#!/usr/bin/env node
/**
 * Read-only Devnet state inventory (no transactions, no fees, no secrets).
 * Probes every known account and records: address, owner, lamports, data
 * length, initialized/delegation state, reusability, and the expected next
 * lifecycle action. The result is merged into the resumable checkpoint
 * manifest (default /tmp/opencode/lifecycle-state.json) as `manifest`.
 */
import fs from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

const RPC = "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const PROGRAM_ID = new PublicKey("H3UogXdaamHi4Ga9ZzrZNNttCRpasZgarexVyNTZvGET");
const PROGRAMDATA = new PublicKey("GCLwk9aFz8cz4etHv4cibqSwaKBa2ubQUgPRhRiHqTP2");
const DELEGATION_PROGRAM = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const BPF_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const statePath = process.argv[2] ?? "/tmp/opencode/lifecycle-state.json";
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};

const authority = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8"))),
);

async function inspect(label, address, expected) {
  const entry = {
    label,
    address: address ? new PublicKey(address).toBase58() : null,
    exists: false,
    owner: null,
    lamports: 0,
    dataLen: 0,
    initialized: null,
    delegationStatus: null,
    reusable: false,
    recreate: address !== null,
    nextAction: "probe",
    ...expected,
  };
  if (address) {
    const info = await conn.getAccountInfo(new PublicKey(address));
    if (info) {
      entry.exists = true;
      entry.owner = info.owner.toBase58();
      entry.lamports = info.lamports / LAMPORTS_PER_SOL;
      entry.dataLen = info.data.length;
      entry.reusable = entry.reusableOverride ?? true;
      entry.recreate = false;
      if (entry.owner === PROGRAM_ID.toBase58() && info.data.length > 330) {
        entry.initialized = info.data.readUInt8(10) === 1;
        entry.delegationStatus = ["NotDelegated", "Delegated", "Undelegating", "Restored"][info.data[327 + 2]] ?? `raw ${info.data[327 + 2]}`;
      }
    }
  }
  delete entry.reusableOverride;
  return entry;
}

const manifest = [];
const push = async (label, address, expected) => manifest.push(await inspect(label, address, expected));

// Program + ProgramData
{
  const info = await conn.getAccountInfo(PROGRAM_ID);
  manifest.push({
    label: "program", address: PROGRAM_ID.toBase58(), exists: info !== null,
    owner: info?.owner.toBase58() ?? null, lamports: (info?.lamports ?? 0) / LAMPORTS_PER_SOL,
    dataLen: info?.data.length ?? 0, executable: info?.executable ?? false,
    reusable: info?.owner.toBase58() === BPF_LOADER && info?.executable === true,
    recreate: false, nextAction: info?.executable ? "none (infrastructure)" : "re-deploy",
  });
  const pd = await conn.getAccountInfo(PROGRAMDATA);
  manifest.push({
    label: "programdata", address: PROGRAMDATA.toBase58(), exists: pd !== null,
    owner: pd?.owner.toBase58() ?? null, lamports: (pd?.lamports ?? 0) / LAMPORTS_PER_SOL,
    dataLen: pd?.data.length ?? 0, reusable: pd !== null, recreate: false,
    nextAction: "upgrade when funded (deployed ELF sha 23b6922b… != local eb7e4a91…)",
  });
}

// Registry / lifecycle accounts (addresses from the checkpoint manifest)
const known = [
  ["exchange", state.exchange, {}],
  ["instrument", state.instrument, {}],
  ["market", state.market, { reusableOverride: true, reusable: false }],
  ["mint", state.mint, { owner: TOKEN_PROGRAM }],
  ["sessionA", state.sessionA, {}],
  ["sessionB", state.sessionB, {}],
];
for (const [label, address, extra] of known) {
  if (!address) {
    manifest.push({ label, address: null, exists: false, reusable: false, recreate: true, nextAction: `re-run the lifecycle stage that creates the ${label}` });
    continue;
  }
  const info = await conn.getAccountInfo(pk(address));
  const entry = {
    label, address, exists: info !== null, owner: info?.owner.toBase58() ?? null,
    lamports: (info?.lamports ?? 0) / LAMPORTS_PER_SOL, dataLen: info?.data.length ?? 0,
    initialized: info && info.owner.toBase58() === PROGRAM_ID.toBase58() && info.data.length > 330
      ? info.data.readUInt8(10) === 1 : undefined,
    delegationStatus: info && info.owner.toBase58() === PROGRAM_ID.toBase58() && info.data.length > 330
      ? (["NotDelegated", "Delegated", "Undelegating", "Restored"][info.data[327 + 2]] ?? `raw ${info.data[327 + 2]}`) : undefined,
    reusable: info !== null, recreate: info === null,
    nextAction: info ? "reuse (rent already paid)" : `recreate ${label}`,
    ...extra,
  };
  manifest.push(entry);
}

// Derived-but-not-yet-created members (scratch, sessions) from the last
// known instrument/market; only meaningful when the market exists.
if (state.market) {
  const market = new PublicKey(state.market);
  for (const seat of [0, 1]) {
    const scratch = PublicKey.findProgramAddressSync(
      [Buffer.from("settlement"), market.toBuffer(), Buffer.from([seat, 0])], PROGRAM_ID)[0];
    const info = await conn.getAccountInfo(scratch);
    manifest.push({
      label: `scratch${seat}`, address: scratch.toBase58(), exists: info !== null,
      owner: info?.owner.toBase58() ?? null, dataLen: info?.data.length ?? 0,
      reusable: info !== null && info.owner.toBase58() === PROGRAM_ID.toBase58(),
      recreate: info === null, nextAction: info ? "delegate (fund-gated)" : "create + initialize (fund-gated)",
    });
  }
  // delegation records for the market
  for (const tag of ["delegation", "delegation-metadata"]) {
    const record = PublicKey.findProgramAddressSync(
      [Buffer.from(tag), market.toBuffer()], new PublicKey(DELEGATION_PROGRAM))[0];
    const info = await conn.getAccountInfo(record);
    manifest.push({
      label: tag, address: record.toBase58(), exists: info !== null,
      owner: info?.owner.toBase58() ?? null, dataLen: info?.data.length ?? 0,
      reusable: true, recreate: false,
      nextAction: info ? "record exists (delegation attempted)" : "created during DelegateMarket (fund-gated)",
    });
  }
}

// Deploy wallet balance
const balance = await conn.getBalance(authority.publicKey);
manifest.push({
  label: "deploy wallet", address: authority.publicKey.toBase58(),
  exists: true, owner: "11111111111111111111111111111111",
  lamports: balance / LAMPORTS_PER_SOL, reusable: true, recreate: false,
  nextAction: "fund to the calculated minimum (scripts/devnet-cost.mjs)",
});

save({ manifest });
console.log(JSON.stringify(manifest, null, 2));

function save(patch) { fs.writeFileSync(statePath, JSON.stringify({ ...JSON.parse(fs.readFileSync(statePath, "utf8")), ...patch }, null, 2)); }
function pk(v) { return new PublicKey(v); }
