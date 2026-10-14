// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {Vault} from "../src/Vault.sol";
import {VaultRaffle} from "../src/VaultRaffle.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";
import {Points} from "../src/Points.sol";
import {Treasury} from "../src/Treasury.sol";
import {BuybackEngine} from "../src/BuybackEngine.sol";
import {PushFloorOracle} from "../src/oracles/PushFloorOracle.sol";
import {MockNFT} from "./mocks/MockNFT.sol";
import {MockRandomness} from "./mocks/MockRandomness.sol";

/// @dev Random actions on the BuybackEngine, the Vault (unlock, relock, auctions, raffle hand-over), the
///      VaultRaffle, Points and the PredictionMarket. Complements test/Invariants.t.sol, which covers the
///      Marketplace.
contract CoreHandler is Test {
    address internal gov;
    Treasury internal treasury;
    BuybackEngine internal engine;
    Vault internal vault;
    VaultRaffle internal raffle;
    PredictionMarket internal prediction;
    Points internal points;
    PushFloorOracle internal oracle;
    MockRandomness internal randomness;
    MockNFT internal nft;

    uint256 internal nextToken = 1;
    uint256 public constant ACTORS = 5;

    // ghosts
    uint256 public predictionIn;
    uint256 public predictionOut;
    uint256 public predictionFees;
    uint256 public auctionProceeds;
    uint256 public buybackSpent;
    uint256 public budgetFunded;
    mapping(uint256 vaultId => bool) public ownerPriced;
    uint256 public fulfilled;

    constructor(
        address gov_,
        Treasury treasury_,
        BuybackEngine engine_,
        Vault vault_,
        VaultRaffle raffle_,
        PredictionMarket prediction_,
        Points points_,
        PushFloorOracle oracle_,
        MockRandomness randomness_,
        MockNFT nft_
    ) {
        gov = gov_;
        treasury = treasury_;
        engine = engine_;
        vault = vault_;
        raffle = raffle_;
        prediction = prediction_;
        points = points_;
        oracle = oracle_;
        randomness = randomness_;
        nft = nft_;
    }

    function actor(uint256 seed) public pure returns (address) {
        return address(uint160(0xB000 + seed % ACTORS));
    }

    function _actor(uint256 seed) internal returns (address a) {
        a = actor(seed);
        vm.deal(a, 10_000 ether);
    }

    /// A holding in `wanted` status, searching from a random start. Zero when there is none.
    function _holding(uint256 seed, Vault.Status wanted) internal view returns (uint256) {
        uint256 n = vault.holdingCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = (seed + i) % n + 1;
            (,,,,,, Vault.Status status) = vault.holdings(id);
            if (status == wanted) return id;
        }
        return 0;
    }

    function _raffle(uint256 seed, VaultRaffle.Status wanted) internal view returns (uint256) {
        uint256 n = raffle.raffleCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = (seed + i) % n + 1;
            (,,,, VaultRaffle.Status status,) = raffle.raffles(id);
            if (status == wanted) return id;
        }
        return 0;
    }

    function _market(uint256 seed, bool pending) internal view returns (uint256) {
        uint256 n = prediction.marketCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = (seed + i) % n + 1;
            (,,,,,, PredictionMarket.Outcome outcome) = prediction.markets(id);
            if ((outcome == PredictionMarket.Outcome.Pending) == pending) return id;
        }
        return 0;
    }

    function _push(uint256 price) internal {
        vm.prank(gov);
        oracle.pushFloor(address(nft), bound(price, 1, 100 ether));
    }

    // ------------------------------------------------------------------ time, oracle, funding

    function warp(uint32 seconds_) external {
        skip(bound(seconds_, 0, 40 days));
    }

    function pushFloor(uint96 price) external {
        _push(price);
    }

    function fund(uint96 amount) external {
        uint256 a = bound(amount, 0, 30 ether);
        vm.deal(address(this), a);
        treasury.deposit{value: a}(address(nft));
        budgetFunded += a;
    }

    // ------------------------------------------------------------------ engine and vault

    function sellToEngine(uint8 actorSeed) external {
        if (!engine.isFillable(address(nft))) return;
        address seller = _actor(actorSeed);
        uint256 tokenId = nextToken++;
        nft.mint(seller, tokenId);
        uint256 price = engine.currentBid(address(nft));
        vm.startPrank(seller);
        nft.approve(address(engine), tokenId);
        engine.sell(address(nft), tokenId, 0);
        vm.stopPrank();
        buybackSpent += price;
    }

    function unlock(uint256 seed, bool byGov, uint96 floor) external {
        uint256 id = _holding(seed, Vault.Status.Locked);
        if (id == 0) return;
        if (byGov) {
            vm.prank(gov);
            vault.governanceUnlock(id);
        } else {
            if (vault.isPlayersHolding(id)) {
                (,,,, uint40 until,,) = vault.holdings(id);
                if (block.timestamp < until) vm.warp(until);
                vault.releaseToPlayers(id);
                return;
            }
            (,,, uint40 acquiredAt, uint40 lockedUntil,,) = vault.holdings(id);
            uint256 sampleFrom = lockedUntil > 15 days ? lockedUntil - 15 days : 0;
            if (block.timestamp < sampleFrom) vm.warp(sampleFrom);
            for (uint256 d; d < 16; ++d) {
                if (d != 0) skip(1 days);
                _push(floor);
                vault.sampleFloor(address(nft));
            }
            if (block.timestamp < lockedUntil) vm.warp(lockedUntil);
            _push(floor);
            vault.requestUnlockRound(); // reverts if a draw was requested less than a day ago
            uint256 chance = vault.drawChanceBps(block.timestamp - acquiredAt);
            uint256 word = 1;
            while (uint256(keccak256(abi.encode(word, id))) % 10_000 >= chance) ++word;
            randomness.fulfill(randomness.lastRequestId(), word);
            // reverts unless the median floor meets the multiple the holding's age needs and the
            // weekly release cap has room
            vault.unlock(id);
        }
    }

    function relock(uint256 seed, uint32 extra, bool fromUnlocked) external {
        uint256 id = _holding(seed, fromUnlocked ? Vault.Status.Unlocked : Vault.Status.Locked);
        if (id == 0) return;
        (,,,, uint40 lockedUntil,,) = vault.holdings(id);
        uint256 from = lockedUntil > block.timestamp ? lockedUntil : block.timestamp;
        vm.prank(gov);
        vault.relock(id, from + bound(extra, 1, 60 days));
    }

    /// Start or restart an auction at oracle prices, as the owner or as anyone. Auctions in any state
    /// are tried too, so restarts of running auctions are exercised (and must revert).
    function startAuction(uint256 seed, uint8 actorSeed, bool byGov, bool restart, bool wait) external {
        uint256 id = _holding(seed, restart ? Vault.Status.Auction : Vault.Status.Unlocked);
        if (id == 0) return;
        if (wait) {
            skip(restart ? 3 days : 30 days);
            _push(seed);
        }
        vm.prank(byGov ? gov : _actor(actorSeed));
        vault.startAuction(id);
        ownerPriced[id] = false;
    }

    function startAuctionWithPrices(uint256 seed, uint96 start, uint96 end, bool restart) external {
        uint256 id = _holding(seed, restart ? Vault.Status.Auction : Vault.Status.Unlocked);
        if (id == 0) return;
        uint256 e = bound(end, 1, 50 ether);
        uint256 s = bound(start, e, 100 ether);
        vm.prank(gov);
        vault.startAuctionWithPrices(id, s, e);
        ownerPriced[id] = true;
    }

    function buy(uint256 seed, uint8 actorSeed, uint96 extra) external {
        uint256 id = _holding(seed, Vault.Status.Auction);
        if (id == 0) return;
        address buyer = _actor(actorSeed);
        uint256 price = vault.auctionPrice(id);
        uint256 before = buyer.balance;
        vm.prank(buyer);
        vault.buy{value: price + bound(extra, 0, 5 ether)}(id);
        assertEq(before - buyer.balance, price, "buyer charged exactly the price");
        auctionProceeds += price;
    }

    function sendToRaffle(uint256 seed) external {
        uint256 id = _holding(seed, Vault.Status.Unlocked);
        if (id == 0) return;
        vm.prank(gov);
        vault.sendToRaffle(id);
    }

    // ------------------------------------------------------------------ points and raffle

    function earn(uint8 actorSeed, uint64 feeWei, bool flush) external {
        address user = actor(actorSeed);
        points.creditFee(user, feeWei); // this handler has a rate
        if (flush) points.flush(user); // reverts while a draw is in flight
    }

    function draw(uint256 seed, bool wait) external {
        uint256 id = _raffle(seed, VaultRaffle.Status.Open);
        if (id == 0) return;
        (,, uint40 drawAfter,,,) = raffle.raffles(id);
        if (wait && block.timestamp < drawAfter) vm.warp(drawAfter);
        raffle.draw(id);
    }

    function fulfil(uint256 seed, uint256 word, bool late) external {
        uint256 id = _raffle(seed, VaultRaffle.Status.Drawing);
        if (id == 0) return;
        if (late) skip(1 days);
        randomness.fulfill(raffle.currentRequest(id), word);
        ++fulfilled;
    }

    /// A stale or unknown request id must never change anything.
    function fulfilArbitrary(uint8 requestId, uint256 word) external {
        uint256 id = raffle.raffleOfRequest(requestId);
        if (id != 0 && raffle.currentRequest(id) == requestId) return; // that one is live
        randomness.fulfill(requestId, word);
        fail(); // unreachable: a request that is not current must revert
    }

    function resetDraw(uint256 seed, bool wait) external {
        uint256 id = _raffle(seed, VaultRaffle.Status.Drawing);
        if (id == 0) return;
        if (wait) skip(1 days);
        raffle.resetDraw(id);
    }

    function claimPrize(uint256 seed) external {
        uint256 id = _raffle(seed, VaultRaffle.Status.Won);
        if (id == 0) return;
        uint256 vestsAt = raffle.claimableAt(id);
        if (block.timestamp < vestsAt) vm.warp(vestsAt);
        raffle.claim(id);
    }

    // ------------------------------------------------------------------ prediction market

    function createMarket(uint32 betting, uint32 duration, uint96 price) external {
        uint256 b = bound(betting, 10 minutes, 2 days);
        uint256 d = bound(duration, 2 * b, 30 days);
        _push(price);
        prediction.createMarket(address(nft), b, d);
    }

    function placeBet(uint256 seed, uint8 actorSeed, uint96 amount, bool higher) external {
        uint256 id = _market(seed, true);
        if (id == 0) return;
        address bettor = _actor(actorSeed);
        uint256 a = bound(amount, 0.001 ether, 50 ether);
        vm.prank(bettor);
        prediction.placeBet{value: a}(id, higher); // reverts once betting has closed
        predictionIn += a;
    }

    function resolve(uint256 seed, bool wait, bool push, uint96 price) external {
        uint256 id = _market(seed, true);
        if (id == 0) return;
        (,,, uint40 resolveTime,,,) = prediction.markets(id);
        if (wait && block.timestamp < resolveTime) vm.warp(resolveTime);
        if (push) _push(price);
        prediction.resolve(id);
    }

    function claimBet(uint256 seed, uint8 actorSeed) external {
        uint256 id = _market(seed, false);
        if (id == 0) return;
        address bettor = actor(actorSeed);
        uint256 before = bettor.balance;
        uint256 budgetBefore = treasury.budgetOf(address(nft)) + treasury.totalOwed();
        vm.prank(bettor);
        prediction.claim(id);
        predictionOut += bettor.balance - before;
        predictionFees += treasury.budgetOf(address(nft)) + treasury.totalOwed() - budgetBefore;
    }

    /// A whole two-sided market in one step, so settled markets with fees are reached often. Claims are
    /// left to `claimBet`, except for one random bettor.
    function predictionRound(uint96 startPrice, uint96 endPrice, uint96[4] calldata amounts, uint8 claimer)
        external
    {
        _push(startPrice);
        uint256 id = prediction.createMarket(address(nft), 1 hours, 2 hours);
        for (uint256 i; i < 4; ++i) {
            address bettor = _actor(i);
            uint256 a = bound(amounts[i], 0.001 ether, 50 ether);
            vm.prank(bettor);
            prediction.placeBet{value: a}(id, i % 2 == 0);
            predictionIn += a;
        }
        skip(2 hours);
        _push(endPrice);
        prediction.resolve(id);
        address c = actor(claimer);
        uint256 before = c.balance;
        uint256 budgetBefore = treasury.budgetOf(address(nft)) + treasury.totalOwed();
        vm.prank(c);
        prediction.claim(id);
        predictionOut += c.balance - before;
        predictionFees += treasury.budgetOf(address(nft)) + treasury.totalOwed() - budgetBefore;
    }

    function setPredictionFee(uint16 feeBps) external {
        vm.prank(gov);
        prediction.setParams(bound(feeBps, 0, 1_000), 0.001 ether, 1 days);
    }
}

contract CoreAuditInvariants is Base {
    CoreHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new CoreHandler(
            gov, treasury, engine, vault, raffle, prediction, points, pushOracle, randomness, nft
        );
        vm.startPrank(gov);
        engine.configureBid(address(nft), 1 ether, 5 ether, 2_000, 1_000, true);
        treasury.setProjectShare(address(nft), makeAddr("project"), 2_500);
        points.setRate(address(handler), 1_000e18);
        vm.stopPrank();
        _pushFloor(2 ether);
        targetContract(address(handler));
    }

    /// Shows how deep a run got (visible with -vv).
    function afterInvariant() public view {
        uint256 won;
        uint256 claimed;
        for (uint256 id = 1; id <= raffle.raffleCount(); ++id) {
            (,,,, VaultRaffle.Status status,) = raffle.raffles(id);
            if (status == VaultRaffle.Status.Won) ++won;
            if (status == VaultRaffle.Status.Claimed) ++claimed;
        }
        console2.log("holdings / raffles", vault.holdingCount(), raffle.raffleCount());
        console2.log("raffles won / claimed", won, claimed);
        console2.log(
            "auction proceeds / prediction paid out", handler.auctionProceeds(), handler.predictionOut()
        );
        console2.log("markets / prediction fees", prediction.marketCount(), handler.predictionFees());
    }

    /// Every wei in the treasury belongs to a budget, the unallocated pool or a project share, and the
    /// budget is exactly what was put in minus what buybacks paid out.
    function invariant_treasuryAccounted() public view {
        assertEq(
            address(treasury).balance,
            treasury.budgetOf(address(nft)) + treasury.unallocated() + treasury.totalOwed()
        );
        assertEq(
            treasury.budgetOf(address(nft)) + treasury.totalOwed(),
            handler.budgetFunded() + handler.auctionProceeds() + handler.predictionFees()
                - handler.buybackSpent()
        );
    }

    /// The engine, the vault and the raffle never hold ETH.
    function invariant_noStrayEth() public view {
        assertEq(address(engine).balance, 0);
        assertEq(address(vault).balance, 0);
        assertEq(address(raffle).balance, 0);
    }

    /// Every NFT the protocol bought is where its state says it is.
    function invariant_nftsAccounted() public view {
        uint256 inVault;
        uint256 n = vault.holdingCount();
        for (uint256 id = 1; id <= n; ++id) {
            (, uint256 tokenId, uint128 purchasePrice,,,, Vault.Status status) = vault.holdings(id);
            assertTrue(status != Vault.Status.None);
            if (status == Vault.Status.Released) {
                assertTrue(nft.ownerOf(tokenId) != address(vault));
            } else {
                assertEq(nft.ownerOf(tokenId), address(vault));
                ++inVault;
            }
            if (status == Vault.Status.Auction && !handler.ownerPriced(id)) {
                (, uint128 endPrice,) = vault.auctions(id);
                assertGe(endPrice, uint256(purchasePrice) * 13_000 / 10_000, "public reserve below 130%");
            }
        }
        assertEq(nft.balanceOf(address(vault)), inVault);
        assertEq(nft.balanceOf(address(engine)), 0);

        uint256 inRaffle;
        uint256 drawing;
        uint256 r = raffle.raffleCount();
        for (uint256 id = 1; id <= r; ++id) {
            (, uint256 tokenId,,, VaultRaffle.Status status, address winner) = raffle.raffles(id);
            if (status == VaultRaffle.Status.Claimed) {
                assertEq(nft.ownerOf(tokenId), winner);
            } else {
                assertEq(nft.ownerOf(tokenId), address(raffle));
                ++inRaffle;
            }
            if (status == VaultRaffle.Status.Drawing) {
                ++drawing;
                assertTrue(raffle.currentRequest(id) != 0);
            } else {
                assertEq(raffle.currentRequest(id), 0);
            }
            if (status == VaultRaffle.Status.Won || status == VaultRaffle.Status.Claimed) {
                assertTrue(winner != address(0));
            }
        }
        assertEq(nft.balanceOf(address(raffle)), inRaffle);
        // points are frozen exactly while a draw is in flight
        assertEq(points.freezeCount(), drawing);
    }

    /// The points tree total equals the sum of the holders' balances.
    function invariant_pointsTreeConsistent() public view {
        uint256 sum;
        for (uint256 i; i < handler.ACTORS(); ++i) {
            sum += points.pointsOf(handler.actor(i));
        }
        assertEq(points.totalPoints(), sum);
    }

    /// The prediction market holds exactly bets minus payouts minus fees, and that covers every claim
    /// still open (computed independently here) in every market at once.
    function invariant_predictionSolvent() public view {
        assertEq(
            address(prediction).balance,
            handler.predictionIn() - handler.predictionOut() - handler.predictionFees()
        );
        uint256 owed;
        uint256 n = prediction.marketCount();
        for (uint256 id = 1; id <= n; ++id) {
            (,,,, uint128 higherPool, uint128 lowerPool, PredictionMarket.Outcome outcome) =
                prediction.markets(id);
            for (uint256 i; i < handler.ACTORS(); ++i) {
                (uint128 h, uint128 l) = prediction.stakes(id, handler.actor(i));
                if (outcome == PredictionMarket.Outcome.Pending || outcome == PredictionMarket.Outcome.Void) {
                    owed += uint256(h) + l;
                } else if (outcome == PredictionMarket.Outcome.Higher) {
                    if (h != 0) owed += h + uint256(h) * lowerPool / higherPool;
                } else {
                    if (l != 0) owed += l + uint256(l) * higherPool / lowerPool;
                }
            }
        }
        assertGe(address(prediction).balance, owed);
    }
}
