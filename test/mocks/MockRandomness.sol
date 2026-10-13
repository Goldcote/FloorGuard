// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IRandomnessProvider, IRandomnessConsumer} from "../../src/interfaces/IFloorGuard.sol";

/// @dev Randomness provider for tests and local chains: whoever calls `fulfill` picks the random word.
///      Never deploy this on a public network.
contract MockRandomness is IRandomnessProvider {
    uint256 public lastRequestId;
    mapping(uint256 => address) public consumerOf;

    function requestRandomness() external returns (uint256 requestId) {
        requestId = ++lastRequestId;
        consumerOf[requestId] = msg.sender;
    }

    function fulfill(uint256 requestId, uint256 randomWord) external {
        IRandomnessConsumer(consumerOf[requestId]).fulfillRandomness(requestId, randomWord);
    }
}
