// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {ITreasury, ISaleRecorder, IPoints} from "./interfaces/IFloorGuard.sol";

/// @title Marketplace
/// @notice Offer/accept NFT trading with no listings. Buyers escrow ETH in an offer on one token or on
///         any token of a collection; a holder accepts to swap atomically. The protocol fee goes to the
///         Treasury as buyback budget for the traded collection, and ERC-2981 royalties are honoured.
contract Marketplace is Ownable2Step, ReentrancyGuard {
    struct Offer {
        address offerer;
        address collection;
        uint256 tokenId; // ignored for collection-wide offers
        uint128 price; // per item, in wei
        uint32 remaining; // items still wanted
        uint40 expiry;
        bool collectionWide;
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 500;
    uint256 public constant MAX_ROYALTY_CAP_BPS = 1_000;
    uint256 private constant ROYALTY_GAS = 50_000;

    ITreasury public immutable treasury;
    /// @notice Optional. Receives the price of collection-offer fills, which are floor-type sales.
    ISaleRecorder public saleRecorder;
    /// @notice Optional. Credited with the fee each side of a trade generates.
    IPoints public points;

    uint256 public feeBps = 200;
    /// @notice Royalties above this share of the price are truncated. Zero disables royalties.
    uint256 public royaltyCapBps = 500;

    /// @notice Collections the protocol defends. Their fees are earmarked for their own buybacks, their
    ///         trades earn points and their collection-offer fills feed the oracle. Any other contract
    ///         can still be traded, but its fees go to the Treasury's unallocated pool and earn nothing.
    mapping(address collection => bool) public isSupported;

    uint256 public offerCount;
    mapping(uint256 offerId => Offer) public offers;

    event OfferMade(
        uint256 indexed offerId,
        address indexed offerer,
        address indexed collection,
        uint256 tokenId,
        bool collectionWide,
        uint256 price,
        uint256 quantity,
        uint256 expiry
    );
    event OfferCancelled(uint256 indexed offerId, uint256 refund);
    event OfferAccepted(
        uint256 indexed offerId,
        address indexed seller,
        address indexed collection,
        uint256 tokenId,
        uint256 price,
        uint256 fee,
        uint256 royalty
    );
    event FeeSet(uint256 feeBps);
    event RoyaltyCapSet(uint256 royaltyCapBps);
    event SaleRecorderSet(address saleRecorder);
    event PointsSet(address points);
    event CollectionSupportSet(address indexed collection, bool supported);

    error InvalidPrice();
    error InvalidQuantity();
    error InvalidExpiry();
    error OfferInactive();
    error OfferExpired();
    error NotOfferer();
    error WrongToken();
    error ProceedsTooLow(uint256 proceeds, uint256 minProceeds);
    error TooHigh();
    error TransferFailed();
    error NotAContract();

    constructor(address owner_, ITreasury treasury_) Ownable(owner_) {
        treasury = treasury_;
    }

    // ------------------------------------------------------------------ offers

    /// @notice Offer `msg.value` for one specific token.
    function makeOffer(address collection, uint256 tokenId, uint256 expiry)
        external
        payable
        returns (uint256)
    {
        return _makeOffer(collection, tokenId, false, msg.value, 1, expiry);
    }

    /// @notice Offer to buy `quantity` tokens of a collection, any token id, at `msg.value / quantity` each.
    function makeCollectionOffer(address collection, uint256 quantity, uint256 expiry)
        external
        payable
        returns (uint256)
    {
        if (quantity == 0 || quantity > type(uint32).max || msg.value % quantity != 0) {
            revert InvalidQuantity();
        }
        return _makeOffer(collection, 0, true, msg.value / quantity, quantity, expiry);
    }

    function _makeOffer(
        address collection,
        uint256 tokenId,
        bool collectionWide,
        uint256 price,
        uint256 quantity,
        uint256 expiry
    ) private returns (uint256 offerId) {
        if (price == 0 || price > type(uint128).max) revert InvalidPrice();
        if (expiry <= block.timestamp || expiry > type(uint40).max) revert InvalidExpiry();

        offerId = ++offerCount;
        offers[offerId] = Offer({
            offerer: msg.sender,
            collection: collection,
            tokenId: tokenId,
            price: uint128(price),
            remaining: uint32(quantity),
            expiry: uint40(expiry),
            collectionWide: collectionWide
        });
        emit OfferMade(offerId, msg.sender, collection, tokenId, collectionWide, price, quantity, expiry);
    }

    /// @notice Withdraw the unfilled part of an offer. Allowed at any time, expired or not.
    function cancelOffer(uint256 offerId) external nonReentrant {
        Offer memory offer = offers[offerId];
        if (offer.remaining == 0) revert OfferInactive();
        if (offer.offerer != msg.sender) revert NotOfferer();

        delete offers[offerId];
        uint256 refund = uint256(offer.price) * offer.remaining;
        emit OfferCancelled(offerId, refund);
        _send(msg.sender, refund);
    }

    /// @notice Sell `tokenId` into an offer. The caller must own the token and have approved this contract.
    /// @param minProceeds Reverts if the seller would receive less, guarding against fee or royalty changes.
    function acceptOffer(uint256 offerId, uint256 tokenId, uint256 minProceeds) external nonReentrant {
        Offer memory offer = offers[offerId];
        if (offer.remaining == 0) revert OfferInactive();
        if (block.timestamp > offer.expiry) revert OfferExpired();
        if (!offer.collectionWide && tokenId != offer.tokenId) revert WrongToken();

        if (offer.remaining == 1) delete offers[offerId];
        else offers[offerId].remaining = offer.remaining - 1;

        uint256 price = offer.price;
        uint256 fee = price * feeBps / BPS;
        (address royaltyReceiver, uint256 royalty) = _royaltyInfo(offer.collection, tokenId, price);
        uint256 proceeds = price - fee - royalty;
        if (proceeds < minProceeds) revert ProceedsTooLow(proceeds, minProceeds);

        IERC721(offer.collection).safeTransferFrom(msg.sender, offer.offerer, tokenId);

        if (royalty != 0) {
            // A royalty receiver that cannot take ETH forfeits it to the collection's buyback budget.
            (bool paid,) = royaltyReceiver.call{value: royalty, gas: ROYALTY_GAS}("");
            if (!paid) {
                fee += royalty;
                royalty = 0;
            }
        }
        bool supported = isSupported[offer.collection];
        uint256 toBudget;
        if (fee != 0) {
            if (supported) toBudget = treasury.depositFee{value: fee}(offer.collection);
            else _send(address(treasury), fee);
        }
        _send(msg.sender, proceeds);

        if (supported) {
            if (offer.collectionWide && address(saleRecorder) != address(0)) {
                // price reporting is best effort and must never block a trade
                try saleRecorder.recordSale(offer.collection, price) {} catch {}
            }
            if (address(points) != address(0) && toBudget != 0) {
                // Points follow what reached the buyback budget, not the project's share of the fee.
                // Each fee is credited once, half to each side, so trading with oneself earns no more
                // than one point per unit of fee.
                // They are a bonus; a failure there must never block a trade.
                try points.creditFee(msg.sender, toBudget / 2) {} catch {}
                try points.creditFee(offer.offerer, toBudget - toBudget / 2) {} catch {}
            }
        }
        emit OfferAccepted(offerId, msg.sender, offer.collection, tokenId, price, fee, royalty);
    }

    // ------------------------------------------------------------------ admin

    function setFee(uint256 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert TooHigh();
        feeBps = feeBps_;
        emit FeeSet(feeBps_);
    }

    function setRoyaltyCap(uint256 royaltyCapBps_) external onlyOwner {
        if (royaltyCapBps_ > MAX_ROYALTY_CAP_BPS) revert TooHigh();
        royaltyCapBps = royaltyCapBps_;
        emit RoyaltyCapSet(royaltyCapBps_);
    }

    function setSaleRecorder(ISaleRecorder saleRecorder_) external onlyOwner {
        if (address(saleRecorder_) != address(0) && address(saleRecorder_).code.length == 0) {
            revert NotAContract();
        }
        saleRecorder = saleRecorder_;
        emit SaleRecorderSet(address(saleRecorder_));
    }

    function setCollectionSupport(address collection, bool supported) external onlyOwner {
        isSupported[collection] = supported;
        emit CollectionSupportSet(collection, supported);
    }

    function setPoints(IPoints points_) external onlyOwner {
        if (address(points_) != address(0) && address(points_).code.length == 0) revert NotAContract();
        points = points_;
        emit PointsSet(address(points_));
    }

    // ------------------------------------------------------------------ internal

    function _royaltyInfo(address collection, uint256 tokenId, uint256 price)
        private
        view
        returns (address receiver, uint256 amount)
    {
        uint256 cap = price * royaltyCapBps / BPS;
        if (cap == 0) return (address(0), 0);
        // Low-level call: a collection without ERC-2981 may revert or return nothing, and neither may
        // stop the sale.
        (bool ok, bytes memory data) =
            collection.staticcall{gas: ROYALTY_GAS}(abi.encodeCall(IERC2981.royaltyInfo, (tokenId, price)));
        if (!ok || data.length != 64) return (address(0), 0);
        (uint256 rawReceiver, uint256 a) = abi.decode(data, (uint256, uint256));
        if (rawReceiver == 0 || rawReceiver > type(uint160).max) return (address(0), 0);
        return (address(uint160(rawReceiver)), a > cap ? cap : a);
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
