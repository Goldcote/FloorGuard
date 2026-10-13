// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IFloorOracle} from "../interfaces/IFloorGuard.sol";

/// @title PushFloorOracle
/// @notice Floor prices pushed by trusted reporters from off-chain market data. A bridge for collections
///         whose trading happens mostly on other venues.
/// @dev Fully trusts its reporters. Use a multisig or an attested feed, not a single hot key.
contract PushFloorOracle is IFloorOracle, Ownable2Step {
    struct Price {
        uint128 price;
        uint40 updatedAt;
    }

    mapping(address => bool) public isReporter;
    mapping(address collection => Price) private _prices;

    event FloorPushed(address indexed collection, uint256 price, address indexed reporter);
    event ReporterSet(address indexed reporter, bool allowed);

    error NotReporter();
    error NoPrice();
    error InvalidPrice();

    constructor(address owner_) Ownable(owner_) {}

    function pushFloor(address collection, uint256 price) external {
        if (!isReporter[msg.sender]) revert NotReporter();
        if (price == 0 || price > type(uint128).max) revert InvalidPrice();
        _prices[collection] = Price(uint128(price), uint40(block.timestamp));
        emit FloorPushed(collection, price, msg.sender);
    }

    /// @inheritdoc IFloorOracle
    function floorPrice(address collection) external view returns (uint256 price, uint256 updatedAt) {
        Price memory p = _prices[collection];
        if (p.updatedAt == 0) revert NoPrice();
        return (p.price, p.updatedAt);
    }

    function setReporter(address reporter, bool allowed) external onlyOwner {
        isReporter[reporter] = allowed;
        emit ReporterSet(reporter, allowed);
    }
}
