"use client";

import {useState} from "react";
import {keccak256, stringToHex, toHex, type Address} from "viem";
import {useAccount, useWriteContract} from "wagmi";

import {OperatorCard} from "./Card";
import {contractAddresses, isDeployed} from "@/lib/addresses";
import {C, F} from "@/lib/tokens";

/// Operator action panel (spec §47.4). Currently wires the two on-chain operator
/// actions that exist as typed contract functions today:
///   - addTickerToBlocklist  (FilterLauncher)
///   - disableCreatorFee     (CreatorFeeDistributor) — multisig-callable
/// Recovery / governance actions that don't yet have an on-chain counterpart
/// (force scheduler tick, republish Merkle, manual refund sweep, force HP
/// recompute, toggle feature flags, weight-change workflow) render placeholders
/// linking to the operator runbook entry per spec §47.6 — those are CI/scheduler
/// actions, not contract calls, and the operator console tracks them via the
/// audit log rather than initiating them in-browser.

const FILTER_LAUNCHER_ADD_TICKER_ABI = [
  {
    type: "function",
    name: "addTickerToBlocklist",
    inputs: [{name: "tickerHash", type: "bytes32"}],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const CREATOR_FEE_DISTRIBUTOR_DISABLE_ABI = [
  {
    type: "function",
    name: "disableCreatorFee",
    inputs: [
      {name: "token", type: "address"},
      {name: "reason", type: "string"},
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

function readCreatorFeeDistributorAddress(): Address | null {
  if (!isDeployed("creatorFeeDistributor")) return null;
  return contractAddresses.creatorFeeDistributor;
}

export function ActionsPanel() {
  return (
    <div>
      <OperatorCard label="Recovery" sublabel="spec §47.4.1" accent={C.yellow}>
        <PlaceholderAction
          name="Force scheduler tick"
          why="Manually fires the next phase-boundary tick. Use only when the scheduler is genuinely stuck — re-runs are idempotent but can fire downstream filter events twice if the scheduler self-recovered concurrently."
        />
        <PlaceholderAction
          name="Republish Merkle root"
          why="Re-runs oracle Merkle generation + IPFS pin + on-chain post for a specified season + round (CUT or FINALIZE). Used if pin propagation failed or RPC errored mid-publish."
        />
        <PlaceholderAction
          name="Manual refund sweep"
          why="Calls LaunchEscrow.refund(creator) for any reservation flagged stuck post-abort. Per-creator, with confirmation."
        />
        <PlaceholderAction
          name="Force HP recompute"
          why="Triggers scoring/.computeHP() + writes a fresh hpSnapshot row. Diagnostic only — the snapshot writer normally drives this on its own cadence."
        />
      </OperatorCard>

      <OperatorCard label="Governance" sublabel="spec §47.4.2" accent={C.pink}>
        <AddTickerToBlocklistForm />
        <DisableCreatorFeeForm />
        <PlaceholderAction
          name="Toggle HP_MOMENTUM_ENABLED / HP_CONCENTRATION_ENABLED"
          why="Flips a runtime feature flag. Implementation is a CI/CD action (commits a config change to the repo + opens a deployment PR). Track the trigger via this console; the actual flip happens in the deploy."
        />
      </OperatorCard>

      <OperatorCard label="Weights" sublabel="spec §47.4.3" accent={C.cyan}>
        <PlaceholderAction
          name="Stage a weight change"
          why="Input: 5 component weights + new HP_WEIGHTS_VERSION. Validation: weights sum to 1.0 and are non-negative. Queues a 7-day timer; activate-eligible at expiry."
        />
        <PlaceholderAction
          name="Generate public-notice draft"
          why="Auto-drafts the X post + docs.filter.fun/changelog entry copy. Operator reviews + posts manually. No auto-publish (spec §47.4.4)."
        />
        <PlaceholderAction
          name="Activate weight change"
          why="Once the 7-day timer elapses, single click to bump scoring/ config + trigger redeploy."
        />
      </OperatorCard>

      <OperatorCard label="Comms helpers" sublabel="spec §47.4.4" accent={C.green}>
        <SeasonRecapBuilder />
        <AbortCommsBuilder />
      </OperatorCard>
    </div>
  );
}

// ============================================================ Add ticker to blocklist

function AddTickerToBlocklistForm() {
  const {address, isConnected} = useAccount();
  const {writeContractAsync, isPending, error: txError} = useWriteContract();
  const [ticker, setTicker] = useState("");
  const [confirm, setConfirm] = useState(false);

  const launcherAddr = contractAddresses.filterLauncher;
  const launcherDeployed = isDeployed("filterLauncher");

  // Canonical normalisation matches FilterLauncher's TickerLib.normalize: trim,
  // upper-case, no leading $. Intentionally minimal here — the launch-form
  // pre-flight check at /season/:id/tickers/check is the authoritative validator.
  const canonical = ticker.trim().toUpperCase().replace(/^\$/, "");
  const tickerHash = canonical
    ? keccak256(stringToHex(canonical))
    : ("0x" + "0".repeat(64) as `0x${string}`);

  async function submit() {
    if (!isConnected || !address || !canonical) return;
    await writeContractAsync({
      abi: FILTER_LAUNCHER_ADD_TICKER_ABI,
      address: launcherAddr,
      functionName: "addTickerToBlocklist",
      args: [tickerHash],
    });
    setTicker("");
    setConfirm(false);
  }

  return (
    <ActionRow
      title="Add ticker to blocklist"
      detail={`FilterLauncher.addTickerToBlocklist(bytes32). Multisig-only on-chain in v1.`}
    >
      <input
        type="text"
        value={ticker}
        onChange={(e) => {
          setTicker(e.target.value);
          setConfirm(false);
        }}
        placeholder="ticker (e.g. SCAM)"
        style={inputStyle}
      />
      {canonical && (
        <div style={{fontFamily: F.mono, fontSize: 11, color: C.faint, marginTop: 4}}>
          canonical: <span style={{color: C.text}}>{canonical}</span> · hash: {tickerHash.slice(0, 18)}…
        </div>
      )}
      <div style={{display: "flex", gap: 8, marginTop: 8}}>
        {!confirm ? (
          <button
            type="button"
            onClick={() => setConfirm(true)}
            disabled={!launcherDeployed || !canonical}
            style={btnStyle(C.pink, !launcherDeployed || !canonical)}
          >
            Review tx
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setConfirm(false)}
              style={btnStyle(C.faint, false)}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={isPending}
              style={btnStyle(C.red, isPending)}
            >
              {isPending ? "Submitting…" : "Confirm + submit"}
            </button>
          </>
        )}
      </div>
      {txError && (
        <p style={{margin: "8px 0 0", fontSize: 12, color: C.red, fontFamily: F.mono}}>
          {txError.message}
        </p>
      )}
    </ActionRow>
  );
}

// ============================================================ Disable creator fee

function DisableCreatorFeeForm() {
  const {address, isConnected} = useAccount();
  const {writeContractAsync, isPending, error: txError} = useWriteContract();
  const [token, setToken] = useState("");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);

  const cfdAddr = readCreatorFeeDistributorAddress();
  const ready = !!cfdAddr && token.startsWith("0x") && token.length === 42 && reason.length > 0;

  async function submit() {
    if (!isConnected || !address || !cfdAddr || !ready) return;
    await writeContractAsync({
      abi: CREATOR_FEE_DISTRIBUTOR_DISABLE_ABI,
      address: cfdAddr,
      functionName: "disableCreatorFee",
      args: [token as Address, reason],
    });
    setToken("");
    setReason("");
    setConfirm(false);
  }

  return (
    <ActionRow
      title="Disable creator fee"
      detail="CreatorFeeDistributor.disableCreatorFee(token, reason). Reserved for sanctioned / compromised recipient cases per spec §10.6. Reason is logged on-chain via OperatorActionEmitted."
    >
      <input
        type="text"
        value={token}
        onChange={(e) => {
          setToken(e.target.value);
          setConfirm(false);
        }}
        placeholder="token address (0x…)"
        style={inputStyle}
      />
      <textarea
        value={reason}
        onChange={(e) => {
          setReason(e.target.value);
          setConfirm(false);
        }}
        placeholder="reason (free text, logged on-chain — required)"
        rows={2}
        style={{...inputStyle, marginTop: 6, resize: "vertical"}}
      />
      <div style={{display: "flex", gap: 8, marginTop: 8}}>
        {!confirm ? (
          <button
            type="button"
            onClick={() => setConfirm(true)}
            disabled={!ready}
            style={btnStyle(C.pink, !ready)}
          >
            Review tx
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setConfirm(false)}
              style={btnStyle(C.faint, false)}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={isPending}
              style={btnStyle(C.red, isPending)}
            >
              {isPending ? "Submitting…" : "Confirm + submit"}
            </button>
          </>
        )}
      </div>
      {!cfdAddr && (
        <p style={{margin: "8px 0 0", fontSize: 12, color: C.faint, fontFamily: F.mono}}>
          CreatorFeeDistributor not deployed — sync the deploy manifest first.
        </p>
      )}
      {txError && (
        <p style={{margin: "8px 0 0", fontSize: 12, color: C.red, fontFamily: F.mono}}>
          {txError.message}
        </p>
      )}
    </ActionRow>
  );
}

// ============================================================ Comms helpers

function SeasonRecapBuilder() {
  const [seasonId, setSeasonId] = useState("");
  const [draft, setDraft] = useState<string | null>(null);

  function build() {
    if (!seasonId) return;
    const md = [
      `# Season ${seasonId} — recap`,
      "",
      `**Phase end:** _fill in_`,
      `**Winner:** _fill in (ticker + address)_`,
      `**Filter Fund:** _fill in_ WETH`,
      `**Tokens filtered:** _fill in_ / 12`,
      `**Rollover claims:** _fill in_`,
      "",
      "## What happened",
      "",
      "_2-3 sentence narrative of the cohort's arc — early lead, mid-week shifts, finals._",
      "",
      "## Numbers",
      "",
      "- Volume: _fill in_",
      "- Holder count peak: _fill in_",
      "- Top creator: _fill in_",
      "",
      "Drafted by the operator console — review + post manually to X / Farcaster.",
    ].join("\n");
    setDraft(md);
  }

  return (
    <ActionRow
      title="Generate season recap (markdown)"
      detail="Auto-builds a markdown summary of last week's season ready to paste into X / Farcaster. No auto-publish (spec §47.4.4)."
    >
      <input
        type="text"
        value={seasonId}
        onChange={(e) => setSeasonId(e.target.value)}
        placeholder="season id"
        style={inputStyle}
      />
      <button
        type="button"
        onClick={build}
        disabled={!seasonId}
        style={{...btnStyle(C.cyan, !seasonId), marginTop: 8}}
      >
        Build recap
      </button>
      {draft && <DraftPreview value={draft} onChange={setDraft} />}
    </ActionRow>
  );
}

function AbortCommsBuilder() {
  const [seasonId, setSeasonId] = useState("");
  const [refunded, setRefunded] = useState("");
  const [draft, setDraft] = useState<string | null>(null);

  function build() {
    if (!seasonId) return;
    const md = [
      `Season ${seasonId} aborted — sparse week.`,
      "",
      `Threshold: 4 reservations. Actual: _fill in_.`,
      `Refunds processed: ${refunded || "_fill in_"} creators, ${refunded ? `${refunded} × baseLaunchCost` : "_fill in_"} WETH returned.`,
      "",
      `Why: not enough creators reserved a slot in the 48h launch window. Refunds went out automatically — no creator action needed.`,
      "",
      `Next season starts at the next h168 anchor.`,
      "",
      `Drafted by the operator console — review + post manually.`,
    ].join("\n");
    setDraft(md);
  }

  return (
    <ActionRow
      title="Generate abort comms (markdown)"
      detail="For sparse-week aborts. Templated X copy with refund stats. No auto-publish."
    >
      <div style={{display: "flex", gap: 8}}>
        <input
          type="text"
          value={seasonId}
          onChange={(e) => setSeasonId(e.target.value)}
          placeholder="season id"
          style={{...inputStyle, flex: 1}}
        />
        <input
          type="text"
          value={refunded}
          onChange={(e) => setRefunded(e.target.value)}
          placeholder="# refunded creators"
          style={{...inputStyle, flex: 1}}
        />
      </div>
      <button
        type="button"
        onClick={build}
        disabled={!seasonId}
        style={{...btnStyle(C.cyan, !seasonId), marginTop: 8}}
      >
        Build copy
      </button>
      {draft && <DraftPreview value={draft} onChange={setDraft} />}
    </ActionRow>
  );
}

// ============================================================ shared subcomponents

function PlaceholderAction({name, why}: {name: string; why: string}) {
  return (
    <div
      style={{
        padding: "8px 0",
        borderBottom: `1px solid ${C.lineSoft}`,
      }}
    >
      <div style={{fontFamily: F.display, fontSize: 13, fontWeight: 700, color: C.text}}>
        {name}
        <span style={{marginLeft: 8, fontSize: 11, color: C.faint, fontWeight: 400, fontFamily: F.mono}}>
          (cli-only — see runbook)
        </span>
      </div>
      <p style={{margin: "4px 0 0", fontSize: 12, color: C.dim, fontFamily: F.display, lineHeight: 1.5}}>
        {why}
      </p>
    </div>
  );
}

function ActionRow({title, detail, children}: {title: string; detail: string; children: React.ReactNode}) {
  return (
    <div style={{padding: "10px 0", borderBottom: `1px solid ${C.lineSoft}`}}>
      <div style={{fontFamily: F.display, fontSize: 13, fontWeight: 700, color: C.text}}>{title}</div>
      <p style={{margin: "4px 0 8px", fontSize: 12, color: C.dim, fontFamily: F.display, lineHeight: 1.5}}>
        {detail}
      </p>
      {children}
    </div>
  );
}

function DraftPreview({value, onChange}: {value: string; onChange: (s: string | null) => void}) {
  return (
    <div style={{marginTop: 10}}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        style={{
          ...inputStyle,
          fontFamily: F.mono,
          fontSize: 12,
          minHeight: 200,
          width: "100%",
          resize: "vertical",
        }}
      />
      <button
        type="button"
        onClick={() => navigator.clipboard?.writeText(value)}
        style={{...btnStyle(C.green, false), marginTop: 6}}
      >
        Copy to clipboard
      </button>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: `1px solid ${C.line}`,
  borderRadius: 6,
  padding: "8px 10px",
  color: C.text,
  fontFamily: F.mono,
  fontSize: 12,
  width: "100%",
  boxSizing: "border-box",
};

function btnStyle(tone: string, disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? "rgba(255,255,255,0.04)" : `${tone}22`,
    border: `1px solid ${disabled ? C.line : tone}66`,
    color: disabled ? C.faint : tone,
    padding: "8px 14px",
    borderRadius: 6,
    fontFamily: F.display,
    fontWeight: 700,
    fontSize: 12,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

// Reference unused helpers so they don't get tree-shaken; placeholder for future
// per-action gas-estimate readouts (spec §47.4 confirmation modal).
void toHex;
