// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Finishes the ownership handover started by Deploy. Broadcast it from the OWNER account.
///
/// Without a timelock it calls `acceptOwnership()` on every contract whose pending owner is the caller.
/// With a timelock, run it twice: `STEP=schedule` queues the acceptance in the timelock, and after the
/// delay `STEP=execute` carries it out.
///
/// A multisig cannot broadcast a Foundry script. Run this without `--broadcast` to print the calls, and
/// submit the same calls from the multisig.
contract AcceptOwnership is Script {
    using stdJson for string;

    bytes32 internal constant SALT = keccak256("floorguard.acceptOwnership");

    function run() external {
        string memory json = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        address timelock = json.readAddress(".timelock");
        address expected = timelock == address(0) ? json.readAddress(".owner") : timelock;

        string[13] memory keys = [
            ".treasury",
            ".marketplace",
            ".buybackEngine",
            ".vault",
            ".predictionMarket",
            ".points",
            ".vaultRaffle",
            ".games",
            ".ticketRaffle",
            ".ipLicenseManager",
            ".salesFloorOracle",
            ".pushFloorOracle",
            ".randomness"
        ];
        // collect the contracts that are waiting for `expected` to accept
        address[] memory targets = new address[](keys.length + 2);
        uint256 n;
        for (uint256 i; i < keys.length; ++i) {
            n = _add(targets, n, json.readAddress(keys[i]), expected);
        }
        n = _add(targets, n, json.readAddress(".gamesRandomness"), expected);
        n = _add(targets, n, json.readAddress(".ticketRaffleRandomness"), expected);
        if (n == 0) {
            console2.log("Nothing is waiting to be accepted.");
            return;
        }

        vm.startBroadcast();
        if (timelock == address(0)) {
            for (uint256 i; i < n; ++i) {
                Ownable2Step(targets[i]).acceptOwnership();
            }
        } else {
            address[] memory to = new address[](n);
            uint256[] memory values = new uint256[](n);
            bytes[] memory data = new bytes[](n);
            for (uint256 i; i < n; ++i) {
                to[i] = targets[i];
                data[i] = abi.encodeCall(Ownable2Step.acceptOwnership, ());
            }
            TimelockController controller = TimelockController(payable(timelock));
            if (keccak256(bytes(vm.envString("STEP"))) == keccak256("schedule")) {
                controller.scheduleBatch(to, values, data, bytes32(0), SALT, controller.getMinDelay());
            } else {
                controller.executeBatch(to, values, data, bytes32(0), SALT);
            }
        }
        vm.stopBroadcast();
        console2.log("Contracts handled:", n);
    }

    function _add(address[] memory targets, uint256 n, address target, address expected)
        private
        view
        returns (uint256)
    {
        if (target.code.length == 0) return n;
        for (uint256 i; i < n; ++i) {
            if (targets[i] == target) return n;
        }
        try Ownable2Step(target).pendingOwner() returns (address pending) {
            if (pending != expected) return n;
        } catch {
            return n; // not ownable, for example the local mock randomness provider
        }
        targets[n] = target;
        return n + 1;
    }
}
