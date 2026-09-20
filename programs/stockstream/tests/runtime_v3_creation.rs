#![cfg(feature = "runtime-tests")]
//! Real-SVM coverage for the bounded V3 account-creation lifecycle.
//!
//! This deliberately uses a fresh registered-instrument fixture, never the
//! existing V2 Devnet market. It proves the program signs the System CPIs for
//! its own core PDA and creates a 10,184-byte book page below both the runtime
//! data-growth boundary and MagicBlock's current commit limit.

use std::path::PathBuf;

use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use stockstream::{
    registry::{
        derive_instrument, EXCHANGE_CONFIG_VERSION, EXCHANGE_DISCRIMINATOR, EXCHANGE_SIZE,
        INSTRUMENT_DISCRIMINATOR, INSTRUMENT_SIZE,
    },
    v3::{
        derive_book_page_v3, derive_market_core_v3, V3_BOOK_PAGE_SIZE, V3_LAYOUT_VERSION,
        V3_MARKET_CORE_SIZE,
    },
    ID,
};

const CREATE_V3_ACCOUNT: u8 = 46;
const INITIALIZE_V3_MARKET: u8 = 47;
const SYSTEM_PROGRAM: Address = Address::new_from_array([0; 32]);

fn program_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/stockstream.so")
}

fn solana_address(address: pinocchio::Address) -> Address {
    Address::new_from_array(address.to_bytes())
}

fn writable(address: Address) -> AccountMeta {
    AccountMeta::new(address, false)
}
fn writable_signer(address: Address) -> AccountMeta {
    AccountMeta::new(address, true)
}
fn readonly(address: Address) -> AccountMeta {
    AccountMeta::new_readonly(address, false)
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    parent: Address,
    target: Address,
    kind: u8,
    index: u8,
) -> Result<(), String> {
    // The three resume calls have identical instruction bytes and signer;
    // LiteSVM's duplicate-signature guard therefore needs a fresh blockhash
    // between them, just as separate cluster transactions naturally get.
    svm.expire_blockhash();
    let instruction = Instruction {
        program_id: solana_address(ID),
        accounts: vec![
            readonly(parent),
            writable(target),
            writable_signer(payer.pubkey()),
            readonly(SYSTEM_PROGRAM),
        ],
        data: vec![CREATE_V3_ACCOUNT, kind, index],
    };
    let message = Message::new(&[instruction], Some(&payer.pubkey()));
    let transaction = Transaction::new(&[payer], message, svm.latest_blockhash());
    svm.send_transaction(transaction)
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
}

fn activate(
    svm: &mut LiteSVM,
    authority: &Keypair,
    exchange: Address,
    instrument: Address,
    core: Address,
) -> Result<(), String> {
    svm.expire_blockhash();
    let instruction = Instruction {
        program_id: solana_address(ID),
        accounts: vec![
            readonly(exchange),
            readonly(instrument),
            writable(core),
            AccountMeta::new_readonly(authority.pubkey(), true),
        ],
        data: vec![INITIALIZE_V3_MARKET],
    };
    let message = Message::new(&[instruction], Some(&authority.pubkey()));
    let transaction = Transaction::new(&[authority], message, svm.latest_blockhash());
    svm.send_transaction(transaction)
        .map(|_| ())
        .map_err(|error| format!("{error:?}"))
}

#[test]
fn creates_core_and_resumable_book_page_with_real_system_cpis() {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(solana_address(ID), program_path())
        .expect("SBF artifact must load");
    let authority = Keypair::new();
    let impostor = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&impostor.pubkey(), 10_000_000_000).unwrap();
    let exchange = Address::new_unique();
    let mut exchange_data = vec![0; EXCHANGE_SIZE];
    exchange_data[0..8].copy_from_slice(&EXCHANGE_DISCRIMINATOR);
    exchange_data[8..10].copy_from_slice(&EXCHANGE_CONFIG_VERSION.to_le_bytes());
    exchange_data[10] = 1;
    exchange_data[11..43].copy_from_slice(authority.pubkey().as_ref());
    svm.set_account(
        exchange,
        Account {
            lamports: 1_000_000,
            data: exchange_data,
            owner: solana_address(ID),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    let pinocchio_exchange = pinocchio::Address::new_from_array(exchange.to_bytes());
    let instrument_id = [9; 32];
    let instrument = solana_address(derive_instrument(&ID, &pinocchio_exchange, &instrument_id));
    let mut instrument_data = vec![0; INSTRUMENT_SIZE];
    instrument_data[0..8].copy_from_slice(&INSTRUMENT_DISCRIMINATOR);
    instrument_data[8..10].copy_from_slice(&1u16.to_le_bytes());
    instrument_data[10] = 1;
    instrument_data[11..43].copy_from_slice(&instrument_id);
    instrument_data[75..79].copy_from_slice(&922u32.to_le_bytes());
    instrument_data[79] = 1;
    instrument_data[107..111].copy_from_slice(&(-6i32).to_le_bytes());
    svm.set_account(
        instrument,
        Account {
            lamports: 1_000_000,
            data: instrument_data,
            owner: solana_address(ID),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let pinocchio_instrument = pinocchio::Address::new_from_array(instrument.to_bytes());
    let core = solana_address(derive_market_core_v3(&ID, &pinocchio_instrument));
    send(&mut svm, &authority, instrument, core, 0, 0).expect("create V3 core");
    let core_account = svm.get_account(&core).expect("core created");
    assert_eq!(core_account.owner, solana_address(ID));
    assert_eq!(core_account.data.len(), V3_MARKET_CORE_SIZE);
    assert_eq!(&core_account.data[0..8], b"STKMK003");
    assert_eq!(core_account.data[10], 1);
    assert!(
        activate(&mut svm, &impostor, exchange, instrument, core).is_err(),
        "non-listing authority cannot activate V3 core"
    );
    activate(&mut svm, &authority, exchange, instrument, core).expect("activate V3 core");
    let active_core = svm.get_account(&core).expect("activated core");
    assert_eq!(active_core.data[11], 1);
    assert_eq!(&active_core.data[44..76], authority.pubkey().as_ref());
    assert_eq!(&active_core.data[246..250], &922u32.to_le_bytes());
    assert_eq!(active_core.data[250], 1);
    assert_eq!(&active_core.data[251..255], &(-6i32).to_le_bytes());
    assert!(
        activate(&mut svm, &authority, exchange, instrument, core).is_err(),
        "activation is one-time"
    );

    let pinocchio_core = pinocchio::Address::new_from_array(core.to_bytes());
    // The V3 creation opcode uses a flattened book-page index: 7 is side 0,
    // page 7 (the same mapping used by `derive_v3_account`).
    let page = solana_address(derive_book_page_v3(&ID, &pinocchio_core, 0, 7));
    for expected_len in [V3_BOOK_PAGE_SIZE] {
        send(&mut svm, &authority, core, page, 1, 7).expect("resume V3 book-page creation");
        assert_eq!(
            svm.get_account(&page).expect("page exists").data.len(),
            expected_len
        );
    }
    let page_account = svm.get_account(&page).expect("page completed");
    assert_eq!(page_account.owner, solana_address(ID));
    assert_eq!(&page_account.data[0..8], b"STKBK003");
    assert_eq!(page_account.data[8..10], V3_LAYOUT_VERSION.to_le_bytes());
    assert_eq!(&page_account.data[10..12], &[0, 7]);
    assert_eq!(&page_account.data[12..44], core.as_ref());
}
