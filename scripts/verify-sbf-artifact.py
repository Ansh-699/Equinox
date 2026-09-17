#!/usr/bin/env python3
"""Gate 2 artifact regression check.

Rejects a SBF artifact the loader would refuse, or that is implausibly not the
real program. Run after `cargo build-sbf --features bpf-entrypoint`.

Checks (failures):
  * EI_OSABI != 0 (ELFOSABI_NONE). A `#[used]` static makes LLVM emit
    SHF_GNU_RETAIN, which makes lld tag the whole ELF ELFOSABI_GNU; solana-sbpf
    then rejects it with `ElfError::WrongAbi`. Commit 1635d6a removed the one
    such static from production -- this check keeps it gone.
  * missing/zero entry point
  * implausibly small stub artifact (the ~1.3 KB no-entrypoint case)
  * wrong e_machine
  * missing StockStream program identity (the pinned program ID bytes)

Reported, not failed on: SHF_GNU_RETAIN section presence, so a future `#[used]`
shows up in CI output instead of silently regressing the header.
"""
from __future__ import annotations

import sys
from pathlib import Path

PROGRAM_ID = bytes([
    238, 93, 151, 107, 197, 15, 150, 255, 50, 108, 58, 155, 4, 9, 32, 48, 102,
    97, 106, 199, 17, 221, 77, 89, 193, 85, 47, 160, 102, 163, 179, 240,
])
MIN_PLAUSIBLE_BYTES = 50_000
EM_SBPF = 0x107
EF_SBPF_V0 = 0x0
SHF_GNU_RETAIN = 0x200000


def read_u16(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset:offset + 2], "little")


def read_u32(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset:offset + 4], "little")


def read_u64(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset:offset + 8], "little")


def cstr(blob: bytes, offset: int) -> str:
    end = blob.find(b"\0", offset)
    return blob[offset:end if end != -1 else len(blob)].decode("utf-8", "replace")


def gnu_retain_sections(data: bytes) -> list[str]:
    """Section names carrying SHF_GNU_RETAIN. Empty when the table is unreadable."""
    try:
        shoff = read_u64(data, 0x28)
        shentsize = read_u16(data, 0x3A)
        shnum = read_u16(data, 0x3C)
        shstrndx = read_u16(data, 0x3E)
        if shoff == 0 or shnum == 0 or shstrndx >= shnum:
            return []
        str_off = read_u64(data, shoff + shstrndx * shentsize + 0x18)
        str_size = read_u64(data, shoff + shstrndx * shentsize + 0x20)
        names = data[str_off:str_off + str_size]
        found = []
        for index in range(shnum):
            base = shoff + index * shentsize
            flags = read_u64(data, base + 0x08)
            if flags & SHF_GNU_RETAIN:
                found.append(cstr(names, read_u32(data, base + 0x00)))
        return found
    except Exception:
        return []


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "target/deploy/stockstream.so")
    if not path.is_file():
        print(f"FAIL: artifact not found: {path}", file=sys.stderr)
        return 1

    data = path.read_bytes()
    failures: list[str] = []
    print(f"artifact: {path} ({len(data)} bytes)")

    if len(data) < MIN_PLAUSIBLE_BYTES:
        failures.append(
            f"implausibly small ({len(data)} bytes < {MIN_PLAUSIBLE_BYTES}) -- "
            "the no-entrypoint stub is ~1.3 KB; was --features bpf-entrypoint omitted?"
        )

    if data[:4] != b"\x7fELF":
        print("FAIL: not an ELF file", file=sys.stderr)
        return 1

    osabi = data[7]
    print(f"EI_OSABI:        {osabi} ({'ELFOSABI_NONE' if osabi == 0 else 'NON-CONFORMING'})")
    if osabi != 0:
        failures.append(
            f"EI_OSABI={osabi}, must be 0 (ELFOSABI_NONE); the loader rejects it "
            "with ElfError::WrongAbi"
        )

    e_machine = read_u16(data, 0x12)
    print(f"e_machine:       0x{e_machine:x} ({'EM_SBPF' if e_machine == EM_SBPF else 'UNEXPECTED'})")
    if e_machine != EM_SBPF:
        failures.append(f"e_machine=0x{e_machine:x}, expected 0x{EM_SBPF:x} (EM_SBPF)")

    e_flags = read_u32(data, 0x30)
    print(f"e_flags:         0x{e_flags:x}")

    entry = read_u64(data, 0x18)
    print(f"entry point:     0x{entry:x}")
    if entry == 0:
        failures.append("entry point is 0 -- no program entrypoint registered")

    print(f"program id:      {'present' if PROGRAM_ID in data else 'MISSING'}")
    if PROGRAM_ID not in data:
        failures.append("pinned StockStream program ID bytes are not present in the artifact")

    retain = gnu_retain_sections(data)
    if retain:
        print(
            "SHF_GNU_RETAIN:  present in "
            + ", ".join(retain)
            + " (a `#[used]` static; verify EI_OSABI above)"
        )
    else:
        print("SHF_GNU_RETAIN:  none")

    if failures:
        print("\nFAIL:", file=sys.stderr)
        for item in failures:
            print(f"  - {item}", file=sys.stderr)
        return 1

    print("\nOK: artifact is loadable and is the StockStream program")
    return 0


if __name__ == "__main__":
    sys.exit(main())
