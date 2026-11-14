// `new` takes its settings as named JSON args (8 since the deposit caps); the near macro's generated wrapper
// can't carry a per-function allow, and grouping the args would change the API.
#![allow(clippy::too_many_arguments)]
//! Sledgit vault.
//!
//! Funds sit in this contract. An agent account may only ask for swaps; each request is checked against a
//! fixed policy and then executed on a Rhea (Ref) exchange as deposit -> swap -> withdraw, so the output
//! amount is known exactly. Only the owner withdraws, and only to itself. Every decision (trade, refusal,
//! skip, failure) is an event carrying the agent's receipt hash; the public record is built from these.
//!
//! A second venue, NEAR Intents, is in `intents.rs`: the vault signs intents itself through Chain Signatures.
//!
//! Prices: every allowed pair has an owner-set Rhea pool and price band (both timelocked like any rule), so a
//! request is never priced off a pool or a price the agent chose. Caps apply over a rolling 24 hours.
//!
//! The vault account is meant to have no access keys after deployment, so the code cannot change.
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

mod intents;
mod policy;
pub use intents::{IntentStage, OpenIntent, MPC_PATH};
pub use policy::{Pair, Policy, TokenLimit};

pub const HOUR_NS: u64 = 3_600 * 1_000_000_000;
pub const DAY_NS: u64 = 24 * HOUR_NS;
pub const TIMELOCK_NS: u64 = DAY_NS;
pub const STUCK_NS: u64 = 15 * 60 * 1_000_000_000;
const WINDOW_HOURS: u64 = 24;
pub(crate) const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// NEAR kept back on withdraw_near for gas and the 1-yocto deposits swaps attach.
const NEAR_RESERVE: NearToken = NearToken::from_millinear(500);

// Static gas per hop, in Tgas. Each callback reserves what the rest of the chain needs.
const TG_VIEW: u64 = 10;
/// A token balance view (the vault's own balance, read before and after the payout).
const TG_SMALL_VIEW: u64 = 5;
const TG_FT_TRANSFER_CALL: u64 = 60;
const TG_SWAP: u64 = 60; // DEGEN_SWAP pools burn more than 30
const TG_WITHDRAW: u64 = 60;
const TG_FT_TRANSFER: u64 = 15;
const TG_ON_MOVED: u64 = 5;
const TG_ON_VERIFY: u64 = 10;
const TG_ON_WITHDRAW: u64 = TG_SMALL_VIEW + TG_ON_VERIFY + 5;
const TG_ON_SWAP: u64 = TG_WITHDRAW + TG_ON_WITHDRAW + 5;
const TG_ON_DEPOSIT: u64 = TG_SWAP + 2 * TG_SMALL_VIEW + TG_ON_SWAP + 10;
const TG_ON_QUOTE: u64 = TG_FT_TRANSFER_CALL + TG_ON_DEPOSIT + 10;
/// A vault trades for this long after creation, so old versions sunset on their own.
pub const TRADING_DAYS: u64 = 30;
pub const TG_MIN_REQUEST: u64 = TG_VIEW + TG_ON_QUOTE + 20;
/// balance → withdraw → balance → record.
pub const TG_MIN_EXCHANGE_WITHDRAW: u64 = TG_VIEW + TG_WITHDRAW + TG_VIEW + TG_ON_MOVED + 15 + 20;
/// balance → claim_lostfound → balance → record.
pub const TG_MIN_CLAIM_LOSTFOUND: u64 = TG_MIN_EXCHANGE_WITHDRAW;
const MAX_NOTE: usize = 280;

pub(crate) const fn tgas(n: u64) -> Gas { Gas::from_tgas(n) }

/// Lowest acceptable output: the quote less a slippage allowance (no overflow for any u128).
pub(crate) fn floor(quote: u128, slippage_bps: u16) -> u128 {
    let keep = 10_000 - slippage_bps as u128;
    quote / 10_000 * keep + quote % 10_000 * keep / 10_000
}

#[near(serializers = [json])]
pub struct SwapAction {
    pub pool_id: u64,
    pub token_in: AccountId,
    pub amount_in: Option<U128>,
    pub token_out: AccountId,
    pub min_amount_out: U128,
}

#[allow(dead_code)]
#[ext_contract(ext_exchange)]
trait Exchange {
    fn get_return(&self, pool_id: u64, token_in: AccountId, amount_in: U128, token_out: AccountId) -> U128;
    fn swap(&mut self, actions: Vec<SwapAction>, referral_id: Option<AccountId>) -> U128;
    fn withdraw(&mut self, token_id: AccountId, amount: U128, unregister: Option<bool>, skip_unwrap_near: Option<bool>);
    fn register_tokens(&mut self, token_ids: Vec<AccountId>);
    fn get_deposit(&self, account_id: AccountId, token_id: AccountId) -> U128;
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
    fn claim_lostfound(&mut self, token_id: AccountId);
}

#[allow(dead_code)]
#[ext_contract(ext_ft)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> U128;
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Stage { Quote, Deposit, Swap, Withdraw }

/// The one Rhea swap allowed in flight at a time. Pricing inputs are fixed at request time.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct InFlight {
    pub seq: u64,
    pub pool_id: u64,
    pub token_in: AccountId,
    pub token_out: AccountId,
    pub amount_in: U128,
    pub min_amount_out: U128,
    pub band_floor: U128,
    pub slippage_bps: u16,
    pub receipt_hash: String,
    pub started_at: U64,
    pub reserved_hour: U64,
    pub stage: Stage,
}

/// Spending over a rolling 24 hours: per token, one bucket per hour (bucket = hour % 24).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Usage {
    pub hour: U64,
    pub spent: Vec<(AccountId, Vec<U128>)>,
    /// Trades started in the current clock hour.
    pub trades: u32,
}

impl Usage {
    fn rolled_to(&self, now_hour: u64) -> Usage {
        let mut u = self.clone();
        if now_hour > u.hour.0 {
            let gap = now_hour - u.hour.0;
            for (_, b) in u.spent.iter_mut() {
                if gap >= WINDOW_HOURS { b.iter_mut().for_each(|x| *x = U128(0)); }
                else { for h in u.hour.0 + 1..=now_hour { b[(h % WINDOW_HOURS) as usize] = U128(0); } }
            }
            u.hour = U64(now_hour);
            u.trades = 0;
        }
        u
    }

    pub fn spent_24h(&self, token: &AccountId) -> u128 {
        self.spent.iter().find(|(t, _)| t == token).map(|(_, b)| b.iter().map(|x| x.0).sum()).unwrap_or(0)
    }

    fn add(&mut self, token: &AccountId, amount: u128) {
        let i = (self.hour.0 % WINDOW_HOURS) as usize;
        match self.spent.iter_mut().find(|(t, _)| t == token) {
            Some((_, b)) => b[i].0 += amount,
            None => {
                let mut b = vec![U128(0); WINDOW_HOURS as usize];
                b[i] = U128(amount);
                self.spent.push((token.clone(), b));
            }
        }
    }

    /// Undo a reservation made in `hour`, if that hour is still inside the window.
    fn sub(&mut self, token: &AccountId, amount: u128, hour: u64) {
        if self.hour.0.saturating_sub(hour) >= WINDOW_HOURS { return; }
        if let Some((_, b)) = self.spent.iter_mut().find(|(t, _)| t == token) {
            let x = &mut b[(hour % WINDOW_HOURS) as usize];
            x.0 = x.0.saturating_sub(amount);
        }
    }
}

#[near(serializers = [json])]
pub struct UsageView {
    pub hour: U64,
    pub trades: u32,
    /// Per token: total over the last 24 hours.
    pub spent: Vec<(AccountId, U128)>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Pending<T> {
    pub value: T,
    pub applies_at: U64,
}

/// Ceiling on the owner's `ft_transfer_call` deposits of one token, net of withdrawals. Set once at init (by the
/// factory). Not a ceiling on holdings: plain `ft_transfer` and intents transfers into the vault aren't counted.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct DepositCap {
    pub token: AccountId,
    pub max: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner_id: AccountId,
    proposed_owner: Option<AccountId>,
    agent_id: AccountId,
    exchange_id: AccountId,
    policy: Policy,
    pending_policy: Option<Pending<Policy>>,
    frozen: bool,
    in_flight: Option<InFlight>,
    usage: Usage,
    seq: u64,
    intents_id: AccountId,
    mpc_id: AccountId,
    /// This vault's Chain Signatures key, set once intents.near has registered it (`intents_setup`).
    intents_key: Option<String>,
    open_intent: Option<OpenIntent>,
    /// Start of an owner exchange operation (withdraw or lostfound claim) whose balance-before/after measurement a
    /// swap must not overlap. Treated as over after STUCK_NS in case its callbacks never came back.
    exchange_op_since: Option<U64>,
    /// Empty = no cap. Otherwise a token without an entry can't be deposited at all.
    deposit_caps: Vec<DepositCap>,
    /// Owner deposits less owner withdrawals, per token (never below 0, so withdrawn gains free room again).
    net_deposits: Vec<(AccountId, u128)>,
    /// Trading stops here (creation + TRADING_DAYS); withdrawals never do.
    trading_ends_ns: u64,
}

fn validate_caps(caps: &[DepositCap]) {
    require!(caps.len() <= policy::MAX_TOKENS, "too many deposit caps");
    for (i, c) in caps.iter().enumerate() {
        require!(c.max.0 > 0, "deposit cap must be above 0");
        require!(caps[..i].iter().all(|d| d.token != c.token), "duplicate deposit cap");
    }
}

pub(crate) fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "sledgit", "version": "1.2.0", "event": event, "data": [data]})
    ));
}

pub(crate) fn valid_hash(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(crate) fn now_hour() -> u64 { env::block_timestamp() / HOUR_NS }

/// Longest reply we read from another contract; anything longer counts as a failure.
const MAX_RESULT_LEN: usize = 128;

/// Bounded promise result: never panics, and a huge reply cannot burn the callback's gas.
pub(crate) fn result_bytes() -> Option<Vec<u8>> {
    if env::promise_results_count() != 1 { return None; }
    env::promise_result_checked(0, MAX_RESULT_LEN).ok()
}

pub(crate) fn result_u128() -> Option<u128> {
    result_bytes().and_then(|b| near_sdk::serde_json::from_slice::<U128>(&b).ok()).map(|v| v.0)
}

#[near]
impl Vault {
    /// Initialise in the same transaction that deploys the code: either signed by the vault account itself (then delete
    /// its keys), or by its parent account, which is how the factory creates keyless vaults in one atomic batch.
    #[init]
    pub fn new(owner_id: AccountId, agent_id: AccountId, exchange_id: AccountId, intents_id: AccountId, mpc_id: AccountId,
               policy: Policy, deposit_caps: Option<Vec<DepositCap>>) -> Self {
        let me = env::current_account_id();
        let caller = env::predecessor_account_id();
        require!(caller == me || me.is_sub_account_of(&caller), "only the vault account or its parent may initialise it");
        require!(owner_id != agent_id, "owner and agent must differ");
        require!(owner_id != me && agent_id != me, "owner and agent must be separate accounts");
        policy.validate();
        let deposit_caps = deposit_caps.unwrap_or_default();
        validate_caps(&deposit_caps);
        emit("init", json!({"owner_id": owner_id, "agent_id": agent_id, "exchange_id": exchange_id, "intents_id": intents_id,
            "mpc_id": mpc_id, "policy": policy, "deposit_caps": deposit_caps}));
        Self { owner_id, proposed_owner: None, agent_id, exchange_id, policy, pending_policy: None, frozen: false,
            in_flight: None, usage: Usage { hour: U64(now_hour()), ..Default::default() }, seq: 0, intents_id, mpc_id,
            intents_key: None, open_intent: None, exchange_op_since: None, deposit_caps, net_deposits: Vec::new(),
            trading_ends_ns: env::block_timestamp() + TRADING_DAYS * 86_400 * 1_000_000_000 }
    }

    // ---------------------------------------------------------------- agent

    /// Ask for a Rhea swap. Policy breaches are recorded as refusals (no panic, so the event persists).
    pub fn request_swap(&mut self, token_in: AccountId, token_out: AccountId, amount_in: U128, min_amount_out: U128,
                        receipt_hash: String) -> PromiseOrValue<bool> {
        self.assert_agent();
        require!(valid_hash(&receipt_hash), "receipt_hash must be 64 lowercase hex chars");
        require!(env::prepaid_gas() >= tgas(TG_MIN_REQUEST), format!("attach at least {TG_MIN_REQUEST} Tgas"));
        self.seq += 1;
        let seq = self.seq;
        self.usage = self.rolled();
        let pair = match self.check(&self.usage, &token_in, &token_out, amount_in.0, min_amount_out.0) {
            Ok(p) => p,
            Err((code, why)) => {
                emit("refuse", json!({"seq": seq, "receipt_hash": receipt_hash, "venue": "rhea", "token_in": token_in,
                    "token_out": token_out, "amount_in": amount_in, "code": code, "reason": why}));
                return PromiseOrValue::Value(false);
            }
        };
        // Reserve the caps before any async call: nothing can slip through the gap.
        self.reserve(&token_in, amount_in.0);
        emit("request", json!({"seq": seq, "receipt_hash": receipt_hash, "venue": "rhea", "pool_id": pair.pool_id,
            "token_in": token_in, "token_out": token_out, "amount_in": amount_in, "min_amount_out": min_amount_out}));
        let band = pair.band_floor(amount_in.0).unwrap_or(u128::MAX);
        self.in_flight = Some(InFlight { seq, pool_id: pair.pool_id, token_in: token_in.clone(), token_out: token_out.clone(),
            amount_in, min_amount_out, band_floor: U128(band), slippage_bps: self.policy.max_slippage_bps, receipt_hash,
            started_at: U64(env::block_timestamp()), reserved_hour: self.usage.hour, stage: Stage::Quote });
        PromiseOrValue::Promise(
            ext_exchange::ext(self.exchange_id.clone()).with_static_gas(tgas(TG_VIEW))
                .get_return(pair.pool_id, token_in, amount_in, token_out)
                .then(Self::ext(env::current_account_id()).with_static_gas(tgas(TG_ON_QUOTE)).with_unused_gas_weight(0)
                    .on_quote(seq)),
        )
    }

    /// Record a decision not to trade.
    pub fn log_skip(&mut self, receipt_hash: String, note: String) {
        self.assert_agent();
        require!(valid_hash(&receipt_hash), "receipt_hash must be 64 lowercase hex chars");
        require!(note.len() <= MAX_NOTE, "note too long");
        self.seq += 1;
        emit("skip", json!({"seq": self.seq, "receipt_hash": receipt_hash, "note": note}));
    }

    // ---------------------------------------------------------------- swap chain (private callbacks)

    #[private]
    pub fn on_quote(&mut self, seq: u64) -> PromiseOrValue<bool> {
        let Some(f) = self.current(seq) else { return PromiseOrValue::Value(false) };
        if self.frozen { return self.fail(seq, "vault frozen before the swap", true); }
        let Some(quote) = result_u128().filter(|q| *q > 0) else { return self.fail(seq, "quote failed", true) };
        if f.band_floor.0 > quote {
            return self.fail(seq, &format!("Rhea quote {quote} below the price band {}", f.band_floor.0), true);
        }
        if f.min_amount_out.0 > quote {
            return self.fail(seq, &format!("min_amount_out {} above the exchange quote {}", f.min_amount_out.0, quote), true);
        }
        let min_out = f.min_amount_out.0.max(floor(quote, f.slippage_bps)).max(f.band_floor.0);
        self.set_stage(Stage::Deposit, Some(U128(min_out)));
        PromiseOrValue::Promise(
            ext_ft::ext(f.token_in.clone()).with_attached_deposit(ONE_YOCTO).with_static_gas(tgas(TG_FT_TRANSFER_CALL))
                .ft_transfer_call(self.exchange_id.clone(), f.amount_in, None, String::new())
                .then(Self::ext(env::current_account_id()).with_static_gas(tgas(TG_ON_DEPOSIT)).with_unused_gas_weight(0)
                    .on_deposit(seq, U128(quote))),
        )
    }

    #[private]
    pub fn on_deposit(&mut self, seq: u64, quote: U128) -> PromiseOrValue<bool> {
        let Some(f) = self.current(seq) else { return PromiseOrValue::Value(false) };
        // ft_transfer_call returns the amount the receiver kept.
        let used = result_u128().unwrap_or(0);
        if used == 0 { return self.fail(seq, "deposit to exchange failed", true); }
        if used != f.amount_in.0 {
            // Partial deposit: whatever arrived sits in the vault's exchange balance; owner recovers it.
            return self.fail(seq, &format!("partial deposit {used}; recover with exchange_withdraw"), false);
        }
        self.set_stage(Stage::Swap, None);
        let action = SwapAction { pool_id: f.pool_id, token_in: f.token_in.clone(), amount_in: Some(f.amount_in),
            token_out: f.token_out.clone(), min_amount_out: f.min_amount_out };
        // The vault's own balances before the payout: only what then arrives counts as back (see on_verify).
        let balance = |t: &AccountId| ext_ft::ext(t.clone()).with_static_gas(tgas(TG_SMALL_VIEW)).ft_balance_of(env::current_account_id());
        PromiseOrValue::Promise(
            ext_exchange::ext(self.exchange_id.clone()).with_attached_deposit(ONE_YOCTO).with_static_gas(tgas(TG_SWAP))
                .swap(vec![action], None)
                .and(balance(&f.token_out)).and(balance(&f.token_in))
                .then(Self::ext(env::current_account_id()).with_static_gas(tgas(TG_ON_SWAP)).with_unused_gas_weight(0)
                    .on_swap(seq, quote)),
        )
    }

    /// Results: the swap's output, then the vault's balance of token_out and of token_in before the payout.
    #[private]
    pub fn on_swap(&mut self, seq: u64, quote: U128) -> PromiseOrValue<bool> {
        let Some(f) = self.current(seq) else { return PromiseOrValue::Value(false) };
        self.set_stage(Stage::Withdraw, None);
        let read = |i: u64| (env::promise_results_count() == 3).then(|| env::promise_result_checked(i, MAX_RESULT_LEN).ok()).flatten()
            .and_then(|b| near_sdk::serde_json::from_slice::<U128>(&b).ok()).map(|v| v.0);
        let (token, amount, ok, before) = match read(0).filter(|o| *o > 0) {
            Some(out) => (f.token_out.clone(), out, true, read(1)),
            // Swap failed (e.g. slippage): bring the input back.
            None => (f.token_in.clone(), f.amount_in.0, false, read(2)),
        };
        PromiseOrValue::Promise(
            ext_exchange::ext(self.exchange_id.clone()).with_attached_deposit(ONE_YOCTO).with_static_gas(tgas(TG_WITHDRAW))
                .withdraw(token.clone(), U128(amount), None, Some(true))
                .then(Self::ext(env::current_account_id()).with_static_gas(tgas(TG_ON_WITHDRAW)).with_unused_gas_weight(0)
                    .on_withdraw(seq, quote, ok, token, U128(amount), before.map(U128))),
        )
    }

    /// Rhea's withdraw swallows a failed payout: it re-credits the vault on the exchange, parks it in the vault's
    /// lostfound, or (when it lacks spare NEAR) hands it to the exchange's owner. A successful promise proves nothing,
    /// so the payout counts as back only if the vault's own balance went up by the amount.
    #[private]
    pub fn on_withdraw(&mut self, seq: u64, quote: U128, swapped: bool, token: AccountId, amount: U128, before: Option<U128>) -> PromiseOrValue<bool> {
        if self.current(seq).is_none() { return PromiseOrValue::Value(false) };
        if result_bytes().is_none() || before.is_none() {
            return PromiseOrValue::Value(self.settle(seq, quote, swapped, token, amount, false));
        }
        PromiseOrValue::Promise(
            ext_ft::ext(token.clone()).with_static_gas(tgas(TG_SMALL_VIEW)).ft_balance_of(env::current_account_id())
                .then(Self::ext(env::current_account_id()).with_static_gas(tgas(TG_ON_VERIFY)).with_unused_gas_weight(0)
                    .on_verify(seq, quote, swapped, token, amount, before.unwrap_or(U128(0)))),
        )
    }

    #[private]
    pub fn on_verify(&mut self, seq: u64, quote: U128, swapped: bool, token: AccountId, amount: U128, before: U128) -> bool {
        let back = result_u128().is_some_and(|after| after.saturating_sub(before.0) >= amount.0);
        self.settle(seq, quote, swapped, token, amount, back)
    }

    // ---------------------------------------------------------------- deposits

    /// Accept tokens only from the owner and only allowed tokens; refund everything else.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let _ = msg;
        let token = env::predecessor_account_id();
        if sender_id != self.owner_id || self.policy.limit(&token).is_none() {
            return PromiseOrValue::Value(amount);
        }
        let room = self.deposit_room(&token);
        let accepted = room.map_or(amount.0, |r| r.min(amount.0));
        if accepted == 0 {
            emit("deposit_refused", json!({"token": token, "amount": amount, "code": "deposit_cap"}));
            return PromiseOrValue::Value(amount);
        }
        self.add_net(&token, accepted);
        let returned = amount.0 - accepted;
        if returned > 0 { emit("deposit", json!({"token": token, "amount": U128(accepted), "returned": U128(returned), "code": "deposit_cap"})); }
        else { emit("deposit", json!({"token": token, "amount": U128(accepted)})); }
        PromiseOrValue::Value(U128(returned))
    }

    // ---------------------------------------------------------------- factory

    /// The factory (this vault's direct parent) pushes the current beta deposit caps. Caps only gate new owner
    /// deposits: no funds move, and limits, agent, freeze and withdrawals are untouched.
    pub fn set_deposit_caps(&mut self, deposit_caps: Vec<DepositCap>) {
        let me = env::current_account_id();
        let parent = me.as_str().split_once('.').map(|x| x.1);
        require!(parent == Some(env::predecessor_account_id().as_str()), "only the vault's parent (its factory)");
        validate_caps(&deposit_caps);
        emit("deposit_caps_set", json!({"deposit_caps": deposit_caps}));
        self.deposit_caps = deposit_caps;
    }

    // ---------------------------------------------------------------- owner

    /// Withdraw any token, to the owner only. The `withdraw` event is emitted once the transfer succeeded.
    #[payable]
    pub fn withdraw(&mut self, token: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0, "zero amount");
        ext_ft::ext(token.clone()).with_attached_deposit(ONE_YOCTO).with_static_gas(tgas(TG_FT_TRANSFER))
            .ft_transfer(self.owner_id.clone(), amount, Some("sledgit withdraw".into()))
            .then(Self::ext(env::current_account_id()).with_static_gas(tgas(TG_ON_MOVED)).on_moved("withdraw".into(), token.to_string(), amount, self.owner_id.clone()))
    }

    /// Withdraw native NEAR to the owner, keeping storage plus a gas reserve.
    #[payable]
    pub fn withdraw_near(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        let locked = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
        let free = env::account_balance().saturating_sub(locked).saturating_sub(NEAR_RESERVE);
        require!(amount.0 > 0 && amount.0 <= free.as_yoctonear(), "amount above free balance");
        Promise::new(self.owner_id.clone()).transfer(NearToken::from_yoctonear(amount.0))
            .then(Self::ext(env::current_account_id()).with_static_gas(tgas(TG_ON_MOVED)).on_moved("withdraw".into(), "near".into(), amount, self.owner_id.clone()))
    }

    /// Records a movement of funds only after it happened. Replies carrying an amount (ft_transfer_call,
    /// ft_withdraw) are recorded at that amount; zero or failure is recorded as `<kind>_failed`.
    #[private]
    pub fn on_moved(&mut self, kind: String, token: String, amount: U128, to: AccountId) -> bool {
        let moved = result_bytes().map(|b| near_sdk::serde_json::from_slice::<U128>(&b).map(|v| v.0).unwrap_or(amount.0));
        match moved {
            Some(m) if m > 0 => {
                if kind == "withdraw" && to == self.owner_id { self.sub_net(&token, m); }
                emit(&kind, json!({"token": token, "amount": U128(m), "to": to})); true
            }
            _ => { emit(&format!("{kind}_failed"), json!({"token": token, "amount": amount})); false }
        }
    }

    /// Stop all trading at once. The agent may also pull this brake. An already-signed intent stays fillable until
    /// its deadline (at most 2 minutes): cancel it with `intents_cancel`, or empty the intents balance.
    #[payable]
    pub fn freeze(&mut self) {
        let who = env::predecessor_account_id();
        if who == self.owner_id { require!(env::attached_deposit() == ONE_YOCTO, "attach 1 yoctoNEAR"); }
        else { require!(who == self.agent_id, "owner or agent only"); }
        self.frozen = true;
        emit("freeze", json!({"by": who}));
    }

    #[payable]
    pub fn unfreeze(&mut self) {
        self.assert_owner();
        self.frozen = false;
        emit("unfreeze", json!({}));
    }

    /// New rules apply only after the timelock, so the record always shows them in advance.
    #[payable]
    pub fn propose_policy(&mut self, policy: Policy) {
        self.assert_owner();
        policy.validate();
        let applies_at = env::block_timestamp() + TIMELOCK_NS;
        if self.pending_policy.is_some() { emit("policy_cancelled", json!({"replaced": true})); }
        emit("policy_proposed", json!({"policy": policy, "applies_at": U64(applies_at)}));
        self.pending_policy = Some(Pending { value: policy, applies_at: U64(applies_at) });
    }

    /// Anyone may apply a proposed policy once its timelock has passed.
    pub fn apply_policy(&mut self) {
        let applies_at = self.pending_policy.as_ref().map(|p| p.applies_at.0).unwrap_or_else(|| env::panic_str("no pending policy"));
        require!(env::block_timestamp() >= applies_at, "timelock not over");
        let p = self.pending_policy.take().unwrap();
        emit("policy_applied", json!({"policy": p.value}));
        self.policy = p.value;
    }

    #[payable]
    pub fn cancel_policy(&mut self) {
        self.assert_owner();
        require!(self.pending_policy.take().is_some(), "no pending policy");
        emit("policy_cancelled", json!({}));
    }

    #[payable]
    pub fn set_agent(&mut self, agent_id: AccountId) {
        self.assert_owner();
        require!(agent_id != self.owner_id && agent_id != env::current_account_id()
            && self.proposed_owner.as_ref() != Some(&agent_id), "agent must be a separate account");
        emit("agent_set", json!({"old": self.agent_id, "new": agent_id}));
        self.agent_id = agent_id;
    }

    /// Two-step ownership transfer: the new owner must accept.
    #[payable]
    pub fn propose_owner(&mut self, owner_id: AccountId) {
        self.assert_owner();
        require!(owner_id != self.agent_id && owner_id != env::current_account_id(), "owner must be a separate account");
        emit("owner_proposed", json!({"owner_id": owner_id}));
        self.proposed_owner = Some(owner_id);
    }

    #[payable]
    pub fn accept_owner(&mut self) {
        require!(env::attached_deposit() == ONE_YOCTO, "attach 1 yoctoNEAR");
        let who = env::predecessor_account_id();
        require!(self.proposed_owner.as_ref() == Some(&who), "not the proposed owner");
        require!(who != self.agent_id, "owner and agent must differ");
        emit("owner_set", json!({"old": self.owner_id, "new": who}));
        self.owner_id = who;
        self.proposed_owner = None;
    }

    /// Pay the exchange's storage for this vault (forwards the attached NEAR).
    #[payable]
    pub fn exchange_storage_deposit(&mut self) -> Promise {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
        let deposit = env::attached_deposit();
        require!(deposit > ONE_YOCTO, "attach NEAR for exchange storage");
        ext_exchange::ext(self.exchange_id.clone()).with_attached_deposit(deposit).with_static_gas(tgas(TG_VIEW))
            .storage_deposit(None, Some(false))
    }

    #[payable]
    pub fn exchange_register_tokens(&mut self) -> Promise {
        self.assert_owner();
        let tokens: Vec<AccountId> = self.policy.tokens.iter().map(|t| t.token.clone()).collect();
        ext_exchange::ext(self.exchange_id.clone()).with_attached_deposit(ONE_YOCTO).with_static_gas(tgas(TG_VIEW))
            .register_tokens(tokens)
    }

    /// Bring back a balance left on the exchange after a failed or partial swap. Rhea's withdraw reports success even
    /// when it kept the payout, so what moved is measured as the vault's exchange balance before minus after.
    #[payable]
    pub fn exchange_withdraw(&mut self, token: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        require!(self.in_flight.is_none(), "a swap is in flight");
        require!(!self.exchange_busy(), "another exchange operation is running");
        require!(env::prepaid_gas() >= tgas(TG_MIN_EXCHANGE_WITHDRAW), format!("attach at least {TG_MIN_EXCHANGE_WITHDRAW} Tgas"));
        self.exchange_op_since = Some(U64(env::block_timestamp()));
        ext_exchange::ext(self.exchange_id.clone()).with_static_gas(tgas(TG_VIEW))
            .get_deposit(env::current_account_id(), token.clone())
            .then(Self::ext(env::current_account_id()).with_static_gas(tgas(TG_WITHDRAW + TG_VIEW + TG_ON_MOVED + 15))
                .on_exchange_before(token, amount))
    }

    #[private]
    pub fn on_exchange_before(&mut self, token: AccountId, amount: U128) -> PromiseOrValue<bool> {
        let Some(before) = result_u128() else {
            self.exchange_op_since = None;
            emit("exchange_withdraw_failed", json!({"token": token, "amount": amount, "reason": "balance unavailable"}));
            return PromiseOrValue::Value(false);
        };
        PromiseOrValue::Promise(
            ext_exchange::ext(self.exchange_id.clone()).with_attached_deposit(ONE_YOCTO).with_static_gas(tgas(TG_WITHDRAW))
                .withdraw(token.clone(), amount, None, Some(true))
                .then(ext_exchange::ext(self.exchange_id.clone()).with_static_gas(tgas(TG_VIEW))
                    .get_deposit(env::current_account_id(), token.clone()))
                .then(Self::ext(env::current_account_id()).with_static_gas(tgas(TG_ON_MOVED)).on_exchange_after(token, amount, U128(before))),
        )
    }

    #[private]
    pub fn on_exchange_after(&mut self, token: AccountId, amount: U128, before: U128) -> bool {
        self.exchange_op_since = None;
        let moved = result_u128().map(|after| before.0.saturating_sub(after)).unwrap_or(0);
        if moved == 0 {
            emit("exchange_withdraw_failed", json!({"token": token, "amount": amount, "reason": "the exchange balance did not go down"}));
            return false;
        }
        emit("exchange_withdraw", json!({"token": token, "amount": U128(moved), "to": env::current_account_id()}));
        true
    }

    /// Claim tokens Rhea parked in this vault's lostfound (a payout it couldn't deliver or re-credit). What arrived is
    /// measured as the vault's own token balance after minus before.
    #[payable]
    pub fn exchange_claim_lostfound(&mut self, token: AccountId) -> Promise {
        self.assert_owner();
        require!(self.in_flight.is_none(), "a swap is in flight");
        require!(!self.exchange_busy(), "another exchange operation is running");
        require!(env::prepaid_gas() >= tgas(TG_MIN_CLAIM_LOSTFOUND), format!("attach at least {TG_MIN_CLAIM_LOSTFOUND} Tgas"));
        self.exchange_op_since = Some(U64(env::block_timestamp()));
        ext_ft::ext(token.clone()).with_static_gas(tgas(TG_VIEW)).ft_balance_of(env::current_account_id())
            .then(Self::ext(env::current_account_id()).with_static_gas(tgas(TG_WITHDRAW + TG_VIEW + TG_ON_MOVED + 15))
                .on_claim_before(token))
    }

    #[private]
    pub fn on_claim_before(&mut self, token: AccountId) -> PromiseOrValue<bool> {
        let Some(before) = result_u128() else {
            self.exchange_op_since = None;
            emit("exchange_lostfound_claim_failed", json!({"token": token, "reason": "balance unavailable"}));
            return PromiseOrValue::Value(false);
        };
        PromiseOrValue::Promise(
            ext_exchange::ext(self.exchange_id.clone()).with_attached_deposit(ONE_YOCTO).with_static_gas(tgas(TG_WITHDRAW))
                .claim_lostfound(token.clone())
                .then(ext_ft::ext(token.clone()).with_static_gas(tgas(TG_VIEW)).ft_balance_of(env::current_account_id()))
                .then(Self::ext(env::current_account_id()).with_static_gas(tgas(TG_ON_MOVED)).on_claim_after(token, U128(before))),
        )
    }

    #[private]
    pub fn on_claim_after(&mut self, token: AccountId, before: U128) -> bool {
        self.exchange_op_since = None;
        let arrived = result_u128().map(|after| after.saturating_sub(before.0)).unwrap_or(0);
        if arrived == 0 {
            emit("exchange_lostfound_claim_failed", json!({"token": token, "reason": "the vault's balance did not go up"}));
            return false;
        }
        emit("exchange_lostfound_claim", json!({"token": token, "amount": U128(arrived), "to": env::current_account_id()}));
        true
    }

    /// Release a swap whose callbacks never came back. Funds are not moved; reconcile with exchange_withdraw.
    #[payable]
    pub fn clear_stuck(&mut self) {
        self.assert_owner();
        let started = self.in_flight.as_ref().map(|f| f.started_at.0).unwrap_or_else(|| env::panic_str("nothing in flight"));
        require!(env::block_timestamp() >= started.saturating_add(STUCK_NS), "not stuck yet");
        let f = self.in_flight.take().unwrap();
        emit("failed", json!({"seq": f.seq, "receipt_hash": f.receipt_hash, "reason": "cleared as stuck", "stage": f.stage}));
    }

    // ---------------------------------------------------------------- views

    pub fn get_config(&self) -> Value {
        json!({"owner_id": self.owner_id, "proposed_owner": self.proposed_owner, "agent_id": self.agent_id,
            "exchange_id": self.exchange_id, "intents_id": self.intents_id, "mpc_id": self.mpc_id, "frozen": self.frozen,
            "seq": self.seq, "trading_ends_ns": U64(self.trading_ends_ns), "version": env!("CARGO_PKG_VERSION")})
    }
    /// Each cap with what the owner has deposited net of withdrawals (empty = no cap).
    pub fn get_deposit_caps(&self) -> Value {
        json!(self.deposit_caps.iter().map(|c| json!({"token": c.token, "max": c.max,
            "net_deposited": U128(self.net_of(c.token.as_str()))})).collect::<Vec<_>>())
    }
    pub fn get_policy(&self) -> Policy { self.policy.clone() }
    pub fn get_pending_policy(&self) -> Option<Pending<Policy>> { self.pending_policy.clone() }
    pub fn get_in_flight(&self) -> Option<InFlight> { self.in_flight.clone() }
    pub fn get_usage(&self) -> UsageView {
        let u = self.rolled();
        UsageView { hour: u.hour, trades: u.trades,
            spent: u.spent.iter().map(|(t, _)| (t.clone(), U128(u.spent_24h(t)))).collect() }
    }

    /// Free dry run for agents: would this request pass the policy right now, and at what price floor?
    pub fn preview_swap(&self, token_in: AccountId, token_out: AccountId, amount_in: U128, min_amount_out: U128) -> Value {
        match self.check(&self.rolled(), &token_in, &token_out, amount_in.0, min_amount_out.0) {
            Ok(p) => json!({"ok": true, "pool_id": p.pool_id, "band_floor": U128(p.band_floor(amount_in.0).unwrap_or(u128::MAX))}),
            Err((code, reason)) => json!({"ok": false, "code": code, "reason": reason}),
        }
    }

    // ---------------------------------------------------------------- internal

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
        // Function-call keys cannot attach deposits: this proves a full-access key signed.
        require!(env::attached_deposit() == ONE_YOCTO, "attach 1 yoctoNEAR");
    }

    fn assert_agent(&self) {
        require!(env::predecessor_account_id() == self.agent_id, "agent only");
    }

    fn net_of(&self, token: &str) -> u128 {
        self.net_deposits.iter().find(|(t, _)| t.as_str() == token).map_or(0, |(_, n)| *n)
    }

    /// How much more of `token` the owner may deposit: None = no cap; Some(0) = none (no entry, or at the cap).
    fn deposit_room(&self, token: &AccountId) -> Option<u128> {
        if self.deposit_caps.is_empty() { return None; }
        let cap = self.deposit_caps.iter().find(|c| &c.token == token).map_or(0, |c| c.max.0);
        Some(cap.saturating_sub(self.net_of(token.as_str())))
    }

    fn add_net(&mut self, token: &AccountId, amount: u128) {
        match self.net_deposits.iter_mut().find(|(t, _)| t == token) {
            Some((_, n)) => *n = n.saturating_add(amount),
            None => self.net_deposits.push((token.clone(), amount)),
        }
    }

    fn sub_net(&mut self, token: &str, amount: u128) {
        if let Some((_, n)) = self.net_deposits.iter_mut().find(|(t, _)| t.as_str() == token) { *n = n.saturating_sub(amount); }
    }

    /// Usage as it stands now, with the 24 h window and the hourly trade count rolled forward.
    fn rolled(&self) -> Usage { self.usage.rolled_to(now_hour()) }

    /// The policy check, pure. On success returns the pair; otherwise a stable code for agents plus a sentence.
    fn check(&self, u: &Usage, token_in: &AccountId, token_out: &AccountId, amount_in: u128, min_out: u128)
        -> Result<Pair, (&'static str, String)> {
        let p = &self.policy;
        if self.frozen { return Err(("frozen", "vault is frozen".into())); }
        let now = env::block_timestamp();
        if now >= self.trading_ends_ns { return Err(("season_ended", "this vault's trading window has ended; withdraw any time".into())); }
        if self.in_flight.is_some() || self.open_intent.as_ref().is_some_and(|o| o.live(now)) || self.exchange_busy() {
            return Err(("busy", "another swap or intent is in flight".into()));
        }
        if self.open_intent.is_some() {
            return Err(("unsettled", "the last intent is finished but not recorded: call intents_settle".into()));
        }
        let Some(pair) = p.pair(token_in, token_out) else {
            return Err(("pair_not_allowed", format!("{token_in} -> {token_out} not allowed")));
        };
        let lim = p.limit(token_in).expect("validated: pair tokens are listed");
        if amount_in == 0 || min_out == 0 { return Err(("zero_amount", "zero amount".into())); }
        if amount_in > lim.max_per_trade.0 { return Err(("trade_cap", format!("per-trade cap is {}", lim.max_per_trade.0))); }
        if pair.band_floor(amount_in).is_none() { return Err(("unpriceable", "amount overflows the price band".into())); }
        let spent = u.spent_24h(token_in);
        if spent.saturating_add(amount_in) > lim.max_per_day.0 {
            return Err(("daily_cap", format!("24-hour cap is {}, {} used", lim.max_per_day.0, spent)));
        }
        if u.trades >= p.max_trades_per_hour { return Err(("rate_limit", format!("limit of {} trades per hour", p.max_trades_per_hour))); }
        Ok(pair.clone())
    }

    fn exchange_busy(&self) -> bool {
        self.exchange_op_since.is_some_and(|t| env::block_timestamp() < t.0.saturating_add(STUCK_NS))
    }

    fn reserve(&mut self, token: &AccountId, amount: u128) {
        self.usage.trades += 1;
        self.usage.add(token, amount);
    }

    fn release(&mut self, token: &AccountId, amount: u128, hour: u64) {
        self.usage = self.rolled();
        self.usage.sub(token, amount, hour);
    }

    fn current(&self, seq: u64) -> Option<InFlight> {
        self.in_flight.clone().filter(|f| f.seq == seq)
    }

    fn set_stage(&mut self, stage: Stage, min_out: Option<U128>) {
        if let Some(f) = self.in_flight.as_mut() {
            f.stage = stage;
            if let Some(m) = min_out { f.min_amount_out = m; }
        }
    }

    fn settle(&mut self, seq: u64, quote: U128, swapped: bool, token: AccountId, amount: U128, back: bool) -> bool {
        let Some(f) = self.current(seq) else { return false };
        let note = if back { "" } else { "output did not reach the vault: recover with exchange_withdraw or exchange_claim_lostfound" };
        if swapped {
            emit("trade", json!({"seq": seq, "receipt_hash": f.receipt_hash, "venue": "rhea", "pool_id": f.pool_id,
                "token_in": f.token_in, "amount_in": f.amount_in, "token_out": token, "amount_out": amount,
                "quote": quote, "min_amount_out": f.min_amount_out, "returned": back, "note": note}));
            self.in_flight = None;
            return true;
        }
        let _ = self.fail(seq, &format!("swap failed; input {}", if back { "returned" } else { "did not reach the vault; recover with exchange_withdraw or exchange_claim_lostfound" }), back);
        false
    }

    /// End the swap without a trade. Caps are released only if the input is known to be back in the vault.
    fn fail(&mut self, seq: u64, reason: &str, input_safe: bool) -> PromiseOrValue<bool> {
        if let Some(f) = self.in_flight.take() {
            if input_safe { self.release(&f.token_in, f.amount_in.0, f.reserved_hour.0); }
            emit("failed", json!({"seq": seq, "receipt_hash": f.receipt_hash, "venue": "rhea", "reason": reason, "stage": f.stage}));
        }
        PromiseOrValue::Value(false)
    }
}

#[cfg(test)]
mod tests;
