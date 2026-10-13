// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {GamesHandler} from "./GamesInvariant.t.sol";

/// @dev The existing invariant never reads `reserved`. This one does:
///      reserved == sum of open exposures, and balance == bankroll + reserved + open wagers + owedTo.
contract GamesReserved3 is Base {
    GamesHandler internal handler;

    function setUp() public override {
        super.setUp();
        games.fundBankroll{value: 1_000 ether}();
        handler = new GamesHandler(games, treasury, randomness, address(nft), gov, makeAddr("project"));
        targetContract(address(handler));
    }

    function invariant_reservedIsExactlyOpenExposure() public view {
        uint256 wagers;
        uint256 exposures;
        uint256 n = handler.openCount();
        for (uint256 i; i < n; ++i) {
            (,, uint128 wager, uint128 exposure,,,) = games.bets(handler.open(i));
            wagers += wager;
            exposures += exposure;
        }
        uint256 owed = games.owedTo(address(handler.fussy()));
        for (uint256 i; i < 3; ++i) {
            owed += games.owedTo(handler.eoas(i));
        }
        assertEq(games.reserved(), exposures, "reserved drifted");
        assertEq(address(games).balance, games.bankroll() + games.reserved() + wagers + owed);
        // Note: reserved <= 20% of house funds is NOT an invariant. The cap is only checked in `play`;
        // `withdrawBankrollToTreasury` and player wins shrink the bankroll afterwards. Solvency is unaffected.
    }
}
