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
    uint256 public constant MAX_DURATION = 3650 days;

    Vault public immutable vault;
    ITreasury public immutable treasury;

    /// @notice Licence terms per collection. Tier numbers are the owner's to define, for example
    ///         0 personal, 1 creator, 2 commercial.
    mapping(address collection => mapping(uint8 tier => Tier)) public tiers;
    uint256 public licenseCount;
    mapping(uint256 licenseId => License) public licenses;
    /// @notice The licence that counts for a licensee and holding: the one in force that ends last.
    mapping(address licensee => mapping(uint256 vaultId => uint256 licenseId)) public latestLicenseOf;
    /// @notice Set when a licence is revoked: the licensee cannot buy another for that holding until
    ///         the owner lifts the ban.
    mapping(address licensee => mapping(uint256 vaultId => bool)) public isBanned;

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
    event BanSet(address indexed licensee, uint256 indexed vaultId, bool banned);

    error NotInVault();
    error TierInactive();
    error WrongPayment(uint256 expected);
    error ScopeTooLong();
    error UnknownLicense();
    error InvalidTier();
    error Banned();

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
        // Only locked holdings can be licensed: an unlocked one may go to auction at any moment.
        (address collection, Vault.Status status) = _holding(vaultId);
        if (status != Vault.Status.Locked) revert NotInVault();
        if (isBanned[msg.sender][vaultId]) revert Banned();
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
        // a shorter licence never hides a longer one that is still in force
        License storage current = licenses[latestLicenseOf[msg.sender][vaultId]];
        if (current.revoked || current.end <= block.timestamp || end >= current.end) {
            latestLicenseOf[msg.sender][vaultId] = licenseId;
        }
        emit LicenseIssued(licenseId, msg.sender, vaultId, tier, end, msg.value, usageScope);
        if (msg.value != 0) treasury.depositFee{value: msg.value}(collection);
    }

    /// @notice Whether `licensee` holds a licence in force for the holding.
    function hasValidLicense(address licensee, uint256 vaultId) external view returns (bool valid) {
        (valid,,) = validLicenseOf(licensee, vaultId);
    }

    /// @notice The licence in force for `licensee` on the holding, with its tier and end time. A licence
    ///         is in force until its term ends, it is revoked, or the NFT goes to auction or leaves the
    ///         Vault.
    function validLicenseOf(address licensee, uint256 vaultId)
        public
        view
        returns (bool valid, uint8 tier, uint40 end)
    {
        License storage l = licenses[latestLicenseOf[licensee][vaultId]];
        if (l.licensee == address(0) || l.revoked || block.timestamp >= l.end) return (false, 0, 0);
        (, Vault.Status status) = _holding(vaultId);
        if (status != Vault.Status.Locked && status != Vault.Status.Unlocked) return (false, 0, 0);
        return (true, l.tier, l.end);
    }

    /// @notice Governance may revoke a licence for a breach of its terms. No refund is paid, and the
    ///         licensee is banned from licensing that holding again until `setBan` lifts it.
    function revokeLicense(uint256 licenseId) external onlyOwner {
        License storage l = licenses[licenseId];
        if (l.licensee == address(0)) revert UnknownLicense();
        l.revoked = true;
        isBanned[l.licensee][l.vaultId] = true;
        emit LicenseRevoked(licenseId);
        emit BanSet(l.licensee, l.vaultId, true);
    }

    function setTier(address collection, uint8 tier, uint128 price, uint40 duration, bool active)
        external
        onlyOwner
    {
        if (duration > MAX_DURATION || (active && duration == 0)) revert InvalidTier();
        tiers[collection][tier] = Tier(price, duration, active);
        emit TierSet(collection, tier, price, duration, active);
    }

    function setBan(address licensee, uint256 vaultId, bool banned) external onlyOwner {
        isBanned[licensee][vaultId] = banned;
        emit BanSet(licensee, vaultId, banned);
    }

    function _holding(uint256 vaultId) private view returns (address collection, Vault.Status status) {
        (collection,,,,,, status) = vault.holdings(vaultId);
    }
}
