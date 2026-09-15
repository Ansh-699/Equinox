# Program Layout

The market account is 222,752 bytes: a 512-byte header, two 90,640-byte arena
regions, 128 256-byte seats and 128 64-byte fill events. Arena nodes are 88
bytes and include branch and leaf metadata, so node capacity is not resting
order capacity. The settlement scratch PDA is derived from
`settlement || market || seat_index_le`; its padded header is 272 bytes and its
plan begins at an explicitly aligned offset.
