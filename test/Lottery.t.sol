// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {Lottery} from "../src/Lottery.sol";

contract LotteryTest is Base {
    function setUp() public override {
        super.setUp();
        vm.prank(gov);
        lottery.setConfig(address(nft), 0.01 ether, 7 days, true);
    }

    function _buy(address who, uint32 count) internal returns (uint256) {
        vm.prank(who);
        return lottery.buy{value: 0.01 ether * uint256(count)}(address(nft), count);
    }

    function _status(uint256 roundId) internal view returns (Lottery.Status status) {
        (,,,,,, status,) = lottery.rounds(roundId);
    }

    function test_fullRound_winnerTakesThePotLessTheFee() public {
        uint256 roundId = _buy(alice, 30); // tickets 0-29
        assertEq(_buy(bob, 60), roundId); // tickets 30-89
        assertEq(_buy(carol, 10), roundId); // tickets 90-99
        assertEq(lottery.ownerOfTicket(roundId, 29), alice);
        assertEq(lottery.ownerOfTicket(roundId, 30), bob);
        assertEq(lottery.ownerOfTicket(roundId, 99), carol);

        vm.expectRevert(Lottery.StillOpen.selector);
        lottery.draw(roundId);
        skip(7 days);
        lottery.draw(roundId);
        randomness.fulfill(1, 100 * 3 + 45); // ticket 45

        (,,,,,,, address winner) = lottery.rounds(roundId);
        assertEq(winner, bob);
        // 1 ETH pot: 5% to the collection's buyback budget, 0.95 ETH to bob
        assertEq(treasury.budgetOf(address(nft)), 0.05 ether);
        assertEq(lottery.owedTo(bob), 0.95 ether);

        uint256 before = bob.balance;
        vm.prank(bob);
        lottery.withdraw();
        assertEq(bob.balance - before, 0.95 ether);
        assertEq(address(lottery).balance, 0);
    }

    function test_buy_opensANewRoundOnceTheLastOneEnded() public {
        uint256 first = _buy(alice, 10);
        skip(7 days);
        uint256 second = _buy(bob, 10);
        assertEq(second, first + 1);
        assertEq(lottery.currentRoundOf(address(nft)), second);

        // the ended round is unaffected and can still be drawn
        lottery.draw(first);
        randomness.fulfill(1, 0);
        assertEq(lottery.owedTo(alice), 0.095 ether);
    }

    function test_buy_validation() public {
        vm.startPrank(alice);
        vm.expectRevert(Lottery.InvalidCount.selector);
        lottery.buy(address(nft), 0);
        vm.expectRevert(abi.encodeWithSelector(Lottery.WrongPayment.selector, 0.02 ether));
        lottery.buy{value: 0.01 ether}(address(nft), 2);
        vm.expectRevert(Lottery.InactiveCollection.selector);
        lottery.buy{value: 0.01 ether}(makeAddr("other"), 1);
        vm.stopPrank();
    }

    function test_smallPotIsRefunded() public {
        uint256 roundId = _buy(alice, 2);
        _buy(bob, 1);
        skip(7 days);
        lottery.draw(roundId); // 0.03 ETH is below the 0.05 ETH minimum
        assertEq(uint8(_status(roundId)), uint8(Lottery.Status.Refunding));
        assertEq(randomness.lastRequestId(), 0);

        uint256 before = alice.balance;
        vm.prank(alice);
        lottery.refund(roundId);
        assertEq(alice.balance - before, 0.02 ether);
        vm.prank(alice);
        vm.expectRevert(Lottery.NothingOwed.selector);
        lottery.refund(roundId);
        vm.prank(bob);
        lottery.refund(roundId);
        assertEq(address(lottery).balance, 0);
    }

    function test_lateRandomnessReopensTheDraw() public {
        uint256 roundId = _buy(alice, 10);
        skip(7 days);
        lottery.draw(roundId);
        skip(1 days);
        randomness.fulfill(1, 0);
        assertEq(uint8(_status(roundId)), uint8(Lottery.Status.Open));
        assertEq(lottery.owedTo(alice), 0);

        lottery.draw(roundId);
        vm.expectRevert(Lottery.StaleRequest.selector);
        randomness.fulfill(1, 0);
        randomness.fulfill(2, 0);
        assertEq(uint8(_status(roundId)), uint8(Lottery.Status.Won));
    }

    function test_abort_whenTheDrawNeverCompletes() public {
        uint256 roundId = _buy(alice, 10);
        skip(7 days);
        lottery.draw(roundId);
        vm.expectRevert(abi.encodeWithSelector(Lottery.TooEarly.selector, block.timestamp + 7 days));
        lottery.abort(roundId);

        skip(7 days);
        lottery.abort(roundId);
        vm.expectRevert(Lottery.StaleRequest.selector);
        randomness.fulfill(1, 0);
        uint256 before = alice.balance;
        vm.prank(alice);
        lottery.refund(roundId);
        assertEq(alice.balance - before, 0.1 ether);
    }

    function test_resetDraw_afterTimeout() public {
        uint256 roundId = _buy(alice, 10);
        skip(7 days);
        lottery.draw(roundId);
        vm.expectRevert(abi.encodeWithSelector(Lottery.TooEarly.selector, block.timestamp + 1 days));
        lottery.resetDraw(roundId);
        skip(1 days);
        lottery.resetDraw(roundId);
        assertEq(uint8(_status(roundId)), uint8(Lottery.Status.Open));
    }

    function test_configAndFeeChangesApplyFromTheNextRound() public {
        uint256 roundId = _buy(alice, 10);
        vm.startPrank(gov);
        lottery.setConfig(address(nft), 1 ether, 1 days, true);
        lottery.setParams(1_000, 0.05 ether);
        vm.stopPrank();

        _buy(bob, 10); // still 0.01 ETH a ticket in the open round
        skip(7 days);
        lottery.draw(roundId);
        randomness.fulfill(1, 0);
        assertEq(treasury.budgetOf(address(nft)), 0.01 ether); // 5% of 0.2 ETH

        vm.prank(carol);
        uint256 next = lottery.buy{value: 1 ether}(address(nft), 1);
        (, uint128 price,,,, uint16 fee,,) = lottery.rounds(next);
        assertEq(price, 1 ether);
        assertEq(fee, 1_000);
    }

    function test_inactiveCollectionFinishesItsOpenRound() public {
        uint256 roundId = _buy(alice, 10);
        vm.prank(gov);
        lottery.setConfig(address(nft), 0.01 ether, 7 days, false);
        _buy(bob, 10); // the open round still sells
        skip(7 days);
        vm.prank(carol);
        vm.expectRevert(Lottery.InactiveCollection.selector);
        lottery.buy{value: 0.01 ether}(address(nft), 1);
        lottery.draw(roundId);
    }

    function test_fulfill_onlyRandomnessProviderAndAdminValidation() public {
        uint256 roundId = _buy(alice, 10);
        skip(7 days);
        lottery.draw(roundId);
        vm.prank(alice);
        vm.expectRevert(Lottery.NotRandomness.selector);
        lottery.fulfillRandomness(1, 0);

        vm.startPrank(gov);
        vm.expectRevert(Lottery.InvalidParams.selector);
        lottery.setParams(1_001, 0);
        vm.expectRevert(Lottery.InvalidParams.selector);
        lottery.setConfig(address(nft), 0, 7 days, true);
        vm.expectRevert(Lottery.InvalidParams.selector);
        lottery.setConfig(address(nft), 1 ether, 10 minutes, true);
        vm.stopPrank();
    }

    /// Across rounds that are drawn, refunded or still open, the contract holds exactly the open pots,
    /// the refundable payments and the unclaimed winnings.
    function testFuzz_accounting(uint8[4] memory counts, uint256 word) public {
        address[2] memory buyers = [alice, bob];
        uint256 sold;
        for (uint256 i; i < 4; ++i) {
            uint32 count = uint32(bound(counts[i], 1, 8));
            _buy(buyers[i % 2], count);
            sold += count;
        }
        uint256 pot = sold * 0.01 ether;
        skip(7 days);
        lottery.draw(1);

        if (pot < 0.05 ether) {
            vm.prank(alice);
            lottery.refund(1);
            vm.prank(bob);
            lottery.refund(1);
            assertEq(address(lottery).balance, 0);
            return;
        }
        randomness.fulfill(1, word);
        (,,,,,,, address winner) = lottery.rounds(1);
        assertGt(lottery.paidBy(1, winner), 0);
        assertEq(lottery.owedTo(winner) + treasury.budgetOf(address(nft)), pot);
        assertEq(address(lottery).balance, lottery.owedTo(winner));
    }
}
