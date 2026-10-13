// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IRandomnessProvider, IRandomnessConsumer} from "../interfaces/IFloorGuard.sol";

interface IVRFCoordinatorV2Plus {
    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }

    function requestRandomWords(RandomWordsRequest calldata req) external returns (uint256 requestId);
}

/// @title ChainlinkVRFRandomness
/// @notice Adapter between the protocol's randomness interface and a Chainlink VRF v2.5 subscription.
///         This contract must be added as a consumer of the subscription.
/// @dev Written against the published v2.5 coordinator interface. Not yet tested against a live
///      coordinator.
contract ChainlinkVRFRandomness is IRandomnessProvider, Ownable2Step {
    bytes4 private constant EXTRA_ARGS_V1_TAG = bytes4(keccak256("VRF ExtraArgsV1"));

    IVRFCoordinatorV2Plus public immutable coordinator;
    IRandomnessConsumer public immutable consumer;

    bytes32 public keyHash;
    uint256 public subscriptionId;
    uint16 public requestConfirmations = 3;
    /// @dev Must cover VaultRaffle.fulfillRandomness, which walks the points tree and resets the winner.
    uint32 public callbackGasLimit = 600_000;
    bool public nativePayment;

    event ConfigSet(
        bytes32 keyHash,
        uint256 subscriptionId,
        uint16 requestConfirmations,
        uint32 callbackGasLimit,
        bool nativePayment
    );

    error NotConsumer();
    error NotCoordinator();

    constructor(
        address owner_,
        IVRFCoordinatorV2Plus coordinator_,
        IRandomnessConsumer consumer_,
        bytes32 keyHash_,
        uint256 subscriptionId_
    ) Ownable(owner_) {
        coordinator = coordinator_;
        consumer = consumer_;
        keyHash = keyHash_;
        subscriptionId = subscriptionId_;
    }

    /// @inheritdoc IRandomnessProvider
    function requestRandomness() external returns (uint256 requestId) {
        if (msg.sender != address(consumer)) revert NotConsumer();
        return coordinator.requestRandomWords(
            IVRFCoordinatorV2Plus.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: 1,
                extraArgs: abi.encodeWithSelector(EXTRA_ARGS_V1_TAG, nativePayment)
            })
        );
    }

    /// @notice Called by the VRF coordinator with the random words.
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        if (msg.sender != address(coordinator)) revert NotCoordinator();
        consumer.fulfillRandomness(requestId, randomWords[0]);
    }

    function setConfig(
        bytes32 keyHash_,
        uint256 subscriptionId_,
        uint16 requestConfirmations_,
        uint32 callbackGasLimit_,
        bool nativePayment_
    ) external onlyOwner {
        keyHash = keyHash_;
        subscriptionId = subscriptionId_;
        requestConfirmations = requestConfirmations_;
        callbackGasLimit = callbackGasLimit_;
        nativePayment = nativePayment_;
        emit ConfigSet(keyHash_, subscriptionId_, requestConfirmations_, callbackGasLimit_, nativePayment_);
    }
}
