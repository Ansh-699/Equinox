#!/usr/bin/env node
/**
 * Custody setup: mint, ATAs, vault, seats, deposits — for one test market.
 */
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, getAccount,
} from "@solana/spl-token";

const MARKET_PDA_STR = "3pzM8u4bQVNGgFmVvvB5RCowUUQoJeXJzbwoGkHfxHyx";
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const AUTHORITY_PUBKEY = new PublicKey("A5sV4PkkVM4gm3rejACvKFgxEMmj8ouGsffSKT5qYVc8");
const conn = new Connection("https://api.devnet.solana.com", "confirmed");

// Check vault exists
const vaultStr = "EoiYduem3nbxK6FNccU9gj6a5KpX7cYSmNQhqXr4ik2e";
const vaultInfo = await conn.getAccountInfo(new PublicKey(vaultStr));
if (!vaultInfo) {
  console.log(`vault ${vaultStr}: does not exist`);
} else {
  console.log(`vault ${vaultStr}: owner=${vaultInfo.owner.toBase58()} lamports=${vaultInfo.lamports} dataLen=${vaultInfo.data.length}`);
}
