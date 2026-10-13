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
///         without needing a price oracle. Purchases are paid from the collection's Treasury budget and
///         the NFT is locked in the Vault.
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

    error InactiveCollection();
    error InvalidConfig();
    error NotAContract();
    error BidBelowMinimum(uint256 bid, uint256 minPrice);
    error InsufficientBudget(uint256 budget, uint256 bid);
    error FillCooldown(uint256 readyAt);

    constructor(address owner_, ITreasury treasury_, IVault vault_) Ownable(owner_) {
        treasury = treasury_;
        vault = vault_;
    }

    /// @notice The price the engine pays right now for any token of `collection`.
    function currentBid(address collection) public view returns (uint256) {
        Bid memory bid = bids[collection];
        if (!bid.active) return 0;
        uint256 elapsed = block.timestamp - bid.lastReset;
        uint256 price =
            bid.basePrice + uint256(bid.basePrice) * bid.growthBpsPerDay * elapsed / (BPS * 1 days);
        return price > bid.maxPrice ? bid.maxPrice : price;
    }

    /// @notice Whether the collection's budget covers the current bid.
    function isFillable(address collection) external view returns (bool) {
        uint256 bid = currentBid(collection);
        return bid != 0 && treasury.budgetOf(collection) >= bid;
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
        if (price < minPrice) revert BidBelowMinimum(price, minPrice);
        uint256 budget = treasury.budgetOf(collection);
        if (budget < price) revert InsufficientBudget(budget, price);

        bid.basePrice = uint128(price * (BPS - bid.stepDownBps) / BPS);
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

    /// @notice Set or update a collection's bid curve. Restarts the curve at `basePrice`.
    function configureBid(
        address collection,
        uint128 basePrice,
        uint128 maxPrice,
        uint16 growthBpsPerDay,
        uint16 stepDownBps,
        bool active
    ) external onlyOwner {
        if (basePrice == 0 || basePrice > maxPrice || stepDownBps >= BPS) {
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
        emit BidConfigured(collection, basePrice, maxPrice, growthBpsPerDay, stepDownBps, active);
    }

    function setFillCooldown(address collection, uint256 cooldown) external onlyOwner {
        fillCooldownOf[collection] = cooldown;
        emit FillCooldownSet(collection, cooldown);
    }

    function setSaleRecorder(ISaleRecorder saleRecorder_) external onlyOwner {
        if (address(saleRecorder_) != address(0) && address(saleRecorder_).code.length == 0) {
            revert NotAContract();
        }
        saleRecorder = saleRecorder_;
        emit SaleRecorderSet(address(saleRecorder_));
    }
}
