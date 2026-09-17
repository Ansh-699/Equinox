# StockStream Roadmap — Priority 9–14

Status: **Planning document.** No item below is implemented or verified.
This roadmap extends the existing Priority 1–8 structure
(`docs/stockstream-build-record.md`, `docs/stockstream-devnet-release-gate.md`)
with the next six priorities, ordered by architectural dependency and
risk retirement. Each phase has an explicit exit criterion; do not start a
phase before the previous phase's exit holds. Research facts cited here were
verified against official provider documentation on 2026-09-17.

Guiding constraint: every phase must leave the repository in a state where
the documentation's claims remain true. No phase changes the three-plane
boundary model (`stockstream-architecture-v2.md` §5.2) or the risk plane's
Pyth-only oracle rule.

---

## Priority 9 — Runtime proof (critical path for everything)

Close the documented SBPF toolchain mismatch (`docs/sbpf-compatibility.md`):
run `scripts/install-stockstream-toolchain.sh` (pinned Anza Agave 4.2.1),
rebuild the SBF artifact with `--features bpf-entrypoint` (omitting it
silently produces a ~1.3 KB stub with no entrypoint), and execute the
serialized runtime harness (`.github/workflows/stockstream-runtime.yml`).
Additionally test whether the MagicBlock local stack's bundled runtime
(`@magicblock-labs/ephemeral-validator`) accepts the current SBPF v4
artifact — a positive result is an alternative Gate 2 resolution.

**Exit:** the `.so` executes on a real SVM runtime; first live
compute-unit measurements exist for representative instructions
(place/cancel/match, `consume_oracle_update`, custody transfers).

## Priority 10 — Live delegation and fee-payer economics

Deploy to devnet (`docs/devnet-configuration.md`) and run the full
delegation lifecycle: initialize → `delegate_market` → trade on the ER →
periodic commits → `commit_and_undelegate` → withdrawals unblocked →
**byte-for-byte comparison of the final account against the pre-delegation
layout expectations**. Known frictions to validate: Magic Router
`getBlockhashForAccounts` (ER/L1 blockhash split), the 222 KB account
cloning to the ER, and the Worker `execution-status` model against observed
reality.

Wire the delegated fee payer + the ER validator's `magic_fee_vault` from
the start and size the delegation deposit for the planned session length:
the verified fee model (`docs/magicblock.md` §"Verified ER runtime limits
and commit economics") charges both a live per-commit fee from commit 26
onward *and* a per-commit deposit charge settled at undelegation. Per-market
commit policy is a **program change required before long-lived delegation**
(see `docs/magicblock.md` § Commit policy — the 30,000 ms value is a
delegation argument, so the Worker cannot slow it down); if that change is
not made in time, limit session length instead.

**Delegated hot cluster (exit requirement, not future work):** active
settlement scratch PDAs must be delegated together with the market account
(and the delegated fee payer) as one hot cluster — an ER transaction cannot
write the delegated market account and an L1-resident non-delegated scratch
PDA (mixed writable domains). The program's
`require_scratch_accounts_empty` gate already enforces Empty-scratch at
delegation/commit/undelegation boundaries (`docs/magicblock.md`). The
ER-native ephemeral-account alternative for scratch is unproven and not
selected.

Measure every latency stage of `stockstream-architecture-v2.md` §23.4:
browser construct, signing, router submission, ER acceptance, matching, UI
update, L1 commit request, L1 commit confirmation — plus commit cost per
commit. **Claimed numbers are forbidden; measured numbers with sample
counts are the deliverable.**

**Exit:** one market delegated, trading, committing, restoring, with a
recorded latency/cost table, and:

- the scratch account is delegated (or replaced by an ER-native account),
- a crossing order executes through the production settlement path on the
  ER (scratch Empty→Planning→Ready→Empty inside the instruction),
- no mixed writable-account routing occurs in any submitted transaction,
- market and scratch lifecycles restore safely (byte-verified market state;
  scratch Empty or closed per policy).

## Priority 11 — ER demo core (make the thesis visible)

- AAPL-PERP on a delegated ER; two traders plus the designated demo market
  maker (identified per §16 of the architecture).
- Order burst: place / cancel / cancel-all / replace / IOC / post-only.
- Latency HUD: signing, router, ER-accept, match-to-UI, L1-commit; p50,
  p95, failure rate, sample count; benchmark bar against a ~400 ms L1 slot.
- Two-clock display: ER acceptance sequence vs L1 commit sequence, from
  `GET /v1/markets/:symbol/execution-status`; commit-pending event count.
- Pegged-book scene: Pyth ticks reprice pegged quotes without per-order
  transactions (the oracle-update path changes *effective* prices; no node
  rewrites are implied).

**Exit:** the ER-speed thesis is a measured, screen-visible fact (or an
honestly measured different number, reported with the same HUD).

## Priority 12 — Pyth Pro live integration

Acquire `PYTH_PRO_API_KEY` and follow `docs/pyth-ops.md`:
feed discovery (confirm the AAPL / AAPLx / AAPLON feed IDs and their
`min_channel`), three-endpoint subscription with `ignoreInvalidFeeds: true`,
JWT-minted frontend auth (raw keys are server-side only by Pyth ToS), real
signed payload → Ed25519 → `consume_oracle_update` end to end, session/
status mode transitions visible in the UI, dual-feed basis panel
(underlying equity feed authoritative for risk; tokenized-stock feeds for
display, basis, hedge warnings only — never liquidation pricing by default).

**Exit:** the risk engine runs on live verified Pyth data; basis and
session surfaces are demonstrable; one market may flip `live: true` when
mint, feed, and deployment are all verified (per `docs/market-registry.md`).

## Priority 13 — One-click hedge (core product)

The consumer wedge, deliberately kept separate from any sponsor lane — the
core product must be complete without the Launch Lab: detect a supported
tokenized-stock holding, show spot exposure / existing perp exposure / net
exposure, offer 25/50/100% hedge, display basis divergence, required
margin, estimated liquidation price, and funding before signature; execute
the short on the ER and update net exposure.

**Exit:** hedge flow demonstrated end to end on the delegated ER market
with measured latency and the basis warning surfaced from live
(or fixture, if the key is still pending) Pyth data.

## Priority 14 — MagicBlock-native extensions and PER spike

**14a. Crank (one, bounded).** Target a 5–10-second bounded
expired/invalid-order cleanup crank on the delegated market, **subject to
measured crank granularity, reliability, and cost** — scheduling cadence,
retry behavior, fee economics, and the Pinocchio-compatible instruction
format all require runtime proof before this claim is firmed up. Cloudflare
keepers retain Pyth ingestion, L1 confirmation, reconciliation, dead
letters, keeper health, holiday calendar, and emergency fallback.

**14b. SettlementCheckpoint Magic Action (one).** Post-commit L1 write of
the committed market sequence + timestamp to a `SettlementCheckpoint` PDA —
verifiable commit evidence, cleaner withdrawal readiness, two-clock UI
support. The first Magic Action must **not** move user funds; withdrawals
remain explicit L1 instructions gated by `l1_withdrawals_allowed()`.

**14c. PER spike (one day, pass/fail, before any Block Venue build).**
MagicBlock Private Ephemeral Rollup (TEE/Intel TDX) probe, local-first via
the Query Filtering Service (`mb-stack`), with an official Pinocchio
private-counter reference implementation. Pass conditions — all required:
1. ACL permission CPIs hand-encodable in this program's `no_std`
   Pinocchio style (license and wire format verified against
   `ephemeral-rollups-pinocchio`).
2. Non-member RPC reads blocked at the QFS/TEE ingress.
3. Privy wallet obtains a TEE authorization token (wallet-signed
   challenge; TDX RPC-integrity check on devnet/mainnet).
4. Keeper signer roles can access the private market as members.
5. TEE-ER latency measured and acceptable.
6. **L1 commit semantics for private accounts empirically established:**
   what exact bytes land on L1 at commit (plaintext, redacted, encrypted,
   or commitment-only), who can read committed state, whether logs/
   account-history expose prior snapshots, and what undelegation publishes.
   Until then, the conservative interpretation applies: committed private
   state must be assumed publicly readable on L1.
7. Event-leakage behavior understood (does `sol_log_data` output survive
   ingress filtering; what surfaces at commit).

Any failure ⇒ PER is recorded as researched roadmap with **no** privacy
claim. On full pass: a "Confidential Block Venue" may be built.

**Liquidation model correction (2026-09-17):** an earlier version said
"liquidations remain permissionless and public" for the confidential
venue. That was wrong. The hot state — book, seats, positions — is one
market account; if that account is private, an arbitrary public liquidator
cannot read eligibility or submit against it. The honest models are:

- **Confidential Block Venue (recommended for the spike):** enrolled
  traders, enrolled market maker, **enrolled protocol liquidation
  keepers**, enrolled oracle/maintenance keepers; confidential live
  positions; **keeper-operated liquidation**. This is not fully
  permissionless liquidation.
- Preserving public permissionless liquidation would require architectural
  surgery (public risk-summary accounts, public eligibility proofs, or
  splitting private order state from public position/risk state, possibly
  proof-based eligibility) — incompatible with the current single-account
  design and not attempted.

So: **the public venue retains permissionless liquidation; the
confidential venue initially uses enrolled liquidation keepers** because
its private market account cannot be read by arbitrary non-members.
Naming rule: never "dark pool" — the honest claim is "intra-ER
confidentiality with delayed L1 state publication," never persistent
privacy.

**PER event-privacy test matrix** (to fill during the spike):

| Surface | Public venue | Confidential venue |
| --- | --- | --- |
| Order submission | Public ER | Member-only |
| Book account | Public | Member-only during ER |
| Fill logs | Public | Member-only during ER |
| Position | Public account state | Member-only during ER |
| L1 committed bytes | Public | **Unknown until tested** |
| Undelegated bytes | Public | Presumed public |
| Aggregate metrics | Public | Optional delayed publication |

**14d. Commit-policy field (optional protocol change).** A per-market
commit-policy field set (`commit_policy_version`,
`periodic_commit_interval_ms`, `max_uncommitted_events`,
`max_uncommitted_open_interest_delta`, `immediate_commit_flags`) is a
candidate for the 30 free `reserved_upgrade` bytes (`155..185`,
`docs/program-layout.md`), gated on `MARKET_VERSION` discipline (no size
change; version-gated reinterpretation only). Required **before**
long-lived delegation if low-activity markets are to exist at all (see
`docs/magicblock.md` § Commit policy).

## Priority 15 — Meteora DBC Launch Lab (sponsor lane, only if 13 holds)

The pre-designed lane (`stockstream-architecture-v2.md` §20): DBC
TypeScript SDK service (already pinned at 1.5.12), issuer templates,
curve/fee/graduation preview, devnet pool creation with a real
wallet-signed transaction, pool monitor (curve progress, fees,
graduation), DAMM v2 migration status (Manual Migrator covers devnet;
mainnet keepers migrate stock-token quote pairs at ≥ 750 USD-equivalent).
The DBC program ID is identical on mainnet and devnet. **Boundary:**
DBC/DAMM values are launch/liquidity analytics only and may never reach
perps margin, funding, index, or liquidation state. A DBC-launched token
is never described as a share absent an authorized issuer and backing
process.

**Exit:** a real pool signature, a live monitor, graduation observed on
devnet.

## Priority 16 — PreStocks / Tessera discovery panel

One shared read-model panel: PreStocks API (mark/token price, implied
valuation, supply, contract addresses) and Tessera public token-details
API (mark price, holders, mark valuation) plus Tessera T-Token Meteora
pool monitoring in the Launch Lab monitor. Hard rules: no risk-plane
integration, no custody of Token-2022 transfer-fee/hook assets (custody
config is legacy-SPL-only by design), no PreStocks/Tessera perp markets
absent a signed risk oracle and a legally coherent market specification,
no reserve-attestation data treated as a market-price oracle, Tessera's
own framing ("loan participation rights, not securities") quoted
verbatim, transfer-fee and redemption warnings displayed.

## Priority 17 — Clawpump agent lane (conditional)

**No-go until directly confirmed.** The bounty requirement is a
conjunction — launch with a stock-paired liquidity pool *using Clawpump
and Meteora* — and no public documentation confirms Clawpump's launch
surface creates Meteora stock-paired pools (documented built-in targets:
pump.fun, Metaplex Genesis, Pons). Resolution path: ask Clawpump which
API/MCP method satisfies the requirement, whether it creates the Meteora
pool itself, which stock quote mints are supported, whether a non-Meteora
pair counts, whether devnet is accepted, and what transaction evidence
judges expect. Until then, the Launch Lab shows the agent lane as
capability-pending per the §20.2 capability gate. If later confirmed:
owner-Privy-signed launches, agent prepares/monitors/reports only,
spending cap + revocation, and no agent access to trading sessions,
vault authority, withdrawals, or market configuration — ever.

---

## Dependency graph

```
P9 runtime proof ──► P10 delegation + hot cluster + fee payer ──► P11 ER demo core
                                                                       │
                              P12 Pyth live ◄─────────────────────────┤
                                     │                                │
                                     ▼                                ▼
                              P13 one-click hedge                (parallel)
                                     │
              ┌──────────────────────┼───────────────────────┐
              ▼                      ▼                       ▼
     P14 crank + checkpoint   P14 PER spike          P15 Launch Lab ──► P16 discovery
     (MB-native, bounded)     (gated on P10)         (sponsor lane)          panel

P17 Clawpump: gated on external confirmation only, not on engineering
```

## Explicit non-goals (unchanged)

Five products from one project; "dark pool" or "trustless privacy" claims;
DBC/DAMM prices in any risk path; T-Token custody; PreStocks/Tessera
perp markets; automated post-commit withdrawals; unconfirmed Clawpump
integration; matcher changes for MEV research; cross-margin;
multi-collateral; RFQ; autonomous agent trading.