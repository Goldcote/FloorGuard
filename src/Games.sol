// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ITreasury, IPoints, IRandomnessProvider, IRandomnessConsumer} from "./interfaces/IFloorGuard.sol";

/// @title Games
/// @notice A dice game against a house bankroll. The player picks a chance of winning between 1% and
///         95%; a coinflip is a 50% roll. An edge is taken from every wager and paid to the Treasury as
///         a fee for the collection the player chose to back. The rest of the wager is played at fair
///         odds, so the bankroll has no expected gain or loss: all of the house's take funds buybacks.
/// @dev The house's side of every open bet is set aside when the bet is placed, so the contract can
///      always pay every outcome. Operating games of chance is regulated or prohibited in many places.
contract Games is IRandomnessConsumer, Ownable2Step, ReentrancyGuard {
    struct Bet {
        address player;
        address collection;
        uint128 wager;
        uint128 exposure; // house money set aside to pay a win
        uint16 chanceBps;
        uint16 edgeBps;
        uint40 placedAt;
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant MIN_CHANCE_BPS = 100;
    uint256 public constant MAX_CHANCE_BPS = 9_500;
    uint256 public constant MAX_EDGE_BPS = 1_000;
    /// @notice A bet whose randomness never arrived can be refunded after this long.
    uint256 public constant REFUND_TIMEOUT = 1 days;
    /// @notice The most the house may have at risk across all open bets, as a share of its total funds.
    uint256 public constant MAX_TOTAL_EXPOSURE_BPS = 2_000;
    uint256 private constant PAYOUT_GAS = 50_000;

    ITreasury public immutable treasury;
    IRandomnessProvider public randomness;
    /// @notice Optional.
    IPoints public points;

    uint256 public edgeBps = 200;
    uint256 public minBet = 0.001 ether;
    /// @notice The most the house may stand to lose on one bet, as a share of the free bankroll.
    uint256 public maxExposureBps = 100;
    mapping(address collection => bool) public isSupported;

    /// @notice House funds not set aside for open bets.
    uint256 public bankroll;
    /// @notice House funds set aside to pay the open bets if they win.
    uint256 public reserved;
    /// @notice Winnings that could not be delivered and wait to be withdrawn.
    mapping(address => uint256) public owedTo;
    mapping(uint256 requestId => Bet) public bets;

    event BetPlaced(
        uint256 indexed requestId,
        address indexed player,
        address indexed collection,
        uint256 wager,
        uint256 chanceBps
    );
    event BetSettled(
        uint256 indexed requestId, address indexed player, bool won, uint256 roll, uint256 payout, uint256 fee
    );
    event BetRefunded(uint256 indexed requestId, address indexed player, uint256 wager);
    event BankrollFunded(address indexed from, uint256 amount);
    event BankrollWithdrawnToTreasury(uint256 amount);
    event Withdrawn(address indexed player, uint256 amount);
    event ParamsSet(uint256 edgeBps, uint256 minBet, uint256 maxExposureBps);
    event CollectionSupportSet(address indexed collection, bool supported);
    event RandomnessSet(address randomness);
    event PointsSet(address points);

    error UnsupportedCollection();
    error InvalidChance();
    error BetTooSmall();
    error ExposureTooHigh(uint256 exposure, uint256 limit);
    error TotalExposureTooHigh(uint256 total, uint256 limit);
    error RequestIdInUse();
    error NotAContract();
    error NotRandomness();
    error UnknownBet();
    error TooEarly(uint256 readyAt);
    error NothingOwed();
    error InvalidParams();
    error InsufficientBankroll();
    error TransferFailed();

    constructor(address owner_, ITreasury treasury_, IRandomnessProvider randomness_) Ownable(owner_) {
        treasury = treasury_;
        randomness = randomness_;
    }

    // ------------------------------------------------------------------ playing

    /// @notice What a winning bet of `wager` at `chanceBps` pays, the wager included.
    function quote(uint256 wager, uint256 chanceBps) public view returns (uint256 payout, uint256 fee) {
        fee = wager * edgeBps / BPS;
        payout = (wager - fee) * BPS / chanceBps;
    }

    /// @notice Bet `msg.value` on a roll with a `chanceBps` chance of winning. The edge on the wager goes
    ///         to the buyback budget of `collection` when the bet settles.
    function play(address collection, uint256 chanceBps)
        external
        payable
        nonReentrant
        returns (uint256 requestId)
    {
        if (!isSupported[collection]) revert UnsupportedCollection();
        if (chanceBps < MIN_CHANCE_BPS || chanceBps > MAX_CHANCE_BPS) revert InvalidChance();
        if (msg.value < minBet) revert BetTooSmall();

        (uint256 payout, uint256 fee) = quote(msg.value, chanceBps);
        uint256 exposure = payout - (msg.value - fee);
        uint256 limit = bankroll * maxExposureBps / BPS;
        if (exposure > limit) revert ExposureTooHigh(exposure, limit);
        uint256 totalLimit = (bankroll + reserved) * MAX_TOTAL_EXPOSURE_BPS / BPS;
        if (reserved + exposure > totalLimit) revert TotalExposureTooHigh(reserved + exposure, totalLimit);
        bankroll -= exposure;
        reserved += exposure;

        requestId = randomness.requestRandomness();
        // a replacement provider must never reuse the id of a bet that is still open
        if (bets[requestId].player != address(0)) revert RequestIdInUse();
        bets[requestId] = Bet({
            player: msg.sender,
            collection: collection,
            wager: uint128(msg.value),
            exposure: uint128(exposure),
            chanceBps: uint16(chanceBps),
            edgeBps: uint16(edgeBps),
            placedAt: uint40(block.timestamp)
        });
        emit BetPlaced(requestId, msg.sender, collection, msg.value, chanceBps);
    }

    /// @inheritdoc IRandomnessConsumer
    function fulfillRandomness(uint256 requestId, uint256 randomWord) external nonReentrant {
        if (msg.sender != address(randomness)) revert NotRandomness();
        Bet memory bet = bets[requestId];
        if (bet.player == address(0)) revert UnknownBet();
        delete bets[requestId];
        reserved -= bet.exposure;

        // Randomness that arrives after the refund window is not used. Otherwise whoever saw the result
        // first could choose between letting it settle and refunding the bet.
        if (block.timestamp >= bet.placedAt + REFUND_TIMEOUT) {
            _refund(requestId, bet);
            return;
        }

        uint256 fee = uint256(bet.wager) * bet.edgeBps / BPS;
        uint256 stake = bet.wager - fee;
        uint256 roll = randomWord % BPS;
        bool won = roll < bet.chanceBps;
        uint256 payout;
        if (won) {
            payout = stake + bet.exposure;
            (bool ok,) = bet.player.call{value: payout, gas: PAYOUT_GAS}("");
            if (!ok) owedTo[bet.player] += payout;
        } else {
            bankroll += stake + bet.exposure;
        }

        if (fee != 0) {
            // points follow what reached the buyback budget, not the project's share of the fee
            uint256 toBudget = treasury.depositFee{value: fee}(bet.collection);
            if (address(points) != address(0) && toBudget != 0) {
                try points.creditFee(bet.player, toBudget) {} catch {}
            }
        }
        emit BetSettled(requestId, bet.player, won, roll, payout, fee);
    }

    /// @notice Return the wager of a bet whose randomness never arrived. Anyone may call.
    function refund(uint256 requestId) external nonReentrant {
        Bet memory bet = bets[requestId];
        if (bet.player == address(0)) revert UnknownBet();
        uint256 readyAt = bet.placedAt + REFUND_TIMEOUT;
        if (block.timestamp < readyAt) revert TooEarly(readyAt);
        delete bets[requestId];
        reserved -= bet.exposure;
        _refund(requestId, bet);
    }

    function _refund(uint256 requestId, Bet memory bet) private {
        bankroll += bet.exposure;
        emit BetRefunded(requestId, bet.player, bet.wager);
        (bool ok,) = bet.player.call{value: bet.wager, gas: PAYOUT_GAS}("");
        if (!ok) owedTo[bet.player] += bet.wager;
    }

    /// @notice Collect winnings or refunds that could not be sent directly.
    function withdraw() external nonReentrant {
        uint256 amount = owedTo[msg.sender];
        if (amount == 0) revert NothingOwed();
        owedTo[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ------------------------------------------------------------------ bankroll

    /// @notice Add to the house bankroll. Anyone may fund it; funds can only ever leave to players or to
    ///         the Treasury.
    function fundBankroll() external payable {
        bankroll += msg.value;
        emit BankrollFunded(msg.sender, msg.value);
    }

    /// @notice Move free bankroll to the Treasury's unallocated pool. There is no other way out.
    function withdrawBankrollToTreasury(uint256 amount) external onlyOwner nonReentrant {
        if (amount > bankroll) revert InsufficientBankroll();
        bankroll -= amount;
        emit BankrollWithdrawnToTreasury(amount);
        (bool ok,) = address(treasury).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ------------------------------------------------------------------ admin

    function setParams(uint256 edgeBps_, uint256 minBet_, uint256 maxExposureBps_) external onlyOwner {
        if (edgeBps_ > MAX_EDGE_BPS || maxExposureBps_ > BPS) revert InvalidParams();
        edgeBps = edgeBps_;
        minBet = minBet_;
        maxExposureBps = maxExposureBps_;
        emit ParamsSet(edgeBps_, minBet_, maxExposureBps_);
    }

    function setCollectionSupport(address collection, bool supported) external onlyOwner {
        isSupported[collection] = supported;
        emit CollectionSupportSet(collection, supported);
    }

    /// @dev Bets in flight with the old provider can be refunded after the timeout.
    function setRandomness(IRandomnessProvider randomness_) external onlyOwner {
        randomness = randomness_;
        emit RandomnessSet(address(randomness_));
    }

    function setPoints(IPoints points_) external onlyOwner {
        if (address(points_) != address(0) && address(points_).code.length == 0) revert NotAContract();
        points = points_;
        emit PointsSet(address(points_));
    }
}
