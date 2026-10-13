// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {Lottery} from "../src/Lottery.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockRandomness} from "./mocks/MockRandomness.sol";
import {MockNFT} from "./mocks/MockNFT.sol";

contract Review6LotteryHandler is Test {
    Lottery internal lottery;
    Treasury internal treasury;
    MockRandomness internal randomness;
    address internal gov;
    address[2] public collections;
    address[4] public buyers = [address(0xB01), address(0xB02), address(0xB03), address(0xB04)];

    /// every request id ever issued to the lottery, answered or not
    uint256[] public requests;
    mapping(uint256 roundId => uint256) public wonCount;
    mapping(uint256 roundId => bool) public everRefunding;
    mapping(uint256 roundId => bool) public everWon;
    uint256 public feesPaid;
    uint256 public withdrawn;
    uint256 public unexpectedFulfilReverts;
    uint256 public acceptedStale;
    uint256 public wins;
    uint256 public refunds;
    uint256 public resets;
    uint256 public aborts;

    constructor(Lottery l, Treasury t, MockRandomness r, address gov_, address c0, address c1) {
        (lottery, treasury, randomness, gov) = (l, t, r, gov_);
        collections = [c0, c1];
    }

    function _status(uint256 roundId) internal view returns (Lottery.Status status) {
        (,,,,,, status,) = lottery.rounds(roundId);
    }

    function _round(uint256 seed) internal view returns (uint256) {
        uint256 n = lottery.roundCount();
        return n == 0 ? 0 : 1 + seed % n;
    }

    /// A round in `wanted`, searched from a random start, or a random round if there is none.
    function _roundIn(uint256 seed, Lottery.Status wanted) internal view returns (uint256) {
        uint256 n = lottery.roundCount();
        if (n == 0) return 0;
        for (uint256 i; i < n; ++i) {
            uint256 id = 1 + (seed + i) % n;
            if (_status(id) == wanted) return id;
        }
        return 1 + seed % n;
    }

    function _note(uint256 roundId) internal {
        Lottery.Status s = _status(roundId);
        if (s == Lottery.Status.Refunding) everRefunding[roundId] = true;
        if (s == Lottery.Status.Won) everWon[roundId] = true;
    }

    function buy(uint8 who, uint8 col, uint16 count) external {
        address c = collections[col % 2];
        (uint128 price,, bool active) = lottery.configOf(c);
        uint256 roundId = lottery.currentRoundOf(c);
        (, uint128 roundPrice,, uint40 endTime,,, Lottery.Status status,) = lottery.rounds(roundId);
        bool opens = status != Lottery.Status.Open || block.timestamp >= endTime;
        if (opens && !active) return;
        uint256 p = opens ? price : roundPrice;
        uint32 n = uint32(bound(count, 1, 400));
        address b = buyers[who % 4];
        vm.deal(b, b.balance + p * n);
        vm.prank(b);
        lottery.buy{value: p * n}(c, n);
    }

    function draw(uint256 seed) external {
        uint256 roundId = _roundIn(seed, Lottery.Status.Open);
        uint256 before = randomness.lastRequestId();
        try lottery.draw(roundId) {
            if (randomness.lastRequestId() != before) requests.push(randomness.lastRequestId());
            _note(roundId);
        } catch {}
    }

    /// Answer any request ever issued, current or stale, in time or late.
    function fulfill(uint256 seed, uint256 word) external {
        if (requests.length == 0) return;
        uint256 requestId = requests[seed % requests.length];
        uint256 roundId = lottery.roundOfRequest(requestId);
        bool current = roundId != 0 && lottery.currentRequest(roundId) == requestId;
        Lottery.Status beforeStatus = _status(roundId);
        uint256 budgetBefore = address(treasury).balance;
        try randomness.fulfill(requestId, word) {
            if (!current || beforeStatus != Lottery.Status.Drawing) ++acceptedStale;
            if (_status(roundId) == Lottery.Status.Won) {
                ++wonCount[roundId];
                ++wins;
            }
            feesPaid += address(treasury).balance - budgetBefore;
            _note(roundId);
        } catch {
            if (current) ++unexpectedFulfilReverts;
        }
    }

    function resetDraw(uint256 seed) external {
        uint256 roundId = _roundIn(seed, Lottery.Status.Drawing);
        try lottery.resetDraw(roundId) {
            ++resets;
        } catch {}
    }

    function abort(uint256 seed) external {
        uint256 roundId = seed % 3 == 0 ? _round(seed) : _roundIn(seed, Lottery.Status.Drawing);
        try lottery.abort(roundId) {
            ++aborts;
            _note(roundId);
        } catch {}
    }

    function refund(uint256 seed, uint8 who) external {
        uint256 roundId = _roundIn(seed, Lottery.Status.Refunding);
        address b = buyers[who % 4];
        vm.prank(b);
        try lottery.refund(roundId) {
            ++refunds;
        } catch {}
    }

    function withdraw(uint8 who) external {
        address b = buyers[who % 4];
        uint256 owed = lottery.owedTo(b);
        if (owed == 0) return;
        vm.prank(b);
        lottery.withdraw();
        withdrawn += owed;
    }

    function setParams(uint16 fee, uint64 minPot) external {
        vm.prank(gov);
        lottery.setParams(bound(fee, 0, 1_000), bound(minPot, 0, 0.2 ether));
    }

    function setConfig(uint8 col, uint64 price, uint32 duration, bool active) external {
        vm.prank(gov);
        lottery.setConfig(
            collections[col % 2],
            uint128(bound(price, 0.0001 ether, 0.05 ether)),
            uint40(bound(duration, 1 hours, 30 days)),
            active
        );
    }

    function setShare(uint8 col, uint16 bps) external {
        vm.prank(gov);
        treasury.setProjectShare(collections[col % 2], address(0xFEE), uint16(bound(bps, 0, 5_000)));
    }

    function warp(uint32 s, bool long_) external {
        skip(bound(s, 0, long_ ? 9 days : 30 hours));
    }
}

/// @dev balance == pots of Open and Drawing rounds + refundable paidBy of Refunding rounds + owedTo,
///      a round is won at most once, a round never both pays a winner and refunds, an abandoned request
///      is never accepted, and the answer to a current request never reverts.
contract Review6LotteryInvariant is Base {
    Review6LotteryHandler internal handler;
    MockNFT internal nft2;

    function setUp() public override {
        super.setUp();
        nft2 = new MockNFT();
        vm.startPrank(gov);
        lottery.setConfig(address(nft), 0.01 ether, 1 days, true);
        lottery.setConfig(address(nft2), 0.002 ether, 3 hours, true);
        vm.stopPrank();
        handler = new Review6LotteryHandler(lottery, treasury, randomness, gov, address(nft), address(nft2));
        targetContract(address(handler));
    }

    function invariant_review6_lotteryFullyAccounted() public view {
        uint256 expected;
        uint256 n = lottery.roundCount();
        for (uint256 id = 1; id <= n; ++id) {
            (, uint128 price, uint32 sold,,,, Lottery.Status status, address winner) = lottery.rounds(id);
            assertTrue(status != Lottery.Status.None, "round without status");
            uint256 paid;
            for (uint256 b; b < 4; ++b) {
                paid += lottery.paidBy(id, handler.buyers(b));
            }
            if (status == Lottery.Status.Open || status == Lottery.Status.Drawing) {
                expected += uint256(price) * sold;
                assertEq(paid, uint256(price) * sold, "paidBy != pot before the round is decided");
            } else if (status == Lottery.Status.Refunding) {
                expected += paid;
                assertEq(winner, address(0), "refunding round has a winner");
            } else {
                assertTrue(winner != address(0), "won round without winner");
            }
            // request bookkeeping: a request is recorded exactly while the round is drawing
            uint256 req = lottery.currentRequest(id);
            if (status == Lottery.Status.Drawing) {
                assertEq(lottery.roundOfRequest(req), id, "drawing round lost its request");
            } else {
                assertEq(req, 0, "request recorded for a round that is not drawing");
            }
            assertLe(handler.wonCount(id), 1, "round won twice");
            assertFalse(handler.everRefunding(id) && handler.everWon(id), "round refunded and won");
        }
        for (uint256 b; b < 4; ++b) {
            expected += lottery.owedTo(handler.buyers(b));
        }
        assertEq(address(lottery).balance, expected, "lottery balance");
        assertEq(handler.unexpectedFulfilReverts(), 0, "callback reverted for a current request");
        assertEq(handler.acceptedStale(), 0, "stale request accepted");
    }

    function invariant_review6_treasuryAccounted() public view {
        assertEq(
            address(treasury).balance,
            treasury.budgetOf(address(nft)) + treasury.budgetOf(address(nft2)) + treasury.unallocated()
                + treasury.totalOwed()
        );
    }

    /// Not an invariant. Set REVIEW6_REACH=1 to make it fail as soon as one run has seen a win, a
    /// refund, a reset and an abort, which shows the campaign reaches all four.
    function invariant_review6_coverageCounters() public view {
        if (vm.envOr("REVIEW6_REACH", uint256(0)) == 0) return;
        assertFalse(
            handler.wins() > 1 && handler.refunds() > 1 && handler.resets() > 0 && handler.aborts() > 0,
            "reached: wins, refunds, resets and aborts in one run"
        );
    }
}
