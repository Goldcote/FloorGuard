// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {Base} from "./Base.t.sol";
import {Games} from "../src/Games.sol";
import {Lottery} from "../src/Lottery.sol";
import {ChainlinkVRFRandomness, IVRFCoordinatorV2Plus} from "../src/randomness/ChainlinkVRFRandomness.sol";
import {IRandomnessProvider} from "../src/interfaces/IFloorGuard.sol";

contract Coordinator8 is IVRFCoordinatorV2Plus {
    uint256 public count;
    address public lastConsumer;

    function requestRandomWords(RandomWordsRequest calldata) external returns (uint256 requestId) {
        requestId = uint256(keccak256(abi.encode(++count)));
        lastConsumer = msg.sender;
    }

    function fulfill(address adapter, uint256 requestId, uint256 word, uint256 gasLimit)
        external
        returns (bool ok)
    {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        (ok,) = adapter.call{gas: gasLimit}(
            abi.encodeCall(ChainlinkVRFRandomness.rawFulfillRandomWords, (requestId, words))
        );
    }
}

/// @dev A player whose receive function burns all the gas it is given.
contract GasBurner {
    function play(Games games, address collection, uint256 chance) external payable returns (uint256) {
        return games.play{value: msg.value}(collection, chance);
    }

    function spin(Games games, address collection) external payable returns (uint256) {
        return games.spin{value: msg.value}(collection);
    }

    receive() external payable {
        while (true) {}
    }
}

/// @dev Review 8, question D: the randomness callbacks of Games and Lottery, measured through the real
///      Chainlink adapter with the Treasury notice in place, in the most expensive state I could
///      build: first fee of a collection (budget, project share and points slots all empty), a payout
///      to a contract that burns its 50k of gas, and a curve that the notice has to restart.
contract Review8GasTest is Base {
    Coordinator8 internal coordinator;
    ChainlinkVRFRandomness internal gamesAdapter;
    ChainlinkVRFRandomness internal lotteryAdapter;
    GasBurner internal burner;
    address internal project = makeAddr("project");

    function setUp() public override {
        super.setUp();
        coordinator = new Coordinator8();
        gamesAdapter = new ChainlinkVRFRandomness(gov, coordinator, games, bytes32("lane"), 1);
        lotteryAdapter = new ChainlinkVRFRandomness(gov, coordinator, lottery, bytes32("lane"), 1);
        burner = new GasBurner();
        vm.deal(address(this), 10_000 ether);
        vm.startPrank(gov);
        games.setRandomness(IRandomnessProvider(address(gamesAdapter)));
        games.setRiskParams(100, 5_000); // the deployed default: half the edge stays in the bankroll
        lottery.setRandomness(IRandomnessProvider(address(lotteryAdapter)));
        lottery.setConfig(address(nft), 0.01 ether, 1 days, true);
        treasury.setProjectShare(address(nft), project, 5_000);
        engine.configureBid(address(nft), 10 ether, 15 ether, 1_000, 1_500, true);
        vm.stopPrank();
        games.fundBankroll{value: 1_000 ether}();
        skip(10 days); // the curve has drifted: the first fee restarts it
    }

    /// The least gas the coordinator must give the adapter for the callback to go through.
    function _minGas(address adapter, uint256 id, uint256 word) internal returns (uint256 lo) {
        uint256 hi = 2_000_000;
        lo = 20_000;
        while (hi - lo > 500) {
            uint256 mid = (hi + lo) / 2;
            uint256 snap = vm.snapshotState();
            bool ok = coordinator.fulfill(adapter, id, word, mid);
            vm.revertToState(snap);
            if (ok) hi = mid;
            else lo = mid;
        }
        lo = hi;
    }

    function _noListener() internal {
        vm.prank(gov);
        treasury.setSpender(makeAddr("eoa"));
    }

    function test_D_games_diceWin_burnerPlayer() public {
        uint256 id = burner.play{value: 1 ether}(games, address(nft), 5_000);
        uint256 snap = vm.snapshotState();
        _noListener();
        uint256 without = _minGas(address(gamesAdapter), id, 0);
        vm.revertToState(snap);
        uint256 with_ = _minGas(address(gamesAdapter), id, 0);
        console2.log("Games dice win, payout burns 50k: min callback gas without the notice:", without);
        console2.log("Games dice win, payout burns 50k: min callback gas with the notice:   ", with_);
        assertLt(with_, 360_000);
        assertTrue(coordinator.fulfill(address(gamesAdapter), id, 0, 360_000));
        assertGt(games.owedTo(address(burner)), 0);
        assertGt(treasury.budgetOf(address(nft)), 0);
    }

    function test_D_games_slotsJackpot_burnerPlayer() public {
        uint256 id = burner.spin{value: 0.1 ether}(games, address(nft));
        uint256 snap = vm.snapshotState();
        _noListener();
        uint256 without = _minGas(address(gamesAdapter), id, 0);
        vm.revertToState(snap);
        uint256 with_ = _minGas(address(gamesAdapter), id, 0);
        console2.log("Games slots 50x, payout burns 50k: min callback gas without the notice:", without);
        console2.log("Games slots 50x, payout burns 50k: min callback gas with the notice:   ", with_);
        assertLt(with_, 360_000);
    }

    function test_D_games_diceLoss() public {
        vm.prank(alice);
        uint256 id = games.play{value: 1 ether}(address(nft), 5_000);
        uint256 snap = vm.snapshotState();
        _noListener();
        uint256 without = _minGas(address(gamesAdapter), id, 9_999);
        vm.revertToState(snap);
        uint256 with_ = _minGas(address(gamesAdapter), id, 9_999);
        console2.log("Games dice loss: min callback gas without the notice:", without);
        console2.log("Games dice loss: min callback gas with the notice:   ", with_);
        assertLt(with_, 360_000);
    }

    function test_D_lottery_200Buyers() public {
        uint256 roundId;
        for (uint256 i; i < 200; ++i) {
            address buyer = address(uint160(0x9000 + i));
            vm.deal(buyer, 1 ether);
            vm.prank(buyer);
            roundId = lottery.buy{value: 0.01 ether}(address(nft), 1);
        }
        skip(1 days);
        lottery.draw(roundId);
        uint256 id = uint256(keccak256(abi.encode(coordinator.count())));
        uint256 snap = vm.snapshotState();
        _noListener();
        uint256 without = _minGas(address(lotteryAdapter), id, 137);
        vm.revertToState(snap);
        uint256 with_ = _minGas(address(lotteryAdapter), id, 137);
        console2.log("Lottery, 200 separate buyers: min callback gas without the notice:", without);
        console2.log("Lottery, 200 separate buyers: min callback gas with the notice:   ", with_);
        assertLt(with_, 360_000);
    }
}
