// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {Games} from "../src/Games.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockRandomness} from "./mocks/MockRandomness.sol";

/// @dev Review 6. A player that can refuse ETH, burn all the gas it is given, or return a large blob.
contract HostilePlayer {
    uint8 public mode; // 0 accept, 1 revert, 2 burn gas, 3 return bomb

    function setMode(uint8 m) external {
        mode = m;
    }

    function play(Games games, address collection, uint256 chance, uint256 wager) external returns (uint256) {
        return games.play{value: wager}(collection, chance);
    }

    function spin(Games games, address collection, uint256 wager) external returns (uint256) {
        return games.spin{value: wager}(collection);
    }

    function withdraw(Games games) external {
        games.withdraw();
    }

    receive() external payable {
        if (mode == 1) revert("no");
        if (mode == 2) {
            while (true) {}
        }
        if (mode == 3) {
            assembly {
                // as much return data as the stipend can pay for
                return(0, 130000)
            }
        }
    }
}

contract SpinHandler is Test {
    Games internal games;
    Treasury internal treasury;
    MockRandomness internal randomness;
    address internal collection;
    address internal gov;
    address internal project;

    address[3] public eoas = [address(0xA11), address(0xA12), address(0xA13)];
    HostilePlayer public hostile;
    uint256[] public open;

    uint256 public spins;
    uint256 public plays;
    uint256 public settled;
    uint256 public lateRefunds;
    uint256 public refunded;
    uint256 public fulfilReverts;

    constructor(Games g, Treasury t, MockRandomness r, address c, address gov_, address project_) {
        (games, treasury, randomness, collection, gov, project) = (g, t, r, c, gov_, project_);
        hostile = new HostilePlayer();
        vm.deal(address(hostile), 1_000_000 ether);
    }

    function openCount() external view returns (uint256) {
        return open.length;
    }

    function _remove(uint256 i) internal {
        open[i] = open[open.length - 1];
        open.pop();
    }

    function _fits(uint256 exposure) internal view returns (bool) {
        if (exposure > games.bankroll() * games.maxExposureBps() / 10_000) return false;
        return games.reserved() + exposure <= (games.bankroll() + games.reserved()) * 2_000 / 10_000;
    }

    function play(uint8 who, uint96 wager, uint16 chance) external {
        uint256 c = bound(chance, 100, 9_500);
        uint256 w = bound(wager, games.minBet(), 5 ether);
        (uint256 payout, uint256 fee) = games.quote(w, c);
        if (!_fits(payout - (w - fee))) return;
        uint256 id;
        if (who % 4 == 3) {
            id = hostile.play(games, collection, c, w);
        } else {
            address p = eoas[who % 4];
            vm.deal(p, w);
            vm.prank(p);
            id = games.play{value: w}(collection, c);
        }
        open.push(id);
        ++plays;
    }

    function spin(uint8 who, uint96 wager) external {
        uint256 w = bound(wager, games.minBet(), 0.5 ether);
        uint256 stake = w - w * games.edgeBps() / 10_000;
        if (!_fits(stake * 49)) return;
        uint256 id;
        if (who % 4 == 3) {
            id = hostile.spin(games, collection, w);
        } else {
            address p = eoas[who % 4];
            vm.deal(p, w);
            vm.prank(p);
            id = games.spin{value: w}(collection);
        }
        open.push(id);
        ++spins;
    }

    /// The callback must never revert for an open bet, whatever happened in between.
    function fulfill(uint256 seed, uint256 word, bool jackpot) external {
        if (open.length == 0) return;
        uint256 i = seed % open.length;
        (,,,,,, uint40 placedAt) = games.bets(open[i]);
        if (jackpot) word = (word / 10_000) * 10_000 + (word % 20); // roll below 20
        try randomness.fulfill(open[i], word) {
            if (block.timestamp >= placedAt + 1 days) ++lateRefunds;
            else ++settled;
        } catch {
            ++fulfilReverts;
            return;
        }
        _remove(i);
    }

    function refund(uint256 seed) external {
        if (open.length == 0) return;
        uint256 i = seed % open.length;
        (,,,,,, uint40 placedAt) = games.bets(open[i]);
        if (block.timestamp < placedAt + 1 days) return;
        games.refund(open[i]);
        _remove(i);
        ++refunded;
    }

    function setHostileMode(uint8 m) external {
        hostile.setMode(m % 4);
    }

    function withdrawOwed() external {
        if (games.owedTo(address(hostile)) == 0) return;
        hostile.setMode(0);
        hostile.withdraw(games);
    }

    function setParams(uint16 edge, uint16 maxExposure) external {
        vm.prank(gov);
        games.setParams(bound(edge, 0, 1_000), 0.001 ether, bound(maxExposure, 0, 10_000));
    }

    function setEdgeExtreme(bool top) external {
        vm.prank(gov);
        games.setParams(top ? 1_000 : 0, 0.001 ether, 100);
    }

    function setShare(uint16 bps) external {
        vm.prank(gov);
        treasury.setProjectShare(collection, project, uint16(bound(bps, 0, 5_000)));
    }

    function fund(uint96 amount) external {
        uint256 a = bound(amount, 0, 100 ether);
        vm.deal(address(this), a);
        games.fundBankroll{value: a}();
    }

    function toTreasury(uint96 amount) external {
        uint256 a = bound(amount, 0, games.bankroll());
        vm.prank(gov);
        games.withdrawBankrollToTreasury(a);
    }

    function warp(uint32 s) external {
        skip(bound(s, 0, 20 hours));
    }
}

/// @dev balance == bankroll + reserved + open wagers + owedTo, reserved == sum of open exposures, and
///      the randomness callback never reverts for an open bet, with dice and slots mixed.
contract Review6GamesInvariant is Base {
    SpinHandler internal handler;
    address internal project = makeAddr("project");

    function setUp() public override {
        super.setUp();
        games.fundBankroll{value: 1_000 ether}();
        handler = new SpinHandler(games, treasury, randomness, address(nft), gov, project);
        targetContract(address(handler));
    }

    function invariant_review6_gamesAccountingWithSlots() public view {
        uint256 wagers;
        uint256 exposures;
        uint256 n = handler.openCount();
        for (uint256 i; i < n; ++i) {
            (address player,, uint128 wager, uint128 exposure,,,) = games.bets(handler.open(i));
            assertTrue(player != address(0), "tracked bet vanished");
            wagers += wager;
            exposures += exposure;
        }
        uint256 owed = games.owedTo(address(handler.hostile()));
        for (uint256 i; i < 3; ++i) {
            owed += games.owedTo(handler.eoas(i));
        }
        assertEq(games.reserved(), exposures, "reserved != open exposures");
        assertEq(address(games).balance, games.bankroll() + games.reserved() + wagers + owed, "balance");
        assertEq(handler.fulfilReverts(), 0, "callback reverted for an open bet");
    }

    function invariant_review6_treasuryAccounted() public view {
        assertEq(
            address(treasury).balance,
            treasury.budgetOf(address(nft)) + treasury.unallocated() + treasury.totalOwed()
        );
    }

    /// Not an invariant. Set REVIEW6_REACH=1 to make it fail as soon as one run has seen spins, dice
    /// bets, settlements, late-randomness refunds, timeout refunds and an undeliverable payout.
    function invariant_review6_coverageCounters() public view {
        if (vm.envOr("REVIEW6_REACH", uint256(0)) == 0) return;
        assertFalse(
            handler.spins() > 3 && handler.plays() > 3 && handler.settled() > 3 && handler.lateRefunds() > 0
                && handler.refunded() > 0 && games.owedTo(address(handler.hostile())) != 0,
            "reached: spins, dice, settlements, late refunds, refunds, owed payouts in one run"
        );
    }
}

contract Review6GamesUnit is Base {
    function setUp() public override {
        super.setUp();
        games.fundBankroll{value: 1_000_000 ether}();
    }

    /// Settlement of a dice bet never underflows, whatever the edge was at placement and whatever it is
    /// changed to before the callback, and the house neither gains nor loses a wei it did not reserve.
    function testFuzz_review6_diceSettlementNeverUnderflows(
        uint96 wager,
        uint16 chance,
        uint16 edgeAtPlacement,
        uint16 edgeAtSettlement,
        uint256 word
    ) public {
        uint256 w = bound(wager, 1, 5 ether);
        uint256 c = bound(chance, 100, 9_500);
        vm.prank(gov);
        games.setParams(bound(edgeAtPlacement, 0, 1_000), 0, 100);
        uint256 houseBefore = games.bankroll();
        vm.prank(alice);
        uint256 id = games.play{value: w}(address(nft), c);
        (,,, uint128 exposure,, uint16 betEdge,) = games.bets(id);
        vm.prank(gov);
        games.setParams(bound(edgeAtSettlement, 0, 1_000), 0, 100);

        uint256 aliceBefore = alice.balance;
        randomness.fulfill(id, word);
        uint256 fee = w * betEdge / 10_000;
        uint256 stake = w - fee;
        if (word % 10_000 < c) {
            assertEq(alice.balance - aliceBefore, stake + exposure);
            assertEq(games.bankroll(), houseBefore - exposure);
            // never more than fair odds on the stake
            assertLe((stake + exposure) * c, stake * 10_000);
        } else {
            assertEq(games.bankroll(), houseBefore + stake);
        }
        assertEq(games.reserved(), 0);
        assertEq(address(games).balance, games.bankroll());
    }

    function testFuzz_review6_slotsSettlementNeverUnderflows(
        uint96 wager,
        uint16 edgeAtPlacement,
        uint16 edgeAtSettlement,
        uint256 word
    ) public {
        uint256 w = bound(wager, 1, 5 ether);
        vm.prank(gov);
        games.setParams(bound(edgeAtPlacement, 0, 1_000), 0, 100);
        uint256 houseBefore = games.bankroll();
        vm.prank(alice);
        uint256 id = games.spin{value: w}(address(nft));
        (,,, uint128 exposure, uint16 chanceBps, uint16 betEdge,) = games.bets(id);
        assertEq(chanceBps, 0);
        vm.prank(gov);
        games.setParams(bound(edgeAtSettlement, 0, 1_000), 0, 100);

        uint256 aliceBefore = alice.balance;
        randomness.fulfill(id, word);
        uint256 stake = w - w * betEdge / 10_000;
        uint256 payout = stake * games.slotsMultiplier(word % 10_000);
        assertEq(exposure, stake * 49);
        assertEq(alice.balance - aliceBefore, payout);
        assertEq(games.bankroll(), houseBefore + stake - payout);
        assertEq(address(games).balance, games.bankroll());
    }

    /// Exhaustive: the pay table is exactly fair and its tier sizes are as documented.
    function test_review6_payTableIsExactlyFair() public view {
        uint256 total;
        uint256[51] memory count;
        for (uint256 roll; roll < 10_000; ++roll) {
            uint256 m = games.slotsMultiplier(roll);
            total += m;
            ++count[m];
        }
        assertEq(total, 10_000);
        assertEq(count[50], 20);
        assertEq(count[10], 100);
        assertEq(count[5], 400);
        assertEq(count[2], 1_500);
        assertEq(count[1], 3_000);
        assertEq(count[0], 4_980);
        // modulo bias of `randomWord % 10000`: 2^256 mod 10000 = 9936 rolls are favoured by 1 in ~1.2e73
        assertEq(type(uint256).max % 10_000, 9_935);
    }

    /// `play` cannot create a bet that settles as slots, and `spin` cannot create one that settles as dice.
    function test_review6_sentinelCannotBeReached() public {
        vm.prank(alice);
        vm.expectRevert(Games.InvalidChance.selector);
        games.play{value: 1 ether}(address(nft), 0);
        vm.prank(alice);
        vm.expectRevert(Games.InvalidChance.selector);
        games.play{value: 1 ether}(address(nft), 99);
        vm.prank(alice);
        vm.expectRevert(Games.InvalidChance.selector);
        games.play{value: 1 ether}(address(nft), 65_536 + 0); // would truncate to 0 in uint16
        vm.prank(alice);
        vm.expectRevert(Games.InvalidChance.selector);
        games.play{value: 1 ether}(address(nft), 65_536 + 5_000);
    }

    /// Gas of the callback when a jackpot goes to a receiver that burns its stipend or returns a blob.
    function test_review6_callbackGasForJackpotToHostileReceiver() public {
        vm.prank(gov);
        treasury.setProjectShare(address(nft), makeAddr("project"), 5_000);
        HostilePlayer hostile = new HostilePlayer();
        vm.deal(address(hostile), 10 ether);
        uint256 worst;
        for (uint8 mode = 1; mode < 4; ++mode) {
            hostile.setMode(mode);
            uint256 id = hostile.spin(games, address(nft), 1 ether);
            uint256 before = gasleft();
            randomness.fulfill(id, 7); // roll 7: 50x
            uint256 used = before - gasleft();
            if (used > worst) worst = used;
        }
        emit log_named_uint("worst callback gas, jackpot to hostile receiver", worst);
        assertEq(games.owedTo(address(hostile)), 2 * 49 ether); // the blob-returning call succeeds
        // the adapter's default callbackGasLimit is 600,000
        assertLt(worst, 250_000);
    }

    /// Many small spins and dice bets together cannot reserve more than the house has, and the house can
    /// pay every one of them at its maximum.
    function test_review6_everyOpenBetCanHitItsMaximum() public {
        uint256[] memory ids = new uint256[](400);
        uint256 n;
        for (uint256 i; i < 400; ++i) {
            vm.prank(alice);
            try games.spin{value: 2 ether}(address(nft)) returns (uint256 id) {
                ids[n++] = id;
            } catch {
                vm.prank(alice);
                try games.play{value: 1 ether}(address(nft), 100) returns (uint256 id) {
                    ids[n++] = id;
                } catch {
                    break;
                }
            }
        }
        assertGt(n, 100);
        assertLe(games.reserved(), (games.bankroll() + games.reserved()) / 5);
        for (uint256 i; i < n; ++i) {
            randomness.fulfill(ids[i], 0); // roll 0: every dice bet wins, every spin pays 50x
        }
        assertEq(games.reserved(), 0);
        assertEq(address(games).balance, games.bankroll());
    }
}
