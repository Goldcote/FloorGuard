// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Base} from "./Base.t.sol";
import {Games} from "../src/Games.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockRandomness} from "./mocks/MockRandomness.sol";

/// @dev A holder and player that is a contract and can be switched to reject ETH.
contract FussyActor {
    bool public accept = true;

    function setAccept(bool accept_) external {
        accept = accept_;
    }

    function exec(address target, uint256 value, bytes calldata data)
        external
        returns (bool ok, bytes memory ret)
    {
        (ok, ret) = target.call{value: value}(data);
    }

    receive() external payable {
        require(accept, "no");
    }
}

/// @dev Review 10, part 1, question 4. Five accounts hold shares and also play; one is a contract that
///      can reject ETH. Every handler call checks what the call itself must have done; the invariants
///      check the books.
contract HouseHandler is Test {
    Games internal games;
    Treasury internal treasury;
    MockRandomness internal randomness;
    address internal collection;
    address internal gov;

    uint256 public constant ACTORS = 5;
    address[5] public actors;
    FussyActor public fussy;

    uint256[] public open;
    mapping(uint256 id => uint256) public seqOf;
    mapping(uint256 seq => bool) public ghostClosed;
    uint256 public ghostPlaced;

    mapping(address => uint256) public depSeq;
    mapping(address => uint256) public redSeq;

    // statistics
    uint256 public nPlaced;
    uint256 public nSettled;
    uint256 public nLate;
    uint256 public nRefunded;
    uint256 public nDepReq;
    uint256 public nDepNow;
    uint256 public nDepLater;
    uint256 public nDepCancel;
    uint256 public nRedReq;
    uint256 public nRedNow;
    uint256 public nRedLater;
    uint256 public nRedPartial;
    uint256 public nRedCancel;
    uint256 public nRejected;
    uint256 public nOwed;

    constructor(Games g, Treasury t, MockRandomness r, address c, address gov_) {
        (games, treasury, randomness, collection, gov) = (g, t, r, c, gov_);
        fussy = new FussyActor();
        actors = [address(0xB01), address(0xB02), address(0xB03), address(0xB04), address(fussy)];
        for (uint256 i; i < ACTORS; ++i) {
            vm.deal(actors[i], 1_000_000 ether);
        }
    }

    function openCount() external view returns (uint256) {
        return open.length;
    }

    function _call(uint256 who, uint256 value, bytes memory data)
        internal
        returns (bool ok, bytes memory ret)
    {
        address a = actors[who];
        if (a == address(fussy)) {
            (bool sent, bytes memory out) =
                address(fussy).call(abi.encodeCall(FussyActor.exec, (address(games), value, data)));
            assertTrue(sent);
            (ok, ret) = abi.decode(out, (bool, bytes));
        } else {
            vm.prank(a);
            (ok, ret) = address(games).call{value: value}(data);
        }
    }

    function _funds() internal view returns (uint256) {
        return games.bankroll() + games.reserved();
    }

    function _othersWorth(address except) internal view returns (uint256 worth) {
        for (uint256 i; i < ACTORS; ++i) {
            if (actors[i] != except) worth += games.previewRedeem(games.sharesOf(actors[i]));
        }
    }

    /// No bet numbered below `seq` may still be open when a request made at `seq` is carried out.
    function _assertWaited(uint256 seq) internal view {
        for (uint256 i; i < open.length; ++i) {
            assertGe(seqOf[open[i]], seq, "request carried out before an earlier bet closed");
        }
    }

    // ------------------------------------------------------------------ bets

    function play(uint8 who, uint96 wager, uint16 chance, bool slots) external {
        uint256 w = games.maxWager();
        if (w < games.minBet()) return;
        w = bound(wager, games.minBet(), w);
        uint256 c = bound(chance, 100, 9_500);
        {
            // scale the wager to the exposure limit, most of the time
            uint256 stake = w - w * games.edgeBps() / 10_000;
            uint256 exposure = slots ? stake * 49 : stake * 10_000 / c - stake;
            uint256 limit = games.bankroll() * games.maxExposureBps() / 10_000;
            if (exposure > limit && wager % 16 != 0) w = w * limit / (exposure + 1);
            if (w < games.minBet()) return;
        }
        bytes memory data =
            slots ? abi.encodeCall(Games.spin, (collection)) : abi.encodeCall(Games.play, (collection, c));
        uint256 fundsBefore = _funds();
        (bool ok, bytes memory ret) = _call(who % ACTORS, w, data);
        if (!ok) return;
        uint256 id = abi.decode(ret, (uint256));
        seqOf[id] = ghostPlaced++;
        open.push(id);
        ++nPlaced;
        assertEq(_funds(), fundsBefore, "placing a bet changed the house's funds");
        assertEq(games.placedCount(), ghostPlaced);
    }

    function _close(uint256 i) internal {
        ghostClosed[seqOf[open[i]]] = true;
        open[i] = open[open.length - 1];
        open.pop();
    }

    /// What the bet's own terms say the settlement must do.
    function _expected(uint256 id, uint256 word)
        internal
        view
        returns (int256 delta, uint256 paid, bool late)
    {
        (,, uint128 wager, uint128 exposure, uint16 chance, uint16 edge, uint40 placedAt) = games.bets(id);
        if (block.timestamp >= uint256(placedAt) + 1 days) return (0, wager, true);
        uint256 fee = uint256(wager) * edge / 10_000;
        uint256 stake = wager - fee;
        uint256 roll = word % 10_000;
        if (chance == 0) paid = stake * games.slotsMultiplier(roll);
        else if (roll < chance) paid = stake + exposure;
        delta = int256(stake + fee * games.bankrollShareBps() / 10_000) - int256(paid);
    }

    function fulfill(uint256 seed, uint256 word) external {
        if (open.length == 0) return;
        uint256 i = seed % open.length;
        uint256 id = open[i];
        (address player,,,,,,) = games.bets(id);
        (int256 delta, uint256 paid, bool late) = _expected(id, word);
        if (late) ++nLate;
        else ++nSettled;
        uint256 fundsBefore = _funds();
        uint256 playerBefore = player.balance + games.owedTo(player);
        uint256 owedBefore = games.owedTo(player);
        randomness.fulfill(id, word);
        _close(i);
        assertEq(int256(_funds()), int256(fundsBefore) + delta, "house result differs from the bet's terms");
        assertEq(player.balance + games.owedTo(player), playerBefore + paid, "player paid wrongly");
        if (games.owedTo(player) != owedBefore) ++nOwed;
    }

    function refund(uint256 seed) external {
        if (open.length == 0) return;
        uint256 i = seed % open.length;
        (address player,, uint128 wager,,,, uint40 placedAt) = games.bets(open[i]);
        if (block.timestamp < uint256(placedAt) + 1 days) return;
        uint256 fundsBefore = _funds();
        uint256 playerBefore = player.balance + games.owedTo(player);
        games.refund(open[i]);
        _close(i);
        ++nRefunded;
        assertEq(_funds(), fundsBefore);
        assertEq(player.balance + games.owedTo(player), playerBefore + wager);
    }

    function warp(uint32 s) external {
        skip(s % 4 == 0 ? 25 hours : bound(s, 1, 7 hours));
    }

    // ------------------------------------------------------------------ the house

    function _afterDeposit(
        address a,
        uint256 sharesBefore,
        uint256 pendingBefore,
        uint256 othersBefore,
        bool now_
    ) internal {
        uint256 minted = games.sharesOf(a) - sharesBefore;
        if (minted == 0) return;
        _assertWaited(depSeq[a]);
        assertEq(games.pendingDepositOf(a), 0);
        // never worth more than was paid, and others never lose by it
        assertLe(games.previewRedeem(minted), pendingBefore, "deposit minted more than it paid for");
        assertGe(_othersWorth(a), othersBefore, "a deposit diluted the other holders");
        if (now_) ++nDepNow;
        else ++nDepLater;
    }

    function deposit(uint8 who, uint96 amount) external {
        address a = actors[who % ACTORS];
        uint256 value = bound(amount, 1, 60 ether);
        uint256 sharesBefore = games.sharesOf(a);
        uint256 othersBefore = _othersWorth(a);
        uint256 pending = games.pendingDepositOf(a) + value;
        uint256 seq = games.placedCount();
        (bool ok,) = _call(who % ACTORS, value, abi.encodeCall(Games.deposit, (0)));
        if (!ok) return;
        depSeq[a] = seq;
        ++nDepReq;
        _afterDeposit(a, sharesBefore, pending, othersBefore, true);
    }

    function executeDeposit(uint8 who) external {
        address a = actors[who % ACTORS];
        uint256 sharesBefore = games.sharesOf(a);
        uint256 othersBefore = _othersWorth(a);
        uint256 pending = games.pendingDepositOf(a);
        (bool ok,) = _call(who % ACTORS, 0, abi.encodeCall(Games.executeDeposit, (0)));
        if (!ok) {
            assertEq(games.pendingDepositOf(a), pending);
            return;
        }
        assertGt(games.sharesOf(a), sharesBefore);
        _afterDeposit(a, sharesBefore, pending, othersBefore, false);
    }

    function cancelDeposit(uint8 who) external {
        address a = actors[who % ACTORS];
        uint256 pending = games.pendingDepositOf(a);
        uint256 balance = a.balance;
        uint256 funds = _funds();
        (bool ok,) = _call(who % ACTORS, 0, abi.encodeCall(Games.cancelDeposit, ()));
        if (!ok) {
            if (pending != 0) ++nRejected;
            assertEq(games.pendingDepositOf(a), pending);
            return;
        }
        ++nDepCancel;
        assertEq(a.balance, balance + pending);
        assertEq(_funds(), funds, "a cancelled deposit touched house money");
    }

    function _afterRedeem(
        address a,
        address to,
        uint256 sharesBefore,
        uint256 toBefore,
        uint256 othersBefore,
        bool now_
    ) internal {
        uint256 burned = sharesBefore - games.sharesOf(a);
        if (burned == 0) return;
        _assertWaited(redSeq[a]);
        assertGe(_othersWorth(a), othersBefore, "a redemption took from the other holders");
        // fewer than a million shares are worth less than a wei and are burned for nothing
        assertGe(to.balance, toBefore);
        assertLe(games.pendingRedeemOf(a), games.sharesOf(a));
        if (games.pendingRedeemOf(a) != 0) ++nRedPartial;
        if (now_) ++nRedNow;
        else ++nRedLater;
    }

    function redeem(uint8 who, uint256 fraction, uint8 toSeed) external {
        address a = actors[who % ACTORS];
        uint256 sharesBefore = games.sharesOf(a);
        if (sharesBefore == 0) return;
        uint256 shares = fraction % 4 == 0 ? sharesBefore : bound(fraction, 1, sharesBefore);
        address to = toSeed % 3 == 0 ? actors[toSeed % ACTORS] : a;
        uint256 toBefore = to.balance;
        uint256 othersBefore = _othersWorth(a);
        uint256 seq = games.placedCount();
        (bool ok,) = _call(who % ACTORS, 0, abi.encodeCall(Games.redeem, (shares, 0, payable(to))));
        if (!ok) {
            ++nRejected;
            assertEq(games.sharesOf(a), sharesBefore);
            return;
        }
        redSeq[a] = seq;
        ++nRedReq;
        _afterRedeem(a, to, sharesBefore, toBefore, othersBefore, true);
    }

    function executeRedeem(uint8 who, uint8 toSeed) external {
        address a = actors[who % ACTORS];
        uint256 sharesBefore = games.sharesOf(a);
        address to = toSeed % 3 == 0 ? actors[toSeed % ACTORS] : a;
        uint256 toBefore = to.balance;
        uint256 othersBefore = _othersWorth(a);
        (bool ok,) = _call(who % ACTORS, 0, abi.encodeCall(Games.executeRedeem, (0, payable(to))));
        if (!ok) {
            assertEq(games.sharesOf(a), sharesBefore);
            return;
        }
        assertLt(games.sharesOf(a), sharesBefore);
        _afterRedeem(a, to, sharesBefore, toBefore, othersBefore, false);
    }

    function cancelRedeem(uint8 who) external {
        (bool ok,) = _call(who % ACTORS, 0, abi.encodeCall(Games.cancelRedeem, ()));
        if (ok) ++nRedCancel;
    }

    function advance(uint16 steps) external {
        games.advanceClosed(bound(steps, 0, 300));
    }

    /// Lock up the reserve with long shots, then let the largest holder carry out or make a redemption
    /// of everything it has: the case that can only be paid in part.
    function lockAndRedeem(uint256 seed) external {
        for (uint256 i; i < 12; ++i) {
            this.play(uint8(seed >> i), type(uint96).max - 1, 100 + uint16(i) * 50, false);
        }
        uint256 big;
        for (uint256 i = 1; i < ACTORS; ++i) {
            if (games.sharesOf(actors[i]) > games.sharesOf(actors[big])) big = i;
        }
        if (games.pendingRedeemOf(actors[big]) != 0) this.executeRedeem(uint8(big), 1);
        else this.redeem(uint8(big), 0, 1);
    }

    // ------------------------------------------------------------------ the rest

    function toggleFussy(bool accept) external {
        fussy.setAccept(accept);
    }

    function withdrawOwed(uint8 who) external {
        _call(who % ACTORS, 0, abi.encodeCall(Games.withdraw, ()));
    }

    function setParams(uint16 edge, uint16 maxExposure) external {
        vm.prank(gov);
        games.setParams(bound(edge, 0, 1_000), 0.001 ether, bound(maxExposure, 50, 300));
    }

    function setRiskParams(uint16 maxWager, uint16 keep) external {
        vm.prank(gov);
        games.setRiskParams(bound(maxWager, 50, 300), bound(keep, 0, 10_000));
    }

    /// Close every bet, carry out every request and redeem every share. Returns what is left.
    function windDown() external returns (uint256 left) {
        fussy.setAccept(true);
        skip(1 days + 1);
        while (open.length != 0) {
            games.refund(open[0]);
            _close(0);
        }
        games.advanceClosed(type(uint256).max);
        for (uint256 i; i < ACTORS; ++i) {
            if (games.pendingDepositOf(actors[i]) != 0) {
                (bool ok,) = _call(i, 0, abi.encodeCall(Games.executeDeposit, (0)));
                if (!ok) {
                    // a deposit too small for one share at today's price can only be cancelled
                    (ok,) = _call(i, 0, abi.encodeCall(Games.cancelDeposit, ()));
                    assertTrue(ok, "pending deposit stuck");
                }
            }
        }
        for (uint256 i; i < ACTORS; ++i) {
            uint256 shares = games.sharesOf(actors[i]);
            if (shares == 0) continue;
            (bool ok,) = _call(i, 0, abi.encodeCall(Games.redeem, (shares, 0, payable(actors[i]))));
            assertTrue(ok, "redeem failed with nothing open");
            assertEq(games.sharesOf(actors[i]), 0, "shares left with nothing open");
        }
        for (uint256 i; i < ACTORS; ++i) {
            if (games.owedTo(actors[i]) != 0) _call(i, 0, abi.encodeCall(Games.withdraw, ()));
        }
        return games.bankroll() + games.reserved();
    }
}

contract Review10HouseInvariant is Base {
    HouseHandler internal handler;

    function setUp() public override {
        super.setUp();
        vm.prank(gov);
        games.setRiskParams(100, 5_000);
        handler = new HouseHandler(games, treasury, randomness, address(nft), gov);
        // one dominant holder, so that redemptions meet the reserve
        for (uint256 i; i < 15; ++i) {
            handler.deposit(0, 60 ether);
        }
        handler.deposit(1, 30 ether);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](19);
        selectors[18] = HouseHandler.lockAndRedeem.selector;
        selectors[17] = HouseHandler.setRiskParams.selector;
        selectors[0] = HouseHandler.play.selector;
        selectors[1] = HouseHandler.play.selector;
        selectors[2] = HouseHandler.play.selector;
        selectors[3] = HouseHandler.fulfill.selector;
        selectors[4] = HouseHandler.fulfill.selector;
        selectors[5] = HouseHandler.refund.selector;
        selectors[6] = HouseHandler.warp.selector;
        selectors[7] = HouseHandler.deposit.selector;
        selectors[8] = HouseHandler.executeDeposit.selector;
        selectors[9] = HouseHandler.cancelDeposit.selector;
        selectors[10] = HouseHandler.redeem.selector;
        selectors[11] = HouseHandler.executeRedeem.selector;
        selectors[12] = HouseHandler.cancelRedeem.selector;
        selectors[13] = HouseHandler.advance.selector;
        selectors[14] = HouseHandler.toggleFussy.selector;
        selectors[15] = HouseHandler.withdrawOwed.selector;
        selectors[16] = HouseHandler.setParams.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_books() public view {
        uint256 n = handler.openCount();
        uint256 wagers;
        uint256 exposures;
        for (uint256 i; i < n; ++i) {
            (address player,, uint128 wager, uint128 exposure,,,) = games.bets(handler.open(i));
            assertTrue(player != address(0), "tracked bet vanished");
            wagers += wager;
            exposures += exposure;
        }
        assertEq(games.reserved(), exposures, "reserved != sum of open exposures");
        assertEq(games.openWagers(), wagers, "openWagers != sum of open wagers");

        uint256 shares;
        uint256 pending;
        uint256 owed;
        uint256 worth;
        for (uint256 i; i < handler.ACTORS(); ++i) {
            address a = handler.actors(i);
            shares += games.sharesOf(a);
            pending += games.pendingDepositOf(a);
            owed += games.owedTo(a);
            worth += games.previewRedeem(games.sharesOf(a));
            assertLe(games.pendingRedeemOf(a), games.sharesOf(a), "pending redemption above the holding");
        }
        assertEq(shares, games.totalShares(), "sum of shares");
        assertEq(pending, games.totalPendingDeposits(), "sum of pending deposits");
        assertLe(worth, games.bankroll() + games.reserved(), "shares worth more than the house holds");
        assertEq(
            address(games).balance,
            games.bankroll() + games.reserved() + games.openWagers() + owed + games.totalPendingDeposits(),
            "balance identity"
        );
    }

    function invariant_closedRecord() public view {
        uint256 through = games.closedThrough();
        assertLe(through, games.placedCount());
        assertEq(games.placedCount(), handler.ghostPlaced());
        for (uint256 seq; seq < through; ++seq) {
            assertTrue(handler.ghostClosed(seq), "closedThrough passed an open bet");
        }
        assertEq(games.isClosedThrough(games.placedCount()), handler.openCount() == 0);
    }

    uint256 internal constant DUST_LIMIT = 1e9;

    /// After everything is closed, executed and redeemed, only dust is left without an owner.
    function afterInvariant() public {
        uint256 left = handler.windDown();
        assertEq(games.totalShares(), 0);
        assertEq(games.totalPendingDeposits(), 0);
        assertEq(games.reserved(), 0);
        assertEq(address(games).balance, left, "something other than the residue is left");
        assertLt(left, DUST_LIMIT, "ownerless value above dust");
        console2.log("residue wei", left);
        console2.log("bets placed / settled / late / refunded");
        console2.log(handler.nPlaced(), handler.nSettled(), handler.nLate(), handler.nRefunded());
        console2.log("deposits requested / at once / later / cancelled");
        console2.log(handler.nDepReq(), handler.nDepNow(), handler.nDepLater(), handler.nDepCancel());
        console2.log("redemptions requested / at once / later / left partial");
        console2.log(handler.nRedReq(), handler.nRedNow(), handler.nRedLater(), handler.nRedPartial());
        console2.log("redeem cancels / rejected calls / payouts parked in owedTo");
        console2.log(handler.nRedCancel(), handler.nRejected(), handler.nOwed());
    }

    function step(uint256 r) external {
        uint256 k = r % 100;
        uint8 who = uint8(r >> 8);
        uint256 x = r >> 16;
        if (k < 22) handler.play(who, uint96(x), uint16(x >> 96), x % 5 == 0);
        else if (k < 52) handler.fulfill(x, x >> 7);
        else if (k < 56) handler.refund(x);
        else if (k < 59) handler.warp(uint32(x));
        else if (k < 67) handler.deposit(who, uint96(x));
        else if (k < 74) handler.executeDeposit(who);
        else if (k < 76) handler.cancelDeposit(who);
        else if (k < 83) handler.redeem(who, x, uint8(x >> 200));
        else if (k < 90) handler.executeRedeem(who, uint8(x >> 200));
        else if (k < 92) handler.cancelRedeem(who);
        else if (k < 94) handler.advance(uint16(x));
        else if (k < 96) handler.toggleFussy(x % 2 == 0);
        else if (k < 97) handler.withdrawOwed(who);
        else if (k < 98) handler.setParams(uint16(x), uint16(x >> 16));
        else if (k < 99) handler.setRiskParams(uint16(x), uint16(x >> 16));
        else handler.lockAndRedeem(x);
    }

    /// Seeded campaigns whose size and mix are known: 1,500 calls each, the books checked after every
    /// call and the record of closed bets every 50, then a full wind-down.
    function _seeded(uint256 seed) internal {
        for (uint256 i; i < 1_500; ++i) {
            // external calls, so that each one's memory is released
            this.step(uint256(keccak256(abi.encode(seed, i))));
            this.invariant_books();
            if (i % 50 == 0) this.invariant_closedRecord();
        }
        invariant_closedRecord();
        console2.log("placed/settled/late/refunded", handler.nPlaced(), handler.nSettled(), handler.nLate());
        console2.log("  refunded", handler.nRefunded());
        console2.log("dep req/now/later", handler.nDepReq(), handler.nDepNow(), handler.nDepLater());
        console2.log("  dep cancelled", handler.nDepCancel());
        console2.log("red req/now/later", handler.nRedReq(), handler.nRedNow(), handler.nRedLater());
        console2.log("  red partial/cancel", handler.nRedPartial(), handler.nRedCancel());
        console2.log("  rejected/owed", handler.nRejected(), handler.nOwed());
        uint256 left = handler.windDown();
        assertEq(games.totalShares(), 0);
        assertEq(address(games).balance, left);
        assertLt(left, DUST_LIMIT, "ownerless value above dust");
        console2.log("residue after wind-down, wei", left);
    }

    function test_seededCampaign_1() public {
        _seeded(1);
    }

    function test_seededCampaign_2() public {
        _seeded(2);
    }

    function test_seededCampaign_3() public {
        _seeded(3);
    }

    function test_seededCampaign_4() public {
        _seeded(4);
    }

    function test_seededCampaign_5() public {
        _seeded(5);
    }

    function test_seededCampaign_6() public {
        _seeded(6);
    }

    function test_seededCampaign_7() public {
        _seeded(7);
    }

    function test_seededCampaign_8() public {
        _seeded(8);
    }
}
