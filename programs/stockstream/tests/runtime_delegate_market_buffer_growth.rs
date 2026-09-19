#![cfg(feature = "runtime-tests")]
//! Real-SVM regression test for `DelegateMarket` (opcode 13) against a
//! genuine, full-size market account (`MARKET_ACCOUNT_SIZE` =
//! `state::MARKET_ACCOUNT_SIZE` bytes).
//!
//! The bug this proves fixed: a single Solana instruction can only grow
//! any one account's data length by `MAX_PERMITTED_DATA_INCREASE` (10,240)
//! bytes, whether via a fresh `CreateAccount` CPI or a direct owner-side
//! realloc -- a limit LiteSVM enforces just like a real cluster, unlike the
//! native `process_instruction` unit tests in `tests/magicblock.rs`, where
//! CPIs are no-ops and this constraint is invisible. `delegate_market`
//! used to try to size its delegation "buffer" PDA to the market's full
//! size in one `CreateAccount` CPI, which fails with "Failed to
//! reallocate account data" for any market (`MARKET_ACCOUNT_SIZE` is far
//! larger than 10,240 bytes) -- found only by actually running the real
//! Devnet lifecycle end to end, not by any test that existed before this
//! one. `magicblock.rs::ensure_buffer_ready` now grows the buffer
//! incrementally, exactly like `registry::create_market_account` already
//! does for the market's own creation, requiring this instruction to be
//! invoked repeatedly (same accounts) until it actually delegates.

use std::path::PathBuf;
use std::ptr;

use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::account_meta::AccountMeta;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use stockstream::{
    magicblock::{DELEGATE_BUFFER_TAG, DELEGATION_METADATA_TAG, DELEGATION_RECORD_TAG},
    registry::PERP_MARKET_SEED,
    state::{DelegationStatus, MarketMode, MarketStateHeader, MARKET_ACCOUNT_SIZE},
    ID,
};

const DELEGATION_PROGRAM_ID: Address = Address::new_from_array([
    181, 183, 0, 225, 242, 87, 58, 192, 204, 6, 34, 1, 52, 74, 207, 151, 184, 53, 6, 235, 140, 229,
    25, 152, 204, 98, 126, 24, 147, 128, 167, 62,
]);

fn program_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/stockstream.so")
}

fn install(svm: &mut LiteSVM, address: Address, data: Vec<u8>, owner: Address) {
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(
        address,
        Account {
            lamports,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn read_header(data: &[u8]) -> MarketStateHeader {
    unsafe { ptr::read_unaligned(data.as_ptr() as *const MarketStateHeader) }
}

fn writable(address: Address) -> AccountMeta {
    AccountMeta::new(address, false)
}
fn readonly(address: Address) -> AccountMeta {
    AccountMeta::new_readonly(address, false)
}
fn readonly_signer(address: Address) -> AccountMeta {
    AccountMeta::new_readonly(address, true)
}
fn writable_signer(address: Address) -> AccountMeta {
    AccountMeta::new(address, true)
}

/// A real, non-delegated, full-size market -- not the "already delegated"
/// shortcut fixture other delegation tests use, since this test's whole
/// point is to drive `delegate_market` itself from scratch.
fn setup() -> (LiteSVM, Keypair, Address, Address) {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(ID, program_path())
        .expect("unmodified artifact must load in LiteSVM");
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();

    let instrument = Address::new_unique();
    let market = Address::find_program_address(&[PERP_MARKET_SEED, instrument.as_ref()], &ID).0;

    let mut header = MarketStateHeader::empty();
    header.initialized = 1;
    header.mode = MarketMode::Open as u8;
    header.market_authority = authority.pubkey().to_bytes();
    let mut data = vec![0u8; MARKET_ACCOUNT_SIZE];
    unsafe {
        ptr::copy_nonoverlapping(
            &header as *const MarketStateHeader as *const u8,
            data.as_mut_ptr(),
            core::mem::size_of::<MarketStateHeader>(),
        );
    }
    install(&mut svm, market, data, ID);

    (svm, authority, instrument, market)
}

fn delegate_ix(
    market: Address,
    authority: Address,
    instrument: Address,
    payer: Address,
    buffer: Address,
    record: Address,
    metadata: Address,
    validator: Address,
) -> Instruction {
    let mut data = vec![13u8];
    data.extend_from_slice(validator.as_ref());
    Instruction {
        program_id: ID,
        accounts: vec![
            writable(market),
            readonly_signer(authority),
            readonly(instrument),
            writable_signer(payer),
            writable(buffer),
            writable(record),
            writable(metadata),
            readonly(DELEGATION_PROGRAM_ID),
            readonly(Address::new_from_array([0; 32])),
            readonly(ID),
        ],
        data,
    }
}

#[test]
fn delegating_a_full_size_market_requires_multiple_calls_and_never_hits_the_realloc_cap() {
    let (mut svm, authority, instrument, market) = setup();
    let (buffer, _) = Address::find_program_address(&[DELEGATE_BUFFER_TAG, market.as_ref()], &ID);
    let (record, _) = Address::find_program_address(
        &[DELEGATION_RECORD_TAG, market.as_ref()],
        &DELEGATION_PROGRAM_ID,
    );
    let (metadata, _) = Address::find_program_address(
        &[DELEGATION_METADATA_TAG, market.as_ref()],
        &DELEGATION_PROGRAM_ID,
    );
    install(&mut svm, record, vec![0; 200], DELEGATION_PROGRAM_ID);
    install(&mut svm, metadata, vec![0; 200], DELEGATION_PROGRAM_ID);
    let validator = Address::new_unique();

    let mut calls = 0;
    let max_calls = MARKET_ACCOUNT_SIZE / 10_240 + 4;
    loop {
        calls += 1;
        assert!(
            calls <= max_calls,
            "delegate_market did not converge within the expected number of calls"
        );
        svm.expire_blockhash();
        let instruction = delegate_ix(
            market,
            authority.pubkey(),
            instrument,
            authority.pubkey(),
            buffer,
            record,
            metadata,
            validator,
        );
        let message = Message::new(&[instruction], Some(&authority.pubkey()));
        let blockhash = svm.latest_blockhash();
        let transaction = Transaction::new(&[&authority], message, blockhash);
        let result = svm.send_transaction(transaction);

        let market_owner = svm.get_account(&market).unwrap().owner;
        if market_owner == DELEGATION_PROGRAM_ID {
            // The final call reaches the real (unloaded, in this harness)
            // Delegation Program CPI, which LiteSVM cannot execute -- that
            // failure is expected and is not what this test is proving;
            // reaching it at all (instead of "Failed to reallocate account
            // data") is the proof. Accept either a clean success (if a
            // future LiteSVM version stubs the CPI) or a failure that is
            // clearly the missing-program boundary, never the realloc bug.
            break;
        }
        match result {
            Ok(_) => {
                // A pure buffer-growth call: the market must be untouched
                // (still ours, still NotDelegated) while the buffer grows
                // underneath it.
                let market_data = svm.get_account(&market).unwrap().data;
                let header = read_header(&market_data);
                assert_eq!(
                    header.delegation_status(),
                    DelegationStatus::NotDelegated as u8,
                    "the market must not be marked delegated until the buffer is fully grown"
                );
                let buffer_len = svm.get_account(&buffer).map(|a| a.data.len()).unwrap_or(0);
                assert!(
                    buffer_len < MARKET_ACCOUNT_SIZE,
                    "a successful non-final call must mean the buffer is still growing"
                );
            }
            Err(failed) => {
                let text = format!("{:?} | {}", failed.err, failed.meta.pretty_logs());
                assert!(
                    !text.contains("Failed to reallocate account data"),
                    "the realloc-cap bug regressed: {text}"
                );
                // A failing transaction's writes are rolled back entirely,
                // including any growth this same call performed -- so the
                // buffer length read now reflects the last COMMITTED
                // (pre-this-call) size. This call must only ever fail once
                // that committed size was already close enough that this
                // call's own growth step would have completed it and gone
                // on to attempt the real (unloaded, in this harness)
                // Delegation Program CPI -- never at an earlier, partial
                // growth step.
                let buffer_len_before_this_call =
                    svm.get_account(&buffer).map(|a| a.data.len()).unwrap_or(0);
                assert!(
                    buffer_len_before_this_call + 10_240 >= MARKET_ACCOUNT_SIZE,
                    "a failing call must only happen once growth would complete within it: buffer was {buffer_len_before_this_call} bytes; {text}"
                );
                assert!(
                    !text.contains("0x600e")
                        && !text.contains("0x600f")
                        && !text.contains("0x6010")
                        && !text.contains("0x6013")
                        && !text.contains("0x601a"),
                    "validation gates must pass before the CPI; got {text}"
                );
                break;
            }
        }
    }
    assert!(
        calls > 1,
        "a market this large must require more than one delegate_market call"
    );
}
