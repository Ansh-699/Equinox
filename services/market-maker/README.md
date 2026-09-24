# StockStream market maker

An always-on devnet quoting bot for the V3 TSLA-PERP book inside the MagicBlock
rollup. It replaced the Cloudflare Durable Object, which hit Durable Object
request limits at one tick every ~0.5 s.

Each tick:
- reads the maker's own resting orders from the rollup book;
- replaces only the rungs that drifted, with an atomic `ReplaceOrder`, so a level is never empty;
- re-sizes two settled rungs, so the book keeps moving;
- has a taker seat cross the touch with 1–2 lots, so fills print.

Every transaction is timed from send to the rollup's `signatureSubscribe`
"processed" push. The bot pauses while Pyth reports the US session closed:
the program refuses orders then.

## Where to run it

In **Singapore**, next to the `devnet-as` validator. Latency is dominated by
the network: about 4 ms from Singapore versus about 80 ms from India.

- DigitalOcean: `SGP1`.
- Azure: `Southeast Asia`.

The smallest VM is enough: 1 vCPU and 1 GB RAM.

## Build and test

```bash
cargo test                                   # quote logic + byte parity with clients/stockstream
cargo build --release                        # target/release/stockstream-market-maker
# or, from the repository root:
docker build -f services/market-maker/Dockerfile -t stockstream-mm .
```

`tests/fixtures/encoding.json` comes from the TypeScript client. Regenerate it
after an ABI change with
`npx tsx services/market-maker/tests/fixtures/generate.mts`.

## Deploy on a VM (systemd)

```bash
# 1. Binary and a service user
sudo install -m 755 target/release/stockstream-market-maker /usr/local/bin/
sudo useradd --system --no-create-home stockstream

# 2. Keys (the bots' own keypairs; never the market authority) and config
sudo install -d -m 750 -o root -g stockstream /etc/stockstream
sudo install -m 640 -o root -g stockstream mm-maker.json mm-taker.json /etc/stockstream/
sudo install -m 600 deploy/mm.env.example /etc/stockstream/mm.env   # then edit MM_REGION etc.

# 3. Service
sudo install -m 644 deploy/stockstream-mm.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now stockstream-mm
journalctl -u stockstream-mm -f
curl -s localhost:8080/v1/mm/status | head -c 300
```

With Docker instead (the image runs as uid 10001, which must be able to read the keys):

```bash
sudo chown 10001 /etc/stockstream/mm-maker.json /etc/stockstream/mm-taker.json
sudo chmod 751 /etc/stockstream   # let uid 10001 reach the key files
docker run -d --restart=always --name stockstream-mm -p 127.0.0.1:8080:8080 \
  -v /etc/stockstream:/etc/stockstream:ro --env-file /etc/stockstream/mm.env \
  -e MM_STATUS_ADDR=0.0.0.0:8080 stockstream-mm
```

## Status for the terminal (HTTPS)

The terminal's live-transactions panel polls the status every second. Serve
it over HTTPS and point the frontend at it directly: polling through the
Worker would spend Worker requests (about 86k/day for one open tab).

1. Install Caddy.
2. Copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile` and replace the host with
   `<vm-ip-with-dashes>.sslip.io`, for example `203-0-113-5.sslip.io`. It
   resolves to the VM, so there's no domain to buy, and Caddy gets a Let's
   Encrypt certificate automatically.
3. Open ports 80 and 443 (keep 8080 closed).
4. Set the frontend build variable, then redeploy:
   ```
   NEXT_PUBLIC_MM_STATUS_URL=https://203-0-113-5.sslip.io/v1/mm/status
   ```
5. Optional: set the Worker variable `MM_STATUS_URL` to the same URL, so
   `GET /v1/mm/status` on the market API keeps working as a fallback.

## Configuration

| Variable | Default | |
|---|---|---|
| `MM_MAKER_KEYPAIR`, `MM_TAKER_KEYPAIR` | required | paths to solana-keygen JSON files; each key must already own a seat in the market |
| `MM_KEEPER_KEYPAIR` | unset | the core's keeper key; turns on commits, funding and liquidation (see Keeper) |
| `MM_COMMIT_EVERY_S`, `MM_FUNDING_EVERY_S` | `120`, `3600` | keeper pacing |
| `MAGICBLOCK_RPC_URL` | deployment `magicBlock.rpc` | rollup RPC and websocket |
| `MARKET_API_URL` | the StockStream Worker | permissionless Pyth snapshot refresh when the rollup price is older than 6 s |
| `MM_STATUS_ADDR` | `0.0.0.0:8080` | status server (`/v1/mm/status`, `/healthz`) |
| `MM_REGION` | unset | label shown in the terminal |
| `MM_TICK_MS` | `400` | pause between ticks |
| `STOCKSTREAM_DEPLOYMENT` | compiled-in `config/stockstream-deployment.json` | another market |

Stopping the service is safe: quotes expire on their own within 60 s.

## Keeper

With `MM_KEEPER_KEYPAIR` set, the same process also runs the market's keeper
jobs (`src/keeper.rs`), signed by a key the market authority names on the core:

```sh
node scripts/v3-set-keeper.mjs <keeper-pubkey>   # opcode 64; `clear` revokes it
```

The program lets that key fund, liquidate and commit-only snapshot, nothing
else (no custody, no risk settings, no undelegation). Fund it with ~1 devnet
SOL for rollup fees.

- **Commit** every `MM_COMMIT_EVERY_S`: the 26 child shards, then the core.
  Trading pauses while the snapshot is open (~1.4 s from Singapore), so the
  maker stands down. Commits are paid by the core through the validator's
  magic fee vault, which lifts MagicBlock's 10-commits-per-delegation cap; keep
  the core's rollup balance above rent with `node scripts/v3-topup-core.mjs 1`.
  A failed commit closes its snapshot (opcode 65) so trading continues;
  `node scripts/v3-set-keeper.mjs abort-snapshot` does the same by hand.
- **Funding** every `MM_FUNDING_EVERY_S`: moves the accumulator by the book's
  premium over the oracle (the program only lets it rise and caps the step).
- **Liquidation** every 3 s: re-scores every seat with the program's own risk
  code (the `stockstream` crate is a path dependency) and liquidates the ones
  under maintenance margin.

The status JSON gains a `keeper` object (commits, last sequence, pause length,
funding steps, liquidations, errors).

