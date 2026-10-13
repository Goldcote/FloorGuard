// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Vault} from "./Vault.sol";
import {ITreasury} from "./interfaces/IFloorGuard.sol";

/// @title IPLicenseManager
/// @notice Sells time-limited licences to use the artwork of NFTs held in the Vault. Licence fees go to
///         the Treasury as buyback budget for the NFT's collection. A licence lapses when its term
///         ends, when the owner revokes it, or when the NFT leaves the Vault.
/// @dev This contract only records who paid for which licence. Whether the Vault may sublicense a
///      collection's artwork at all depends on that collection's own terms, and the licence text itself
///      lives off-chain. Nothing here is legal advice.
contract IPLicenseManager is Ownable2Step, ReentrancyGuard {
    struct Tier {
        uint128 price;
        uint40 duration;
        bool active;
    }

    struct License {
        address licensee;
        uint256 vaultId;
        uint8 tier;
        uint40 start;
        uint40 end;
        bool revoked;
        string usageScope;
    }

    uint256 public constant MAX_SCOPE_LENGTH = 280;

    Vault public immutable vault;
    ITreasury public immutable treasury;

    /// @notice Licence terms per collection. Tier numbers are the owner's to define, for example
    ///         0 personal, 1 creator, 2 commercial.
    mapping(address collection => mapping(uint8 tier => Tier)) public tiers;
    uint256 public licenseCount;
    mapping(uint256 licenseId => License) public licenses;
    mapping(address licensee => mapping(uint256 vaultId => uint256 licenseId)) public latestLicenseOf;

    event TierSet(
        address indexed collection, uint8 indexed tier, uint256 price, uint256 duration, bool active
    );
    event LicenseIssued(
        uint256 indexed licenseId,
        address indexed licensee,
        uint256 indexed vaultId,
        uint8 tier,
        uint256 end,
        uint256 fee,
        string usageScope
    );
    event LicenseRevoked(uint256 indexed licenseId);

    error NotInVault();
    error TierInactive();
    error WrongPayment(uint256 expected);
    error ScopeTooLong();
    error UnknownLicense();
    error InvalidTier();

    constructor(address owner_, Vault vault_, ITreasury treasury_) Ownable(owner_) {
        vault = vault_;
        treasury = treasury_;
    }

    /// @notice Buy a licence for the NFT in holding `vaultId`. `msg.value` must equal the tier price.
    /// @param usageScope A short description of the intended use, recorded with the licence.
    function requestLicense(uint256 vaultId, uint8 tier, string calldata usageScope)
        external
        payable
        nonReentrant
        returns (uint256 licenseId)
    {
        (address collection, bool held) = _holding(vaultId);
        if (!held) revert NotInVault();
        Tier memory t = tiers[collection][tier];
        if (!t.active) revert TierInactive();
        if (msg.value != t.price) revert WrongPayment(t.price);
        if (bytes(usageScope).length > MAX_SCOPE_LENGTH) revert ScopeTooLong();

        licenseId = ++licenseCount;
        uint40 end = uint40(block.timestamp + t.duration);
        licenses[licenseId] = License({
            licensee: msg.sender,
            vaultId: vaultId,
            tier: tier,
            start: uint40(block.timestamp),
            end: end,
            revoked: false,
            usageScope: usageScope
        });
        latestLicenseOf[msg.sender][vaultId] = licenseId;
        emit LicenseIssued(licenseId, msg.sender, vaultId, tier, end, msg.value, usageScope);
        if (msg.value != 0) treasury.depositFee{value: msg.value}(collection);
    }

    /// @notice Whether `licensee`'s most recent licence for the holding is in force.
    function hasValidLicense(address licensee, uint256 vaultId) external view returns (bool) {
        License storage l = licenses[latestLicenseOf[licensee][vaultId]];
        if (l.licensee == address(0) || l.revoked || block.timestamp >= l.end) return false;
        (, bool held) = _holding(vaultId);
        return held;
    }

    /// @notice Governance may revoke a licence for a breach of its terms. No refund is paid.
    function revokeLicense(uint256 licenseId) external onlyOwner {
        License storage l = licenses[licenseId];
        if (l.licensee == address(0)) revert UnknownLicense();
        l.revoked = true;
        emit LicenseRevoked(licenseId);
    }

    function setTier(address collection, uint8 tier, uint128 price, uint40 duration, bool active)
        external
        onlyOwner
    {
        if (active && duration == 0) revert InvalidTier();
        tiers[collection][tier] = Tier(price, duration, active);
        emit TierSet(collection, tier, price, duration, active);
    }

    /// @dev An NFT is licensable while the Vault holds it and it is not being auctioned.
    function _holding(uint256 vaultId) private view returns (address collection, bool held) {
        Vault.Status status;
        (collection,,,,,, status) = vault.holdings(vaultId);
        held = status == Vault.Status.Locked || status == Vault.Status.Unlocked;
    }
}
