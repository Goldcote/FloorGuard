// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {Vault} from "../src/Vault.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

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
        skip(180 days);
        _pushFloor(13 ether);
        vault.unlock(vaultId);
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

    // ------------------------------------------------------------------ unlocking

    function test_unlock_needsBothTimeAndPrice() public {
        _pushFloor(20 ether);
        assertFalse(vault.canUnlock(vaultId)); // price met, time not

        skip(180 days);
        _pushFloor(12.99 ether);
        assertFalse(vault.canUnlock(vaultId)); // time met, price not
        vm.expectRevert(Vault.UnlockConditionsNotMet.selector);
        vault.unlock(vaultId);

        _pushFloor(13 ether);
        assertTrue(vault.canUnlock(vaultId));
        vm.prank(carol); // permissionless
        vault.unlock(vaultId);
        assertEq(uint8(_status()), uint8(Vault.Status.Unlocked));
    }

    function test_unlock_rejectsStaleOrMissingOracle() public {
        skip(180 days);
        assertFalse(vault.canUnlock(vaultId)); // no price ever pushed

        _pushFloor(20 ether);
        skip(3 days + 1);
        assertFalse(vault.canUnlock(vaultId)); // price too old
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

        skip(90 days);
        _pushFloor(13 ether);
        assertTrue(vault.canUnlock(vaultId));
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
        assertEq(vault.auctionPrice(vaultId), 21 ether);
    }

    function test_auction_ownerCanStartImmediately() public {
        _unlockByConditions();
        vm.prank(gov);
        vault.startAuction(vaultId);
        assertEq(vault.auctionPrice(vaultId), 19.5 ether);
    }

    function test_auction_priceFallsToFloorThenHolds() public {
        _unlockByConditions();
        vm.prank(gov);
        vault.startAuction(vaultId); // 19.5 -> 13 over 3 days

        skip(1.5 days);
        assertEq(vault.auctionPrice(vaultId), 16.25 ether);
        skip(1.5 days);
        assertEq(vault.auctionPrice(vaultId), 13 ether);
        skip(10 days);
        assertEq(vault.auctionPrice(vaultId), 13 ether);
    }

    function test_buy_sendsProceedsToCollectionBudgetAndRefundsExcess() public {
        _unlockByConditions();
        vm.prank(gov);
        vault.startAuction(vaultId);
        skip(3 days);

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
        vm.expectRevert(abi.encodeWithSelector(Vault.PriceNotMet.selector, 19.5 ether, 19 ether));
        vault.buy{value: 19 ether}(vaultId);
    }

    function test_auction_restartOnlyAfterItRanOut() public {
        _unlockByConditions();
        vm.prank(gov);
        vault.startAuction(vaultId);

        vm.prank(gov);
        vm.expectRevert(Vault.AuctionRunning.selector);
        vault.startAuction(vaultId);

        skip(3 days);
        _pushFloor(8 ether); // floor fell, nobody bought at 13
        vm.prank(carol);
        vault.startAuction(vaultId);
        assertEq(vault.auctionPrice(vaultId), 12 ether);
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
