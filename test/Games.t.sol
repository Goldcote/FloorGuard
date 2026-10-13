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

    function test_bankroll_canOnlyLeaveToTheTreasury() public {
        vm.prank(alice);
        vm.expectRevert();
        games.withdrawBankrollToTreasury(1 ether);

        vm.prank(gov);
        vm.expectRevert(Games.InsufficientBankroll.selector);
        games.withdrawBankrollToTreasury(1_001 ether);

        vm.prank(gov);
        games.withdrawBankrollToTreasury(400 ether);
        assertEq(games.bankroll(), 600 ether);
        assertEq(treasury.unallocated(), 400 ether);
    }

    function test_openBetsCannotBeDrainedByBankrollWithdrawal() public {
        _play(alice, 1 ether, 5_000);
        uint256 free = games.bankroll();
        vm.prank(gov);
        games.withdrawBankrollToTreasury(free);
        assertEq(address(games).balance, 1.98 ether); // the 1.96 ETH a win would pay plus the 0.02 ETH fee
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
