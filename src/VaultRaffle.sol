// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IPoints, IVaultRaffle, IRandomnessProvider, IRandomnessConsumer} from "./interfaces/IFloorGuard.sol";

/// @title VaultRaffle
/// @notice Raffles vault NFTs to points holders. Nobody buys tickets: each holder's chance is their
///         share of all points when the randomness arrives. The winner then loses most of their points.
/// @dev Point weights are frozen from `draw` until the randomness arrives. Otherwise anyone who saw the
///      random word before it landed could add just enough points to steer the result.
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
    /// @notice Wait between a reset and the next draw, so points cannot be kept frozen without a break.
    uint256 public constant REDRAW_COOLDOWN = 1 hours;

    IPoints public immutable points;
    /// @notice The only address allowed to open raffles (the Vault).
    address public immutable vault;
    IRandomnessProvider public randomness;
    /// @notice Time between a raffle opening and its earliest draw, so holders can see it coming.
    uint256 public announcePeriod = 7 days;

    /// @notice After any draw is reset, no draw can be requested before this time. Together with the
    ///         rule of one draw at a time, this leaves a window in which points can be activated.
    uint256 public nextDrawAt;

    uint256 public raffleCount;
    mapping(uint256 raffleId => Raffle) public raffles;
    mapping(uint256 requestId => uint256 raffleId) public raffleOfRequest;
    /// @notice The only randomness request a raffle will accept; cleared by `resetDraw`.
    mapping(uint256 raffleId => uint256 requestId) public currentRequest;

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
    error StaleRequest();
    error DrawInFlight();

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
        if (block.timestamp < nextDrawAt) revert TooEarly(nextDrawAt);
        // one draw at a time: overlapping draws could keep point weights frozen without a break
        if (points.freezeCount() != 0) revert DrawInFlight();
        if (points.totalPoints() == 0) revert NoPoints();

        r.status = Status.Drawing;
        r.requestedAt = uint40(block.timestamp);
        points.freeze();
        uint256 requestId = randomness.requestRandomness();
        raffleOfRequest[requestId] = raffleId;
        currentRequest[raffleId] = requestId;
        emit DrawRequested(raffleId, requestId);
    }

    /// @inheritdoc IRandomnessConsumer
    function fulfillRandomness(uint256 requestId, uint256 randomWord) external {
        if (msg.sender != address(randomness)) revert NotRandomness();
        uint256 raffleId = raffleOfRequest[requestId];
        Raffle storage r = raffles[raffleId];
        if (r.status != Status.Drawing) revert WrongStatus(r.status);
        if (currentRequest[raffleId] != requestId) revert StaleRequest();
        delete raffleOfRequest[requestId];

        // Randomness that arrives after the timeout is not used. Otherwise whoever saw the result first
        // could choose between letting it stand and resetting the draw.
        if (points.totalPoints() == 0 || block.timestamp >= r.requestedAt + DRAW_TIMEOUT) {
            _reset(raffleId, r);
            return;
        }
        delete currentRequest[raffleId];
        address winner = points.pick(randomWord);
        r.winner = winner;
        r.status = Status.Won;
        points.resetWinner(winner);
        points.unfreeze();
        emit WinnerDrawn(raffleId, winner);
    }

    /// @notice Reopen a raffle whose randomness request was never answered.
    function resetDraw(uint256 raffleId) external {
        Raffle storage r = raffles[raffleId];
        if (r.status != Status.Drawing) revert WrongStatus(r.status);
        uint256 readyAt = r.requestedAt + DRAW_TIMEOUT;
        if (block.timestamp < readyAt) revert TooEarly(readyAt);
        _reset(raffleId, r);
    }

    function _reset(uint256 raffleId, Raffle storage r) private {
        r.status = Status.Open;
        nextDrawAt = block.timestamp + REDRAW_COOLDOWN;
        delete currentRequest[raffleId];
        points.unfreeze();
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
