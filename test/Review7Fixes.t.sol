// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {Vault} from "../src/Vault.sol";
import {VaultRaffle} from "../src/VaultRaffle.sol";
import {Games} from "../src/Games.sol";
import {TicketRaffle} from "../src/TicketRaffle.sol";
import {Lottery} from "../src/Lottery.sol";
import {ChainlinkVRFRandomness, IVRFCoordinatorV2Plus} from "../src/randomness/ChainlinkVRFRandomness.sol";
import {IRandomnessProvider, IRandomnessConsumer} from "../src/interfaces/IFloorGuard.sol";
import {Burner, Rejector} from "./SystemHandler.sol";

/// @dev A provider that numbers its requests from zero and lets anyone deliver the answer.
contract ZeroIdRandomness is IRandomnessProvider {
    uint256 public next;
    mapping(uint256 => address) public consumerOf;

    function requestRandomness() external returns (uint256 requestId) {
        requestId = next++;
        consumerOf[requestId] = msg.sender;
    }

    function fulfill(uint256 requestId, uint256 word) external {
        IRandomnessConsumer(consumerOf[requestId]).fulfillRandomness(requestId, word);
    }
}

/// @dev Stands in for the VRF v2.5 coordinator and forwards the callback with a chosen gas limit.
contract R7Coordinator is IVRFCoordinatorV2Plus {
    uint256 public count;
    uint256 public lastRequestId;
    mapping(uint256 => address) public consumerOf;

    function requestRandomWords(RandomWordsRequest calldata) external returns (uint256 requestId) {
        requestId = uint256(keccak256(abi.encode(++count)));
        lastRequestId = requestId;
        consumerOf[requestId] = msg.sender;
    }

    function fulfill(uint256 requestId, uint256 word, uint256 gasLimit)
        external
        returns (bool ok, uint256 used)
    {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        uint256 before = gasleft();
        (ok,) = consumerOf[requestId].call{gas: gasLimit}(
            abi.encodeCall(ChainlinkVRFRandomness.rawFulfillRandomWords, (requestId, words))
        );
        used = before - gasleft();
    }
}

/// @notice Review 7, part 1: the fixes made after review 6, re-checked.
contract Review7FixesTest is Base {
    address internal constant OTHER = address(0xC0FFEE);

    function setUp() public override {
        super.setUp();
        vm.startPrank(gov);
        ticketRaffle.setCollectionSupport(address(nft), true);
        lottery.setConfig(address(nft), 0.01 ether, 1 days, true);
        lottery.setConfig(OTHER, 0.01 ether, 1 hours, true);
        vm.stopPrank();
    }

    /// The shipped providers never issue id 0 (the mock counts from 1, VRF ids are hashes), and with ids
    /// from 1 the unconditional delete touches nothing.
    function test_R7L1_notReachableWithIdsFromOne() public {
        vm.prank(carol);
        uint256 stale = lottery.buy{value: 0.01 ether}(OTHER, 1);
        skip(1 hours + 7 days);
        vm.prank(alice);
        uint256 roundId = lottery.buy{value: 0.1 ether}(address(nft), 10);
        skip(1 days);
        lottery.draw(roundId);
        lottery.abort(stale);
        randomness.fulfill(1, 3);
        assertEq(lottery.owedTo(alice), 0.095 ether);
    }

    // ------------------------------------------------------------------ refunds past the abort time

    /// Nobody can keep `close` from being called: it is open to anyone, makes no call to the creator or
    /// to a buyer, and a buyer that cannot receive ETH does not stand in its way.
    function test_closeCannotBeBlockedByCreatorOrBuyer() public {
        Rejector hostile = new Rejector();
        vm.deal(address(hostile), 10 ether);
        _mintApproved(alice, 1, address(ticketRaffle));
        vm.prank(alice);
        uint256 id = ticketRaffle.create(address(nft), 1, 0.1 ether, 1, 10, 1 days);
        vm.prank(address(hostile));
        ticketRaffle.buy{value: 0.5 ether}(id, 5);
        skip(1 days);
        vm.prank(carol); // a stranger
        ticketRaffle.close(id);
        randomness.fulfill(1, 0);
        ticketRaffle.settle(id);
        assertEq(nft.ownerOf(1), address(hostile));
        assertEq(ticketRaffle.owedTo(alice), 0.475 ether);
    }

    /// A sold-out raffle that is only closed just before a week after its scheduled end still draws;
    /// one second later it refunds. The end time is only rewritten when it closes early.
    function test_soldOutRaffleClosedLate_drawsUntilTheAbortTimeThenRefunds() public {
        _mintApproved(alice, 1, address(ticketRaffle));
        vm.prank(alice);
        uint256 id = ticketRaffle.create(address(nft), 1, 0.1 ether, 1, 5, 1 days);
        vm.prank(bob);
        ticketRaffle.buy{value: 0.5 ether}(id, 5);

        skip(8 days - 1);
        uint256 snap = vm.snapshotState();
        ticketRaffle.close(id);
        (,,,,,,, uint40 endTime,, TicketRaffle.Status status,) = ticketRaffle.raffles(id);
        assertEq(uint8(status), uint8(TicketRaffle.Status.Drawing));
        assertEq(endTime, block.timestamp - 7 days + 1, "end time untouched");
        vm.revertToState(snap);

        skip(1);
        ticketRaffle.close(id);
        (,,,,,,,,, status,) = ticketRaffle.raffles(id);
        assertEq(uint8(status), uint8(TicketRaffle.Status.Refunding));
    }

    /// Early sell-out, then a draw that is never answered: the week runs from the close, and after it
    /// `close` refunds even though the scheduled end has not been reached.
    function test_earlySellOut_resetDrawThenCloseRefundsAWeekAfterTheFirstClose() public {
        _mintApproved(alice, 1, address(ticketRaffle));
        vm.prank(alice);
        uint256 id = ticketRaffle.create(address(nft), 1, 0.1 ether, 1, 5, 30 days);
        vm.prank(bob);
        ticketRaffle.buy{value: 0.5 ether}(id, 5);
        ticketRaffle.close(id); // sold out on day 0
        uint256 closedAt = block.timestamp;

        // six failed draws, one a day: each can still be requested
        for (uint256 day = 1; day <= 6; ++day) {
            vm.warp(closedAt + day * 1 days);
            ticketRaffle.resetDraw(id);
            ticketRaffle.close(id);
            (,,,,,,,,, TicketRaffle.Status s,) = ticketRaffle.raffles(id);
            assertEq(uint8(s), uint8(TicketRaffle.Status.Drawing));
        }
        // the answer to the sixth is still accepted until day 7, so no abort before that
        vm.warp(closedAt + 7 days - 1);
        vm.expectRevert();
        ticketRaffle.abort(id);
        vm.warp(closedAt + 7 days);
        ticketRaffle.resetDraw(id);
        ticketRaffle.close(id);
        (,,,,,,,,, TicketRaffle.Status status,) = ticketRaffle.raffles(id);
        assertEq(uint8(status), uint8(TicketRaffle.Status.Refunding));
        vm.prank(bob);
        ticketRaffle.refund(id);
        vm.prank(alice);
        ticketRaffle.reclaim(id);
        assertEq(nft.ownerOf(1), alice);
    }

    /// A raffle that was drawn just before its abort time can still be settled after it: `settle` has no
    /// deadline of its own, and `abort` of a won raffle counts a week from the draw request.
    function test_wonRaffleSettlesAfterTheAbortTimeOfItsEnd() public {
        _mintApproved(alice, 1, address(ticketRaffle));
        vm.prank(alice);
        uint256 id = ticketRaffle.create(address(nft), 1, 0.1 ether, 1, 5, 1 days);
        vm.prank(bob);
        ticketRaffle.buy{value: 0.5 ether}(id, 5);
        skip(8 days - 1 hours);
        ticketRaffle.close(id);
        randomness.fulfill(1, 2);

        skip(6 days); // nearly two weeks after the end
        vm.expectRevert();
        ticketRaffle.abort(id);
        ticketRaffle.settle(id);
        assertEq(nft.ownerOf(1), bob);
    }

    /// Lottery: the same boundary. One second before a week after the end the round draws; at a week it
    /// refunds, and a round reopened by a late answer after that time refunds too.
    function test_lotteryDrawBoundaryAndLateAnswerAfterIt() public {
        vm.prank(bob);
        uint256 roundId = lottery.buy{value: 0.1 ether}(address(nft), 10);
        skip(8 days - 1);
        lottery.draw(roundId);
        (,,,,,, Lottery.Status status,) = lottery.rounds(roundId);
        assertEq(uint8(status), uint8(Lottery.Status.Drawing));

        skip(1 days); // the answer is late
        randomness.fulfill(1, 0);
        (,,,,,, status,) = lottery.rounds(roundId);
        assertEq(uint8(status), uint8(Lottery.Status.Open));
        lottery.draw(roundId);
        (,,,,,, status,) = lottery.rounds(roundId);
        assertEq(uint8(status), uint8(Lottery.Status.Refunding));
        assertEq(randomness.lastRequestId(), 1, "no second request");
        uint256 before = bob.balance;
        vm.prank(bob);
        lottery.refund(roundId);
        assertEq(bob.balance - before, 0.1 ether);
    }

    // ------------------------------------------------------------------ vault unlock floor

    function _holding(uint256 price) internal returns (uint256 vaultId) {
        vm.prank(gov);
        engine.configureBid(address(nft), uint128(price), uint128(price), 0, 0, true);
        treasury.deposit{value: price}(address(nft));
        _mintApproved(alice, 1, address(engine));
        vm.prank(alice);
        vaultId = engine.sell(address(nft), 1, 0);
    }

    /// A relock keeps the recorded floor, the next permissionless unlock overwrites it, and the opening
    /// price of the auction follows the newest record. At the cap the auction takes eight days, not
    /// four, to reach its reserve.
    function test_unlockFloorAfterRelockAndAuctionOpeningAtTheCap() public {
        uint256 vaultId = _holding(10 ether);
        _unlockThroughDraw(vaultId, 1_000_000 ether);
        assertEq(vault.unlockFloorOf(vaultId), 208 ether);

        vm.prank(gov);
        vault.relock(vaultId, block.timestamp + 1 days);
        assertEq(vault.unlockFloorOf(vaultId), 208 ether, "kept across a relock");
        _unlockThroughDraw(vaultId, 14 ether);
        assertEq(vault.unlockFloorOf(vaultId), 14 ether, "overwritten by the next unlock");

        // back to the capped record
        vm.prank(gov);
        vault.relock(vaultId, block.timestamp + 1 days);
        _unlockThroughDraw(vaultId, 1_000_000 ether);
        _pushFloor(13 ether);
        vm.prank(gov);
        vault.startAuction(vaultId);
        // the holding is older now, so the multiple it needed, and the cap, are a little lower
        uint256 cap = 10 ether * vault.unlockBpsOf(vaultId) / 10_000 * 16;
        assertLt(vault.unlockBpsOf(vaultId), 13_000);
        assertEq(vault.unlockFloorOf(vaultId), cap);
        (uint128 startPrice, uint128 endPrice,) = vault.auctions(vaultId);
        assertEq(endPrice, 13 ether);
        assertEq(startPrice, cap * 16);
        skip(4 days);
        assertEq(vault.auctionPrice(vaultId), cap, "after AUCTION_DURATION still 16x the cap");
        skip(4 days);
        assertEq(vault.auctionPrice(vaultId), 13 ether);
    }

    // ------------------------------------------------------------------ VRF callback gas
    /// The most expensive games callback: a win paid to a contract that burns the whole stipend, with a
    /// project share and a first points credit. It fits in MIN_CALLBACK_GAS, and a loss costs less than
    /// a win, so a player cannot arrange for only losing settlements to run out of gas.
    function test_gamesCallbackGas_winCostsMoreThanLossAndFitsTheMinimum() public {
        R7Coordinator coordinator = new R7Coordinator();
        ChainlinkVRFRandomness adapter = new ChainlinkVRFRandomness(gov, coordinator, games, bytes32(0), 1);
        Burner player = new Burner();
        vm.deal(address(player), 10 ether);
        vm.startPrank(gov);
        games.setRandomness(adapter);
        treasury.setProjectShare(address(nft), address(0xABCD), 2_000);
        vm.stopPrank();
        games.fundBankroll{value: 1_000 ether}();

        vm.prank(address(player));
        uint256 id = games.play{value: 0.1 ether}(address(nft), 5_000);

        uint256 snap = vm.snapshotState();
        _coolGames();
        (bool ok, uint256 win) = coordinator.fulfill(id, 0, 5_000_000);
        assertTrue(ok);
        assertEq(games.owedTo(address(player)), 0.196 ether, "the payout was deferred");
        vm.revertToState(snap);

        _coolGames();
        uint256 loss;
        (ok, loss) = coordinator.fulfill(id, 9_999, 5_000_000);
        assertTrue(ok);
        console2.log("games callback gas, win to a gas-burning contract", win);
        console2.log("games callback gas, loss", loss);
        assertLt(loss, win);
        assertLt(win, adapter.MIN_CALLBACK_GAS());
    }

    // ------------------------------------------------------------------ full read: licences

    /// R7-I3. `latestLicenseOf` keeps one licence per tier. When that one is revoked and the ban is later
    /// lifted, an older licence of the same tier that is unrevoked and still in its term stays hidden:
    /// the licensee paid for it, it was never revoked, and `hasValidLicense` says no.
    function test_R7I3_unrevokedLicenceStaysHiddenAfterBanIsLifted() public {
        uint256 vaultId = _holding(10 ether);
        vm.prank(gov);
        licenses.setTier(address(nft), 0, 0.1 ether, 30 days, true);
        vm.prank(bob);
        uint256 first = licenses.requestLicense{value: 0.1 ether}(vaultId, 0, "print run");
        vm.prank(gov);
        licenses.setTier(address(nft), 0, 0.1 ether, 60 days, true);
        vm.prank(bob);
        uint256 second = licenses.requestLicense{value: 0.1 ether}(vaultId, 0, "print run, longer");

        vm.startPrank(gov);
        licenses.revokeLicense(second);
        licenses.setBan(bob, vaultId, false);
        vm.stopPrank();

        (,,,, uint40 end, bool revoked,) = licenses.licenses(first);
        assertFalse(revoked);
        assertGt(end, block.timestamp);
        assertFalse(licenses.hasValidLicense(bob, vaultId, 0), "the first licence is in force but not found");
    }

    function _coolGames() internal {
        vm.cool(address(games));
        vm.cool(address(treasury));
        vm.cool(address(points));
    }
}
