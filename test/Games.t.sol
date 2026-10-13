// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {Games} from "../src/Games.sol";
import {Treasury} from "../src/Treasury.sol";
import {RejectETH} from "./mocks/MockNFT.sol";

contract GamesTest is Base {
    function setUp() public override {
        super.setUp();
        games.fundBankroll{value: 1_000 ether}();
    }

    function _play(address who, uint256 wager, uint256 chanceBps) internal returns (uint256 requestId) {
        vm.prank(who);
        requestId = games.play{value: wager}(address(nft), chanceBps);
    }

    /// Everything the contract holds is bankroll, an open bet or owed winnings.
    function _assertAccounted(uint256 openBets, uint256 owed) internal view {
        assertEq(address(games).balance, games.bankroll() + openBets + owed + games.totalPendingDeposits());
    }

    function test_coinflip_winPaysFairOddsOnTheStakeAfterEdge() public {
        uint256 id = _play(alice, 1 ether, 5_000);
        // 2% edge leaves a 0.98 ETH stake; a fair coinflip pays 1.96 ETH, 0.98 of it from the house
        assertEq(games.bankroll(), 1_000 ether - 0.98 ether);
        _assertAccounted(1 ether + 0.98 ether, 0);

        uint256 before = alice.balance;
        randomness.fulfill(id, 4_999); // roll 4999 < 5000: win
        assertEq(alice.balance - before, 1.96 ether);
        assertEq(treasury.budgetOf(address(nft)), 0.02 ether);
        assertEq(games.bankroll(), 1_000 ether - 0.98 ether);
        assertEq(points.pendingOf(alice), 0.02 ether * POINTS_RATE / 1 ether);
        _assertAccounted(0, 0);
    }

    function test_coinflip_lossMovesStakeToBankrollAndEdgeToTreasury() public {
        uint256 id = _play(alice, 1 ether, 5_000);
        uint256 before = alice.balance;
        randomness.fulfill(id, 5_000); // roll 5000: loss
        assertEq(alice.balance, before);
        assertEq(games.bankroll(), 1_000 ether + 0.98 ether);
        assertEq(treasury.budgetOf(address(nft)), 0.02 ether);
        _assertAccounted(0, 0);
    }

    function test_dice_longShotPaysMore() public {
        (uint256 payout, uint256 fee) = games.quote(0.1 ether, 100); // 1% chance
        assertEq(fee, 0.002 ether);
        assertEq(payout, 9.8 ether);

        uint256 id = _play(alice, 0.1 ether, 100);
        uint256 before = alice.balance;
        randomness.fulfill(id, 10_000 * 7 + 99); // roll 99: win
        assertEq(alice.balance - before, 9.8 ether);
    }

    function test_play_validation() public {
        vm.startPrank(alice);
        vm.expectRevert(Games.UnsupportedCollection.selector);
        games.play{value: 1 ether}(makeAddr("other"), 5_000);
        vm.expectRevert(Games.InvalidChance.selector);
        games.play{value: 1 ether}(address(nft), 99);
        vm.expectRevert(Games.InvalidChance.selector);
        games.play{value: 1 ether}(address(nft), 9_501);
        vm.expectRevert(Games.BetTooSmall.selector);
        games.play{value: 0.0001 ether}(address(nft), 5_000);
        vm.stopPrank();
    }

    function test_play_capsHouseExposurePerBet() public {
        // the house may risk 1% of the bankroll: 10 ETH. A 1% roll of 0.2 ETH would risk 19.4 ETH.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Games.ExposureTooHigh.selector, 19.404 ether, 10 ether));
        games.play{value: 0.2 ether}(address(nft), 100);
    }

    function test_fulfill_onlyProviderAndOnlyOnce() public {
        uint256 id = _play(alice, 1 ether, 5_000);
        vm.prank(alice);
        vm.expectRevert(Games.NotRandomness.selector);
        games.fulfillRandomness(id, 0);

        randomness.fulfill(id, 0);
        vm.expectRevert(Games.UnknownBet.selector);
        randomness.fulfill(id, 0);
    }

    function test_refund_afterTimeoutReturnsWagerAndFreesExposure() public {
        uint256 id = _play(alice, 1 ether, 5_000);
        vm.expectRevert(abi.encodeWithSelector(Games.TooEarly.selector, block.timestamp + 6 hours));
        games.refund(id);

        skip(1 days);
        uint256 before = alice.balance;
        vm.prank(bob); // anyone may trigger it
        games.refund(id);
        assertEq(alice.balance - before, 1 ether);
        assertEq(games.bankroll(), 1_000 ether);
        assertEq(treasury.budgetOf(address(nft)), 0);
        _assertAccounted(0, 0);

        vm.expectRevert(Games.UnknownBet.selector);
        randomness.fulfill(id, 0); // a late answer is ignored
    }

    function test_win_toContractThatRejectsEthIsHeldForWithdrawal() public {
        address rejecter = address(new RejectETH());
        vm.deal(rejecter, 1 ether);
        uint256 id = _play(rejecter, 1 ether, 5_000);
        randomness.fulfill(id, 0);
        assertEq(games.owedTo(rejecter), 1.96 ether);
        _assertAccounted(0, 1.96 ether);

        vm.prank(alice);
        vm.expectRevert(Games.NothingOwed.selector);
        games.withdraw();
    }

    function test_house_depositMintsSharesAndRedeemPaysThemBack() public {
        // the test contract funded 1,000 ETH in setUp and holds every share
        uint256 shares = games.sharesOf(address(this));
        assertEq(shares, games.totalShares());
        assertEq(games.previewRedeem(shares), 1_000 ether);

        vm.prank(bob);
        uint256 bobShares = games.deposit{value: 100 ether}(0); // no bet open: converted at once
        assertEq(bobShares, games.sharesOf(bob));
        assertApproxEqAbs(games.previewRedeem(bobShares), 100 ether, 1e6);

        uint256 before = bob.balance;
        vm.prank(bob);
        uint256 paid = games.redeem(bobShares, 10, payable(bob)); // at most 0.1% under fair value
        assertApproxEqAbs(paid, 100 ether, 1e6);
        assertEq(bob.balance - before, paid);
        assertEq(games.sharesOf(bob), 0);
        _assertAccounted(0, 0);
    }

    function test_house_sharesGainWhenPlayersLoseAndFallWhenTheyWin() public {
        uint256 shares = games.sharesOf(address(this));
        uint256 id = _play(alice, 1 ether, 5_000);
        randomness.fulfill(id, 9_999); // alice loses: her 0.98 ETH stake joins the bankroll
        assertApproxEqAbs(games.previewRedeem(shares), 1_000.98 ether, 1e6);

        id = _play(alice, 1 ether, 5_000);
        randomness.fulfill(id, 0); // alice wins 0.98 ETH from the house
        assertApproxEqAbs(games.previewRedeem(shares), 1_000 ether, 1e6);
    }

    /// A deposit made while a bet is open waits for that bet, and is then priced after its result.
    function test_house_depositWaitsForOpenBetsAndIsPricedAfterThem() public {
        uint256 id = _play(alice, 10 ether, 5_000);

        // bob sees that alice is about to lose and deposits first
        vm.prank(bob);
        assertEq(games.deposit{value: 100 ether}(0), 0); // pending, not shares
        assertEq(games.pendingDepositOf(bob), 100 ether);
        assertEq(games.sharesOf(bob), 0);
        _assertAccounted(10 ether + 9.8 ether, 0);
        vm.prank(bob);
        vm.expectRevert(Games.BetsStillOpen.selector);
        games.executeDeposit(0);

        randomness.fulfill(id, 9_999); // the house wins 9.8 ETH
        vm.prank(bob);
        uint256 bobShares = games.executeDeposit(0);
        // bob bought in at the price after the win: his shares are worth what he paid, no more
        assertApproxEqAbs(games.previewRedeem(bobShares), 100 ether, 1e6);
        assertApproxEqAbs(games.previewRedeem(games.sharesOf(address(this))), 1_009.8 ether, 1e6);
    }

    /// A redemption requested while a bet is open waits for it too, so leaving before a known loss does
    /// not avoid the loss.
    function test_house_redeemWaitsForOpenBetsAndSharesTheirResult() public {
        vm.prank(carol);
        uint256 carolShares = games.deposit{value: 100 ether}(0);
        uint256 id = _play(alice, 10 ether, 5_000);

        // carol sees that alice is about to win and asks to leave first
        vm.prank(carol);
        assertEq(games.redeem(carolShares, 0, payable(carol)), 0); // pending
        vm.prank(carol);
        vm.expectRevert(Games.BetsStillOpen.selector);
        games.executeRedeem(0, payable(carol));

        randomness.fulfill(id, 0); // the house loses 9.8 ETH
        uint256 before = carol.balance;
        vm.prank(carol);
        games.executeRedeem(0, payable(carol));
        // she bears her eleventh of the loss
        assertApproxEqAbs(carol.balance - before, 100 ether - uint256(9.8 ether) * 100 / 1_100, 1e6);
    }

    /// A request left standing is not a free option on later bets: carried out while bets are open, a
    /// deposit is priced as if the house wins them all and a redemption as if it loses them all.
    function test_house_standingRequestIsNotAFreeOption() public {
        vm.prank(carol);
        uint256 carolShares = games.deposit{value: 1_000 ether}(0); // carol is half the house
        uint256 first = _play(alice, 1 ether, 5_000);
        vm.prank(carol);
        games.redeem(carolShares, 0, payable(carol)); // a request, armed behind one small bet
        vm.prank(bob);
        games.deposit{value: 100 ether}(0); // and bob arms a deposit
        randomness.fulfill(first, 9_999);

        // later, a large bet is open and both can see its result coming
        uint256 big = _play(alice, 15 ether, 5_000);
        uint256 fair = games.shareValue(carolShares);

        // carol knows alice will win: leaving now pays as if the house had already lost
        assertApproxEqAbs(games.previewRedeem(carolShares), fair - uint256(14.7 ether) / 2, 1e9);
        // bob knows the house will win: joining now is priced as if it had already won, and more
        assertLt(
            games.previewDeposit(100 ether), games.totalShares() * 100 ether / (2_000.98 ether + 14.7 ether)
        );

        // once the bet has closed, the same requests go through at the full value
        randomness.fulfill(big, 9_999);
        assertEq(games.previewRedeem(carolShares), games.shareValue(carolShares));
    }

    /// The last holder cannot leave while bets are open, so nothing set aside for them is left
    /// without an owner.
    function test_house_lastHolderWaitsForOpenBets() public {
        uint256 all = games.sharesOf(address(this));
        uint256 first = _play(alice, 1 ether, 5_000);
        games.redeem(all, 0, payable(bob)); // waits for the open bet
        randomness.fulfill(first, 9_999);

        uint256 later = _play(alice, 1 ether, 5_000);
        vm.expectRevert(Games.BetsStillOpen.selector);
        games.executeRedeem(0, payable(bob));

        randomness.fulfill(later, 9_999);
        uint256 before = bob.balance;
        games.executeRedeem(0, payable(bob));
        assertApproxEqAbs(bob.balance - before, 1_001.96 ether, 1e9);
        assertEq(games.totalShares(), 0);
        assertLt(games.bankroll(), 1e9);
    }

    /// The record of closed bets keeps up by itself, so a request made after a long run of bets goes
    /// through at once.
    function test_house_requestAfterALongRunOfBetsGoesThroughAtOnce() public {
        for (uint256 i; i < 600; ++i) {
            uint256 id = _play(alice, 0.01 ether, 5_000);
            randomness.fulfill(id, i);
        }
        assertEq(games.closedThrough(), games.placedCount());
        vm.prank(bob);
        assertGt(games.deposit{value: 10 ether}(0), 0);
    }

    /// The spread a requester tolerates is checked on chain against fair value at that moment.
    function test_house_spreadToleranceIsEnforcedOnChain() public {
        vm.prank(carol);
        uint256 carolShares = games.deposit{value: 1_000 ether}(0);
        uint256 first = _play(alice, 1 ether, 5_000);
        vm.prank(carol);
        assertEq(games.redeem(carolShares, 100, payable(carol)), 0); // waits for the open bet
        randomness.fulfill(first, 9_999);

        // someone locks up funds with long shots in front of her
        for (uint256 i; i < 5; ++i) {
            _play(alice, 0.1 ether, 100);
        }
        vm.startPrank(carol);
        vm.expectRevert(Games.SlippageExceeded.selector);
        games.executeRedeem(100, payable(carol)); // more than 1% would be given up: refused
        uint256 fair = games.shareValue(carolShares);
        uint256 paid = games.executeRedeem(500, payable(carol)); // she accepts up to 5%
        vm.stopPrank();
        assertGe(paid, fair * 95 / 100);
        assertLt(paid, fair);
    }

    /// Open wagers are capped against the house's funds, which bounds what a deposit carried out with
    /// bets open can give up.
    function test_openWagersAreCapped() public {
        uint256 placed;
        vm.startPrank(alice);
        while (true) {
            (bool ok,) =
                address(games).call{value: 9 ether}(abi.encodeCall(Games.play, (address(nft), 9_500)));
            if (!ok) break;
            ++placed;
        }
        vm.stopPrank();
        assertGt(placed, 15);
        assertLe(games.openWagers(), (games.bankroll() + games.reserved()) / 5);
        // a deposit carried out now gives up at most a sixth
        assertGe(games.previewDeposit(60 ether) * 6, games.totalShares() * 60 ether * 5 / 1_000 ether - 1e12);
    }

    /// After a refund no bet is accepted for ten minutes, so a table kept full with free bets while
    /// randomness is down has to empty.
    function test_betsPauseAfterARefund() public {
        uint256 id = _play(alice, 1 ether, 5_000);
        skip(6 hours);
        games.refund(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Games.BetsPaused.selector, block.timestamp + 10 minutes));
        games.play{value: 1 ether}(address(nft), 5_000);
        assertEq(games.reserved(), 0); // a moment with nothing open: requests go through at fair value
        skip(10 minutes);
        _play(alice, 1 ether, 5_000);
    }

    /// A holding too small to be redeemed on its own is taken along with the rest.
    function test_house_dustRemainderIsRedeemedWithTheRest() public {
        vm.startPrank(bob);
        uint256 shares = games.deposit{value: 10 ether}(0);
        games.redeem(shares - 2, 0, payable(bob));
        vm.stopPrank();
        assertEq(games.sharesOf(bob), 0);
    }

    function test_refundMany_skipsBetsThatAreNotRefundable() public {
        uint256 a = _play(alice, 1 ether, 5_000);
        uint256 b = _play(alice, 1 ether, 5_000);
        skip(1 days);
        uint256 c = _play(alice, 1 ether, 5_000); // not late yet
        uint256[] memory ids = new uint256[](4);
        ids[0] = a;
        ids[1] = b;
        ids[2] = c;
        ids[3] = 999; // unknown
        uint256 before = alice.balance;
        games.refundMany(ids);
        assertEq(alice.balance - before, 2 ether);
        assertEq(games.openWagers(), 1 ether);
    }

    function test_house_cancelAndValidation() public {
        uint256 id = _play(alice, 1 ether, 5_000);
        vm.startPrank(bob);
        games.deposit{value: 10 ether}(0);
        uint256 before = bob.balance;
        games.cancelDeposit();
        assertEq(bob.balance - before, 10 ether);
        vm.expectRevert(Games.NothingPending.selector);
        games.cancelDeposit();
        vm.expectRevert(Games.NothingPending.selector);
        games.executeDeposit(0);
        vm.expectRevert(Games.InsufficientShares.selector);
        games.redeem(1, 0, payable(bob));
        vm.expectRevert(Games.NothingPending.selector);
        games.cancelRedeem();
        vm.stopPrank();
        randomness.fulfill(id, 0);

        vm.prank(bob);
        vm.expectRevert(Games.InvalidParams.selector);
        games.deposit{value: 1 ether}(10_001); // more than 100% is not a spread
    }

    function test_house_openBetsStayFundedWhenHoldersLeave() public {
        _play(alice, 1 ether, 5_000);
        // the request is made after the bet and waits for it; the bet's payout stays set aside
        assertEq(games.redeem(games.sharesOf(address(this)), 0, payable(bob)), 0);
        assertEq(games.reserved(), 0.98 ether);
        _assertAccounted(1.98 ether, 0);
    }

    /// Bets that close out of order still release the requests waiting on them, and no earlier.
    function test_house_requestsFollowBetsClosingOutOfOrder() public {
        uint256 first = _play(alice, 1 ether, 5_000);
        uint256 second = _play(alice, 1 ether, 5_000);
        vm.prank(bob);
        games.deposit{value: 10 ether}(0);
        uint256 third = _play(alice, 1 ether, 5_000); // placed after the request: does not hold it up

        randomness.fulfill(second, 9_999);
        vm.prank(bob);
        vm.expectRevert(Games.BetsStillOpen.selector);
        games.executeDeposit(0);
        randomness.fulfill(first, 9_999);
        // the later bet is still open: at zero tolerance the deposit waits, with some it goes through
        vm.prank(bob);
        vm.expectRevert(Games.SlippageExceeded.selector);
        games.executeDeposit(0);
        vm.prank(bob);
        assertGt(games.executeDeposit(100), 0);
        randomness.fulfill(third, 9_999);
    }

    /// Whatever depositors, redeemers and players do, holders can never take out more than the house
    /// has, and the contract always holds what it owes.
    function testFuzz_house_accounting(uint64 dep, uint64 wager, uint256 word, bool requestWhileOpen) public {
        uint256 d = bound(dep, 1e9, 500 ether);
        uint256 w = bound(wager, 0.001 ether, 5 ether);
        uint256 bobShares;
        if (!requestWhileOpen) {
            vm.prank(bob);
            bobShares = games.deposit{value: d}(0);
        }
        uint256 id = _play(alice, w, 5_000);
        if (requestWhileOpen) {
            vm.prank(bob);
            games.deposit{value: d}(0);
        }
        randomness.fulfill(id, word);
        if (requestWhileOpen) {
            vm.prank(bob);
            bobShares = games.executeDeposit(0);
        }
        vm.prank(bob);
        games.redeem(bobShares, 0, payable(bob));
        games.redeem(games.sharesOf(address(this)), 0, payable(address(0xBEEF)));
        assertEq(games.reserved(), 0);
        assertEq(games.openWagers(), 0);
        assertEq(games.totalPendingDeposits(), 0);
        assertEq(address(games).balance, games.bankroll());
        assertLt(games.bankroll(), 1e9); // only rounding dust is left for the virtual shares
    }

    function test_setParams_caps() public {
        vm.startPrank(gov);
        vm.expectRevert(Games.InvalidParams.selector);
        games.setParams(1_001, 0, 100);
        vm.expectRevert(Games.InvalidParams.selector);
        games.setParams(200, 0, 10_001);
        vm.stopPrank();
    }

    /// Whatever the bets and outcomes, the contract holds exactly bankroll plus what it owes, and the
    /// house's gain or loss plus the treasury's fees equals the players' net loss or gain.
    function testFuzz_accounting(uint64[6] memory wagers, uint16[6] memory chances, uint256[6] memory words)
        public
    {
        uint256 playersBefore = alice.balance;
        for (uint256 i; i < 6; ++i) {
            uint256 wager = bound(wagers[i], 0.001 ether, 0.1 ether);
            uint256 chance = bound(chances[i], 100, 9_500);
            uint256 id = _play(alice, wager, chance);
            randomness.fulfill(id, words[i]);
        }
        _assertAccounted(0, 0);
        uint256 fees = treasury.budgetOf(address(nft));
        assertEq(playersBefore + 1_000 ether, alice.balance + games.bankroll() + fees);
    }
}

contract SlotsTest is Base {
    function setUp() public override {
        super.setUp();
        games.fundBankroll{value: 1_000 ether}();
    }

    function _spin(uint256 wager, uint256 word) internal returns (uint256 paid) {
        vm.prank(alice);
        uint256 id = games.spin{value: wager}(address(nft));
        uint256 before = alice.balance;
        randomness.fulfill(id, word);
        return alice.balance - before;
    }

    function test_payTableAveragesExactlyOneTimesTheStake() public view {
        uint256 total;
        for (uint256 roll; roll < 10_000; ++roll) {
            total += games.slotsMultiplier(roll);
        }
        assertEq(total, 10_000);
        assertEq(games.slotsMultiplier(0), 50);
        assertEq(games.slotsMultiplier(19), 50);
        assertEq(games.slotsMultiplier(20), 10);
        assertEq(games.slotsMultiplier(120), 5);
        assertEq(games.slotsMultiplier(520), 2);
        assertEq(games.slotsMultiplier(2_020), 1);
        assertEq(games.slotsMultiplier(5_020), 0);
    }

    function test_spin_reservesTheJackpotAndPaysByTheTable() public {
        vm.prank(alice);
        uint256 id = games.spin{value: 0.1 ether}(address(nft));
        // stake 0.098 ETH after the 2% edge; the house sets aside 49 stakes for a 50x jackpot
        assertEq(games.reserved(), 0.098 ether * 49);
        assertEq(games.bankroll(), 1_000 ether - 0.098 ether * 49);

        uint256 before = alice.balance;
        randomness.fulfill(id, 0); // jackpot
        assertEq(alice.balance - before, 4.9 ether);
        assertEq(games.reserved(), 0);
        assertEq(games.bankroll(), 1_000 ether + 0.098 ether - 4.9 ether);
        assertEq(treasury.budgetOf(address(nft)), 0.002 ether);
        assertEq(address(games).balance, games.bankroll());
    }

    function test_spin_eachTier() public {
        assertEq(_spin(0.1 ether, 100), 0.98 ether); // 10x
        assertEq(_spin(0.1 ether, 500), 0.49 ether); // 5x
        assertEq(_spin(0.1 ether, 2_000), 0.196 ether); // 2x
        assertEq(_spin(0.1 ether, 5_000), 0.098 ether); // 1x: the stake back, less the edge already taken
        assertEq(_spin(0.1 ether, 9_999), 0); // nothing
        assertEq(address(games).balance, games.bankroll());
        assertEq(treasury.budgetOf(address(nft)), 0.01 ether);
    }

    function test_spin_limitsAndValidation() public {
        // the jackpot may risk 1% of the bankroll (10 ETH): a 0.3 ETH spin would risk 14.4 ETH
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Games.ExposureTooHigh.selector, 0.294 ether * 49, 10 ether));
        games.spin{value: 0.3 ether}(address(nft));

        vm.prank(alice);
        vm.expectRevert(Games.BetTooSmall.selector);
        games.spin{value: 0.0001 ether}(address(nft));
        vm.prank(alice);
        vm.expectRevert(Games.UnsupportedCollection.selector);
        games.spin{value: 0.1 ether}(makeAddr("other"));
    }

    function test_spin_refundAfterTimeout() public {
        vm.prank(alice);
        uint256 id = games.spin{value: 0.1 ether}(address(nft));
        skip(1 days);
        uint256 before = alice.balance;
        games.refund(id);
        assertEq(alice.balance - before, 0.1 ether);
        assertEq(games.bankroll(), 1_000 ether);
    }

    /// Dice and slots mixed: every wei stays accounted for whatever the rolls.
    function testFuzz_mixedGamesAccounting(
        uint64[6] memory wagers,
        bool[6] memory slots,
        uint256[6] memory words
    ) public {
        uint256 before = alice.balance;
        for (uint256 i; i < 6; ++i) {
            uint256 wager = bound(wagers[i], 0.001 ether, 0.05 ether);
            vm.prank(alice);
            uint256 id = slots[i]
                ? games.spin{value: wager}(address(nft))
                : games.play{value: wager}(address(nft), 5_000);
            randomness.fulfill(id, words[i]);
        }
        assertEq(games.reserved(), 0);
        assertEq(address(games).balance, games.bankroll());
        assertEq(before + 1_000 ether, alice.balance + games.bankroll() + treasury.budgetOf(address(nft)));
    }
}

contract ProjectShareTest is Base {
    address internal project = makeAddr("project");

    function test_feesAreSplitBetweenProjectAndBuybackBudget() public {
        vm.prank(gov);
        treasury.setProjectShare(address(nft), project, 2_500); // 25% of fees to the project

        _mintApproved(alice, 1, address(marketplace));
        vm.prank(bob);
        uint256 id = marketplace.makeOffer{value: 10 ether}(address(nft), 1, block.timestamp + 1 days);
        vm.prank(alice);
        marketplace.acceptOffer(id, 1, 0);

        // 0.2 ETH fee: 0.05 to the project, 0.15 to buybacks
        assertEq(treasury.owedTo(project), 0.05 ether);
        assertEq(treasury.budgetOf(address(nft)), 0.15 ether);

        vm.prank(project);
        treasury.claimProjectShare();
        assertEq(project.balance, 0.05 ether);
        assertEq(treasury.totalOwed(), 0);
        vm.prank(project);
        vm.expectRevert(Treasury.NothingOwed.selector);
        treasury.claimProjectShare();
    }

    function test_recycledCapitalIsNotSplit() public {
        vm.prank(gov);
        treasury.setProjectShare(address(nft), project, 2_500);
        treasury.deposit{value: 10 ether}(address(nft)); // e.g. auction proceeds
        assertEq(treasury.budgetOf(address(nft)), 10 ether);
        assertEq(treasury.owedTo(project), 0);
    }

    function test_shareIsCappedAndOwnerOnly() public {
        vm.prank(gov);
        vm.expectRevert(Treasury.InvalidShare.selector);
        treasury.setProjectShare(address(nft), project, 5_001);
        vm.prank(gov);
        vm.expectRevert(Treasury.InvalidShare.selector);
        treasury.setProjectShare(address(nft), address(0), 100);
        vm.prank(alice);
        vm.expectRevert();
        treasury.setProjectShare(address(nft), project, 100);
    }
}
