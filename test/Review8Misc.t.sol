// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";
import {Games} from "../src/Games.sol";
import {VaultRaffle} from "../src/VaultRaffle.sol";

/// @dev Review 8, question G: points, prediction markets, the games limits and the raffle minimum.
contract Review8MiscTest is Base {
    address internal C;

    function setUp() public override {
        super.setUp();
        C = address(nft);
        vm.deal(address(this), 100_000 ether);
    }

    // ------------------------------------------------------------------ points: the halved credit

    function _trade(address seller, address buyer, uint256 price, uint256 tokenId) internal {
        vm.prank(buyer);
        uint256 offerId = marketplace.makeCollectionOffer{value: price}(C, 1, block.timestamp + 1 days);
        _mintApproved(seller, tokenId, address(marketplace));
        vm.prank(seller);
        marketplace.acceptOffer(offerId, tokenId, 0);
    }

    /// An odd fee: the seller gets the lower half, the offerer the upper half, nothing is lost.
    function test_G_marketplace_oddFee() public {
        uint256 price = 1 ether + 50; // 2% fee = 0.02 ETH + 1 wei
        uint256 fee = price * 200 / 10_000;
        assertEq(fee % 2, 1);
        _trade(alice, bob, price, 1);
        assertEq(points.pendingOf(alice), (fee / 2) * 2_500);
        assertEq(points.pendingOf(bob), (fee - fee / 2) * 2_500);
        assertEq(points.pendingOf(alice) + points.pendingOf(bob), fee * 2_500);
    }

    /// Trading with oneself earns exactly one fee's worth, and splitting a trade into small ones does
    /// not earn more: the odd wei always goes to the offerer, never to both.
    function test_G_marketplace_washAndSplitting() public {
        uint256 price = 1 ether + 50;
        _trade(alice, alice, price, 1);
        assertEq(points.pendingOf(alice), (price * 200 / 10_000) * 2_500);

        // 100 trades of 50 wei: a fee of one wei each, all of it to the offerer
        uint256 before = points.pendingOf(carol);
        for (uint256 i; i < 100; ++i) {
            _trade(bob, carol, 50, 100 + i);
        }
        assertEq(points.pendingOf(bob), 0);
        assertEq(points.pendingOf(carol) - before, 100 * 2_500); // 100 wei of fees in total
    }

    function testFuzz_G_marketplace_creditNeverExceedsFee(uint96 price, uint16 share) public {
        price = uint96(bound(price, 1, 1_000 ether));
        vm.prank(gov);
        treasury.setProjectShare(C, carol, uint16(bound(share, 0, 5_000)));
        uint256 budgetBefore = treasury.budgetOf(C);
        vm.deal(bob, price);
        _trade(alice, bob, price, 1);
        uint256 toBudget = treasury.budgetOf(C) - budgetBefore;
        assertEq(points.pendingOf(alice) + points.pendingOf(bob), toBudget * 2_500);
        assertLe(points.pendingOf(alice), points.pendingOf(bob));
    }

    /// Prediction market: the points of all claimers add up to the fees that reached the budget, to
    /// within rounding.
    function testFuzz_G_prediction_pointsAddUpToFees(uint64 a, uint64 b, uint64 c, uint16 share) public {
        vm.prank(gov);
        treasury.setProjectShare(C, makeAddr("project"), uint16(bound(share, 0, 5_000)));
        _pushFloor(10 ether);
        uint256 id = prediction.createMarket(C, 1 hours, 10 hours);
        uint256 sa = bound(a, 0.001 ether, 100 ether);
        uint256 sb = bound(b, 0.001 ether, 100 ether);
        uint256 sc = bound(c, 0.001 ether, 100 ether);
        vm.prank(alice);
        prediction.placeBet{value: sa}(id, true);
        vm.prank(bob);
        prediction.placeBet{value: sb}(id, false);
        vm.prank(carol);
        prediction.placeBet{value: sc}(id, false);
        vm.prank(carol);
        prediction.placeBet{value: sc}(id, true); // carol is on both sides
        skip(10 hours);
        _pushFloor(11 ether);
        prediction.resolve(id);
        vm.prank(alice);
        prediction.claim(id);
        vm.prank(bob);
        prediction.claim(id);
        vm.prank(carol);
        prediction.claim(id);

        uint256 credited = points.pendingOf(alice) + points.pendingOf(bob) + points.pendingOf(carol);
        uint256 toBudget = treasury.budgetOf(C);
        // INFO I-2: a claimer on both sides has the losing half of the credit scaled by toBudget / fee of
        // the winning half, so its rounding is magnified by lost / fee. Seen: 28 wei of fee too much
        // on 0.0137 ETH. Never more than a billionth here.
        assertLe(credited, toBudget * 2_500 + toBudget * 2_500 / 1e9 + 10 * 2_500);
        assertGe(credited + toBudget * 2_500 / 1e9 + 10 * 2_500, toBudget * 2_500);
    }

    // ------------------------------------------------------------------ prediction: the dead band

    function _outcome(uint256 start, uint256 end) internal returns (PredictionMarket.Outcome outcome) {
        _pushFloor(start);
        uint256 id = prediction.createMarket(C, 10 minutes, 100 minutes);
        vm.prank(alice);
        prediction.placeBet{value: 1 ether}(id, true);
        vm.prank(bob);
        prediction.placeBet{value: 1 ether}(id, false);
        skip(100 minutes);
        _pushFloor(end);
        prediction.resolve(id);
        (,,,,,, outcome) = prediction.markets(id);
    }

    function test_G_deadBand_boundaries() public {
        // exactly 2% decides, one wei less is void, in both directions
        assertEq(uint8(_outcome(100 ether, 102 ether)), uint8(PredictionMarket.Outcome.Higher));
        assertEq(uint8(_outcome(100 ether, 102 ether - 1)), uint8(PredictionMarket.Outcome.Void));
        assertEq(uint8(_outcome(100 ether, 98 ether)), uint8(PredictionMarket.Outcome.Lower));
        assertEq(uint8(_outcome(100 ether, 98 ether + 1)), uint8(PredictionMarket.Outcome.Void));
        assertEq(uint8(_outcome(100 ether, 100 ether)), uint8(PredictionMarket.Outcome.Void));
    }

    /// Tiny start prices: one wei is at least 2% of anything up to 50 wei, so the band stops mattering
    /// there, which is right in proportion. No rounding makes a sub-band move count.
    function test_G_deadBand_tinyPrices() public {
        assertEq(uint8(_outcome(1, 2)), uint8(PredictionMarket.Outcome.Higher));
        assertEq(uint8(_outcome(50, 51)), uint8(PredictionMarket.Outcome.Higher)); // 2.00%
        assertEq(uint8(_outcome(51, 52)), uint8(PredictionMarket.Outcome.Void)); // 1.96%
        assertEq(uint8(_outcome(51, 50)), uint8(PredictionMarket.Outcome.Void));
        assertEq(uint8(_outcome(51, 49)), uint8(PredictionMarket.Outcome.Lower)); // 3.9%
    }

    function test_G_deadBand_zeroAndMax() public {
        vm.startPrank(gov);
        vm.expectRevert(PredictionMarket.TooHigh.selector);
        prediction.setMarketRules(1_001, 1 hours);
        prediction.setMarketRules(0, 1 hours);
        vm.stopPrank();
        assertEq(uint8(_outcome(100 ether, 100 ether + 1)), uint8(PredictionMarket.Outcome.Higher));
        assertEq(uint8(_outcome(100 ether, 100 ether)), uint8(PredictionMarket.Outcome.Void));
    }

    /// The band is fixed per market when it is created.
    function test_G_deadBand_fixedAtCreation() public {
        _pushFloor(100 ether);
        uint256 id = prediction.createMarket(C, 10 minutes, 100 minutes);
        vm.prank(alice);
        prediction.placeBet{value: 1 ether}(id, true);
        vm.prank(bob);
        prediction.placeBet{value: 1 ether}(id, false);
        vm.prank(gov);
        prediction.setMarketRules(0, 1 hours);
        skip(100 minutes);
        _pushFloor(101 ether);
        prediction.resolve(id);
        (,,,,,, PredictionMarket.Outcome outcome) = prediction.markets(id);
        assertEq(uint8(outcome), uint8(PredictionMarket.Outcome.Void));
    }

    // ------------------------------------------------------------------ prediction: durations

    function test_G_durationLimits() public {
        _pushFloor(10 ether);
        vm.expectRevert(PredictionMarket.InvalidDuration.selector);
        prediction.createMarket(C, 10 minutes - 1, 30 days);
        vm.expectRevert(PredictionMarket.InvalidDuration.selector);
        prediction.createMarket(C, 10 minutes, 100 minutes - 1);
        prediction.createMarket(C, 10 minutes, 100 minutes); // the shortest market
        prediction.createMarket(C, 3 days, 30 days); // the longest betting period
        vm.expectRevert(PredictionMarket.InvalidDuration.selector);
        prediction.createMarket(C, 3 days + 1, 30 days);
        vm.expectRevert(PredictionMarket.InvalidDuration.selector);
        prediction.createMarket(C, 10 minutes, 30 days + 1);
    }

    // ------------------------------------------------------------------ prediction: start price age

    function test_G_startPriceAge() public {
        _pushFloor(10 ether);
        skip(1 hours);
        prediction.createMarket(C, 10 minutes, 100 minutes); // exactly one hour old: accepted
        skip(1);
        vm.expectRevert(PredictionMarket.OracleUnavailable.selector);
        prediction.createMarket(C, 10 minutes, 100 minutes);

        // a start-price age longer than maxOracleAge has no effect: the shorter of the two applies
        vm.prank(gov);
        prediction.setMarketRules(200, 30 days);
        _pushFloor(10 ether);
        skip(1 days);
        prediction.createMarket(C, 10 minutes, 100 minutes);
        skip(1);
        vm.expectRevert(PredictionMarket.OracleUnavailable.selector);
        prediction.createMarket(C, 10 minutes, 100 minutes);

        // zero means "published in this very block"
        vm.prank(gov);
        prediction.setMarketRules(200, 0);
        _pushFloor(10 ether);
        prediction.createMarket(C, 10 minutes, 100 minutes);
        skip(1);
        vm.expectRevert(PredictionMarket.OracleUnavailable.selector);
        prediction.createMarket(C, 10 minutes, 100 minutes);
    }

    /// FINDING I-3. With the sales oracle, `updatedAt` is the time of the newest sale, not of the
    /// median. One fresh sale at any price makes a six-day-old median pass the one-hour check.
    function test_G_startPriceAge_salesOracleMedianCanBeOld() public {
        vm.prank(gov);
        prediction.setOracle(salesOracle);
        for (uint256 i; i < 3; ++i) {
            _trade(alice, bob, 10 ether, 1 + i);
        }
        skip(6 days);
        vm.expectRevert(PredictionMarket.OracleUnavailable.selector);
        prediction.createMarket(C, 10 minutes, 100 minutes);
        _trade(alice, alice, 1, 10); // a one-wei trade with oneself
        uint256 id = prediction.createMarket(C, 10 minutes, 100 minutes);
        (, uint128 startPrice,,,,,) = prediction.markets(id);
        assertEq(startPrice, 10 ether); // the price of sales made six days ago
    }

    // ------------------------------------------------------------------ games: the wager cap

    /// Below a bankroll of minBet / maxWagerBps (0.1 ETH at the defaults) no bet of any kind is
    /// accepted: a bet at the minimum is "too high" and anything smaller is "too small".
    function test_G_games_unplayableBelowTenthOfAnEther() public {
        vm.prank(gov);
        games.setRiskParams(100, 5_000);
        games.fundBankroll{value: 0.0999 ether}();
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Games.WagerTooHigh.selector, 0.001 ether, 0.000999 ether));
        games.play{value: 0.001 ether}(C, 9_500);
        vm.expectRevert(Games.BetTooSmall.selector);
        games.play{value: 0.000999 ether}(C, 9_500);
        vm.stopPrank();

        games.fundBankroll{value: 0.0001 ether}();
        vm.prank(alice);
        games.play{value: 0.001 ether}(C, 5_000);
        // the cap is on the FREE bankroll: the first open bet takes the game below the threshold again
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Games.WagerTooHigh.selector, 0.001 ether, 0.0009902 ether));
        games.play{value: 0.001 ether}(C, 5_000);
    }

    function test_G_games_wagerCapClosesTheNearCertainBet() public {
        vm.prank(gov);
        games.setRiskParams(100, 5_000);
        games.fundBankroll{value: 100 ether}();
        // before the cap a 95% bet could stake 19 ETH for an exposure of 0.98 ETH
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Games.WagerTooHigh.selector, 1 ether + 1, 1 ether));
        games.play{value: 1 ether + 1}(C, 9_500);
        vm.prank(alice);
        games.play{value: 1 ether}(C, 9_500);
    }

    /// The bankroll's share is read when the bet settles, not when it is placed, unlike the edge.
    function test_G_games_shareIsNotFixedWithTheBet() public {
        games.fundBankroll{value: 100 ether}();
        vm.prank(gov);
        games.setRiskParams(100, 0);
        vm.prank(alice);
        uint256 id = games.play{value: 1 ether}(C, 5_000);
        vm.prank(gov);
        games.setRiskParams(100, 10_000);
        randomness.fulfill(id, 9_999);
        assertEq(treasury.budgetOf(C), 0); // the whole edge stayed in the bankroll
        assertEq(points.pendingOf(alice), 0); // and the player earned no points
        assertEq(games.bankroll(), 101 ether);
    }

    function testFuzz_G_games_shareAccounting(
        uint96 wager,
        uint16 share,
        uint16 edge,
        uint16 chance,
        uint256 word
    ) public {
        games.fundBankroll{value: 10_000 ether}();
        share = uint16(bound(share, 0, 10_000));
        vm.startPrank(gov);
        games.setRiskParams(10_000, share);
        games.setParams(bound(edge, 0, 1_000), 1, 10_000);
        vm.stopPrank();
        uint256 w = bound(wager, 1, 1 ether);
        uint256 c = bound(chance, 100, 9_500);
        vm.deal(alice, w);
        uint256 bankrollBefore = games.bankroll();
        vm.prank(alice);
        uint256 id = games.play{value: w}(C, c);
        randomness.fulfill(id, word);

        uint256 fee = w * games.edgeBps() / 10_000;
        uint256 kept = fee * share / 10_000;
        bool won = word % 10_000 < c;
        uint256 payout = won ? (w - fee) * 10_000 / c : 0;
        assertEq(treasury.budgetOf(C), fee - kept);
        assertEq(games.bankroll(), bankrollBefore + (w - fee) + kept - (won ? payout : 0));
        assertEq(address(games).balance, games.bankroll());
        assertEq(games.reserved(), 0);
    }

    // ------------------------------------------------------------------ raffle: the minimum

    function _prize(uint256 tokenId) internal returns (uint256 raffleId) {
        vm.prank(gov);
        engine.configureBid(C, 10 ether, 15 ether, 0, 0, true);
        treasury.deposit{value: 10 ether}(C);
        _mintApproved(alice, tokenId, address(engine));
        vm.prank(alice);
        uint256 vaultId = engine.sell(C, tokenId, 0);
        vm.startPrank(gov);
        vault.governanceUnlock(vaultId);
        raffleId = vault.sendToRaffle(vaultId);
        vm.stopPrank();
    }

    /// FINDING L-5. A winner loses 80% of their points, so the draw of one raffle can take the total
    /// below the minimum and block every other open raffle. The prizes sit in the raffle contract,
    /// which has no way to return them; the only exits are more activated points or the owner
    /// lowering the minimum.
    function test_G_raffle_minimumCanStrandTheNextRaffle() public {
        uint256 first = _prize(1);
        uint256 second = _prize(2);
        vm.startPrank(gov);
        points.setRate(address(this), 1_000e18);
        raffle.setMinPointsToDraw(500e18);
        vm.stopPrank();
        _earn(bob, 0.6 ether); // 600 points, above the minimum
        skip(7 days);

        raffle.draw(first);
        randomness.fulfill(randomness.lastRequestId(), 0);
        skip(1 hours); // the cooldown after a draw
        assertEq(points.totalPoints(), 120e18); // bob won and kept 20%

        vm.expectRevert(abi.encodeWithSelector(VaultRaffle.BelowMinPoints.selector, 120e18, 500e18));
        raffle.draw(second);
        skip(3_650 days);
        vm.expectRevert(abi.encodeWithSelector(VaultRaffle.BelowMinPoints.selector, 120e18, 500e18));
        raffle.draw(second);
        assertEq(nft.ownerOf(2), address(raffle));

        // exit 1: anyone activates enough pending points (they must exist)
        // exit 2: the owner lowers the minimum
        vm.prank(gov);
        raffle.setMinPointsToDraw(0);
        raffle.draw(second);
    }

    /// The minimum counts activated points only, and anyone can activate anyone's pending points.
    function test_G_raffle_minimumCountsActivatedOnly() public {
        uint256 id = _prize(1);
        vm.startPrank(gov);
        points.setRate(address(this), 1_000e18);
        raffle.setMinPointsToDraw(500e18);
        vm.stopPrank();
        _earn(bob, 0.1 ether);
        points.creditFee(carol, 1 ether); // pending
        skip(7 days);
        vm.expectRevert(abi.encodeWithSelector(VaultRaffle.BelowMinPoints.selector, 100e18, 500e18));
        raffle.draw(id);
        points.flush(carol);
        raffle.draw(id);
    }
}
