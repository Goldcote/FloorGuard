// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";

contract PredictionMarketTest is Base {
    uint256 internal marketId;

    function setUp() public override {
        super.setUp();
        _pushFloor(10 ether);
        // betting open for 1 hour, settles after 1 day
        marketId = prediction.createMarket(address(nft), 1 hours, 1 days);
    }

    function _bet(address who, bool higher, uint256 amount) internal {
        vm.prank(who);
        prediction.placeBet{value: amount}(marketId, higher);
    }

    function _resolveAt(uint256 floor) internal {
        skip(1 days);
        _pushFloor(floor);
        prediction.resolve(marketId);
    }

    function _outcome() internal view returns (PredictionMarket.Outcome outcome) {
        (,,,,,, outcome) = prediction.markets(marketId);
    }

    // ------------------------------------------------------------------ creation and betting

    function test_create_snapshotsFloorAndValidates() public {
        (address collection, uint128 startPrice, uint40 closeTime, uint40 resolveTime,,,) =
            prediction.markets(marketId);
        assertEq(collection, address(nft));
        assertEq(startPrice, 10 ether);
        assertEq(closeTime, block.timestamp + 1 hours);
        assertEq(resolveTime, block.timestamp + 1 days);

        vm.expectRevert(PredictionMarket.UnsupportedCollection.selector);
        prediction.createMarket(makeAddr("other"), 1 hours, 1 days);
        vm.expectRevert(PredictionMarket.InvalidDuration.selector);
        prediction.createMarket(address(nft), 1 minutes, 1 days);
        vm.expectRevert(PredictionMarket.InvalidDuration.selector);
        prediction.createMarket(address(nft), 1 days, 1 days);
        vm.expectRevert(PredictionMarket.InvalidDuration.selector);
        prediction.createMarket(address(nft), 1 hours, 31 days);
    }

    function test_create_revertsWithoutFreshOracle() public {
        skip(1 days + 1);
        vm.expectRevert(PredictionMarket.OracleUnavailable.selector);
        prediction.createMarket(address(nft), 1 hours, 1 days);
    }

    function test_bet_revertsAfterCloseOrBelowMinimum() public {
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.BetTooSmall.selector);
        prediction.placeBet{value: 0.0001 ether}(marketId, true);

        vm.prank(alice);
        vm.expectRevert(PredictionMarket.UnknownMarket.selector);
        prediction.placeBet{value: 1 ether}(99, true);

        skip(1 hours);
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.BettingClosed.selector);
        prediction.placeBet{value: 1 ether}(marketId, true);
    }

    // ------------------------------------------------------------------ settlement

    function test_higherWins_winnersSplitLosingPoolMinusFee() public {
        _bet(alice, true, 3 ether);
        _bet(carol, true, 1 ether);
        _bet(bob, false, 8 ether);
        _resolveAt(11 ether);
        assertEq(uint8(_outcome()), uint8(PredictionMarket.Outcome.Higher));

        // alice: 3 + 6 profit - 3% of 6; carol: 1 + 2 profit - 3% of 2
        uint256 before = alice.balance;
        vm.prank(alice);
        prediction.claim(marketId);
        assertEq(alice.balance - before, 8.82 ether);

        before = carol.balance;
        vm.prank(carol);
        prediction.claim(marketId);
        assertEq(carol.balance - before, 2.94 ether);

        assertEq(treasury.budgetOf(address(nft)), 0.24 ether);
        assertEq(address(prediction).balance, 0);
    }

    function test_lowerWins() public {
        _bet(alice, true, 4 ether);
        _bet(bob, false, 2 ether);
        _resolveAt(9 ether);
        assertEq(uint8(_outcome()), uint8(PredictionMarket.Outcome.Lower));

        uint256 before = bob.balance;
        vm.prank(bob);
        prediction.claim(marketId);
        assertEq(bob.balance - before, 2 ether + 4 ether - 0.12 ether);
    }

    function test_loserGetsPointsButNoEth() public {
        _bet(alice, true, 1 ether);
        _bet(bob, false, 2 ether);
        _resolveAt(11 ether);

        uint256 before = bob.balance;
        vm.prank(bob);
        prediction.claim(marketId);
        assertEq(bob.balance, before);
        // bob's stake funds 3% of 2 ETH in fees; each fee is credited once, half to each side
        assertEq(points.pendingOf(bob), 0.03 ether * POINTS_RATE / 1 ether);

        vm.prank(alice);
        prediction.claim(marketId);
        assertEq(points.pendingOf(alice), 0.03 ether * POINTS_RATE / 1 ether);
    }

    function test_claim_onlyOnceAndOnlyWithStake() public {
        _bet(alice, true, 1 ether);
        _bet(bob, false, 1 ether);

        vm.prank(alice);
        vm.expectRevert(PredictionMarket.NotResolved.selector);
        prediction.claim(marketId);

        _resolveAt(11 ether);
        vm.prank(alice);
        prediction.claim(marketId);
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.NothingToClaim.selector);
        prediction.claim(marketId);
        vm.prank(carol);
        vm.expectRevert(PredictionMarket.NothingToClaim.selector);
        prediction.claim(marketId);
    }

    function test_resolve_revertsEarlyAndTwice() public {
        _bet(alice, true, 1 ether);
        _bet(bob, false, 1 ether);
        vm.expectRevert(PredictionMarket.NotResolvable.selector);
        prediction.resolve(marketId);

        _resolveAt(11 ether);
        vm.expectRevert(PredictionMarket.NotResolvable.selector);
        prediction.resolve(marketId);
    }

    // ------------------------------------------------------------------ voids

    function test_void_unchangedPriceRefundsEveryone() public {
        _bet(alice, true, 3 ether);
        _bet(bob, false, 5 ether);
        _resolveAt(10 ether);
        assertEq(uint8(_outcome()), uint8(PredictionMarket.Outcome.Void));

        uint256 before = alice.balance;
        vm.prank(alice);
        prediction.claim(marketId);
        assertEq(alice.balance - before, 3 ether);
        before = bob.balance;
        vm.prank(bob);
        prediction.claim(marketId);
        assertEq(bob.balance - before, 5 ether);

        assertEq(treasury.budgetOf(address(nft)), 0);
        assertEq(points.totalPoints(), 0);
    }

    function test_void_oneSidedPoolNeedsNoOracle() public {
        _bet(alice, true, 3 ether);
        skip(2 days); // oracle is stale by now
        prediction.resolve(marketId);
        assertEq(uint8(_outcome()), uint8(PredictionMarket.Outcome.Void));

        uint256 before = alice.balance;
        vm.prank(alice);
        prediction.claim(marketId);
        assertEq(alice.balance - before, 3 ether);
    }

    function test_void_staleOracleOnlyAfterGrace() public {
        _bet(alice, true, 1 ether);
        _bet(bob, false, 1 ether);
        skip(1 days + 1 hours); // start price is now older than maxOracleAge
        vm.expectRevert(PredictionMarket.OracleUnavailable.selector);
        prediction.resolve(marketId);

        skip(3 days);
        prediction.resolve(marketId);
        assertEq(uint8(_outcome()), uint8(PredictionMarket.Outcome.Void));
    }

    function test_bothSidesBettor_losesOnlyTheLosingSide() public {
        _bet(alice, true, 2 ether);
        _bet(alice, false, 2 ether);
        _resolveAt(12 ether);

        uint256 before = alice.balance;
        vm.prank(alice);
        prediction.claim(marketId);
        // wins her own 2 ETH back as profit, minus the 3% fee on it
        assertEq(alice.balance - before, 4 ether - 0.06 ether);
        assertEq(treasury.budgetOf(address(nft)), 0.06 ether);
    }

    function test_admin_feeCap() public {
        vm.prank(gov);
        vm.expectRevert(PredictionMarket.TooHigh.selector);
        prediction.setParams(1_001, 0, 1 days);
    }

    /// The contract can always pay every claim, and what it keeps is rounding dust only.
    function testFuzz_solvency(uint64 a, uint64 b, uint64 c, bool cHigher, uint128 endPrice, uint16 feeBps)
        public
    {
        uint256 stakeA = bound(a, 0.001 ether, 100 ether);
        uint256 stakeB = bound(b, 0.001 ether, 100 ether);
        uint256 stakeC = bound(c, 0.001 ether, 100 ether);
        endPrice = uint128(bound(endPrice, 1, 100 ether));
        vm.prank(gov);
        prediction.setParams(bound(feeBps, 0, 1_000), 0.001 ether, 1 days);

        _bet(alice, true, stakeA);
        _bet(bob, false, stakeB);
        _bet(carol, cHigher, stakeC);
        _resolveAt(endPrice);

        uint256 total = stakeA + stakeB + stakeC;
        uint256 paid;
        address[3] memory bettors = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            uint256 before = bettors[i].balance;
            vm.prank(bettors[i]);
            prediction.claim(marketId);
            paid += bettors[i].balance - before;
        }
        uint256 fees = treasury.budgetOf(address(nft));
        uint256 dust = address(prediction).balance;

        assertEq(paid + fees + dust, total);
        assertLt(dust, 3);
    }

    /// A move smaller than the dead band voids the market, so a one-wei move cannot decide it.
    function test_void_moveInsideTheDeadBand() public {
        _bet(alice, true, 1 ether);
        _bet(bob, false, 1 ether);
        _resolveAt(10.19 ether); // +1.9%, inside the 2% band
        assertEq(uint8(_outcome()), uint8(PredictionMarket.Outcome.Void));
    }

    function test_moveAtTheDeadBandDecides() public {
        _bet(alice, true, 1 ether);
        _bet(bob, false, 1 ether);
        _resolveAt(9.8 ether); // exactly -2%
        assertEq(uint8(_outcome()), uint8(PredictionMarket.Outcome.Lower));
    }

    function test_create_needsACurrentStartPrice() public {
        skip(1 hours + 1); // the pushed price is still fresh for settlement, but too old to start on
        vm.expectRevert(PredictionMarket.OracleUnavailable.selector);
        prediction.createMarket(address(nft), 1 hours, 1 days);
    }

    function test_marketRules_ownerOnlyCappedAndFixedPerMarket() public {
        vm.prank(alice);
        vm.expectRevert();
        prediction.setMarketRules(0, 1 hours);
        vm.prank(gov);
        vm.expectRevert(PredictionMarket.TooHigh.selector);
        prediction.setMarketRules(1_001, 1 hours);

        vm.prank(gov);
        prediction.setMarketRules(0, 1 hours); // no dead band for new markets
        _bet(alice, true, 1 ether);
        _bet(bob, false, 1 ether);
        _resolveAt(10.1 ether); // the open market keeps its 2% band
        assertEq(uint8(_outcome()), uint8(PredictionMarket.Outcome.Void));
    }
}
