// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {Games} from "../src/Games.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockRandomness} from "./mocks/MockRandomness.sol";

/// @dev A player contract that can be switched between accepting and rejecting ETH.
contract FussyPlayer {
    bool public accept;

    function setAccept(bool accept_) external {
        accept = accept_;
    }

    function play(Games games, address collection, uint256 chance, uint256 wager) external returns (uint256) {
        return games.play{value: wager}(collection, chance);
    }

    function withdraw(Games games) external {
        games.withdraw();
    }

    receive() external payable {
        require(accept, "no");
    }
}

contract GamesHandler is Test {
    Games internal games;
    Treasury internal treasury;
    MockRandomness internal randomness;
    address internal collection;
    address internal gov;
    address internal project;

    address[3] public eoas = [address(0xA11), address(0xA12), address(0xA13)];
    FussyPlayer public fussy;
    uint256[] public open;

    uint256 public settled;
    uint256 public refunded;

    constructor(Games g, Treasury t, MockRandomness r, address c, address gov_, address project_) {
        (games, treasury, randomness, collection, gov, project) = (g, t, r, c, gov_, project_);
        fussy = new FussyPlayer();
        vm.deal(address(fussy), 1_000_000 ether);
    }

    function openCount() external view returns (uint256) {
        return open.length;
    }

    function _remove(uint256 i) internal {
        open[i] = open[open.length - 1];
        open.pop();
    }

    function play(uint8 who, uint96 wager, uint16 chance) external {
        uint256 c = bound(chance, 100, 9_500);
        uint256 w = bound(wager, games.minBet(), 5 ether);
        (uint256 payout, uint256 fee) = games.quote(w, c);
        if (payout - (w - fee) > games.bankroll() * games.maxExposureBps() / 10_000) return;
        uint256 id;
        if (who % 4 == 3) {
            id = fussy.play(games, collection, c, w);
        } else {
            address p = eoas[who % 4];
            vm.deal(p, w);
            vm.prank(p);
            id = games.play{value: w}(collection, c);
        }
        open.push(id);
    }

    function fulfill(uint256 seed, uint256 word) external {
        if (open.length == 0) return;
        uint256 i = seed % open.length;
        randomness.fulfill(open[i], word);
        _remove(i);
        ++settled;
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

    function toggleFussy(bool accept) external {
        fussy.setAccept(accept);
    }

    function withdrawOwed() external {
        if (games.owedTo(address(fussy)) == 0 || !fussy.accept()) return;
        fussy.withdraw(games);
    }

    function setParams(uint16 edge, uint16 maxExposure) external {
        vm.prank(gov);
        games.setParams(bound(edge, 0, 1_000), 0.001 ether, bound(maxExposure, 0, 10_000));
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
        // house shares replaced the owner's withdrawal: redeem some of this handler's own shares
        uint256 shares = bound(amount, 0, games.sharesOf(address(this)));
        if (shares == 0) return;
        games.redeem(shares, 0, payable(address(treasury)));
    }

    function claimShare() external {
        if (treasury.owedTo(project) == 0) return;
        vm.prank(project);
        treasury.claimProjectShare();
    }

    function warp(uint32 s) external {
        skip(bound(s, 0, 2 days));
    }
}

/// @dev Stateful check of the two accounting identities under random play, settlement, refunds,
///      undeliverable payouts, parameter changes and bankroll moves.
contract GamesInvariantTest is Base {
    GamesHandler internal handler;
    address internal project = makeAddr("project");

    function setUp() public override {
        super.setUp();
        games.fundBankroll{value: 1_000 ether}();
        handler = new GamesHandler(games, treasury, randomness, address(nft), gov, project);
        targetContract(address(handler));
    }

    /// address(games).balance == bankroll + sum over open bets of (wager + exposure) + sum of owedTo
    function invariant_gamesFullyAccounted() public view {
        uint256 locked;
        uint256 n = handler.openCount();
        for (uint256 i; i < n; ++i) {
            (address player,, uint128 wager, uint128 exposure,,,) = games.bets(handler.open(i));
            assertTrue(player != address(0), "tracked bet vanished");
            locked += uint256(wager) + exposure;
        }
        uint256 owed = games.owedTo(address(handler.fussy()));
        for (uint256 i; i < 3; ++i) {
            owed += games.owedTo(handler.eoas(i));
        }
        assertEq(address(games).balance, games.bankroll() + locked + owed);
    }

    /// treasury balance == budgets + unallocated + totalOwed, and totalOwed == the only recipient's claim
    function invariant_treasuryFullyAccounted() public view {
        assertEq(
            address(treasury).balance,
            treasury.budgetOf(address(nft)) + treasury.unallocated() + treasury.totalOwed()
        );
        assertEq(treasury.totalOwed(), treasury.owedTo(project));
    }
}
