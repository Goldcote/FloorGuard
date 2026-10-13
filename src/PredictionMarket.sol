// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ITreasury, IFloorOracle, IPoints} from "./interfaces/IFloorGuard.sol";

/// @title PredictionMarket
/// @notice Pooled (parimutuel) bets on whether a collection's floor will be higher or lower at a set
///         time. Winners split the losing pool pro rata; a fee on their winnings goes to the Treasury as
///         buyback budget for that collection. Markets with a one-sided pool, a price that moved less
///         than the dead band, or no usable oracle price are voided and refunded in full.
contract PredictionMarket is Ownable2Step, ReentrancyGuard {
    enum Outcome {
        Pending,
        Higher,
        Lower,
        Void
    }

    struct Market {
        address collection;
        uint128 startPrice;
        uint40 closeTime; // last moment to bet
        uint40 resolveTime; // earliest moment to settle
        uint128 higherPool;
        uint128 lowerPool;
        Outcome outcome;
    }

    struct Stake {
        uint128 higher;
        uint128 lower;
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 1_000;
    uint256 public constant MIN_BETTING_PERIOD = 10 minutes;
    uint256 public constant MAX_DURATION = 30 days;
    /// @notice If the oracle has no fresh price this long after `resolveTime`, the market can be voided.
    uint256 public constant VOID_GRACE = 3 days;

    ITreasury public immutable treasury;
    IFloorOracle public oracle;
    /// @notice Optional.
    IPoints public points;

    uint256 public feeBps = 300;
    uint256 public minBet = 0.001 ether;
    /// @notice Oracle prices older than this are rejected at settlement.
    uint256 public maxOracleAge = 1 days;
    /// @notice A market can only be created on a price at most this old, so its start price is current.
    uint256 public maxStartPriceAge = 1 hours;
    /// @notice A market is void unless the price moved by at least this share of the start price, so a
    ///         one-wei move cannot decide it.
    uint256 public deadBandBps = 200;
    uint256 public constant MAX_DEAD_BAND_BPS = 1_000;
    mapping(address collection => bool) public isSupported;

    uint256 public marketCount;
    mapping(uint256 marketId => Market) public markets;
    /// @notice The fee of each market, fixed when it is created.
    mapping(uint256 marketId => uint256) public feeBpsOf;
    /// @notice The dead band of each market, fixed when it is created.
    mapping(uint256 marketId => uint256) public deadBandBpsOf;
    mapping(uint256 marketId => mapping(address => Stake)) public stakes;

    event MarketCreated(
        uint256 indexed marketId,
        address indexed collection,
        uint256 startPrice,
        uint256 closeTime,
        uint256 resolveTime
    );
    event BetPlaced(uint256 indexed marketId, address indexed bettor, bool higher, uint256 amount);
    event MarketResolved(uint256 indexed marketId, Outcome outcome, uint256 endPrice);
    event Claimed(uint256 indexed marketId, address indexed bettor, uint256 payout, uint256 fee);
    event CollectionSupportSet(address indexed collection, bool supported);
    event ParamsSet(uint256 feeBps, uint256 minBet, uint256 maxOracleAge);
    event OracleSet(address oracle);
    event MarketRulesSet(uint256 deadBandBps, uint256 maxStartPriceAge);
    event PointsSet(address points);

    error UnsupportedCollection();
    error InvalidDuration();
    error OracleUnavailable();
    error UnknownMarket();
    error BettingClosed();
    error BetTooSmall();
    error NotResolvable();
    error NotResolved();
    error NothingToClaim();
    error TooHigh();
    error TransferFailed();
    error NotAContract();

    constructor(address owner_, ITreasury treasury_, IFloorOracle oracle_) Ownable(owner_) {
        treasury = treasury_;
        oracle = oracle_;
    }

    // ------------------------------------------------------------------ markets

    /// @notice Open a market on a supported collection. Betting runs for `bettingPeriod`, at most a tenth
    ///         of `duration`, so the last bettor knows little more than the first; the market settles on
    ///         a floor price published at or after `duration`.
    function createMarket(address collection, uint256 bettingPeriod, uint256 duration)
        external
        returns (uint256 marketId)
    {
        if (!isSupported[collection]) revert UnsupportedCollection();
        if (bettingPeriod < MIN_BETTING_PERIOD || duration < 10 * bettingPeriod || duration > MAX_DURATION) {
            revert InvalidDuration();
        }
        (bool fresh, uint256 price, uint256 updatedAt) = _tryFloor(collection);
        if (!fresh || updatedAt + maxStartPriceAge < block.timestamp) revert OracleUnavailable();

        marketId = ++marketCount;
        feeBpsOf[marketId] = feeBps;
        deadBandBpsOf[marketId] = deadBandBps;
        Market storage m = markets[marketId];
        m.collection = collection;
        m.startPrice = uint128(price);
        m.closeTime = uint40(block.timestamp + bettingPeriod);
        m.resolveTime = uint40(block.timestamp + duration);
        emit MarketCreated(marketId, collection, price, m.closeTime, m.resolveTime);
    }

    function placeBet(uint256 marketId, bool higher) external payable {
        Market storage m = markets[marketId];
        if (m.resolveTime == 0) revert UnknownMarket();
        if (block.timestamp >= m.closeTime) revert BettingClosed();
        if (msg.value < minBet) revert BetTooSmall();

        uint128 amount = uint128(msg.value);
        if (higher) {
            m.higherPool += amount;
            stakes[marketId][msg.sender].higher += amount;
        } else {
            m.lowerPool += amount;
            stakes[marketId][msg.sender].lower += amount;
        }
        emit BetPlaced(marketId, msg.sender, higher, msg.value);
    }

    /// @notice Settle a market against the oracle. Anyone may call once `resolveTime` has passed.
    function resolve(uint256 marketId) external {
        Market storage m = markets[marketId];
        if (m.resolveTime == 0) revert UnknownMarket();
        if (m.outcome != Outcome.Pending || block.timestamp < m.resolveTime) revert NotResolvable();

        Outcome outcome;
        uint256 endPrice;
        if (m.higherPool == 0 || m.lowerPool == 0) {
            outcome = Outcome.Void;
        } else {
            // the settlement price must have been published after the market's settlement time
            bool fresh;
            uint256 updatedAt;
            (fresh, endPrice, updatedAt) = _tryFloor(m.collection);
            fresh = fresh && updatedAt >= m.resolveTime;
            if (!fresh) {
                if (block.timestamp < uint256(m.resolveTime) + VOID_GRACE) revert OracleUnavailable();
                outcome = Outcome.Void;
            } else {
                uint256 move = endPrice > m.startPrice ? endPrice - m.startPrice : m.startPrice - endPrice;
                if (move == 0 || move * BPS < uint256(m.startPrice) * deadBandBpsOf[marketId]) {
                    outcome = Outcome.Void;
                } else {
                    outcome = endPrice > m.startPrice ? Outcome.Higher : Outcome.Lower;
                }
            }
        }
        m.outcome = outcome;
        emit MarketResolved(marketId, outcome, endPrice);
    }

    /// @notice Collect a payout, a refund or (for losing stakes) points. Losing stakes fund the fee, so
    ///         they earn points for it even though no ETH is returned.
    function claim(uint256 marketId) external nonReentrant {
        Market memory m = markets[marketId];
        if (m.outcome == Outcome.Pending) revert NotResolved();
        Stake memory s = stakes[marketId][msg.sender];
        if (s.higher == 0 && s.lower == 0) revert NothingToClaim();
        delete stakes[marketId][msg.sender];
        uint256 marketFeeBps = feeBpsOf[marketId];

        uint256 payout;
        uint256 fee;
        uint256 pointsFee;
        if (m.outcome == Outcome.Void) {
            payout = uint256(s.higher) + s.lower;
        } else {
            bool higherWon = m.outcome == Outcome.Higher;
            (uint256 won, uint256 lost) = higherWon ? (s.higher, s.lower) : (s.lower, s.higher);
            (uint256 winPool, uint256 losePool) =
                higherWon ? (m.higherPool, m.lowerPool) : (m.lowerPool, m.higherPool);
            if (won != 0) {
                uint256 profit = won * losePool / winPool;
                fee = profit * marketFeeBps / BPS;
                payout = won + profit - fee;
            }
            // each fee is credited once: half to the winners who pay it, half to the losers who fund it
            pointsFee = lost * marketFeeBps / BPS;
        }

        emit Claimed(marketId, msg.sender, payout, fee);
        // points follow what reaches the buyback budget, not the project's share of the fee
        if (pointsFee != 0) {
            (, uint16 shareBps) = treasury.projectShareOf(m.collection);
            pointsFee = pointsFee * (BPS - shareBps) / BPS;
        }
        if (fee != 0) pointsFee += treasury.depositFee{value: fee}(m.collection);
        pointsFee /= 2;
        if (pointsFee != 0 && address(points) != address(0)) {
            // points are a bonus; a failure there must never block a payout
            try points.creditFee(msg.sender, pointsFee) {} catch {}
        }
        if (payout != 0) {
            (bool ok,) = msg.sender.call{value: payout}("");
            if (!ok) revert TransferFailed();
        }
    }

    // ------------------------------------------------------------------ admin

    function setCollectionSupport(address collection, bool supported) external onlyOwner {
        isSupported[collection] = supported;
        emit CollectionSupportSet(collection, supported);
    }

    /// @dev A fee change applies to markets created afterwards.
    function setParams(uint256 feeBps_, uint256 minBet_, uint256 maxOracleAge_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert TooHigh();
        feeBps = feeBps_;
        minBet = minBet_;
        maxOracleAge = maxOracleAge_;
        emit ParamsSet(feeBps_, minBet_, maxOracleAge_);
    }

    /// @dev The dead band applies to markets created afterwards.
    function setMarketRules(uint256 deadBandBps_, uint256 maxStartPriceAge_) external onlyOwner {
        if (deadBandBps_ > MAX_DEAD_BAND_BPS) revert TooHigh();
        deadBandBps = deadBandBps_;
        maxStartPriceAge = maxStartPriceAge_;
        emit MarketRulesSet(deadBandBps_, maxStartPriceAge_);
    }

    function setOracle(IFloorOracle oracle_) external onlyOwner {
        oracle = oracle_;
        emit OracleSet(address(oracle_));
    }

    function setPoints(IPoints points_) external onlyOwner {
        if (address(points_) != address(0) && address(points_).code.length == 0) revert NotAContract();
        points = points_;
        emit PointsSet(address(points_));
    }

    function _tryFloor(address collection)
        private
        view
        returns (bool fresh, uint256 price, uint256 updatedAt)
    {
        try oracle.floorPrice(collection) returns (uint256 p, uint256 at) {
            return (p != 0 && at + maxOracleAge >= block.timestamp, p, at);
        } catch {
            return (false, 0, 0);
        }
    }
}
