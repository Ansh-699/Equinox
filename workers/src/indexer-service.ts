import type { MarketEvent, MarketSnapshot } from './types';
import { IndexerRepository } from './repositories';

export interface AuthoritativeSnapshotFetcher {
  snapshot(marketPda: string, domain: 'l1' | 'er'): Promise<{ sequence: number; slot: number; snapshot: MarketSnapshot }>;
}

export interface MarketPublisher {
  publish(event: MarketEvent): Promise<'applied' | 'duplicate' | 'gap'>;
  replaceSnapshot(snapshot: MarketSnapshot): Promise<{ accepted: boolean; reason?: string }>;
}

export type IndexResult = 'applied' | 'duplicate' | 'resnapshotted';

/** D1-backed ordered ingestion. A sequence gap is never filled from the event
 * stream: it is repaired only by replacing the projection from a designated
 * authoritative account reader. */
export class MarketIndexer {
  constructor(
    private readonly repository: IndexerRepository,
    private readonly snapshots: AuthoritativeSnapshotFetcher,
    private readonly publisherForMarket: (market: string) => MarketPublisher,
  ) {}

  async ingest(marketPda: string, event: MarketEvent): Promise<IndexResult> {
    if (!event.domain || event.sequence === undefined) throw new Error('sequenced domain event required');
    const result = await this.repository.append(
      marketPda, event.domain, event.sequence, event.slot ?? 0, event.id, event, event.observedAt,
    );
    const publisher = this.publisherForMarket(marketPda);
    if (result.kind === 'duplicate') return 'duplicate';
    if (result.kind === 'applied') {
      const publication = await publisher.publish(event);
      if (publication === 'gap') return this.resnapshot(marketPda, event.domain, publisher);
      return 'applied';
    }
    return this.resnapshot(marketPda, event.domain, publisher);
  }

  async resnapshot(marketPda: string, domain: 'l1' | 'er', publisher = this.publisherForMarket(marketPda)): Promise<'resnapshotted'> {
    const replacement = await this.snapshots.snapshot(marketPda, domain);
    if (replacement.snapshot.market.marketPda !== marketPda || replacement.snapshot.domain !== domain || replacement.snapshot.sequence !== replacement.sequence)
      throw new Error('authoritative snapshot identity mismatch');
    await this.repository.replaceSnapshot(marketPda, domain, replacement.sequence, replacement.slot, replacement.snapshot, replacement.snapshot.capturedAt);
    const accepted = await publisher.replaceSnapshot(replacement.snapshot);
    if (!accepted.accepted) throw new Error(accepted.reason ?? 'durable stream rejected snapshot');
    return 'resnapshotted';
  }
}
