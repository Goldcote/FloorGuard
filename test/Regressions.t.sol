// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";
import {Points} from "../src/Points.sol";
import {VaultRaffle} from "../src/VaultRaffle.sol";
import {MockNFT} from "./mocks/MockNFT.sol";

/// @dev Regression tests for the issues found in the first independent review.
contract RegressionsTest is Base {
    function _openRaffle() internal returns (uint256 raffleId) {
        vm.prank(gov);
        engine.configureBid(address(nft), 10 ether, 15 ether, 0, 0, true);
        treasury.deposit{value: 10 ether}(address(nft));
        _mintApproved(alice, 1, address(engine));
        vm.prank(alice);
        uint256 vaultId = engine.sell(address(nft), 1, 0);
        vm.startPrank(gov);
        vault.governanceUnlock(vaultId);
        raffleId = vault.sendToRaffle(vaultId);
        points.setRate(address(this), 1_000e18);
        vm.stopPrank();
    }

    /// Points earned while a draw is in flight cannot change that draw's weights.
    function test_raffleWeightsAreFrozenDuringDraw() public {
        uint256 raffleId = _openRaffle();
        _earn(bob, 1 ether);
        skip(7 days);
        raffle.draw(raffleId);

        // carol sees the pending random word and buys a huge number of points
        points.creditFee(carol, 1_000 ether);
        assertEq(points.pointsOf(carol), 0);
        assertEq(points.pendingOf(carol), 1_000_000e18);
        assertEq(points.totalPoints(), 1_000e18);
        vm.expectRevert(Points.Frozen.selector);
        points.flush(carol);

        randomness.fulfill(1, 999e18);
        (,,,,, address winner) = raffle.raffles(raffleId);
        assertEq(winner, bob);

        // afterwards her points count for future raffles
        assertEq(points.freezeCount(), 0);
        points.flush(carol);
        assertEq(points.pointsOf(carol), 1_000_000e18);
        assertEq(points.pendingOf(carol), 0);
    }

    /// A randomness request abandoned by `resetDraw` is never accepted later.
    function test_abandonedRandomnessRequestIsRejected() public {
        uint256 raffleId = _openRaffle();
        _earn(bob, 1 ether);
        skip(7 days);
        raffle.draw(raffleId); // request 1
        skip(1 days);
        raffle.resetDraw(raffleId);
        raffle.draw(raffleId); // request 2

        vm.expectRevert(VaultRaffle.StaleRequest.selector);
        randomness.fulfill(1, 0);
        randomness.fulfill(2, 0);
        (,,,,, address winner) = raffle.raffles(raffleId);
        assertEq(winner, bob);
    }

    /// A market cannot settle on a price published before its settlement time.
    function test_predictionNeedsPricePublishedAfterSettlementTime() public {
        _pushFloor(10 ether);
        uint256 marketId = prediction.createMarket(address(nft), 6 hours, 12 hours);
        vm.prank(alice);
        prediction.placeBet{value: 1 ether}(marketId, true);
        vm.prank(bob);
        prediction.placeBet{value: 1 ether}(marketId, false);

        skip(11 hours);
        _pushFloor(11 ether); // fresh, but from before the settlement time
        skip(1 hours);
        vm.expectRevert(PredictionMarket.OracleUnavailable.selector);
        prediction.resolve(marketId);

        _pushFloor(9 ether);
        prediction.resolve(marketId);
        (,,,,,, PredictionMarket.Outcome outcome) = prediction.markets(marketId);
        assertEq(uint8(outcome), uint8(PredictionMarket.Outcome.Lower));
    }

    function test_predictionBettingWindowIsAtMostHalfTheDuration() public {
        _pushFloor(10 ether);
        vm.expectRevert(PredictionMarket.InvalidDuration.selector);
        prediction.createMarket(address(nft), 1 days - 1, 1 days);
    }

    /// Trading an unsupported contract earns no points, feeds no oracle and strands no fee.
    function test_unsupportedCollectionEarnsNothing() public {
        MockNFT junk = new MockNFT();
        junk.mint(alice, 1);
        vm.prank(alice);
        junk.approve(address(marketplace), 1);
        vm.prank(bob);
        uint256 id =
            marketplace.makeCollectionOffer{value: 10 ether}(address(junk), 1, block.timestamp + 1 days);
        vm.prank(alice);
        marketplace.acceptOffer(id, 1, 0);

        assertEq(points.pendingOf(alice) + points.pendingOf(bob), 0);
        assertEq(salesOracle.saleCount(address(junk)), 0);
        assertEq(treasury.budgetOf(address(junk)), 0);
        assertEq(treasury.unallocated(), 0.2 ether);
    }

    /// Turning a module's points rate off must not block trades or payouts.
    function test_pointsFailureDoesNotBlockTradesOrClaims() public {
        vm.startPrank(gov);
        points.setRate(address(marketplace), 0);
        points.setRate(address(prediction), 0);
        vm.stopPrank();

        _mintApproved(alice, 1, address(marketplace));
        vm.prank(bob);
        uint256 id = marketplace.makeOffer{value: 1 ether}(address(nft), 1, block.timestamp + 1 days);
        vm.prank(alice);
        marketplace.acceptOffer(id, 1, 0);
        assertEq(nft.ownerOf(1), bob);

        _pushFloor(10 ether);
        uint256 marketId = prediction.createMarket(address(nft), 1 hours, 1 days);
        vm.prank(alice);
        prediction.placeBet{value: 1 ether}(marketId, true);
        vm.prank(bob);
        prediction.placeBet{value: 1 ether}(marketId, false);
        skip(1 days);
        _pushFloor(11 ether);
        prediction.resolve(marketId);
        uint256 before = alice.balance;
        vm.prank(alice);
        prediction.claim(marketId);
        assertEq(alice.balance - before, 1.97 ether);
    }

    /// The randomness callback, with weights frozen, stays far below the VRF adapter's gas limit.
    function test_fulfilGasWithManyHolders() public {
        uint256 raffleId = _openRaffle();
        for (uint256 i; i < 600; ++i) {
            _earn(address(uint160(0x5000 + i)), 0.001 ether);
        }
        skip(7 days);
        raffle.draw(raffleId);
        vm.prank(address(randomness));
        uint256 gasBefore = gasleft();
        raffle.fulfillRandomness(1, 599e18);
        assertLt(gasBefore - gasleft(), 400_000);
    }
}
