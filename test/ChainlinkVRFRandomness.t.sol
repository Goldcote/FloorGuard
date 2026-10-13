// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {ChainlinkVRFRandomness, IVRFCoordinatorV2Plus} from "../src/randomness/ChainlinkVRFRandomness.sol";
import {IRandomnessProvider} from "../src/interfaces/IFloorGuard.sol";

/// @dev Stands in for the VRF v2.5 coordinator: records the request and lets the test answer it.
contract MockCoordinator is IVRFCoordinatorV2Plus {
    uint256 public lastRequestId;
    RandomWordsRequest public lastRequest;
    address public lastConsumer;

    function requestRandomWords(RandomWordsRequest calldata req) external returns (uint256 requestId) {
        requestId = uint256(keccak256(abi.encode(++lastRequestId)));
        lastRequest = req;
        lastConsumer = msg.sender;
    }

    function fulfill(uint256 requestId, uint256 word, uint256 gasLimit) external returns (bool ok) {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        (ok,) = lastConsumer.call{gas: gasLimit}(
            abi.encodeCall(ChainlinkVRFRandomness.rawFulfillRandomWords, (requestId, words))
        );
    }
}

/// @dev Runs the games through the real adapter and a mock coordinator.
contract ChainlinkVRFRandomnessTest is Base {
    MockCoordinator internal coordinator;
    ChainlinkVRFRandomness internal adapter;
    bytes32 internal constant KEY_HASH = keccak256("lane");

    function setUp() public override {
        super.setUp();
        coordinator = new MockCoordinator();
        adapter = new ChainlinkVRFRandomness(gov, coordinator, games, KEY_HASH, 42);
        vm.prank(gov);
        games.setRandomness(IRandomnessProvider(address(adapter)));
        games.fundBankroll{value: 1_000 ether}();
    }

    function test_request_carriesTheSubscriptionConfig() public {
        vm.prank(alice);
        games.play{value: 1 ether}(address(nft), 5_000);

        (
            bytes32 keyHash,
            uint256 subId,
            uint16 confirmations,
            uint32 gasLimit,
            uint32 numWords,
            bytes memory extraArgs
        ) = coordinator.lastRequest();
        assertEq(keyHash, KEY_HASH);
        assertEq(subId, 42);
        assertEq(confirmations, 3);
        assertEq(gasLimit, 600_000);
        assertEq(numWords, 1);
        // VRFV2PlusClient._argsToBytes(ExtraArgsV1({nativePayment: false}))
        assertEq(extraArgs, abi.encodeWithSelector(bytes4(keccak256("VRF ExtraArgsV1")), false));
    }

    function test_fulfil_settlesTheBetWithinTheCallbackGasLimit() public {
        vm.prank(alice);
        uint256 id = games.play{value: 1 ether}(address(nft), 5_000);
        uint256 before = alice.balance;
        assertTrue(coordinator.fulfill(id, 0, 600_000));
        assertEq(alice.balance - before, 1.96 ether);
    }

    function test_onlyTheConsumerMayRequestAndOnlyTheCoordinatorMayFulfil() public {
        vm.prank(alice);
        vm.expectRevert(ChainlinkVRFRandomness.NotConsumer.selector);
        adapter.requestRandomness();

        uint256[] memory words = new uint256[](1);
        vm.prank(alice);
        vm.expectRevert(ChainlinkVRFRandomness.NotCoordinator.selector);
        adapter.rawFulfillRandomWords(1, words);
    }

    function test_setConfig_ownerOnlyAndUsedByTheNextRequest() public {
        vm.prank(alice);
        vm.expectRevert();
        adapter.setConfig(KEY_HASH, 7, 10, 300_000, true);

        vm.prank(gov);
        adapter.setConfig(KEY_HASH, 7, 10, 300_000, true);
        vm.prank(alice);
        games.play{value: 1 ether}(address(nft), 5_000);
        (, uint256 subId, uint16 confirmations, uint32 gasLimit,, bytes memory extraArgs) =
            coordinator.lastRequest();
        assertEq(subId, 7);
        assertEq(confirmations, 10);
        assertEq(gasLimit, 300_000);
        assertEq(extraArgs, abi.encodeWithSelector(bytes4(keccak256("VRF ExtraArgsV1")), true));
    }
}
