// The outward-facing page. Three kinds of thing move here, and each says which it is:
//  - the hero reads the demo simulation running in this tab (src/demo/sim.ts): play money;
//  - the flywheel story runs its own explainer model (src/viz/flywheelModel.ts): the contracts'
//    rules with example amounts, changed only by the visitor;
//  - the fairness walk recomputes a payout from a sample number drawn in this browser.
// Nothing is fetched, nothing is real money, and no activity is invented.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { FloorLine } from "../brand";
import { setMode } from "../demo/mode";
import { demoReads } from "../demo/sim";
import { eth } from "../lib/format";
import { href } from "../routes";
import { FairnessWalk } from "../viz/FairnessWalk";
import { Flywheel, type FlyData, type FlyFlow, type FlyHandle, type FlyNode } from "../viz/Flywheel";
import { advance, catchAuction, initialModel, modelAuctionPrice, modelBid, modelCurve, modelLock, raffle, RULES, sellIntoBid, setDay, setFloor, startAuction, trade, unlock, wager, type FlowEvent, type Model } from "../viz/flywheelModel";
import { HeroScene } from "../viz/HeroScene";
import { useDemoTick, useInView, useReducedMotion, useWidth } from "../viz/motion";
import { PriceLockGauge, Shackle, TimeLockDial } from "../viz/parts";

const launch = (path: string) => () => {
  setMode("demo", false);
  window.location.hash = path;
};

// ---------------------------------------------------------------- hero

function Hero() {
  useDemoTick();
  const section = useRef<HTMLElement>(null);
  const bidTag = useRef<HTMLDivElement>(null);
  const floorTag = useRef<HTMLDivElement>(null);
  const lastText = useRef(0);
  const [passed, setPassed] = useState(false);
  const overview = demoReads.overview();

  // Scroll parallax: the copy lifts away a little faster than the scene.
  useEffect(() => {
    const node = section.current;
    if (!node) return;
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        node.style.setProperty("--scroll", String(Math.min(1, window.scrollY / Math.max(1, node.offsetHeight))));
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <section className="lp-hero" ref={section}>
      <HeroScene
        onReadout={({ bid, floor, x, y, horizon, capped, limited }) => {
          const tag = bidTag.current;
          if (tag) tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
          if (floorTag.current) floorTag.current.style.transform = `translateY(${horizon.toFixed(1)}px)`;
          const now = performance.now();
          if (now - lastText.current < 250) return;
          lastText.current = now;
          if (tag) tag.querySelector("b")!.textContent = bid.toFixed(4);
          if (tag) tag.querySelector("span")!.textContent = limited ? "ETH, limited by the budget" : capped ? "ETH, at its cap" : "ETH, rising";
          if (floorTag.current) floorTag.current.querySelector("b")!.textContent = floor.toFixed(3);
          setPassed((was) => (was === bid >= floor ? was : bid >= floor));
        }}
      />
      <div className="hero-tag bid" ref={bidTag} aria-hidden="true">
        <i>demo bid</i>
        <b>–</b> <span>ETH, rising</span>
      </div>
      <div className="hero-tag floor" ref={floorTag} aria-hidden="true">
        <i>the floor: last demo sales</i>
        <b>–</b> <span>ETH</span>
      </div>

      <div className="lp-hero-copy">
        <p className="eyebrow">An NFT marketplace protocol · unaudited · not deployed publicly</p>
        <h1>
          Fees that
          <br />
          <span className="accent-text">buy the floor.</span>
        </h1>
        <p className="lede">
          A marketplace with no listings to undercut. The part of each fee that is not paid to the NFT project becomes a
          budget for buying that collection's cheapest tokens, and what it buys is locked in a vault. The effect is modest:
          about one token bought for every fifty traded.
        </p>
        <div className="hero-actions">
          <button type="button" className="btn big" onClick={launch("/app")}>
            Launch the demo
          </button>
          <a className="btn secondary big" href="#how" onClick={(e) => (e.preventDefault(), document.getElementById("how")?.scrollIntoView({ behavior: "smooth" }))}>
            See how it works
          </a>
        </div>
        <p className="muted small hero-fine">No wallet needed. The demo is a simulation on play money, and nothing here is an investment.</p>
      </div>

      <div className="hero-foot">
        <dl className="hero-figures">
          <div>
            <dt>Demo budget</dt>
            <dd>{eth(overview.floorBid.budget, 3)} ETH</dd>
          </div>
          <div>
            <dt>Demo bid</dt>
            <dd>{eth(overview.floorBid.currentBid, 4)} ETH</dd>
          </div>
          <div>
            <dt>In the demo vault</dt>
            <dd>{overview.collectionHoldingsInVault} held</dd>
          </div>
        </dl>
        <p className="hero-caption small">
          {passed ? (
            <>
              The demo bid has passed the last sales floor. In the demo, you are the holder who can{" "}
              <a href={href("/trade/floor-bid")} onClick={launch("/trade/floor-bid")}>
                sell into it
              </a>
              .
            </>
          ) : (
            "The line and the tiles are the demo simulation in this tab: play money, simulated time 600 times faster than real."
          )}
        </p>
      </div>
      <p className="sr-only">
        Picture: the floor price as a glowing horizon with the vault's {overview.collectionHoldingsInVault} demo holdings resting on it, and the
        protocol's demo bid, {eth(overview.floorBid.currentBid, 4)} ETH, rising towards it.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- the flywheel story

type Chapter = { id: string; kicker: string; title: string; body: ReactNode; focus: FlyNode[]; flows: FlyFlow[] };

const CHAPTERS: Chapter[] = [
  {
    id: "fees",
    kicker: "01 · Fees in",
    title: "Every trade and every game leaves a fee.",
    body: (
      <>
        A sale on the marketplace pays a 2% fee. Dice and slots take a 2% edge on each wager: half of it is a fee, and the
        games bankroll keeps the other half for the risk it carries. Lottery and ticket-raffle pots pay 5%, prediction
        winnings 3%, artwork licences their price.
      </>
    ),
    focus: ["trading", "games", "more", "budget"],
    flows: ["trade", "games", "more"],
  },
  {
    id: "budget",
    kicker: "02 · A budget per collection",
    title: "Fees are not pooled.",
    body: (
      <>
        Each collection's fees fill that collection's own budget, and one collection can never spend another's. Only the buyback
        engine can pay out of it. A project can be given a share of its collection's fees first, at most half. The bid is never
        more than this budget can pay.
      </>
    ),
    focus: ["budget", "bid"],
    flows: ["fuel"],
  },
  {
    id: "bid",
    kicker: "03 · The rising bid",
    title: "A bid that climbs until someone sells.",
    body: (
      <>
        The protocol quotes a standing bid for the collection. Its curve rises with time until a holder accepts it, then steps
        down and rises again, so it finds the lowest price a holder will accept without an oracle. The rise only counts while
        the budget covers it: money that arrives late restarts the curve. The owner sets a cap it cannot pass.
      </>
    ),
    focus: ["budget", "bid", "holder", "vault"],
    flows: ["fuel", "pay", "deposit"],
  },
  {
    id: "lock",
    kicker: "04 · The vault",
    title: "Two locks hold what the bid buys.",
    body: (
      <>
        A bought token cannot leave until both open: 180 days have passed, and the floor is at least 30% above what the vault
        paid for it. If the floor never gets there, it stays locked unless the owner releases it. Move time and the floor and
        watch the locks.
      </>
    ),
    focus: ["vault"],
    flows: [],
  },
  {
    id: "out",
    kicker: "05 · Release",
    title: "Out by a falling price, or a raffle.",
    body: (
      <>
        An unlocked token goes to a Dutch auction or to a raffle. The auction opens at 16 times its reserve and halves every day
        until someone catches it; the reserve is the higher of the floor and 130% of the purchase price. A raffle gives the
        token to a holder of activated points. Points are earned by paying fees, so they can be bought by trading with
        oneself.
      </>
    ),
    focus: ["vault", "auction", "raffle", "budget"],
    flows: ["toAuction", "proceeds", "toRaffle"],
  },
  {
    id: "again",
    kicker: "06 · Round again",
    title: "Proceeds are budget again.",
    body: (
      <>
        What the auction earns returns to the same collection's budget. Selling one token brings in about enough to buy one
        back, so auctions do not grow the vault. That is the whole machine. It promises no price: the bid pays only what the
        budget holds, up to the owner's cap, and the software is unaudited.
      </>
    ),
    focus: ["auction", "budget", "bid"],
    flows: ["proceeds", "fuel"],
  },
];

const f3 = (n: number) => n.toFixed(3);

function Story() {
  const reduced = useReducedMotion();
  const [model, setModel] = useState<Model>(initialModel);
  const [active, setActive] = useState(0);
  const [note, setNote] = useState<string>();
  const fly = useRef<FlyHandle>(null);
  const stage = useRef<HTMLDivElement>(null);
  const width = useWidth(stage, 600);
  const chapters = useRef<(HTMLElement | null)[]>([]);
  const sectionRef = useRef<HTMLElement>(null);
  const inView = useInView(sectionRef, "0px");

  // Which chapter is in the middle of the screen.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.index));
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    chapters.current.forEach((node) => node && observer.observe(node));
    return () => observer.disconnect();
  }, []);

  const emit = (events: FlowEvent[]) =>
    events.forEach((event, i) =>
      window.setTimeout(() => {
        if (event.flow === "trade" || event.flow === "games") fly.current?.emit(event.flow, "eth", `+${f3(event.amount)}`);
        else if (event.flow === "pay") fly.current?.emit("pay", "eth", `${f3(event.amount)} ETH`);
        else if (event.flow === "proceeds") fly.current?.emit("proceeds", "eth", `+${f3(event.amount)}`);
        else if (event.flow === "restart") setNote("The curve restarted: this money reached a budget that could not cover it.");
        else fly.current?.emit(event.flow, "nft");
      }, i * 260),
    );
  const act = (step: (m: Model) => { model: Model; events: FlowEvent[]; refused?: string }) => {
    const result = step(model);
    setModel(result.model);
    setNote(result.refused);
    emit(result.events);
  };

  const bid = modelBid(model);
  const curve = modelCurve(model);
  const bidLine =
    model.budget < RULES.minBid
      ? `The budget holds less than the minimum bid of ${RULES.minBid} ETH, so there is no buyback.`
      : model.budget < curve
        ? `The curve is at ${curve.toFixed(4)} ETH; the budget can pay ${f3(model.budget)}, so the bid is ${f3(bid)} ETH.`
        : `The curve is at ${curve.toFixed(4)} ETH${curve >= RULES.maxBid ? ", its cap," : ""} and the budget covers it, so the bid is ${bid.toFixed(4)} ETH.`;
  const holding = model.holdings.find((h) => h.status === "locked" || h.status === "unlocked" || h.status === "auction") ?? model.holdings[model.holdings.length - 1];
  const lock = holding ? modelLock(model, holding) : undefined;
  const onAuction = model.holdings.find((h) => h.status === "auction");
  const auctionPrice = onAuction?.auction ? modelAuctionPrice(onAuction.auction, model.day) : undefined;

  // While the release chapter is on screen, a running auction's days pass by themselves so the
  // price can be seen falling. Reduced motion: the visitor steps the days instead.
  const auctionRunning = !!onAuction && active === 4 && inView && !reduced && auctionPrice! > onAuction!.auction!.reserve + 1e-9;
  useEffect(() => {
    if (!auctionRunning) return;
    const id = setInterval(() => setModel((m) => advance(m, 0.05)), 120);
    return () => clearInterval(id);
  }, [auctionRunning]);

  const data: FlyData = {
    budget: model.budget,
    bid,
    curve,
    bidBase: model.bidBase,
    bidCap: RULES.maxBid,
    minBid: RULES.minBid,
    tiles: model.holdings.filter((h) => h.status === "locked" || h.status === "unlocked" || h.status === "auction").map((h) => ({ key: String(h.id), state: h.status as "locked" | "unlocked" | "auction" })),
    auction: onAuction?.auction ? { price: auctionPrice!, reserve: onAuction.auction.reserve, progress: Math.min(1, (model.day - onAuction.auction.startDay) / 4) } : undefined,
  };

  const chapter = CHAPTERS[active];
  const DAY = 86_400;
  const controls: ReactNode[] = [
    // 01 fees
    <>
      <div className="story-actions">
        <button type="button" className="btn" onClick={() => act((m) => trade(m, 1))}>
          Trade for 1 ETH
        </button>
        <button type="button" className="btn secondary" onClick={() => act((m) => wager(m, 0.5))}>
          Wager 0.5 ETH
        </button>
      </div>
      <p className="story-read">
        Fees in so far: <b>{f3(model.fees.trading)}</b> from trading, <b>{f3(model.fees.games)}</b> from games.
      </p>
    </>,
    // 02 budget
    <>
      <p className="story-read">
        This collection's budget: <b>{f3(model.budget)} ETH</b>. {bidLine}
      </p>
      <div className="story-actions">
        <button type="button" className="btn secondary" onClick={() => act((m) => trade(m, 25))}>
          A busy week: 25 ETH of trades
        </button>
      </div>
    </>,
    // 03 bid
    <>
      <p className="story-read">
        Day {model.day.toFixed(1)}. {bidLine}
      </p>
      <div className="story-actions">
        <button type="button" className="btn secondary" onClick={() => setModel((m) => advance(m, 1))}>
          Wait a day
        </button>
        <button type="button" className="btn" onClick={() => act(sellIntoBid)}>
          Sell into the bid
        </button>
      </div>
    </>,
    // 04 locks
    holding && lock && holding.status === "locked" ? (
      <>
        <div className="story-locks">
          <TimeLockDial acquiredAt={holding.boughtDay * DAY} lockedUntil={(holding.boughtDay + RULES.lockDays) * DAY} now={model.day * DAY} size={84} />
          <PriceLockGauge purchasePrice={BigInt(Math.round(holding.price * 1e6)) * 10n ** 12n} floor={BigInt(Math.round(model.floor * 1e6)) * 10n ** 12n} />
        </div>
        <label className="field">
          <span>Days since the vault bought it: {Math.round(model.day - holding.boughtDay)}</span>
          <input type="range" min={0} max={240} value={Math.min(240, Math.round(model.day - holding.boughtDay))} onChange={(e) => setModel((m) => setDay(m, holding.boughtDay + Number(e.target.value)))} />
        </label>
        <label className="field">
          <span>
            Floor price: {f3(model.floor)} ETH (bought at {f3(holding.price)})
          </span>
          <input type="range" min={0.5} max={2} step={0.01} value={model.floor} onChange={(e) => setModel((m) => setFloor(m, Number(e.target.value)))} />
        </label>
        <div className="story-actions">
          <button type="button" className="btn" onClick={() => act((m) => unlock(m, holding.id))} disabled={!lock.time || !lock.price}>
            <Shackle open={lock.time && lock.price} size={18} /> Unlock
          </button>
          <span className="muted small">Anyone can call it once both locks are open.</span>
        </div>
      </>
    ) : holding && holding.status !== "locked" && model.holdings.some((h) => h.status !== "locked") ? (
      <p className="story-read">
        Holding #{holding.id} is {holding.status === "unlocked" ? "unlocked. Scroll on to release it." : holding.status === "auction" ? "on auction." : "gone."}{" "}
        <button type="button" className="link-btn" onClick={() => act(sellIntoBid)}>
          Sell another into the bid
        </button>
      </p>
    ) : (
      <div className="story-actions">
        <button type="button" className="btn" onClick={() => act(sellIntoBid)}>
          First, sell one into the bid
        </button>
      </div>
    ),
    // 05 out
    !holding || holding.status === "sold" || holding.status === "raffled" ? (
      <>
        {holding?.status === "sold" && (
          <p className="story-read">
            Caught at <b>{f3(holding.soldFor ?? 0)} ETH</b>. The proceeds went back to the budget.
          </p>
        )}
        {holding?.status === "raffled" && <p className="story-read">Raffled to a points holder. No ETH moved.</p>}
        <div className="story-actions">
          <button type="button" className="btn secondary" onClick={() => act(sellIntoBid)}>
            Sell another into the bid
          </button>
        </div>
      </>
    ) : holding.status === "locked" ? (
      <>
        <p className="story-read">Holding #{holding.id} is still locked.</p>
        <div className="story-actions">
          <button
            type="button"
            className="btn secondary"
            onClick={() => {
              const ready = setFloor(setDay(model, holding.boughtDay + RULES.lockDays), Math.max(model.floor, Math.ceil(holding.price * RULES.unlockMultiple * 100) / 100));
              const result = unlock(ready, holding.id);
              setModel(result.model);
              setNote(result.refused);
            }}
          >
            Skip ahead: 180 days on, floor up 30%, unlock
          </button>
        </div>
      </>
    ) : holding.status === "unlocked" ? (
      <div className="story-actions">
        <button type="button" className="btn" onClick={() => act((m) => startAuction(m, holding.id))}>
          Start the auction
        </button>
        <button type="button" className="btn secondary" onClick={() => act((m) => raffle(m, holding.id))}>
          Raffle it instead
        </button>
      </div>
    ) : (
      <>
        <p className="story-read">
          Day {(model.day - holding.auction!.startDay).toFixed(1)} of the auction: <b>{f3(auctionPrice ?? 0)} ETH</b>, falling to a reserve of{" "}
          {f3(holding.auction!.reserve)}.
        </p>
        <div className="story-actions">
          <button type="button" className="btn" onClick={() => act((m) => catchAuction(m, holding.id))}>
            Catch it at {f3(auctionPrice ?? 0)} ETH
          </button>
          <button type="button" className="btn secondary" onClick={() => setModel((m) => advance(m, 1))}>
            Next day
          </button>
        </div>
      </>
    ),
    // 06 again
    <>
      <p className="story-read">
        Budget now: <b>{f3(model.budget)} ETH</b>. Bid: <b>{bid.toFixed(4)} ETH</b>.
      </p>
      <div className="story-actions">
        <button type="button" className="btn" onClick={launch("/app")}>
          Try it in the demo
        </button>
        <button
          type="button"
          className="btn secondary"
          onClick={() => {
            setModel(initialModel());
            setNote(undefined);
          }}
        >
          Reset this model
        </button>
      </div>
    </>,
  ];

  const press = (node: FlyNode) => {
    if (node === "trading") act((m) => trade(m, 1));
    else if (node === "games") act((m) => wager(m, 0.5));
    else if (node === "holder") act(sellIntoBid);
  };

  return (
    <section id="how" className="lp-story" ref={sectionRef} aria-labelledby="how-title">
      <header className="lp-section-head">
        <p className="eyebrow">The flywheel</p>
        <h2 id="how-title">Fees become a bid. The bid fills a vault. The vault pays back.</h2>
        <p className="lede">Scroll through it, and poke it: every button and slider below moves the machine on the right.</p>
      </header>
      <div className="story-grid">
        <div className="story-stage" ref={stage}>
          <div className="story-machine">
            <Flywheel
              ref={fly}
              layout={width < 520 ? "tall" : "wide"}
              data={data}
              focus={chapter.focus}
              focusFlows={chapter.flows}
              onNode={press}
              actions={{ trading: "Trade for 1 ETH: send the 2% fee to the budget", games: "Wager 0.5 ETH: send half of the 2% edge to the budget", holder: "Sell a token into the bid" }}
              label="The flywheel: fees from trading and games fill a per-collection budget, the budget funds a rising bid that is never more than the budget can pay, a holder sells into it, the token locks in the vault, and leaves by auction or raffle."
            />
            <p className="story-legend small">
              <span>
                <i className="dot eth" /> ETH
              </span>
              <span>
                <i className="dot nft" /> a token
              </span>
              <span className="muted">An explainer model: the contracts' rules, example amounts (curve +10% a day, −15% after a sale, cap 1.5 ETH). Not the demo, not a chain.</span>
            </p>
            <p className="story-note small" role="status" aria-live="polite">
              {note}
            </p>
          </div>
        </div>
        <ol className="story-chapters">
          {CHAPTERS.map((c, i) => (
            <li
              key={c.id}
              data-index={i}
              ref={(node) => {
                chapters.current[i] = node;
              }}
              className={i === active ? "story-chapter on" : "story-chapter"}
            >
              <p className="story-kicker">{c.kicker}</p>
              <h3>{c.title}</h3>
              <p className="story-body">{c.body}</p>
              <div className="story-controls">{controls[i]}</div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- games

const GAMES: { path: string; name: string; fact: string; text: string; art: ReactNode }[] = [
  {
    path: "/play/dice",
    name: "Dice and coinflip",
    fact: "2% edge, half to buybacks",
    text: "Pick a chance from 1% to 95%. A win pays the stake divided by the chance. Expected return: minus 2% of the wager.",
    art: (
      <svg viewBox="0 0 120 80" aria-hidden="true">
        <g className="art-die">
          <rect x="38" y="18" width="44" height="44" rx="9" />
          <circle cx="50" cy="30" r="3.500" />
          <circle cx="70" cy="30" r="3.500" />
          <circle cx="60" cy="40" r="3.500" />
          <circle cx="50" cy="50" r="3.500" />
          <circle cx="70" cy="50" r="3.500" />
        </g>
      </svg>
    ),
  },
  {
    path: "/play/slots",
    name: "Slots",
    fact: "2% edge, half to buybacks",
    text: "One roll against a fixed table: 50× at 0.2%, 10× at 1%, 5× at 4%, 2× at 15%, 1× at 30%. About half of all spins pay nothing.",
    art: (
      <svg viewBox="0 0 120 80" aria-hidden="true">
        <g className="art-reels">
          <rect x="22" y="18" width="22" height="44" rx="5" />
          <rect x="49" y="18" width="22" height="44" rx="5" />
          <rect x="76" y="18" width="22" height="44" rx="5" />
          <path className="sym s1" d="M28 46 33 34l5 12Z" />
          <circle className="sym s2" cx="60" cy="40" r="6" />
          <path className="sym s3" d="M87 33l6 7-6 7-6-7Z" />
        </g>
        <line className="art-payline" x1="14" x2="106" y1="40" y2="40" />
      </svg>
    ),
  },
  {
    path: "/play/lottery",
    name: "Lottery",
    fact: "5% of the pot to buybacks",
    text: "A pooled pot per collection. When the round ends anyone can draw it; one random ticket wins the rest.",
    art: (
      <svg viewBox="0 0 120 80" aria-hidden="true">
        <g className="art-balls">
          <circle cx="42" cy="46" r="11" />
          <circle cx="62" cy="34" r="11" />
          <circle cx="80" cy="50" r="11" />
        </g>
      </svg>
    ),
  },
  {
    path: "/play/ticket-raffles",
    name: "Ticket raffles",
    fact: "5% of ticket revenue to buybacks",
    text: "Anyone raffles an NFT they own for paid tickets. If the minimum is not reached, every buyer can take a refund.",
    art: (
      <svg viewBox="0 0 120 80" aria-hidden="true">
        <g className="art-ticket">
          <path d="M26 24h68v10a6 6 0 0 0 0 12v10H26V46a6 6 0 0 0 0-12V24Z" />
          <line x1="72" x2="72" y1="26" y2="54" />
          <rect x="40" y="33" width="14" height="14" rx="3" />
        </g>
      </svg>
    ),
  },
  {
    path: "/play/predictions",
    name: "Predictions",
    fact: "3% of winnings to buybacks",
    text: "Pooled higher-or-lower bets on a collection's floor. Winners split the losing pool. A move of less than 2% voids the market and refunds everyone.",
    art: (
      <svg viewBox="0 0 120 80" aria-hidden="true">
        <line className="art-payline" x1="14" x2="106" y1="40" y2="40" />
        <path className="art-up" d="M40 36 52 18l12 18Z" />
        <path className="art-down" d="M58 44 70 62l12-18Z" />
      </svg>
    ),
  },
  {
    path: "/play/house",
    name: "The house",
    fact: "not a game, not a yield product",
    text: "Dice and slots are played against a bankroll anyone can fund for redeemable shares. Share holders can lose part or all of it when players win.",
    art: (
      <svg viewBox="0 0 120 80" aria-hidden="true">
        <g className="art-house">
          <rect x="30" y="26" width="60" height="30" rx="7" />
          <rect className="fill" x="34" y="30" width="34" height="22" rx="4" />
          <path d="M72 30v22M78 30v22M84 30v22" />
        </g>
      </svg>
    ),
  },
];

function Games() {
  return (
    <section className="lp-section lp-games" aria-labelledby="games-title">
      <header className="lp-section-head">
        <p className="eyebrow">Play</p>
        <h2 id="games-title">Games whose fee buys the floor.</h2>
        <p className="lede">
          The fee on every game becomes buyback budget for the collection the player backs, less any share set for the project.
          Every game has a negative expected return for the player. Each opens as a playable stage in the demo, on play money.
        </p>
      </header>
      <ul className="game-cards">
        {GAMES.map((game) => (
          <li key={game.path}>
            <a className="game-card" href={href(game.path)} onClick={launch(game.path)}>
              <span className="game-art">{game.art}</span>
              <span className="game-fact">{game.fact}</span>
              <strong>{game.name}</strong>
              <span className="game-text">{game.text}</span>
              <span className="game-go">{game.path === "/play/house" ? "See it in the demo" : "Play in the demo"}</span>
            </a>
          </li>
        ))}
      </ul>
      <p className="notice lp-notice" role="note">
        Games of chance, lotteries and paid raffles are regulated or prohibited in many places. Check the law that applies to you. Play only
        with what you can afford to lose.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- fairness

function FairnessStory() {
  return (
    <section className="lp-section lp-fair" aria-labelledby="fair-title">
      <header className="lp-section-head">
        <p className="eyebrow">Fairness</p>
        <h2 id="fair-title">One number in, one fixed rule, a payout you can recompute.</h2>
        <p className="lede">
          Every result follows the same four steps. Set a bet, draw a sample number and follow it through; it is the same
          arithmetic the contract runs.
        </p>
      </header>
      <FairnessWalk compact />
      <div className="lp-fair-foot">
        <p className="notice" role="note">
          "Provably fair" means only that the draw can be checked; it says nothing about the expected return, which is negative in
          every game. The contracts are written for Chainlink VRF, tested only against a simulated coordinator. The demo and local test
          chains use numbers that are not fair play, and the app says so on every game screen.
        </p>
        <a className="btn secondary" href={href("/fairness")}>
          The full fairness page
        </a>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- status

const PASSES = [
  ["Review 1", "All contracts at the time", "2 High, 3 Medium, 4 Low"],
  ["Review 2", "Games, project fee share, fixes from review 1", "2 Medium, 7 Low"],
  ["Review 3", "TicketRaffle, IPLicenseManager, deploy scripts", "1 High, 5 Medium, 7 Low"],
  ["Review 5", "Fixes from review 3 and the full-system audit; a fresh look at everything", "2 Medium, 8 Low"],
  ["Review 6", "Slots, Lottery, fixes from review 5, deploy scripts", "1 Medium, 4 Low"],
  ["Review 7", "Fixes from review 6; one randomised campaign across every contract at once", "2 Low; every invariant held"],
  ["Full-system audit", "Core contracts and how all modules interact", "1 High, 3 Medium, 6 Low"],
  ["Review 8", "The reworked buyback bid and the other changes made after the economics review", "2 Medium, 6 Low"],
  ["Economics review", "Whether the mechanism does what it claims, with models", "5 main findings"],
] as const;

const UNVERIFIED = [
  "Behaviour against a live Chainlink VRF coordinator.",
  "Any deployment on a public network.",
  "A real browser wallet in the web app.",
  "NFT contracts with transfer hooks, blocklists or other non-standard behaviour.",
  "The web app's own security: it has been tested for function, not reviewed for attacks.",
  "The fixes made after review 6: they have regression tests but no further independent pass.",
  "House shares in the games bankroll, and the fixes made after review 8 (the base rule for falling markets, the minimum bid, restarting the curve from the old budget): tests, but no independent review yet.",
];

function Status() {
  return (
    <section className="lp-section lp-status" aria-labelledby="status-title">
      <header className="lp-section-head">
        <p className="eyebrow">Status</p>
        <h2 id="status-title">Where this honestly stands.</h2>
      </header>
      <div className="status-heads">
        <div className="status-flag bad">
          <strong>Unaudited</strong>
          <span>No professional audit, no formal verification, no testnet soak. Do not use it with real funds.</span>
        </div>
        <div className="status-flag warn">
          <strong>Not deployed publicly</strong>
          <span>It runs on a local chain. A Base Sepolia deployment has been simulated, not broadcast.</span>
        </div>
        <div className="status-flag warn">
          <strong>The owner must be trusted</strong>
          <span>The owner can change fees, oracles, the randomness provider and the Treasury spender. It has to be a timelocked multisig before any real use.</span>
        </div>
        <div className="status-flag">
          <strong>No token, no promise</strong>
          <span>There is no governance token, no team wallet and no staking. Nothing here is an investment or a promise of a price.</span>
        </div>
      </div>
      <div className="status-board">
        <div className="status-col">
          <h3>What the automated reviews covered</h3>
          <p className="muted small">
            Carried out by AI agents in one working session on 13 October 2026, on code that was changing between passes. Findings were acted
            on or documented. This is not a professional audit.
          </p>
          <div className="table-wrap">
            <table className="status-table">
              <thead>
                <tr>
                  <th>Pass</th>
                  <th>Scope</th>
                  <th>Found</th>
                </tr>
              </thead>
              <tbody>
                {PASSES.map(([name, scope, result]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td className="wrap">{scope}</td>
                    <td className="wrap">{result}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Also: Slither static analysis with no actionable medium or high finding, and every write flow of the web app clicked through with a
            local test account. No Critical finding was reported in any pass; the four High findings were fixed with regression tests. Five
            Medium findings are accepted and documented rather than fixed. The economics review found the buying to be modest (about one token
            bought for every fifty traded) and led to the budget-limited bid. The contract test suite had 271 tests at the time of the record.
          </p>
        </div>
        <div className="status-col">
          <h3>What nobody has verified</h3>
          <ul className="unverified">
            {UNVERIFIED.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="muted small">
            Sources: <code>SECURITY.md</code> and <code>docs/AUDIT.md</code> in the repository, which also list the known limitations in full.
          </p>
        </div>
      </div>
    </section>
  );
}

export function Landing() {
  return (
    <div className="lp">
      <Hero />
      <Story />
      <FloorLine />
      <Games />
      <FairnessStory />
      <Status />
      <section className="lp-final">
        <div className="lp-final-line" aria-hidden="true" />
        <h2>See it run.</h2>
        <p className="lede">The whole protocol, simulated in your browser. No wallet, no chain, play money.</p>
        <button type="button" className="btn big" onClick={launch("/app")}>
          Launch the demo
        </button>
      </section>
    </div>
  );
}
