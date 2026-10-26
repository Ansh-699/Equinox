//! Emits `ID` (the program's own address). `EQUINOX_PROGRAM_ID` (base58) overrides
//! the devnet default, so a mainnet build is `EQUINOX_PROGRAM_ID=<id> cargo build-sbf ...`.
use std::{env, fs, path::PathBuf};

const DEVNET_ID: [u8; 32] = [
    1, 234, 74, 20, 133, 113, 141, 20, 242, 15, 253, 116, 227, 98, 23, 21, 74, 231, 252, 113, 229,
    226, 164, 31, 131, 3, 31, 153, 255, 39, 114, 192,
];

fn base58_decode(text: &str) -> [u8; 32] {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut bytes: Vec<u8> = Vec::new(); // little endian
    for ch in text.bytes() {
        let mut carry = ALPHABET.iter().position(|&a| a == ch).unwrap_or_else(|| panic!("EQUINOX_PROGRAM_ID: invalid base58 character {:?}", ch as char)) as u32;
        for byte in bytes.iter_mut() {
            carry += u32::from(*byte) * 58;
            *byte = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    bytes.extend(std::iter::repeat(0).take(text.bytes().take_while(|&c| c == b'1').count()));
    bytes.reverse();
    bytes.try_into().unwrap_or_else(|v: Vec<u8>| panic!("EQUINOX_PROGRAM_ID must decode to 32 bytes, got {}", v.len()))
}

fn main() {
    println!("cargo:rerun-if-env-changed=EQUINOX_PROGRAM_ID");
    println!("cargo:rerun-if-changed=build.rs");
    let id = env::var("EQUINOX_PROGRAM_ID").map(|text| base58_decode(text.trim())).unwrap_or(DEVNET_ID);
    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("program_id.rs");
    fs::write(out, format!("pub const ID: Address = Address::new_from_array({id:?});\n")).expect("write program_id.rs");
}
