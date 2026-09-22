#!/usr/bin/env node
/**
 * Read-only audit of the preserved V3 core and its bounded execution shards.
 * It derives every PDA from the supplied core, reads L1 and ER atomically,
 * and queries Magic Router delegation status. It never signs or submits.
 *
 * Usage: node scripts/v3-live-account-audit.mjs [core]
 */
import { PublicKey } from "@solana/web3.js";

const PROGRAM = new PublicKey(process.env.STOCKSTREAM_PROGRAM_ID ?? "8Ucdsd3ejSEFFTpUivfK84eZv2q6aAe83A9zwSBcxFZ");
const DEFAULT_CORE = "47Mx7SZvt7EY6NydsA5krgrqvcDDR1H5BG5xTPDSnhso";
const L1 = "https://api.devnet.solana.com";
const ER = "https://devnet-as.magicblock.app/";
const ROUTER = "https://devnet-router.magicblock.app";
const core = new PublicKey(process.argv[2] ?? DEFAULT_CORE);

const derive = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0];
const children = [];
for (let side = 0; side < 2; side += 1) {
  for (let page = 0; page < 9; page += 1) {
    children.push({ kind: "book", index: `${side}/${page}`, key: derive([Buffer.from("book-page-v3"), core.toBuffer(), Buffer.from([side]), Buffer.from([page])]) });
  }
}
for (let index = 0; index < 4; index += 1) {
  children.push({ kind: "seat", index, key: derive([Buffer.from("seat-shard-v3"), core.toBuffer(), Buffer.from([index])]) });
}
for (let index = 0; index < 4; index += 1) {
  children.push({ kind: "event", index, key: derive([Buffer.from("event-shard-v3"), core.toBuffer(), Buffer.from([index])]) });
}
const accounts = [{ kind: "core", index: null, key: core }, ...children];

async function rpc(endpoint, method, params) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

const addresses = accounts.map(({ key }) => key.toBase58());
const [l1, er, delegation] = await Promise.all([
  rpc(L1, "getMultipleAccounts", [addresses, { encoding: "base64", commitment: "finalized" }]),
  rpc(ER, "getMultipleAccounts", [addresses, { encoding: "base64", commitment: "processed" }]),
  Promise.all(addresses.map(async (address) => ({ address, status: await rpc(ROUTER, "getDelegationStatus", [address]) }))),
]);

function accountView(result, index) {
  const value = result.value?.[index] ?? null;
  return {
    owner: value?.owner ?? null,
    dataLength: value?.data?.[0] ? Buffer.from(value.data[0], "base64").length : null,
  };
}

const rows = accounts.map((account, index) => ({
  kind: account.kind,
  index: account.index,
  address: account.key.toBase58(),
  l1: accountView(l1, index),
  er: accountView(er, index),
  delegation: delegation[index].status,
}));
const delegated = rows.filter(({ delegation: status }) => status?.isDelegated === true).length;
console.log(JSON.stringify({
  readOnly: true,
  core: core.toBase58(),
  accountCount: rows.length,
  l1Slot: l1.context?.slot ?? null,
  erSlot: er.context?.slot ?? null,
  delegatedCount: delegated,
  sizes: [...new Set(rows.map(({ l1: value }) => value.dataLength).filter((value) => value !== null))],
  rows,
}, null, 2));
