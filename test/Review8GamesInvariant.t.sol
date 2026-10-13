// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {Games} from "../src/Games.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockRandomness} from "./mocks/MockRandomness.sol";

contract Fussy8 {
    bool public accept;

    function setAccept(bool a) external {
        accept = a;
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
        require(accept, "no");
    }
}

/// @dev The existing GamesInvariant handler runs with the bankroll's share at zero (Base sets it so)
///      and never changes `maxWagerBps`. This one varies both, plays slots as well as dice, and checks
///      each settlement's bankroll movement against the formula.
contract Games8Handler is Test {
    Games internal games;
    Treasury internal treasury;
    MockRandomness internal randomness;
    address internal collection;
    address internal gov;
    address internal project;

    address[3] public eoas = [address(0xB11), address(0xB12), address(0xB13)];
    Fussy8 public fussy;
    uint256[] public open;

    uint256 public settled;
    uint256 public settledWithShare;
    uint256 public keptTotal;
    uint256 public feesToTreasury;
    bool public settlementMismatch;

    constructor(Games g, Treasury t, MockRandomness r, address c, address gov_, address project_) {
        (games, treasury, randomness, collection, gov, project) = (g, t, r, c, gov_, project_);
        fussy = new Fussy8();
        vm.deal(address(fussy), 1_000_000 ether);
    }

    function openCount() external view returns (uint256) {
        return open.length;
    }

    function _remove(uint256 i) internal {
        open[i] = open[open.length - 1];
        open.pop();
    }

    function play(uint8 who, uint96 wager, uint16 chance, bool slots) external {
        uint256 c = bound(chance, 100, 9_500);
        // the largest wager the three limits allow, so that most calls place a bet
        uint256 mult = slots ? 49 : (10_000 + c - 1) / c;
        uint256 cap = games.bankroll() * games.maxWagerBps() / 10_000;
        uint256 byExposure = games.bankroll() * games.maxExposureBps() / 10_000 / mult;
        uint256 total = (games.bankroll() + games.reserved()) * 2_000 / 10_000;
        uint256 byTotal = total > games.reserved() ? (total - games.reserved()) / mult : 0;
        if (byExposure < cap) cap = byExposure;
        if (byTotal < cap) cap = byTotal;
        if (cap < games.minBet()) return;
        uint256 w = bound(wager, games.minBet(), cap);
        uint256 id;
        if (slots) {
            if (who % 4 == 3) {
                id = fussy.spin(games, collection, w);
            } else {
                vm.deal(eoas[who % 4], w);
                vm.prank(eoas[who % 4]);
                id = games.spin{value: w}(collection);
            }
        } else {
            if (who % 4 == 3) {
                id = fussy.play(games, collection, c, w);
            } else {
                vm.deal(eoas[who % 4], w);
                vm.prank(eoas[who % 4]);
                id = games.play{value: w}(collection, c);
            }
        }
        open.push(id);
    }

    function fulfill(uint256 seed, uint256 word) external {
        if (open.length == 0) return;
        uint256 i = seed % open.length;
        uint256 id = open[i];
        (,, uint128 wager, uint128 exposure, uint16 chanceBps, uint16 edgeBps, uint40 placedAt) =
            games.bets(id);
        uint256 bankrollBefore = games.bankroll();
        uint256 treasuryBefore = address(treasury).balance;
        uint256 share = games.bankrollShareBps();
        randomness.fulfill(id, word);
        _remove(i);

        if (block.timestamp >= uint256(placedAt) + 1 days) {
            if (games.bankroll() != bankrollBefore + exposure) settlementMismatch = true;
            return;
        }
        uint256 fee = uint256(wager) * edgeBps / 10_000;
        uint256 stake = wager - fee;
        uint256 roll = word % 10_000;
        uint256 payout;
        if (chanceBps == 0) payout = stake * games.slotsMultiplier(roll);
        else if (roll < chanceBps) payout = stake + exposure;
        uint256 kept = fee * share / 10_000;
        if (games.bankroll() != bankrollBefore + stake + exposure - payout + kept) settlementMismatch = true;
        if (address(treasury).balance != treasuryBefore + fee - kept) settlementMismatch = true;
        ++settled;
        if (kept != 0) ++settledWithShare;
        keptTotal += kept;
        feesToTreasury += fee - kept;
    }

    function refund(uint256 seed) external {
        if (open.length == 0) return;
        uint256 i = seed % open.length;
        (,,,,,, uint40 placedAt) = games.bets(open[i]);
        if (block.timestamp < uint256(placedAt) + 1 days) return;
        games.refund(open[i]);
        _remove(i);
    }

    function toggleFussy(bool accept) external {
        fussy.setAccept(accept);
    }

    function withdrawOwed() external {
        if (games.owedTo(address(fussy)) == 0 || !fussy.accept()) return;
        fussy.withdraw(games);
    }

    function setRisk(uint16 wagerBps, uint16 share) external {
        vm.prank(gov);
        games.setRiskParams(bound(wagerBps, 1, 10_000), bound(share, 0, 10_000));
    }

    function setParams(uint16 edge, uint16 maxExposure) external {
        vm.prank(gov);
        games.setParams(bound(edge, 0, 1_000), 0.001 ether, bound(maxExposure, 100, 10_000));
    }

    function setProjectShare(uint16 bps) external {
        vm.prank(gov);
        treasury.setProjectShare(collection, project, uint16(bound(bps, 0, 5_000)));
    }

    function fund(uint96 amount) external {
        uint256 a = bound(amount, 1, 100 ether);
        vm.deal(address(this), a);
        games.fundBankroll{value: a}();
    }

    function toTreasury(uint96 amount) external {
        uint256 a = bound(amount, 0, games.bankroll() / 10);
        vm.prank(gov);
        // low-level, so this file still compiles if the function is renamed or removed later
        (bool ok,) = address(games).call(abi.encodeWithSignature("withdrawBankrollToTreasury(uint256)", a));
        ok;
    }

    function warp(uint32 s) external {
        skip(bound(s, 0, 2 days));
    }
}

/// @dev Review 8, question G: the Games accounting identity with `bankrollShareBps` and `maxWagerBps`
///      in play.
contract Review8GamesInvariantTest is Base {
    Games8Handler internal handler;
    address internal project = makeAddr("project");

    function setUp() public override {
        super.setUp();
        vm.prank(gov);
        games.setRiskParams(100, 5_000); // the deployed default
        games.fundBankroll{value: 1_000 ether}();
        handler = new Games8Handler(games, treasury, randomness, address(nft), gov, project);
        targetContract(address(handler));
    }

    /// balance == bankroll + reserved + open wagers + owedTo, and reserved == the open bets' exposures
    function invariant_R8_gamesFullyAccounted() public view {
        uint256 wagers;
        uint256 exposures;
        uint256 n = handler.openCount();
        for (uint256 i; i < n; ++i) {
            (address player,, uint128 wager, uint128 exposure,,,) = games.bets(handler.open(i));
            assertTrue(player != address(0), "tracked bet vanished");
            wagers += wager;
            exposures += exposure;
        }
        uint256 owed = games.owedTo(address(handler.fussy()));
        for (uint256 i; i < 3; ++i) {
            owed += games.owedTo(handler.eoas(i));
        }
        assertEq(games.reserved(), exposures, "reserved != open exposures");
        assertEq(
            address(games).balance,
            games.bankroll() + games.reserved() + wagers + owed + games.totalPendingDeposits(),
            "games balance"
        );
    }

    /// every settlement moved the bankroll by stake + exposure - payout + kept, and the Treasury by
    /// fee - kept
    function invariant_R8_everySettlementMatchedTheFormula() public view {
        assertFalse(handler.settlementMismatch());
    }

    function invariant_R8_treasuryFullyAccounted() public view {
        assertEq(
            address(treasury).balance,
            treasury.budgetOf(address(nft)) + treasury.unallocated() + treasury.totalOwed()
        );
        assertEq(treasury.budgetOf(address(nft)) + treasury.totalOwed(), handler.feesToTreasury());
    }

    /// A fixed campaign through the same handler, to show that the invariants above are exercised with
    /// a share in force: bets settled, refunded and left undeliverable while the parameters move.
    function test_R8_campaign_coversSettlementsWithAShare() public {
        for (uint256 i; i < 600; ++i) {
            uint256 r = uint256(keccak256(abi.encode("review8", i)));
            uint256 action = r % 12;
            if (action < 4) {
                handler.play(uint8(r >> 8), uint96(r >> 16), uint16(r >> 112), (r >> 128) % 3 == 0);
            } else if (action < 7) {
                handler.fulfill(r >> 8, r >> 40);
            } else if (action == 7) {
                handler.refund(r >> 8);
            } else if (action == 8) {
                handler.setRisk(uint16(r >> 8), uint16(r >> 24));
            } else if (action == 9) {
                handler.setProjectShare(uint16(r >> 8));
            } else if (action == 10) {
                handler.toggleFussy((r >> 8) % 2 == 0);
            } else if ((r >> 8) % 4 == 0) {
                handler.warp(uint32(r >> 16));
            } else {
                handler.toTreasury(uint96(r >> 16));
            }
            if (i % 50 == 0) {
                invariant_R8_gamesFullyAccounted();
                invariant_R8_everySettlementMatchedTheFormula();
                invariant_R8_treasuryFullyAccounted();
            }
        }
        invariant_R8_gamesFullyAccounted();
        invariant_R8_everySettlementMatchedTheFormula();
        invariant_R8_treasuryFullyAccounted();
        assertGt(handler.settled(), 50);
        assertGt(handler.settledWithShare(), 25);
        assertGt(handler.keptTotal(), 0);
    }
}
