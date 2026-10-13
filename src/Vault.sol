// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ITreasury, IVault, IFloorOracle, IVaultRaffle} from "./interfaces/IFloorGuard.sol";

/// @title Vault
/// @notice Holds NFTs bought by the BuybackEngine. A holding unlocks once it has been held for
///         `LOCK_DURATION` and the collection floor is at least `UNLOCK_BPS` of the purchase price. After
///         unlocking, the owner (governance) may raffle it, relock it or auction it. If governance does
///         nothing for `GOVERNANCE_WINDOW`, anyone can start a Dutch auction. Auction proceeds return to
///         the collection's Treasury budget.
contract Vault is IVault, Ownable2Step, ReentrancyGuard {
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

    uint256 public constant BPS = 10_000;
    uint256 public constant LOCK_DURATION = 180 days;
    uint256 public constant UNLOCK_BPS = 13_000;
    uint256 public constant GOVERNANCE_WINDOW = 30 days;
    /// @notice An auction opens at this multiple of its reserve, far above any plausible market price,
    ///         and halves every `AUCTION_HALF_LIFE` until it reaches the reserve. The sale price is found
    ///         by buyers competing on the way down, not by where the auction starts.
    uint256 public constant AUCTION_START_MULTIPLE = 16;
    uint256 public constant AUCTION_HALF_LIFE = 1 days;
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
        holdings[vaultId] = Holding({
            collection: collection,
            tokenId: tokenId,
            purchasePrice: uint128(price),
            acquiredAt: uint40(block.timestamp),
            lockedUntil: uint40(block.timestamp + LOCK_DURATION),
            unlockedAt: 0,
            status: Status.Locked
        });
        emit Deposited(vaultId, collection, tokenId, price);
    }

    // ------------------------------------------------------------------ unlocking

    /// @notice True when the time lock has passed and the floor is at least 130% of the purchase price.
    function canUnlock(uint256 vaultId) public view returns (bool) {
        Holding memory h = holdings[vaultId];
        if (h.status != Status.Locked || block.timestamp < h.lockedUntil) return false;
        (bool fresh, uint256 floor) = _tryFloor(h.collection);
        return fresh && floor >= uint256(h.purchasePrice) * UNLOCK_BPS / BPS;
    }

    function unlock(uint256 vaultId) external {
        if (!canUnlock(vaultId)) revert UnlockConditionsNotMet();
        // Remember the floor seen now, capped so that a pumped oracle cannot push the opening price of
        // every later auction out of reach.
        Holding storage h = holdings[vaultId];
        (, uint256 floor) = _tryFloor(h.collection);
        uint256 cap = uint256(h.purchasePrice) * UNLOCK_BPS / BPS * AUCTION_START_MULTIPLE;
        unlockFloorOf[vaultId] = floor > cap ? cap : floor;
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
        h.status = Status.Released;

        IERC721(h.collection).transferFrom(address(this), address(raffle), h.tokenId);
        raffleId = raffle.open(h.collection, h.tokenId);
        emit SentToRaffle(vaultId, raffleId);
    }

    // ------------------------------------------------------------------ auction

    /// @notice Start a Dutch auction at oracle-based prices. The reserve is the highest of the oracle
    ///         floor, the unlock price (130% of the purchase price) and the collection's `minReserveOf`.
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
        uint256 reserve = uint256(h.purchasePrice) * UNLOCK_BPS / BPS;
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
            if (auctionPrice(vaultId) > auctions[vaultId].endPrice) revert AuctionRunning();
            if (isOwnerPriced[vaultId] && msg.sender != owner()) revert OwnerPricedAuction();
        } else if (h.status != Status.Unlocked) {
            revert WrongStatus(h.status);
        }
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

    function _tryFloor(address collection) private view returns (bool fresh, uint256 price) {
        try oracle.floorPrice(collection) returns (uint256 p, uint256 updatedAt) {
            return (p != 0 && updatedAt + maxOracleAge >= block.timestamp, p);
        } catch {
            return (false, 0);
        }
    }
}
