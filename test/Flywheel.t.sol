// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {Vault} from "../src/Vault.sol";

/// @dev End-to-end run of the flywheel on the sales oracle: trading fees fund a buyback, the bought NFT
///      unlocks once the floor has risen, and it is raffled to the traders who generated the fees.
contract FlywheelTest is Base {
    uint256 internal nextToken = 100;

    function setUp() public override {
        super.setUp();
        vm.prank(gov);
        vault.setOracle(salesOracle);
    }

    /// `buyer` posts a collection offer and `seller` fills it `count` times with freshly minted tokens.
    function _trade(address buyer, address seller, uint256 price, uint256 count) internal {
        vm.prank(buyer);
        uint256 id = marketplace.makeCollectionOffer{value: price * count}(
            address(nft), count, block.timestamp + 1 days
        );
        for (uint256 i; i < count; ++i) {
            uint256 tokenId = nextToken++;
            _mintApproved(seller, tokenId, address(marketplace));
            vm.prank(seller);
            marketplace.acceptOffer(id, tokenId, 0);
        }
    }

    function test_flywheel() public {
        // 1. Trading: 50 sales at 10 ETH put 2% each, 10 ETH in total, into the collection's budget.
        _trade(bob, alice, 10 ether, 50);
        assertEq(treasury.budgetOf(address(nft)), 10 ether);
        (uint256 floor,) = salesOracle.floorPrice(address(nft));
        assertEq(floor, 10 ether);
        points.flush(alice);
        points.flush(bob);
        assertEq(points.pointsOf(alice), points.pointsOf(bob));
        assertEq(points.totalPoints(), 10 * POINTS_RATE); // each fee credited once, half to each side

        // 2. Buyback: the bid starts under the floor and rises until a holder takes it.
        vm.prank(gov);
        engine.configureBid(address(nft), 9 ether, 12 ether, 1_000, 500, true);
        _mintApproved(carol, 1, address(engine));
        vm.prank(carol);
        vm.expectRevert(); // 9 ETH is below what carol will take
        engine.sell(address(nft), 1, 9.9 ether);

        skip(1 days);
        uint256 carolBefore = carol.balance;
        vm.prank(carol);
        uint256 vaultId = engine.sell(address(nft), 1, 9.9 ether);
        assertEq(carol.balance - carolBefore, 9.9 ether);
        assertEq(nft.ownerOf(1), address(vault));
        assertEq(treasury.budgetOf(address(nft)), 0.1 ether);

        // 3. Lock: nothing takes part in the unlock draw before 90 days.
        assertFalse(vault.canUnlock(vaultId));
        skip(75 days);
        vm.expectRevert(); // old sales have aged out of the oracle
        vault.sampleFloor(address(nft));

        // 4. The floor recovers to 13 ETH, above 130% of the 9.9 ETH purchase price, and holds there:
        //    sampled daily, it becomes the Vault's 30-day median floor.
        _trade(bob, alice, 13 ether, 3);
        vault.sampleFloor(address(nft));
        for (uint256 i; i < 15; ++i) {
            skip(1 days);
            _trade(bob, alice, 13 ether, 1);
            vault.sampleFloor(address(nft));
        }

        // 5. The daily draw picks the holding, on a day nobody could know in advance.
        (,,, uint40 acquiredAt,,,) = vault.holdings(vaultId);
        _drawUnlockRound(_seedPicking(vaultId, vault.drawChanceBps(block.timestamp - acquiredAt)));
        assertTrue(vault.canUnlock(vaultId));
        vault.unlock(vaultId);

        // 6. Governance raffles the NFT to points holders.
        vm.prank(gov);
        uint256 raffleId = vault.sendToRaffle(vaultId);
        skip(7 days);
        raffle.draw(raffleId);
        uint256 alicePoints = points.pointsOf(alice);
        randomness.fulfill(randomness.lastRequestId(), 0); // point 0 belongs to alice, the first holder

        // 7. The prize vests for 30 days before it can be claimed.
        vm.expectRevert();
        raffle.claim(raffleId);
        skip(30 days);
        raffle.claim(raffleId);
        assertEq(nft.ownerOf(1), alice);
        assertEq(points.pointsOf(alice), alicePoints * 2_000 / 10_000);
        (,,,,,, Vault.Status status) = vault.holdings(vaultId);
        assertEq(uint8(status), uint8(Vault.Status.Released));
    }
}
