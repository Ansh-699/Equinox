import { expect, test } from "vitest";
import { associatedTokenAddress, FAUCET_LAMPORTS, FAUCET_TOKENS, faucetInstructions } from "./faucet";

const keeper = "AmHAkHvKo8K7UFs9g7Vkk5ZZerA3K7qx5VMj8rG5ixm8";
const wallet = "8FfLriMAyH5MCxP9UmUJ5Qh5i8xiq97AHv1h3tzjmuCi";
const mint = "GLgZYwSXmDTktcX9Hpizak7AjPJjd5QdwrRDkYc5oRtC";

test("derives the canonical associated token account", async () => {
  // Pinned from @solana/spl-token getAssociatedTokenAddressSync(mint, wallet).
  expect(await associatedTokenAddress(wallet, mint)).toBe("4oSZ4o5joP2PRFGtAM1yyBCtaRkPh9GX8kC6hoUv4Ztr");
});

test("creates the token account idempotently, mints collateral and tops up SOL only when asked", async () => {
  const withSol = await faucetInstructions(keeper, wallet, mint, true);
  expect(withSol.map((ix) => ix.programAddress)).toEqual(["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "11111111111111111111111111111111"]);
  expect(withSol[0].data).toEqual(Uint8Array.of(1));
  expect(new DataView(withSol[1].data!.buffer).getBigUint64(1, true)).toBe(FAUCET_TOKENS);
  expect(new DataView(withSol[2].data!.buffer).getBigUint64(4, true)).toBe(FAUCET_LAMPORTS);
  expect(await faucetInstructions(keeper, wallet, mint, false)).toHaveLength(2);
});

test("wallet-signed faucet claims: accepts a fresh signature over the exact message and rejects tampering or staleness", async () => {
    const { faucetClaimMessage, verifyFaucetSignature } = await import("./faucet");
    const { getBase58Decoder } = await import("@solana/kit");
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const wallet = getBase58Decoder().decode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer));
    const message = faucetClaimMessage(wallet, 1_000);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(message)))));
    expect(await verifyFaucetSignature(wallet, message, signature, 1_100)).toBe(true);
    expect(await verifyFaucetSignature(wallet, message, signature, 2_000)).toBe(false); // stale
    expect(await verifyFaucetSignature(wallet, message.replace("1000", "1001"), signature, 1_100)).toBe(false); // tampered
});
