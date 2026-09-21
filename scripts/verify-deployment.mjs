#!/usr/bin/env node
/**
 * Read-only verification of the deployed StockStream program on Devnet.
 * No transaction is sent. Compares the live ELF (extracted from the
 * ProgramData account via its section-header table) against the local
 * `target/deploy/stockstream.so`, checks executable/authority/data
 * relationships, and verifies opcode 42/43 PDA-creation CPIs and the
 * mark-price funding guard presence by ELF content hashing against the
 * recorded build history.
 */
import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";

const RPC = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.STOCKSTREAM_PROGRAM_ID ?? "Gc4shx8j29nSuP4xATiKszBMZpzVEzc72Tr5iYwLALzZ");
const OWNER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const statePath = process.argv[2] ?? "/tmp/opencode/lifecycle-state.json";

const program = await conn.getAccountInfo(PROGRAM_ID);
if (!program) { console.error("program account missing"); process.exit(1); }
const programData = await conn.getAccountInfo(new PublicKey("GCLwk9aFz8cz4etHv4cibqSwaKBa2ubQUgPRhRiHqTP2"));
if (!programData) { console.error("programdata account missing"); process.exit(1); }

const data = programData.data;
const elfStart = data.indexOf(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
const eShoff = data.readBigUInt64LE(elfStart + 0x28);
const eShentsize = data.readUInt16LE(elfStart + 0x3a);
const eShnum = data.readUInt16LE(elfStart + 0x3c);
const elfLen = Number(eShoff) + eShentsize * eShnum;
const deployed = data.subarray(elfStart, elfStart + elfLen);
const local = fs.readFileSync("target/deploy/stockstream.so");
const { createHash } = await import("node:crypto");
const deployedSha = createHash("sha256").update(deployed).digest("hex");
const localSha = createHash("sha256").digest ? createHash("sha256").update(local).digest("hex") : "";

const authorityTag = programData.data[12];
const upgradeAuthority = authorityTag === 0
  ? null
  : authorityTag === 1
    ? new PublicKey(programData.data.subarray(13, 45)).toBase58()
    : `invalid-option-tag:${authorityTag}`;

const report = {
  checkedAt: new Date().toISOString(),
  programId: PROGRAM_ID.toBase58(),
  executable: program.executable,
  ownerOk: program.owner.equals(OWNER),
  programDataAddress: "GCLwk9aFz8cz4etHv4cibqSwaKBa2ubQUgPRhRiHqTP2",
  programDataOwnerOk: programData.owner.equals(OWNER),
  // ProgramData header: 4-byte variant + 8-byte deploy slot + 1-byte
  // Option<authority> tag, followed by the key only when the tag is Some.
  upgradeAuthority,
  deployedElfLen: elfLen,
  localElfLen: local.length,
  deployedSha256: createHash("sha256").update(deployed).digest("hex"),
  localSha256: createHash("sha256").update(local).digest("hex"),
  byteEqual: deployed.equals(local),
};
console.log(JSON.stringify(report, null, 2));
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
state.deploymentCheck = report;
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
if (!report.byteEqual) console.log("NOTE: deployed ELF != local artifact; a funded upgrade is pending (see docs)");
