// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {RejectETH} from "./mocks/MockNFT.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract MarketplaceTest is Base {
    uint256 internal expiry;

    function setUp() public override {
        super.setUp();
        expiry = block.timestamp + 1 days;
    }

    function test_tokenOffer_acceptPaysSellerAndTreasury() public {
        _mintApproved(alice, 1, address(marketplace));
        vm.prank(bob);
        uint256 id = marketplace.makeOffer{value: 10 ether}(address(nft), 1, expiry);

        uint256 before = alice.balance;
        vm.prank(alice);
        marketplace.acceptOffer(id, 1, 9.8 ether);

        assertEq(nft.ownerOf(1), bob);
        assertEq(alice.balance - before, 9.8 ether);
        assertEq(treasury.budgetOf(address(nft)), 0.2 ether);
        assertEq(address(marketplace).balance, 0);
        // a token-specific sale is not a floor signal
        assertEq(salesOracle.saleCount(address(nft)), 0);
    }

    function test_royalty_paidAndCapped() public {
        address creator = makeAddr("creator");
        nft.setRoyalty(creator, 2_000); // asks 20%, cap is 5%
        _mintApproved(alice, 1, address(marketplace));
        vm.prank(bob);
        uint256 id = marketplace.makeOffer{value: 10 ether}(address(nft), 1, expiry);

        uint256 before = alice.balance;
        vm.prank(alice);
        marketplace.acceptOffer(id, 1, 0);

        assertEq(creator.balance, 0.5 ether);
        assertEq(treasury.budgetOf(address(nft)), 0.2 ether);
        assertEq(alice.balance - before, 9.3 ether);
    }

    function test_royalty_unpayableReceiverForfeitsToTreasury() public {
        nft.setRoyalty(address(new RejectETH()), 500);
        _mintApproved(alice, 1, address(marketplace));
        vm.prank(bob);
        uint256 id = marketplace.makeOffer{value: 10 ether}(address(nft), 1, expiry);

        uint256 before = alice.balance;
        vm.prank(alice);
        marketplace.acceptOffer(id, 1, 0);

        assertEq(treasury.budgetOf(address(nft)), 0.7 ether);
        assertEq(alice.balance - before, 9.3 ether);
    }

    function test_royalty_disabledWhenCapIsZero() public {
        address creator = makeAddr("creator");
        nft.setRoyalty(creator, 500);
        vm.prank(gov);
        marketplace.setRoyaltyCap(0);
        _mintApproved(alice, 1, address(marketplace));
        vm.prank(bob);
        uint256 id = marketplace.makeOffer{value: 10 ether}(address(nft), 1, expiry);
        vm.prank(alice);
        marketplace.acceptOffer(id, 1, 0);
        assertEq(creator.balance, 0);
    }

    function test_collectionOffer_fillsAnyTokenUntilExhausted() public {
        _mintApproved(alice, 7, address(marketplace));
        _mintApproved(carol, 9, address(marketplace));
        vm.prank(bob);
        uint256 id = marketplace.makeCollectionOffer{value: 6 ether}(address(nft), 3, expiry);

        vm.prank(alice);
        marketplace.acceptOffer(id, 7, 0);
        vm.prank(carol);
        marketplace.acceptOffer(id, 9, 0);

        assertEq(nft.ownerOf(7), bob);
        assertEq(nft.ownerOf(9), bob);
        (,,,, uint32 remaining,,) = marketplace.offers(id);
        assertEq(remaining, 1);
        assertEq(salesOracle.saleCount(address(nft)), 2);

        uint256 before = bob.balance;
        vm.prank(bob);
        marketplace.cancelOffer(id);
        assertEq(bob.balance - before, 2 ether);
        assertEq(address(marketplace).balance, 0);
    }

    function test_collectionOffer_revertsOnUnevenValue() public {
        vm.prank(bob);
        vm.expectRevert(Marketplace.InvalidQuantity.selector);
        marketplace.makeCollectionOffer{value: 1 ether + 1}(address(nft), 2, expiry);
    }

    function test_accept_revertsOnWrongToken() public {
        _mintApproved(alice, 2, address(marketplace));
        vm.prank(bob);
        uint256 id = marketplace.makeOffer{value: 1 ether}(address(nft), 1, expiry);
        vm.prank(alice);
        vm.expectRevert(Marketplace.WrongToken.selector);
        marketplace.acceptOffer(id, 2, 0);
    }

    function test_accept_revertsWhenExpired() public {
        _mintApproved(alice, 1, address(marketplace));
        vm.prank(bob);
        uint256 id = marketplace.makeOffer{value: 1 ether}(address(nft), 1, expiry);
        vm.warp(expiry + 1);
        vm.prank(alice);
        vm.expectRevert(Marketplace.OfferExpired.selector);
        marketplace.acceptOffer(id, 1, 0);

        // the offerer can still get the escrow back
        uint256 before = bob.balance;
        vm.prank(bob);
        marketplace.cancelOffer(id);
        assertEq(bob.balance - before, 1 ether);
    }

    function test_accept_revertsWhenFilledOrCancelled() public {
        _mintApproved(alice, 1, address(marketplace));
        vm.prank(bob);
        uint256 id = marketplace.makeOffer{value: 1 ether}(address(nft), 1, expiry);
        vm.prank(alice);
        marketplace.acceptOffer(id, 1, 0);

        vm.prank(bob);
        nft.approve(address(marketplace), 1);
        vm.prank(bob);
        vm.expectRevert(Marketplace.OfferInactive.selector);
        marketplace.acceptOffer(id, 1, 0);
        vm.prank(bob);
        vm.expectRevert(Marketplace.OfferInactive.selector);
        marketplace.cancelOffer(id);
    }

    function test_accept_revertsWhenCallerDoesNotOwnToken() public {
        _mintApproved(alice, 1, address(marketplace));
        vm.prank(bob);
        uint256 id = marketplace.makeOffer{value: 1 ether}(address(nft), 1, expiry);
        vm.prank(carol);
        vm.expectRevert();
        marketplace.acceptOffer(id, 1, 0);
    }

    function test_accept_revertsBelowMinProceeds() public {
        _mintApproved(alice, 1, address(marketplace));
        vm.prank(bob);
        uint256 id = marketplace.makeOffer{value: 10 ether}(address(nft), 1, expiry);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.ProceedsTooLow.selector, 9.8 ether, 9.9 ether));
        marketplace.acceptOffer(id, 1, 9.9 ether);
    }

    function test_cancel_onlyOfferer() public {
        vm.prank(bob);
        uint256 id = marketplace.makeOffer{value: 1 ether}(address(nft), 1, expiry);
        vm.prank(alice);
        vm.expectRevert(Marketplace.NotOfferer.selector);
        marketplace.cancelOffer(id);
    }

    function test_makeOffer_validation() public {
        vm.startPrank(bob);
        vm.expectRevert(Marketplace.InvalidPrice.selector);
        marketplace.makeOffer(address(nft), 1, expiry);
        vm.expectRevert(Marketplace.InvalidExpiry.selector);
        marketplace.makeOffer{value: 1 ether}(address(nft), 1, block.timestamp);
        vm.stopPrank();
    }

    function test_admin_feeIsCappedAndOwnerOnly() public {
        vm.prank(gov);
        vm.expectRevert(Marketplace.TooHigh.selector);
        marketplace.setFee(501);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        marketplace.setFee(100);

        vm.prank(gov);
        marketplace.setFee(0);
        _mintApproved(alice, 1, address(marketplace));
        vm.prank(bob);
        uint256 id = marketplace.makeOffer{value: 1 ether}(address(nft), 1, expiry);
        vm.prank(alice);
        marketplace.acceptOffer(id, 1, 1 ether);
        assertEq(treasury.budgetOf(address(nft)), 0);
    }

    /// Every wei of the price ends up with the seller, the creator or the treasury.
    function testFuzz_accept_conservesValue(uint128 price, uint16 feeBps, uint16 royaltyBps) public {
        price = uint128(bound(price, 1, 500 ether));
        feeBps = uint16(bound(feeBps, 0, 500));
        royaltyBps = uint16(bound(royaltyBps, 0, 10_000));
        address creator = makeAddr("creator");
        nft.setRoyalty(creator, royaltyBps);
        vm.prank(gov);
        marketplace.setFee(feeBps);

        _mintApproved(alice, 1, address(marketplace));
        vm.prank(bob);
        uint256 id = marketplace.makeOffer{value: price}(address(nft), 1, expiry);
        uint256 before = alice.balance;
        vm.prank(alice);
        marketplace.acceptOffer(id, 1, 0);

        uint256 toSeller = alice.balance - before;
        assertEq(toSeller + creator.balance + treasury.budgetOf(address(nft)), price);
        assertLe(creator.balance, uint256(price) * 500 / 10_000);
        assertEq(address(marketplace).balance, 0);
    }
}
