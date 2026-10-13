// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {BuybackEngine} from "../src/BuybackEngine.sol";
import {Treasury} from "../src/Treasury.sol";
import {Vault} from "../src/Vault.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract BuybackEngineTest is Base {
    function setUp() public override {
        super.setUp();
        // bid starts at 10 ETH, +10% a day, capped at 15 ETH, drops 5% after a fill
        vm.prank(gov);
        engine.configureBid(address(nft), 10 ether, 15 ether, 1_000, 500, true);
        treasury.deposit{value: 100 ether}(address(nft));
    }

    function test_bid_risesLinearlyAndCaps() public {
        assertEq(engine.currentBid(address(nft)), 10 ether);
        skip(1 days);
        assertEq(engine.currentBid(address(nft)), 11 ether);
        skip(12 hours);
        assertEq(engine.currentBid(address(nft)), 11.5 ether);
        skip(30 days);
        assertEq(engine.currentBid(address(nft)), 15 ether);
    }

    function test_sell_paysSellerLocksNftAndStepsBidDown() public {
        skip(2 days); // bid is 12 ETH
        _mintApproved(alice, 1, address(engine));
        uint256 before = alice.balance;
        vm.prank(alice);
        uint256 vaultId = engine.sell(address(nft), 1, 12 ether);

        assertEq(alice.balance - before, 12 ether);
        assertEq(nft.ownerOf(1), address(vault));
        assertEq(treasury.budgetOf(address(nft)), 88 ether);
        assertEq(engine.currentBid(address(nft)), 11.4 ether);
        assertEq(salesOracle.saleCount(address(nft)), 1);

        (
            address collection,
            uint256 tokenId,
            uint128 price,
            uint40 acquiredAt,
            uint40 lockedUntil,,
            Vault.Status status
        ) = vault.holdings(vaultId);
        assertEq(collection, address(nft));
        assertEq(tokenId, 1);
        assertEq(price, 12 ether);
        assertEq(acquiredAt, block.timestamp);
        assertEq(lockedUntil, block.timestamp + 180 days);
        assertEq(uint8(status), uint8(Vault.Status.Locked));
    }

    function test_sell_revertsBelowMinPrice() public {
        _mintApproved(alice, 1, address(engine));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BuybackEngine.BidBelowMinimum.selector, 10 ether, 11 ether));
        engine.sell(address(nft), 1, 11 ether);
    }

    function test_sell_revertsWhenBudgetShort() public {
        vm.prank(gov);
        engine.configureBid(address(nft), 150 ether, 200 ether, 0, 0, true);
        assertFalse(engine.isFillable(address(nft)));
        _mintApproved(alice, 1, address(engine));
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(BuybackEngine.InsufficientBudget.selector, 100 ether, 150 ether)
        );
        engine.sell(address(nft), 1, 0);
    }

    function test_sell_revertsForInactiveCollection() public {
        vm.prank(gov);
        engine.configureBid(address(nft), 10 ether, 15 ether, 1_000, 500, false);
        assertEq(engine.currentBid(address(nft)), 0);
        _mintApproved(alice, 1, address(engine));
        vm.prank(alice);
        vm.expectRevert(BuybackEngine.InactiveCollection.selector);
        engine.sell(address(nft), 1, 0);
    }

    function test_budgetsAreIsolatedPerCollection() public {
        address other = makeAddr("otherCollection");
        treasury.deposit{value: 5 ether}(other);
        vm.prank(gov);
        engine.configureBid(address(nft), 101 ether, 200 ether, 0, 0, true);
        _mintApproved(alice, 1, address(engine));
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(BuybackEngine.InsufficientBudget.selector, 100 ether, 101 ether)
        );
        engine.sell(address(nft), 1, 0);
    }

    function test_configure_validationAndAccess() public {
        vm.startPrank(gov);
        vm.expectRevert(BuybackEngine.InvalidConfig.selector);
        engine.configureBid(address(nft), 0, 1 ether, 0, 0, true);
        vm.expectRevert(BuybackEngine.InvalidConfig.selector);
        engine.configureBid(address(nft), 2 ether, 1 ether, 0, 0, true);
        vm.expectRevert(BuybackEngine.InvalidConfig.selector);
        engine.configureBid(address(nft), 1 ether, 1 ether, 0, 10_000, true);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        engine.configureBid(address(nft), 1 ether, 1 ether, 0, 0, true);
    }

    function test_treasury_onlyEngineSpends() public {
        vm.prank(alice);
        vm.expectRevert(Treasury.NotSpender.selector);
        treasury.spend(address(nft), 1 ether, payable(alice));
    }

    function test_treasury_unallocatedNeedsOwnerAllocation() public {
        (bool ok,) = address(treasury).call{value: 3 ether}("");
        assertTrue(ok);
        assertEq(treasury.unallocated(), 3 ether);

        vm.prank(gov);
        vm.expectRevert(abi.encodeWithSelector(Treasury.InsufficientBudget.selector, 3 ether, 4 ether));
        treasury.allocate(address(nft), 4 ether);

        vm.prank(gov);
        treasury.allocate(address(nft), 3 ether);
        assertEq(treasury.unallocated(), 0);
        assertEq(treasury.budgetOf(address(nft)), 103 ether);
    }

    /// The bid never exceeds the cap and never falls while nobody sells.
    function testFuzz_bid_boundedAndMonotonic(uint128 base, uint128 cap, uint16 growth, uint32 t1, uint32 t2)
        public
    {
        base = uint128(bound(base, 1, 1_000 ether));
        cap = uint128(bound(cap, base, 2_000 ether));
        vm.prank(gov);
        engine.configureBid(address(nft), base, cap, growth, 500, true);

        skip(t1);
        uint256 first = engine.currentBid(address(nft));
        skip(t2);
        uint256 second = engine.currentBid(address(nft));

        assertGe(first, base);
        assertGe(second, first);
        assertLe(second, cap);
    }

    /// A fill pays exactly the quoted bid out of the collection's budget, and nothing else moves.
    function testFuzz_sell_accounting(uint32 wait, uint16 stepDown) public {
        stepDown = uint16(bound(stepDown, 0, 9_999));
        vm.prank(gov);
        engine.configureBid(address(nft), 10 ether, 15 ether, 1_000, stepDown, true);
        skip(wait);

        uint256 bid = engine.currentBid(address(nft));
        _mintApproved(alice, 1, address(engine));
        uint256 before = alice.balance;
        vm.prank(alice);
        engine.sell(address(nft), 1, bid);

        assertEq(alice.balance - before, bid);
        assertEq(treasury.budgetOf(address(nft)), 100 ether - bid);
        assertEq(address(treasury).balance, 100 ether - bid);
        assertEq(address(engine).balance, 0);
        assertEq(engine.currentBid(address(nft)), bid * (10_000 - stepDown) / 10_000);
    }
}
