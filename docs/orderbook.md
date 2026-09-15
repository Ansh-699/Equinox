# Order Book

Each side has fixed and oracle-pegged Patricia roots sharing a bounded arena
allocator. Matching normalizes effective prices, preserves FIFO at equal price,
and bounds fills and cleanup. Invalid handles, duplicate identities, corrupted
tags and capacity exhaustion are rejected. A leaf count must be measured from
the validated arena, never inferred from the 1,024-node allocator limit.
