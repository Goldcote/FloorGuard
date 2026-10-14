// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {TicketRaffle} from "../src/TicketRaffle.sol";

contract TicketRaffleTest is Base {
    uint256 internal raffleId;

    function setUp() public override {
        super.setUp();
        vm.prank(gov);
        ticketRaffle.setCollectionSupport(address(nft), true);
        // alice raffles token 1: 0.1 ETH a ticket, at least 5 and at most 20 tickets, for a day
        _mintApproved(alice, 1, address(ticketRaffle));
        vm.prank(alice);
        raffleId = ticketRaffle.create(address(nft), 1, 0.1 ether, 5, 20, 1 days);
    }

    function _buy(address who, uint32 count) internal {
        vm.prank(who);
        ticketRaffle.buy{value: 0.1 ether * count}(raffleId, count);
    }

    function _status() internal view returns (TicketRaffle.Status status) {
        (,,,,,,,,, status,) = ticketRaffle.raffles(raffleId);
    }

    function test_create_escrowsTheNftAndValidates() public {
        assertEq(nft.ownerOf(1), address(ticketRaffle));
        _mintApproved(alice, 2, address(ticketRaffle));
        vm.startPrank(alice);
        vm.expectRevert(TicketRaffle.InvalidParams.selector);
        ticketRaffle.create(address(nft), 2, 0, 1, 10, 1 days);
        vm.expectRevert(TicketRaffle.InvalidParams.selector);
        ticketRaffle.create(address(nft), 2, 1 ether, 11, 10, 1 days);
        vm.expectRevert(TicketRaffle.InvalidParams.selector);
        ticketRaffle.create(address(nft), 2, 1 ether, 1, 10, 10 minutes);
        vm.stopPrank();
    }

    function test_buy_validation() public {
        vm.startPrank(bob);
        vm.expectRevert(abi.encodeWithSelector(TicketRaffle.WrongPayment.selector, 0.2 ether));
        ticketRaffle.buy{value: 0.1 ether}(raffleId, 2);
        vm.expectRevert(abi.encodeWithSelector(TicketRaffle.SoldOut.selector, 20));
        ticketRaffle.buy{value: 2.1 ether}(raffleId, 21);
        vm.stopPrank();

        skip(1 days);
        vm.prank(bob);
        vm.expectRevert(TicketRaffle.SalesClosed.selector);
        ticketRaffle.buy{value: 0.1 ether}(raffleId, 1);
    }

    function test_fullRaffle_ticketHolderWinsCreatorIsPaidFeeFundsBuybacks() public {
        _buy(bob, 3); // tickets 0-2
        _buy(carol, 5); // tickets 3-7
        _buy(bob, 2); // tickets 8-9
        assertEq(ticketRaffle.ownerOfTicket(raffleId, 2), bob);
        assertEq(ticketRaffle.ownerOfTicket(raffleId, 3), carol);
        assertEq(ticketRaffle.ownerOfTicket(raffleId, 7), carol);
        assertEq(ticketRaffle.ownerOfTicket(raffleId, 9), bob);

        vm.expectRevert(TicketRaffle.StillOpen.selector);
        ticketRaffle.close(raffleId);
        skip(1 days);
        ticketRaffle.close(raffleId);
        randomness.fulfill(1, 10 * 7 + 4); // ticket 4
        (,,,,,,,,,, address winner) = ticketRaffle.raffles(raffleId);
        assertEq(winner, carol);

        ticketRaffle.settle(raffleId);
        assertEq(nft.ownerOf(1), carol);
        // 1 ETH of tickets: 5% to the collection's buyback budget, the rest to alice
        assertEq(treasury.budgetOf(address(nft)), 0.05 ether);
        assertEq(ticketRaffle.owedTo(alice), 0.95 ether);

        uint256 before = alice.balance;
        vm.prank(alice);
        ticketRaffle.withdraw();
        assertEq(alice.balance - before, 0.95 ether);
        assertEq(address(ticketRaffle).balance, 0);

        vm.expectRevert(
            abi.encodeWithSelector(TicketRaffle.WrongStatus.selector, TicketRaffle.Status.Settled)
        );
        ticketRaffle.settle(raffleId);
    }

    function test_consecutivePurchasesBySameBuyerShareOneEntry() public {
        _buy(bob, 1);
        _buy(bob, 1);
        _buy(carol, 1);
        assertEq(ticketRaffle.entryCount(raffleId), 2);
        assertEq(ticketRaffle.ownerOfTicket(raffleId, 1), bob);
        assertEq(ticketRaffle.ownerOfTicket(raffleId, 2), carol);
    }

    function test_sellOut_canCloseEarly() public {
        _buy(bob, 20);
        ticketRaffle.close(raffleId);
        assertEq(uint8(_status()), uint8(TicketRaffle.Status.Drawing));
    }

    function test_belowMinimum_refundsBuyersAndReturnsTheNft() public {
        _buy(bob, 3);
        _buy(carol, 1);
        skip(1 days);
        ticketRaffle.close(raffleId);
        assertEq(uint8(_status()), uint8(TicketRaffle.Status.Refunding));

        vm.prank(bob);
        vm.expectRevert(TicketRaffle.NotCreator.selector);
        ticketRaffle.reclaim(raffleId);
        vm.prank(alice);
        ticketRaffle.reclaim(raffleId);
        assertEq(nft.ownerOf(1), alice);
        vm.prank(alice);
        vm.expectRevert(TicketRaffle.AlreadyReclaimed.selector);
        ticketRaffle.reclaim(raffleId);

        uint256 before = bob.balance;
        vm.prank(bob);
        ticketRaffle.refund(raffleId);
        assertEq(bob.balance - before, 0.3 ether);
        vm.prank(bob);
        vm.expectRevert(TicketRaffle.NothingOwed.selector);
        ticketRaffle.refund(raffleId);

        vm.prank(carol);
        ticketRaffle.refund(raffleId);
        assertEq(address(ticketRaffle).balance, 0);
    }

    function test_cancel_onlyCreatorAndOnlyBeforeAnySale() public {
        vm.prank(bob);
        vm.expectRevert(TicketRaffle.NotCreator.selector);
        ticketRaffle.cancel(raffleId);

        _buy(bob, 1);
        vm.prank(alice);
        vm.expectRevert(TicketRaffle.TicketsAlreadySold.selector);
        ticketRaffle.cancel(raffleId);
    }

    function test_cancel_returnsTheNft() public {
        vm.prank(alice);
        ticketRaffle.cancel(raffleId);
        assertEq(nft.ownerOf(1), alice);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(TicketRaffle.WrongStatus.selector, TicketRaffle.Status.Cancelled)
        );
        ticketRaffle.buy{value: 0.1 ether}(raffleId, 1);
    }

    function test_lateRandomnessReopensTheDrawInsteadOfPickingAWinner() public {
        _buy(bob, 5);
        skip(1 days);
        ticketRaffle.close(raffleId);
        skip(1 days);
        randomness.fulfill(1, 0);
        assertEq(uint8(_status()), uint8(TicketRaffle.Status.Open));

        ticketRaffle.close(raffleId); // request 2
        vm.expectRevert(TicketRaffle.StaleRequest.selector);
        randomness.fulfill(1, 0);
        randomness.fulfill(2, 0);
        assertEq(uint8(_status()), uint8(TicketRaffle.Status.Won));
    }

    function test_resetDraw_afterTimeout() public {
        _buy(bob, 5);
        skip(1 days);
        ticketRaffle.close(raffleId);
        vm.expectRevert(abi.encodeWithSelector(TicketRaffle.TooEarly.selector, block.timestamp + 1 days));
        ticketRaffle.resetDraw(raffleId);
        skip(1 days);
        ticketRaffle.resetDraw(raffleId);
        ticketRaffle.close(raffleId);
        vm.expectRevert(TicketRaffle.StaleRequest.selector);
        randomness.fulfill(1, 0);
    }

    function test_fulfill_onlyRandomnessProvider() public {
        _buy(bob, 5);
        skip(1 days);
        ticketRaffle.close(raffleId);
        vm.prank(bob);
        vm.expectRevert(TicketRaffle.NotRandomness.selector);
        ticketRaffle.fulfillRandomness(1, 0);
    }

    function test_create_onlySupportedCollectionsAndOnlyTheTokenOwner() public {
        _mintApproved(alice, 2, address(ticketRaffle));
        vm.prank(bob);
        vm.expectRevert(TicketRaffle.NotTokenOwner.selector);
        ticketRaffle.create(address(nft), 2, 0.1 ether, 5, 20, 1 days);

        vm.prank(gov);
        ticketRaffle.setCollectionSupport(address(nft), false);
        vm.prank(alice);
        vm.expectRevert(TicketRaffle.UnsupportedCollection.selector);
        ticketRaffle.create(address(nft), 2, 0.1 ether, 5, 20, 1 days);
    }

    /// A raffle too small to pay for its own randomness request is refunded, not drawn.
    function test_potBelowMinimumIsRefunded() public {
        _mintApproved(alice, 2, address(ticketRaffle));
        vm.prank(alice);
        uint256 id = ticketRaffle.create(address(nft), 2, 1 wei, 1, 1, 1 hours);
        vm.prank(bob);
        ticketRaffle.buy{value: 1}(id, 1);
        ticketRaffle.close(id);
        (,,,,,,,,, TicketRaffle.Status status,) = ticketRaffle.raffles(id);
        assertEq(uint8(status), uint8(TicketRaffle.Status.Refunding));
        assertEq(randomness.lastRequestId(), 0);
    }

    /// If randomness never arrives, anyone can turn the raffle into refunds a week after its end.
    function test_abort_whenTheDrawNeverCompletes() public {
        _buy(bob, 5);
        skip(1 days);
        ticketRaffle.close(raffleId);
        vm.expectRevert(abi.encodeWithSelector(TicketRaffle.TooEarly.selector, block.timestamp + 7 days));
        ticketRaffle.abort(raffleId);

        skip(7 days);
        vm.prank(carol);
        ticketRaffle.abort(raffleId);
        assertEq(uint8(_status()), uint8(TicketRaffle.Status.Refunding));

        uint256 before = bob.balance;
        vm.prank(bob);
        ticketRaffle.refund(raffleId);
        assertEq(bob.balance - before, 0.5 ether);
        vm.prank(alice);
        ticketRaffle.reclaim(raffleId);
        assertEq(nft.ownerOf(1), alice);

        vm.expectRevert(TicketRaffle.StaleRequest.selector);
        randomness.fulfill(1, 0); // the abandoned request can no longer pick a winner
    }

    /// A drawn raffle that nobody settles for a week (for example because the NFT cannot be moved) can
    /// also be aborted, so the ticket money is never stuck.
    function test_abort_whenAWonRaffleIsNeverSettled() public {
        _buy(bob, 5);
        skip(1 days);
        ticketRaffle.close(raffleId);
        randomness.fulfill(1, 0);
        skip(7 days);
        ticketRaffle.abort(raffleId);
        vm.expectRevert(
            abi.encodeWithSelector(TicketRaffle.WrongStatus.selector, TicketRaffle.Status.Refunding)
        );
        ticketRaffle.settle(raffleId);
        vm.prank(bob);
        ticketRaffle.refund(raffleId);
        assertEq(address(ticketRaffle).balance, 0);
    }

    /// The fee is fixed when the raffle is created.
    function test_feeChangeDoesNotAffectExistingRaffles() public {
        vm.prank(gov);
        ticketRaffle.setParams(1_000, 0.05 ether);
        _buy(bob, 10);
        skip(1 days);
        ticketRaffle.close(raffleId);
        randomness.fulfill(1, 0);
        ticketRaffle.settle(raffleId);
        assertEq(ticketRaffle.owedTo(alice), 0.95 ether);
    }

    /// Whoever buys however many tickets, every wei ends up with the creator, the treasury or back
    /// with the buyers, and the winner holds one of the tickets.
    function testFuzz_accounting(uint8[5] memory counts, uint256 word) public {
        address[3] memory buyers = [bob, carol, makeAddr("dave")];
        vm.deal(buyers[2], 100 ether);
        uint256 sold;
        for (uint256 i; i < 5; ++i) {
            uint32 count = uint32(bound(counts[i], 0, 6));
            if (count == 0 || sold + count > 20) continue;
            _buy(buyers[i % 3], count);
            sold += count;
        }
        skip(1 days);
        ticketRaffle.close(raffleId);

        if (sold < 5) {
            vm.prank(alice);
            ticketRaffle.reclaim(raffleId);
            assertEq(nft.ownerOf(1), alice);
            for (uint256 i; i < 3; ++i) {
                if (ticketRaffle.paidBy(raffleId, buyers[i]) == 0) continue;
                vm.prank(buyers[i]);
                ticketRaffle.refund(raffleId);
            }
            assertEq(address(ticketRaffle).balance, 0);
            return;
        }
        randomness.fulfill(1, word);
        ticketRaffle.settle(raffleId);
        (,,,,,,,,,, address winner) = ticketRaffle.raffles(raffleId);
        assertGt(ticketRaffle.paidBy(raffleId, winner), 0);
        assertEq(nft.ownerOf(1), winner);
        assertEq(ticketRaffle.owedTo(alice) + treasury.budgetOf(address(nft)), sold * 0.1 ether);
        assertEq(address(ticketRaffle).balance, ticketRaffle.owedTo(alice));
    }
}
