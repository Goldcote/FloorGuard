// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {Base} from "./Base.t.sol";

/// @dev Review 8, question A. The economics review's scenarios replayed against the real BuybackEngine,
///      Treasury and Vault. Time moves in one-hour steps. In each step the market floor is updated, the
///      hour's fee inflow is deposited (which fires the Treasury notice), and competitive sellers sell
///      for as long as the bid is at or above their reservation price (the floor) and the cooldown
///      allows. A "monopolist" seller instead waits until the bid has stopped rising.
///
///      Run: forge test --match-path 'test/review8/Review8BuybackSim.t.sol' -vv
contract Review8BuybackSim is Base {
    uint256 internal constant F0 = 10 ether;
    uint256 internal constant HOURS_PER_YEAR = 8_760;
    // hourly factors, 1e18 fixed point
    uint256 internal constant FLAT = 1e18;
    uint256 internal constant FALL_70PCT_A_YEAR = 999_862_569_626_573_568; // 1.0 -> 0.3 in 365 days
    uint256 internal constant RISE_3X_A_YEAR = 1_000_125_420_226_179_072; // 1.0 -> 3.0 in 365 days
    uint256 internal constant HALVE_IN_30_DAYS = 999_037_758_833_783_424;

    struct Cfg {
        uint256 baseBps; // of F0
        uint256 maxBps; // of F0
        uint16 growth;
        uint16 stepDown;
        uint256 cooldown;
    }

    struct Res {
        uint256 fills;
        uint256 paid; // wei
        uint256 worth; // sum of the floor at each fill, wei
        uint256 overpaid; // sum of max(0, price - floor)
        uint256 maxRatioBps; // highest price / floor seen
        uint256 inflow; // wei deposited
        uint256 budgetHours; // sum over hours of budget, for the time-average
        uint256 hoursRun;
    }

    Res internal res;
    uint256 internal nextId = 1;
    uint256 internal floorNow = F0;
    address internal seller = makeAddr("seller");
    bool internal hasCooldown;
    uint256 internal maxPriceNow;

    function setUp() public override {
        super.setUp();
        vm.prank(seller);
        nft.setApprovalForAll(address(engine), true);
        vm.deal(address(this), 1_000_000 ether);
    }

    // ------------------------------------------------------------------ machinery

    function _configure(Cfg memory c) internal {
        vm.startPrank(gov);
        engine.configureBid(
            address(nft),
            uint128(F0 * c.baseBps / 10_000),
            uint128(F0 * c.maxBps / 10_000),
            c.growth,
            c.stepDown,
            true
        );
        if (c.cooldown != 0) engine.setFillCooldown(address(nft), c.cooldown);
        vm.stopPrank();
        hasCooldown = c.cooldown != 0;
        maxPriceNow = F0 * c.maxBps / 10_000;
    }

    function _sellOne(uint256 price) internal {
        uint256 id = nextId++;
        nft.mint(seller, id);
        vm.prank(seller);
        engine.sell(address(nft), id, price);
        res.fills++;
        res.paid += price;
        res.worth += floorNow;
        if (price > floorNow) res.overpaid += price - floorNow;
        uint256 ratio = price * 10_000 / floorNow;
        if (ratio > res.maxRatioBps) res.maxRatioBps = ratio;
    }

    /// Competitive sellers: sell while the bid is at or above the floor.
    function _competitive() internal {
        for (uint256 i; i < 200; ++i) {
            if (hasCooldown && !engine.isFillable(address(nft))) return;
            uint256 bid = engine.currentBid(address(nft));
            if (bid < floorNow) return;
            _sellOne(bid);
        }
    }

    /// One holder is the only supply. It sells only when waiting cannot raise the bid any further: the
    /// bid is at the cap, or the curve has caught up with the budget (the next deposit would restart it).
    function _monopolist() internal {
        uint256 bid = engine.currentBid(address(nft));
        if (bid < floorNow) return;
        // bid < curve means the budget is what limits it; bid == cap means the curve is done
        if (bid == maxPriceNow || bid < engine.curvePrice(address(nft))) _sellOne(bid);
    }

    /// @param inflowBpsPerDay fee inflow in floors per day, in bps of the *current* floor
    function _run(uint256 hours_, uint256 factor, uint256 inflowBpsPerDay, bool monopolist) internal {
        uint256 ptr;
        assembly {
            ptr := mload(0x40)
        }
        for (uint256 h; h < hours_; ++h) {
            // nothing in memory lives across iterations: reuse it, or memory growth eats the gas limit
            assembly {
                mstore(0x40, ptr)
            }
            skip(1 hours);
            floorNow = floorNow * factor / 1e18;
            uint256 amount = floorNow * inflowBpsPerDay / 10_000 / 24;
            if (amount != 0) {
                treasury.deposit{value: amount}(address(nft));
                res.inflow += amount;
            }
            if (monopolist) _monopolist();
            else _competitive();
            res.budgetHours += treasury.budgetOf(address(nft));
            res.hoursRun++;
        }
    }

    function _lump(uint256 amount) internal {
        treasury.deposit{value: amount}(address(nft));
        res.inflow += amount;
    }

    function _report(string memory name) internal view {
        uint256 budget = treasury.budgetOf(address(nft));
        (uint128 base,,,,,) = engine.bids(address(nft));
        console2.log(name);
        console2.log(
            "   fills %s | avg paid/floor (bps) %s | max paid/floor (bps) %s",
            res.fills,
            res.worth == 0 ? 0 : res.paid * 10_000 / res.worth,
            res.maxRatioBps
        );
        console2.log(
            "   overpaid share of spend (bps) %s | budget left / inflow (bps) %s | avg budget (bps of F0) %s",
            res.paid == 0 ? 0 : res.overpaid * 10_000 / res.paid,
            res.inflow == 0 ? 0 : budget * 10_000 / res.inflow,
            res.hoursRun == 0 ? 0 : res.budgetHours / res.hoursRun * 10_000 / F0
        );
        console2.log(
            "   end: base/floor (bps) %s | curve/floor (bps) %s | floor/F0 (bps) %s",
            uint256(base) * 10_000 / floorNow,
            engine.curvePrice(address(nft)) * 10_000 / floorNow,
            floorNow * 10_000 / F0
        );
    }

    function _avgBps() internal view returns (uint256) {
        return res.worth == 0 ? 0 : res.paid * 10_000 / res.worth;
    }

    function _idleBps() internal view returns (uint256) {
        return treasury.budgetOf(address(nft)) * 10_000 / res.inflow;
    }

    Cfg internal DEFAULTS =
        Cfg({baseBps: 9_000, maxBps: 15_000, growth: 1_000, stepDown: 1_500, cooldown: 0});

    // ------------------------------------------------------------------ 1. slow steady inflow

    function test_A1_steady_002() public {
        _configure(DEFAULTS);
        _run(HOURS_PER_YEAR, FLAT, 200, false);
        _report("A1 steady 0.02 floors/day, g 10%, s 15%, flat, 365 d");
        assertLe(res.maxRatioBps, 10_100);
    }

    function test_A1_steady_010() public {
        _configure(DEFAULTS);
        _run(HOURS_PER_YEAR, FLAT, 1_000, false);
        _report("A1 steady 0.10 floors/day, g 10%, s 15%, flat, 365 d");
        assertLe(res.maxRatioBps, 10_100);
        assertLe(_idleBps(), 500);
    }

    function test_A1_steady_050() public {
        _configure(DEFAULTS);
        _run(HOURS_PER_YEAR, FLAT, 5_000, false);
        _report("A1 steady 0.50 floors/day, g 10%, s 15%, flat, 365 d");
        assertLe(res.maxRatioBps, 10_100);
    }

    /// Above f* = g (1 - s) / s = 0.567 floors/day the engine cannot buy fast enough.
    function test_A1_steady_200_idle() public {
        _configure(DEFAULTS);
        _run(HOURS_PER_YEAR, FLAT, 20_000, false);
        _report("A1 steady 2.00 floors/day, g 10%, s 15%, flat, 365 d (above f*)");
        assertGe(_idleBps(), 6_500); // about 72% never spent
    }

    function test_A1_steady_010_oldStep() public {
        _configure(Cfg({baseBps: 9_000, maxBps: 15_000, growth: 1_000, stepDown: 500, cooldown: 0}));
        _run(HOURS_PER_YEAR, FLAT, 1_000, false);
        _report("A1 steady 0.10 floors/day, g 10%, s 5%, flat, 365 d");
        assertLe(res.maxRatioBps, 10_100);
    }

    /// A slow curve: g 0.25% a day. The engine can buy one token every 70 days at most.
    function test_A1_steady_010_slowCurve_idle() public {
        _configure(Cfg({baseBps: 9_000, maxBps: 15_000, growth: 25, stepDown: 1_500, cooldown: 0}));
        _run(HOURS_PER_YEAR, FLAT, 1_000, false);
        _report("A1 steady 0.10 floors/day, g 0.25%, s 15%, flat, 365 d (slow curve)");
        assertGe(_idleBps(), 7_500);
    }

    // ------------------------------------------------------------------ 2. lump after a long unfunded period

    function test_A2_lumpAfterUnfunded() public {
        _configure(DEFAULTS);
        _run(60 * 24, FLAT, 0, false); // unfunded: the curve drifts to maxPrice
        assertEq(engine.curvePrice(address(nft)), F0 * 15_000 / 10_000);
        _lump(30 * F0);
        _competitive();
        _run(60 * 24, FLAT, 0, false);
        _report("A2 60 d unfunded, then a 30-floor lump, 60 d more (base fresh at 0.9 F)");
        assertLe(res.maxRatioBps, 10_100); // the lump is not spent above the floor
    }

    // ------------------------------------------------------------------ 3. falling market

    function test_A3_falling_002() public {
        _configure(DEFAULTS);
        _run(HOURS_PER_YEAR, FALL_70PCT_A_YEAR, 200, false);
        _report("A3 floor -70%/yr, inflow 0.02 floors/day (of the current floor), cap fixed at 1.5 F0");
    }

    function test_A3_falling_010() public {
        _configure(DEFAULTS);
        _run(HOURS_PER_YEAR, FALL_70PCT_A_YEAR, 1_000, false);
        _report("A3 floor -70%/yr, inflow 0.10 floors/day");
    }

    function test_A3_falling_050() public {
        _configure(DEFAULTS);
        _run(HOURS_PER_YEAR, FALL_70PCT_A_YEAR, 5_000, false);
        _report("A3 floor -70%/yr, inflow 0.50 floors/day");
    }

    /// With s 15% and a fill every 50 days or so, one step per fill happens to keep pace with a floor
    /// that loses 70% a year: the base ends below the market and a late lump is not overpaid.
    function test_A3_falling_thenLump_step15_tracks() public {
        _configure(DEFAULTS);
        _run(HOURS_PER_YEAR, FALL_70PCT_A_YEAR, 200, false);
        _report("A3b floor -70%/yr at 0.02 floors/day, s 15%: state before the lump");
        delete res;
        _lump(10 * floorNow);
        _competitive();
        _run(30 * 24, FLAT, 0, false);
        _report("A3b ... then a 10-floor lump, 30 d flat: the lump only");
        assertLe(res.maxRatioBps, 10_100);
    }

    function test_A3_falling_thenLump_step15_thinner_overpays() public {
        _configure(DEFAULTS);
        _run(HOURS_PER_YEAR, FALL_70PCT_A_YEAR, 50, false);
        _report("A3b floor -70%/yr at 0.005 floors/day, s 15%: state before the lump");
        delete res;
        _lump(10 * floorNow);
        _competitive();
        _run(30 * 24, FLAT, 0, false);
        _report("A3b ... then a 10-floor lump, 30 d flat: the lump only");
    }

    /// The same with no inflow at all during the fall: floor halves in 30 days, then a lump.
    function test_A3_crashThenLump_overpays() public {
        _configure(Cfg({baseBps: 8_500, maxBps: 15_000, growth: 1_000, stepDown: 1_500, cooldown: 0}));
        _run(30 * 24, HALVE_IN_30_DAYS, 0, false);
        _lump(10 * floorNow);
        _competitive();
        _run(30 * 24, FLAT, 0, false);
        _report("A3c floor halves in 30 d with no inflow, then a 10-floor lump, 30 d flat");
        assertGe(res.maxRatioBps, 16_900); // first fill at 1.7 times the market
        assertGe(res.overpaid * 10_000 / res.paid, 1_000);
    }

    function test_A3_crashThenLump_oldStep_overpays() public {
        _configure(Cfg({baseBps: 8_500, maxBps: 15_000, growth: 1_000, stepDown: 500, cooldown: 0}));
        _run(30 * 24, HALVE_IN_30_DAYS, 0, false);
        _lump(10 * floorNow);
        _competitive();
        _run(30 * 24, FLAT, 0, false);
        _report("A3c same with s 5%");
    }

    // ------------------------------------------------------------------ 4. rising market

    function test_A4_rising_capFixed() public {
        _configure(DEFAULTS);
        _run(HOURS_PER_YEAR, RISE_3X_A_YEAR, 1_000, false);
        _report("A4 floor x3 in a year, inflow 0.10 floors/day, cap fixed at 1.5 F0");
    }

    function test_A4_rising_capWide() public {
        _configure(Cfg({baseBps: 9_000, maxBps: 40_000, growth: 1_000, stepDown: 1_500, cooldown: 0}));
        _run(HOURS_PER_YEAR, RISE_3X_A_YEAR, 1_000, false);
        _report("A4 floor x3 in a year, inflow 0.10 floors/day, cap 4 F0");
        assertLe(res.maxRatioBps, 10_100);
    }

    function test_A4_rising_capWide_002() public {
        _configure(Cfg({baseBps: 9_000, maxBps: 40_000, growth: 1_000, stepDown: 1_500, cooldown: 0}));
        _run(HOURS_PER_YEAR, RISE_3X_A_YEAR, 200, false);
        _report("A4 floor x3 in a year, inflow 0.02 floors/day, cap 4 F0");
    }

    /// A curve slower than the market never catches it: g 0.25% a day against a floor rising 0.30% a day.
    function test_A4_rising_slowCurve_neverBuys() public {
        _configure(Cfg({baseBps: 9_000, maxBps: 40_000, growth: 25, stepDown: 1_500, cooldown: 0}));
        _run(HOURS_PER_YEAR, RISE_3X_A_YEAR, 1_000, false);
        _report("A4 floor x3 in a year, inflow 0.10 floors/day, g 0.25%, cap 4 F0 (never buys)");
        assertEq(res.fills, 0);
    }

    // ------------------------------------------------------------------ 5. inflow stops and restarts

    function test_A5_stopAndRestart() public {
        _configure(DEFAULTS);
        for (uint256 i; i < 3; ++i) {
            _run(60 * 24, FLAT, 1_000, false);
            _run(60 * 24, FLAT, 0, false);
        }
        _report("A5 inflow 0.10 floors/day for 60 d, none for 60 d, three times, flat");
        assertLe(res.maxRatioBps, 10_100);
    }

    /// The market falls 30% during each pause. The bid is the leftover budget, so nothing is overpaid
    /// while the money trickles, but the base lags.
    function test_A5_stopAndRestart_fallingDuringPause() public {
        _configure(DEFAULTS);
        for (uint256 i; i < 3; ++i) {
            _run(60 * 24, FLAT, 1_000, false);
            _run(60 * 24, 999_752_339_739_575_936, 0, false); // -30% in 60 days
        }
        _report("A5b same, floor falls 30% in each pause");
    }

    // ------------------------------------------------------------------ 6. one dominant holder

    function test_A6_monopolist_010() public {
        _configure(DEFAULTS);
        _run(HOURS_PER_YEAR, FLAT, 1_000, true);
        _report("A6 one seller who waits, inflow 0.10 floors/day, cap 1.5 F0, flat");
        assertGe(_avgBps(), 11_000);
    }

    function test_A6_monopolist_002() public {
        _configure(DEFAULTS);
        _run(HOURS_PER_YEAR, FLAT, 200, true);
        _report("A6 one seller who waits, inflow 0.02 floors/day, cap 1.5 F0, flat");
    }

    function test_A6_monopolist_050() public {
        _configure(DEFAULTS);
        _run(HOURS_PER_YEAR, FLAT, 5_000, true);
        _report("A6 one seller who waits, inflow 0.50 floors/day, cap 1.5 F0, flat");
    }
}
