// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";
import {Points} from "../src/Points.sol";
import {VaultRaffle} from "../src/VaultRaffle.sol";
import {Games} from "../src/Games.sol";
import {Vault} from "../src/Vault.sol";
import {TicketRaffle} from "../src/TicketRaffle.sol";
import {Lottery} from "../src/Lottery.sol";
import {ChainlinkVRFRandomness, IVRFCoordinatorV2Plus} from "../src/randomness/ChainlinkVRFRandomness.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {BuybackEngine} from "../src/BuybackEngine.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockNFT, RejectETH} from "./mocks/MockNFT.sol";
import {MockRandomness} from "./mocks/MockRandomness.sol";
import {
    IRandomnessProvider,
    IRandomnessConsumer,
    IPoints,
    ISaleRecorder
} from "../src/interfaces/IFloorGuard.sol";

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
        skip(1 hours);
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
        uint256 marketId = prediction.createMarket(address(nft), 1 hours, 12 hours);
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
        prediction.createMarket(address(nft), 2 hours + 24 minutes + 1, 1 days); // more than a tenth
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

    // ------------------------------------------------------------------ second review

    /// Randomness arriving after the refund window refunds the bet instead of settling it, so nobody
    /// can pick between a late result and a refund.
    function test_lateGameRandomnessRefundsInsteadOfSettling() public {
        games.fundBankroll{value: 1_000 ether}();
        vm.prank(alice);
        uint256 id = games.play{value: 1 ether}(address(nft), 5_000);
        skip(1 days);

        uint256 before = alice.balance;
        randomness.fulfill(id, 0); // would have been a win
        assertEq(alice.balance - before, 1 ether);
        assertEq(games.bankroll(), 1_000 ether);
        assertEq(games.reserved(), 0);
        assertEq(treasury.budgetOf(address(nft)), 0);
    }

    function test_lateRaffleRandomnessResetsInsteadOfPickingAWinner() public {
        uint256 raffleId = _openRaffle();
        _earn(bob, 1 ether);
        skip(7 days);
        raffle.draw(raffleId);
        skip(1 days);
        randomness.fulfill(1, 0);

        (,,,, VaultRaffle.Status status, address winner) = raffle.raffles(raffleId);
        assertEq(uint8(status), uint8(VaultRaffle.Status.Open));
        assertEq(winner, address(0));
        assertEq(points.freezeCount(), 0);
    }

    /// After a reset the next draw must wait, leaving a window in which points can be activated.
    function test_redrawCooldownLeavesAWindowToActivatePoints() public {
        uint256 raffleId = _openRaffle();
        _earn(bob, 1 ether);
        skip(7 days);
        raffle.draw(raffleId);
        points.creditFee(carol, 1 ether);
        skip(1 days);
        raffle.resetDraw(raffleId);

        vm.expectRevert(abi.encodeWithSelector(VaultRaffle.TooEarly.selector, block.timestamp + 1 hours));
        raffle.draw(raffleId);
        points.flush(carol);
        assertEq(points.pointsOf(carol), 1_000e18);
    }

    function test_raffleCannotBeReplacedMidDraw() public {
        uint256 raffleId = _openRaffle();
        _earn(bob, 1 ether);
        skip(7 days);
        raffle.draw(raffleId);
        vm.prank(gov);
        vm.expectRevert(Points.Frozen.selector);
        points.setRaffle(address(1));
    }

    /// A replacement randomness provider cannot overwrite a bet that is still open.
    function test_gameRequestIdCannotBeReused() public {
        games.fundBankroll{value: 1_000 ether}();
        vm.prank(alice);
        uint256 id = games.play{value: 1 ether}(address(nft), 5_000);

        MockRandomness fresh = new MockRandomness(); // its ids also start at 1
        vm.prank(gov);
        games.setRandomness(IRandomnessProvider(address(fresh)));
        vm.prank(bob);
        vm.expectRevert(Games.RequestIdInUse.selector);
        games.play{value: 0.01 ether}(address(nft), 5_000);

        skip(1 days);
        games.refund(id); // alice's bet is intact and refundable
        assertEq(games.reserved(), 0);
    }

    /// Open bets together can put at most 20% of the house's funds at risk.
    function test_gameTotalExposureIsCapped() public {
        games.fundBankroll{value: 100 ether}();
        uint256 placed;
        vm.startPrank(alice);
        while (true) {
            (bool ok,) =
                address(games).call{value: 0.005 ether}(abi.encodeCall(Games.play, (address(nft), 100)));
            if (!ok) break;
            ++placed;
        }
        vm.stopPrank();
        assertGt(placed, 10);
        assertLe(games.reserved(), 20 ether);
        assertGe(games.bankroll(), 80 ether);
    }

    /// Points are earned on the part of the fee that funds buybacks, not on the project's share.
    function test_pointsExcludeTheProjectShare() public {
        address project = makeAddr("project");
        vm.prank(gov);
        treasury.setProjectShare(address(nft), project, 5_000);

        _mintApproved(alice, 1, address(marketplace));
        vm.prank(bob);
        uint256 id = marketplace.makeOffer{value: 50 ether}(address(nft), 1, block.timestamp + 1 days);
        vm.prank(alice);
        marketplace.acceptOffer(id, 1, 0);

        // 1 ETH fee, half to the project: the 0.5 ETH that funds buybacks is credited once, split in two
        assertEq(treasury.budgetOf(address(nft)), 0.5 ether);
        assertEq(points.pendingOf(alice), 0.25 ether * POINTS_RATE / 1 ether);
        assertEq(points.pendingOf(bob), 0.25 ether * POINTS_RATE / 1 ether);
    }

    function test_projectShareCanBeClaimedToAnotherAddress() public {
        address project = address(new RejectETH());
        vm.prank(gov);
        treasury.setProjectShare(address(nft), project, 5_000);
        treasury.depositFee{value: 2 ether}(address(nft));

        vm.prank(project);
        vm.expectRevert(Treasury.TransferFailed.selector);
        treasury.claimProjectShare();

        vm.prank(project);
        treasury.claimProjectShareTo(payable(carol));
        assertEq(treasury.owedTo(project), 0);
        assertEq(treasury.totalOwed(), 0);
    }

    function test_setPointsRejectsAddressWithoutCode() public {
        vm.startPrank(gov);
        vm.expectRevert(Games.NotAContract.selector);
        games.setPoints(IPoints(address(0xdead)));
        games.setPoints(IPoints(address(0))); // turning points off is allowed
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ full-system audit

    /// The sales oracle can be pushed to 1 wei for free, but an auction opens at 16 times the unlock
    /// price and halves daily, so it is still above the real market when buyers start competing.
    function test_auctionCannotBeSnipedBelowMarketByPushingTheOracleDown() public {
        vm.prank(gov);
        vault.setOracle(salesOracle);
        vm.prank(gov);
        engine.configureBid(address(nft), 10 ether, 15 ether, 0, 0, true);
        treasury.deposit{value: 10 ether}(address(nft));
        _mintApproved(alice, 1, address(engine));
        vm.prank(alice);
        uint256 vaultId = engine.sell(address(nft), 1, 0); // bought at 10 ETH; the market is now 30 ETH
        vm.prank(gov);
        vault.governanceUnlock(vaultId);
        skip(30 days);

        // four free wash sales at 1 wei take over the median
        nft.mint(carol, 50);
        vm.startPrank(carol);
        nft.setApprovalForAll(address(marketplace), true);
        for (uint256 i; i < 4; ++i) {
            uint256 id = marketplace.makeCollectionOffer{value: 1}(address(nft), 1, block.timestamp + 1);
            marketplace.acceptOffer(id, 50, 0);
        }
        (uint256 floor,) = salesOracle.floorPrice(address(nft));
        assertEq(floor, 1);

        vault.startAuction(vaultId);
        vm.stopPrank();
        assertEq(vault.auctionPrice(vaultId), 208 ether);
        skip(2 days + 12 hours);
        assertGt(vault.auctionPrice(vaultId), 30 ether); // still above the real market after 2.5 days
        skip(2 days);
        assertEq(vault.auctionPrice(vaultId), 13 ether); // and never below the unlock price
    }

    /// A buyback cooldown limits how fast anyone with cheap supply can sell into the bid.
    function test_fillCooldownSlowsRepeatedBuybacks() public {
        vm.startPrank(gov);
        engine.configureBid(address(nft), 1 ether, 2 ether, 1_000, 500, true);
        engine.setFillCooldown(address(nft), 1 hours);
        vm.stopPrank();
        treasury.deposit{value: 10 ether}(address(nft));
        _mintApproved(alice, 1, address(engine));
        _mintApproved(alice, 2, address(engine));

        vm.startPrank(alice);
        engine.sell(address(nft), 1, 0);
        vm.expectRevert(
            abi.encodeWithSelector(BuybackEngine.FillCooldown.selector, block.timestamp + 1 hours)
        );
        engine.sell(address(nft), 2, 0);
        skip(1 hours);
        engine.sell(address(nft), 2, 0);
        vm.stopPrank();
    }

    /// A collection without ERC-2981 whose fallback returns nothing can still be traded.
    function test_collectionWithSilentFallbackIsTradeable() public {
        FallbackNFT odd = new FallbackNFT();
        odd.mint(alice, 1);
        vm.prank(alice);
        odd.approve(address(marketplace), 1);
        vm.prank(bob);
        uint256 id = marketplace.makeOffer{value: 1 ether}(address(odd), 1, block.timestamp + 1 days);
        vm.prank(alice);
        marketplace.acceptOffer(id, 1, 0);
        assertEq(odd.ownerOf(1), bob);
    }

    /// A prediction loser's points are scaled by the project share, like a winner's.
    function test_predictionLoserPointsExcludeTheProjectShare() public {
        vm.prank(gov);
        treasury.setProjectShare(address(nft), makeAddr("project"), 5_000);
        _pushFloor(10 ether);
        uint256 marketId = prediction.createMarket(address(nft), 1 hours, 1 days);
        vm.prank(alice);
        prediction.placeBet{value: 1 ether}(marketId, true);
        vm.prank(bob);
        prediction.placeBet{value: 1 ether}(marketId, false);
        skip(1 days);
        _pushFloor(11 ether);
        prediction.resolve(marketId);
        vm.prank(alice);
        prediction.claim(marketId);
        vm.prank(bob);
        prediction.claim(marketId);
        assertEq(points.pendingOf(bob), points.pendingOf(alice));
        assertEq(points.pendingOf(bob), 0.0075 ether * POINTS_RATE / 1 ether);
    }

    // ------------------------------------------------------------------ fifth review

    function _holdingBoughtAt10() internal returns (uint256 vaultId) {
        vm.prank(gov);
        engine.configureBid(address(nft), 10 ether, 15 ether, 0, 0, true);
        treasury.deposit{value: 10 ether}(address(nft));
        _mintApproved(alice, 1, address(engine));
        vm.prank(alice);
        vaultId = engine.sell(address(nft), 1, 0);
    }

    /// An auction the owner priced can only be restarted or replaced by the owner.
    function test_publicCannotReplaceAnOwnerPricedAuction() public {
        uint256 vaultId = _holdingBoughtAt10();
        vm.startPrank(gov);
        vault.governanceUnlock(vaultId);
        vault.startAuctionWithPrices(vaultId, 400 ether, 100 ether);
        vm.stopPrank();
        skip(60 days);
        _pushFloor(1 ether);
        assertEq(vault.auctionPrice(vaultId), 100 ether);

        vm.prank(carol);
        vm.expectRevert(Vault.OwnerPricedAuction.selector);
        vault.startAuction(vaultId);
        assertEq(vault.auctionPrice(vaultId), 100 ether);

        vm.prank(gov);
        vault.startAuctionWithPrices(vaultId, 50 ether, 5 ether); // the owner can
        assertEq(vault.auctionPrice(vaultId), 50 ether);
    }

    /// An auction cannot be restarted before its price has fallen to the reserve.
    function test_auctionRestartsOnlyOnceThePriceReachedTheReserve() public {
        uint256 vaultId = _holdingBoughtAt10();
        skip(180 days);
        _pushFloor(100 ether);
        vault.unlock(vaultId); // floor at unlock: 100 ETH
        assertEq(vault.unlockFloorOf(vaultId), 100 ether);
        skip(30 days);

        // the oracle now reads 13 ETH, but the auction still opens at 16 x the floor seen at unlock
        _pushFloor(13 ether);
        vm.prank(carol);
        vault.startAuction(vaultId);
        assertEq(vault.auctionPrice(vaultId), 1_600 ether);

        skip(4 days); // 100 ETH: not yet at the 13 ETH reserve
        _pushFloor(13 ether);
        vm.prank(carol);
        vm.expectRevert(Vault.AuctionRunning.selector);
        vault.startAuction(vaultId);

        skip(3 days); // 1,600 / 128 = 12.5, floored at 13
        _pushFloor(13 ether);
        assertEq(vault.auctionPrice(vaultId), 13 ether);
        vm.prank(carol);
        vault.startAuction(vaultId);
    }

    function test_minReserveIsALowerBoundOnOraclePricedAuctions() public {
        uint256 vaultId = _holdingBoughtAt10();
        vm.startPrank(gov);
        vault.governanceUnlock(vaultId);
        vault.setMinReserve(address(nft), 40 ether);
        vm.stopPrank();
        _pushFloor(1 ether);
        vm.prank(gov);
        vault.startAuction(vaultId);
        assertEq(vault.auctionPrice(vaultId), 640 ether);
        skip(30 days);
        assertEq(vault.auctionPrice(vaultId), 40 ether);
    }

    /// Cancelling an auction restarts the governance window.
    function test_cancelAuctionReopensTheGovernanceWindow() public {
        uint256 vaultId = _holdingBoughtAt10();
        vm.prank(gov);
        vault.governanceUnlock(vaultId);
        skip(31 days);
        _pushFloor(13 ether);
        vm.startPrank(gov);
        vault.startAuction(vaultId);
        vault.cancelAuction(vaultId);
        vm.stopPrank();

        vm.prank(carol);
        vm.expectRevert(
            abi.encodeWithSelector(Vault.GovernanceWindowOpen.selector, block.timestamp + 30 days)
        );
        vault.startAuction(vaultId);
    }

    /// Only one vault raffle draw can be in flight, so points always get a window to be activated.
    function test_onlyOneVaultRaffleDrawAtATime() public {
        uint256 first = _openRaffle();
        // a second prize
        treasury.deposit{value: 10 ether}(address(nft));
        _mintApproved(alice, 2, address(engine));
        vm.prank(alice);
        uint256 vaultId = engine.sell(address(nft), 2, 0);
        vm.startPrank(gov);
        vault.governanceUnlock(vaultId);
        uint256 second = vault.sendToRaffle(vaultId);
        vm.stopPrank();
        _earn(bob, 1 ether);
        skip(7 days);

        raffle.draw(first);
        vm.expectRevert(VaultRaffle.DrawInFlight.selector);
        raffle.draw(second);
        randomness.fulfill(1, 0);
        raffle.draw(second);
    }

    /// A ticket raffle cannot be aborted while an answer to its draw would still be accepted, so nobody
    /// can veto a result they have seen coming.
    function test_ticketRaffleAbortCannotVetoAPendingDraw() public {
        vm.prank(gov);
        ticketRaffle.setCollectionSupport(address(nft), true);
        _mintApproved(alice, 1, address(ticketRaffle));
        vm.prank(alice);
        uint256 id = ticketRaffle.create(address(nft), 1, 0.1 ether, 5, 20, 1 days);
        vm.prank(bob);
        ticketRaffle.buy{value: 0.5 ether}(id, 5);
        vm.prank(carol);
        ticketRaffle.buy{value: 0.5 ether}(id, 5);

        skip(1 days + 6 days + 12 hours); // closed late, half a day before the abort time
        ticketRaffle.close(id);
        skip(12 hours); // a week after the end: the answer to the draw is still awaited
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TicketRaffle.TooEarly.selector, block.timestamp + 12 hours));
        ticketRaffle.abort(id);

        randomness.fulfill(1, 7); // carol's ticket: the result stands
        (,,,,,,,,,, address winner) = ticketRaffle.raffles(id);
        assertEq(winner, carol);
    }

    /// A raffle that sells out early can be aborted a week after it closed, not after its scheduled end.
    function test_soldOutRaffleAbortClockRunsFromTheClose() public {
        vm.prank(gov);
        ticketRaffle.setCollectionSupport(address(nft), true);
        _mintApproved(alice, 1, address(ticketRaffle));
        vm.prank(alice);
        uint256 id = ticketRaffle.create(address(nft), 1, 0.1 ether, 5, 10, 30 days);
        vm.prank(bob);
        ticketRaffle.buy{value: 1 ether}(id, 10);
        ticketRaffle.close(id); // sold out in the first hour; randomness never arrives

        skip(7 days);
        ticketRaffle.abort(id);
        uint256 before = bob.balance;
        vm.prank(bob);
        ticketRaffle.refund(id);
        assertEq(bob.balance - before, 1 ether);
    }

    function test_lotteryAbortCannotVetoAPendingDraw() public {
        vm.prank(gov);
        lottery.setConfig(address(nft), 0.01 ether, 1 days, true);
        vm.prank(bob);
        uint256 roundId = lottery.buy{value: 0.1 ether}(address(nft), 10);
        skip(1 days + 6 days + 12 hours);
        lottery.draw(roundId);
        skip(12 hours);
        vm.expectRevert(abi.encodeWithSelector(Lottery.TooEarly.selector, block.timestamp + 12 hours));
        lottery.abort(roundId);
        randomness.fulfill(1, 0);
        assertEq(lottery.owedTo(bob), 0.095 ether);
    }

    // ------------------------------------------------------------------ sixth review

    /// Once a round or raffle is past its abort time, closing it refunds instead of requesting another
    /// draw, so retrying a draw cannot keep pushing refunds out.
    function test_drawPastTheAbortTimeGoesStraightToRefunds() public {
        vm.startPrank(gov);
        lottery.setConfig(address(nft), 0.01 ether, 1 days, true);
        ticketRaffle.setCollectionSupport(address(nft), true);
        vm.stopPrank();
        vm.prank(bob);
        uint256 roundId = lottery.buy{value: 0.1 ether}(address(nft), 10);
        _mintApproved(alice, 1, address(ticketRaffle));
        vm.prank(alice);
        uint256 raffleId = ticketRaffle.create(address(nft), 1, 0.1 ether, 1, 10, 1 days);
        vm.prank(bob);
        ticketRaffle.buy{value: 0.5 ether}(raffleId, 5);

        skip(9 days);
        lottery.draw(roundId);
        ticketRaffle.close(raffleId);
        assertEq(randomness.lastRequestId(), 0);

        uint256 before = bob.balance;
        vm.startPrank(bob);
        lottery.refund(roundId);
        ticketRaffle.refund(raffleId);
        vm.stopPrank();
        assertEq(bob.balance - before, 0.6 ether);
    }

    /// The lottery only ever accepts the answer to a round's current request, even from a provider
    /// that numbers its requests from zero.
    function test_lotteryRejectsAnswersToAbandonedRequestsFromAZeroBasedProvider() public {
        ZeroBasedRandomness zero = new ZeroBasedRandomness();
        vm.startPrank(gov);
        lottery.setRandomness(IRandomnessProvider(address(zero)));
        lottery.setConfig(address(nft), 0.01 ether, 1 days, true);
        vm.stopPrank();
        vm.prank(alice);
        uint256 roundId = lottery.buy{value: 0.1 ether}(address(nft), 10);
        skip(1 days);
        lottery.draw(roundId); // request 0
        skip(1 days);
        lottery.resetDraw(roundId);
        lottery.draw(roundId); // request 1

        vm.expectRevert(Lottery.StaleRequest.selector);
        zero.fulfill(0, 0);
        zero.fulfill(1, 0);
        assertEq(lottery.owedTo(alice), 0.095 ether);
        vm.expectRevert(Lottery.StaleRequest.selector);
        zero.fulfill(1, 0);
    }

    /// The floor recorded at unlock is capped, and a governance unlock clears it.
    function test_unlockFloorIsCappedAndClearedByGovernanceUnlock() public {
        uint256 vaultId = _holdingBoughtAt10();
        skip(180 days);
        _pushFloor(10_000 ether); // a pumped reading
        vault.unlock(vaultId);
        assertEq(vault.unlockFloorOf(vaultId), 208 ether); // 16 x the 13 ETH unlock price

        vm.startPrank(gov);
        vault.relock(vaultId, block.timestamp + 1 days);
        vault.governanceUnlock(vaultId);
        vm.stopPrank();
        assertEq(vault.unlockFloorOf(vaultId), 0);
    }

    function test_vrfAdapterRejectsALowCallbackGasLimit() public {
        ChainlinkVRFRandomness adapter =
            new ChainlinkVRFRandomness(gov, IVRFCoordinatorV2Plus(address(1)), games, bytes32(0), 1);
        vm.prank(gov);
        vm.expectRevert(ChainlinkVRFRandomness.CallbackGasTooLow.selector);
        adapter.setConfig(bytes32(0), 1, 3, 399_999, false);
    }

    /// A prediction market's fee and a raffle's minimum pot are fixed when they are created.
    function test_feeAndMinPotChangesDoNotReachOpenMarketsAndRaffles() public {
        _pushFloor(10 ether);
        uint256 marketId = prediction.createMarket(address(nft), 1 hours, 1 days);
        vm.prank(alice);
        prediction.placeBet{value: 1 ether}(marketId, true);
        vm.prank(bob);
        prediction.placeBet{value: 1 ether}(marketId, false);

        vm.startPrank(gov);
        ticketRaffle.setCollectionSupport(address(nft), true);
        vm.stopPrank();
        _mintApproved(alice, 1, address(ticketRaffle));
        vm.prank(alice);
        uint256 raffleId = ticketRaffle.create(address(nft), 1, 0.1 ether, 1, 10, 1 days);
        vm.prank(bob);
        ticketRaffle.buy{value: 0.1 ether}(raffleId, 1);

        vm.startPrank(gov);
        prediction.setParams(1_000, 0.001 ether, 1 days);
        ticketRaffle.setParams(500, 100 ether);
        vm.stopPrank();

        skip(1 days);
        _pushFloor(11 ether);
        prediction.resolve(marketId);
        uint256 before = alice.balance;
        vm.prank(alice);
        prediction.claim(marketId);
        assertEq(alice.balance - before, 1.97 ether); // still the 3% fee

        ticketRaffle.close(raffleId);
        (,,,,,,,,, TicketRaffle.Status status,) = ticketRaffle.raffles(raffleId);
        assertEq(uint8(status), uint8(TicketRaffle.Status.Drawing)); // 0.1 ETH pot still meets its own minimum
    }

    function test_saleRecorderMustBeAContract() public {
        vm.startPrank(gov);
        vm.expectRevert(BuybackEngine.NotAContract.selector);
        engine.setSaleRecorder(ISaleRecorder(address(0xdead)));
        vm.expectRevert(Marketplace.NotAContract.selector);
        marketplace.setSaleRecorder(ISaleRecorder(address(0xdead)));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ economics review

    /// Trading with oneself earns one point per unit of fee, not two.
    function test_selfTradeEarnsOnePointPerUnitOfFee() public {
        _mintApproved(alice, 1, address(marketplace));
        vm.startPrank(alice);
        uint256 id = marketplace.makeOffer{value: 10 ether}(address(nft), 1, block.timestamp + 1 days);
        marketplace.acceptOffer(id, 1, 0);
        vm.stopPrank();
        assertEq(points.pendingOf(alice), 0.2 ether * POINTS_RATE / 1 ether);
    }

    /// A draw needs a minimum of activated points, so a raffle cannot be taken by one freshly activated
    /// account while everyone else's points are still pending.
    function test_drawNeedsAMinimumOfActivatedPoints() public {
        uint256 raffleId = _openRaffle();
        vm.prank(gov);
        raffle.setMinPointsToDraw(5_000e18);
        _earn(bob, 1 ether); // 1,000 points activated
        skip(7 days);
        vm.expectRevert(abi.encodeWithSelector(VaultRaffle.BelowMinPoints.selector, 1_000e18, 5_000e18));
        raffle.draw(raffleId);

        _earn(carol, 4 ether);
        raffle.draw(raffleId);
    }

    /// One wager can be at most 1% of the bankroll, however small the house's exposure on it.
    function test_wagerIsCappedAgainstTheBankroll() public {
        games.fundBankroll{value: 100 ether}();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Games.WagerTooHigh.selector, 5 ether, 1 ether));
        games.play{value: 5 ether}(address(nft), 9_500); // exposure would be only 0.16 ETH
    }

    /// The owner can let the bankroll keep part of the edge to pay for the risk it carries.
    function test_bankrollCanKeepAShareOfTheEdge() public {
        games.fundBankroll{value: 100 ether}();
        assertEq(new Games(gov, treasury, randomness).bankrollShareBps(), 5_000); // the default
        vm.prank(gov);
        games.setRiskParams(100, 5_000);
        vm.prank(alice);
        uint256 id = games.play{value: 1 ether}(address(nft), 5_000);
        randomness.fulfill(id, 9_999); // loss
        // 0.02 ETH edge: half to the bankroll with the 0.98 ETH stake, half to buybacks
        assertEq(games.bankroll(), 100 ether + 0.98 ether + 0.01 ether);
        assertEq(treasury.budgetOf(address(nft)), 0.01 ether);
        assertEq(points.pendingOf(alice), 0.01 ether * POINTS_RATE / 1 ether);
        assertEq(address(games).balance, games.bankroll());
    }

    // ------------------------------------------------------------------ seventh review

    /// Aborting a round that has no randomness request must not disturb another round's live request,
    /// even with a provider that hands out the id zero.
    function test_abortOfARoundWithoutARequestLeavesOthersAlone() public {
        ZeroBasedRandomness zero = new ZeroBasedRandomness();
        vm.startPrank(gov);
        lottery.setRandomness(IRandomnessProvider(address(zero)));
        lottery.setConfig(address(nft), 0.01 ether, 1 days, true);
        address other = makeAddr("otherCollection");
        lottery.setConfig(other, 0.01 ether, 1 days, true);
        vm.stopPrank();

        vm.prank(carol);
        uint256 stale = lottery.buy{value: 0.01 ether}(other, 1); // never drawn
        skip(7 days);
        vm.prank(alice);
        uint256 live = lottery.buy{value: 0.1 ether}(address(nft), 10);
        skip(1 days);
        lottery.draw(live); // request 0

        lottery.abort(stale);
        zero.fulfill(0, 3); // still accepted
        assertEq(lottery.owedTo(alice), 0.095 ether);
    }
}

/// @dev A randomness provider that numbers its requests from zero.
contract ZeroBasedRandomness is IRandomnessProvider {
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

/// @dev An ERC-721 without ERC-2981 whose fallback accepts any call and returns nothing.
contract FallbackNFT is ERC721 {
    constructor() ERC721("Fallback", "FB") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    fallback() external {}
}
