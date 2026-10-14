// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
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
import {IRandomnessProvider} from "../src/interfaces/IFloorGuard.sol";
import {MockNFT} from "./mocks/MockNFT.sol";
import {MockRandomness} from "./mocks/MockRandomness.sol";

/// @dev Cannot receive ETH. Can receive NFTs.
contract Rejector {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

/// @dev Burns gas on receive: everything it is given when called with a stipend (so the call fails),
///      roughly 150k when called with plenty (so the call succeeds, expensively).
contract Burner {
    receive() external payable {
        if (gasleft() <= 160_000) {
            assembly {
                invalid()
            }
        }
        uint256 x;
        for (uint256 i; i < 900; ++i) {
            x = uint256(keccak256(abi.encode(x, i)));
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

/// @dev A royalty receiver that reverts.
contract RevertingReceiver {
    receive() external payable {
        revert("no royalties please");
    }
}

/// @dev Calls back into the protocol whenever it receives ETH or an NFT.
contract Reenterer {
    address public target;
    bytes public data;
    bool private busy;
    uint256 public reentered;

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
    }

    function disarm() external {
        target = address(0);
    }

    function _hook() private {
        if (target == address(0) || busy) return;
        busy = true;
        (bool ok,) = target.call(data);
        if (ok) ++reentered;
        busy = false;
    }

    receive() external payable {
        _hook();
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        _hook();
        return this.onERC721Received.selector;
    }
}

/// @notice Review 7: one handler for the whole protocol. Deploys and wires everything like
///         `script/Deploy.s.sol` on a local chain (Vault on the sales oracle, PredictionMarket on the push
///         oracle, a shared randomness mock for the vault raffle and games, one each for the ticket
///         raffle and the lottery) and exposes actions for a stateful fuzzer plus the global checks.
/// @dev No action reverts and no ETH is minted after construction, so global conservation can be checked.
contract SystemHandler is Test {
    uint256 internal constant TOKENS = 18;

    address public gov = makeAddr("r7.gov");
    address public proj = makeAddr("r7.project");
    address public royEOA = makeAddr("r7.royalty");

    Treasury public treasury;
    Marketplace public marketplace;
    BuybackEngine public engine;
    Vault public vault;
    SalesFloorOracle public salesOracle;
    PushFloorOracle public pushOracle;
    PredictionMarket public prediction;
    Points public points;
    VaultRaffle public raffle;
    Games public games;
    TicketRaffle public ticketRaffle;
    Lottery public lottery;
    IPLicenseManager public licenses;
    MockRandomness public rndShared;
    /// The Vault's own provider for its daily unlock draw.
    MockRandomness public vaultRnd;

    MockNFT[3] public cols; // 0 and 1 are supported everywhere, 2 is supported nowhere
    Rejector public rejector;
    Burner public burner;
    Reenterer public reenterer;
    RevertingReceiver public royRevert;

    address[] public actors;
    mapping(address => bool) public isActor;
    /// actors that can take ETH when called with all gas
    mapping(address => bool) public isNormal;
    address[] public ethHolders;
    uint256 public initialEth;

    uint256[] public betIds;
    mapping(uint256 => bool) internal betSeen;

    mapping(string => uint256) public hits;
    string[] public hitNames;
    uint256 public steps;
    uint256 public lastDust;
    string public ghostViolation;

    // ------------------------------------------------------------------ setup

    constructor() {
        vm.warp(1_760_000_000);
        _deploy();
        _makeActors();
        _seed();
        initialEth = totalEth();
    }

    function _deploy() private {
        vm.startPrank(gov);
        treasury = new Treasury(gov);
        salesOracle = new SalesFloorOracle(gov);
        pushOracle = new PushFloorOracle(gov);
        marketplace = new Marketplace(gov, treasury);
        vault = new Vault(gov, treasury, salesOracle);
        engine = new BuybackEngine(gov, treasury, vault);
        prediction = new PredictionMarket(gov, treasury, pushOracle);
        points = new Points(gov);
        rndShared = new MockRandomness();
        raffle = new VaultRaffle(gov, points, address(vault), rndShared);
        games = new Games(gov, treasury, rndShared);
        ticketRaffle = new TicketRaffle(gov, treasury, new MockRandomness());
        licenses = new IPLicenseManager(gov, vault, treasury);
        lottery = new Lottery(gov, treasury, new MockRandomness());

        treasury.setSpender(address(engine));
        vault.setEngine(address(engine));
        vault.setRaffle(raffle);
        vaultRnd = new MockRandomness();
        vault.setRandomness(vaultRnd);
        marketplace.setSaleRecorder(salesOracle);
        engine.setSaleRecorder(salesOracle);
        salesOracle.setReporter(address(marketplace), true);
        salesOracle.setReporter(address(engine), true);
        pushOracle.setReporter(gov, true);
        points.setRaffle(address(raffle));
        points.setRate(address(marketplace), 2_500e18);
        points.setRate(address(prediction), 2_500e18);
        points.setRate(address(games), 2_500e18);
        marketplace.setPoints(points);
        prediction.setPoints(points);
        games.setPoints(points);
        vm.stopPrank();

        for (uint256 i; i < 3; ++i) {
            cols[i] = new MockNFT();
        }
        rejector = new Rejector();
        burner = new Burner();
        reenterer = new Reenterer();
        royRevert = new RevertingReceiver();
    }

    function _makeActors() private {
        for (uint256 i; i < 4; ++i) {
            address a = makeAddr(string.concat("r7.actor", vm.toString(i)));
            actors.push(a);
            isNormal[a] = true;
        }
        actors.push(address(rejector));
        actors.push(address(burner));
        isNormal[address(burner)] = true;
        actors.push(address(reenterer));
        isNormal[address(reenterer)] = true;

        for (uint256 i; i < actors.length; ++i) {
            address a = actors[i];
            isActor[a] = true;
            vm.deal(a, 10_000 ether);
            ethHolders.push(a);
            for (uint256 c; c < 3; ++c) {
                vm.startPrank(a);
                cols[c].setApprovalForAll(address(marketplace), true);
                cols[c].setApprovalForAll(address(engine), true);
                cols[c].setApprovalForAll(address(ticketRaffle), true);
                vm.stopPrank();
            }
        }
        for (uint256 c; c < 3; ++c) {
            for (uint256 id = 1; id <= TOKENS; ++id) {
                cols[c].mint(actors[(id + c) % actors.length], id);
            }
            ethHolders.push(address(cols[c]));
        }
        vm.deal(gov, 5_000 ether);
        address[19] memory others = [
            gov,
            proj,
            royEOA,
            address(royRevert),
            address(this),
            address(treasury),
            address(marketplace),
            address(engine),
            address(vault),
            address(salesOracle),
            address(pushOracle),
            address(prediction),
            address(points),
            address(raffle),
            address(games),
            address(ticketRaffle),
            address(lottery),
            address(licenses),
            address(rndShared)
        ];
        for (uint256 i; i < others.length; ++i) {
            ethHolders.push(others[i]);
        }
        ethHolders.push(address(ticketRaffle.randomness()));
        ethHolders.push(address(lottery.randomness()));
    }

    function _seed() private {
        vm.startPrank(gov);
        for (uint256 c; c < 2; ++c) {
            address col = address(cols[c]);
            marketplace.setCollectionSupport(col, true);
            prediction.setCollectionSupport(col, true);
            games.setCollectionSupport(col, true);
            ticketRaffle.setCollectionSupport(col, true);
            engine.configureBid(col, 1 ether, 3 ether, 1_000, 500, true);
            treasury.deposit{value: 30 ether}(col);
            pushOracle.pushFloor(col, 1 ether);
        }
        lottery.setConfig(address(cols[0]), 0.01 ether, 1 days, true);
        lottery.setConfig(address(cols[1]), 0.05 ether, 3 hours, true);
        treasury.setProjectShare(address(cols[1]), proj, 2_000);
        games.fundBankroll{value: 1_000 ether}();
        licenses.setTier(address(cols[0]), 0, 0.01 ether, 30 days, true);
        licenses.setTier(address(cols[1]), 1, 0.05 ether, 90 days, true);
        vm.stopPrank();
        cols[0].setRoyalty(royEOA, 300);
        cols[1].setRoyalty(address(royRevert), 500);
    }

    function actionSelectors() external pure returns (bytes4[] memory s) {
        s = new bytes4[](28);
        s[0] = this.mpOffer.selector;
        s[1] = this.mpAccept.selector;
        s[2] = this.mpCancel.selector;
        s[3] = this.engSell.selector;
        s[4] = this.engAdmin.selector;
        s[5] = this.vUnlock.selector;
        s[6] = this.vGov.selector;
        s[7] = this.vStartAuction.selector;
        s[8] = this.vBuy.selector;
        s[9] = this.vrOp.selector;
        s[10] = this.ptsFlush.selector;
        s[11] = this.pmCreate.selector;
        s[12] = this.pmBet.selector;
        s[13] = this.pmOp.selector;
        s[14] = this.gPlay.selector;
        s[15] = this.gSpin.selector;
        s[16] = this.gSettle.selector;
        s[17] = this.gAdmin.selector;
        s[18] = this.trCreate.selector;
        s[19] = this.trBuy.selector;
        s[20] = this.trOp.selector;
        s[21] = this.lBuy.selector;
        s[22] = this.lOp.selector;
        s[23] = this.licOp.selector;
        s[24] = this.admin.selector;
        s[25] = this.warp.selector;
        s[26] = this.washTrade.selector;
        s[27] = this.vDraw.selector;
    }

    // ------------------------------------------------------------------ helpers

    modifier step() {
        _;
        ++steps;
        _sync();
        uint256 owed = pmOwed();
        uint256 bal = address(prediction).balance;
        if (bal < owed) {
            ghostViolation = "PredictionMarket cannot cover open claims";
        } else {
            if (bal - owed < lastDust) ghostViolation = "PredictionMarket dust shrank";
            lastDust = bal - owed;
        }
    }

    // Entities that can still hold value or change state. Finished ones are dropped so that the checks
    // stay cheap in long runs; a finished entity owes nothing and has no way back.
    uint256[] public aOffers;
    uint256[] public aMarkets;
    uint256[] public aTicketRaffles;
    uint256[] public aVaultRaffles;
    uint256[] public aRounds;
    uint256[] public aHoldings;
    uint256[6] internal seen;

    function _sync() internal {
        for (uint256 n = marketplace.offerCount(); seen[0] < n;) {
            aOffers.push(++seen[0]);
        }
        for (uint256 n = prediction.marketCount(); seen[1] < n;) {
            aMarkets.push(++seen[1]);
        }
        for (uint256 n = ticketRaffle.raffleCount(); seen[2] < n;) {
            aTicketRaffles.push(++seen[2]);
        }
        for (uint256 n = raffle.raffleCount(); seen[3] < n;) {
            aVaultRaffles.push(++seen[3]);
        }
        for (uint256 n = lottery.roundCount(); seen[4] < n;) {
            aRounds.push(++seen[4]);
        }
        for (uint256 n = vault.holdingCount(); seen[5] < n;) {
            aHoldings.push(++seen[5]);
        }
        _prune(aOffers, _offerDone);
        _prune(aMarkets, _marketDone);
        _prune(aTicketRaffles, _ticketRaffleDone);
        _prune(aVaultRaffles, _vaultRaffleDone);
        _prune(aRounds, _roundDone);
        _prune(aHoldings, _holdingDone);
        for (uint256 i = betIds.length; i > 0; --i) {
            (address player,,,,,,) = games.bets(betIds[i - 1]);
            if (player != address(0)) continue;
            betSeen[betIds[i - 1]] = false;
            betIds[i - 1] = betIds[betIds.length - 1];
            betIds.pop();
        }
    }

    function _prune(uint256[] storage list, function(uint256) internal view returns (bool) done) private {
        for (uint256 i = list.length; i > 0; --i) {
            if (!done(list[i - 1])) continue;
            list[i - 1] = list[list.length - 1];
            list.pop();
        }
    }

    function _offerDone(uint256 id) internal view returns (bool) {
        (,,,, uint32 remaining,,) = marketplace.offers(id);
        return remaining == 0;
    }

    function _marketDone(uint256 id) internal view returns (bool) {
        if (_outcome(id) == PredictionMarket.Outcome.Pending) return false;
        for (uint256 i; i < actors.length; ++i) {
            (uint128 hi, uint128 lo) = prediction.stakes(id, actors[i]);
            if (hi != 0 || lo != 0) return false;
        }
        return true;
    }

    function _ticketRaffleDone(uint256 id) internal view returns (bool) {
        TicketRaffle.Status status = _trStatus(id);
        if (status == TicketRaffle.Status.Settled || status == TicketRaffle.Status.Cancelled) return true;
        if (status != TicketRaffle.Status.Refunding || !ticketRaffle.nftReturned(id)) return false;
        for (uint256 i; i < actors.length; ++i) {
            if (ticketRaffle.paidBy(id, actors[i]) != 0) return false;
        }
        return true;
    }

    function _vaultRaffleDone(uint256 id) internal view returns (bool) {
        return _vrStatus(id) == VaultRaffle.Status.Claimed;
    }

    function _roundDone(uint256 id) internal view returns (bool) {
        Lottery.Status status = _roundStatus(id);
        if (status == Lottery.Status.Won) return true;
        if (status != Lottery.Status.Refunding) return false;
        for (uint256 i; i < actors.length; ++i) {
            if (lottery.paidBy(id, actors[i]) != 0) return false;
        }
        return true;
    }

    function _holdingDone(uint256 id) internal view returns (bool) {
        return _holdingStatus(id) == Vault.Status.Released;
    }

    function _hit(string memory name) internal {
        if (hits[name]++ == 0) hitNames.push(name);
    }

    function hitCount() external view returns (uint256) {
        return hitNames.length;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _a(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    function _col(uint256 s) internal view returns (MockNFT) {
        return s % 7 == 6 ? cols[2] : cols[s % 2];
    }

    function _price(uint256 s) internal pure returns (uint256) {
        if (s % 16 == 0) return 1 + (s >> 8) % 1_000;
        return bound(s >> 8, 0.01 ether, 5 ether);
    }

    function _ownedToken(MockNFT c, uint256 seed) internal view returns (bool, uint256, address) {
        for (uint256 i; i < TOKENS; ++i) {
            uint256 id = 1 + (seed % TOKENS + i) % TOKENS;
            address o = c.ownerOf(id);
            if (isActor[o]) return (true, id, o);
        }
        return (false, 0, address(0));
    }

    // ------------------------------------------------------------------ marketplace

    function mpOffer(uint256 s1, uint256 s2, uint256 s3) external step {
        address a = _a(s1);
        address c = address(_col(s2));
        uint256 price = _price(s3);
        uint256 expiry = block.timestamp + bound(s3 >> 128, 1 hours, 10 days);
        if ((s2 >> 8) % 2 == 0) {
            uint256 tokenId = 1 + (s2 >> 16) % TOKENS;
            vm.prank(a);
            try marketplace.makeOffer{value: price}(c, tokenId, expiry) {
                _hit("mp.makeOffer");
            } catch {}
        } else {
            uint256 q = 1 + (s2 >> 16) % 3;
            vm.prank(a);
            try marketplace.makeCollectionOffer{value: price * q}(c, q, expiry) {
                _hit("mp.makeCollectionOffer");
            } catch {}
        }
    }

    function _liveOffer(uint256 seed) internal view returns (uint256) {
        uint256 n = marketplace.offerCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = 1 + (seed % n + i) % n;
            (,,,, uint32 remaining,,) = marketplace.offers(id);
            if (remaining != 0) return id;
        }
        return 0;
    }

    function mpAccept(uint256 s1, uint256 s2, uint256) external step {
        uint256 id = _liveOffer(s1);
        if (id == 0) return;
        // prefer an offer that has not expired
        for (uint256 k; k < aOffers.length; ++k) {
            uint256 candidate = aOffers[(s1 % aOffers.length + k) % aOffers.length];
            (,,,, uint32 remaining, uint40 expiry,) = marketplace.offers(candidate);
            if (remaining == 0 || block.timestamp > expiry) continue;
            id = candidate;
            break;
        }
        (, address c, uint256 tokenId,,,, bool wide) = marketplace.offers(id);
        address seller;
        if (wide) {
            bool found;
            (found, tokenId, seller) = _ownedToken(MockNFT(c), s2);
            if (!found) return;
        } else {
            seller = MockNFT(c).ownerOf(tokenId);
            if (!isActor[seller]) return;
        }
        vm.prank(seller);
        try marketplace.acceptOffer(id, tokenId, 0) {
            _hit(wide ? "mp.acceptCollectionOffer" : "mp.acceptTokenOffer");
        } catch {}
    }

    function mpCancel(uint256 s1, uint256, uint256) external step {
        uint256 id = _liveOffer(s1);
        if (id == 0) return;
        (address offerer,,,,,,) = marketplace.offers(id);
        vm.prank(offerer);
        try marketplace.cancelOffer(id) {
            _hit("mp.cancelOffer");
        } catch {}
    }

    /// Four collection-offer fills at one price: the documented way to move the sales oracle.
    function washTrade(uint256 s1, uint256 s2, uint256 s3) external step {
        _wash(address(cols[s1 % 2]), s3 % 5 == 0 ? 1 : bound(s3 >> 8, 0.5 ether, 9 ether), s1 >> 8, s2);
    }

    function _wash(address c, uint256 price, uint256 s1, uint256 s2) internal {
        for (uint256 i; i < 4; ++i) {
            (bool found, uint256 tokenId, address seller) = _ownedToken(MockNFT(c), s2 % TOKENS + i);
            if (!found) return;
            address buyer = actors[s1 % 4];
            vm.prank(buyer);
            try marketplace.makeCollectionOffer{value: price}(c, 1, block.timestamp + 1) {}
            catch {
                return;
            }
            uint256 id = marketplace.offerCount();
            vm.prank(seller);
            try marketplace.acceptOffer(id, tokenId, 0) {
                _hit("mp.washFill");
            } catch {}
        }
    }

    // ------------------------------------------------------------------ buyback engine

    function engSell(uint256 s1, uint256 s2, uint256) external step {
        MockNFT c = cols[s1 % 2];
        (bool found, uint256 tokenId, address seller) = _ownedToken(c, s2);
        if (!found) return;
        vm.prank(seller);
        try engine.sell(address(c), tokenId, 0) {
            _hit("engine.sell");
        } catch {}
    }

    function engAdmin(uint256 s1, uint256 s2, uint256 s3) external step {
        address c = address(cols[s1 % 2]);
        uint256 op = s2 % 4;
        if (op == 0) {
            uint256 base = _price(s3);
            uint256 max = base * bound(s3 >> 200, 1, 4);
            vm.prank(gov);
            try engine.configureBid(
                c,
                uint128(base),
                uint128(max),
                uint16((s2 >> 8) % 5_000),
                uint16((s2 >> 24) % 3_000),
                (s2 >> 40) % 8 != 0
            ) {
                _hit("engine.configureBid");
            } catch {}
        } else if (op == 1) {
            vm.prank(gov);
            try engine.setFillCooldown(c, (s3 % 3) * 12 hours) {
                _hit("engine.setFillCooldown");
            } catch {}
        } else if (op == 2) {
            vm.prank(s3 % 2 == 0 ? gov : _a(s3 >> 8));
            try treasury.deposit{value: bound(s3 >> 16, 1, 5 ether)}(c) {
                _hit("treasury.deposit");
            } catch {}
        } else {
            address from = _a(s3);
            vm.prank(from);
            (bool ok,) = address(treasury).call{value: bound(s3 >> 16, 1, 2 ether)}("");
            if (ok) _hit("treasury.receive");
            uint256 un = treasury.unallocated();
            vm.prank(gov);
            try treasury.allocate(c, un / 2) {
                _hit("treasury.allocate");
            } catch {}
        }
    }

    // ------------------------------------------------------------------ vault

    function _holdingIn(uint256 seed, Vault.Status wanted) internal view returns (uint256) {
        uint256 n = vault.holdingCount();
        if (n == 0) return 0;
        for (uint256 i; i < n; ++i) {
            uint256 id = 1 + (seed % n + i) % n;
            (,,,,,, Vault.Status status) = vault.holdings(id);
            if (status == wanted) return id;
        }
        return 1 + seed % n;
    }

    function _holdingStatus(uint256 id) internal view returns (Vault.Status status) {
        (,,,,,, status) = vault.holdings(id);
    }

    function vUnlock(uint256 s1, uint256 s2, uint256) external step {
        uint256 id = _holdingIn(s1, Vault.Status.Locked);
        if (id != 0 && s2 % 6 == 0 && !vault.isPlayersHolding(id)) _patientUnlocker(id, s2);
        vm.prank(_a(s2));
        try vault.unlock(id) {
            _hit("vault.unlock (permissionless)");
        } catch {}
    }

    /// Someone who wants a holding out: washes the sales oracle to at least 130% of the purchase price
    /// (sometimes far above, to hit the cap) and samples it daily until the collection has a usable
    /// median, waits for the lock to end, then waits for a daily draw that picks the holding.
    function _patientUnlocker(uint256 id, uint256 s2) private {
        (address c,, uint128 purchasePrice,, uint40 lockedUntil,,) = vault.holdings(id);
        uint256 days_ = _samplingDaysNeeded(c, purchasePrice);
        uint256 sampleFrom = lockedUntil > days_ * 1 days ? lockedUntil - days_ * 1 days : 0;
        if (block.timestamp < sampleFrom) vm.warp(sampleFrom);
        uint256 target =
            uint256(purchasePrice) * ((s2 >> 8) % 4 == 0 ? 400 : bound(s2 >> 16, 13, 40)) / 10 + 1;
        for (uint256 d; d < days_; ++d) {
            _washAndSample(c, target, s2, d);
        }
        if (block.timestamp < lockedUntil) vm.warp(lockedUntil);
        _drawPicking(id);
    }

    /// A month of samples is only needed when the collection has no usable median high enough.
    function _samplingDaysNeeded(address c, uint128 purchasePrice) private view returns (uint256) {
        (bool usable, uint256 median) = vault.medianFloor(c);
        return usable && median >= uint256(purchasePrice) * 13 / 10 ? 0 : 16;
    }

    function _washAndSample(address c, uint256 target, uint256 s2, uint256 d) private {
        _wash(c, target, s2 >> 32, (s2 >> 64) + d);
        try vault.sampleFloor(c) {
            _hit("vault.sampleFloor");
        } catch {}
        skip(1 days);
    }

    function _drawPicking(uint256 id) private {
        (,,, uint40 acquiredAt,,,) = vault.holdings(id);
        try vault.requestUnlockRound() {
            uint256 chance = vault.drawChanceBps(block.timestamp - acquiredAt);
            uint256 word = 1;
            while (uint256(keccak256(abi.encode(word, id))) % 10_000 >= chance) ++word;
            vaultRnd.fulfill(vaultRnd.lastRequestId(), word);
        } catch {}
    }

    /// The moving lock's moving parts, driven by anyone: floor samples, the daily draw (fulfilled on time,
    /// late or never, with any word), releases of players' holdings, and the owner's players' share.
    function vDraw(uint256 s1, uint256 s2, uint256 s3) external step {
        uint256 op = s2 % 6;
        if (op == 0) {
            vm.prank(_a(s3));
            try vault.sampleFloor(address(cols[s1 % 3])) {
                _hit("vault.sampleFloor");
            } catch {}
        } else if (op == 1) {
            try vault.requestUnlockRound() {
                _hit("vault.requestUnlockRound");
                if (s3 % 3 == 0) return; // never answered
                if (s3 % 3 == 1) skip(1 days); // too late: must be ignored
                uint256 before = vault.seedArrivedAt();
                vaultRnd.fulfill(vaultRnd.lastRequestId(), s3 >> 8);
                if (s3 % 3 == 1 && vault.seedArrivedAt() != before) {
                    ghostViolation = "Vault used a late unlock word";
                }
            } catch {}
        } else if (op == 2) {
            // an arbitrary, usually stale, request id
            uint256 last = vaultRnd.lastRequestId();
            if (last == 0) return;
            uint256 requestId = 1 + s1 % last;
            bool current = vault.roundPending() && vault.roundRequestId() == requestId;
            try vaultRnd.fulfill(requestId, s3) {
                if (!current) ghostViolation = "Vault accepted a stale unlock word";
            } catch {}
        } else if (op == 3 || op == 4) {
            uint256 id = _holdingIn(s1, Vault.Status.Locked);
            if (id == 0) return;
            (,,,, uint40 lockedUntil,,) = vault.holdings(id);
            if (op == 4 && block.timestamp < lockedUntil) vm.warp(lockedUntil);
            vm.prank(_a(s3));
            try vault.releaseToPlayers(id) {
                _hit("vault.releaseToPlayers");
            } catch {}
        } else {
            vm.prank(gov);
            try vault.setPlayersShare(bound(s3, 0, 5_000)) {
                _hit("vault.setPlayersShare");
            } catch {}
        }
    }

    function vGov(uint256 s1, uint256 s2, uint256 s3) external step {
        uint256 op = s2 % 8;
        if (op == 0) {
            uint256 id = _holdingIn(s1, Vault.Status.Locked);
            vm.prank(gov);
            try vault.governanceUnlock(id) {
                _hit("vault.governanceUnlock");
            } catch {}
        } else if (op == 1) {
            uint256 id = _holdingIn(s1, s3 % 2 == 0 ? Vault.Status.Locked : Vault.Status.Unlocked);
            (,,,, uint40 lockedUntil,,) = vault.holdings(id);
            uint256 from = lockedUntil > block.timestamp ? lockedUntil : block.timestamp;
            vm.prank(gov);
            try vault.relock(id, from + bound(s3 >> 8, 1 hours, 60 days)) {
                _hit("vault.relock");
            } catch {}
        } else if (op == 2) {
            uint256 id = _holdingIn(s1, Vault.Status.Unlocked);
            vm.prank(gov);
            try vault.sendToRaffle(id) {
                _hit("vault.sendToRaffle");
            } catch {}
        } else if (op == 3) {
            uint256 id = _holdingIn(s1, s3 % 3 == 0 ? Vault.Status.Auction : Vault.Status.Unlocked);
            uint256 end = bound(s3 >> 8, 0.05 ether, 3 ether);
            vm.prank(gov);
            try vault.startAuctionWithPrices(id, end * bound(s3 >> 200, 1, 20), end) {
                _hit("vault.startAuctionWithPrices");
            } catch {}
        } else if (op == 4) {
            uint256 id = _holdingIn(s1, Vault.Status.Auction);
            vm.prank(gov);
            try vault.cancelAuction(id) {
                _hit("vault.cancelAuction");
            } catch {}
        } else if (op == 5) {
            vm.prank(gov);
            try vault.setMinReserve(
                address(cols[s1 % 2]), s3 % 3 == 0 ? 0 : bound(s3 >> 8, 0.01 ether, 6 ether)
            ) {
                _hit("vault.setMinReserve");
            } catch {}
        } else if (op == 6) {
            vm.prank(gov);
            try vault.setMaxOracleAge(bound(s3, 1 hours, 10 days)) {
                _hit("vault.setMaxOracleAge");
            } catch {}
        } else {
            uint256 id = _holdingIn(s1, Vault.Status.Unlocked);
            (address c,, uint128 purchasePrice,,,,) = vault.holdings(id);
            // half of the time there are recent sales to price the auction from
            if (id != 0 && s3 % 2 == 0) {
                _wash(c, uint256(purchasePrice) * bound(s3 >> 8, 5, 40) / 10 + 1, s3 >> 32, s3 >> 64);
            }
            vm.prank(gov);
            try vault.startAuction(id) {
                _hit("vault.startAuction (owner)");
            } catch {}
        }
    }

    function vStartAuction(uint256 s1, uint256 s2, uint256) external step {
        uint256 id = _holdingIn(s1, s2 % 2 == 0 ? Vault.Status.Unlocked : Vault.Status.Auction);
        (address c,, uint128 purchasePrice,,, uint40 unlockedAt, Vault.Status status) = vault.holdings(id);
        if (id != 0 && (s2 >> 4) % 3 != 0) {
            // someone waits out the governance window (or the running auction) and trades the oracle fresh
            if (status == Vault.Status.Unlocked && block.timestamp < uint256(unlockedAt) + 30 days) {
                vm.warp(uint256(unlockedAt) + 30 days);
            }
            if (status == Vault.Status.Auction && (s2 >> 6) % 2 == 0) vm.warp(block.timestamp + 5 days);
            _wash(
                c,
                (s2 >> 7) % 4 == 0 ? 1 : uint256(purchasePrice) * bound(s2 >> 16, 5, 40) / 10 + 1,
                s2 >> 32,
                s2 >> 64
            );
        }
        vm.prank(_a(s2 >> 8));
        try vault.startAuction(id) {
            _hit("vault.startAuction (anyone)");
        } catch {}
    }

    function vBuy(uint256 s1, uint256 s2, uint256 s3) external step {
        uint256 id = _holdingIn(s1, Vault.Status.Auction);
        if (id == 0 || _holdingStatus(id) != Vault.Status.Auction) return;
        uint256 price = vault.auctionPrice(id);
        if (price > 300 ether) return;
        address a = _a(s2);
        uint256 extra = s3 % 2 == 0 ? 0 : bound(s3 >> 8, 1, 1 ether);
        vm.prank(a);
        try vault.buy{value: price + extra}(id) {
            _hit("vault.buy");
        } catch {}
    }

    // ------------------------------------------------------------------ vault raffle and points

    function _vrIn(uint256 seed, VaultRaffle.Status wanted) internal view returns (uint256) {
        uint256 n = raffle.raffleCount();
        if (n == 0) return 0;
        for (uint256 i; i < n; ++i) {
            uint256 id = 1 + (seed % n + i) % n;
            if (_vrStatus(id) == wanted) return id;
        }
        return 1 + seed % n;
    }

    function _vrStatus(uint256 id) internal view returns (VaultRaffle.Status status) {
        (,,,, status,) = raffle.raffles(id);
    }

    function _fulfilVaultRaffle(uint256 id, uint256 word) internal {
        uint256 requestId = raffle.currentRequest(id);
        (,,, uint40 requestedAt,,) = raffle.raffles(id);
        try MockRandomness(address(raffle.randomness())).fulfill(requestId, word) {
            if (_vrStatus(id) == VaultRaffle.Status.Won) _hit("vaultRaffle.fulfil -> Won");
            else if (block.timestamp >= requestedAt + 1 days) _hit("vaultRaffle.fulfil late -> reset");
        } catch {}
    }

    function vrOp(uint256 s1, uint256 s2, uint256 s3) external step {
        uint256 op = s2 % 8;
        if (op <= 2) {
            uint256 id = _vrIn(s1, VaultRaffle.Status.Open);
            (,, uint40 drawAfter,,,) = raffle.raffles(id);
            // a patient keeper: wait for the announce period and activate everyone's points first
            if (id != 0 && s3 % 3 != 2 && block.timestamp < drawAfter) vm.warp(drawAfter);
            if (s3 % 3 != 1) {
                try points.flushMany(actors) {} catch {}
            }
            vm.prank(_a(s3));
            try raffle.draw(id) {
                _hit("vaultRaffle.draw");
                if (s3 % 2 == 0) _fulfilVaultRaffle(id, s3 >> 8);
            } catch {}
        } else if (op == 3) {
            uint256 id = _vrIn(s1, VaultRaffle.Status.Drawing);
            if (id == 0) return;
            _fulfilVaultRaffle(id, s3);
        } else if (op == 4) {
            // an arbitrary, usually stale, request id
            uint256 last = rndShared.lastRequestId();
            if (last == 0) return;
            uint256 requestId = 1 + s1 % last;
            if (rndShared.consumerOf(requestId) != address(raffle)) return;
            uint256 id = raffle.raffleOfRequest(requestId);
            bool current =
                _vrStatus(id) == VaultRaffle.Status.Drawing && raffle.currentRequest(id) == requestId;
            try rndShared.fulfill(requestId, s3) {
                if (!current) ghostViolation = "VaultRaffle accepted a stale request";
            } catch {
                _hit("vaultRaffle.fulfil stale reverted");
            }
        } else if (op == 5) {
            uint256 id = _vrIn(s1, VaultRaffle.Status.Drawing);
            try raffle.resetDraw(id) {
                _hit("vaultRaffle.resetDraw");
            } catch {}
        } else {
            uint256 id = _vrIn(s1, VaultRaffle.Status.Won);
            try raffle.claim(id) {
                _hit("vaultRaffle.claim");
            } catch {}
        }
    }

    function ptsFlush(uint256 s1, uint256 s2, uint256) external step {
        if (s2 % 2 == 0) {
            address a = _a(s1);
            uint256 pending = points.pendingOf(a);
            try points.flush(a) {
                if (pending != 0) _hit("points.flush");
            } catch {}
        } else {
            try points.flushMany(actors) {
                _hit("points.flushMany");
            } catch {}
        }
    }

    // ------------------------------------------------------------------ prediction market

    function _marketIn(uint256 seed, bool pending) internal view returns (uint256) {
        uint256 n = prediction.marketCount();
        if (n == 0) return 0;
        for (uint256 i; i < n; ++i) {
            uint256 id = 1 + (seed % n + i) % n;
            if ((_outcome(id) == PredictionMarket.Outcome.Pending) == pending) return id;
        }
        return 1 + seed % n;
    }

    function _outcome(uint256 id) internal view returns (PredictionMarket.Outcome outcome) {
        (,,,,,, outcome) = prediction.markets(id);
    }

    function _bettable() internal view returns (uint256 count) {
        for (uint256 k; k < aMarkets.length; ++k) {
            (,, uint40 closeTime,,,,) = prediction.markets(aMarkets[k]);
            if (block.timestamp < closeTime) ++count;
        }
    }

    function pmCreate(uint256 s1, uint256 s2, uint256 s3) external step {
        if (_bettable() >= 3) return _bet(s1, s2, s3);
        address c = address(cols[s1 % 2]);
        if (s1 % 3 == 0) {
            vm.prank(gov);
            pushOracle.pushFloor(c, bound(s1 >> 8, 0.2 ether, 5 ether));
        }
        uint256 bettingPeriod = bound(s2, 10 minutes, 2 days);
        uint256 duration = 2 * bettingPeriod + bound(s3, 0, 4 days);
        vm.prank(_a(s1 >> 4));
        try prediction.createMarket(c, bettingPeriod, duration) {
            _hit("pm.createMarket");
        } catch {}
    }

    function pmBet(uint256 s1, uint256 s2, uint256 s3) external step {
        _bet(s1, s2, s3);
    }

    function _bet(uint256 s1, uint256 s2, uint256 s3) internal {
        uint256 n = prediction.marketCount();
        if (n == 0) return;
        // prefer a market that still takes bets
        uint256 id = 1 + s1 % n;
        for (uint256 i; i < n; ++i) {
            uint256 candidate = 1 + (s1 % n + i) % n;
            (,, uint40 closeTime,,,,) = prediction.markets(candidate);
            if (block.timestamp < closeTime) {
                id = candidate;
                break;
            }
        }
        uint256 amount = s3 % 4 == 0 ? bound(s3 >> 8, 1, 0.01 ether) : bound(s3 >> 8, 0.001 ether, 5 ether);
        vm.prank(_a(s2));
        try prediction.placeBet{value: amount}(id, (s2 >> 8) % 2 == 0) {
            _hit("pm.placeBet");
        } catch {}
    }

    function pmOp(uint256 s1, uint256 s2, uint256 s3) external step {
        uint256 op = s2 % 6;
        if (op == 0) {
            vm.prank(gov);
            pushOracle.pushFloor(address(cols[s1 % 2]), bound(s3, 0.2 ether, 5 ether));
            _hit("pushOracle.pushFloor");
        } else if (op <= 2) {
            uint256 id = _marketIn(s1, true);
            if (id == 0) return;
            (address c,,, uint40 resolveTime,,,) = prediction.markets(id);
            if (s3 % 2 == 0) {
                // the keeper flow: wait, publish a price after the settlement time, then resolve
                if (block.timestamp < resolveTime) vm.warp(resolveTime);
                vm.prank(gov);
                pushOracle.pushFloor(c, bound(s3 >> 8, 0.2 ether, 5 ether));
            }
            try prediction.resolve(id) {
                PredictionMarket.Outcome o = _outcome(id);
                _hit(o == PredictionMarket.Outcome.Void ? "pm.resolve -> Void" : "pm.resolve -> Higher/Lower");
            } catch {}
        } else {
            uint256 id = _marketIn(s1, false);
            if (id == 0) return;
            address a = _a(s3);
            for (uint256 i; i < actors.length; ++i) {
                (uint128 hi, uint128 lo) =
                    prediction.stakes(id, actors[(s3 % actors.length + i) % actors.length]);
                if (hi == 0 && lo == 0) continue;
                a = actors[(s3 % actors.length + i) % actors.length];
                break;
            }
            uint256 before = a.balance;
            PredictionMarket.Outcome o = _outcome(id);
            vm.prank(a);
            try prediction.claim(id) {
                if (o == PredictionMarket.Outcome.Void) _hit("pm.claim refund");
                else if (a.balance > before) _hit("pm.claim winnings");
                else _hit("pm.claim loser (points only)");
            } catch {}
        }
    }

    // ------------------------------------------------------------------ games

    function _openBet(uint256 seed) internal view returns (uint256) {
        uint256 n = betIds.length;
        for (uint256 i; i < n; ++i) {
            uint256 id = betIds[(seed % n + i) % n];
            (address player,,,,,,) = games.bets(id);
            if (player != address(0)) return id;
        }
        return 0;
    }

    function _noteBet(uint256 id) internal {
        if (!betSeen[id]) {
            betSeen[id] = true;
            betIds.push(id);
        }
    }

    function gPlay(uint256 s1, uint256 s2, uint256 s3) external step {
        uint256 chance = s2 % 9 == 0 ? (s2 >> 8) % 10_001 : bound(s2 >> 8, 100, 9_500);
        uint256 wager = s3 % 8 == 0 ? bound(s3 >> 8, 0, 0.002 ether) : bound(s3 >> 8, 0.001 ether, 0.3 ether);
        vm.prank(_a(s1));
        try games.play{value: wager}(address(_col(s1 >> 8)), chance) returns (uint256 id) {
            _noteBet(id);
            _hit("games.play");
            if (s3 % 2 == 0) _fulfilBet(id, s2 >> 128);
        } catch {}
    }

    function gSpin(uint256 s1, uint256 s2, uint256 s3) external step {
        uint256 wager = s3 % 8 == 0 ? bound(s3 >> 8, 0, 0.002 ether) : bound(s3 >> 8, 0.001 ether, 0.2 ether);
        vm.prank(_a(s1));
        try games.spin{value: wager}(address(_col(s1 >> 8))) returns (uint256 id) {
            _noteBet(id);
            _hit("games.spin");
            if (s3 % 2 == 0) _fulfilBet(id, s2);
        } catch {}
    }

    function _fulfilBet(uint256 id, uint256 s3) internal {
        (address player,,,, uint16 chanceBps,, uint40 placedAt) = games.bets(id);
        // steer one roll in four into the top of the table so that rare payouts are reached
        uint256 word = s3 % 3 == 0 ? (s3 >> 8) % 30 : s3 >> 8;
        bool late = block.timestamp >= placedAt + 1 days;
        uint256 owedBefore = games.owedTo(player);
        try MockRandomness(address(games.randomness())).fulfill(id, word) {
            if (late) _hit("games.fulfil late -> refund");
            else if (chanceBps == 0 && word % 10_000 < 20) _hit("games.slots jackpot 50x");
            else if (chanceBps == 0) _hit("games.fulfil slots");
            else _hit(word % 10_000 < chanceBps ? "games.fulfil dice win" : "games.fulfil dice loss");
            if (games.owedTo(player) > owedBefore) _hit("games.payout deferred to owedTo");
        } catch {}
    }

    function gSettle(uint256 s1, uint256 s2, uint256 s3) external step {
        uint256 op = s2 % 6;
        if (op < 3) {
            uint256 id = _openBet(s1);
            if (id == 0) return;
            _fulfilBet(id, s3);
        } else if (op == 3) {
            uint256 id = _openBet(s1);
            if (id == 0) return;
            vm.prank(_a(s3));
            try games.refund(id) {
                _hit("games.refund");
            } catch {}
        } else {
            address a = _a(s1);
            for (uint256 i; i < actors.length; ++i) {
                if (games.owedTo(actors[(s1 % actors.length + i) % actors.length]) == 0) continue;
                a = actors[(s1 % actors.length + i) % actors.length];
                break;
            }
            vm.prank(a);
            try games.withdraw() {
                _hit("games.withdraw");
            } catch {}
        }
    }

    function gAdmin(uint256 s1, uint256 s2, uint256 s3) external step {
        uint256 op = s2 % 4;
        if (op == 0) {
            vm.prank(s1 % 2 == 0 ? gov : _a(s1 >> 8));
            try games.fundBankroll{value: bound(s3, 1, 20 ether)}() {
                _hit("games.fundBankroll");
            } catch {}
        } else if (op == 1) {
            // house shares replaced the owner's withdrawal: nothing to do here for the owner
            s3;
        } else if (op == 2) {
            uint256 minBet = s3 % 3 == 0 ? 1 : (s3 % 3 == 1 ? 0.001 ether : 0.01 ether);
            vm.prank(gov);
            try games.setParams(
                (s3 >> 8) % 1_001, minBet, (s3 >> 24) % 8 == 0 ? (s3 >> 32) % 50 : 50 + (s3 >> 32) % 251
            ) {
                _hit("games.setParams");
            } catch {}
        } else {
            vm.prank(gov);
            games.setCollectionSupport(address(cols[s1 % 2]), s3 % 12 != 0);
        }
    }

    // ------------------------------------------------------------------ ticket raffle

    function _trIn(uint256 seed, TicketRaffle.Status wanted) internal view returns (uint256) {
        uint256 n = ticketRaffle.raffleCount();
        if (n == 0) return 0;
        for (uint256 i; i < n; ++i) {
            uint256 id = 1 + (seed % n + i) % n;
            if (_trStatus(id) == wanted) return id;
        }
        return 1 + seed % n;
    }

    function _trStatus(uint256 id) internal view returns (TicketRaffle.Status status) {
        (,,,,,,,,, status,) = ticketRaffle.raffles(id);
    }

    function _selling() internal view returns (uint256 count) {
        for (uint256 k; k < aTicketRaffles.length; ++k) {
            (,,,,, uint32 m, uint32 sd, uint40 endTime,, TicketRaffle.Status st,) =
                ticketRaffle.raffles(aTicketRaffles[k]);
            if (st == TicketRaffle.Status.Open && block.timestamp < endTime && sd < m) ++count;
        }
    }

    function trCreate(uint256 s1, uint256 s2, uint256 s3) external step {
        if (_selling() >= 3) return _buyTickets(s1, s2, s3);
        MockNFT c = cols[s1 % 2];
        (bool found, uint256 tokenId, address creator) = _ownedToken(c, s1 >> 8);
        if (!found) return;
        uint32 max = uint32(1 + s2 % 20);
        uint32 min = (s2 >> 30) % 2 == 0 ? 0 : uint32((s2 >> 8) % (uint256(max) + 1));
        uint128 price =
            uint128(s3 % 6 == 0 ? bound(s3 >> 8, 1, 0.001 ether) : bound(s3 >> 8, 0.005 ether, 0.5 ether));
        uint256 duration =
            (s2 >> 40) % 4 == 0 ? bound(s3 >> 128, 1 hours, 30 days) : bound(s3 >> 128, 1 days, 6 days);
        vm.prank(creator);
        try ticketRaffle.create(address(c), tokenId, price, min, max, duration) {
            _hit("ticketRaffle.create");
        } catch {}
    }

    function trBuy(uint256 s1, uint256 s2, uint256 s3) external step {
        _buyTickets(s1, s2, s3);
    }

    function _buyTickets(uint256 s1, uint256 s2, uint256 s3) internal {
        uint256 id = _trIn(s1, TicketRaffle.Status.Open);
        if (id == 0) return;
        uint256 n = ticketRaffle.raffleCount();
        for (uint256 i; i < n; ++i) {
            uint256 candidate = 1 + (s1 % n + i) % n;
            (,,,,, uint32 m, uint32 sd, uint40 endTime,, TicketRaffle.Status st,) =
                ticketRaffle.raffles(candidate);
            if (st == TicketRaffle.Status.Open && block.timestamp < endTime && sd < m) {
                id = candidate;
                break;
            }
        }
        (,,, uint128 price,, uint32 max, uint32 sold,,,,) = ticketRaffle.raffles(id);
        uint256 remaining = max - sold;
        uint256 count = remaining == 0 ? 1 : (s3 % 3 == 0 ? remaining : 1 + (s3 >> 8) % remaining);
        vm.prank(_a(s2));
        try ticketRaffle.buy{value: uint256(price) * count}(id, uint32(count)) {
            _hit("ticketRaffle.buy");
        } catch {}
    }

    function _fulfilTicketRaffle(uint256 id, uint256 word) internal {
        uint256 requestId = ticketRaffle.currentRequest(id);
        try MockRandomness(address(ticketRaffle.randomness())).fulfill(requestId, word) {
            _hit(
                _trStatus(id) == TicketRaffle.Status.Won
                    ? "ticketRaffle.fulfil -> Won"
                    : "ticketRaffle.fulfil late -> reopened"
            );
            // a prompt keeper usually settles straight away; the moving lock's long waits would otherwise
            // leave most won raffles to be aborted after their week
            if (_trStatus(id) == TicketRaffle.Status.Won && word % 4 != 0) {
                try ticketRaffle.settle(id) {
                    _hit("ticketRaffle.settle");
                } catch {}
            }
        } catch {}
    }

    function trOp(uint256 s1, uint256 s2, uint256 s3) external step {
        uint256 op = s2 % 10;
        if (op == 0) {
            uint256 id = _trIn(s1, TicketRaffle.Status.Open);
            if (id == 0) return;
            (address creator,,,,,,,,,,) = ticketRaffle.raffles(id);
            vm.prank(creator);
            try ticketRaffle.cancel(id) {
                _hit("ticketRaffle.cancel");
            } catch {}
        } else if (op <= 2) {
            uint256 id = _trIn(s1, TicketRaffle.Status.Open);
            // two times in three, prefer a raffle that has sold enough to draw
            for (uint256 k; k < aTicketRaffles.length && s3 % 3 != 2; ++k) {
                uint256 candidate = aTicketRaffles[(s1 % aTicketRaffles.length + k) % aTicketRaffles.length];
                (,,, uint128 p, uint32 mn,, uint32 sd,,, TicketRaffle.Status st,) =
                    ticketRaffle.raffles(candidate);
                if (st != TicketRaffle.Status.Open || sd == 0 || sd < mn) continue;
                if (uint256(p) * sd < ticketRaffle.minPotOf(candidate)) continue;
                id = candidate;
                break;
            }
            (,,,,,,, uint40 endTime,,,) = ticketRaffle.raffles(id);
            if (s3 % 3 != 2 && block.timestamp < endTime) vm.warp(endTime);
            vm.prank(_a(s3));
            try ticketRaffle.close(id) {
                if (_trStatus(id) == TicketRaffle.Status.Drawing) {
                    _hit("ticketRaffle.close -> Drawing");
                    if (s3 % 2 == 0) _fulfilTicketRaffle(id, s3 >> 8);
                } else {
                    _hit("ticketRaffle.close -> Refunding");
                }
            } catch {}
        } else if (op == 3) {
            uint256 id = _trIn(s1, TicketRaffle.Status.Drawing);
            if (id == 0) return;
            _fulfilTicketRaffle(id, s3);
        } else if (op == 4) {
            uint256 id = _trIn(s1, TicketRaffle.Status.Drawing);
            try ticketRaffle.resetDraw(id) {
                _hit("ticketRaffle.resetDraw");
            } catch {}
        } else if (op == 5) {
            uint256 id = _trIn(s1, TicketRaffle.Status(1 + (s3 >> 8) % 3));
            TicketRaffle.Status before = id == 0 ? TicketRaffle.Status.None : _trStatus(id);
            (,,,,,,,, uint40 requestedAt,,) = ticketRaffle.raffles(id);
            // a winner who never shows up: a week later anyone can abort
            if (before == TicketRaffle.Status.Won && s3 % 2 == 0) vm.warp(uint256(requestedAt) + 7 days);
            try ticketRaffle.abort(id) {
                if (before == TicketRaffle.Status.Won) _hit("ticketRaffle.abort from Won");
                else _hit("ticketRaffle.abort");
            } catch {}
        } else if (op == 6) {
            uint256 id = _trIn(s1, TicketRaffle.Status.Won);
            try ticketRaffle.settle(id) {
                _hit("ticketRaffle.settle");
            } catch {}
        } else if (op == 7) {
            uint256 id = _trIn(s1, TicketRaffle.Status.Refunding);
            for (uint256 i; i < actors.length; ++i) {
                address a = actors[(s3 % actors.length + i) % actors.length];
                if (ticketRaffle.paidBy(id, a) == 0) continue;
                vm.prank(a);
                try ticketRaffle.refund(id) {
                    _hit("ticketRaffle.refund");
                } catch {}
                break;
            }
        } else if (op == 8) {
            uint256 id = _trIn(s1, TicketRaffle.Status.Refunding);
            if (id == 0) return;
            (address creator,,,,,,,,,,) = ticketRaffle.raffles(id);
            vm.prank(creator);
            try ticketRaffle.reclaim(id) {
                _hit("ticketRaffle.reclaim");
            } catch {}
        } else {
            address a = _a(s1);
            for (uint256 i; i < actors.length; ++i) {
                if (ticketRaffle.owedTo(actors[(s1 % actors.length + i) % actors.length]) == 0) continue;
                a = actors[(s1 % actors.length + i) % actors.length];
                break;
            }
            vm.prank(a);
            try ticketRaffle.withdraw() {
                _hit("ticketRaffle.withdraw");
            } catch {}
        }
    }

    // ------------------------------------------------------------------ lottery

    function _roundIn(uint256 seed, Lottery.Status wanted) internal view returns (uint256) {
        uint256 n = lottery.roundCount();
        if (n == 0) return 0;
        for (uint256 i; i < n; ++i) {
            uint256 id = 1 + (seed % n + i) % n;
            if (_roundStatus(id) == wanted) return id;
        }
        return 1 + seed % n;
    }

    function _roundStatus(uint256 id) internal view returns (Lottery.Status status) {
        (,,,,,, status,) = lottery.rounds(id);
    }

    function lBuy(uint256 s1, uint256 s2, uint256 s3) external step {
        address c = address(cols[s1 % 2]);
        (uint128 price,,) = lottery.configOf(c);
        uint256 roundId = lottery.currentRoundOf(c);
        (, uint128 roundPrice,, uint40 endTime,,, Lottery.Status status,) = lottery.rounds(roundId);
        if (status == Lottery.Status.Open && block.timestamp < endTime) price = roundPrice;
        uint32 count = uint32(1 + s3 % 25);
        vm.prank(_a(s2));
        try lottery.buy{value: uint256(price) * count}(c, count) {
            _hit("lottery.buy");
        } catch {}
    }

    function _fulfilRound(uint256 id, uint256 word) internal {
        uint256 requestId = lottery.currentRequest(id);
        try MockRandomness(address(lottery.randomness())).fulfill(requestId, word) {
            _hit(
                _roundStatus(id) == Lottery.Status.Won
                    ? "lottery.fulfil -> Won"
                    : "lottery.fulfil late -> reopened"
            );
        } catch {}
    }

    function lOp(uint256 s1, uint256 s2, uint256 s3) external step {
        uint256 op = s2 % 8;
        if (op <= 1) {
            uint256 id = _roundIn(s1, Lottery.Status.Open);
            for (uint256 k; k < aRounds.length && s3 % 3 != 2; ++k) {
                uint256 candidate = aRounds[(s1 % aRounds.length + k) % aRounds.length];
                (, uint128 p, uint32 sd,,,, Lottery.Status st,) = lottery.rounds(candidate);
                if (st != Lottery.Status.Open || uint256(p) * sd < lottery.minPotOf(candidate)) continue;
                id = candidate;
                break;
            }
            (,,, uint40 endTime,,,,) = lottery.rounds(id);
            if (s3 % 3 != 2 && block.timestamp < endTime) vm.warp(endTime);
            vm.prank(_a(s3));
            try lottery.draw(id) {
                if (_roundStatus(id) == Lottery.Status.Drawing) {
                    _hit("lottery.draw -> Drawing");
                    if (s3 % 2 == 0) _fulfilRound(id, s3 >> 8);
                } else {
                    _hit("lottery.draw -> Refunding");
                }
            } catch {}
        } else if (op <= 3) {
            uint256 id = _roundIn(s1, Lottery.Status.Drawing);
            if (id == 0) return;
            _fulfilRound(id, s3);
        } else if (op == 4) {
            uint256 id = _roundIn(s1, Lottery.Status.Drawing);
            try lottery.resetDraw(id) {
                _hit("lottery.resetDraw");
            } catch {}
        } else if (op == 5) {
            uint256 id = _roundIn(s1, s3 % 2 == 0 ? Lottery.Status.Open : Lottery.Status.Drawing);
            try lottery.abort(id) {
                _hit("lottery.abort");
            } catch {}
        } else if (op == 6) {
            uint256 id = _roundIn(s1, Lottery.Status.Refunding);
            for (uint256 i; i < actors.length; ++i) {
                address a = actors[(s3 % actors.length + i) % actors.length];
                if (lottery.paidBy(id, a) == 0) continue;
                vm.prank(a);
                try lottery.refund(id) {
                    _hit("lottery.refund");
                } catch {}
                break;
            }
        } else {
            address a = _a(s1);
            for (uint256 i; i < actors.length; ++i) {
                if (lottery.owedTo(actors[(s1 % actors.length + i) % actors.length]) == 0) continue;
                a = actors[(s1 % actors.length + i) % actors.length];
                break;
            }
            vm.prank(a);
            try lottery.withdraw() {
                _hit("lottery.withdraw (winnings)");
            } catch {}
        }
    }

    // ------------------------------------------------------------------ licences

    function licOp(uint256 s1, uint256 s2, uint256 s3) external step {
        uint256 op = s2 % 6;
        uint256 n = licenses.licenseCount();
        if (op == 0) {
            vm.prank(gov);
            try licenses.setTier(
                address(cols[s1 % 2]),
                uint8(s1 >> 8) % 3,
                uint128(bound(s3, 0, 0.2 ether)),
                uint40(bound(s3 >> 128, 0, 400 days)),
                (s3 >> 200) % 4 != 0
            ) {
                _hit("licences.setTier");
            } catch {}
        } else if (op <= 3) {
            uint256 id = _holdingIn(s1, Vault.Status.Locked);
            if (id == 0) return;
            (address c,,,,,,) = vault.holdings(id);
            uint8 tier = uint8(s3 % 3);
            (uint128 price,,) = licenses.tiers(c, tier);
            vm.prank(_a(s3 >> 8));
            try licenses.requestLicense{value: price}(id, tier, "review 7") {
                _hit("licences.requestLicense");
            } catch {}
        } else if (op == 4) {
            if (n == 0) return;
            vm.prank(gov);
            try licenses.revokeLicense(1 + s1 % n) {
                _hit("licences.revokeLicense");
            } catch {}
        } else {
            if (n == 0) return;
            (address licensee, uint256 vaultId,,,,,) = licenses.licenses(1 + s1 % n);
            vm.prank(gov);
            try licenses.setBan(licensee, vaultId, s3 % 2 == 0) {
                _hit("licences.setBan");
            } catch {}
        }
    }

    // ------------------------------------------------------------------ owner parameters, time, reentrancy

    function admin(uint256 s1, uint256 s2, uint256 s3) external step {
        uint256 op = s2 % 16;
        address c = address(cols[s1 % 2]);
        if (op == 0) {
            vm.prank(gov);
            try marketplace.setFee(s3 % 501) {
                _hit("mp.setFee");
            } catch {}
        } else if (op == 1) {
            vm.prank(gov);
            try marketplace.setRoyaltyCap(s3 % 1_001) {
                _hit("mp.setRoyaltyCap");
            } catch {}
        } else if (op == 2) {
            address[5] memory receivers =
                [royEOA, address(royRevert), address(burner), address(rejector), address(reenterer)];
            MockNFT(c).setRoyalty(receivers[s3 % 5], uint96((s3 >> 8) % 2_001));
            _hit("nft.setRoyalty");
        } else if (op == 3) {
            address[3] memory recipients = [proj, address(rejector), address(reenterer)];
            vm.prank(gov);
            try treasury.setProjectShare(c, recipients[s3 % 3], uint16((s3 >> 8) % 5_001)) {
                _hit("treasury.setProjectShare");
            } catch {}
        } else if (op == 4) {
            address who = s3 % 2 == 0 ? proj : address(reenterer);
            vm.prank(who);
            try treasury.claimProjectShare() {
                _hit("treasury.claimProjectShare");
            } catch {}
        } else if (op == 5) {
            // a recipient that cannot take ETH claims to another address
            vm.prank(address(rejector));
            try treasury.claimProjectShareTo(payable(actors[0])) {
                _hit("treasury.claimProjectShareTo");
            } catch {}
        } else if (op == 6) {
            vm.prank(gov);
            try lottery.setParams(
                s3 % 1_001, (s3 >> 16) % 3 == 0 ? 0 : bound(s3 >> 24, 0.001 ether, 0.2 ether)
            ) {
                _hit("lottery.setParams");
            } catch {}
        } else if (op == 7) {
            vm.prank(gov);
            try lottery.setConfig(
                c,
                uint128(bound(s3, 0.001 ether, 0.1 ether)),
                uint40(bound(s3 >> 128, 1 hours, 3 days)),
                s3 % 7 != 0
            ) {
                _hit("lottery.setConfig");
            } catch {}
        } else if (op == 8) {
            vm.prank(gov);
            try ticketRaffle.setParams(
                s3 % 1_001, (s3 >> 16) % 3 == 0 ? 0 : bound(s3 >> 24, 0.001 ether, 0.2 ether)
            ) {
                _hit("ticketRaffle.setParams");
            } catch {}
        } else if (op == 9) {
            uint256 minBet = s3 % 3 == 0 ? 1 : 0.001 ether;
            vm.prank(gov);
            try prediction.setParams((s3 >> 8) % 1_001, minBet, bound(s3 >> 24, 1 hours, 3 days)) {
                _hit("pm.setParams");
            } catch {}
        } else if (op == 10) {
            vm.prank(gov);
            try points.setWinnerKeepBps(s3 % 10_001) {
                _hit("points.setWinnerKeepBps");
            } catch {}
        } else if (op == 11) {
            vm.prank(gov);
            raffle.setAnnouncePeriod(s3 % 3 == 0 ? 7 days : bound(s3 >> 8, 0, 2 days));
            _hit("vaultRaffle.setAnnouncePeriod");
        } else if (op == 12) {
            vm.prank(gov);
            try salesOracle.setParams(bound(s3, 1 days, 14 days), 1 + (s3 >> 128) % 7) {
                _hit("salesOracle.setParams");
            } catch {}
        } else if (op == 13) {
            _swapProvider(s3);
        } else {
            _arm(s1, s3);
        }
    }

    /// The owner replaces a randomness provider with a fresh one that numbers its requests from 1 again.
    function _swapProvider(uint256 s) private {
        if (s % 5 != 0) return;
        MockRandomness fresh = new MockRandomness();
        ethHolders.push(address(fresh));
        uint256 which = (s >> 8) % 4;
        vm.prank(gov);
        if (which == 0) raffle.setRandomness(fresh);
        else if (which == 1) games.setRandomness(fresh);
        else if (which == 2) ticketRaffle.setRandomness(fresh);
        else lottery.setRandomness(fresh);
        _hit("owner replaced a randomness provider");
    }

    /// Choose what the reentering actor does the next time it is paid or handed an NFT.
    function _arm(uint256 s1, uint256 s3) private {
        uint256 op = s3 % 13;
        address r = address(reenterer);
        uint256 x = s1 >> 8;
        if (op == 0) {
            reenterer.arm(address(games), abi.encodeCall(Games.withdraw, ()));
        } else if (op == 1) {
            reenterer.arm(address(lottery), abi.encodeCall(Lottery.withdraw, ()));
        } else if (op == 2) {
            reenterer.arm(address(ticketRaffle), abi.encodeCall(TicketRaffle.withdraw, ()));
        } else if (op == 3) {
            reenterer.arm(address(marketplace), abi.encodeCall(Marketplace.cancelOffer, (_liveOffer(x))));
        } else if (op == 4) {
            reenterer.arm(address(prediction), abi.encodeCall(PredictionMarket.claim, (_marketIn(x, false))));
        } else if (op == 5) {
            reenterer.arm(
                address(lottery), abi.encodeCall(Lottery.refund, (_roundIn(x, Lottery.Status.Refunding)))
            );
        } else if (op == 6) {
            reenterer.arm(
                address(ticketRaffle),
                abi.encodeCall(TicketRaffle.refund, (_trIn(x, TicketRaffle.Status.Refunding)))
            );
        } else if (op == 7) {
            reenterer.arm(address(games), abi.encodeCall(Games.refund, (_openBet(x))));
        } else if (op == 8) {
            reenterer.arm(address(treasury), abi.encodeCall(Treasury.claimProjectShare, ()));
        } else if (op == 9) {
            (, uint256 tokenId,) = _ownedToken(cols[x % 2], x >> 8);
            reenterer.arm(
                address(engine), abi.encodeCall(BuybackEngine.sell, (address(cols[x % 2]), tokenId, 0))
            );
        } else if (op == 10) {
            reenterer.arm(address(points), abi.encodeCall(Points.flush, (r)));
        } else if (op == 11) {
            reenterer.arm(
                address(ticketRaffle),
                abi.encodeCall(TicketRaffle.settle, (_trIn(x, TicketRaffle.Status.Won)))
            );
        } else {
            reenterer.disarm();
        }
        _hit("reenterer armed");
    }

    function warp(uint256 s1, uint256 s2, uint256) external step {
        uint256 k = s1 % 1000;
        uint256 dt;
        if (k < 600) dt = bound(s2, 1, 1 hours);
        else if (k < 850) dt = bound(s2, 1 hours, 12 hours);
        else if (k < 940) dt = bound(s2, 1 days, 3 days);
        else if (k < 980) dt = bound(s2, 7 days, 9 days);
        else if (k < 992) dt = bound(s2, 30 days, 32 days);
        else dt = bound(s2, 180 days, 190 days);
        vm.warp(block.timestamp + dt);
    }

    // ------------------------------------------------------------------ checks

    function totalEth() public view returns (uint256 total) {
        for (uint256 i; i < ethHolders.length; ++i) {
            total += ethHolders[i].balance;
        }
    }

    function checkEth() public view {
        assertEq(totalEth(), initialEth, "global ETH is not conserved");
    }

    /// What the PredictionMarket still has to pay out (fees included) to everyone with a stake.
    function pmOwed() public view returns (uint256 owed) {
        for (uint256 k; k < aMarkets.length; ++k) {
            uint256 id = aMarkets[k];
            (,,,, uint128 higherPool, uint128 lowerPool, PredictionMarket.Outcome outcome) =
                prediction.markets(id);
            for (uint256 i; i < actors.length; ++i) {
                (uint128 hi, uint128 lo) = prediction.stakes(id, actors[i]);
                if (outcome == PredictionMarket.Outcome.Pending || outcome == PredictionMarket.Outcome.Void) {
                    owed += uint256(hi) + lo;
                } else if (outcome == PredictionMarket.Outcome.Higher) {
                    if (hi != 0) owed += hi + uint256(hi) * lowerPool / higherPool;
                } else {
                    if (lo != 0) owed += lo + uint256(lo) * higherPool / lowerPool;
                }
            }
        }
    }

    function checkSolvency() public view {
        _checkMarketplace();
        _checkTreasury();
        _checkGames();
        _checkTicketRaffle();
        _checkLottery();
        assertGe(address(prediction).balance, pmOwed(), "PredictionMarket cannot cover open claims");
        assertEq(address(engine).balance, 0, "engine holds ETH");
        assertEq(address(vault).balance, 0, "vault holds ETH");
        assertEq(address(raffle).balance, 0, "vault raffle holds ETH");
        assertEq(address(points).balance, 0, "points holds ETH");
        assertEq(address(licenses).balance, 0, "licence manager holds ETH");
        assertEq(address(salesOracle).balance + address(pushOracle).balance, 0, "an oracle holds ETH");
    }

    function _checkMarketplace() private view {
        uint256 escrow;
        for (uint256 k; k < aOffers.length; ++k) {
            uint256 id = aOffers[k];
            (,,, uint128 price, uint32 remaining,,) = marketplace.offers(id);
            escrow += uint256(price) * remaining;
        }
        assertEq(address(marketplace).balance, escrow, "marketplace balance != escrow of open offers");
    }

    function _checkTreasury() private view {
        uint256 owed = treasury.owedTo(proj);
        for (uint256 i; i < actors.length; ++i) {
            owed += treasury.owedTo(actors[i]);
        }
        assertEq(treasury.totalOwed(), owed, "treasury totalOwed != sum of owedTo");
        uint256 total = owed + treasury.unallocated();
        for (uint256 c; c < 3; ++c) {
            total += treasury.budgetOf(address(cols[c]));
        }
        assertEq(address(treasury).balance, total, "treasury balance != budgets + unallocated + owed");
    }

    function _checkGames() private view {
        uint256 wagers;
        uint256 exposure;
        for (uint256 i; i < betIds.length; ++i) {
            (address player,, uint128 wager, uint128 e,,,) = games.bets(betIds[i]);
            if (player == address(0)) continue;
            wagers += wager;
            exposure += e;
        }
        assertEq(games.reserved(), exposure, "games reserved != exposure of open bets");
        uint256 owed;
        for (uint256 i; i < actors.length; ++i) {
            owed += games.owedTo(actors[i]);
        }
        assertEq(
            address(games).balance,
            games.bankroll() + games.reserved() + wagers + owed + games.totalPendingDeposits(),
            "games balance != bankroll + reserved + open wagers + owed"
        );
    }

    function _checkTicketRaffle() private view {
        uint256 total;
        for (uint256 k; k < aTicketRaffles.length; ++k) {
            uint256 id = aTicketRaffles[k];
            (,,, uint128 price,,, uint32 sold,,, TicketRaffle.Status status,) = ticketRaffle.raffles(id);
            uint256 paid;
            for (uint256 i; i < actors.length; ++i) {
                paid += ticketRaffle.paidBy(id, actors[i]);
            }
            if (status == TicketRaffle.Status.Refunding) {
                assertLe(paid, uint256(price) * sold, "ticket raffle refunds exceed the pot");
                total += paid;
            } else if (status != TicketRaffle.Status.Settled && status != TicketRaffle.Status.Cancelled) {
                assertEq(paid, uint256(price) * sold, "ticket raffle paidBy != pot");
                total += paid;
            }
        }
        for (uint256 i; i < actors.length; ++i) {
            total += ticketRaffle.owedTo(actors[i]);
        }
        assertEq(address(ticketRaffle).balance, total, "ticket raffle balance != pots + refundable + owed");
    }

    function _checkLottery() private view {
        uint256 total;
        for (uint256 k; k < aRounds.length; ++k) {
            uint256 id = aRounds[k];
            (, uint128 price, uint32 sold,,,, Lottery.Status status,) = lottery.rounds(id);
            uint256 paid;
            for (uint256 i; i < actors.length; ++i) {
                paid += lottery.paidBy(id, actors[i]);
            }
            if (status == Lottery.Status.Refunding) {
                assertLe(paid, uint256(price) * sold, "lottery refunds exceed the pot");
                total += paid;
            } else if (status != Lottery.Status.Won) {
                assertEq(paid, uint256(price) * sold, "lottery paidBy != pot");
                total += paid;
            }
        }
        for (uint256 i; i < actors.length; ++i) {
            total += lottery.owedTo(actors[i]);
        }
        assertEq(address(lottery).balance, total, "lottery balance != pots + refundable + owed");
    }

    function checkNfts() public view {
        uint256 inVault;
        uint256 inRaffle;
        uint256 inTicketRaffle;
        for (uint256 c; c < 3; ++c) {
            for (uint256 id = 1; id <= TOKENS; ++id) {
                address o = cols[c].ownerOf(id);
                if (o == address(vault)) ++inVault;
                else if (o == address(raffle)) ++inRaffle;
                else if (o == address(ticketRaffle)) ++inTicketRaffle;
                else assertTrue(isActor[o], "a token is owned by an unexpected address");
            }
        }
        uint256 expected;
        for (uint256 k; k < aHoldings.length; ++k) {
            uint256 id = aHoldings[k];
            (address c, uint256 tokenId,,,,, Vault.Status status) = vault.holdings(id);
            if (status == Vault.Status.Released) continue;
            assertEq(IERC721(c).ownerOf(tokenId), address(vault), "vault does not own a holding");
            ++expected;
        }
        assertEq(inVault, expected, "vault tokens != holdings not released");
        uint256 counted;
        for (uint256 c; c < 3; ++c) {
            counted += vault.heldCount(address(cols[c]));
        }
        assertEq(counted, expected, "vault heldCount != holdings not released");

        expected = 0;
        for (uint256 k; k < aVaultRaffles.length; ++k) {
            uint256 id = aVaultRaffles[k];
            (address c, uint256 tokenId,,, VaultRaffle.Status status,) = raffle.raffles(id);
            if (status == VaultRaffle.Status.Claimed) continue;
            assertEq(IERC721(c).ownerOf(tokenId), address(raffle), "vault raffle does not own a prize");
            ++expected;
        }
        assertEq(inRaffle, expected, "vault raffle tokens != unclaimed prizes");

        expected = 0;
        for (uint256 k; k < aTicketRaffles.length; ++k) {
            uint256 id = aTicketRaffles[k];
            (, address c, uint256 tokenId,,,,,,, TicketRaffle.Status status,) = ticketRaffle.raffles(id);
            bool escrowed = status == TicketRaffle.Status.Open || status == TicketRaffle.Status.Drawing
                || status == TicketRaffle.Status.Won
                || (status == TicketRaffle.Status.Refunding && !ticketRaffle.nftReturned(id));
            if (!escrowed) continue;
            assertEq(
                IERC721(c).ownerOf(tokenId),
                address(ticketRaffle),
                "ticket raffle does not own an escrowed NFT"
            );
            ++expected;
        }
        assertEq(inTicketRaffle, expected, "ticket raffle tokens != escrowed raffles");
    }

    function checkPoints() public view {
        uint256 sum = points.pointsOf(proj) + points.pointsOf(gov);
        for (uint256 i; i < actors.length; ++i) {
            sum += points.pointsOf(actors[i]);
        }
        assertEq(points.totalPoints(), sum, "points tree total != sum of balances");
        uint256 drawing;
        for (uint256 k; k < aVaultRaffles.length; ++k) {
            uint256 id = aVaultRaffles[k];
            if (_vrStatus(id) == VaultRaffle.Status.Drawing) ++drawing;
        }
        assertEq(points.freezeCount(), drawing, "freezeCount != vault raffle draws in flight");
        assertLe(drawing, 1, "more than one vault raffle draw in flight");
    }

    function checkGhost() public view {
        assertEq(ghostViolation, "", "a check inside the handler failed");
    }

    // ------------------------------------------------------------------ liveness

    /// @notice Every position must have an exit. First everything that is claimable now is claimed by
    ///         every account that can receive ETH. Then time moves far ahead, every unfinished bet, round,
    ///         raffle and market is pushed to its end with the public functions, and everything is claimed
    ///         again. Nothing of a normal account may be left behind. All of it is rolled back afterwards.
    function checkLiveness() public {
        uint256 snap = vm.snapshotState();
        reenterer.disarm();
        _exitNow();
        vm.warp(block.timestamp + 400 days);
        _finishEverything();
        _exitNow();
        _assertDrained();
        checkSolvency();
        checkEth();
        checkNfts();
        vm.revertToStateAndDelete(snap);
    }

    function _must(bool ok, string memory what) private pure {
        require(ok, string.concat("LIVENESS: ", what));
    }

    function _exitNow() private {
        _exitGames();
        _exitLottery();
        _exitTicketRaffle();
        _exitPrediction();
        _exitMisc();
    }

    function _exitGames() private {
        for (uint256 i; i < betIds.length; ++i) {
            (address player,, uint128 wager,,,, uint40 placedAt) = games.bets(betIds[i]);
            if (player == address(0) || block.timestamp < placedAt + 1 days) continue;
            uint256 before = player.balance + games.owedTo(player);
            try games.refund(betIds[i]) {}
            catch {
                _must(false, "an expired games bet cannot be refunded");
            }
            _must(
                player.balance + games.owedTo(player) == before + wager, "games refund paid the wrong amount"
            );
        }
        for (uint256 i; i < actors.length; ++i) {
            address a = actors[i];
            uint256 owed = games.owedTo(a);
            if (owed == 0 || !isNormal[a]) continue;
            uint256 before = a.balance;
            vm.prank(a);
            try games.withdraw() {}
            catch {
                _must(false, "games.withdraw failed for a normal account");
            }
            _must(a.balance == before + owed, "games.withdraw paid the wrong amount");
        }
    }

    function _exitLottery() private {
        for (uint256 k; k < aRounds.length; ++k) {
            uint256 id = aRounds[k];
            if (_roundStatus(id) != Lottery.Status.Refunding) continue;
            for (uint256 i; i < actors.length; ++i) {
                address a = actors[i];
                uint256 paid = lottery.paidBy(id, a);
                if (paid == 0 || !isNormal[a]) continue;
                uint256 before = a.balance;
                vm.prank(a);
                try lottery.refund(id) {}
                catch {
                    _must(false, "lottery.refund failed in a Refunding round");
                }
                _must(a.balance == before + paid, "lottery.refund paid the wrong amount");
            }
        }
        for (uint256 i; i < actors.length; ++i) {
            address a = actors[i];
            uint256 owed = lottery.owedTo(a);
            if (owed == 0 || !isNormal[a]) continue;
            uint256 before = a.balance;
            vm.prank(a);
            try lottery.withdraw() {}
            catch {
                _must(false, "lottery.withdraw failed for a normal account");
            }
            _must(a.balance == before + owed, "lottery.withdraw paid the wrong amount");
        }
    }

    function _exitTicketRaffle() private {
        for (uint256 k; k < aTicketRaffles.length; ++k) {
            uint256 id = aTicketRaffles[k];
            TicketRaffle.Status status = _trStatus(id);
            if (status == TicketRaffle.Status.Won) {
                (, address c, uint256 tokenId,,,,,,,, address winner) = ticketRaffle.raffles(id);
                try ticketRaffle.settle(id) {}
                catch {
                    _must(false, "a Won ticket raffle cannot be settled");
                }
                _must(IERC721(c).ownerOf(tokenId) == winner, "settle did not deliver the prize to the winner");
            } else if (status == TicketRaffle.Status.Refunding) {
                _exitRefundingRaffle(id);
            }
        }
        for (uint256 i; i < actors.length; ++i) {
            address a = actors[i];
            uint256 owed = ticketRaffle.owedTo(a);
            if (owed == 0 || !isNormal[a]) continue;
            uint256 before = a.balance;
            vm.prank(a);
            try ticketRaffle.withdraw() {}
            catch {
                _must(false, "ticketRaffle.withdraw failed for a normal account");
            }
            _must(a.balance == before + owed, "ticketRaffle.withdraw paid the wrong amount");
        }
    }

    function _exitRefundingRaffle(uint256 id) private {
        for (uint256 i; i < actors.length; ++i) {
            address a = actors[i];
            uint256 paid = ticketRaffle.paidBy(id, a);
            if (paid == 0 || !isNormal[a]) continue;
            uint256 before = a.balance;
            vm.prank(a);
            try ticketRaffle.refund(id) {}
            catch {
                _must(false, "ticketRaffle.refund failed in a Refunding raffle");
            }
            _must(a.balance == before + paid, "ticketRaffle.refund paid the wrong amount");
        }
        if (ticketRaffle.nftReturned(id)) return;
        (address creator, address c, uint256 tokenId,,,,,,,,) = ticketRaffle.raffles(id);
        vm.prank(creator);
        try ticketRaffle.reclaim(id) {}
        catch {
            _must(false, "the creator cannot reclaim the NFT of a Refunding raffle");
        }
        _must(IERC721(c).ownerOf(tokenId) == creator, "reclaim did not return the NFT");
    }

    function _exitPrediction() private {
        for (uint256 k; k < aMarkets.length; ++k) {
            uint256 id = aMarkets[k];
            if (_outcome(id) == PredictionMarket.Outcome.Pending) continue;
            for (uint256 i; i < actors.length; ++i) {
                address a = actors[i];
                (uint128 hi, uint128 lo) = prediction.stakes(id, a);
                if ((hi == 0 && lo == 0) || !isNormal[a]) continue;
                vm.prank(a);
                try prediction.claim(id) {}
                catch {
                    _must(false, "prediction.claim failed on a resolved market");
                }
            }
        }
    }

    function _exitMisc() private {
        for (uint256 k; k < aOffers.length; ++k) {
            uint256 id = aOffers[k];
            (address offerer,,, uint128 price, uint32 remaining,,) = marketplace.offers(id);
            if (remaining == 0 || !isNormal[offerer]) continue;
            uint256 before = offerer.balance;
            vm.prank(offerer);
            try marketplace.cancelOffer(id) {}
            catch {
                _must(false, "an open offer cannot be cancelled");
            }
            _must(
                offerer.balance == before + uint256(price) * remaining,
                "cancelOffer refunded the wrong amount"
            );
        }
        for (uint256 k; k < aVaultRaffles.length; ++k) {
            uint256 id = aVaultRaffles[k];
            if (_vrStatus(id) != VaultRaffle.Status.Won) continue;
            (address c, uint256 tokenId,,,, address winner) = raffle.raffles(id);
            // a prize vests before it can be claimed
            uint256 vestsAt = raffle.claimableAt(id);
            if (block.timestamp < vestsAt) vm.warp(vestsAt);
            try raffle.claim(id) {}
            catch {
                _must(false, "a won vault raffle cannot be claimed");
            }
            _must(IERC721(c).ownerOf(tokenId) == winner, "vault raffle claim did not deliver the prize");
        }
        address[2] memory takers = [proj, address(reenterer)];
        for (uint256 i; i < 2; ++i) {
            uint256 owed = treasury.owedTo(takers[i]);
            if (owed == 0) continue;
            uint256 before = takers[i].balance;
            vm.prank(takers[i]);
            try treasury.claimProjectShare() {}
            catch {
                _must(false, "a project share cannot be claimed");
            }
            _must(takers[i].balance == before + owed, "claimProjectShare paid the wrong amount");
        }
        if (treasury.owedTo(address(rejector)) != 0) {
            vm.prank(address(rejector));
            try treasury.claimProjectShareTo(payable(proj)) {}
            catch {
                _must(false, "claimProjectShareTo failed");
            }
        }
    }

    /// Far in the future: push every unfinished thing to its end using only public functions.
    function _finishEverything() private {
        for (uint256 i; i < betIds.length; ++i) {
            (address player,,,,,,) = games.bets(betIds[i]);
            if (player == address(0)) continue;
            try games.refund(betIds[i]) {}
            catch {
                _must(false, "an old games bet cannot be refunded");
            }
        }
        for (uint256 k; k < aRounds.length; ++k) {
            uint256 id = aRounds[k];
            Lottery.Status status = _roundStatus(id);
            if (status != Lottery.Status.Open && status != Lottery.Status.Drawing) continue;
            try lottery.abort(id) {}
            catch {
                _must(false, "an old lottery round cannot be aborted");
            }
        }
        for (uint256 k; k < aTicketRaffles.length; ++k) {
            uint256 id = aTicketRaffles[k];
            TicketRaffle.Status status = _trStatus(id);
            if (status != TicketRaffle.Status.Open && status != TicketRaffle.Status.Drawing) continue;
            try ticketRaffle.abort(id) {}
            catch {
                _must(false, "an old ticket raffle cannot be aborted");
            }
        }
        for (uint256 k; k < aMarkets.length; ++k) {
            uint256 id = aMarkets[k];
            if (_outcome(id) != PredictionMarket.Outcome.Pending) continue;
            try prediction.resolve(id) {}
            catch {
                _must(false, "an old prediction market cannot be resolved");
            }
        }
        for (uint256 k; k < aVaultRaffles.length; ++k) {
            uint256 id = aVaultRaffles[k];
            if (_vrStatus(id) != VaultRaffle.Status.Drawing) continue;
            try raffle.resetDraw(id) {}
            catch {
                _must(false, "a stuck vault raffle draw cannot be reset");
            }
        }
        _must(points.freezeCount() == 0, "points stay frozen");
    }

    /// After everyone normal has left: no unfinished state, and nothing of theirs left in any contract.
    function _assertDrained() private view {
        for (uint256 i; i < betIds.length; ++i) {
            (address player,,,,,,) = games.bets(betIds[i]);
            _must(player == address(0), "a games bet is still open");
        }
        _must(games.reserved() == 0, "games reserve not released");
        for (uint256 k; k < aRounds.length; ++k) {
            uint256 id = aRounds[k];
            Lottery.Status status = _roundStatus(id);
            _must(
                status == Lottery.Status.Won || status == Lottery.Status.Refunding,
                "a lottery round is unfinished"
            );
        }
        for (uint256 k; k < aTicketRaffles.length; ++k) {
            uint256 id = aTicketRaffles[k];
            TicketRaffle.Status status = _trStatus(id);
            _must(
                status == TicketRaffle.Status.Settled || status == TicketRaffle.Status.Cancelled
                    || (status == TicketRaffle.Status.Refunding && ticketRaffle.nftReturned(id)),
                "a ticket raffle is unfinished"
            );
        }
        for (uint256 k; k < aMarkets.length; ++k) {
            uint256 id = aMarkets[k];
            _must(_outcome(id) != PredictionMarket.Outcome.Pending, "a prediction market is unresolved");
        }
        uint256 hostile = _hostileClaims();
        _must(
            address(games).balance
                == games.bankroll() + games.totalPendingDeposits() + games.owedTo(address(rejector)),
            "ETH left in Games"
        );
        _must(address(lottery).balance == hostile >> 128, "ETH of a normal account left in the Lottery");
        _must(
            address(ticketRaffle).balance == uint128(hostile),
            "ETH of a normal account left in the TicketRaffle"
        );
        _must(address(prediction).balance == pmOwed() + lastDustNow(), "prediction market accounting");
        for (uint256 i; i < actors.length; ++i) {
            if (!isNormal[actors[i]]) continue;
            for (uint256 k; k < aMarkets.length; ++k) {
                (uint128 hi, uint128 lo) = prediction.stakes(aMarkets[k], actors[i]);
                _must(hi == 0 && lo == 0, "a normal account still has a prediction stake");
            }
        }
    }

    function lastDustNow() public view returns (uint256) {
        return address(prediction).balance - pmOwed();
    }

    /// What the account that cannot receive ETH is still owed: lottery in the high half, ticket raffle low.
    function _hostileClaims() private view returns (uint256) {
        address r = address(rejector);
        uint256 lot = lottery.owedTo(r);
        for (uint256 k; k < aRounds.length; ++k) {
            uint256 id = aRounds[k];
            if (_roundStatus(id) == Lottery.Status.Refunding) lot += lottery.paidBy(id, r);
        }
        uint256 tr = ticketRaffle.owedTo(r);
        for (uint256 k; k < aTicketRaffles.length; ++k) {
            uint256 id = aTicketRaffles[k];
            if (_trStatus(id) == TicketRaffle.Status.Refunding) tr += ticketRaffle.paidBy(id, r);
        }
        return (lot << 128) | tr;
    }
}
