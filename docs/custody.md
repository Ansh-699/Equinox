# Custody

Custody accepts one configured mint and the legacy SPL Token program with exact
decimals; Token-2022 extensions are rejected until separately reviewed.
Deposits credit the internal ledger only after the transfer CPI succeeds.
Withdrawals settle funding, reserve margin and maintenance health before a
vault-authority signed transfer. The current devnet USDC reference is
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (6 decimals, testnet only),
but deployment configuration remains explicit and live CPI execution is not
verified here.
