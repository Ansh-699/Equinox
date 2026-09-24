# Equinox Separation Report

Date: 2026-09-15

## Incorrectly Coupled Artifacts Removed

The following imported implementation surfaces were removed because they were
not authored as Equinox and must not be used as source, build, test,
deployment, or release evidence:

- `programs/slipstream/**`: imported program source.
- `programs/equinox/**`: copied program tree created by renaming imported
  source; replaced by a clean implementation.
- `client/**`, `keepers/**`, and `tests/**`: imported SDK, operational code,
  fixtures, and tests.
- `Anchor.toml`, `deploy.json`, root `Cargo.lock`, and `target/**`: imported
  deployment configuration, account addresses, artifacts, and lock state.
- `docs/00-*` through `docs/08-*`, including
  `docs/04-settlement-and-the-fill-log.md`, `docs/audit/**`, `docs/checks/**`,
  `docs/review/**`, `docs/spec/**`, and `docs/research/**`: imported technical
  claims, audit evidence, and deployment references.

## Historical Notes

No imported technical documentation is retained as Equinox evidence. The
only retained historical statement is this report: an external project was
reviewed for general architectural ideas and all copied implementation material
was removed before Equinox development continued.

## Required Separation Rules

- Equinox has its own program ID, crate, client constants, tests, lockfile,
  SBF artifact, and release evidence.
- No deployed account, program ID, test result, or source file from the
  reference project is valid Equinox evidence.
- Future integrations are designed against their official documentation and
  Equinox's own program interfaces.
