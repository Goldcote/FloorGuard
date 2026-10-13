// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Treasury} from "../src/Treasury.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {BuybackEngine} from "../src/BuybackEngine.sol";
import {Vault} from "../src/Vault.sol";
import {SalesFloorOracle} from "../src/oracles/SalesFloorOracle.sol";
import {PushFloorOracle} from "../src/oracles/PushFloorOracle.sol";
import {MockNFT} from "./mocks/MockNFT.sol";

/// @dev Deploys and wires the core protocol. The Vault reads the push oracle so tests control the floor;
///      the sales oracle is fed by the Marketplace and the BuybackEngine.
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
    MockNFT internal nft;

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
        vm.stopPrank();

        nft = new MockNFT();
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(carol, 1_000 ether);
    }

    function _mintApproved(address to, uint256 tokenId, address operator) internal {
        nft.mint(to, tokenId);
        vm.prank(to);
        nft.approve(operator, tokenId);
    }

    function _pushFloor(uint256 price) internal {
        vm.prank(gov);
        pushOracle.pushFloor(address(nft), price);
    }
}
