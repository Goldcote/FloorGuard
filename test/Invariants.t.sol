// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {BuybackEngine} from "../src/BuybackEngine.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockNFT} from "./mocks/MockNFT.sol";

/// @dev Drives the marketplace, the buyback engine and the treasury with random actions.
contract Handler is Test {
    Marketplace internal marketplace;
    BuybackEngine internal engine;
    Treasury internal treasury;
    MockNFT internal nft;

    uint256[] public offerIds;
    uint256 internal nextToken = 1;
    uint256 public buybacks;

    constructor(Marketplace marketplace_, BuybackEngine engine_, Treasury treasury_, MockNFT nft_) {
        marketplace = marketplace_;
        engine = engine_;
        treasury = treasury_;
        nft = nft_;
    }

    function offerCount() external view returns (uint256) {
        return offerIds.length;
    }

    function _actor(uint8 seed) internal returns (address actor) {
        actor = address(uint160(0xA000 + seed % 4));
        vm.deal(actor, 10_000 ether);
    }

    function makeOffer(uint8 actorSeed, uint96 price, uint8 quantity, bool collectionWide) external {
        address actor = _actor(actorSeed);
        uint256 p = bound(price, 1, 50 ether);
        uint256 expiry = block.timestamp + 1 days;
        vm.prank(actor);
        if (collectionWide) {
            uint256 q = bound(quantity, 1, 4);
            offerIds.push(marketplace.makeCollectionOffer{value: p * q}(address(nft), q, expiry));
        } else {
            offerIds.push(marketplace.makeOffer{value: p}(address(nft), nextToken, expiry));
        }
    }

    function acceptOffer(uint8 actorSeed, uint256 offerSeed) external {
        if (offerIds.length == 0) return;
        uint256 id = offerIds[offerSeed % offerIds.length];
        (,, uint256 wantedToken,, uint32 remaining, uint40 expiry, bool collectionWide) =
            marketplace.offers(id);
        if (remaining == 0 || block.timestamp > expiry) return;

        address seller = _actor(actorSeed);
        uint256 tokenId = collectionWide ? nextToken : wantedToken;
        if (!collectionWide && wantedToken != nextToken) return; // that token was already minted and sold
        nextToken++;
        nft.mint(seller, tokenId);
        vm.startPrank(seller);
        nft.approve(address(marketplace), tokenId);
        marketplace.acceptOffer(id, tokenId, 0);
        vm.stopPrank();
    }

    function cancelOffer(uint256 offerSeed) external {
        if (offerIds.length == 0) return;
        uint256 id = offerIds[offerSeed % offerIds.length];
        (address offerer,,,, uint32 remaining,,) = marketplace.offers(id);
        if (remaining == 0) return;
        vm.prank(offerer);
        marketplace.cancelOffer(id);
    }

    function sellToEngine(uint8 actorSeed) external {
        if (!engine.isFillable(address(nft))) return;
        address seller = _actor(actorSeed);
        uint256 tokenId = nextToken++;
        nft.mint(seller, tokenId);
        vm.startPrank(seller);
        nft.approve(address(engine), tokenId);
        engine.sell(address(nft), tokenId, 0);
        vm.stopPrank();
        buybacks++;
    }

    function fund(uint96 amount, bool earmarked) external {
        uint256 a = bound(amount, 0, 20 ether);
        vm.deal(address(this), a);
        if (earmarked) {
            treasury.deposit{value: a}(address(nft));
        } else {
            (bool ok,) = address(treasury).call{value: a}("");
            require(ok);
        }
    }

    function warp(uint32 seconds_) external {
        skip(bound(seconds_, 0, 2 days));
    }
}

contract InvariantsTest is Base {
    Handler internal handler;

    function setUp() public override {
        super.setUp();
        vm.prank(gov);
        engine.configureBid(address(nft), 1 ether, 5 ether, 2_000, 1_000, true);
        handler = new Handler(marketplace, engine, treasury, nft);
        targetContract(address(handler));
    }

    /// The marketplace holds exactly the escrow of its open offers.
    function invariant_marketplaceHoldsExactlyOpenEscrow() public view {
        uint256 escrow;
        uint256 n = handler.offerCount();
        for (uint256 i; i < n; ++i) {
            (,,, uint128 price, uint32 remaining,,) = marketplace.offers(handler.offerIds(i));
            escrow += uint256(price) * remaining;
        }
        assertEq(address(marketplace).balance, escrow);
    }

    /// Every wei in the treasury is accounted to a budget or to the unallocated pool.
    function invariant_treasuryFullyAccounted() public view {
        assertEq(address(treasury).balance, treasury.budgetOf(address(nft)) + treasury.unallocated());
    }

    /// The engine never holds ETH or NFTs; everything it buys is in the vault and registered.
    function invariant_engineHoldsNothingAndVaultMatches() public view {
        assertEq(address(engine).balance, 0);
        assertEq(nft.balanceOf(address(engine)), 0);
        assertEq(nft.balanceOf(address(vault)), handler.buybacks());
        assertEq(vault.holdingCount(), handler.buybacks());
    }

    /// The bid never exceeds the owner's cap.
    function invariant_bidWithinCap() public view {
        assertLe(engine.currentBid(address(nft)), 5 ether);
    }
}
