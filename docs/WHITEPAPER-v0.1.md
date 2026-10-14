# FloorGuard Protocol
## A Self-Sustaining NFT Marketplace with Floor Price Protection

*Draft v0.1 — March 19, 2026*
*Author: Sylv (concept) + Chris (spec)*

> **Historical concept document.** This is the v0.1 draft that the code in this
> repository started from. It is kept as a record of the original thinking and
> is not a description of what was built, a roadmap or an offer.
>
> - **The current description of FloorGuard** is the
>   [v1 design paper](FLOORGUARD-V1.md). What was actually built, and every
>   place it departs from this draft, is in [ARCHITECTURE.md](ARCHITECTURE.md). Several mechanisms here (the treasury
>   triggering buybacks, the engine "accepting an offer", Chainlink NFT floor
>   feeds) were replaced after review.
> - **There is no token.** The $FLOOR token below was one possibility discussed
>   in the draft. Nothing in this repository creates, plans or promises a token.
> - **Figures in this draft are illustrative, not forecasts.** For an analysis of
>   what the mechanism can and cannot do, see
>   [ECONOMICS-REVIEW.md](ECONOMICS-REVIEW.md).
> - Some ideas here (casino gamification such as referral rewards on losses or
>   leaderboards, paid NFT raffle tickets as a profit source) were not built.

---

## Abstract

FloorGuard is a decentralized NFT marketplace that reverses the toxic incentives introduced by Blur and adopted by OpenSea. Instead of rewarding undercutting (race to the bottom), FloorGuard recycles all platform fees into automatic floor price support through buybacks.

The protocol combines three revenue-generating components:
1. **Simple Marketplace** — Offer/accept NFT trading
2. **Floor Prediction Market** — Bet on floor price movements  
3. **Community Casino** — Fun games with house edge

All fees flow to a Treasury that automatically purchases floor NFTs, creating a self-reinforcing flywheel that protects collection value.

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Solution Overview](#2-solution-overview)
3. [Architecture](#3-architecture)
4. [Marketplace Module](#4-marketplace-module)
5. [Prediction Market Module](#5-prediction-market-module)
6. [Casino Module](#6-casino-module)
7. [Treasury & Buyback Engine](#7-treasury--buyback-engine)
8. [Tokenomics (Optional)](#8-tokenomics-optional)
9. [Desktop App Design](#9-desktop-app-design)
10. [Technical Implementation](#10-technical-implementation)
11. [Security Considerations](#11-security-considerations)
12. [Roadmap](#12-roadmap)
13. [Conclusion](#13-conclusion)

---

## 1. Problem Statement

### The Blur Effect

Blur introduced point-based incentives for listing NFTs at or below floor price. This created:

- **Race to the bottom**: Sellers compete to undercut each other
- **Floor collapse**: Collections lose value as listings spiral down
- **Holder exodus**: Long-term believers get wrecked
- **Mercenary liquidity**: Traders farm points, dump rewards

OpenSea copied this model (OpenSea Pro), amplifying the damage.

### The Core Misalignment

**Current model:** Platform rewards *listing low*
**Healthy model:** Platform rewards *floor strength*

FloorGuard realigns incentives by making the platform itself a buyer of last resort.

---

## 2. Solution Overview

### Three Pillars

```
┌─────────────────────────────────────────────────────────────┐
│                    FloorGuard Protocol                       │
├─────────────────┬─────────────────┬─────────────────────────┤
│   MARKETPLACE   │   PREDICTION    │        CASINO           │
│                 │     MARKET      │                         │
│  Offer/Accept   │  Floor Up/Down  │   Lotto, Coinflip,     │
│  NFT Trading    │    Betting      │   Raffles, etc.        │
│                 │                 │                         │
│   Fee: 1-2%     │   Fee: 2-5%     │   House Edge: 2-5%     │
└────────┬────────┴────────┬────────┴────────────┬────────────┘
         │                 │                     │
         └─────────────────┼─────────────────────┘
                           ▼
              ┌────────────────────────┐
              │       TREASURY         │
              │                        │
              │  Accumulates ETH/USDC  │
              │  from all fee sources  │
              └───────────┬────────────┘
                          ▼
              ┌────────────────────────┐
              │    BUYBACK ENGINE      │
              │                        │
              │  Auto-purchases floor  │
              │  NFTs when threshold   │
              │  reached               │
              └───────────┬────────────┘
                          ▼
              ┌────────────────────────┐
              │   FLOOR NFT VAULT      │
              │                        │
              │  • Hold (display)      │
              │  • Raffle to stakers   │
              │  • Burn (deflationary) │
              └────────────────────────┘
```

### The Flywheel

```
More Trading Activity
        ↓
   More Fees Generated
        ↓
   More Floor Buybacks
        ↓
   Stronger Floor Price
        ↓
   More Holder Confidence
        ↓
   More Trading Activity
        ↑
   (cycle repeats)
```

---

## 3. Architecture

### Smart Contract Structure

```
contracts/
├── FloorGuard.sol          # Main coordinator
├── Marketplace.sol         # Offer/accept logic
├── PredictionMarket.sol    # Floor price betting
├── Casino.sol              # Games (modular)
│   ├── Coinflip.sol
│   ├── Lottery.sol
│   └── Raffle.sol
├── Treasury.sol            # Fee accumulation
├── BuybackEngine.sol       # Auto floor purchases
└── Vault.sol               # Acquired NFT management
```

### Data Flow

1. User interacts with Marketplace/Prediction/Casino
2. Fees extracted and sent to Treasury
3. Treasury accumulates until threshold (e.g., 1 ETH)
4. BuybackEngine triggers: buys cheapest floor NFT
5. NFT sent to Vault for holding/raffling/burning

---

## 4. Marketplace Module

### Design Philosophy

**No orderbook. No signatures. No complexity.**

Just offers and accepts.

### Flow

```
1. Buyer sees NFT on-chain (no listing required)
2. Buyer calls makeOffer(nft, tokenId) + sends ETH
3. Offer stored on-chain with expiry
4. Seller sees incoming offer (via events)
5. Seller calls acceptOffer(offerId)
6. Atomic swap: NFT → Buyer, ETH (minus fee) → Seller
```

### Contract Interface

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IMarketplace {
    struct Offer {
        address offerer;
        address nftContract;
        uint256 tokenId;
        uint256 amount;
        uint256 expiry;
        bool active;
    }
    
    // Make an offer on any NFT (no listing required)
    function makeOffer(
        address nftContract, 
        uint256 tokenId, 
        uint256 expiry
    ) external payable returns (bytes32 offerId);
    
    // Accept an offer (must own the NFT)
    function acceptOffer(bytes32 offerId) external;
    
    // Cancel/withdraw expired offer
    function cancelOffer(bytes32 offerId) external;
    
    // View functions
    function getOffer(bytes32 offerId) external view returns (Offer memory);
    function getOffersForNFT(address nft, uint256 tokenId) external view returns (bytes32[] memory);
}
```

### Fee Structure

| Action | Fee | Recipient |
|--------|-----|-----------|
| Offer accepted | 2% of sale | Treasury |

### Why No Listings?

- Listings require signatures or on-chain state
- Adds complexity and attack surface
- With offer model, any NFT is "listed" by default
- Sellers just accept offers they like

---

## 5. Prediction Market Module

### Concept

Users bet on whether a collection's floor price will be higher or lower after a time period.

### Markets

```
Example Market:
┌────────────────────────────────────────┐
│  Bored Ape Yacht Club                  │
│  Current Floor: 25.5 ETH               │
│                                        │
│  Will floor be HIGHER in 24 hours?     │
│                                        │
│  [YES: 1.8x]     [NO: 2.2x]           │
│                                        │
│  Pool: 45 ETH    Expires: 18h 32m     │
└────────────────────────────────────────┘
```

### Oracle Solution

**Floor Price Source Options:**

1. **On-chain calculation**: Track recent sales, compute floor
2. **Chainlink NFT Floor Price Feeds**: Available for major collections
3. **UMA Optimistic Oracle**: Dispute-based, works for any collection
4. **Reservoir Oracle**: NFT-specific, signed floor prices

Recommendation: Start with Chainlink for major collections, add UMA for long-tail.

### Contract Interface

```solidity
interface IPredictionMarket {
    struct Market {
        address nftContract;
        uint256 startPrice;      // Floor at market creation
        uint256 resolveTime;     // When market settles
        uint256 yesPool;         // ETH bet on higher
        uint256 noPool;          // ETH bet on lower
        bool resolved;
        bool outcome;            // true = higher, false = lower
    }
    
    function createMarket(
        address nftContract,
        uint256 duration
    ) external returns (uint256 marketId);
    
    function placeBet(
        uint256 marketId, 
        bool higher
    ) external payable;
    
    function resolveMarket(uint256 marketId) external;
    
    function claimWinnings(uint256 marketId) external;
}
```

### Fee Structure

| Action | Fee | Recipient |
|--------|-----|-----------|
| Winning claim | 3% of winnings | Treasury |

### Prediction Market Benefits

1. **Price discovery**: Community sentiment on floor direction
2. **Hedging**: Holders can hedge against floor drops
3. **Engagement**: Fun way to be involved beyond just trading
4. **Revenue**: Generates fees for floor support

---

## 6. Casino Module

### Philosophy

Fun, simple games that generate revenue for floor support. Not a full casino — just enough to engage the community.

### Game 1: Coinflip

```
┌────────────────────────────┐
│        COINFLIP            │
│                            │
│   Bet: [____] ETH          │
│                            │
│   [ HEADS ]  [ TAILS ]     │
│                            │
│   Win: 1.96x (2% edge)     │
└────────────────────────────┘
```

**Implementation:**
- Use Chainlink VRF for randomness
- Instant settlement
- House edge: 2%

### Game 2: NFT Lottery

```
┌────────────────────────────────────────┐
│           WEEKLY NFT LOTTERY           │
│                                        │
│   Prize: 1x Floor NFT from Vault       │
│   Ticket Price: 0.01 ETH               │
│   Tickets Sold: 847                    │
│   Draw in: 2d 14h                      │
│                                        │
│   [ BUY TICKET ]                       │
└────────────────────────────────────────┘
```

**Implementation:**
- Weekly draws using Chainlink VRF
- Prize = NFT from Vault (bought via buybacks)
- All ticket revenue → Treasury (circular economy)

### Game 3: Raffle

```
┌────────────────────────────────────────┐
│        COMMUNITY RAFFLE                │
│                                        │
│   Prize: Custom (donated NFT/ETH)      │
│   Creator sets: ticket price, duration │
│   Platform fee: 5% of pool             │
│                                        │
│   Anyone can create a raffle           │
└────────────────────────────────────────┘
```

### VRF Integration

All randomness via Chainlink VRF v2.5:

```solidity
import "@chainlink/contracts/src/v0.8/vrf/VRFConsumerBaseV2Plus.sol";

contract Casino is VRFConsumerBaseV2Plus {
    function flipCoin(bool heads) external payable {
        // Request random number
        uint256 requestId = s_vrfCoordinator.requestRandomWords(...);
        // Store bet details
        pendingFlips[requestId] = Flip(msg.sender, msg.value, heads);
    }
    
    function fulfillRandomWords(uint256 requestId, uint256[] memory randomWords) internal override {
        Flip memory flip = pendingFlips[requestId];
        bool result = randomWords[0] % 2 == 0;
        if (result == flip.choice) {
            // Winner - pay 1.96x
        } else {
            // Loser - house keeps
        }
    }
}
```

---

## 7. Treasury & Buyback Engine

### Treasury

Simple ETH accumulator:

```solidity
contract Treasury {
    address public buybackEngine;
    uint256 public buybackThreshold = 1 ether;
    
    receive() external payable {
        if (address(this).balance >= buybackThreshold) {
            IBuybackEngine(buybackEngine).executeBuyback();
        }
    }
    
    function setThreshold(uint256 newThreshold) external onlyGovernance {
        buybackThreshold = newThreshold;
    }
}
```

### Buyback Engine

Automatically purchases floor NFTs:

```solidity
contract BuybackEngine {
    ITreasury public treasury;
    IMarketplace public marketplace;
    IVault public vault;
    
    // Collections eligible for buyback support
    mapping(address => bool) public supportedCollections;
    
    function executeBuyback() external {
        // 1. Get available balance from Treasury
        uint256 balance = treasury.withdraw();
        
        // 2. Find cheapest floor NFT across supported collections
        (address nft, uint256 tokenId, bytes32 offerId) = findCheapestFloor();
        
        // 3. Accept the offer (buy the NFT)
        marketplace.acceptOffer{value: ...}(offerId);
        
        // 4. Send NFT to Vault
        IERC721(nft).transferFrom(address(this), address(vault), tokenId);
        
        emit Buyback(nft, tokenId, price);
    }
    
    function findCheapestFloor() internal view returns (address, uint256, bytes32) {
        // Query marketplace for lowest offers on supported collections
        // Could also integrate with Reservoir/other aggregators
    }
}
```

### Buyback Strategy Options

| Strategy | Description | Pros | Cons |
|----------|-------------|------|------|
| **Cheapest floor** | Buy lowest priced NFT | Maximum floor support | May get rares "cheap" |
| **Random floor** | Buy random floor-priced NFT | Unpredictable, fair | Less efficient |
| **Weighted by collection** | Allocate by collection TVL | Balanced support | More complex |
| **Community vote** | Let holders decide | Democratic | Slow, gameable |

Recommendation: Start with "cheapest floor" — simple and effective.

### Vault Management

Acquired NFTs can be:

1. **Held** — Display in community gallery
2. **Raffled** — Weekly lottery prize
3. **Burned** — Deflationary (if collection supports)
4. **Auctioned** — During bull runs to recycle ETH back to Treasury

```solidity
contract Vault {
    enum NFTFate { HOLD, RAFFLE, BURN, AUCTION }
    
    mapping(uint256 => NFTFate) public nftFates;
    
    // Governance decides fate of each NFT
    function setFate(uint256 vaultId, NFTFate fate) external onlyGovernance {
        nftFates[vaultId] = fate;
    }
    
    function executeRaffle(uint256 vaultId, address winner) external onlyLottery {
        // Transfer NFT to raffle winner
    }
    
    function executeBurn(uint256 vaultId) external onlyGovernance {
        // Burn if collection supports it
    }
}
```

---

## 8. Tokenomics (Optional)

### Do We Need a Token?

**Arguments for:**
- Governance over Treasury/Vault decisions
- Fee sharing with stakers
- Bootstrapping liquidity

**Arguments against:**
- Adds complexity
- Regulatory concerns
- Can work purely with ETH

### A potential $FLOOR token (not built)

*A possibility considered in this draft only. The supply and allocation below
are illustrative; no token exists, and any token would need its own legal and
economic review.*

```
Total Supply: 100,000,000 FLOOR

Distribution:
├── Community Airdrop:     20% (to early users)
├── Treasury:              30% (for incentives)
├── Team:                  15% (4yr vest)
├── Investors:             15% (2yr vest)
└── Liquidity:             20% (DEX pools)

Utility:
├── Governance voting
├── Fee sharing (stake FLOOR → earn ETH)
├── Boosted prediction market odds
└── Lottery ticket discounts
```

### Fee Sharing Model

```
All Fees
    │
    ├── 70% → Buyback Engine (floor support)
    │
    └── 30% → Staking Rewards (FLOOR holders)
```

### Recommendation

**Launch without token.** Prove the model works, then add token for governance/fee-sharing in v2.

---

## 9. Desktop App Design

### Why Desktop?

- **No app store censorship** — Gambling elements
- **Direct wallet connection** — Hardware wallet support
- **Local-first** — Privacy, no account required
- **Cross-platform** — Mac/Windows/Linux

### Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | **Tauri** (Rust + WebView) |
| Frontend | React + Tailwind |
| Wallet | WalletConnect v2 + ethers.js |
| RPC | User-configurable (Infura/Alchemy/own node) |
| Data | On-chain events + optional indexer |

### App Structure

```
┌─────────────────────────────────────────────────────────────┐
│  FloorGuard                                    [—][□][×]   │
├─────────────────────────────────────────────────────────────┤
│  [Marketplace] [Predictions] [Casino] [Vault] [Settings]   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │   BAYC      │  │  Pudgy     │  │  Azuki     │          │
│  │  Floor: 25E │  │  Floor: 8E │  │  Floor: 5E │          │
│  │  [Offers]   │  │  [Offers]  │  │  [Offers]  │          │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                             │
│  Your NFTs:                                                 │
│  ┌─────────────┐  ┌─────────────┐                          │
│  │  BAYC #1234 │  │  Pudgy #567│                          │
│  │  3 offers   │  │  1 offer   │                          │
│  │  Best: 26E  │  │  Best: 8.5E│                          │
│  └─────────────┘  └─────────────┘                          │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  Treasury: 12.4 ETH  │  Next Buyback: ~2.6 ETH to go       │
│  Vault: 47 NFTs      │  Connected: 0x1234...5678           │
└─────────────────────────────────────────────────────────────┘
```

### Views

1. **Marketplace**
   - Browse collections
   - View your NFTs + incoming offers
   - Make offers on any NFT
   - Accept/reject offers

2. **Predictions**
   - Active markets by collection
   - Place bets (higher/lower)
   - Claim winnings
   - Create markets (if enabled)

3. **Casino**
   - Coinflip
   - Weekly lottery
   - Community raffles
   - Game history

4. **Vault**
   - NFTs acquired via buybacks
   - Upcoming raffles
   - Burn history
   - Community gallery

5. **Settings**
   - RPC endpoint
   - Wallet connection
   - Notification preferences
   - Supported collections

---

## 10. Technical Implementation

### Development Phases

#### Phase 1: Core Marketplace (2-3 weeks)
- [ ] Marketplace.sol — offer/accept
- [ ] Treasury.sol — fee collection
- [ ] Basic Tauri app shell
- [ ] Wallet connection
- [ ] Make/accept/cancel offers

#### Phase 2: Buyback Engine (1-2 weeks)
- [ ] BuybackEngine.sol
- [ ] Vault.sol
- [ ] Auto-buyback on threshold
- [ ] Vault display in app

#### Phase 3: Prediction Market (2-3 weeks)
- [ ] PredictionMarket.sol
- [ ] Oracle integration (Chainlink)
- [ ] Market creation UI
- [ ] Betting UI
- [ ] Settlement logic

#### Phase 4: Casino (2-3 weeks)
- [ ] Coinflip.sol + VRF
- [ ] Lottery.sol
- [ ] Raffle.sol
- [ ] Casino UI tabs
- [ ] History/stats

#### Phase 5: Polish & Launch (2-3 weeks)
- [ ] Security audit
- [ ] Testnet deployment
- [ ] Community testing
- [ ] Mainnet deployment
- [ ] Documentation

**Total: 10-14 weeks** for full product

### Contract Deployment

```
Ethereum Mainnet (recommended for NFT liquidity)
├── FloorGuard.sol (coordinator)
├── Marketplace.sol
├── PredictionMarket.sol
├── Casino.sol
├── Treasury.sol
├── BuybackEngine.sol
└── Vault.sol

Alternative L2s:
├── Base (low fees, Coinbase ecosystem)
├── Arbitrum (established, good NFT scene)
└── Optimism (OP Stack, growing)
```

### Gas Optimization

| Function | Estimated Gas | Est. Cost @ 30 gwei |
|----------|--------------|---------------------|
| makeOffer | ~80,000 | ~$4 |
| acceptOffer | ~120,000 | ~$6 |
| placeBet | ~60,000 | ~$3 |
| claimWinnings | ~80,000 | ~$4 |
| coinflip | ~100,000 | ~$5 |

Consider L2 for lower fees, or batch operations.

---

## 11. Security Considerations

### Smart Contract Risks

| Risk | Mitigation |
|------|------------|
| Reentrancy | CEI pattern, ReentrancyGuard |
| Oracle manipulation | Multiple oracle sources, TWAPs |
| Flash loan attacks | Time-weighted prices |
| Admin key compromise | Multisig, timelock |
| VRF manipulation | Chainlink VRF v2.5 |

### Audit Checklist

- [ ] Professional audit (Code4rena, Sherlock, etc.)
- [ ] Formal verification for core logic
- [ ] Bug bounty program
- [ ] Staged rollout with caps

### Desktop App Security

- No private key storage (wallet connect only)
- Open source for transparency
- Code signing for downloads
- Auto-update mechanism

---

## 12. Roadmap

### Q2 2026
- [ ] Whitepaper finalization
- [ ] Smart contract development
- [ ] Testnet deployment
- [ ] Desktop app MVP

### Q3 2026
- [ ] Security audit
- [ ] Mainnet launch (Marketplace + Buyback)
- [ ] Community onboarding
- [ ] First floor buybacks

### Q4 2026
- [ ] Prediction market launch
- [ ] Casino games launch
- [ ] Multi-collection support
- [ ] Governance discussions

### 2027
- [ ] Token launch (if decided)
- [ ] DAO transition
- [ ] Mobile apps
- [ ] Cross-chain expansion

---

## 13. Conclusion

FloorGuard reimagines NFT marketplaces by aligning platform incentives with holder interests. Instead of racing to the bottom, the protocol creates a sustainable flywheel where:

1. **Trading generates fees**
2. **Fees fund floor buybacks**
3. **Buybacks support price**
4. **Strong floors attract more trading**

Combined with prediction markets and community casino games, FloorGuard offers a complete ecosystem that's fun, engaging, and fundamentally aligned with NFT holders.

The desktop-first approach ensures censorship resistance and true decentralization — no app store gatekeepers, no centralized servers, just smart contracts and a local app.

**It's time to guard the floor.**

---

## Appendix A: Reference Links

- Sylv's original thread: https://x.com/captainpuru/status/1825613065502462081
- Blur's toxic incentives: [analysis needed]
- Chainlink VRF: https://docs.chain.link/vrf
- Chainlink NFT Floor Feeds: https://docs.chain.link/data-feeds/nft-floor-price
- Tauri: https://tauri.app
- WalletConnect: https://walletconnect.com

---

## Appendix B: Contract Pseudocode

See `contracts/` folder for full implementations.

---

*Document version: 0.1*
*Last updated: 2026-03-19*
*Status: historical draft, superseded by the implementation and
[ARCHITECTURE.md](ARCHITECTURE.md)*

---

## 14. Community IP Fund (Added)

### The Vision

NFTs acquired through buybacks don't just sit idle — they become **community-owned productive assets** through IP licensing.

### How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                    VAULT (IP FUND)                          │
│                                                             │
│   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐      │
│   │ BAYC    │  │ Pudgy   │  │ Azuki   │  │ Doodle  │      │
│   │ #1234   │  │ #567    │  │ #890    │  │ #432    │      │
│   │ LOCKED  │  │ LOCKED  │  │ LOCKED  │  │ LOCKED  │      │
│   └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘      │
│        │            │            │            │            │
│        └────────────┴─────┬──────┴────────────┘            │
│                           ▼                                 │
│              ┌────────────────────────┐                    │
│              │     IP LICENSING       │                    │
│              │                        │                    │
│              │  • Commercial merch    │                    │
│              │  • Games & metaverse   │                    │
│              │  • Content creation    │                    │
│              │  • Brand partnerships  │                    │
│              └───────────┬────────────┘                    │
│                          ▼                                 │
│                    Lease Fees                              │
│                          ▼                                 │
│                     Treasury                               │
│                          ▼                                 │
│                   More Buybacks                            │
└─────────────────────────────────────────────────────────────┘
```

### License Tiers

| Tier | Use Case | Duration | Price Model |
|------|----------|----------|-------------|
| **Personal** | Social media, PFP use | 30 days | Free or minimal |
| **Creator** | YouTube, streaming, small merch | 90 days | Fixed fee (e.g., 0.1 ETH) |
| **Commercial** | Products, large-scale merch | 1 year | % of revenue or flat fee |
| **Enterprise** | Brand deals, major campaigns | Custom | Negotiated |

### Smart Contract: IPLicenseManager

```solidity
interface IIPLicenseManager {
    struct License {
        address licensee;
        uint256 vaultNFTId;      // Which vault NFT
        LicenseTier tier;
        uint256 startTime;
        uint256 endTime;
        uint256 feePaid;
        string usageScope;       // What they're allowed to do
        bool active;
    }
    
    enum LicenseTier { PERSONAL, CREATOR, COMMERCIAL, ENTERPRISE }
    
    // Request a license for a vault NFT
    function requestLicense(
        uint256 vaultNFTId,
        LicenseTier tier,
        string calldata usageScope
    ) external payable returns (uint256 licenseId);
    
    // Check if address has valid license
    function hasValidLicense(
        address licensee,
        uint256 vaultNFTId
    ) external view returns (bool);
    
    // Governance can revoke for violations
    function revokeLicense(uint256 licenseId) external onlyGovernance;
    
    // View active licenses for an NFT
    function getLicenses(uint256 vaultNFTId) external view returns (License[] memory);
}
```

### IP Rights Compatibility

**Collections with commercial rights for holders:**
- ✅ Bored Ape Yacht Club (full commercial)
- ✅ Pudgy Penguins (full commercial)
- ✅ Doodles (full commercial)
- ✅ Azuki (full commercial)
- ⚠️ CryptoPunks (limited — Yuga owns)
- ❌ Art Blocks (varies by artist)

FloorGuard can only lease IP for collections that grant commercial rights to holders. The Vault becomes the "holder" and can sublicense.

### Use Cases

**1. Merch Creator**
```
Designer wants to make BAYC t-shirts
    ↓
Licenses BAYC #1234 from Vault (0.5 ETH/year)
    ↓
Creates and sells merch legally
    ↓
License fee → Treasury → Buybacks
```

**2. Game Developer**
```
Indie game wants Pudgy characters
    ↓
Licenses 5 Pudgys from Vault (2 ETH total)
    ↓
Uses in game with attribution
    ↓
Fees → Treasury → Buybacks
```

**3. Content Creator**
```
YouTuber wants Azuki for thumbnails/videos
    ↓
Creator tier license (0.1 ETH/90 days)
    ↓
Uses across content
    ↓
Fees → Treasury → Buybacks
```

### Illustrative licensing scenarios (not a forecast)

If the Vault held 100 NFTs with mixed licensing, purely for illustration:

| Scenario | Monthly Licenses | Avg Fee | Monthly Revenue |
|----------|-----------------|---------|-----------------|
| Conservative | 20 | 0.1 ETH | 2 ETH |
| Moderate | 50 | 0.15 ETH | 7.5 ETH |
| Optimistic | 100 | 0.2 ETH | 20 ETH |

In this scenario, licence fees would add to the buyback budget without selling
the NFTs. Whether anyone would pay for such licences is untested.

### Governance Decisions

The community (or governance token holders) can vote on:

1. **Pricing** — License fee adjustments
2. **Exclusivity** — Can multiple people license same NFT?
3. **Restrictions** — What uses are prohibited?
4. **Revenue split** — % to buybacks vs stakers vs other

### Benefits Summary

| Stakeholder | Benefit |
|-------------|---------|
| **NFT Holders** | Floor support from locked NFTs |
| **Creators** | Affordable access to blue-chip IP |
| **Collections** | Increased utility and visibility |
| **Protocol** | Additional revenue stream |
| **Community** | Shared ownership of valuable IP |

### Future Extensions

1. **Fractionalized IP rights** — Multiple licensees share one NFT
2. **Revenue sharing** — Licensees pay % of their revenue
3. **Exclusive partnerships** — Brands can lock exclusive rights
4. **Cross-collection bundles** — License multiple NFTs as package
5. **Derivative tracking** — On-chain registry of licensed works

---

*This turns FloorGuard from just a marketplace into a community-owned IP fund that generates sustainable yield while supporting floor prices.*

---

## 15. Vault Unlock Mechanics (Added)

### Unlock Conditions

NFTs acquired by the Treasury are **not permanently locked**. They unlock when BOTH conditions are met:

| Condition | Requirement |
|-----------|-------------|
| ⏱️ **Time Lock** | Minimum 6 months since acquisition |
| 📈 **Price Trigger** | Collection floor ≥ 130% of purchase price |

```
Example:
├── Bought BAYC #1234 at 20 ETH floor
├── Lock starts: March 2026
├── Earliest unlock: September 2026 (6 months)
├── Price trigger: Floor must be ≥ 26 ETH (+30%)
└── If floor is 28 ETH in October → UNLOCKED ✓
```

### Governance Override

Community/governance can override unlock in special cases:

| Override Type | Use Case |
|---------------|----------|
| **Early unlock** | Emergency liquidity, exceptional opportunity |
| **Extended lock** | Strong IP revenue, community wants to keep |
| **Force unlock** | Collection rugging, need to exit |

Requires governance vote (token holders or multisig in v1).

### On Unlock: What Happens?

```
┌─────────────────────────────────────────────────────────────┐
│                     NFT UNLOCKED                            │
│                          ↓                                  │
│    ┌─────────────────────────────────────────────┐         │
│    │           GOVERNANCE DECISION               │         │
│    └─────────────────────────────────────────────┘         │
│           ↓              ↓              ↓                   │
│    ┌──────────┐   ┌──────────┐   ┌──────────┐             │
│    │  AUCTION │   │  RAFFLE  │   │   HOLD   │             │
│    │          │   │          │   │          │             │
│    │ Sell for │   │ Community│   │ Keep for │             │
│    │ profit   │   │ reward   │   │ IP fees  │             │
│    └────┬─────┘   └────┬─────┘   └────┬─────┘             │
│         │              │              │                    │
│         ▼              ▼              ▼                    │
│    ┌──────────────────────────────────────────┐           │
│    │              TREASURY                     │           │
│    │   Profit from auction → Buy more NFTs    │           │
│    │   Raffle ticket sales → Buy more NFTs    │           │
│    │   IP licensing fees → Buy more NFTs      │           │
│    └──────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────┘
```

### Profit Recycling

When unlocked NFTs are sold at profit:

```
Bought at: 20 ETH
Sold at:   30 ETH
Profit:    10 ETH
    ↓
    ├── 100% → Treasury
    │      ↓
    │   Buy MORE floor NFTs
    │   (same or different collections)
    │
    └── Counter-cyclical accumulation:
        • Buy during dips
        • Sell during rips
        • Grow holdings over time
```

### Smart Contract: VaultUnlock

```solidity
interface IVaultUnlock {
    struct LockedNFT {
        address nftContract;
        uint256 tokenId;
        uint256 purchasePrice;      // Floor at time of buy
        uint256 purchaseTime;
        bool unlocked;
    }
    
    // Check if NFT can be unlocked
    function canUnlock(uint256 vaultId) external view returns (bool);
    
    // Unlock (requires both conditions met)
    function unlock(uint256 vaultId) external;
    
    // Governance override
    function governanceUnlock(uint256 vaultId) external onlyGovernance;
    function governanceExtendLock(uint256 vaultId, uint256 newDuration) external onlyGovernance;
    
    // Execute post-unlock action
    function executeAuction(uint256 vaultId) external onlyGovernance;
    function executeRaffle(uint256 vaultId) external onlyGovernance;
}

// Unlock logic
function canUnlock(uint256 vaultId) public view returns (bool) {
    LockedNFT memory nft = lockedNFTs[vaultId];
    
    // Condition 1: 6 months passed
    bool timeMet = block.timestamp >= nft.purchaseTime + 180 days;
    
    // Condition 2: Floor is 130% of purchase price
    uint256 currentFloor = oracle.getFloorPrice(nft.nftContract);
    bool priceMet = currentFloor >= (nft.purchasePrice * 130) / 100;
    
    return timeMet && priceMet;
}
```

### Default Behavior

If governance doesn't act within 30 days of unlock:

1. **Auto-auction** via Dutch auction (starts at 150% floor, drops to floor)
2. Proceeds → Treasury → automatic buyback cycle continues

This ensures the system keeps running even without active governance.

### Summary

| Parameter | Value |
|-----------|-------|
| Minimum lock | 6 months |
| Price trigger | +30% above purchase |
| Unlock requires | Both conditions |
| Override | Governance vote |
| Default action | Auto-auction after 30 days |
| Profits | 100% recycled to buy more NFTs |

---

*This creates a sustainable "buy low, sell high" cycle that compounds Treasury holdings over time while supporting floor prices during downturns.*

---

## 16. Casino Games & NFT Raffle Integration (Added)

### The Hook

Vault NFTs become **prizes in the casino** — giving players a shot at winning real blue-chip NFTs through simple gambling games.

### Game Suite (Simple to Start)

```
┌─────────────────────────────────────────────────────────────┐
│                    FLOORGUARD CASINO                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  🎰 SLOTS          🎲 DICE          🪙 COINFLIP            │
│  ───────────       ───────          ─────────              │
│  Match 3 wins      Over/Under       Heads/Tails            │
│  2-5% edge         2% edge          2% edge                │
│                                                             │
│  ════════════════════════════════════════════════════════  │
│                                                             │
│  🎫 NFT RAFFLE (The Hook!)                                 │
│  ─────────────────────────                                 │
│  Win ACTUAL blue-chip NFTs from the Vault!                 │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  🐵 BAYC #1234        │  Current Pot: 847 tickets   │   │
│  │  Floor: ~25 ETH       │  Ticket: 0.05 ETH           │   │
│  │                       │  Draw in: 2d 14h            │   │
│  │                       │                             │   │
│  │  [ BUY 1 ] [ BUY 10 ] [ BUY 100 ]                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  🐧 Pudgy #567        │  Current Pot: 312 tickets   │   │
│  │  Floor: ~8 ETH        │  Ticket: 0.02 ETH           │   │
│  │                       │  Draw in: 5d 2h             │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### How NFT Raffles Work

```
1. Vault NFT unlocks (or governance allocates one)
         ↓
2. Raffle created with:
   • Ticket price (e.g., 0.05 ETH)
   • Duration (e.g., 7 days)
   • Min tickets (or no minimum)
         ↓
3. Users buy tickets
         ↓
4. Draw uses Chainlink VRF
         ↓
5. Winner gets NFT transferred
         ↓
6. ALL ticket revenue → Treasury → More buybacks
```

### Ticket Pricing Strategy

| NFT Floor Value | Ticket Price | Expected Tickets | Total Pot |
|-----------------|--------------|------------------|-----------|
| ~5 ETH | 0.01 ETH | 700-1000 | 7-10 ETH |
| ~10 ETH | 0.02 ETH | 700-1000 | 14-20 ETH |
| ~25 ETH | 0.05 ETH | 700-1000 | 35-50 ETH |
| ~50 ETH | 0.1 ETH | 700-1000 | 70-100 ETH |

**Key insight:** Raffle pot often EXCEEDS NFT floor value → profit for Treasury!

### Simple Casino Games

**🎰 Slots**
```
[ 🍒 ] [ 🍒 ] [ 🍒 ] → JACKPOT! 10x
[ 🍒 ] [ 🍒 ] [ 🍋 ] → 2x
[ 💎 ] [ 💎 ] [ 💎 ] → 50x (rare)

House edge: 3-5%
Min bet: 0.001 ETH
Max bet: 1 ETH
```

**🎲 Dice**
```
Roll 1-100
├── Over/Under X (variable odds)
├── Exact number (100x)
└── Range bets

House edge: 2%
```

**🪙 Coinflip**
```
Heads or Tails
Win: 1.96x (2% edge)
```

### Revenue Flow

```
┌─────────────────┐
│  Casino Games   │
│  (Slots/Dice/   │
│   Coinflip)     │
│                 │
│  House Edge:    │
│  2-5%           │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│    TREASURY     │ ◄───│   NFT Raffles   │
│                 │     │                 │
│  Accumulates    │     │  100% of        │
│  all fees       │     │  ticket sales   │
└────────┬────────┘     └─────────────────┘
         │
         ▼
┌─────────────────┐
│ BUYBACK ENGINE  │
│                 │
│ Buys more floor │
│ NFTs → Vault    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│     VAULT       │
│                 │
│ Some NFTs go to │
│ future raffles! │
└─────────────────┘

     CIRCULAR ECONOMY
```

### Gamification Hooks

| Feature | Engagement |
|---------|------------|
| **Daily free spin** | 1 free slot spin per day (small prizes) |
| **Streak bonus** | Consecutive day bonus tickets |
| **Leaderboard** | Top gamblers get bonus raffle entries |
| **Achievements** | Unlock badges, cosmetics |
| **Referrals** | 5% of referee's losses → referrer |

### Smart Contract: CasinoRaffle

```solidity
interface ICasinoRaffle {
    struct Raffle {
        uint256 vaultNFTId;
        uint256 ticketPrice;
        uint256 endTime;
        uint256 ticketsSold;
        address winner;
        bool drawn;
    }
    
    // Buy raffle tickets
    function buyTickets(uint256 raffleId, uint256 amount) external payable;
    
    // Draw winner (permissionless, uses VRF)
    function draw(uint256 raffleId) external;
    
    // Claim prize (winner only)
    function claimPrize(uint256 raffleId) external;
    
    // View your tickets
    function myTickets(uint256 raffleId) external view returns (uint256);
}
```

### Example User Journey

```
1. User discovers FloorGuard Casino
         ↓
2. Plays slots, wins some, loses some (fun)
         ↓
3. Sees "Win a BAYC!" raffle banner
         ↓
4. Buys 10 tickets (0.5 ETH) for a shot
         ↓
5. Doesn't win, but had fun
         ↓
6. Their 0.5 ETH → Treasury → Buyback
         ↓
7. Floor gets supported, they benefit as holder
         ↓
8. Comes back next week for new raffle
```

### Why This Works

| Element | Effect |
|---------|--------|
| Simple games | Low barrier, instant gratification |
| NFT raffles | Aspirational hook (win a BAYC!) |
| Ticket model | Affordable entry to blue-chip |
| 100% to Treasury | No extraction, all supports floor |
| Circular economy | Winners came from vault, losers fill vault |

---

*The casino isn't about extracting value — it's a fun engagement layer that channels community spending into floor support.*

---

## 17. Points System & Eligibility Raffles (Revised Model)

### Correction: Raffles Are Rewards, Not Purchases

NFT raffles aren't bought — they're **earned through engagement**. Users accumulate points by using the platform, and points make them eligible for NFT raffles when vault NFTs unlock.

### How Points Work

```
┌─────────────────────────────────────────────────────────────┐
│                    EARN POINTS                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  🎰 CASINO                    │  Points Earned             │
│  ─────────────────────────────┼──────────────────────────  │
│  Every 0.1 ETH wagered        │  +10 points                │
│  Win streak (5+)              │  +50 bonus                 │
│  Daily login + play           │  +5 points                 │
│                                                             │
│  📈 PREDICTION MARKET         │  Points Earned             │
│  ─────────────────────────────┼──────────────────────────  │
│  Every 0.1 ETH bet            │  +10 points                │
│  Correct prediction           │  +25 bonus                 │
│  Streak of correct calls      │  +100 bonus                │
│                                                             │
│  🛒 MARKETPLACE               │  Points Earned             │
│  ─────────────────────────────┼──────────────────────────  │
│  Every 1 ETH trading volume   │  +50 points                │
│  First trade of the day       │  +10 bonus                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Raffle Eligibility

When a vault NFT unlocks and governance decides to raffle it:

```
NFT Unlocks
    ↓
Snapshot of all point holders
    ↓
Weighted random draw (more points = better odds)
    ↓
Winner receives NFT
    ↓
Winner's points reset to 0 (or reduced %)
    ↓
Others keep accumulating for next raffle
```

### Weighted Odds Example

```
┌────────────────────────────────────────────────┐
│  BAYC #1234 Raffle                             │
│                                                │
│  User        Points    Odds                    │
│  ─────────────────────────────────────────     │
│  Alice       50,000    25%                     │
│  Bob         30,000    15%                     │
│  Charlie     20,000    10%                     │
│  ...997 others 100,000  50%                    │
│                                                │
│  Total Pool: 200,000 points                    │
│                                                │
│  [ DRAW WINNER ] (Chainlink VRF)              │
└────────────────────────────────────────────────┘
```

### Points Don't Cost Extra

**Important:** Points are earned from activity you're already doing. No separate purchase.

| Activity | You Pay | You Get |
|----------|---------|---------|
| Slots bet 1 ETH | 1 ETH (normal bet) | 100 points + potential win |
| Prediction bet 0.5 ETH | 0.5 ETH (normal bet) | 50 points + potential win |
| Trade NFT | Normal fees | 50 points per ETH volume |

### Post-Win Reset

To keep it fair and prevent whales from winning everything:

| Option | How It Works |
|--------|--------------|
| **Full reset** | Winner's points go to 0 |
| **Partial reset** | Winner keeps 20%, loses 80% |
| **Cooldown** | Winner ineligible for next 2 raffles |
| **Tiered** | Different NFT tiers have separate point pools |

Recommendation: **Partial reset (keep 20%)** — rewards loyalty but gives others a chance.

### Smart Contract: PointsSystem

```solidity
interface IPointsSystem {
    // Points automatically credited on activity
    // (Called internally by Casino, Prediction, Marketplace contracts)
    function creditPoints(address user, uint256 amount) external onlyAuthorized;
    
    // View points
    function getPoints(address user) external view returns (uint256);
    function getTotalPoints() external view returns (uint256);
    
    // Raffle mechanics
    function snapshotForRaffle(uint256 raffleId) external onlyGovernance;
    function drawWinner(uint256 raffleId) external returns (address winner);
    function resetWinnerPoints(address winner, uint256 keepPercent) external onlyRaffle;
    
    // View odds
    function getOdds(address user) external view returns (uint256 numerator, uint256 denominator);
}
```

### The Complete Loop

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│    User plays Casino/Predictions/trades NFTs                │
│                        ↓                                    │
│    Earns points (no extra cost)                            │
│                        ↓                                    │
│    Vault NFT unlocks (6mo + 30% price increase)            │
│                        ↓                                    │
│    Governance triggers raffle                               │
│                        ↓                                    │
│    Weighted draw among point holders                        │
│                        ↓                                    │
│    Winner gets NFT! Points reset.                          │
│                        ↓                                    │
│    Everyone else keeps points for next raffle              │
│                        ↓                                    │
│    Continue playing to improve odds                        │
│                        │                                    │
│                        └────────────────────────────────────┤
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Why This Model

| Benefit | Explanation |
|---------|-------------|
| **Engagement** | Keeps users active (more play = more points) |
| **Not pay-to-win** | Points from activity, not purchased |
| **Fair distribution** | Weighted odds, but small players can win |
| **Loyalty reward** | Long-term users accumulate advantage |
| **No extra extraction** | House edge already captured in games |

---

*Raffles become the ultimate engagement hook — play more, increase your odds, win blue-chip NFTs.*
