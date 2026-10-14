// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {Vault} from "../src/Vault.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IRandomnessProvider} from "../src/interfaces/IFloorGuard.sol";

contract VaultTest is Base {
    uint256 internal vaultId;

    function setUp() public override {
        super.setUp();
        vm.prank(gov);
        engine.configureBid(address(nft), 10 ether, 15 ether, 0, 0, true);
        treasury.deposit{value: 10 ether}(address(nft));
        _mintApproved(alice, 1, address(engine));
        vm.prank(alice);
        vaultId = engine.sell(address(nft), 1, 0); // bought at 10 ETH, budget now empty
    }

    function _status() internal view returns (Vault.Status status) {
        (,,,,,, status) = vault.holdings(vaultId);
    }

    function _unlockByConditions() internal {
        _unlockThroughDraw(vaultId, 13 ether);
    }

    function _acquiredAt(uint256 id) internal view returns (uint256 at) {
        (,,, at,,,) = vault.holdings(id);
    }

    /// Deposit `n` holdings straight into the Vault, as the engine would, at `price` each.
    function _depositMany(uint256 firstTokenId, uint256 n, uint256 price)
        internal
        returns (uint256[] memory ids)
    {
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            nft.mint(address(vault), firstTokenId + i);
            vm.prank(address(engine));
            ids[i] = vault.registerDeposit(address(nft), firstTokenId + i, price);
        }
    }

    // ------------------------------------------------------------------ deposits

    function test_registerDeposit_onlyEngine() public {
        vm.prank(alice);
        vm.expectRevert(Vault.NotEngine.selector);
        vault.registerDeposit(address(nft), 1, 1 ether);
    }

    function test_registerDeposit_requiresCustody() public {
        nft.mint(alice, 2);
        vm.prank(address(engine));
        vm.expectRevert(Vault.NotHeld.selector);
        vault.registerDeposit(address(nft), 2, 1 ether);
    }

    // ------------------------------------------------------------------ floor samples

    function test_sampleFloor_oncePerDayAndOnlyFresh() public {
        vm.expectRevert(Vault.StaleOracle.selector);
        vault.sampleFloor(address(nft)); // nothing pushed yet

        _pushFloor(5 ether);
        vm.prank(carol); // permissionless
        vault.sampleFloor(address(nft));
        vm.expectRevert(Vault.AlreadySampled.selector);
        vault.sampleFloor(address(nft));

        skip(1 days);
        vault.sampleFloor(address(nft));
        assertEq(vault.sampleCount(address(nft)), 2);
    }

    function test_medianFloor_needsFifteenRecentSamplesAndIgnoresSpikes() public {
        _sampleFloor(10 ether, 14);
        (bool usable,) = vault.medianFloor(address(nft));
        assertFalse(usable);

        skip(1 days);
        _pushFloor(1_000 ether); // one pumped day
        vault.sampleFloor(address(nft));
        (bool usable2, uint256 median) = vault.medianFloor(address(nft));
        assertTrue(usable2);
        assertEq(median, 10 ether);

        skip(17 days); // the early samples age out of the 30-day window
        (bool usable3,) = vault.medianFloor(address(nft));
        assertFalse(usable3);
    }

    /// Moving the median needs more than half of the month's samples.
    function test_medianFloor_movesOnlyWithAMajorityOfSamples() public {
        _sampleFloor(10 ether, 15);
        skip(1 days);
        _sampleFloor(20 ether, 15);
        (, uint256 median) = vault.medianFloor(address(nft));
        assertEq(median, 10 ether); // lower median of 15 x 10 and 15 x 20
        skip(1 days);
        _sampleFloor(20 ether, 1);
        (, median) = vault.medianFloor(address(nft));
        assertEq(median, 20 ether);
    }

    // ------------------------------------------------------------------ the unlock draw

    function test_ramps_requiredFloorFallsAndDrawChanceRises() public view {
        assertEq(vault.requiredFloorBps(0), 13_000);
        assertEq(vault.requiredFloorBps(90 days), 13_000);
        assertEq(vault.requiredFloorBps(365 days), 10_000);
        assertEq(vault.requiredFloorBps(1_000 days), 10_000);
        assertEq(vault.requiredFloorBps(227.5 days), 11_500);
        assertEq(vault.drawChanceBps(90 days), 50);
        assertEq(vault.drawChanceBps(227.5 days), 275);
        assertEq(vault.drawChanceBps(365 days), 500);
    }

    function test_requestUnlockRound_oncePerDayAndLateWordsIgnored() public {
        vault.requestUnlockRound();
        uint256 first = randomness.lastRequestId();
        vm.expectRevert(Vault.RoundInFlight.selector);
        vault.requestUnlockRound();

        skip(1 days); // the word never came: a new request replaces it
        vault.requestUnlockRound();
        uint256 second = randomness.lastRequestId();
        vm.expectRevert(Vault.StaleRequest.selector);
        randomness.fulfill(first, 7);

        skip(1 days); // too late: ignored, not used
        randomness.fulfill(second, 7);
        assertEq(vault.seedArrivedAt(), 0);
        assertFalse(vault.roundPending());

        vault.requestUnlockRound();
        randomness.fulfill(randomness.lastRequestId(), 7);
        assertEq(vault.roundSeed(), 7);
        uint256 readyAt = block.timestamp + 1 days;
        vm.expectRevert(abi.encodeWithSelector(Vault.TooEarly.selector, readyAt));
        vault.requestUnlockRound();
    }

    function test_fulfillRandomness_onlyFromTheProvider() public {
        vault.requestUnlockRound();
        uint256 requestId = randomness.lastRequestId();
        vm.prank(alice);
        vm.expectRevert(Vault.NotRandomness.selector);
        vault.fulfillRandomness(requestId, 1);
    }

    function test_requestUnlockRound_needsAProvider() public {
        vm.prank(gov);
        vault.setRandomness(IRandomnessProvider(address(0)));
        vm.expectRevert(Vault.NoRandomness.selector);
        vault.requestUnlockRound();
    }

    function test_unlock_needsAgeDrawAndMedianFloor() public {
        uint256 acquired = _acquiredAt(vaultId);
        // Eligible age and a word that does not pick the holding.
        skip(76 days);
        _sampleFloor(12.9 ether, 15);
        uint256 miss = 1;
        while (uint256(keccak256(abi.encode(miss, vaultId))) % 10_000 < 50) ++miss;
        _drawUnlockRound(miss);
        assertFalse(vault.isPicked(vaultId));
        assertFalse(vault.canUnlock(vaultId));

        // Picked, but the median floor is below the multiple a 91-day-old holding needs.
        skip(1 days);
        _sampleFloor(12.9 ether, 1);
        uint256 age = block.timestamp - acquired;
        _drawUnlockRound(_seedPicking(vaultId, vault.drawChanceBps(age)));
        assertTrue(vault.isPicked(vaultId));
        uint256 required = 10 ether * vault.requiredFloorBps(age) / 10_000;
        (, uint256 median) = vault.medianFloor(address(nft));
        assertLt(median, required);
        assertFalse(vault.canUnlock(vaultId));
        vm.expectRevert(Vault.UnlockConditionsNotMet.selector);
        vault.unlock(vaultId);
    }

    function test_unlock_throughTheDraw() public {
        _unlockByConditions();
        assertEq(uint8(_status()), uint8(Vault.Status.Unlocked));
        assertEq(vault.unlockBpsOf(vaultId), 13_000);
        assertEq(vault.unlockFloorOf(vaultId), 13 ether);
    }

    function test_unlock_notBeforeMinLockEvenWhenPicked() public {
        _sampleFloor(20 ether, 15);
        _drawUnlockRound(_seedPicking(vaultId, 50));
        assertFalse(vault.isPicked(vaultId));
    }

    /// A holding whose lock ends after the draw was requested takes no part in it.
    function test_isPicked_onlyHoldingsEligibleWhenTheDrawWasRequested() public {
        vm.warp(_acquiredAt(vaultId) + 90 days - 1);
        vault.requestUnlockRound();
        skip(1);
        randomness.fulfill(randomness.lastRequestId(), _seedPicking(vaultId, 50));
        assertFalse(vault.isPicked(vaultId));
    }

    function test_isPicked_expiresWithTheSeed() public {
        vm.warp(_acquiredAt(vaultId) + 90 days);
        _drawUnlockRound(_seedPicking(vaultId, 50));
        assertTrue(vault.isPicked(vaultId));
        skip(1 days);
        assertFalse(vault.isPicked(vaultId));
    }

    /// After a year the floor only has to be back at the price paid.
    function test_unlock_requiredFloorFallsToThePricePaid() public {
        vm.warp(_acquiredAt(vaultId) + 365 days - 14 days);
        _sampleFloor(10 ether, 15);
        _pushFloor(10 ether);
        _drawUnlockRound(_seedPicking(vaultId, 500));
        assertTrue(vault.canUnlock(vaultId));
        vault.unlock(vaultId);
        assertEq(vault.unlockBpsOf(vaultId), 10_000);

        skip(30 days);
        _pushFloor(1);
        vm.prank(carol);
        vault.startAuction(vaultId);
        skip(4 days);
        assertEq(vault.auctionPrice(vaultId), 10 ether); // never below the price paid
    }

    /// No more than 5% of a collection's holdings (at least one) unlock per week.
    function test_unlock_releaseCapPerWeek() public {
        vm.prank(gov);
        vault.setPlayersShare(0);
        uint256[] memory ids = _depositMany(100, 19, 10 ether); // 20 held: one per week
        vm.warp(block.timestamp + 365 days - 14 days);
        _sampleFloor(13 ether, 15);
        uint256[] memory pair = new uint256[](2);
        pair[0] = ids[0];
        pair[1] = ids[1];
        _drawUnlockRound(_seedPicking(pair, 500));
        assertEq(vault.releaseAllowance(address(nft)), 1);
        vault.unlock(ids[0]);
        assertEq(vault.releaseAllowance(address(nft)), 0);
        assertFalse(vault.canUnlock(ids[1]));
        vm.expectRevert(Vault.UnlockConditionsNotMet.selector);
        vault.unlock(ids[1]);

        skip(7 days);
        _sampleFloor(13 ether, 1);
        _drawUnlockRound(_seedPicking(ids[1], 500));
        vault.unlock(ids[1]);
    }

    function test_governanceUnlock_skipsConditions() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.governanceUnlock(vaultId);

        vm.prank(gov);
        vault.governanceUnlock(vaultId);
        assertEq(uint8(_status()), uint8(Vault.Status.Unlocked));
    }

    function test_relock_extendsAndRestoresLock() public {
        _unlockByConditions();
        uint256 until = block.timestamp + 90 days;
        vm.prank(gov);
        vault.relock(vaultId, until);
        assertEq(uint8(_status()), uint8(Vault.Status.Locked));
        assertFalse(vault.canUnlock(vaultId));

        vm.prank(gov);
        vm.expectRevert(Vault.InvalidLock.selector);
        vault.relock(vaultId, until);

        _unlockThroughDraw(vaultId, 13 ether);
        assertEq(uint8(_status()), uint8(Vault.Status.Unlocked));
    }

    // ------------------------------------------------------------------ review 12

    /// A sample taken after the draw is known cannot tip the median it is judged on.
    function test_unlock_judgedOnTheMedianAsOfTheDrawRequest() public {
        vm.warp(_acquiredAt(vaultId) + 90 days - 29 days);
        _sampleFloor(12.9 ether, 15);
        _sampleFloor(13.5 ether, 15); // a full ring: 15 low, 15 high, lower median 12.9 < 13 required
        vault.requestUnlockRound();
        skip(1);
        randomness.fulfill(randomness.lastRequestId(), _seedPicking(vaultId, 50));
        assertTrue(vault.isPicked(vaultId));
        assertFalse(vault.canUnlock(vaultId));

        // after seeing the pick, the next day's high sample evicts the oldest low one
        vm.warp((block.timestamp / 1 days + 1) * 1 days);
        _pushFloor(13.5 ether);
        vault.sampleFloor(address(nft));
        (, uint256 current) = vault.medianFloor(address(nft));
        assertEq(current, 13.5 ether);
        assertTrue(vault.isPicked(vaultId));
        assertFalse(vault.canUnlock(vaultId)); // still judged as of the request
        vm.expectRevert(Vault.UnlockConditionsNotMet.selector);
        vault.unlock(vaultId);
    }

    function test_requestUnlockRound_retiresThePreviousWord() public {
        vm.warp(_acquiredAt(vaultId) + 90 days);
        _drawUnlockRound(_seedPicking(vaultId, 50));
        assertTrue(vault.isPicked(vaultId));
        skip(1 days - 1); // the word would live one more second
        vm.warp(block.timestamp); // same moment
        skip(1); // a day after the last request
        vault.requestUnlockRound();
        assertFalse(vault.isPicked(vaultId));
    }

    function test_governanceUnlock_resetsTheUnlockMultiple() public {
        vm.warp(_acquiredAt(vaultId) + 365 days - 15 days);
        _sampleFloor(10 ether, 16);
        _drawUnlockRound(_seedPicking(vaultId, 500));
        vault.unlock(vaultId);
        assertEq(vault.unlockBpsOf(vaultId), 10_000);

        vm.startPrank(gov);
        vault.relock(vaultId, block.timestamp + 1 days);
        vault.governanceUnlock(vaultId);
        vm.stopPrank();
        assertEq(vault.unlockBpsOf(vaultId), 0);
        skip(30 days);
        _pushFloor(1);
        vm.prank(carol);
        vault.startAuction(vaultId);
        (, uint128 endPrice,) = vault.auctions(vaultId);
        assertEq(endPrice, 13 ether); // back to 130% of the 10 ETH price
    }

    function test_isPicked_onlyLockedDrawHoldings() public {
        uint256[] memory ids = _depositMany(100, 4, 1 ether); // ids[3] is a players' holding
        vm.warp(block.timestamp + 365 days);
        uint256[] memory all = new uint256[](4);
        all[0] = ids[3];
        all[1] = 999; // does not exist
        all[2] = vaultId;
        all[3] = ids[0];
        _drawUnlockRound(_seedPicking(all, 500));
        assertFalse(vault.isPicked(ids[3]));
        assertFalse(vault.isPicked(999));
        assertTrue(vault.isPicked(vaultId));
        vm.prank(gov);
        vault.governanceUnlock(ids[0]);
        assertFalse(vault.isPicked(ids[0]));
    }

    function test_removeFromPlayers_joinsTheMovingLockNotBefore90Days() public {
        uint256[] memory ids = _depositMany(100, 4, 1 ether);
        uint256 id = ids[3];
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.removeFromPlayers(id);
        vm.prank(gov);
        vm.expectRevert(Vault.NotForPlayers.selector);
        vault.removeFromPlayers(ids[0]);

        vm.prank(gov);
        vault.removeFromPlayers(id);
        assertFalse(vault.isPlayersHolding(id));
        (,,, uint40 acquiredAt, uint40 lockedUntil,,) = vault.holdings(id);
        assertEq(lockedUntil, acquiredAt + 90 days);
        skip(31 days);
        vm.expectRevert(Vault.NotForPlayers.selector);
        vault.releaseToPlayers(id);
    }

    function test_licences_notOnPlayersHoldings() public {
        uint256[] memory ids = _depositMany(100, 4, 1 ether);
        vm.prank(gov);
        licenses.setTier(address(nft), 0, 0, 30 days, true);
        vm.prank(bob);
        vm.expectRevert();
        licenses.requestLicense(ids[3], 0, "poster");
        vm.prank(bob);
        licenses.requestLicense(ids[0], 0, "poster");
    }

    function test_playersShare_oneInFivePurchases() public {
        uint256[] memory ids = _depositMany(100, 9, 1 ether); // with the setUp purchase: ten in all
        uint256 n;
        for (uint256 i; i < ids.length; ++i) {
            if (vault.isPlayersHolding(ids[i])) ++n;
        }
        assertEq(n, 2);
        assertTrue(vault.isPlayersHolding(ids[3])); // the fifth purchase
        assertTrue(vault.isPlayersHolding(ids[8])); // the tenth
    }

    function test_releaseToPlayers_after30DaysByAnyone() public {
        uint256[] memory ids = _depositMany(100, 4, 1 ether);
        uint256 id = ids[3];
        (,,,, uint40 lockedUntil,,) = vault.holdings(id);
        assertEq(lockedUntil, block.timestamp + 30 days);

        vm.expectRevert(abi.encodeWithSelector(Vault.TooEarly.selector, lockedUntil));
        vault.releaseToPlayers(id);
        vm.expectRevert(Vault.NotForPlayers.selector);
        vault.releaseToPlayers(ids[0]);

        // a players' holding never goes through the draw
        vm.warp(block.timestamp + 365 days);
        assertFalse(vault.canUnlock(id));

        vm.prank(carol);
        uint256 raffleId = vault.releaseToPlayers(id);
        assertEq(nft.ownerOf(103), address(raffle));
        assertEq(raffleId, 1);
        assertEq(vault.heldCount(address(nft)), 4);
    }

    function test_setPlayersShare_boundedAndOwnerOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.setPlayersShare(0);
        vm.prank(gov);
        vm.expectRevert(Vault.InvalidShare.selector);
        vault.setPlayersShare(5_001);
        vm.prank(gov);
        vault.setPlayersShare(0);
        uint256[] memory ids = _depositMany(100, 9, 1 ether);
        for (uint256 i; i < ids.length; ++i) {
            assertFalse(vault.isPlayersHolding(ids[i]));
        }
    }

    // ------------------------------------------------------------------ auction

    function test_auction_publicOnlyAfterGovernanceWindow() public {
        _unlockByConditions();
        uint256 opensAt = block.timestamp + 30 days;
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Vault.GovernanceWindowOpen.selector, opensAt));
        vault.startAuction(vaultId);

        skip(30 days);
        _pushFloor(14 ether);
        vm.prank(carol);
        vault.startAuction(vaultId);
        assertEq(vault.auctionPrice(vaultId), 224 ether); // 16 x the 14 ETH floor
    }

    function test_auction_ownerCanStartImmediately() public {
        _unlockByConditions();
        vm.prank(gov);
        vault.startAuction(vaultId);
        assertEq(vault.auctionPrice(vaultId), 208 ether); // 16 x the 13 ETH reserve
    }

    function test_auction_priceHalvesDailyDownToTheReserveThenHolds() public {
        _unlockByConditions();
        vm.prank(gov);
        vault.startAuction(vaultId); // 208 -> 13 over 4 days

        skip(12 hours);
        assertEq(vault.auctionPrice(vaultId), 156 ether);
        skip(12 hours);
        assertEq(vault.auctionPrice(vaultId), 104 ether);
        skip(1 days);
        assertEq(vault.auctionPrice(vaultId), 52 ether);
        skip(1 days);
        assertEq(vault.auctionPrice(vaultId), 26 ether);
        skip(12 hours);
        assertEq(vault.auctionPrice(vaultId), 19.5 ether);
        skip(12 hours);
        assertEq(vault.auctionPrice(vaultId), 13 ether);
        skip(10 days);
        assertEq(vault.auctionPrice(vaultId), 13 ether);
    }

    function test_cancelAuction_returnsTheHoldingToUnlocked() public {
        _unlockByConditions();
        vm.prank(gov);
        vault.startAuction(vaultId);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.cancelAuction(vaultId);

        vm.prank(gov);
        vault.cancelAuction(vaultId);
        assertEq(uint8(_status()), uint8(Vault.Status.Unlocked));
        vm.prank(gov);
        vault.relock(vaultId, block.timestamp + 30 days);
        assertEq(uint8(_status()), uint8(Vault.Status.Locked));
    }

    function test_buy_sendsProceedsToCollectionBudgetAndRefundsExcess() public {
        _unlockByConditions();
        vm.prank(gov);
        vault.startAuction(vaultId);
        skip(4 days);

        uint256 before = bob.balance;
        vm.prank(bob);
        vault.buy{value: 20 ether}(vaultId);

        assertEq(nft.ownerOf(1), bob);
        assertEq(before - bob.balance, 13 ether);
        assertEq(treasury.budgetOf(address(nft)), 13 ether); // bought at 10, sold at 13
        assertEq(address(vault).balance, 0);
        assertEq(uint8(_status()), uint8(Vault.Status.Released));

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Vault.WrongStatus.selector, Vault.Status.Released));
        vault.buy{value: 20 ether}(vaultId);
    }

    function test_buy_revertsBelowPrice() public {
        _unlockByConditions();
        vm.prank(gov);
        vault.startAuction(vaultId);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Vault.PriceNotMet.selector, 208 ether, 19 ether));
        vault.buy{value: 19 ether}(vaultId);
    }

    function test_auction_restartOnlyAfterItRanOut() public {
        _unlockByConditions();
        vm.prank(gov);
        vault.startAuction(vaultId);

        vm.prank(gov);
        vm.expectRevert(Vault.AuctionRunning.selector);
        vault.startAuction(vaultId);

        skip(4 days); // the price has just reached the reserve
        _pushFloor(20 ether);
        vm.prank(carol);
        vm.expectRevert(Vault.AuctionRunning.selector); // it must rest there for a day first
        vault.startAuction(vaultId);

        skip(1 days);
        _pushFloor(20 ether); // floor rose while the auction sat at 13
        vm.prank(carol);
        vault.startAuction(vaultId);
        assertEq(vault.auctionPrice(vaultId), 320 ether);
    }

    /// A public auction never goes below the unlock price, whatever the oracle says.
    function test_auction_reserveIgnoresOracleBelowUnlockPrice() public {
        _unlockByConditions();
        skip(30 days);
        _pushFloor(1); // oracle pushed down to 1 wei
        vm.prank(carol);
        vault.startAuction(vaultId);
        assertEq(vault.auctionPrice(vaultId), 208 ether);
        skip(4 days);
        assertEq(vault.auctionPrice(vaultId), 13 ether); // 130% of the 10 ETH purchase price

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Vault.PriceNotMet.selector, 13 ether, 1));
        vault.buy{value: 1}(vaultId);
    }

    function test_auction_requiresFreshOracleUnlessGovernanceSetsPrices() public {
        vm.prank(gov);
        vault.governanceUnlock(vaultId);

        vm.prank(gov);
        vm.expectRevert(Vault.StaleOracle.selector);
        vault.startAuction(vaultId);

        vm.prank(gov);
        vm.expectRevert(Vault.InvalidPrices.selector);
        vault.startAuctionWithPrices(vaultId, 1 ether, 2 ether);

        vm.prank(gov);
        vault.startAuctionWithPrices(vaultId, 4 ether, 2 ether);
        assertEq(vault.auctionPrice(vaultId), 4 ether);
    }

    function test_auction_cannotStartWhileLocked() public {
        vm.prank(gov);
        vm.expectRevert(abi.encodeWithSelector(Vault.WrongStatus.selector, Vault.Status.Locked));
        vault.startAuction(vaultId);
    }

    /// The auction price always stays between the end and start prices and never rises.
    function testFuzz_auctionPrice_boundedAndFalling(uint128 start, uint128 end, uint32 t1, uint32 t2)
        public
    {
        end = uint128(bound(end, 1, 1_000 ether));
        start = uint128(bound(start, end, 2_000 ether));
        vm.prank(gov);
        vault.governanceUnlock(vaultId);
        vm.prank(gov);
        vault.startAuctionWithPrices(vaultId, start, end);

        skip(t1);
        uint256 first = vault.auctionPrice(vaultId);
        skip(t2);
        uint256 second = vault.auctionPrice(vaultId);

        assertLe(first, start);
        assertLe(second, first);
        assertGe(second, end);
    }
}
