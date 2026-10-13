// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {IPLicenseManager} from "../src/IPLicenseManager.sol";

contract IPLicenseManagerTest is Base {
    uint256 internal vaultId;
    uint8 internal constant CREATOR = 1;

    function setUp() public override {
        super.setUp();
        vm.prank(gov);
        engine.configureBid(address(nft), 10 ether, 15 ether, 0, 0, true);
        treasury.deposit{value: 10 ether}(address(nft));
        _mintApproved(alice, 1, address(engine));
        vm.prank(alice);
        vaultId = engine.sell(address(nft), 1, 0); // the budget is now empty

        vm.prank(gov);
        licenses.setTier(address(nft), CREATOR, 0.1 ether, 90 days, true);
    }

    function _request(address who) internal returns (uint256) {
        vm.prank(who);
        return licenses.requestLicense{value: 0.1 ether}(vaultId, CREATOR, "YouTube thumbnails");
    }

    function test_license_feeFundsBuybacksAndIsValidForItsTerm() public {
        uint256 id = _request(bob);
        assertEq(treasury.budgetOf(address(nft)), 0.1 ether);
        assertTrue(licenses.hasValidLicense(bob, vaultId));
        assertFalse(licenses.hasValidLicense(carol, vaultId));

        (
            address licensee,
            uint256 holding,
            uint8 tier,
            uint40 start,
            uint40 end,
            bool revoked,
            string memory scope
        ) = licenses.licenses(id);
        assertEq(licensee, bob);
        assertEq(holding, vaultId);
        assertEq(tier, CREATOR);
        assertEq(end - start, 90 days);
        assertFalse(revoked);
        assertEq(scope, "YouTube thumbnails");

        skip(90 days);
        assertFalse(licenses.hasValidLicense(bob, vaultId));
    }

    function test_license_validation() public {
        vm.startPrank(bob);
        vm.expectRevert(abi.encodeWithSelector(IPLicenseManager.WrongPayment.selector, 0.1 ether));
        licenses.requestLicense{value: 0.05 ether}(vaultId, CREATOR, "");
        vm.expectRevert(IPLicenseManager.TierInactive.selector);
        licenses.requestLicense{value: 0.1 ether}(vaultId, 2, "");
        vm.expectRevert(IPLicenseManager.NotInVault.selector);
        licenses.requestLicense{value: 0.1 ether}(99, CREATOR, "");
        vm.expectRevert(IPLicenseManager.ScopeTooLong.selector);
        licenses.requestLicense{value: 0.1 ether}(vaultId, CREATOR, string(new bytes(281)));
        vm.stopPrank();
    }

    function test_revoke_endsTheLicenceAndIsOwnerOnly() public {
        uint256 id = _request(bob);
        vm.prank(bob);
        vm.expectRevert();
        licenses.revokeLicense(id);
        vm.prank(gov);
        vm.expectRevert(IPLicenseManager.UnknownLicense.selector);
        licenses.revokeLicense(99);

        vm.prank(gov);
        licenses.revokeLicense(id);
        assertFalse(licenses.hasValidLicense(bob, vaultId));
    }

    function test_licenceLapsesWhenTheNftLeavesTheVault() public {
        _request(bob);
        vm.startPrank(gov);
        vault.governanceUnlock(vaultId);
        assertTrue(licenses.hasValidLicense(bob, vaultId)); // unlocked but still held
        vault.startAuctionWithPrices(vaultId, 2 ether, 1 ether);
        vm.stopPrank();
        assertFalse(licenses.hasValidLicense(bob, vaultId));

        vm.prank(carol);
        vm.expectRevert(IPLicenseManager.NotInVault.selector);
        licenses.requestLicense{value: 0.1 ether}(vaultId, CREATOR, "");
    }

    function test_freeTierAndTierValidation() public {
        vm.startPrank(gov);
        vm.expectRevert(IPLicenseManager.InvalidTier.selector);
        licenses.setTier(address(nft), 0, 0, 0, true);
        licenses.setTier(address(nft), 0, 0, 30 days, true);
        vm.stopPrank();

        vm.prank(carol);
        licenses.requestLicense(vaultId, 0, "profile picture");
        assertTrue(licenses.hasValidLicense(carol, vaultId));
        assertEq(treasury.budgetOf(address(nft)), 0);
    }

    function test_projectShareAppliesToLicenceFees() public {
        address project = makeAddr("project");
        vm.prank(gov);
        treasury.setProjectShare(address(nft), project, 2_000);
        _request(bob);
        assertEq(treasury.owedTo(project), 0.02 ether);
        assertEq(treasury.budgetOf(address(nft)), 0.08 ether);
    }
}
