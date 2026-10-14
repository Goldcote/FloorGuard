// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {
    ITreasury,
    IVault,
    IFloorOracle,
    IVaultRaffle,
    IRandomnessProvider,
    IRandomnessConsumer
} from "./interfaces/IFloorGuard.sol";

/// @title Vault
/// @notice Holds NFTs bought by the BuybackEngine.
///
///         Most holdings have a moving lock. From `MIN_LOCK` a holding takes part in a daily random draw;
///         its chance of being picked rises with its age, so nobody can know in advance when it will
///         unlock. A picked holding unlocks only if the collection's 30-day median floor is at least a
///         required multiple of its purchase price, 130% at `MIN_LOCK` falling to 100% at `FULL_AGE`, and
///         only while the collection's weekly release cap has room. After unlocking, the owner
///         (governance) may raffle it, relock it or auction it. If governance does nothing for
///         `GOVERNANCE_WINDOW`, anyone can start a Dutch auction. Auction proceeds return to the
///         collection's Treasury budget.
///
///         A share of purchases (`playersShareBps`, one in five by default) is set aside for players: it
///         is locked for `PLAYERS_LOCK` and then anyone can send it to the vault raffle, where points
///         holders compete for it.
contract Vault is IVault, IRandomnessConsumer, Ownable2Step, ReentrancyGuard {
    enum Status {
        None,
        Locked,
        Unlocked,
        Auction,
        Released
    }

    struct Holding {
        address collection;
        uint256 tokenId;
        uint128 purchasePrice;
        uint40 acquiredAt;
        uint40 lockedUntil;
        uint40 unlockedAt;
        Status status;
    }

    struct Auction {
        uint128 startPrice;
        uint128 endPrice;
        uint40 startTime;
    }

    struct FloorSample {
        uint128 price;
        uint40 takenAt;
    }

    struct ReleaseWindow {
        uint40 start;
        uint32 cap;
        uint32 used;
    }

    uint256 public constant BPS = 10_000;

    /// @notice A holding takes no part in the unlock draw before this age.
    uint256 public constant MIN_LOCK = 90 days;
    /// @notice Age at which the required floor and the daily chance stop changing.
    uint256 public constant FULL_AGE = 365 days;
    /// @notice Required 30-day median floor, as a share of the purchase price, at `MIN_LOCK` and at
    ///         `FULL_AGE`, linear in between. It falls so that holdings bought near a peak are not locked
    ///         forever, but never below the price paid.
    uint256 public constant UNLOCK_START_BPS = 13_000;
    uint256 public constant UNLOCK_END_BPS = 10_000;
    /// @notice Chance of a holding being picked in one daily draw, at `MIN_LOCK` and at `FULL_AGE`,
    ///         linear in between. With the floor condition met, about half of holdings unlock by six
    ///         months and nearly all by a year, on dates nobody can know in advance.
    uint256 public constant DRAW_START_BPS = 50;
    uint256 public constant DRAW_END_BPS = 500;

    /// @notice A new unlock draw can be requested this long after the last request.
    uint256 public constant ROUND_INTERVAL = 1 days;
    /// @notice Randomness arriving this long after its request is ignored; a new request can then be made.
    uint256 public constant ROUND_TIMEOUT = 1 days;
    /// @notice How long a draw's result can be used to unlock the holdings it picked.
    uint256 public constant SEED_LIFETIME = 1 days;

    /// @notice One floor sample per collection per `SAMPLE_INTERVAL`; the median of the samples of the
    ///         last `FLOOR_SAMPLES` intervals is the floor the unlock condition uses. Moving it takes
    ///         control of more than half of a month of samples, not one moment.
    uint256 public constant SAMPLE_INTERVAL = 1 days;
    uint256 public constant FLOOR_SAMPLES = 30;
    uint256 public constant MIN_FLOOR_SAMPLES = 15;

    /// @notice At most `RELEASE_CAP_BPS` of a collection's holdings (and at least one) can unlock in
    ///         any `RELEASE_PERIOD`, so there is never a cliff of supply.
    uint256 public constant RELEASE_PERIOD = 7 days;
    uint256 public constant RELEASE_CAP_BPS = 500;

    /// @notice Lock on holdings set aside for players, after which anyone can send them to the raffle.
    uint256 public constant PLAYERS_LOCK = 30 days;
    uint256 public constant MAX_PLAYERS_SHARE_BPS = 5_000;

    uint256 public constant GOVERNANCE_WINDOW = 30 days;
    /// @notice An auction opens at this multiple of its reserve, far above any plausible market price,
    ///         and halves every `AUCTION_HALF_LIFE` until it reaches the reserve. The sale price is found
    ///         by buyers competing on the way down, not by where the auction starts.
    uint256 public constant AUCTION_START_MULTIPLE = 16;
    uint256 public constant AUCTION_HALF_LIFE = 1 days;
    /// @notice An unsold auction rests at its end price for at least this long, and up to twice as long,
    ///         before it can be restarted.
    uint256 public constant AUCTION_RESTART_DWELL = 1 days;
    /// @notice Time for a price opening at 16 times its reserve to fall to the reserve. An auction that
    ///         opens higher, because of the floor recorded at unlock, takes longer.
    uint256 public constant AUCTION_DURATION = 4 days;

    ITreasury public immutable treasury;
    /// @notice The only address allowed to register deposits (the BuybackEngine).
    address public engine;
    IFloorOracle public oracle;
    IVaultRaffle public raffle;
    /// @notice Oracle prices older than this are rejected.
    uint256 public maxOracleAge = 3 days;

    uint256 public holdingCount;
    mapping(uint256 vaultId => Holding) public holdings;
    mapping(uint256 vaultId => Auction) public auctions;
    /// @notice True while a holding's auction runs at prices the owner chose. Only the owner can
    ///         restart or replace such an auction.
    mapping(uint256 vaultId => bool) public isOwnerPriced;
    /// @notice The oracle floor seen when a holding unlocked on its own, capped at 16 times the unlock
    ///         price. An auction never opens below 16 times this. Whoever calls `unlock` can influence
    ///         the oracle at that moment, so `minReserveOf` is the protection to rely on.
    mapping(uint256 vaultId => uint256) public unlockFloorOf;
    /// @notice An owner-set lower bound on the auction reserve of a collection's holdings.
    mapping(address collection => uint256) public minReserveOf;

    /// @notice Source of the daily unlock draw. Without one, holdings unlock only by governance.
    IRandomnessProvider public randomness;
    /// @notice Share of purchases set aside for players, in basis points.
    uint256 public playersShareBps = 2_000;
    /// @notice Running remainder that decides which purchases go to players: exactly
    ///         `playersShareBps` of them, spread evenly.
    mapping(address collection => uint256) public playersCredit;
    mapping(uint256 vaultId => bool) public isPlayersHolding;
    /// @notice Required floor multiple recorded when a holding unlocked by the draw. Its auction never
    ///         rests below this multiple of the purchase price.
    mapping(uint256 vaultId => uint256) public unlockBpsOf;

    /// @notice Holdings of a collection still in the Vault (locked, unlocked or on auction).
    mapping(address collection => uint256) public heldCount;
    mapping(address collection => ReleaseWindow) public releaseWindows;

    mapping(address collection => FloorSample[FLOOR_SAMPLES]) private _samples;
    mapping(address collection => uint256) public sampleCount;
    /// @notice Interval index of a collection's last sample, plus one.
    mapping(address collection => uint256) public lastSampleSlot;

    /// @notice The unlock draw: one random word a day for every holding.
    uint256 public roundRequestId;
    uint40 public roundRequestedAt;
    bool public roundPending;
    uint256 public roundSeed;
    /// @notice When the draw behind `roundSeed` was requested; holdings eligible by then take part.
    uint40 public seedRequestedAt;
    uint40 public seedArrivedAt;

    event Deposited(
        uint256 indexed vaultId, address indexed collection, uint256 indexed tokenId, uint256 price
    );
    event Unlocked(uint256 indexed vaultId, bool byGovernance);
    event Relocked(uint256 indexed vaultId, uint256 lockedUntil);
    event AuctionStarted(uint256 indexed vaultId, uint256 startPrice, uint256 endPrice);
    event AuctionCancelled(uint256 indexed vaultId);
    event AuctionSold(uint256 indexed vaultId, address indexed buyer, uint256 price);
    event SentToRaffle(uint256 indexed vaultId, uint256 raffleId);
    event EngineSet(address engine);
    event OracleSet(address oracle);
    event RaffleSet(address raffle);
    event MaxOracleAgeSet(uint256 maxOracleAge);
    event MinReserveSet(address indexed collection, uint256 minReserve);
    event FloorSampled(address indexed collection, uint256 price);
    event UnlockRoundRequested(uint256 requestId);
    event UnlockRoundSeeded(uint256 requestId, uint256 seed);
    event UnlockRoundExpired(uint256 requestId);
    event ReleasedToPlayers(uint256 indexed vaultId, uint256 raffleId);
    event RandomnessSet(address randomness);
    event PlayersShareSet(uint256 playersShareBps);

    error NotEngine();
    error NotHeld();
    error WrongStatus(Status status);
    error UnlockConditionsNotMet();
    error GovernanceWindowOpen(uint256 opensAt);
    error AuctionRunning();
    error OwnerPricedAuction();
    error InvalidLock();
    error InvalidPrices();
    error StaleOracle();
    error PriceNotMet(uint256 price, uint256 sent);
    error TransferFailed();
    error AlreadySampled();
    error NoRandomness();
    error NotRandomness();
    error RoundInFlight();
    error TooEarly(uint256 readyAt);
    error StaleRequest();
    error NotForPlayers();
    error NoRaffle();
    error InvalidShare();

    constructor(address owner_, ITreasury treasury_, IFloorOracle oracle_) Ownable(owner_) {
        treasury = treasury_;
        oracle = oracle_;
    }

    // ------------------------------------------------------------------ deposits

    /// @inheritdoc IVault
    function registerDeposit(address collection, uint256 tokenId, uint256 price)
        external
        returns (uint256 vaultId)
    {
        if (msg.sender != engine) revert NotEngine();
        if (IERC721(collection).ownerOf(tokenId) != address(this)) revert NotHeld();

        vaultId = ++holdingCount;
        bool forPlayers;
        if (address(raffle) != address(0) && playersShareBps != 0) {
            uint256 credit = playersCredit[collection] + playersShareBps;
            forPlayers = credit >= BPS;
            playersCredit[collection] = forPlayers ? credit - BPS : credit;
        }
        holdings[vaultId] = Holding({
            collection: collection,
            tokenId: tokenId,
            purchasePrice: uint128(price),
            acquiredAt: uint40(block.timestamp),
            lockedUntil: uint40(block.timestamp + (forPlayers ? PLAYERS_LOCK : MIN_LOCK)),
            unlockedAt: 0,
            status: Status.Locked
        });
        if (forPlayers) isPlayersHolding[vaultId] = true;
        ++heldCount[collection];
        emit Deposited(vaultId, collection, tokenId, price);
    }

    // ------------------------------------------------------------------ floor samples

    /// @notice Record today's oracle floor for `collection`. Anyone may call, once per interval.
    function sampleFloor(address collection) external {
        uint256 slot = block.timestamp / SAMPLE_INTERVAL + 1;
        if (lastSampleSlot[collection] >= slot) revert AlreadySampled();
        (bool fresh, uint256 floor) = _tryFloor(collection);
        if (!fresh || floor > type(uint128).max) revert StaleOracle();
        lastSampleSlot[collection] = slot;
        _samples[collection][sampleCount[collection]++ % FLOOR_SAMPLES] =
            FloorSample(uint128(floor), uint40(block.timestamp));
        emit FloorSampled(collection, floor);
    }

    /// @notice Lower median of the samples taken in the last `FLOOR_SAMPLES` intervals. Not usable with
    ///         fewer than `MIN_FLOOR_SAMPLES` of them.
    function medianFloor(address collection) public view returns (bool usable, uint256 median) {
        FloorSample[FLOOR_SAMPLES] storage ring = _samples[collection];
        uint256[FLOOR_SAMPLES] memory prices;
        uint256 n;
        uint256 horizon = FLOOR_SAMPLES * SAMPLE_INTERVAL;
        for (uint256 i; i < FLOOR_SAMPLES; ++i) {
            FloorSample memory s = ring[i];
            if (s.takenAt == 0 || s.takenAt + horizon <= block.timestamp) continue;
            uint256 j = n++;
            for (; j > 0 && prices[j - 1] > s.price; --j) {
                prices[j] = prices[j - 1];
            }
            prices[j] = s.price;
        }
        if (n < MIN_FLOOR_SAMPLES) return (false, 0);
        return (true, prices[(n - 1) / 2]);
    }

    // ------------------------------------------------------------------ the unlock draw

    /// @notice Ask for the day's random word. Anyone may call, once per `ROUND_INTERVAL`.
    function requestUnlockRound() external {
        if (address(randomness) == address(0)) revert NoRandomness();
        if (roundPending && block.timestamp < roundRequestedAt + ROUND_TIMEOUT) revert RoundInFlight();
        uint256 readyAt = uint256(roundRequestedAt) + ROUND_INTERVAL;
        if (roundRequestedAt != 0 && block.timestamp < readyAt) revert TooEarly(readyAt);
        roundPending = true;
        roundRequestedAt = uint40(block.timestamp);
        uint256 requestId = randomness.requestRandomness();
        roundRequestId = requestId;
        emit UnlockRoundRequested(requestId);
    }

    /// @inheritdoc IRandomnessConsumer
    function fulfillRandomness(uint256 requestId, uint256 randomWord) external {
        if (msg.sender != address(randomness)) revert NotRandomness();
        if (!roundPending || requestId != roundRequestId) revert StaleRequest();
        roundPending = false;
        // A word that arrives late is not used, so whoever saw it first cannot choose to deliver it.
        if (block.timestamp >= uint256(roundRequestedAt) + ROUND_TIMEOUT) {
            emit UnlockRoundExpired(requestId);
            return;
        }
        roundSeed = randomWord;
        seedRequestedAt = roundRequestedAt;
        seedArrivedAt = uint40(block.timestamp);
        emit UnlockRoundSeeded(requestId, randomWord);
    }

    /// @notice Floor multiple, in basis points, a holding of this age needs to unlock.
    function requiredFloorBps(uint256 age) public pure returns (uint256) {
        return _ramp(age, UNLOCK_START_BPS, UNLOCK_END_BPS);
    }

    /// @notice Chance, in basis points, that a holding of this age is picked in one draw.
    function drawChanceBps(uint256 age) public pure returns (uint256) {
        return _ramp(age, DRAW_START_BPS, DRAW_END_BPS);
    }

    /// @notice True when the current draw picked this holding. Only holdings whose lock had ended when
    ///         the draw was requested take part, so nobody can know the outcome for a holding before it
    ///         is eligible.
    function isPicked(uint256 vaultId) public view returns (bool) {
        Holding memory h = holdings[vaultId];
        if (seedArrivedAt == 0 || block.timestamp >= uint256(seedArrivedAt) + SEED_LIFETIME) return false;
        if (h.lockedUntil > seedRequestedAt || h.acquiredAt > seedRequestedAt) return false;
        uint256 roll = uint256(keccak256(abi.encode(roundSeed, vaultId))) % BPS;
        return roll < drawChanceBps(seedRequestedAt - h.acquiredAt);
    }

    /// @notice How many more of a collection's holdings can unlock in the current release period.
    function releaseAllowance(address collection) public view returns (uint256) {
        ReleaseWindow memory w = releaseWindows[collection];
        if (w.start == 0 || block.timestamp >= uint256(w.start) + RELEASE_PERIOD) return _newCap(collection);
        return w.cap > w.used ? w.cap - w.used : 0;
    }

    // ------------------------------------------------------------------ unlocking

    /// @notice True when the current draw picked this holding, the 30-day median floor meets the
    ///         multiple its age requires, and the collection's release cap has room.
    function canUnlock(uint256 vaultId) public view returns (bool) {
        Holding memory h = holdings[vaultId];
        if (h.status != Status.Locked || isPlayersHolding[vaultId] || !isPicked(vaultId)) return false;
        (bool usable, uint256 median) = medianFloor(h.collection);
        if (!usable || median < _required(h)) return false;
        return releaseAllowance(h.collection) != 0;
    }

    function unlock(uint256 vaultId) external {
        if (!canUnlock(vaultId)) revert UnlockConditionsNotMet();
        Holding storage h = holdings[vaultId];
        _useAllowance(h.collection);
        uint256 bps = requiredFloorBps(seedRequestedAt - h.acquiredAt);
        unlockBpsOf[vaultId] = bps;
        // Remember the median floor, capped so that a pumped oracle cannot push the opening price of
        // every later auction out of reach.
        (, uint256 median) = medianFloor(h.collection);
        uint256 cap = uint256(h.purchasePrice) * bps / BPS * AUCTION_START_MULTIPLE;
        unlockFloorOf[vaultId] = median > cap ? cap : median;
        _unlock(vaultId, false);
    }

    /// @notice Governance override: unlock regardless of time or price.
    function governanceUnlock(uint256 vaultId) external onlyOwner {
        Status status = holdings[vaultId].status;
        if (status != Status.Locked) revert WrongStatus(status);
        delete unlockFloorOf[vaultId];
        _unlock(vaultId, true);
    }

    /// @notice Governance override: extend the lock of a locked holding, or relock an unlocked one.
    ///         The price condition still applies when the new lock ends.
    function relock(uint256 vaultId, uint256 lockedUntil) external onlyOwner {
        Holding storage h = holdings[vaultId];
        if (h.status != Status.Locked && h.status != Status.Unlocked) revert WrongStatus(h.status);
        if (lockedUntil <= block.timestamp || lockedUntil <= h.lockedUntil || lockedUntil > type(uint40).max)
        {
            revert InvalidLock();
        }
        h.status = Status.Locked;
        h.lockedUntil = uint40(lockedUntil);
        emit Relocked(vaultId, lockedUntil);
    }

    function _unlock(uint256 vaultId, bool byGovernance) private {
        Holding storage h = holdings[vaultId];
        h.status = Status.Unlocked;
        h.unlockedAt = uint40(block.timestamp);
        emit Unlocked(vaultId, byGovernance);
    }

    // ------------------------------------------------------------------ raffle

    /// @notice Hand an unlocked NFT to the raffle contract as a prize for points holders.
    function sendToRaffle(uint256 vaultId) external onlyOwner returns (uint256 raffleId) {
        Holding storage h = holdings[vaultId];
        if (h.status != Status.Unlocked) revert WrongStatus(h.status);
        raffleId = _toRaffle(vaultId, h);
        emit SentToRaffle(vaultId, raffleId);
    }

    /// @notice Send a holding set aside for players to the raffle once its lock has ended. Anyone may
    ///         call.
    function releaseToPlayers(uint256 vaultId) external returns (uint256 raffleId) {
        Holding storage h = holdings[vaultId];
        if (!isPlayersHolding[vaultId]) revert NotForPlayers();
        if (h.status != Status.Locked) revert WrongStatus(h.status);
        if (block.timestamp < h.lockedUntil) revert TooEarly(h.lockedUntil);
        if (address(raffle) == address(0)) revert NoRaffle();
        raffleId = _toRaffle(vaultId, h);
        emit ReleasedToPlayers(vaultId, raffleId);
    }

    function _toRaffle(uint256 vaultId, Holding storage h) private returns (uint256 raffleId) {
        h.status = Status.Released;
        --heldCount[h.collection];
        IERC721(h.collection).transferFrom(address(this), address(raffle), h.tokenId);
        raffleId = raffle.open(h.collection, h.tokenId);
    }

    // ------------------------------------------------------------------ auction

    /// @notice Start a Dutch auction at oracle-based prices. The reserve is the highest of the oracle
    ///         floor, the unlock price (130% of the purchase price) and the collection's `minReserveOf`.
    ///         The unlock price is the floor multiple recorded at unlock (130% for a governance unlock).
    ///         The auction opens at 16 times the reserve, or 16 times the floor seen at unlock if that is
    ///         higher, and the sale price is found on the way down, so a manipulated oracle cannot make
    ///         the Vault sell cheaply. Selling below the unlock price needs the owner and
    ///         `startAuctionWithPrices`. The owner may start an auction as soon as the holding is
    ///         unlocked; anyone may once the governance window has passed. An oracle-priced auction that
    ///         has fallen to its reserve without a buyer can be restarted by anyone.
    function startAuction(uint256 vaultId) external {
        Holding memory h = holdings[vaultId];
        _checkAuctionable(vaultId, h);
        if (h.status == Status.Unlocked && msg.sender != owner()) {
            uint256 opensAt = h.unlockedAt + GOVERNANCE_WINDOW;
            if (block.timestamp < opensAt) revert GovernanceWindowOpen(opensAt);
        }
        (bool fresh, uint256 floor) = _tryFloor(h.collection);
        if (!fresh) revert StaleOracle();
        uint256 bps = unlockBpsOf[vaultId];
        uint256 reserve = uint256(h.purchasePrice) * (bps == 0 ? UNLOCK_START_BPS : bps) / BPS;
        if (floor > reserve) reserve = floor;
        if (minReserveOf[h.collection] > reserve) reserve = minReserveOf[h.collection];
        uint256 opening = unlockFloorOf[vaultId] > reserve ? unlockFloorOf[vaultId] : reserve;
        isOwnerPriced[vaultId] = false;
        _startAuction(vaultId, opening * AUCTION_START_MULTIPLE, reserve);
    }

    /// @notice Governance override: auction at chosen prices, for example to exit a collection that has
    ///         collapsed or has no usable oracle. Only the owner can restart or replace this auction.
    function startAuctionWithPrices(uint256 vaultId, uint256 startPrice, uint256 endPrice)
        external
        onlyOwner
    {
        _checkAuctionable(vaultId, holdings[vaultId]);
        isOwnerPriced[vaultId] = true;
        _startAuction(vaultId, startPrice, endPrice);
    }

    /// @notice Current auction price: halves every `AUCTION_HALF_LIFE`, falling linearly within each
    ///         half-life, and never goes below the end price.
    function auctionPrice(uint256 vaultId) public view returns (uint256) {
        Status status = holdings[vaultId].status;
        if (status != Status.Auction) revert WrongStatus(status);
        Auction memory a = auctions[vaultId];
        uint256 elapsed = block.timestamp - a.startTime;
        uint256 halvings = elapsed / AUCTION_HALF_LIFE;
        if (halvings >= 128) return a.endPrice;
        uint256 price = uint256(a.startPrice) >> halvings;
        price -= (price / 2) * (elapsed % AUCTION_HALF_LIFE) / AUCTION_HALF_LIFE;
        return price > a.endPrice ? price : a.endPrice;
    }

    /// @notice Governance override: take a holding off auction, back to unlocked, so it can be relocked,
    ///         raffled or auctioned again.
    function cancelAuction(uint256 vaultId) external onlyOwner {
        Holding storage h = holdings[vaultId];
        if (h.status != Status.Auction) revert WrongStatus(h.status);
        h.status = Status.Unlocked;
        // the governance window starts again, so the owner has time to relock, raffle or re-auction
        h.unlockedAt = uint40(block.timestamp);
        delete auctions[vaultId];
        delete isOwnerPriced[vaultId];
        emit AuctionCancelled(vaultId);
    }

    /// @notice Buy an auctioned NFT at the current price. `msg.value` is the most the buyer will pay;
    ///         anything above the price is refunded.
    function buy(uint256 vaultId) external payable nonReentrant {
        uint256 price = auctionPrice(vaultId);
        if (msg.value < price) revert PriceNotMet(price, msg.value);

        Holding storage h = holdings[vaultId];
        h.status = Status.Released;
        --heldCount[h.collection];
        emit AuctionSold(vaultId, msg.sender, price);

        IERC721(h.collection).transferFrom(address(this), msg.sender, h.tokenId);
        treasury.deposit{value: price}(h.collection);
        if (msg.value > price) {
            (bool ok,) = msg.sender.call{value: msg.value - price}("");
            if (!ok) revert TransferFailed();
        }
    }

    /// @dev A holding can go to auction when it is unlocked, or when its current auction has fallen to
    ///      its end price without a buyer. Only the owner can replace an owner-priced auction.
    function _checkAuctionable(uint256 vaultId, Holding memory h) private view {
        if (h.status == Status.Auction) {
            // An auction can be restarted once it has rested at its end price for a day, so that buyers
            // get a real chance at that price before it jumps back up.
            if (block.timestamp < _reachesEndAt(auctions[vaultId]) + AUCTION_RESTART_DWELL) {
                revert AuctionRunning();
            }
            if (isOwnerPriced[vaultId] && msg.sender != owner()) revert OwnerPricedAuction();
        } else if (h.status != Status.Unlocked) {
            revert WrongStatus(h.status);
        }
    }

    /// @dev The end of the half-life in which an auction's price reaches its end price.
    function _reachesEndAt(Auction memory a) private pure returns (uint256) {
        uint256 halvings;
        uint256 price = a.startPrice;
        while (price > a.endPrice && halvings < 128) {
            price >>= 1;
            ++halvings;
        }
        return a.startTime + halvings * AUCTION_HALF_LIFE;
    }

    function _startAuction(uint256 vaultId, uint256 startPrice, uint256 endPrice) private {
        if (endPrice == 0 || startPrice < endPrice || startPrice > type(uint128).max) revert InvalidPrices();
        holdings[vaultId].status = Status.Auction;
        auctions[vaultId] = Auction({
            startPrice: uint128(startPrice), endPrice: uint128(endPrice), startTime: uint40(block.timestamp)
        });
        emit AuctionStarted(vaultId, startPrice, endPrice);
    }

    // ------------------------------------------------------------------ admin

    function setEngine(address engine_) external onlyOwner {
        engine = engine_;
        emit EngineSet(engine_);
    }

    function setOracle(IFloorOracle oracle_) external onlyOwner {
        oracle = oracle_;
        emit OracleSet(address(oracle_));
    }

    function setRaffle(IVaultRaffle raffle_) external onlyOwner {
        raffle = raffle_;
        emit RaffleSet(address(raffle_));
    }

    function setMinReserve(address collection, uint256 minReserve) external onlyOwner {
        minReserveOf[collection] = minReserve;
        emit MinReserveSet(collection, minReserve);
    }

    function setMaxOracleAge(uint256 maxOracleAge_) external onlyOwner {
        maxOracleAge = maxOracleAge_;
        emit MaxOracleAgeSet(maxOracleAge_);
    }

    /// @dev Changing the provider strands a draw in flight; a new one can be requested after the timeout.
    function setRandomness(IRandomnessProvider randomness_) external onlyOwner {
        randomness = randomness_;
        emit RandomnessSet(address(randomness_));
    }

    /// @notice Share of future purchases set aside for players. Zero turns it off.
    function setPlayersShare(uint256 bps) external onlyOwner {
        if (bps > MAX_PLAYERS_SHARE_BPS) revert InvalidShare();
        playersShareBps = bps;
        emit PlayersShareSet(bps);
    }

    function _required(Holding memory h) private view returns (uint256) {
        return uint256(h.purchasePrice) * requiredFloorBps(seedRequestedAt - h.acquiredAt) / BPS;
    }

    function _ramp(uint256 age, uint256 atStart, uint256 atEnd) private pure returns (uint256) {
        if (age <= MIN_LOCK) return atStart;
        if (age >= FULL_AGE) return atEnd;
        uint256 progress = age - MIN_LOCK;
        uint256 span = FULL_AGE - MIN_LOCK;
        return atStart > atEnd
            ? atStart - (atStart - atEnd) * progress / span
            : atStart + (atEnd - atStart) * progress / span;
    }

    function _newCap(address collection) private view returns (uint256) {
        uint256 cap = heldCount[collection] * RELEASE_CAP_BPS / BPS;
        return cap == 0 ? 1 : cap;
    }

    function _useAllowance(address collection) private {
        ReleaseWindow storage w = releaseWindows[collection];
        if (w.start == 0 || block.timestamp >= uint256(w.start) + RELEASE_PERIOD) {
            w.start = uint40(block.timestamp);
            w.cap = uint32(_newCap(collection));
            w.used = 0;
        }
        ++w.used;
    }

    function _tryFloor(address collection) private view returns (bool fresh, uint256 price) {
        try oracle.floorPrice(collection) returns (uint256 p, uint256 updatedAt) {
            return (p != 0 && updatedAt + maxOracleAge >= block.timestamp, p);
        } catch {
            return (false, 0);
        }
    }
}
