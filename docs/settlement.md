# Settlement

Place-order settlement is planned, validated and applied within one instruction.
The per-seat scratch account is working memory and must be `Empty` at a
successful boundary; there is no public delayed apply instruction. Apply reads
validated planned values for fills, positions, fees, funding, reserves, events
and sequences. Solana runtime rollback is separate from pre-apply validation
and remains runtime-unverified while the SBPF harness is incompatible.
