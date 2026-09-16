//! Dedicated, versioned scoped-trading-session accounts.
//!
//! A `TradingSession` is a canonical PDA (not bytes borrowed from
//! `TraderSeat`, and not an arbitrary caller-supplied account) that lets a
//! trader's main wallet delegate a bounded set of trading actions to a
//! separate, program-held signing key without exposing the wallet's own key
//! to the client/browser. Every session-authorized trading handler validates
//! this account's PDA, ownership, target program, market, seat and signer
//! before trusting any policy field inside it -- the account is meaningless
//! on its own, only a PDA derived from the exact tuple it claims to bind is.

use core::mem::{size_of, MaybeUninit};

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::error::StockStreamError;

fn custom(error: StockStreamError) -> ProgramError {
    error.into()
}

pub const TRADING_SESSION_DISCRIMINATOR: [u8; 8] = *b"STKSES02";
pub const TRADING_SESSION_VERSION: u16 = 1;
pub const TRADING_SESSION_SEED: &[u8] = b"trading_session";
pub const TRADING_SESSION_SIZE: usize = 256;

/// Session action allowlist bits. A session's `actions` field is the
/// bitwise-OR of the actions its signer may perform; every session-signed
/// trading handler requires at least one bit of its own `required_actions`
/// mask to be set.
pub const SESSION_ACTION_PLACE: u8 = 1 << 0;
pub const SESSION_ACTION_CANCEL: u8 = 1 << 1;
pub const SESSION_ACTION_CANCEL_ALL: u8 = 1 << 2;
pub const SESSION_ACTION_REPLACE: u8 = 1 << 3;
/// Permits `PlaceOrder` only when the order carries the reduce-only flag.
/// A session holding only this bit (not `SESSION_ACTION_PLACE`) can shrink
/// risk but never open or increase a position.
pub const SESSION_ACTION_REDUCE_ONLY_CLOSE: u8 = 1 << 4;
pub const SESSION_ACTION_ALL: u8 = SESSION_ACTION_PLACE
    | SESSION_ACTION_CANCEL
    | SESSION_ACTION_CANCEL_ALL
    | SESSION_ACTION_REPLACE
    | SESSION_ACTION_REDUCE_ONLY_CLOSE;

/// Canonical PDA: `["trading_session", owner, market, seat_index_le, session_signer]`.
/// Every component of the tuple a session claims to be scoped to is a seed,
/// so a session for one (owner, market, seat, signer) combination cannot be
/// presented as authorization for any other.
pub fn derive_trading_session(
    owner: &Address,
    market: &Address,
    seat_index: u16,
    session_signer: &Address,
    program_id: &Address,
) -> Address {
    Address::find_program_address(
        &[
            TRADING_SESSION_SEED,
            owner.as_ref(),
            market.as_ref(),
            &seat_index.to_le_bytes(),
            session_signer.as_ref(),
        ],
        program_id,
    )
    .0
}

#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct TradingSession {
    pub discriminator: [u8; 8],
    pub version: u16,
    pub initialized: u8,
    pub revoked: u8,
    pub owner: [u8; 32],
    pub session_signer: [u8; 32],
    /// The StockStream program this session is scoped to. Checked against
    /// the executing `program_id` on every use; a session cannot be replayed
    /// against a different deployment of this program.
    pub target_program: [u8; 32],
    pub market: [u8; 32],
    pub trader_seat_index: u16,
    pub created_at: u64,
    pub expires_at: u64,
    pub actions: u8,
    pub max_order_notional: u64,
    pub max_cumulative_notional: u64,
    pub consumed_cumulative_notional: u64,
    pub max_exposure: i128,
    pub max_open_orders: u16,
    pub next_expected_nonce: u64,
    pub last_action_timestamp: u64,
    /// Bumped by `UpdateTradingSessionLimits`. Not itself a security
    /// boundary (the action nonce is), it's an audit/cache-invalidation
    /// counter so a client can detect that limits changed underneath it.
    pub session_generation: u32,
    pub reserved_upgrade: [u8; 35],
}

const _: [(); TRADING_SESSION_SIZE] = [(); size_of::<TradingSession>()];

impl TradingSession {
    pub const fn empty() -> Self {
        Self {
            discriminator: TRADING_SESSION_DISCRIMINATOR,
            version: TRADING_SESSION_VERSION,
            initialized: 0,
            revoked: 0,
            owner: [0; 32],
            session_signer: [0; 32],
            target_program: [0; 32],
            market: [0; 32],
            trader_seat_index: 0,
            created_at: 0,
            expires_at: 0,
            actions: 0,
            max_order_notional: 0,
            max_cumulative_notional: 0,
            consumed_cumulative_notional: 0,
            max_exposure: 0,
            max_open_orders: 0,
            next_expected_nonce: 1,
            last_action_timestamp: 0,
            session_generation: 0,
            reserved_upgrade: [0; 35],
        }
    }

    pub fn is_live(&self, now: u64) -> bool {
        self.initialized == 1 && self.revoked == 0 && self.expires_at > now
    }
}

pub fn read_session(data: &[u8]) -> Result<TradingSession, ProgramError> {
    if data.len() != TRADING_SESSION_SIZE {
        return Err(custom(StockStreamError::InvalidTradingSession));
    }
    let mut value = MaybeUninit::<TradingSession>::uninit();
    // SAFETY: length checked above; `TradingSession` is `Copy`/packed, so
    // any byte pattern is a valid instance.
    unsafe {
        core::ptr::copy_nonoverlapping(
            data.as_ptr(),
            value.as_mut_ptr().cast::<u8>(),
            size_of::<TradingSession>(),
        );
        Ok(value.assume_init())
    }
}

pub fn write_session(data: &mut [u8], session: &TradingSession) -> ProgramResult {
    if data.len() != TRADING_SESSION_SIZE {
        return Err(custom(StockStreamError::InvalidTradingSession));
    }
    // SAFETY: length checked above.
    unsafe {
        core::ptr::copy_nonoverlapping(
            session as *const TradingSession as *const u8,
            data.as_mut_ptr(),
            size_of::<TradingSession>(),
        );
    }
    Ok(())
}

/// Full account-shape validation shared by every session handler: exact
/// size, StockStream ownership, writability, and PDA. Returns the decoded
/// session so callers only need their own lifecycle/policy checks on top.
#[allow(clippy::too_many_arguments)]
pub fn validated_session_account(
    program_id: &Address,
    session_account: &AccountView,
    owner: &Address,
    market: &Address,
    seat_index: u16,
    session_signer: &Address,
    require_writable: bool,
) -> Result<TradingSession, ProgramError> {
    if require_writable && !session_account.is_writable() {
        return Err(custom(StockStreamError::InvalidTradingSession));
    }
    if !session_account.owned_by(program_id) || session_account.data_len() != TRADING_SESSION_SIZE {
        return Err(custom(StockStreamError::InvalidTradingSession));
    }
    let expected_pda =
        derive_trading_session(owner, market, seat_index, session_signer, program_id);
    if expected_pda != *session_account.address() {
        return Err(custom(StockStreamError::InvalidTradingSession));
    }
    let bytes = unsafe { session_account.borrow_unchecked() };
    let session = read_session(bytes)?;
    if session.discriminator != TRADING_SESSION_DISCRIMINATOR
        || session.version != TRADING_SESSION_VERSION
        || session.target_program != program_id.to_bytes()
        || session.owner != owner.to_bytes()
        || session.market != market.to_bytes()
        || session.session_signer != session_signer.to_bytes()
        || session.trader_seat_index != seat_index
    {
        return Err(custom(StockStreamError::InvalidTradingSession));
    }
    Ok(session)
}
