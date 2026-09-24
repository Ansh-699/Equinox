import deployment from "../../config/equinox-deployment.json";
import { SolanaL1Transport } from "./chain-transports";
import { resolveKeeperSigning } from "./keeper-signer";
import { fetchPythSolanaMessage, refreshOracleSnapshot, type RefreshResult } from "./oracle-refresh";

/** Keeper-paid, permissionless refresh of the deployed market's Pyth snapshot. */
export async function runOracleRefresh(env: Env): Promise<RefreshResult> {
  if (!env.SOLANA_RPC_URL || !env.PYTH_PRO_API_KEY || !deployment.core || !deployment.oracleSnapshot) {
    return { status: "failed", reason: "oracle refresh is not configured" };
  }
  const signing = await resolveKeeperSigning(env);
  if (signing.state !== "signer-ready" || !signing.signer) return { status: "failed", reason: `keeper signer ${signing.state}` };
  const l1 = new SolanaL1Transport(env.SOLANA_RPC_URL);
  const apiKey = env.PYTH_PRO_API_KEY;
  return refreshOracleSnapshot(
    { programId: deployment.programId, core: deployment.core, snapshot: deployment.oracleSnapshot, feedId: deployment.oracle.feedId, channel: deployment.oracle.channel },
    {
      now: Date.now,
      readAccount: async (address) => {
        const data = (await l1.account(address, "confirmed")).value?.data?.[0];
        return data ? Uint8Array.from(atob(data), (character) => character.charCodeAt(0)) : null;
      },
      fetchSignedMessage: (feedId, channel) => fetchPythSolanaMessage(apiKey, feedId, channel),
      signer: signing.signer,
      latestBlockhash: async () => {
        const { value } = await l1.latestBlockhash("confirmed");
        return { blockhash: value.blockhash, lastValidBlockHeight: BigInt(value.lastValidBlockHeight) };
      },
      send: (transaction) => l1.sendTransaction(transaction, { preflightCommitment: "confirmed" }),
      confirm: async (signature, lastValidBlockHeight) => {
        const outcome = await l1.confirmTransaction(signature, { targetCommitment: "confirmed", lastValidBlockHeight: Number(lastValidBlockHeight), timeoutMs: 20_000, pollIntervalMs: 500 });
        return outcome.status === "finalized" || outcome.status === "confirmed" ? "confirmed" : outcome.status === "blockhash_expired" ? "expired" : outcome.status === "failed" ? "failed" : "timeout";
      },
    },
  );
}
