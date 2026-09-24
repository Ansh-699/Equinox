//! The few Solana primitives the maker needs, without the full SDK:
//! base58 keys, program-derived addresses, and legacy transaction
//! compile + sign (same header, accounts and instructions as web3.js;
//! only the order of accounts within each signer/writable group may differ).

use anyhow::{anyhow, bail, Result};
use curve25519_dalek::edwards::CompressedEdwardsY;
use ed25519_dalek::{Signer as _, SigningKey};
use sha2::{Digest, Sha256};

pub type Pubkey = [u8; 32];

pub const COMPUTE_BUDGET_PROGRAM: &str = "ComputeBudget111111111111111111111111111111";

pub fn pubkey(text: &str) -> Result<Pubkey> {
    let bytes = bs58::decode(text).into_vec()?;
    bytes.try_into().map_err(|_| anyhow!("not a 32-byte address: {text}"))
}

pub fn b58(bytes: &[u8]) -> String {
    bs58::encode(bytes).into_string()
}

/// `findProgramAddress`: the first bump (from 255 down) whose hash is off the ed25519 curve.
pub fn find_program_address(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    for bump in (0..=255u8).rev() {
        let mut hasher = Sha256::new();
        for seed in seeds {
            hasher.update(seed);
        }
        hasher.update([bump]);
        hasher.update(program);
        hasher.update(b"ProgramDerivedAddress");
        let hash: [u8; 32] = hasher.finalize().into();
        if CompressedEdwardsY(hash).decompress().is_none() {
            return hash;
        }
    }
    unreachable!("no viable bump for these seeds")
}

#[derive(Clone, Debug)]
pub struct AccountMeta {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}

#[derive(Clone, Debug)]
pub struct Instruction {
    pub program_id: Pubkey,
    pub accounts: Vec<AccountMeta>,
    pub data: Vec<u8>,
}

pub fn set_compute_unit_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction { program_id: pubkey(COMPUTE_BUDGET_PROGRAM).expect("constant"), accounts: vec![], data }
}

pub struct Keypair {
    signing: SigningKey,
}

impl Keypair {
    /// The 64-byte JSON array written by `solana-keygen`.
    pub fn from_json(text: &str) -> Result<Self> {
        let bytes: Vec<u8> = serde_json::from_str(text.trim())?;
        let bytes: [u8; 64] = bytes.try_into().map_err(|_| anyhow!("keypair JSON must hold 64 bytes"))?;
        let signing = SigningKey::from_keypair_bytes(&bytes).map_err(|_| anyhow!("keypair bytes are inconsistent"))?;
        Ok(Self { signing })
    }

    pub fn from_seed(seed: &[u8; 32]) -> Self {
        Self { signing: SigningKey::from_bytes(seed) }
    }

    pub fn pubkey(&self) -> Pubkey {
        self.signing.verifying_key().to_bytes()
    }
}

fn short_vec(out: &mut Vec<u8>, mut len: usize) {
    loop {
        let mut byte = (len & 0x7f) as u8;
        len >>= 7;
        if len == 0 {
            out.push(byte);
            return;
        }
        byte |= 0x80;
        out.push(byte);
    }
}

/// Legacy message: writable signers (fee payer first), readonly signers,
/// writable non-signers, readonly non-signers -- each in first-seen order.
pub fn compile_message(payer: &Pubkey, instructions: &[Instruction], blockhash: &[u8; 32]) -> Result<Vec<u8>> {
    let mut keys: Vec<(Pubkey, bool, bool)> = vec![(*payer, true, true)];
    let mut upsert = |key: Pubkey, signer: bool, writable: bool| {
        if let Some(entry) = keys.iter_mut().find(|entry| entry.0 == key) {
            entry.1 |= signer;
            entry.2 |= writable;
        } else {
            keys.push((key, signer, writable));
        }
    };
    for ix in instructions {
        for meta in &ix.accounts {
            upsert(meta.pubkey, meta.is_signer, meta.is_writable);
        }
        upsert(ix.program_id, false, false);
    }
    let group = |signer: bool, writable: bool| keys.iter().filter(move |k| k.1 == signer && k.2 == writable);
    let ordered: Vec<_> = group(true, true).chain(group(true, false)).chain(group(false, true)).chain(group(false, false)).copied().collect();
    if ordered.len() > 256 {
        bail!("too many accounts");
    }
    let index = |key: &Pubkey| ordered.iter().position(|k| k.0 == *key).expect("every key was collected") as u8;

    let mut out = vec![
        ordered.iter().filter(|k| k.1).count() as u8,
        ordered.iter().filter(|k| k.1 && !k.2).count() as u8,
        ordered.iter().filter(|k| !k.1 && !k.2).count() as u8,
    ];
    short_vec(&mut out, ordered.len());
    for key in &ordered {
        out.extend_from_slice(&key.0);
    }
    out.extend_from_slice(blockhash);
    short_vec(&mut out, instructions.len());
    for ix in instructions {
        out.push(index(&ix.program_id));
        short_vec(&mut out, ix.accounts.len());
        for meta in &ix.accounts {
            out.push(index(&meta.pubkey));
        }
        short_vec(&mut out, ix.data.len());
        out.extend_from_slice(&ix.data);
    }
    Ok(out)
}

/// A single-signer wire transaction and its signature (the transaction id).
pub fn sign_transaction(payer: &Keypair, instructions: &[Instruction], blockhash: &[u8; 32]) -> Result<(Vec<u8>, [u8; 64])> {
    let message = compile_message(&payer.pubkey(), instructions, blockhash)?;
    let signature = payer.signing.sign(&message).to_bytes();
    let mut wire = Vec::with_capacity(1 + 64 + message.len());
    short_vec(&mut wire, 1);
    wire.extend_from_slice(&signature);
    wire.extend_from_slice(&message);
    if wire.len() > 1232 {
        bail!("transaction is {} bytes, over the 1232-byte packet limit", wire.len());
    }
    Ok((wire, signature))
}
