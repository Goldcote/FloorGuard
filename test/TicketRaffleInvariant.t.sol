// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {TicketRaffle} from "../src/TicketRaffle.sol";
import {MockNFT} from "./mocks/MockNFT.sol";
import {MockRandomness} from "./mocks/MockRandomness.sol";

contract Review5RaffleHandler is Test {
    TicketRaffle internal immutable raffle;
    MockNFT internal immutable nft;
    MockRandomness internal immutable randomness;
    address internal immutable gov;
    address[] public actors;
    uint256 internal nextToken = 1_000;

    uint256 public settled;
    uint256 public refunded;
    uint256 public aborted;
    uint256 public lateAnswers;
    uint256 public staleAnswersAccepted;

    constructor(TicketRaffle raffle_, MockNFT nft_, MockRandomness randomness_, address gov_) {
        raffle = raffle_;
        nft = nft_;
        randomness = randomness_;
        gov = gov_;
        for (uint256 i; i < 5; ++i) {
            address a = makeAddr(string.concat("r5actor", vm.toString(i)));
            actors.push(a);
            vm.deal(a, 1_000_000 ether);
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) private view returns (address) {
        return actors[seed % actors.length];
    }

    function _raffle(uint256 seed) private view returns (uint256) {
        uint256 n = raffle.raffleCount();
        return n == 0 ? 0 : seed % n + 1;
    }

    /// A raffle in `wanted` status if there is one, searching from a random start; otherwise any raffle.
    function _raffleIn(uint256 seed, TicketRaffle.Status wanted) private view returns (uint256) {
        uint256 n = raffle.raffleCount();
        if (n == 0) return 0;
        for (uint256 i; i < n; ++i) {
            uint256 id = (seed + i) % n + 1;
            (,,,,,,,,, TicketRaffle.Status status,) = raffle.raffles(id);
            if (status == wanted) return id;
        }
        return seed % n + 1;
    }

    function create(uint256 actorSeed, uint128 price, uint32 min, uint32 max, uint256 duration) external {
        if (raffle.raffleCount() >= 12) return;
        address a = _actor(actorSeed);
        uint256 tokenId = nextToken++;
        nft.mint(a, tokenId);
        price = uint128(bound(price, 0.001 ether, 1 ether));
        max = uint32(bound(max, 1, 40));
        min = uint32(bound(min, 0, max));
        duration = bound(duration, 1 hours, 3 days);
        vm.startPrank(a);
        nft.approve(address(raffle), tokenId);
        raffle.create(address(nft), tokenId, price, min, max, duration);
        vm.stopPrank();
    }

    function buy(uint256 raffleSeed, uint256 actorSeed, uint32 count) external {
        uint256 id = _raffleIn(raffleSeed, TicketRaffle.Status.Open);
        (,,, uint128 price,,,,,,,) = raffle.raffles(id);
        count = uint32(bound(count, 1, 12));
        vm.prank(_actor(actorSeed));
        raffle.buy{value: uint256(price) * count}(id, count);
    }

    function cancel(uint256 raffleSeed) external {
        uint256 id = _raffle(raffleSeed);
        (address creator,,,,,,,,,,) = raffle.raffles(id);
        vm.prank(creator);
        raffle.cancel(id);
    }

    function close(uint256 raffleSeed) external {
        raffle.close(_raffleIn(raffleSeed, TicketRaffle.Status.Open));
    }

    function fulfil(uint256 raffleSeed, uint256 word) external {
        uint256 id = _raffleIn(raffleSeed, TicketRaffle.Status.Drawing);
        uint256 requestId = raffle.currentRequest(id);
        (,,,,,,,, uint40 requestedAt,,) = raffle.raffles(id);
        if (requestId != 0 && block.timestamp >= requestedAt + 1 days) ++lateAnswers;
        randomness.fulfill(requestId, word);
    }

    /// An answer for any request id ever issued, current or not.
    function fulfilAny(uint256 requestSeed, uint256 word) external {
        uint256 last = randomness.lastRequestId();
        if (last == 0) return;
        uint256 requestId = requestSeed % last + 1;
        uint256 id = raffle.raffleOfRequest(requestId);
        bool current = id != 0 && raffle.currentRequest(id) == requestId;
        try randomness.fulfill(requestId, word) {
            if (!current) ++staleAnswersAccepted;
        } catch {}
    }

    function resetDraw(uint256 raffleSeed) external {
        raffle.resetDraw(_raffleIn(raffleSeed, TicketRaffle.Status.Drawing));
    }

    function abort(uint256 raffleSeed) external {
        raffle.abort(_raffle(raffleSeed));
        ++aborted;
    }

    function settle(uint256 raffleSeed) external {
        raffle.settle(_raffleIn(raffleSeed, TicketRaffle.Status.Won));
        ++settled;
    }

    function refund(uint256 raffleSeed, uint256 actorSeed) external {
        // a refunding raffle that still owes somebody, and a buyer it owes, if there are any
        uint256 n = raffle.raffleCount();
        uint256 id = _raffleIn(raffleSeed, TicketRaffle.Status.Refunding);
        address a = _actor(actorSeed);
        for (uint256 i; i < n * actors.length; ++i) {
            uint256 candidate = (raffleSeed + i / actors.length) % n + 1;
            address buyer = actors[(actorSeed + i) % actors.length];
            (,,,,,,,,, TicketRaffle.Status status,) = raffle.raffles(candidate);
            if (status == TicketRaffle.Status.Refunding && raffle.paidBy(candidate, buyer) != 0) {
                (id, a) = (candidate, buyer);
                break;
            }
        }
        vm.prank(a);
        raffle.refund(id);
        ++refunded;
    }

    function reclaim(uint256 raffleSeed) external {
        uint256 id = _raffleIn(raffleSeed, TicketRaffle.Status.Refunding);
        (address creator,,,,,,,,,,) = raffle.raffles(id);
        vm.prank(creator);
        raffle.reclaim(id);
    }

    function withdraw(uint256 actorSeed) external {
        address a = _actor(actorSeed);
        for (uint256 i; i < actors.length; ++i) {
            if (raffle.owedTo(actors[(actorSeed + i) % actors.length]) != 0) {
                a = actors[(actorSeed + i) % actors.length];
                break;
            }
        }
        vm.prank(a);
        raffle.withdraw();
    }

    function setParams(uint256 fee, uint256 minPot) external {
        vm.prank(gov);
        raffle.setParams(bound(fee, 0, 1_000), bound(minPot, 0, 0.2 ether));
    }

    function warp(uint256 dt) external {
        // mostly short steps, sometimes past the abort delay
        skip(dt % 4 == 0 ? bound(dt, 1 days, 9 days) : bound(dt, 1 minutes, 20 hours));
    }
}

/// @notice Review 5: stateful check of the TicketRaffle accounting, which no earlier invariant test covers.
contract Review5TicketRaffleInvariantTest is Base {
    Review5RaffleHandler internal handler;

    function setUp() public override {
        super.setUp();
        vm.prank(gov);
        ticketRaffle.setCollectionSupport(address(nft), true);
        handler = new Review5RaffleHandler(ticketRaffle, nft, randomness, gov);
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 96
    /// forge-config: default.invariant.depth = 250
    /// balance == pots of raffles still Open, Drawing or Won + refundable `paidBy` of Refunding raffles
    ///            + revenue owed to creators
    function invariant_review5_balanceCoversExactlyWhatIsOwed() public view {
        uint256 expected;
        uint256 n = ticketRaffle.raffleCount();
        uint256 actors = handler.actorCount();
        for (uint256 id = 1; id <= n; ++id) {
            (,,, uint128 price,,, uint32 sold,,, TicketRaffle.Status status,) = ticketRaffle.raffles(id);
            if (
                status == TicketRaffle.Status.Open || status == TicketRaffle.Status.Drawing
                    || status == TicketRaffle.Status.Won
            ) {
                expected += uint256(price) * sold;
                // while a raffle is live, what buyers paid is exactly its pot
                uint256 paid;
                for (uint256 a; a < actors; ++a) {
                    paid += ticketRaffle.paidBy(id, handler.actors(a));
                }
                assertEq(paid, uint256(price) * sold, "paidBy != pot");
            } else if (status == TicketRaffle.Status.Refunding) {
                for (uint256 a; a < actors; ++a) {
                    expected += ticketRaffle.paidBy(id, handler.actors(a));
                }
            }
        }
        for (uint256 a; a < actors; ++a) {
            expected += ticketRaffle.owedTo(handler.actors(a));
        }
        assertEq(address(ticketRaffle).balance, expected, "balance");
    }

    /// forge-config: default.invariant.runs = 96
    /// forge-config: default.invariant.depth = 250
    /// The NFT is in escrow exactly while it can still be won or reclaimed, and a request is current
    /// exactly while a raffle is drawing.
    function invariant_review5_nftCustodyAndRequestsMatchStatus() public view {
        uint256 n = ticketRaffle.raffleCount();
        for (uint256 id = 1; id <= n; ++id) {
            (,, uint256 tokenId,,,,,,, TicketRaffle.Status status, address winner) = ticketRaffle.raffles(id);
            bool live = status == TicketRaffle.Status.Open || status == TicketRaffle.Status.Drawing
                || status == TicketRaffle.Status.Won;
            bool held = live || (status == TicketRaffle.Status.Refunding && !ticketRaffle.nftReturned(id));
            assertEq(nft.ownerOf(tokenId) == address(ticketRaffle), held, "custody");
            assertEq(ticketRaffle.currentRequest(id) != 0, status == TicketRaffle.Status.Drawing, "request");
            if (status == TicketRaffle.Status.Won) assertTrue(winner != address(0), "winner");
            if (status == TicketRaffle.Status.Refunding) assertEq(winner, address(0), "winner cleared");
        }
        assertEq(handler.staleAnswersAccepted(), 0, "stale answer accepted");
    }
}
