// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IFloorOracle, ISaleRecorder} from "../interfaces/IFloorGuard.sol";

/// @title SalesFloorOracle
/// @notice Floor price derived from the protocol's own floor-type sales: collection-offer fills on the
///         Marketplace and BuybackEngine fills. In both the seller picks which token to give up, so the
///         price reflects the cheapest token. The floor is the lower median of the last `WINDOW` recent
///         sales.
/// @dev Manipulable when volume is thin: moving the median takes `WINDOW / 2 + 1` wash sales, each of
///      which only costs the marketplace fee. Do not let large sums settle on this oracle for a
///      collection without deep organic volume.
contract SalesFloorOracle is IFloorOracle, ISaleRecorder, Ownable2Step {
    struct Observation {
        uint128 price;
        uint40 timestamp;
    }

    uint256 public constant WINDOW = 7;

    /// @notice Observations older than this are ignored.
    uint256 public maxAge = 7 days;
    /// @notice Fewer usable observations than this and `floorPrice` reverts.
    uint256 public minObservations = 3;

    mapping(address => bool) public isReporter;
    mapping(address collection => Observation[WINDOW]) private _ring;
    mapping(address collection => uint256) public saleCount;

    event SaleRecorded(address indexed collection, uint256 price);
    event ReporterSet(address indexed reporter, bool allowed);
    event ParamsSet(uint256 maxAge, uint256 minObservations);

    error NotReporter();
    error InsufficientData(uint256 usable, uint256 required);
    error InvalidParams();

    constructor(address owner_) Ownable(owner_) {}

    /// @inheritdoc ISaleRecorder
    function recordSale(address collection, uint256 price) external {
        if (!isReporter[msg.sender]) revert NotReporter();
        uint256 count = saleCount[collection]++;
        _ring[collection][count % WINDOW] = Observation(uint128(price), uint40(block.timestamp));
        emit SaleRecorded(collection, price);
    }

    /// @inheritdoc IFloorOracle
    function floorPrice(address collection) external view returns (uint256 price, uint256 updatedAt) {
        Observation[WINDOW] storage ring = _ring[collection];
        uint256[WINDOW] memory prices;
        uint256 n;
        for (uint256 i; i < WINDOW; ++i) {
            Observation memory obs = ring[i];
            if (obs.timestamp == 0 || obs.timestamp + maxAge < block.timestamp) continue;
            if (obs.timestamp > updatedAt) updatedAt = obs.timestamp;
            // insertion sort, ascending
            uint256 j = n++;
            for (; j > 0 && prices[j - 1] > obs.price; --j) {
                prices[j] = prices[j - 1];
            }
            prices[j] = obs.price;
        }
        if (n < minObservations) revert InsufficientData(n, minObservations);
        price = prices[(n - 1) / 2];
    }

    function setReporter(address reporter, bool allowed) external onlyOwner {
        isReporter[reporter] = allowed;
        emit ReporterSet(reporter, allowed);
    }

    function setParams(uint256 maxAge_, uint256 minObservations_) external onlyOwner {
        if (maxAge_ == 0 || minObservations_ == 0 || minObservations_ > WINDOW) revert InvalidParams();
        maxAge = maxAge_;
        minObservations = minObservations_;
        emit ParamsSet(maxAge_, minObservations_);
    }
}
