// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base} from "./Base.t.sol";
import {SalesFloorOracle} from "../src/oracles/SalesFloorOracle.sol";
import {PushFloorOracle} from "../src/oracles/PushFloorOracle.sol";

contract OraclesTest is Base {
    address internal reporter = makeAddr("reporter");
    address internal collection = makeAddr("collection");

    function setUp() public override {
        super.setUp();
        vm.prank(gov);
        salesOracle.setReporter(reporter, true);
    }

    function _record(uint256 price) internal {
        vm.prank(reporter);
        salesOracle.recordSale(collection, price);
    }

    function test_sales_revertsUntilEnoughObservations() public {
        _record(10 ether);
        _record(11 ether);
        vm.expectRevert(abi.encodeWithSelector(SalesFloorOracle.InsufficientData.selector, 2, 3));
        salesOracle.floorPrice(collection);

        _record(12 ether);
        (uint256 price, uint256 updatedAt) = salesOracle.floorPrice(collection);
        assertEq(price, 11 ether);
        assertEq(updatedAt, block.timestamp);
    }

    function test_sales_usesLowerMedianOfEvenCount() public {
        _record(13 ether);
        _record(10 ether);
        _record(12 ether);
        _record(11 ether);
        (uint256 price,) = salesOracle.floorPrice(collection);
        assertEq(price, 11 ether);
    }

    function test_sales_oneOutlierDoesNotMoveTheFloor() public {
        for (uint256 i; i < 6; ++i) {
            _record(10 ether);
        }
        _record(0.001 ether);
        (uint256 price,) = salesOracle.floorPrice(collection);
        assertEq(price, 10 ether);
    }

    function test_sales_ringKeepsOnlyTheLatestWindow() public {
        for (uint256 i; i < 7; ++i) {
            _record(10 ether);
        }
        for (uint256 i; i < 7; ++i) {
            _record(20 ether);
        }
        (uint256 price,) = salesOracle.floorPrice(collection);
        assertEq(price, 20 ether);
    }

    function test_sales_ignoresOldObservations() public {
        _record(10 ether);
        _record(10 ether);
        _record(10 ether);
        skip(7 days + 1);
        _record(30 ether);
        vm.expectRevert(abi.encodeWithSelector(SalesFloorOracle.InsufficientData.selector, 1, 3));
        salesOracle.floorPrice(collection);
    }

    function test_sales_onlyReporters() public {
        vm.prank(alice);
        vm.expectRevert(SalesFloorOracle.NotReporter.selector);
        salesOracle.recordSale(collection, 1 ether);
    }

    function test_sales_paramValidation() public {
        vm.startPrank(gov);
        vm.expectRevert(SalesFloorOracle.InvalidParams.selector);
        salesOracle.setParams(1 days, 8);
        vm.expectRevert(SalesFloorOracle.InvalidParams.selector);
        salesOracle.setParams(0, 3);
        salesOracle.setParams(1 days, 1);
        vm.stopPrank();
        _record(5 ether);
        (uint256 price,) = salesOracle.floorPrice(collection);
        assertEq(price, 5 ether);
    }

    /// The floor is always one of the recorded prices, with at least half of the window at or above it.
    function testFuzz_sales_medianIsWithinObservedRange(uint96[7] memory prices) public {
        uint256 min = type(uint256).max;
        uint256 max;
        for (uint256 i; i < 7; ++i) {
            _record(prices[i]);
            if (prices[i] < min) min = prices[i];
            if (prices[i] > max) max = prices[i];
        }
        (uint256 floor,) = salesOracle.floorPrice(collection);
        assertGe(floor, min);
        assertLe(floor, max);

        uint256 atOrAbove;
        uint256 atOrBelow;
        for (uint256 i; i < 7; ++i) {
            if (prices[i] >= floor) ++atOrAbove;
            if (prices[i] <= floor) ++atOrBelow;
        }
        assertGe(atOrAbove, 4);
        assertGe(atOrBelow, 4);
    }

    function test_push_storesAndGuards() public {
        vm.expectRevert(PushFloorOracle.NoPrice.selector);
        pushOracle.floorPrice(collection);

        vm.prank(alice);
        vm.expectRevert(PushFloorOracle.NotReporter.selector);
        pushOracle.pushFloor(collection, 1 ether);

        vm.prank(gov);
        vm.expectRevert(PushFloorOracle.InvalidPrice.selector);
        pushOracle.pushFloor(collection, 0);

        vm.prank(gov);
        pushOracle.pushFloor(collection, 7 ether);
        (uint256 price, uint256 updatedAt) = pushOracle.floorPrice(collection);
        assertEq(price, 7 ether);
        assertEq(updatedAt, block.timestamp);
    }
}
