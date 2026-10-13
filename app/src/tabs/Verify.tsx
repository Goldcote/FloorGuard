// "Verify" views: recompute a settled result in the browser and compare it with what the contract did.
import { useState } from "react";
import type { Hash } from "viem";
import { useChainId, useChains } from "wagmi";
import { useProtocol, useRead } from "../hooks";
import { recomputeBet, splitPot } from "../lib/fairness";
import { bps, eth } from "../lib/format";
import { readBetProof, readDrawProof, readFairnessStatus, SLOTS_PAY_TABLE } from "../lib/reads";
import { Addr, Modal, Notice, QueryView } from "../ui";
import { LOGS_FROM_BLOCK } from "../wagmi";

/** A transaction hash: click to copy; linked to the chain's block explorer when it has one. */
export function TxHash({ hash, label }: { hash: Hash; label: string }) {
  const chainId = useChainId();
  const explorer = useChains().find((chain) => chain.id === chainId)?.blockExplorers?.default.url;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_200);
    } catch {
      // clipboard unavailable: the hash is still shown in full in the title
    }
  };
  return (
    <div className="tx-ref">
      <span className="muted small">{label}</span>
      <button type="button" className="addr" title={`${hash} (click to copy)`} onClick={copy}>
        {copied ? "Copied" : `${hash.slice(0, 12)}…${hash.slice(-8)}`}
      </button>
      {explorer && (
        <a className="small" href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer noopener">
          View on explorer
        </a>
      )}
    </div>
  );
}

function Match({ ok, children }: { ok: boolean; children: string }) {
  return (
    <p className={ok ? "verdict ok" : "verdict bad"} role="status">
      <strong>{ok ? "Match" : "MISMATCH"}</strong> {children}
    </p>
  );
}

function BetProofView({ requestId }: { requestId: bigint }) {
  const query = useRead(["betProof", requestId.toString()], (c, d) => readBetProof(c, d, requestId, LOGS_FROM_BLOCK));
  return (
    <QueryView query={query} lines={6}>
      {(proof) => {
        if (!proof) return <p className="muted">This bet is not settled, or its events could not be found.</p>;
        const r = recomputeBet(proof);
        const ok = r.payout === proof.paidPayout && r.fee === proof.paidFee;
        return (
          <div className="verify">
            <dl className="steps">
              <dt>Request</dt>
              <dd>#{proof.requestId.toString()}</dd>
              <dt>Wager</dt>
              <dd>{eth(proof.wager, 18)} ETH</dd>
              <dt>Game</dt>
              <dd>{proof.chanceBps === 0 ? "Slots" : `Dice, win if the roll is below ${proof.chanceBps} of 10000 (${bps(proof.chanceBps)})`}</dd>
              <dt>Edge on this bet</dt>
              <dd>
                {bps(proof.edgeBps)}{" "}
                <span className="muted small">
                  {proof.edgeSource === "stored" ? "(read from the bet's record just before it settled)" : "(implied by the fee paid; the node has no older state)"}
                </span>
              </dd>
              <dt>Roll</dt>
              <dd>{proof.roll}</dd>
            </dl>
            <ol className="calc">
              <li>
                fee = wager × edge ÷ 10000 = <strong>{eth(r.fee, 18)} ETH</strong>
              </li>
              <li>
                stake = wager − fee = <strong>{eth(r.stake, 18)} ETH</strong>
              </li>
              {r.kind === "dice" ? (
                <li>
                  {proof.roll} {r.won ? "<" : "≥"} {proof.chanceBps}, so the bet {r.won ? "wins" : "loses"}: payout ={" "}
                  {r.won ? `stake × 10000 ÷ ${proof.chanceBps}` : "0"} = <strong>{eth(r.payout, 18)} ETH</strong>
                </li>
              ) : (
                <li>
                  roll {proof.roll} falls in the {r.multiplier}× row: payout = stake × {r.multiplier} ={" "}
                  <strong>{eth(r.payout, 18)} ETH</strong>
                </li>
              )}
            </ol>
            {r.kind === "slots" && (
              <table className="pay-table compact">
                <tbody>
                  {SLOTS_PAY_TABLE.map((tier, i) => (
                    <tr key={tier.multiplier} className={i === r.tierIndex ? "hit" : undefined} aria-current={i === r.tierIndex ? "true" : undefined}>
                      <td>
                        rolls {i === 0 ? 0 : SLOTS_PAY_TABLE[i - 1].below} to {tier.below - 1}
                      </td>
                      <td>{tier.multiplier === 0 ? "nothing" : `${tier.multiplier}×`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <dl className="steps">
              <dt>Recomputed here</dt>
              <dd>
                payout {eth(r.payout, 18)} ETH, fee {eth(r.fee, 18)} ETH
              </dd>
              <dt>Paid by the contract</dt>
              <dd>
                payout {eth(proof.paidPayout, 18)} ETH, fee {eth(proof.paidFee, 18)} ETH
              </dd>
            </dl>
            <Match ok={ok}>{ok ? "The contract paid exactly what the roll implies." : "The contract's payout differs from the recomputation."}</Match>
            <TxHash hash={proof.settledTx} label="Settlement transaction (delivers the random number)" />
            <TxHash hash={proof.placedTx} label="Bet transaction" />
            <p className="muted small">
              This checks the arithmetic from the roll. Whether the roll itself was fair depends on the randomness
              provider: see the Fairness page.
            </p>
          </div>
        );
      }}
    </QueryView>
  );
}

function DrawProofView({ kind, id, ticketPrice, feeBps }: { kind: "lottery" | "ticketRaffle"; id: bigint; ticketPrice: bigint; feeBps: bigint }) {
  const query = useRead(["drawProof", kind, id.toString()], (c, d) => readDrawProof(c, d, kind, id, LOGS_FROM_BLOCK));
  return (
    <QueryView query={query} lines={5}>
      {(proof) => {
        if (!proof) return <p className="muted">No draw was found for this one.</p>;
        const ok = proof.winner.toLowerCase() === proof.ticketHolder.toLowerCase() && proof.ticket < BigInt(proof.ticketsSold);
        const split = splitPot(ticketPrice, proof.ticketsSold, feeBps);
        return (
          <div className="verify">
            <dl className="steps">
              <dt>Tickets sold</dt>
              <dd>{proof.ticketsSold} (numbered 0 to {proof.ticketsSold - 1})</dd>
              <dt>Winning ticket</dt>
              <dd>
                #{proof.ticket.toString()} <span className="muted small">= random number mod {proof.ticketsSold}</span>
              </dd>
              <dt>Held by (ownerOfTicket)</dt>
              <dd><Addr address={proof.ticketHolder} /></dd>
              <dt>Winner recorded</dt>
              <dd><Addr address={proof.winner} /></dd>
              <dt>Pot</dt>
              <dd>
                {eth(split.pot)} ETH: {eth(split.fee)} ETH fee ({bps(feeBps)}) to buybacks, {eth(split.rest)} ETH to the{" "}
                {kind === "lottery" ? "winner" : "raffle's creator"}
              </dd>
            </dl>
            <Match ok={ok}>{ok ? "The recorded winner held the winning ticket." : "The recorded winner did not hold the emitted ticket."}</Match>
            <TxHash hash={proof.drawTx} label="Draw transaction (delivers the random number)" />
            <p className="muted small">
              The draw is uniform over tickets. Whether the random number was fair depends on the randomness provider:
              see the Fairness page.
            </p>
          </div>
        );
      }}
    </QueryView>
  );
}

type VerifyTarget =
  | { kind: "bet"; requestId: bigint }
  | { kind: "lottery" | "ticketRaffle"; id: bigint; ticketPrice: bigint; feeBps: bigint };

export function VerifyButton(props: VerifyTarget) {
  const [open, setOpen] = useState(false);
  const title =
    props.kind === "bet" ? `Verify bet #${props.requestId}` : props.kind === "lottery" ? `Verify the draw of round #${props.id}` : `Verify the draw of raffle #${props.id}`;
  return (
    <>
      <button type="button" className="btn secondary small" onClick={() => setOpen(true)}>
        Verify
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={title}>
        {open && (props.kind === "bet" ? <BetProofView requestId={props.requestId} /> : <DrawProofView {...props} />)}
      </Modal>
    </>
  );
}

/** Shown on every game screen of a deployment whose randomness comes from the local mock. */
export function RandomnessNotice() {
  const { demo, deployment } = useProtocol();
  const status = useRead(["fairness"], readFairnessStatus, !!deployment);
  if (demo) return <Notice>Demo: results come from a pseudo-random generator in your browser. Play money, not fair play.</Notice>;
  if (!status.data?.anyMock) return null;
  return <Notice>Local mock randomness: whoever settles picks the number. Not fair, for testing only.</Notice>;
}
