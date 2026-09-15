#![cfg(feature = "runtime-tests")]

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
    state::{MarketStateHeader, MARKET_ACCOUNT_SIZE},
    ID,
};

#[test]
fn serialized_initialize_market_executes_in_litesvm() {
    let mut svm = LiteSVM::new();
    let program_path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/stockstream.so");
    svm.add_program_from_file(ID, program_path).unwrap();

    let authority = Keypair::new();
    let market = Address::new_unique();
    svm.airdrop(&authority.pubkey(), 1_000_000_000).unwrap();
    svm.set_account(
        market,
        Account {
            lamports: 1_000_000,
            data: vec![0; MARKET_ACCOUNT_SIZE],
            owner: ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    let instruction = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(market, false),
            AccountMeta::new_readonly(authority.pubkey(), true),
        ],
        data: vec![0],
    };
    let transaction = Transaction::new(
        &[&authority],
        Message::new(&[instruction], Some(&authority.pubkey())),
        svm.latest_blockhash(),
    );
    let result = svm.send_transaction(transaction).unwrap();
    assert!(result.compute_units_consumed > 0);
    let account = svm.get_account(&market).unwrap();
    let header =
        unsafe { std::ptr::read_unaligned(account.data.as_ptr() as *const MarketStateHeader) };
    assert_eq!(header.initialized, 1);
    assert_eq!(header.market_authority, authority.pubkey().to_bytes());
}
