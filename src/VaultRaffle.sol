// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IPoints, IVaultRaffle, IRandomnessProvider, IRandomnessConsumer} from "./interfaces/IFloorGuard.sol";

/// @title VaultRaffle
/// @notice Raffles vault NFTs to points holders. Nobody buys tickets: each holder's chance is their
///         share of all points when the randomness arrives. The winner then loses most of their points.
/// @dev The winner is chosen inside the randomness callback. Choosing later would let anyone who has seen
///      the random word shift the point weights to steer the result.
contract VaultRaffle is IVaultRaffle, IRandomnessConsumer, Ownable2Step {
    enum Status {
        None,
        Open,
        Drawing,
        Won,
        Claimed
    }

    struct Raffle {
        address collection;
        uint256 tokenId;
        uint40 drawAfter;
        uint40 requestedAt;
        Status status;
        address winner;
    }

    /// @notice A draw stuck without randomness for this long can be reset by anyone.
    uint256 public constant DRAW_TIMEOUT = 1 days;

    IPoints public immutable points;
    /// @notice The only address allowed to open raffles (the Vault).
    address public immutable vault;
    IRandomnessProvider public randomness;
    /// @notice Time between a raffle opening and its earliest draw, so holders can see it coming.
    uint256 public announcePeriod = 7 days;

    uint256 public raffleCount;
    mapping(uint256 raffleId => Raffle) public raffles;
    mapping(uint256 requestId => uint256 raffleId) public raffleOfRequest;

    event RaffleOpened(
        uint256 indexed raffleId, address indexed collection, uint256 indexed tokenId, uint256 drawAfter
    );
    event DrawRequested(uint256 indexed raffleId, uint256 requestId);
    event DrawReset(uint256 indexed raffleId);
    event WinnerDrawn(uint256 indexed raffleId, address indexed winner);
    event PrizeClaimed(uint256 indexed raffleId, address indexed winner);
    event RandomnessSet(address randomness);
    event AnnouncePeriodSet(uint256 announcePeriod);

    error NotVault();
    error NotRandomness();
    error WrongStatus(Status status);
    error TooEarly(uint256 readyAt);
    error NoPoints();

    constructor(address owner_, IPoints points_, address vault_, IRandomnessProvider randomness_)
        Ownable(owner_)
    {
        points = points_;
        vault = vault_;
        randomness = randomness_;
    }

    /// @inheritdoc IVaultRaffle
    function open(address collection, uint256 tokenId) external returns (uint256 raffleId) {
        if (msg.sender != vault) revert NotVault();
        raffleId = ++raffleCount;
        uint256 drawAfter = block.timestamp + announcePeriod;
        raffles[raffleId] = Raffle({
            collection: collection,
            tokenId: tokenId,
            drawAfter: uint40(drawAfter),
            requestedAt: 0,
            status: Status.Open,
            winner: address(0)
        });
        emit RaffleOpened(raffleId, collection, tokenId, drawAfter);
    }

    /// @notice Request randomness for an open raffle. Anyone may call after the announce period.
    function draw(uint256 raffleId) external {
        Raffle storage r = raffles[raffleId];
        if (r.status != Status.Open) revert WrongStatus(r.status);
        if (block.timestamp < r.drawAfter) revert TooEarly(r.drawAfter);
        if (points.totalPoints() == 0) revert NoPoints();

        r.status = Status.Drawing;
        r.requestedAt = uint40(block.timestamp);
        uint256 requestId = randomness.requestRandomness();
        raffleOfRequest[requestId] = raffleId;
        emit DrawRequested(raffleId, requestId);
    }

    /// @inheritdoc IRandomnessConsumer
    function fulfillRandomness(uint256 requestId, uint256 randomWord) external {
        if (msg.sender != address(randomness)) revert NotRandomness();
        uint256 raffleId = raffleOfRequest[requestId];
        Raffle storage r = raffles[raffleId];
        if (r.status != Status.Drawing) revert WrongStatus(r.status);
        delete raffleOfRequest[requestId];

        if (points.totalPoints() == 0) {
            r.status = Status.Open;
            emit DrawReset(raffleId);
            return;
        }
        address winner = points.pick(randomWord);
        r.winner = winner;
        r.status = Status.Won;
        points.resetWinner(winner);
        emit WinnerDrawn(raffleId, winner);
    }

    /// @notice Reopen a raffle whose randomness request was never answered.
    function resetDraw(uint256 raffleId) external {
        Raffle storage r = raffles[raffleId];
        if (r.status != Status.Drawing) revert WrongStatus(r.status);
        uint256 readyAt = r.requestedAt + DRAW_TIMEOUT;
        if (block.timestamp < readyAt) revert TooEarly(readyAt);
        r.status = Status.Open;
        emit DrawReset(raffleId);
    }

    /// @notice Send the prize to the winner. Anyone may call.
    function claim(uint256 raffleId) external {
        Raffle storage r = raffles[raffleId];
        if (r.status != Status.Won) revert WrongStatus(r.status);
        r.status = Status.Claimed;
        IERC721(r.collection).transferFrom(address(this), r.winner, r.tokenId);
        emit PrizeClaimed(raffleId, r.winner);
    }

    /// @dev Changing the provider strands any draw in flight; it can be reopened with `resetDraw`.
    function setRandomness(IRandomnessProvider randomness_) external onlyOwner {
        randomness = randomness_;
        emit RandomnessSet(address(randomness_));
    }

    function setAnnouncePeriod(uint256 announcePeriod_) external onlyOwner {
        announcePeriod = announcePeriod_;
        emit AnnouncePeriodSet(announcePeriod_);
    }
}
