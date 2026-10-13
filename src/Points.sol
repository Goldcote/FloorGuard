// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPoints} from "./interfaces/IFloorGuard.sol";

/// @title Points
/// @notice Non-transferable points earned in proportion to the protocol fees a user generates. Points
///         are the weights in vault NFT raffles. Because they follow fees paid, farming them always
///         funds buybacks.
/// @dev Earning points is one storage write. Activated balances live in the leaves of a 16-ary sum tree:
///      activating costs `DEPTH + 1` writes and picking a point-weighted random holder costs at most
///      `16 * DEPTH` reads, with no loop over users.
contract Points is IPoints, Ownable2Step {
    uint256 private constant ARITY_BITS = 4;
    uint256 private constant ARITY = 1 << ARITY_BITS;
    uint256 private constant DEPTH = 6;
    uint256 public constant MAX_USERS = 1 << (ARITY_BITS * DEPTH);
    uint256 public constant BPS = 10_000;

    /// @notice Points credited per 1 ETH of fees, per calling module. Zero means not authorised.
    mapping(address source => uint256) public rateOf;
    /// @notice The only address allowed to reset a winner (the VaultRaffle).
    address public raffle;
    /// @notice Share of their points a raffle winner keeps.
    uint256 public winnerKeepBps = 2_000;

    /// @notice Number of raffle draws in flight. While non-zero, pending points cannot be activated.
    uint256 public freezeCount;
    /// @notice Points earned but not yet activated; not counted in `pointsOf` or `totalPoints`.
    mapping(address => uint256) public pendingOf;

    address[] private _users;
    mapping(address => uint256) private _indexPlusOne;
    /// @dev `_nodes[level][i]` is the sum of the 16 children below it; level 0 holds user balances.
    mapping(uint256 level => mapping(uint256 index => uint256)) private _nodes;

    event PointsCredited(address indexed user, address indexed source, uint256 amount);
    event PointsActivated(address indexed user, uint256 amount);
    event WinnerReset(address indexed user, uint256 kept, uint256 removed);
    event RateSet(address indexed source, uint256 pointsPerEth);
    event RaffleSet(address raffle);
    event WinnerKeepSet(uint256 bps);

    error NotAuthorised();
    error NoPoints();
    error Frozen();
    error TooManyUsers();
    error InvalidBps();

    constructor(address owner_) Ownable(owner_) {}

    /// @inheritdoc IPoints
    /// @dev Costs one storage write, so trades stay cheap. The credit lands in `pendingOf` and only
    ///      counts in raffles once it has been moved into the tree with `flush`.
    function creditFee(address user, uint256 feeWei) external {
        uint256 rate = rateOf[msg.sender];
        if (rate == 0) revert NotAuthorised();
        uint256 amount = feeWei * rate / 1 ether;
        if (amount == 0) return;
        pendingOf[user] += amount;
        emit PointsCredited(user, msg.sender, amount);
    }

    /// @notice Activate a user's pending points so they count in raffles. Anyone may call for anyone,
    ///         except while a raffle draw is in flight.
    function flush(address user) public {
        if (freezeCount != 0) revert Frozen();
        uint256 amount = pendingOf[user];
        if (amount == 0) return;
        delete pendingOf[user];

        uint256 index = _indexPlusOne[user];
        if (index == 0) {
            if (_users.length == MAX_USERS) revert TooManyUsers();
            _users.push(user);
            index = _users.length;
            _indexPlusOne[user] = index;
        }
        _update(index - 1, amount, true);
        emit PointsActivated(user, amount);
    }

    function flushMany(address[] calldata users) external {
        for (uint256 i; i < users.length; ++i) {
            flush(users[i]);
        }
    }

    /// @inheritdoc IPoints
    function freeze() external {
        if (msg.sender != raffle) revert NotAuthorised();
        ++freezeCount;
    }

    /// @inheritdoc IPoints
    function unfreeze() external {
        if (msg.sender != raffle) revert NotAuthorised();
        --freezeCount;
    }

    /// @notice Activated points: the user's weight in raffles.
    function pointsOf(address user) public view returns (uint256) {
        uint256 index = _indexPlusOne[user];
        return index == 0 ? 0 : _nodes[0][index - 1];
    }

    /// @inheritdoc IPoints
    function totalPoints() public view returns (uint256) {
        return _nodes[DEPTH][0];
    }

    function userCount() external view returns (uint256) {
        return _users.length;
    }

    /// @notice The holder owning point number `randomWord % totalPoints()`, so each holder is picked
    ///         with probability proportional to their points.
    function pick(uint256 randomWord) external view returns (address) {
        uint256 total = totalPoints();
        if (total == 0) revert NoPoints();
        uint256 target = randomWord % total;
        uint256 index;
        for (uint256 level = DEPTH; level > 0; --level) {
            index <<= ARITY_BITS;
            mapping(uint256 => uint256) storage children = _nodes[level - 1];
            for (uint256 i; i < ARITY; ++i) {
                uint256 weight = children[index + i];
                if (target < weight) {
                    index += i;
                    break;
                }
                target -= weight;
            }
        }
        return _users[index];
    }

    /// @inheritdoc IPoints
    function resetWinner(address user) external {
        if (msg.sender != raffle) revert NotAuthorised();
        uint256 balance = pointsOf(user);
        uint256 removed = balance - balance * winnerKeepBps / BPS;
        if (removed != 0) _update(_indexPlusOne[user] - 1, removed, false);
        emit WinnerReset(user, balance - removed, removed);
    }

    function setRate(address source, uint256 pointsPerEth) external onlyOwner {
        rateOf[source] = pointsPerEth;
        emit RateSet(source, pointsPerEth);
    }

    function setRaffle(address raffle_) external onlyOwner {
        raffle = raffle_;
        emit RaffleSet(raffle_);
    }

    function setWinnerKeepBps(uint256 bps) external onlyOwner {
        if (bps > BPS) revert InvalidBps();
        winnerKeepBps = bps;
        emit WinnerKeepSet(bps);
    }

    function _update(uint256 leaf, uint256 amount, bool add) private {
        for (uint256 level; level <= DEPTH; ++level) {
            uint256 index = leaf >> (ARITY_BITS * level);
            if (add) _nodes[level][index] += amount;
            else _nodes[level][index] -= amount;
        }
    }
}
