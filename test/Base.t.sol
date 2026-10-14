// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Treasury} from "../src/Treasury.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {BuybackEngine} from "../src/BuybackEngine.sol";
import {Vault} from "../src/Vault.sol";
import {SalesFloorOracle} from "../src/oracles/SalesFloorOracle.sol";
import {PushFloorOracle} from "../src/oracles/PushFloorOracle.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";
import {Points} from "../src/Points.sol";
import {VaultRaffle} from "../src/VaultRaffle.sol";
import {Games} from "../src/Games.sol";
import {TicketRaffle} from "../src/TicketRaffle.sol";
import {Lottery} from "../src/Lottery.sol";
import {IPLicenseManager} from "../src/IPLicenseManager.sol";
import {MockNFT} from "./mocks/MockNFT.sol";
import {MockRandomness} from "./mocks/MockRandomness.sol";

/// @dev Deploys and wires the whole protocol. The Vault and the PredictionMarket read the push oracle so
///      tests control the floor; the sales oracle is fed by the Marketplace and the BuybackEngine.
abstract contract Base is Test {
    address internal gov = makeAddr("gov");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    Treasury internal treasury;
    Marketplace internal marketplace;
    BuybackEngine internal engine;
    Vault internal vault;
    SalesFloorOracle internal salesOracle;
    PushFloorOracle internal pushOracle;
    PredictionMarket internal prediction;
    Points internal points;
    VaultRaffle internal raffle;
    Games internal games;
    TicketRaffle internal ticketRaffle;
    Lottery internal lottery;
    IPLicenseManager internal licenses;
    MockRandomness internal randomness;
    MockNFT internal nft;

    /// 2,500 points (18 decimals) per ETH of fees: 50 points per ETH traded at the 2% marketplace fee.
    uint256 internal constant POINTS_RATE = 2_500e18;

    function setUp() public virtual {
        vm.warp(1_760_000_000);
        vm.startPrank(gov);
        treasury = new Treasury(gov);
        salesOracle = new SalesFloorOracle(gov);
        pushOracle = new PushFloorOracle(gov);
        marketplace = new Marketplace(gov, treasury);
        vault = new Vault(gov, treasury, pushOracle);
        engine = new BuybackEngine(gov, treasury, vault);

        treasury.setSpender(address(engine));
        vault.setEngine(address(engine));
        marketplace.setSaleRecorder(salesOracle);
        engine.setSaleRecorder(salesOracle);
        salesOracle.setReporter(address(marketplace), true);
        salesOracle.setReporter(address(engine), true);
        pushOracle.setReporter(gov, true);

        randomness = new MockRandomness();
        points = new Points(gov);
        prediction = new PredictionMarket(gov, treasury, pushOracle);
        raffle = new VaultRaffle(gov, points, address(vault), randomness);
        vault.setRaffle(raffle);
        vault.setRandomness(randomness);
        // Most tests use a handful of points; the prize-value gate has its own tests.
        raffle.setPointsPerPrizeWei(0);
        points.setRaffle(address(raffle));
        points.setRate(address(marketplace), POINTS_RATE);
        points.setRate(address(prediction), POINTS_RATE);
        marketplace.setPoints(points);
        prediction.setPoints(points);

        games = new Games(gov, treasury, randomness);
        games.setPoints(points);
        // The game tests check the maths with the whole edge going to buybacks. The bankroll's default
        // half share of the edge is tested in Regressions.
        games.setRiskParams(100, 0);
        points.setRate(address(games), POINTS_RATE);

        ticketRaffle = new TicketRaffle(gov, treasury, randomness);
        lottery = new Lottery(gov, treasury, randomness);
        licenses = new IPLicenseManager(gov, vault, treasury);
        vm.stopPrank();

        nft = new MockNFT();
        vm.prank(gov);
        prediction.setCollectionSupport(address(nft), true);
        vm.prank(gov);
        marketplace.setCollectionSupport(address(nft), true);
        vm.prank(gov);
        games.setCollectionSupport(address(nft), true);
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(carol, 1_000 ether);
    }

    function _mintApproved(address to, uint256 tokenId, address operator) internal {
        nft.mint(to, tokenId);
        vm.prank(to);
        nft.approve(operator, tokenId);
    }

    /// Credit points from this test contract (which must have a rate) and activate them.
    function _earn(address user, uint256 feeWei) internal {
        points.creditFee(user, feeWei);
        points.flush(user);
    }

    function _pushFloor(uint256 price) internal {
        vm.prank(gov);
        pushOracle.pushFloor(address(nft), price);
    }

    /// Push and sample the floor once a day for `days_` days, ending on the last sample (no skip after
    /// it), so the Vault's 30-day median is `price`.
    function _sampleFloor(uint256 price, uint256 days_) internal {
        // one sample per day: wait for the next day if today's has been taken
        if (vault.lastSampleSlot(address(nft)) > block.timestamp / 1 days) skip(1 days);
        for (uint256 i; i < days_; ++i) {
            if (i != 0) skip(1 days);
            _pushFloor(price);
            vault.sampleFloor(address(nft));
        }
    }

    /// A random word under which the daily draw picks every holding in `ids` at `chanceBps`.
    function _seedPicking(uint256[] memory ids, uint256 chanceBps) internal pure returns (uint256 word) {
        for (word = 1;; ++word) {
            bool all = true;
            for (uint256 i; i < ids.length && all; ++i) {
                all = uint256(keccak256(abi.encode(word, ids[i]))) % 10_000 < chanceBps;
            }
            if (all) return word;
        }
    }

    function _seedPicking(uint256 id, uint256 chanceBps) internal pure returns (uint256) {
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        return _seedPicking(ids, chanceBps);
    }

    /// Run the Vault's daily draw with a chosen random word.
    function _drawUnlockRound(uint256 word) internal {
        vault.requestUnlockRound();
        randomness.fulfill(randomness.lastRequestId(), word);
    }

    /// Unlock `id` through the moving lock: sample a floor of `floor` daily up to the end of its lock, so
    /// it is the 30-day median, then draw a word that picks it.
    function _unlockThroughDraw(uint256 id, uint256 floor) internal {
        (,,, uint40 acquiredAt, uint40 lockedUntil,,) = vault.holdings(id);
        uint256 sampleStart = uint256(lockedUntil) > 15 days ? uint256(lockedUntil) - 15 days : 0;
        if (block.timestamp < sampleStart) vm.warp(sampleStart);
        _sampleFloor(floor, 16); // a majority of any 30 days of samples
        if (block.timestamp < lockedUntil) vm.warp(lockedUntil);
        _pushFloor(floor);
        _drawUnlockRound(_seedPicking(id, vault.drawChanceBps(block.timestamp - acquiredAt)));
        vault.unlock(id);
    }
}
