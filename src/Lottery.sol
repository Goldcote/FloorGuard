// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ITreasury, IRandomnessProvider, IRandomnessConsumer} from "./interfaces/IFloorGuard.sol";

/// @title Lottery
/// @notice A pooled ETH lottery per collection. Each round sells tickets at a fixed price for a fixed
///         time; then one random ticket wins the pot, less a fee that goes to the Treasury as buyback
///         budget for the round's collection. The first ticket bought after a round has ended opens the
///         next round.
/// @dev Buyers can always reach either a draw or a refund: a round whose pot is too small to draw, or
///      whose randomness has not arrived a week after its end, goes to refunds. Operating lotteries is
///      regulated or prohibited in many places.
contract Lottery is IRandomnessConsumer, Ownable2Step, ReentrancyGuard {
    enum Status {
        None,
        Open,
        Drawing,
        Won,
        Refunding
    }

    struct Config {
        uint128 ticketPrice;
        uint40 duration;
        bool active;
    }

    struct Round {
        address collection;
        uint128 ticketPrice;
        uint32 ticketsSold;
        uint40 endTime;
        uint40 requestedAt;
        uint16 feeBps;
        Status status;
        address winner;
    }

    /// @dev Tickets are numbered from zero; an entry owns the tickets up to `endTicket`, exclusive.
    struct Entry {
        address buyer;
        uint32 endTicket;
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 1_000;
    uint256 public constant MIN_DURATION = 1 hours;
    uint256 public constant MAX_DURATION = 30 days;
    /// @notice A draw without randomness for this long can be reset; randomness arriving later is ignored.
    uint256 public constant DRAW_TIMEOUT = 1 days;
    /// @notice How long after its end an undrawn round can be turned into refunds by anyone.
    uint256 public constant ABORT_DELAY = 7 days;

    ITreasury public immutable treasury;
    IRandomnessProvider public randomness;
    uint256 public feeBps = 500;
    /// @notice A round whose pot is below this is refunded instead of drawn, so that every draw pays a
    ///         fee that can cover its randomness request.
    uint256 public minPot = 0.05 ether;

    mapping(address collection => Config) public configOf;
    /// @notice The latest round of each collection. It may already have ended.
    mapping(address collection => uint256 roundId) public currentRoundOf;
    uint256 public roundCount;
    mapping(uint256 roundId => Round) public rounds;
    /// @notice The minimum pot of each round, fixed when it opens.
    mapping(uint256 roundId => uint256) public minPotOf;
    mapping(uint256 roundId => Entry[]) private _entries;
    /// @notice What each buyer paid into a round, refundable if the round is not drawn.
    mapping(uint256 roundId => mapping(address => uint256)) public paidBy;
    /// @notice Winnings waiting to be withdrawn.
    mapping(address => uint256) public owedTo;
    mapping(uint256 requestId => uint256 roundId) public roundOfRequest;
    mapping(uint256 roundId => uint256 requestId) public currentRequest;

    event ConfigSet(address indexed collection, uint256 ticketPrice, uint256 duration, bool active);
    event RoundOpened(
        uint256 indexed roundId, address indexed collection, uint256 ticketPrice, uint256 endTime
    );
    event TicketsBought(uint256 indexed roundId, address indexed buyer, uint256 count, uint256 firstTicket);
    event DrawRequested(uint256 indexed roundId, uint256 requestId);
    event DrawReset(uint256 indexed roundId);
    event RoundWon(
        uint256 indexed roundId, address indexed winner, uint256 ticket, uint256 prize, uint256 fee
    );
    event RoundRefunding(uint256 indexed roundId);
    event Refunded(uint256 indexed roundId, address indexed buyer, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event ParamsSet(uint256 feeBps, uint256 minPot);
    event RandomnessSet(address randomness);

    error InvalidParams();
    error InactiveCollection();
    error InvalidCount();
    error WrongPayment(uint256 expected);
    error WrongStatus(Status status);
    error StillOpen();
    error TooEarly(uint256 readyAt);
    error NotRandomness();
    error StaleRequest();
    error RequestIdInUse();
    error NothingOwed();
    error TransferFailed();

    constructor(address owner_, ITreasury treasury_, IRandomnessProvider randomness_) Ownable(owner_) {
        treasury = treasury_;
        randomness = randomness_;
    }

    // ------------------------------------------------------------------ playing

    /// @notice Buy `count` tickets in the collection's open round, opening a new round if the latest one
    ///         has ended. `msg.value` must be exactly `count` times the ticket price of that round.
    function buy(address collection, uint32 count) external payable returns (uint256 roundId) {
        if (count == 0) revert InvalidCount();
        roundId = currentRoundOf[collection];
        Round storage r = rounds[roundId];
        if (r.status != Status.Open || block.timestamp >= r.endTime) {
            Config memory config = configOf[collection];
            if (!config.active) revert InactiveCollection();
            roundId = ++roundCount;
            currentRoundOf[collection] = roundId;
            r = rounds[roundId];
            r.collection = collection;
            r.ticketPrice = config.ticketPrice;
            r.endTime = uint40(block.timestamp + config.duration);
            r.feeBps = uint16(feeBps);
            r.status = Status.Open;
            minPotOf[roundId] = minPot;
            emit RoundOpened(roundId, collection, config.ticketPrice, r.endTime);
        }
        uint256 cost = uint256(r.ticketPrice) * count;
        if (msg.value != cost) revert WrongPayment(cost);
        if (uint256(r.ticketsSold) + count > type(uint32).max) revert InvalidCount();

        uint32 first = r.ticketsSold;
        uint32 end = first + count;
        r.ticketsSold = end;
        paidBy[roundId][msg.sender] += cost;
        Entry[] storage entries = _entries[roundId];
        if (entries.length != 0 && entries[entries.length - 1].buyer == msg.sender) {
            entries[entries.length - 1].endTicket = end;
        } else {
            entries.push(Entry(msg.sender, end));
        }
        emit TicketsBought(roundId, msg.sender, count, first);
    }

    /// @notice End a round whose time is up. Anyone may call. Requests the draw, or opens refunds if the
    ///         pot is below `minPot`.
    function draw(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.status != Status.Open) revert WrongStatus(r.status);
        if (block.timestamp < r.endTime) revert StillOpen();

        // Past the abort time no new draw is requested: retrying a draw must not keep pushing refunds out.
        if (
            r.ticketsSold == 0 || uint256(r.ticketPrice) * r.ticketsSold < minPotOf[roundId]
                || block.timestamp >= r.endTime + ABORT_DELAY
        ) {
            r.status = Status.Refunding;
            emit RoundRefunding(roundId);
            return;
        }
        r.status = Status.Drawing;
        r.requestedAt = uint40(block.timestamp);
        uint256 requestId = randomness.requestRandomness();
        if (roundOfRequest[requestId] != 0) revert RequestIdInUse();
        roundOfRequest[requestId] = roundId;
        currentRequest[roundId] = requestId;
        emit DrawRequested(roundId, requestId);
    }

    /// @inheritdoc IRandomnessConsumer
    function fulfillRandomness(uint256 requestId, uint256 randomWord) external nonReentrant {
        if (msg.sender != address(randomness)) revert NotRandomness();
        uint256 roundId = roundOfRequest[requestId];
        if (roundId == 0) revert StaleRequest();
        Round storage r = rounds[roundId];
        // only the round's current request is ever accepted, whatever ids the provider hands out
        if (r.status != Status.Drawing || currentRequest[roundId] != requestId) revert StaleRequest();
        delete roundOfRequest[requestId];
        delete currentRequest[roundId];

        // late randomness is not used, so nobody can choose between a late result and a reset
        if (block.timestamp >= r.requestedAt + DRAW_TIMEOUT) {
            r.status = Status.Open;
            emit DrawReset(roundId);
            return;
        }
        uint256 ticket = randomWord % r.ticketsSold;
        address winner = ownerOfTicket(roundId, ticket);
        uint256 pot = uint256(r.ticketPrice) * r.ticketsSold;
        uint256 fee = pot * r.feeBps / BPS;
        r.winner = winner;
        r.status = Status.Won;
        owedTo[winner] += pot - fee;
        emit RoundWon(roundId, winner, ticket, pot - fee, fee);
        if (fee != 0) treasury.depositFee{value: fee}(r.collection);
    }

    /// @notice Reopen a draw whose randomness never arrived, so `draw` can request it again.
    function resetDraw(uint256 roundId) external {
        Round storage r = rounds[roundId];
        if (r.status != Status.Drawing) revert WrongStatus(r.status);
        uint256 readyAt = r.requestedAt + DRAW_TIMEOUT;
        if (block.timestamp < readyAt) revert TooEarly(readyAt);
        _clearRequest(roundId);
        r.status = Status.Open;
        emit DrawReset(roundId);
    }

    /// @notice Turn a round that is still undrawn a week after its end into refunds. Anyone may call.
    function abort(uint256 roundId) external {
        Round storage r = rounds[roundId];
        if (r.status != Status.Open && r.status != Status.Drawing) revert WrongStatus(r.status);
        uint256 readyAt = r.endTime + ABORT_DELAY;
        if (r.status == Status.Drawing) {
            // never while an answer to the pending request would still be accepted: otherwise whoever saw
            // the result first could choose between letting it stand and aborting
            uint256 answerDeadline = r.requestedAt + DRAW_TIMEOUT;
            if (answerDeadline > readyAt) readyAt = answerDeadline;
        }
        if (block.timestamp < readyAt) revert TooEarly(readyAt);
        _clearRequest(roundId);
        r.status = Status.Refunding;
        emit RoundRefunding(roundId);
    }

    /// @notice Take back what the caller paid into a round that went to refunds.
    function refund(uint256 roundId) external nonReentrant {
        Status status = rounds[roundId].status;
        if (status != Status.Refunding) revert WrongStatus(status);
        uint256 amount = paidBy[roundId][msg.sender];
        if (amount == 0) revert NothingOwed();
        paidBy[roundId][msg.sender] = 0;
        emit Refunded(roundId, msg.sender, amount);
        _send(msg.sender, amount);
    }

    /// @notice Withdraw the caller's winnings.
    function withdraw() external nonReentrant {
        uint256 amount = owedTo[msg.sender];
        if (amount == 0) revert NothingOwed();
        owedTo[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        _send(msg.sender, amount);
    }

    // ------------------------------------------------------------------ views

    /// @notice The buyer holding ticket number `ticket` of a round.
    function ownerOfTicket(uint256 roundId, uint256 ticket) public view returns (address) {
        Entry[] storage entries = _entries[roundId];
        uint256 low;
        uint256 high = entries.length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (ticket < entries[mid].endTicket) high = mid;
            else low = mid + 1;
        }
        return entries[low].buyer;
    }

    // ------------------------------------------------------------------ admin

    /// @notice Set a collection's ticket price and round length. Applies from its next round; turning it
    ///         off stops new rounds and leaves the open one to finish.
    function setConfig(address collection, uint128 ticketPrice, uint40 duration, bool active)
        external
        onlyOwner
    {
        if (active && (ticketPrice == 0 || duration < MIN_DURATION || duration > MAX_DURATION)) {
            revert InvalidParams();
        }
        configOf[collection] = Config(ticketPrice, duration, active);
        emit ConfigSet(collection, ticketPrice, duration, active);
    }

    /// @dev Both apply to rounds opened afterwards.
    function setParams(uint256 feeBps_, uint256 minPot_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert InvalidParams();
        feeBps = feeBps_;
        minPot = minPot_;
        emit ParamsSet(feeBps_, minPot_);
    }

    /// @dev A draw in flight with the old provider can be reopened with `resetDraw`.
    function setRandomness(IRandomnessProvider randomness_) external onlyOwner {
        randomness = randomness_;
        emit RandomnessSet(address(randomness_));
    }

    function _clearRequest(uint256 roundId) private {
        delete roundOfRequest[currentRequest[roundId]];
        delete currentRequest[roundId];
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
