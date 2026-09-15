# Phase 2 External Concept References

Date: 2026-09-15

StockStream Phase 2 was implemented from the order-book specification in
`stockstream-architecture-v2.md`. No external protocol source code, tests,
layouts, deployment data, or artifacts were imported or copied.

Conceptual references requiring license review before any future reuse:

- PATRICIA / prefix-length binary tries: the general data-structure concept.
- Serum and OpenBook: named only in the architecture document as ecosystem
  context for integer-indexed shared node arenas and price-time trie behavior.
- Manifest: named only in the architecture document to distinguish its
  rotation-based red-black-tree design from StockStream's selected approach.

The Phase 2 Rust implementation and tests are authored independently in this
repository. Future use of external code requires a separate license review and
an explicit attribution record.
