import type { useSignTransaction } from '@privy-io/react-auth/solana';
import type { WalletBoundary } from './execution-boundary';

type Sign = ReturnType<typeof useSignTransaction>['signTransaction'];
type Input = Parameters<Sign>[0];
export class PrivyWalletSigner implements WalletBoundary {
  constructor(private readonly sign: Sign, private readonly wallet: Input['wallet'], private readonly chain: Input['chain']) {}
  async signTransaction(transaction: Uint8Array): Promise<Uint8Array> {
    if (!transaction.length) throw new Error('Empty transaction');
    const result = await this.sign({transaction,wallet:this.wallet,chain:this.chain});
    if (!result.signedTransaction.length) throw new Error('Privy returned an empty signed transaction');
    return result.signedTransaction;
  }
}
