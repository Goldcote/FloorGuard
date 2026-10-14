// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {Points} from "../src/Points.sol";
import {Vault} from "../src/Vault.sol";
import {VaultRaffle} from "../src/VaultRaffle.sol";

contract PointsTest is Base {
    address internal source = makeAddr("source");

    function setUp() public override {
        super.setUp();
        vm.prank(gov);
        points.setRate(source, 1_000e18); // 1,000 points per ETH of fees
    }

    function _credit(address user, uint256 feeWei) internal {
        vm.prank(source);
        points.creditFee(user, feeWei);
        points.flush(user);
    }

    function test_credit_scalesWithFeeAndAccumulates() public {
        _credit(alice, 0.5 ether);
        _credit(alice, 0.25 ether);
        _credit(bob, 1 ether);
        assertEq(points.pointsOf(alice), 750e18);
        assertEq(points.pointsOf(bob), 1_000e18);
        assertEq(points.totalPoints(), 1_750e18);
        assertEq(points.userCount(), 2);
    }

    function test_credit_staysPendingUntilFlushed() public {
        vm.prank(source);
        points.creditFee(alice, 1 ether);
        assertEq(points.pendingOf(alice), 1_000e18);
        assertEq(points.pointsOf(alice), 0);
        assertEq(points.totalPoints(), 0);

        address[] memory users = new address[](2);
        users[0] = alice;
        users[1] = bob; // nothing pending: skipped
        vm.prank(carol); // anyone may activate for anyone
        points.flushMany(users);
        assertEq(points.pendingOf(alice), 0);
        assertEq(points.pointsOf(alice), 1_000e18);
        assertEq(points.userCount(), 1);
    }

    function test_credit_onlyAuthorisedSources() public {
        vm.prank(alice);
        vm.expectRevert(Points.NotAuthorised.selector);
        points.creditFee(alice, 1 ether);
    }

    function test_pick_mapsPointRangesToHolders() public {
        _credit(alice, 1 ether); // points 0 .. 999
        _credit(bob, 3 ether); // points 1000 .. 3999
        _credit(carol, 1 ether); // points 4000 .. 4999
        assertEq(points.pick(0), alice);
        assertEq(points.pick(1_000e18 - 1), alice);
        assertEq(points.pick(1_000e18), bob);
        assertEq(points.pick(4_000e18 - 1), bob);
        assertEq(points.pick(4_000e18), carol);
        assertEq(points.pick(5_000e18 - 1), carol);
        assertEq(points.pick(5_000e18), alice); // wraps modulo the total
    }

    function test_pick_revertsWithoutPoints() public {
        vm.expectRevert(Points.NoPoints.selector);
        points.pick(1);
    }

    function test_pick_worksAcrossTreeBranches() public {
        // 300 holders span several nodes on the lower two levels of the 16-ary tree
        for (uint256 i; i < 300; ++i) {
            _credit(address(uint160(0x1000 + i)), 0.001 ether); // 1 point each
        }
        assertEq(points.totalPoints(), 300e18);
        for (uint256 i; i < 300; i += 7) {
            assertEq(points.pick(i * 1e18), address(uint160(0x1000 + i)));
            assertEq(points.pick(i * 1e18 + 1e18 - 1), address(uint160(0x1000 + i)));
        }
    }

    function test_resetWinner_keepsTwentyPercentAndOnlyRaffleMayCall() public {
        _credit(alice, 1 ether);
        _credit(bob, 1 ether);
        vm.prank(alice);
        vm.expectRevert(Points.NotAuthorised.selector);
        points.resetWinner(alice);

        vm.prank(address(raffle));
        points.resetWinner(alice);
        assertEq(points.pointsOf(alice), 200e18);
        assertEq(points.totalPoints(), 1_200e18);
        assertEq(points.pick(200e18), bob);
    }

    /// The tree root always equals the sum of balances, and `pick` returns the holder of the target point.
    function testFuzz_treeMatchesBalances(uint64[12] memory fees, uint256 word) public {
        uint256 total;
        uint256[12] memory balances;
        for (uint256 i; i < 12; ++i) {
            address user = address(uint160(0x2000 + i % 5)); // 5 users, repeated credits
            if (fees[i] == 0) fees[i] = 1; // a zero credit would not register the user
            _credit(user, fees[i]);
            balances[i % 5] += uint256(fees[i]) * 1_000e18 / 1 ether;
            total += uint256(fees[i]) * 1_000e18 / 1 ether;
        }
        assertEq(points.totalPoints(), total);

        uint256 target = word % total;
        uint256 cumulative;
        address expected;
        for (uint256 i; i < 5; ++i) {
            cumulative += balances[i];
            if (target < cumulative) {
                expected = address(uint160(0x2000 + i));
                break;
            }
        }
        assertEq(points.pick(word), expected);
    }
}

contract VaultRaffleTest is Base {
    uint256 internal raffleId;

    function setUp() public override {
        super.setUp();
        // buy token 1 into the vault, then hand it to the raffle
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

    function _status() internal view returns (VaultRaffle.Status status) {
        (,,,, status,) = raffle.raffles(raffleId);
    }

    function test_open_takesCustodyAndOnlyVaultMayOpen() public {
        assertEq(nft.ownerOf(1), address(raffle));
        assertEq(uint8(_status()), uint8(VaultRaffle.Status.Open));
        vm.expectRevert(VaultRaffle.NotVault.selector);
        raffle.open(address(nft), 1);
    }

    function test_sendToRaffle_requiresUnlockedHolding() public {
        vm.prank(gov);
        vm.expectRevert(abi.encodeWithSelector(Vault.WrongStatus.selector, Vault.Status.Released));
        vault.sendToRaffle(1);
    }

    function test_draw_waitsForAnnouncePeriodAndPoints() public {
        _earn(bob, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(VaultRaffle.TooEarly.selector, block.timestamp + 7 days));
        raffle.draw(raffleId);

        skip(7 days);
        raffle.draw(raffleId);
        assertEq(uint8(_status()), uint8(VaultRaffle.Status.Drawing));
    }

    function test_draw_revertsWithoutPoints() public {
        skip(7 days);
        vm.expectRevert(VaultRaffle.NoPoints.selector);
        raffle.draw(raffleId);
    }

    function test_fullRaffle_weightedWinnerGetsNftAndLosesPoints() public {
        _earn(bob, 1 ether); // points 0 .. 999
        _earn(carol, 3 ether); // points 1000 .. 3999
        skip(7 days);
        raffle.draw(raffleId);
        randomness.fulfill(1, 2_500e18);

        (,,,,, address winner) = raffle.raffles(raffleId);
        assertEq(winner, carol);
        assertEq(points.pointsOf(carol), 600e18);
        assertEq(points.pointsOf(bob), 1_000e18);

        // the prize vests for 30 days first
        uint256 vestsAt = block.timestamp + 30 days;
        assertEq(raffle.claimableAt(raffleId), vestsAt);
        vm.expectRevert(abi.encodeWithSelector(VaultRaffle.TooEarly.selector, vestsAt));
        raffle.claim(raffleId);
        skip(30 days);
        vm.prank(alice); // anyone can deliver the prize
        raffle.claim(raffleId);
        assertEq(nft.ownerOf(1), carol);

        vm.expectRevert(abi.encodeWithSelector(VaultRaffle.WrongStatus.selector, VaultRaffle.Status.Claimed));
        raffle.claim(raffleId);
    }

    function test_fulfill_onlyRandomnessProviderAndOnlyOnce() public {
        _earn(bob, 1 ether);
        skip(7 days);
        raffle.draw(raffleId);

        vm.prank(alice);
        vm.expectRevert(VaultRaffle.NotRandomness.selector);
        raffle.fulfillRandomness(1, 0);

        randomness.fulfill(1, 0);
        vm.expectRevert(abi.encodeWithSelector(VaultRaffle.WrongStatus.selector, VaultRaffle.Status.None));
        randomness.fulfill(1, 0);
    }

    function test_resetDraw_reopensAfterTimeout() public {
        _earn(bob, 1 ether);
        skip(7 days);
        raffle.draw(raffleId);

        vm.expectRevert(abi.encodeWithSelector(VaultRaffle.TooEarly.selector, block.timestamp + 1 days));
        raffle.resetDraw(raffleId);

        skip(1 days);
        raffle.resetDraw(raffleId);
        assertEq(uint8(_status()), uint8(VaultRaffle.Status.Open));

        vm.expectRevert(abi.encodeWithSelector(VaultRaffle.TooEarly.selector, block.timestamp + 1 hours));
        raffle.draw(raffleId);
        skip(1 hours);
        raffle.draw(raffleId);
        randomness.fulfill(2, 0);
        (,,,,, address winner) = raffle.raffles(raffleId);
        assertEq(winner, bob);
    }

    function test_setVestingPeriod_boundedAndAppliesToLaterDraws() public {
        vm.prank(alice);
        vm.expectRevert();
        raffle.setVestingPeriod(0);
        vm.prank(gov);
        vm.expectRevert(VaultRaffle.InvalidPeriod.selector);
        raffle.setVestingPeriod(181 days);
        vm.prank(gov);
        raffle.setVestingPeriod(0);

        _earn(bob, 1 ether);
        skip(7 days);
        raffle.draw(raffleId);
        randomness.fulfill(randomness.lastRequestId(), 0);
        raffle.claim(raffleId); // no vesting
        assertEq(nft.ownerOf(1), bob);
    }

    function test_claim_revertsBeforeWinner() public {
        vm.expectRevert(abi.encodeWithSelector(VaultRaffle.WrongStatus.selector, VaultRaffle.Status.Open));
        raffle.claim(raffleId);
    }
}
