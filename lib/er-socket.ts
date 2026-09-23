"use client";

import { getBase58Decoder } from "@solana/kit";

/**
 * One persistent websocket to the MagicBlock rollup. `watch(signature)`
 * subscribes before a send; `done` settles on the rollup's "processed" push,
 * so a transaction's time is one network round trip plus execution -- no
 * polling. The subscription acknowledgement itself is a pure network round
 * trip, reported as `pingMs`.
 */
export class ErSocket {
  private ws: WebSocket | null = null;
  private opening: Promise<WebSocket> | null = null;
  private nextId = 1;
  private acks = new Map<number, (subscription: number) => void>();
  private waiters = new Map<number, (result: { at: number; ok: boolean }) => void>();

  constructor(private readonly rpcUrl: string) {}

  private connect(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    return (this.opening ??= new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.rpcUrl.replace(/^http/, "ws"));
      ws.onopen = () => { this.ws = ws; this.opening = null; resolve(ws); };
      ws.onerror = () => { this.opening = null; reject(new Error("rollup websocket unavailable")); };
      ws.onclose = () => { if (this.ws === ws) this.ws = null; };
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: number; method?: string; params?: { subscription: number; result: { value: { err: unknown } } } };
        if (message.id !== undefined && typeof message.result === "number") this.acks.get(message.id)?.(message.result);
        else if (message.method === "signatureNotification" && message.params) {
          this.waiters.get(message.params.subscription)?.({ at: performance.now(), ok: !message.params.result.value.err });
          this.waiters.delete(message.params.subscription);
        }
      };
    }));
  }

  /** Wrapped in an object: an async function returning a bare promise would wait for it. */
  async watch(signature: string, timeoutMs = 5_000): Promise<{ pingMs: number; done: Promise<{ at: number; ok: boolean } | null> }> {
    const ws = await this.connect();
    const id = this.nextId++;
    const sentAt = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const subscription = await new Promise<number>((resolve, reject) => {
      this.acks.set(id, resolve);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "signatureSubscribe", params: [signature, { commitment: "processed" }] }));
      timer = setTimeout(() => reject(new Error("signatureSubscribe was not acknowledged")), 3_000);
    }).finally(() => { clearTimeout(timer); this.acks.delete(id); });
    const pingMs = Math.round(performance.now() - sentAt);
    return {
      pingMs,
      done: new Promise((resolve) => {
        this.waiters.set(subscription, resolve);
        setTimeout(() => { if (this.waiters.delete(subscription)) resolve(null); }, timeoutMs);
      }),
    };
  }
}

const base58 = getBase58Decoder();
/** The fee payer's signature of a serialized transaction (after the compact signature count). */
export const firstSignature = (serialized: Uint8Array) => base58.decode(serialized.subarray(1, 65));
