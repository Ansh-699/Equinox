/**
 * Instantiates the relayer fee-payer signer from a secure keypair binding.
 * The keypair material lives in a secret binding (untracked), never in
 * `.env.example`, D1, KV, or browser code.
 */
import { LocalKeypairSigner } from "./signer";

export function createRelayerSigner(keypairJson: string): { publicKey: string; signer: InstanceType<typeof LocalKeypairSigner> } {
  const signer = new LocalKeypairSigner("relayer:fee-payer", keypairJson);
  return { signer, publicKey: "" };
}
