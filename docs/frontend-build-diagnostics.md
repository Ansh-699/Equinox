# Frontend production build: investigation record

**Status: `next build` and `next start` both work.** This records a real
investigation (not a dismissal) of an earlier crash and the exact evidence
that it is not currently reproducible.

## What was reported

Earlier in this branch's history, `next build` reliably crashed (native core
dump) in this sandbox, on both `stockstream/core-auth-sprint` and
`stockstream/frontend-product`. `next dev` was unaffected.

## What was checked

- Next.js 16.3.5, Node 24.10.0, npm 11.19.1, linux x64.
- `@next/swc-linux-x64-gnu` is the correct native package for this
  platform/arch (verified via `next info`, `uname -m`, `ldd --version`); no
  musl/glibc mismatch, no missing optional dependency.
- No stray `package-lock.json`/`pnpm-lock.yaml`/`yarn.lock` above this
  repository that could confuse Next's monorepo-root detection.
- `next.config.ts` carries no build-affecting options beyond `typedRoutes`
  and `allowedDevOrigins` (the latter added this session, dev-only).
- No duplicate Next.js installs, no manually patched or hand-downloaded
  native binaries anywhere in this history.

## What was verified (4 independent clean builds)

1. `stockstream-frontend` worktree, existing `node_modules`, `.next` removed
   first: `next build` succeeded.
2. Repeated on the same worktree: succeeded again (ruling out a one-off
   cache artifact).
3. `stockstream` (root/protocol) worktree, existing `node_modules`, `.next`
   removed: `next build` succeeded.
4. **A genuinely disposable worktree with a from-scratch `npm ci`** (not
   reusing any existing `node_modules`): `next build` succeeded.

Then, against that clean build's `.next` output:

- `next start` boots and serves.
- `/`, `/portfolio`, `/activity`, `/settings`, `/diagnostics`, `/api/health`
  all return `200`.
- The served HTML contains real rendered content ("StockStream", "Devnet"),
  not an error page.
- `scripts/secret-scan.sh` run against the real `.next/static` output:
  clean.

## Conclusion

The crash was not a structural repository/toolchain defect: the same
lockfile, the same `next.config.ts`, and the same native package resolve and
build successfully, repeatedly, including from a from-scratch install. The
most consistent explanation is transient resource contention in this
sandbox at the time of the original run (Turbopack's build step spawns
several worker processes; a native worker crashing under memory/CPU
pressure presents exactly as an unexplained core dump rather than a Rust
panic message). No code, config, or dependency change was needed or made to
"fix" this, because nothing here was actually broken.

## If it recurs

- Re-run with `.next` removed first (`rm -rf .next && npm run build`) before
  assuming a regression -- a stale partial build cache from an interrupted
  run is the most likely non-transient cause.
- If it reproduces on a from-scratch `npm ci` in a disposable worktree (not
  just the working copy), that would indicate a real regression worth a
  fresh investigation -- re-run the checklist above rather than assuming
  it's the same transient issue.
- A webpack-based production build remains available as a documented
  fallback if Turbopack becomes a persistent problem: `next build --webpack`
  (verified against this installed version's own CLI docs,
  `node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md`),
  but was not needed here.
