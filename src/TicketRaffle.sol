// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ITreasury, IRandomnessProvider, IRandomnessConsumer} from "./interfaces/IFloorGuard.sol";

/// @title TicketRaffle
/// @notice Anyone can raffle an NFT they own for paid tickets. When the raffle ends a random ticket
///         wins the NFT, the creator receives the ticket revenue and a platform fee goes to the
///         Treasury. If fewer than the creator's minimum number of tickets sell, the NFT goes back to
///         the creator and every buyer can take a full refund.
/// @dev Operating paid raffles is regulated or prohibited in many places.
contract TicketRaffle is IRandomnessConsumer, Ownable2Step, ReentrancyGuard {
    enum Status {
        None,
        Open,
        Drawing,
        Won,
        Settled,
        Refunding,
        Cancelled
    }

    struct Raffle {
        address creator;
        address collection;
        uint256 tokenId;
        uint128 ticketPrice;
        uint32 minTickets;
        uint32 maxTickets;
        uint32 ticketsSold;
        uint40 endTime;
        uint40 requestedAt;
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

    ITreasury public immutable treasury;
    IRandomnessProvider public randomness;
    uint256 public feeBps = 500;
    /// @notice Collections whose raffle fees are earmarked for their own buybacks. Fees from any other
    ///         contract go to the Treasury's unallocated pool.
    mapping(address collection => bool) public isSupported;

    uint256 public raffleCount;
    mapping(uint256 raffleId => Raffle) public raffles;
    mapping(uint256 raffleId => Entry[]) private _entries;
    /// @notice What each buyer paid into a raffle, refundable if it does not reach its minimum.
    mapping(uint256 raffleId => mapping(address => uint256)) public paidBy;
    /// @notice Raffle revenue waiting for its creator to withdraw.
    mapping(address => uint256) public owedTo;
    mapping(uint256 requestId => uint256 raffleId) public raffleOfRequest;
    mapping(uint256 raffleId => uint256 requestId) public currentRequest;

    event RaffleCreated(
        uint256 indexed raffleId,
        address indexed creator,
        address indexed collection,
        uint256 tokenId,
        uint256 ticketPrice,
        uint256 minTickets,
        uint256 maxTickets,
        uint256 endTime
    );
    event TicketsBought(uint256 indexed raffleId, address indexed buyer, uint256 count, uint256 firstTicket);
    event RaffleCancelled(uint256 indexed raffleId);
    event RaffleRefunding(uint256 indexed raffleId);
    event DrawRequested(uint256 indexed raffleId, uint256 requestId);
    event DrawReset(uint256 indexed raffleId);
    event WinnerDrawn(uint256 indexed raffleId, address indexed winner, uint256 ticket);
    event RaffleSettled(uint256 indexed raffleId, address indexed winner, uint256 toCreator, uint256 fee);
    event Refunded(uint256 indexed raffleId, address indexed buyer, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event FeeSet(uint256 feeBps);
    event CollectionSupportSet(address indexed collection, bool supported);
    event RandomnessSet(address randomness);

    error InvalidParams();
    error WrongStatus(Status status);
    error NotCreator();
    error TicketsAlreadySold();
    error SalesClosed();
    error SoldOut(uint256 remaining);
    error WrongPayment(uint256 expected);
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

    // ------------------------------------------------------------------ creating and buying

    /// @notice Raffle `tokenId`. The caller must own it and have approved this contract; it is held in
    ///         escrow until the raffle ends.
    /// @param minTickets If fewer sell, the raffle is refunded and the NFT returned.
    function create(
        address collection,
        uint256 tokenId,
        uint128 ticketPrice,
        uint32 minTickets,
        uint32 maxTickets,
        uint256 duration
    ) external nonReentrant returns (uint256 raffleId) {
        if (
            ticketPrice == 0 || maxTickets == 0 || minTickets > maxTickets || duration < MIN_DURATION
                || duration > MAX_DURATION
        ) revert InvalidParams();

        raffleId = ++raffleCount;
        uint256 endTime = block.timestamp + duration;
        raffles[raffleId] = Raffle({
            creator: msg.sender,
            collection: collection,
            tokenId: tokenId,
            ticketPrice: ticketPrice,
            minTickets: minTickets,
            maxTickets: maxTickets,
            ticketsSold: 0,
            endTime: uint40(endTime),
            requestedAt: 0,
            status: Status.Open,
            winner: address(0)
        });
        IERC721(collection).transferFrom(msg.sender, address(this), tokenId);
        emit RaffleCreated(
            raffleId, msg.sender, collection, tokenId, ticketPrice, minTickets, maxTickets, endTime
        );
    }

    /// @notice Buy `count` tickets. `msg.value` must be exactly `count * ticketPrice`.
    function buy(uint256 raffleId, uint32 count) external payable {
        Raffle storage r = raffles[raffleId];
        if (r.status != Status.Open) revert WrongStatus(r.status);
        if (block.timestamp >= r.endTime) revert SalesClosed();
        uint256 remaining = r.maxTickets - r.ticketsSold;
        if (count == 0 || count > remaining) revert SoldOut(remaining);
        uint256 cost = uint256(r.ticketPrice) * count;
        if (msg.value != cost) revert WrongPayment(cost);

        uint32 first = r.ticketsSold;
        uint32 end = first + count;
        r.ticketsSold = end;
        paidBy[raffleId][msg.sender] += cost;
        Entry[] storage entries = _entries[raffleId];
        if (entries.length != 0 && entries[entries.length - 1].buyer == msg.sender) {
            entries[entries.length - 1].endTicket = end;
        } else {
            entries.push(Entry(msg.sender, end));
        }
        emit TicketsBought(raffleId, msg.sender, count, first);
    }

    /// @notice The creator can withdraw the NFT while no ticket has been sold.
    function cancel(uint256 raffleId) external nonReentrant {
        Raffle storage r = raffles[raffleId];
        if (r.status != Status.Open) revert WrongStatus(r.status);
        if (msg.sender != r.creator) revert NotCreator();
        if (r.ticketsSold != 0) revert TicketsAlreadySold();
        r.status = Status.Cancelled;
        emit RaffleCancelled(raffleId);
        IERC721(r.collection).transferFrom(address(this), r.creator, r.tokenId);
    }

    // ------------------------------------------------------------------ ending

    /// @notice End a raffle once its time is up or it has sold out. Anyone may call. Requests the draw,
    ///         or opens refunds and returns the NFT if the minimum was not reached.
    function close(uint256 raffleId) external nonReentrant {
        Raffle storage r = raffles[raffleId];
        if (r.status != Status.Open) revert WrongStatus(r.status);
        if (block.timestamp < r.endTime && r.ticketsSold < r.maxTickets) revert StillOpen();

        if (r.ticketsSold == 0 || r.ticketsSold < r.minTickets) {
            r.status = Status.Refunding;
            emit RaffleRefunding(raffleId);
            IERC721(r.collection).transferFrom(address(this), r.creator, r.tokenId);
            return;
        }
        r.status = Status.Drawing;
        r.requestedAt = uint40(block.timestamp);
        uint256 requestId = randomness.requestRandomness();
        if (raffleOfRequest[requestId] != 0) revert RequestIdInUse();
        raffleOfRequest[requestId] = raffleId;
        currentRequest[raffleId] = requestId;
        emit DrawRequested(raffleId, requestId);
    }

    /// @inheritdoc IRandomnessConsumer
    function fulfillRandomness(uint256 requestId, uint256 randomWord) external {
        if (msg.sender != address(randomness)) revert NotRandomness();
        uint256 raffleId = raffleOfRequest[requestId];
        Raffle storage r = raffles[raffleId];
        if (r.status != Status.Drawing) revert WrongStatus(r.status);
        if (currentRequest[raffleId] != requestId) revert StaleRequest();
        delete currentRequest[raffleId];

        // late randomness is not used, so nobody can choose between a late result and a reset
        if (block.timestamp >= r.requestedAt + DRAW_TIMEOUT) {
            r.status = Status.Open;
            emit DrawReset(raffleId);
            return;
        }
        uint256 ticket = randomWord % r.ticketsSold;
        address winner = ownerOfTicket(raffleId, ticket);
        r.winner = winner;
        r.status = Status.Won;
        emit WinnerDrawn(raffleId, winner, ticket);
    }

    /// @notice Reopen a draw whose randomness never arrived, so `close` can request it again.
    function resetDraw(uint256 raffleId) external {
        Raffle storage r = raffles[raffleId];
        if (r.status != Status.Drawing) revert WrongStatus(r.status);
        uint256 readyAt = r.requestedAt + DRAW_TIMEOUT;
        if (block.timestamp < readyAt) revert TooEarly(readyAt);
        r.status = Status.Open;
        delete currentRequest[raffleId];
        emit DrawReset(raffleId);
    }

    /// @notice Deliver the prize and split the ticket revenue. Anyone may call.
    function settle(uint256 raffleId) external nonReentrant {
        Raffle storage r = raffles[raffleId];
        if (r.status != Status.Won) revert WrongStatus(r.status);
        r.status = Status.Settled;

        uint256 pot = uint256(r.ticketPrice) * r.ticketsSold;
        uint256 fee = pot * feeBps / BPS;
        owedTo[r.creator] += pot - fee;
        emit RaffleSettled(raffleId, r.winner, pot - fee, fee);

        IERC721(r.collection).transferFrom(address(this), r.winner, r.tokenId);
        if (fee != 0) {
            if (isSupported[r.collection]) {
                treasury.depositFee{value: fee}(r.collection);
            } else {
                (bool ok,) = address(treasury).call{value: fee}("");
                if (!ok) revert TransferFailed();
            }
        }
    }

    /// @notice Take back what the caller paid into a raffle that did not reach its minimum.
    function refund(uint256 raffleId) external nonReentrant {
        Status status = raffles[raffleId].status;
        if (status != Status.Refunding) revert WrongStatus(status);
        uint256 amount = paidBy[raffleId][msg.sender];
        if (amount == 0) revert NothingOwed();
        paidBy[raffleId][msg.sender] = 0;
        emit Refunded(raffleId, msg.sender, amount);
        _send(msg.sender, amount);
    }

    /// @notice Withdraw raffle revenue owed to the caller.
    function withdraw() external nonReentrant {
        uint256 amount = owedTo[msg.sender];
        if (amount == 0) revert NothingOwed();
        owedTo[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        _send(msg.sender, amount);
    }

    // ------------------------------------------------------------------ views

    /// @notice The buyer holding ticket number `ticket`.
    function ownerOfTicket(uint256 raffleId, uint256 ticket) public view returns (address) {
        Entry[] storage entries = _entries[raffleId];
        uint256 low;
        uint256 high = entries.length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (ticket < entries[mid].endTicket) high = mid;
            else low = mid + 1;
        }
        return entries[low].buyer;
    }

    function entryCount(uint256 raffleId) external view returns (uint256) {
        return _entries[raffleId].length;
    }

    // ------------------------------------------------------------------ admin

    /// @dev Applies to raffles that are already open.
    function setFee(uint256 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert InvalidParams();
        feeBps = feeBps_;
        emit FeeSet(feeBps_);
    }

    function setCollectionSupport(address collection, bool supported) external onlyOwner {
        isSupported[collection] = supported;
        emit CollectionSupportSet(collection, supported);
    }

    /// @dev A draw in flight with the old provider can be reopened with `resetDraw`.
    function setRandomness(IRandomnessProvider randomness_) external onlyOwner {
        randomness = randomness_;
        emit RandomnessSet(address(randomness_));
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
