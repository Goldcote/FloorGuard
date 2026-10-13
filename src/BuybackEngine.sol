// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ITreasury, IVault, ISaleRecorder} from "./interfaces/IFloorGuard.sol";

/// @title BuybackEngine
/// @notice The protocol's standing floor bid. For each supported collection the engine quotes a bid that
///         any holder can sell any token into. The bid rises linearly over time until someone sells, then
///         steps down and starts rising again, so it finds the price the cheapest seller will take
///         without needing a price oracle. The bid is never more than the collection's budget can pay,
///         and its rise only counts while the budget covers it. Purchases are paid from the
///         collection's Treasury budget and the NFT is locked in the Vault.
contract BuybackEngine is Ownable2Step, ReentrancyGuard {
    struct Bid {
        uint128 basePrice; // bid at `lastReset`
        uint128 maxPrice; // hard cap on the bid, the owner's guard against overpaying
        uint40 lastReset;
        uint16 growthBpsPerDay; // linear growth of the bid, relative to basePrice
        uint16 stepDownBps; // drop applied to the fill price to get the next basePrice
        bool active;
    }

    uint256 public constant BPS = 10_000;

    ITreasury public immutable treasury;
    IVault public immutable vault;
    /// @notice Optional. Buyback fills are floor-type sales.
    ISaleRecorder public saleRecorder;

    mapping(address collection => Bid) public bids;
    /// @notice Minimum time between two buybacks of a collection. Slows down anyone who can supply tokens
    ///         below the market price, such as a minter of a collection that is still minting.
    mapping(address collection => uint256) public fillCooldownOf;
    mapping(address collection => uint256) public lastFillAt;
    /// @notice No buyback below this share of the current base. With a thin budget the bid can be very
    ///         small; without a minimum, a seller who names no minimum price of their own could be paid
    ///         dust. Because it is a share of the base, it follows the market down with the base.
    mapping(address collection => uint256) public minBidBpsOf;
    mapping(address collection => bool) private _minBidSet;
    uint256 public constant DEFAULT_MIN_BID_BPS = 1_000;
    /// @notice The smallest base an owner or guardian may set. Below a few wei the curve cannot grow.
    uint256 public constant MIN_BASE_PRICE = 1 gwei;
    /// @notice May lower a collection's prices or pause it. Each call also restarts the curve, so the
    ///         guardian can hold a bid down, never raise it. Meant for a fast key that can react to a
    ///         falling market while the owner sits behind a timelock.
    address public guardian;

    event BidConfigured(
        address indexed collection,
        uint256 basePrice,
        uint256 maxPrice,
        uint256 growthBpsPerDay,
        uint256 stepDownBps,
        bool active
    );
    event Buyback(
        address indexed collection,
        uint256 indexed tokenId,
        address indexed seller,
        uint256 price,
        uint256 vaultId
    );
    event SaleRecorderSet(address saleRecorder);
    event FillCooldownSet(address indexed collection, uint256 cooldown);
    event CurveRestarted(address indexed collection);
    event GuardianSet(address guardian);
    event MinBidSet(address indexed collection, uint256 minBidBps);
    event BidLowered(address indexed collection, uint256 basePrice, uint256 maxPrice, bool active);

    error InactiveCollection();
    error InvalidConfig();
    error NotAContract();
    error BidBelowMinimum(uint256 bid, uint256 minPrice);
    error NothingToBid();
    error FillCooldown(uint256 readyAt);
    error CooldownTooLong(uint256 maxCooldown);
    error NotTreasury();
    error NotGuardian();

    constructor(address owner_, ITreasury treasury_, IVault vault_) Ownable(owner_) {
        treasury = treasury_;
        vault = vault_;
    }

    /// @notice The price the engine pays right now for any token of `collection`: the curve, limited by
    ///         the owner's cap and by what the collection's budget can pay.
    function currentBid(address collection) public view returns (uint256) {
        Bid memory bid = bids[collection];
        if (!bid.active) return 0;
        uint256 price = _curve(bid);
        uint256 budget = treasury.budgetOf(collection);
        return price < budget ? price : budget;
    }

    /// @notice Where the bid curve stands, whatever the budget: the base price plus linear growth since
    ///         the last restart, capped at `maxPrice`.
    function curvePrice(address collection) external view returns (uint256) {
        return _curve(bids[collection]);
    }

    /// @notice Whether a sale into the bid would go through right now.
    function isFillable(address collection) external view returns (bool) {
        uint256 bid = currentBid(collection);
        if (bid == 0 || bid < minBidOf(collection)) return false;
        return
            lastFillAt[collection] == 0
                || block.timestamp >= lastFillAt[collection] + fillCooldownOf[collection];
    }

    /// @notice Sell `tokenId` to the protocol at the current bid. The caller must own the token and have
    ///         approved this contract.
    /// @param minPrice Reverts if the bid is lower.
    function sell(address collection, uint256 tokenId, uint256 minPrice)
        external
        nonReentrant
        returns (uint256 vaultId)
    {
        Bid storage bid = bids[collection];
        if (!bid.active) revert InactiveCollection();
        uint256 readyAt = lastFillAt[collection] + fillCooldownOf[collection];
        if (lastFillAt[collection] != 0 && block.timestamp < readyAt) revert FillCooldown(readyAt);
        lastFillAt[collection] = block.timestamp;

        uint256 price = currentBid(collection);
        // a bid below the collection's minimum is not a bid: it would buy a token for dust
        if (price == 0 || price < minBidOf(collection)) revert NothingToBid();
        if (price < minPrice) revert BidBelowMinimum(price, minPrice);

        // The next round starts one step below this sale. A sale limited by a thin budget may be far
        // below the previous base: it pulls the base down by at most three steps, so the base follows a
        // falling market without one cheap sale collapsing the curve.
        uint256 drop = 3 * uint256(bid.stepDownBps);
        uint256 anchor = drop >= BPS ? 0 : uint256(bid.basePrice) * (BPS - drop) / BPS;
        if (price > anchor) anchor = price;
        uint256 newBase = anchor * (BPS - bid.stepDownBps) / BPS;
        bid.basePrice = uint128(newBase == 0 ? 1 : newBase);
        bid.lastReset = uint40(block.timestamp);

        IERC721(collection).transferFrom(msg.sender, address(vault), tokenId);
        vaultId = vault.registerDeposit(collection, tokenId, price);
        treasury.spend(collection, price, payable(msg.sender));

        if (address(saleRecorder) != address(0)) {
            // price reporting is best effort and must never block a buyback
            try saleRecorder.recordSale(collection, price) {} catch {}
        }
        emit Buyback(collection, tokenId, msg.sender, price, vaultId);
    }

    /// @notice Called by the Treasury whenever a collection's budget grows. If the budget could not
    ///         cover the curve until now, the curve restarts from the higher of its base and the old
    ///         budget: the rise that built up while nobody could have been paid is discarded. This
    ///         stops money that arrives late or in a lump being spent at an inflated bid, provided the
    ///         base itself is not stale; after a sharp fall in the market the owner or guardian should
    ///         lower the bid before a lump arrives.
    function onBudgetIncrease(address collection, uint256 budgetBefore) external {
        if (msg.sender != address(treasury)) revert NotTreasury();
        Bid storage bid = bids[collection];
        if (bid.active && budgetBefore < _curve(bid)) {
            // The bid until now was the budget. Restart from there if it is above the base, so that
            // money arriving never lowers the bid.
            if (budgetBefore > bid.basePrice) bid.basePrice = uint128(budgetBefore);
            bid.lastReset = uint40(block.timestamp);
            emit CurveRestarted(collection);
        }
    }

    /// @notice Set or update a collection's bid curve. Restarts the curve at `basePrice`.
    function configureBid(
        address collection,
        uint128 basePrice,
        uint128 maxPrice,
        uint16 growthBpsPerDay,
        uint16 stepDownBps,
        bool active
    ) external onlyOwner {
        if (basePrice < MIN_BASE_PRICE || basePrice > maxPrice || stepDownBps >= BPS) {
            revert InvalidConfig();
        }
        bids[collection] = Bid({
            basePrice: basePrice,
            maxPrice: maxPrice,
            lastReset: uint40(block.timestamp),
            growthBpsPerDay: growthBpsPerDay,
            stepDownBps: stepDownBps,
            active: active
        });
        _checkCooldown(collection, fillCooldownOf[collection]);
        if (!_minBidSet[collection]) minBidBpsOf[collection] = DEFAULT_MIN_BID_BPS;
        emit BidConfigured(collection, basePrice, maxPrice, growthBpsPerDay, stepDownBps, active);
    }

    /// @notice Set the minimum time between two buybacks of a collection. It must be short enough that
    ///         the bid cannot grow back past its last price before the next sale is allowed.
    function setFillCooldown(address collection, uint256 cooldown) external onlyOwner {
        _checkCooldown(collection, cooldown);
        fillCooldownOf[collection] = cooldown;
        emit FillCooldownSet(collection, cooldown);
    }

    /// @notice Guardian or owner: lower a collection's base and maximum price, or pause it. Prices can
    ///         only go down and a paused collection can only be reactivated by the owner.
    function lowerBid(address collection, uint128 basePrice, uint128 maxPrice, bool active) external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        Bid storage bid = bids[collection];
        if (
            basePrice < MIN_BASE_PRICE || basePrice > maxPrice || basePrice > bid.basePrice
                || maxPrice > bid.maxPrice || (active && !bid.active)
        ) revert InvalidConfig();
        bid.basePrice = basePrice;
        bid.maxPrice = maxPrice;
        bid.active = active;
        bid.lastReset = uint40(block.timestamp);
        emit BidLowered(collection, basePrice, maxPrice, active);
    }

    /// @notice The lowest bid at which the engine buys right now.
    function minBidOf(address collection) public view returns (uint256) {
        return uint256(bids[collection].basePrice) * minBidBpsOf[collection] / BPS;
    }

    /// @notice Set the minimum bid as a share of the base. Zero turns it off.
    function setMinBid(address collection, uint256 minBidBps) external onlyOwner {
        if (minBidBps > BPS) revert InvalidConfig();
        minBidBpsOf[collection] = minBidBps;
        _minBidSet[collection] = true;
        emit MinBidSet(collection, minBidBps);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    function setSaleRecorder(ISaleRecorder saleRecorder_) external onlyOwner {
        if (address(saleRecorder_) != address(0) && address(saleRecorder_).code.length == 0) {
            revert NotAContract();
        }
        saleRecorder = saleRecorder_;
        emit SaleRecorderSet(address(saleRecorder_));
    }

    function _curve(Bid memory bid) private view returns (uint256) {
        uint256 elapsed = block.timestamp - bid.lastReset;
        uint256 price =
            bid.basePrice + uint256(bid.basePrice) * bid.growthBpsPerDay * elapsed / (BPS * 1 days);
        return price > bid.maxPrice ? bid.maxPrice : price;
    }

    /// @dev After a fill the base drops by `stepDown` and regrows at `growth` a day, so it is back at
    ///      the fill price after `stepDown / ((1 - stepDown) * growth)` days. A longer cooldown would
    ///      let every sale happen above the previous one.
    function _checkCooldown(address collection, uint256 cooldown) private view {
        Bid memory bid = bids[collection];
        if (cooldown == 0 || bid.growthBpsPerDay == 0) return;
        uint256 maxCooldown =
            uint256(bid.stepDownBps) * BPS * 1 days / (uint256(BPS - bid.stepDownBps) * bid.growthBpsPerDay);
        if (cooldown > maxCooldown) revert CooldownTooLong(maxCooldown);
    }
}
