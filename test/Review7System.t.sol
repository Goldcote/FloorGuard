// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {SystemHandler} from "./SystemHandler.sol";

/// @notice Review 7: whole-system stateful fuzz. One handler drives every module at once; after every call
///         the global invariants are checked across all contracts.
/// @dev Long campaign:
///        FOUNDRY_INVARIANT_RUNS=400 FOUNDRY_INVARIANT_DEPTH=250 forge test --match-path 'test/review7/*'
///      Deterministic walk; from 6,000 calls on it also asserts that the deep states were reached:
///        REVIEW7_CALLS=8000 REVIEW7_SEED=1 REVIEW7_LIVENESS_EVERY=5 forge test --match-test test_campaign -vv
contract Review7SystemTest is Test {
    SystemHandler internal h;

    function setUp() public {
        h = new SystemHandler();
        targetContract(address(h));
        targetSelector(FuzzSelector({addr: address(h), selectors: h.actionSelectors()}));
    }

    function _checkAll() internal {
        h.checkGhost();
        h.checkEth();
        h.checkSolvency();
        h.checkNfts();
        h.checkPoints();
        h.checkLiveness();
    }

    /// Global ETH conservation, per-contract solvency, NFT custody, points and liveness, after every call.
    function invariant_wholeSystem() public {
        _checkAll();
    }

    function test_initialStateSatisfiesInvariants() public {
        _checkAll();
    }

    /// A long pseudo-random walk over all actions with every check after every call, followed by the
    /// proof that the deep states were actually reached.
    function test_campaign_reachesDeepStates() public {
        uint256 calls = vm.envOr("REVIEW7_CALLS", uint256(1_500));
        uint256 seed = vm.envOr("REVIEW7_SEED", uint256(7));
        // the stateful fuzzer checks liveness after every call; this walk may thin it out to go further
        uint256 livenessEvery = vm.envOr("REVIEW7_LIVENESS_EVERY", uint256(20));
        bytes4[] memory selectors = h.actionSelectors();
        // the walk is far longer than one transaction; nothing here depends on the test's own gas
        vm.pauseGasMetering();
        for (uint256 i; i < calls; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            (bool ok,) = address(h)
                .call(
                    abi.encodeWithSelector(
                        selectors[r % selectors.length],
                        uint256(keccak256(abi.encode(r, 1))),
                        uint256(keccak256(abi.encode(r, 2))),
                        uint256(keccak256(abi.encode(r, 3)))
                    )
                );
            assertTrue(ok, "a handler action reverted");
            h.checkGhost();
            h.checkEth();
            h.checkSolvency();
            h.checkNfts();
            h.checkPoints();
            if (i % livenessEvery == 0 || i + 1 == calls) h.checkLiveness();
        }
        _report();
        if (calls >= 6_000) {
            string[11] memory deep = [
                "vault.buy",
                "vault.unlock (permissionless)",
                "vault.startAuction (anyone)",
                "vaultRaffle.fulfil -> Won",
                "vaultRaffle.claim",
                "pm.resolve -> Higher/Lower",
                "pm.claim winnings",
                "games.slots jackpot 50x",
                "lottery.fulfil -> Won",
                "licences.revokeLicense",
                "ticketRaffle.settle"
            ];
            for (uint256 i; i < deep.length; ++i) {
                assertGt(h.hits(deep[i]), 0, string.concat("deep state never reached: ", deep[i]));
            }
        }
    }

    function _report() internal view {
        uint256 n = h.hitCount();
        console2.log("successful actions by kind after", h.steps(), "handler calls:");
        for (uint256 i; i < n; ++i) {
            string memory name = h.hitNames(i);
            console2.log(string.concat("  ", name), h.hits(name));
        }
        console2.log("prediction market dust (wei)", h.lastDust());
    }
}
