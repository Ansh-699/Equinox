import { validateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { derivePath } from "ed25519-hd-key";
import { Keypair, Connection } from "@solana/web3.js";
import fs from "node:fs";

const MNEMONIC = process.env.STOCKSTREAM_MNEMONIC;
if (!MNEMONIC) { console.error("STOCKSTREAM_MNEMONIC not set"); process.exit(1); }
const words = MNEMONIC.trim().split(/\s+/);
if (words.length !== 12) { console.error("expected 12 words"); process.exit(1); }
try { validateMnemonic(words.join(" "), wordlist); } catch { console.error("invalid BIP-39 checksum"); process.exit(1); }
console.log("mnemonic: valid 12-word BIP-39 (checksum OK)");

const seed = mnemonicToSeedSync(words.join(" "));
console.log("BIP-39 seed derived (64 bytes, contents not printed)");

const PATHS = ["m/44'/501'/0'/0'", "m/44'/501'/0'", "m/44'/501'"];
const conn = new Connection("https://api.devnet.solana.com", "confirmed");

for (const path of PATHS) {
  const { key } = derivePath(path, Buffer.from(seed).toString("hex"));
  const keypair = Keypair.fromSeed(new Uint8Array(key));
  const pubkey = keypair.publicKey.toBase58();
  const balance = await conn.getBalance(keypair.publicKey);
  const balanceSOL = balance / 1_000_000_000;
  console.log(`path=${path} pubkey=${pubkey} balance=${balanceSOL.toFixed(4)} SOL`);
  if (balanceSOL > 0.1) {
    const secretKey = Array.from(keypair.secretKey);
    fs.writeFileSync("/tmp/opencode/lifecycle-wallet.json", JSON.stringify(secretKey));
    fs.chmodSync("/tmp/opencode/lifecycle-wallet.json", 0o600);
    const verify = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync("/tmp/opencode/lifecycle-wallet.json", "utf8"))));
    if (verify.publicKey.toBase58() !== pubkey) { console.error("verification failed"); process.exit(1); }
    console.log(`SELECTED: path=${path} pubkey=${pubkey} balance=${balanceSOL.toFixed(4)} SOL`);
  }
}
console.log("derivation complete");
