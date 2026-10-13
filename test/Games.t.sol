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
        assertEq(address(games).balance, games.bankroll() + openBets + owed);
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
        vm.expectRevert(abi.encodeWithSelector(Games.TooEarly.selector, block.timestamp + 1 days));
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
        uint256 bobShares = games.deposit{value: 100 ether}(0);
        assertApproxEqAbs(games.previewRedeem(bobShares), 100 ether, 1e6);

        uint256 before = bob.balance;
        vm.prank(bob);
        games.redeem(bobShares, 99.99 ether, payable(bob));
        assertApproxEqAbs(bob.balance - before, 100 ether, 1e6);
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

    /// A deposit is priced as if the house wins every open bet, and a redemption as if it loses them
    /// all, so neither can be timed around a result seen in advance.
    function test_house_cannotBeTimedAroundAKnownResult() public {
        uint256 id = _play(alice, 10 ether, 5_000); // 9.8 ETH stake, 9.8 ETH of house money at risk

        // bob sees that alice is about to lose and deposits first
        vm.prank(bob);
        uint256 bobShares = games.deposit{value: 100 ether}(0);
        randomness.fulfill(id, 9_999);
        assertLe(games.previewRedeem(bobShares), 100 ether); // he bought in at the post-win price

        // carol holds shares and sees that alice is about to win; redeeming first gains her nothing
        vm.prank(carol);
        uint256 carolShares = games.deposit{value: 100 ether}(0);
        id = _play(alice, 10 ether, 5_000);
        uint256 beforeLoss = games.previewRedeem(carolShares);
        randomness.fulfill(id, 0);
        assertLe(beforeLoss, games.previewRedeem(carolShares) + 1e6); // she would have got no more by leaving early
    }

    function test_house_redeemValidationAndSlippage() public {
        vm.prank(bob);
        uint256 bobShares = games.deposit{value: 10 ether}(0);
        vm.startPrank(bob);
        vm.expectRevert(Games.InsufficientShares.selector);
        games.redeem(bobShares + 1, 0, payable(bob));
        vm.expectRevert(Games.SlippageExceeded.selector);
        games.redeem(bobShares, 11 ether, payable(bob));
        vm.expectRevert(Games.SlippageExceeded.selector);
        games.deposit{value: 1 ether}(type(uint256).max);
        vm.stopPrank();
    }

    function test_house_openBetsStayFundedWhenEveryoneRedeems() public {
        _play(alice, 1 ether, 5_000);
        games.redeem(games.sharesOf(address(this)), 0, payable(bob));
        assertEq(address(games).balance, 1.98 ether); // the 1.96 ETH a win would pay plus the 0.02 ETH fee
        assertEq(games.reserved(), 0.98 ether);
    }

    /// Whatever depositors, redeemers and players do, the first depositor cannot be robbed by share
    /// price games and the contract always holds what it owes.
    function testFuzz_house_sharesNeverPayOutMoreThanTheBankroll(
        uint64 dep,
        uint64 wager,
        uint256 word,
        bool bobFirst
    ) public {
        uint256 d = bound(dep, 1e9, 500 ether);
        uint256 w = bound(wager, 0.001 ether, 5 ether);
        vm.prank(bob);
        uint256 bobShares = games.deposit{value: d}(0);
        uint256 id = _play(alice, w, 5_000);
        if (bobFirst) {
            vm.prank(bob);
            games.redeem(bobShares, 0, payable(bob));
        }
        randomness.fulfill(id, word);
        if (!bobFirst) {
            vm.prank(bob);
            games.redeem(bobShares, 0, payable(bob));
        }
        games.redeem(games.sharesOf(address(this)), 0, payable(address(0xBEEF)));
        assertEq(games.reserved(), 0);
        assertEq(games.openWagers(), 0);
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
