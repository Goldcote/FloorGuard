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

    /// The bid is never more than the budget can pay: a thin budget lowers the bid instead of
    /// leaving an unpayable one standing.
    function test_bid_isLimitedByTheBudget() public {
        vm.prank(gov);
        engine.configureBid(address(nft), 150 ether, 200 ether, 0, 1_000, true);
        assertEq(engine.curvePrice(address(nft)), 150 ether);
        assertEq(engine.currentBid(address(nft)), 100 ether);

        _mintApproved(alice, 1, address(engine));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BuybackEngine.BidBelowMinimum.selector, 100 ether, 150 ether));
        engine.sell(address(nft), 1, 150 ether);

        uint256 before = alice.balance;
        vm.prank(alice);
        engine.sell(address(nft), 1, 100 ether);
        assertEq(alice.balance - before, 100 ether);
        assertEq(treasury.budgetOf(address(nft)), 0);
        // a budget-limited sale pulls the base down by at most three steps before the usual one:
        // the anchor is max(100, 150 less 30%) = 105 ETH, and the new base is 10% below it
        assertEq(engine.curvePrice(address(nft)), 94.5 ether);

        _mintApproved(alice, 2, address(engine));
        vm.prank(alice);
        vm.expectRevert(BuybackEngine.NothingToBid.selector);
        engine.sell(address(nft), 2, 0);
        assertFalse(engine.isFillable(address(nft)));
    }

    /// While the budget cannot cover the curve, the curve's rise does not count: money that arrives
    /// late or in a lump is spent from the base, not from an inflated bid.
    function test_curveRestartsWhenLateMoneyArrives() public {
        vm.prank(gov);
        engine.configureBid(address(nft), 150 ether, 300 ether, 1_000, 500, true);
        skip(5 days); // unfunded: the curve has drifted to 225 ETH while the budget is 100
        assertEq(engine.curvePrice(address(nft)), 225 ether);

        treasury.deposit{value: 400 ether}(address(nft)); // a lump arrives
        assertEq(engine.curvePrice(address(nft)), 150 ether);
        assertEq(engine.currentBid(address(nft)), 150 ether);

        skip(1 days); // funded now: the rise counts
        assertEq(engine.currentBid(address(nft)), 165 ether);
        treasury.deposit{value: 1 ether}(address(nft));
        assertEq(engine.currentBid(address(nft)), 165 ether);
    }

    /// A deposit never lowers the bid: when the bid was the budget, the curve restarts from there.
    function test_curveRestartsFromTheOldBudgetWhenThatIsAboveTheBase() public {
        vm.prank(gov);
        engine.configureBid(address(nft), 80 ether, 300 ether, 1_000, 500, true);
        skip(5 days); // curve at 120 ETH, budget 100: the bid is 100
        assertEq(engine.currentBid(address(nft)), 100 ether);
        treasury.deposit{value: 1}(address(nft));
        assertEq(engine.curvePrice(address(nft)), 100 ether);
        assertEq(engine.currentBid(address(nft)), 100 ether);
    }

    /// No buyback below the collection's minimum bid, so a seller who names no minimum is never paid
    /// dust out of a nearly empty budget.
    function test_noBuybackBelowTheMinimumBid() public {
        assertEq(engine.minBidOf(address(nft)), 1 ether); // a tenth of the 10 ETH base by default
        vm.prank(gov);
        engine.configureBid(address(nft), 100 ether, 200 ether, 0, 0, true);
        _mintApproved(alice, 1, address(engine));
        _mintApproved(alice, 2, address(engine));
        treasury.deposit{value: 0.5 ether}(address(nft)); // 100.5 ETH: one sale leaves 0.5 ETH
        vm.startPrank(alice);
        engine.sell(address(nft), 1, 0);
        assertEq(engine.currentBid(address(nft)), 0.5 ether);
        assertFalse(engine.isFillable(address(nft)));
        vm.expectRevert(BuybackEngine.NothingToBid.selector);
        engine.sell(address(nft), 2, 0);
        vm.stopPrank();
    }

    /// In a market that has fallen, budget-limited sales pull the base down quickly enough that a later
    /// lump is not spent far above the market.
    function test_baseFollowsAFallingMarket() public {
        vm.startPrank(gov);
        engine.configureBid(address(nft), 100 ether, 200 ether, 1_000, 1_500, true);
        engine.setMinBid(address(nft), 100); // 1% of the base
        vm.stopPrank();
        // the market is now 40 ETH and the budget arrives 40 ETH at a time
        vm.prank(address(engine));
        treasury.spend(address(nft), 60 ether, payable(address(0xdead)));
        for (uint256 id = 1; id <= 2; ++id) {
            _mintApproved(alice, id, address(engine));
            vm.prank(alice);
            engine.sell(address(nft), id, 40 ether);
            treasury.deposit{value: 40 ether}(address(nft));
        }
        // two budget-limited sales at 40 have brought the base from 100 down to 34
        assertLt(engine.curvePrice(address(nft)), 50 ether);
    }

    /// The minimum bid is a share of the base, so it follows the base down and the guardian's remedy
    /// for a fallen market cannot leave the bid unable to buy.
    function test_minimumBidFollowsTheBase() public {
        address guardian = makeAddr("guardian");
        vm.prank(gov);
        engine.setGuardian(guardian);
        assertEq(engine.minBidOf(address(nft)), 1 ether);

        vm.prank(guardian);
        engine.lowerBid(address(nft), 0.4 ether, 0.8 ether, true); // the market fell to 0.5 ETH
        assertEq(engine.minBidOf(address(nft)), 0.04 ether);
        assertTrue(engine.isFillable(address(nft)));

        vm.startPrank(gov);
        engine.setMinBid(address(nft), 0); // off, and it stays off through a reconfiguration
        engine.configureBid(address(nft), 10 ether, 15 ether, 1_000, 500, true);
        assertEq(engine.minBidOf(address(nft)), 0);
        vm.expectRevert(BuybackEngine.InvalidConfig.selector);
        engine.setMinBid(address(nft), 10_001);
        vm.stopPrank();
    }

    function test_onBudgetIncrease_onlyTreasury() public {
        vm.prank(alice);
        vm.expectRevert(BuybackEngine.NotTreasury.selector);
        engine.onBudgetIncrease(address(nft), 0);
    }

    function test_cooldownMustBeShorterThanTheRegrowTime() public {
        // 5% step and 10% a day: the bid is back at its last price after about 12.6 hours
        vm.startPrank(gov);
        vm.expectRevert(abi.encodeWithSelector(BuybackEngine.CooldownTooLong.selector, 45_473));
        engine.setFillCooldown(address(nft), 13 hours);
        engine.setFillCooldown(address(nft), 12 hours);
        // a faster curve would break the limit for the cooldown already set
        vm.expectRevert(abi.encodeWithSelector(BuybackEngine.CooldownTooLong.selector, 22_736));
        engine.configureBid(address(nft), 10 ether, 15 ether, 2_000, 500, true);
        vm.stopPrank();
    }

    function test_guardianCanOnlyLowerOrPause() public {
        address guardian = makeAddr("guardian");
        vm.prank(gov);
        engine.setGuardian(guardian);

        vm.startPrank(guardian);
        vm.expectRevert(BuybackEngine.InvalidConfig.selector);
        engine.lowerBid(address(nft), 11 ether, 15 ether, true); // base up
        vm.expectRevert(BuybackEngine.InvalidConfig.selector);
        engine.lowerBid(address(nft), 10 ether, 16 ether, true); // cap up
        engine.lowerBid(address(nft), 6 ether, 8 ether, true);
        assertEq(engine.currentBid(address(nft)), 6 ether);
        engine.lowerBid(address(nft), 6 ether, 8 ether, false); // pause
        assertEq(engine.currentBid(address(nft)), 0);
        vm.expectRevert(BuybackEngine.InvalidConfig.selector);
        engine.lowerBid(address(nft), 6 ether, 8 ether, true); // cannot reactivate
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(BuybackEngine.NotGuardian.selector);
        engine.lowerBid(address(nft), 1 ether, 1 ether, false);
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
        // the other collection's 5 ETH does not raise this collection's bid
        assertEq(engine.currentBid(address(nft)), 100 ether);
        _mintApproved(alice, 1, address(engine));
        vm.prank(alice);
        engine.sell(address(nft), 1, 0);
        assertEq(treasury.budgetOf(other), 5 ether);
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
        base = uint128(bound(base, 1 gwei, 1_000 ether));
        cap = uint128(bound(cap, base, 2_000 ether));
        vm.prank(gov);
        engine.configureBid(address(nft), base, cap, growth, 500, true);
        vm.deal(address(this), 3_000 ether);
        treasury.deposit{value: 3_000 ether}(address(nft)); // ample, so the curve is what is measured

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
