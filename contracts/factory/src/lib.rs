// `new` takes its settings as named JSON args (8 since the deposit caps); the near macro's generated wrapper
// can't carry a per-function allow, and grouping the args would change the API.
#![allow(clippy::too_many_arguments)]
//! Sledgit vault factory.
//!
//! The vault code is stored once on chain as a global contract, pinned by its hash. `create_vault` creates
//! `<name>.<factory>`, funds it, points it at that exact code and initialises it, in one atomic batch: if any step
//! fails, nothing is created and the deposit is refunded. Vaults never receive an access key, so their code can't
//! change. The factory fixes which exchange, NEAR Intents and Chain Signatures contracts every vault uses, so a vault
//! can't be created against a look-alike signer.
//!
//! Refunds. When the creation batch fails, the runtime returns the transferred deposit (less the listing fee, which
//! never left the factory) in its own refund receipt, and NEAR doesn't order that receipt against the `on_created`
//! callback. So the callback pays the creator back in full at once only if the factory's free balance already covers
//! it. Otherwise it records the deposit less the listing fee, which the factory keeps to pay for that record's own
//! storage, and `claim_refund` pays it once the runtime's refund has arrived. Each record funds its own storage, so
//! claims never need a float beyond the factory's own storage, however many records exist at once.
//!
//! Beta settings. An optional `admin` account can change the deposit caps (pushed to every vault with
//! `push_deposit_caps`) and the NEAR deposit bounds for new vaults. It can't move funds or change any vault's code,
//! limits, agent or withdrawals; the worst it can do is stop new deposits. Hand-over is two-step
//! (`propose_admin` + `accept_admin`) and `renounce_admin` fixes the settings forever.
//!
//! Deploy the factory, call `new`, then delete the factory's keys too.
use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Gas per vault for `push_deposit_caps` (attached, plus ~1.2 Tgas of send/exec fees per call), and the most vaults
/// one call may update.
const TG_PUSH: u64 = 8;
const TG_PUSH_FEES: u64 = 2;
const MAX_PUSH: u32 = 25;

/// Kept by the factory from each deposit for its own record of the vault (storage), or of a pending refund.
const LISTING_FEE: NearToken = NearToken::from_millinear(10);
/// Hard ceiling on any vault deposit; `new` can only set a lower season maximum.
pub const MAX_DEPOSIT: NearToken = NearToken::from_near(100);
const MAX_NAME: usize = 32;

fn emit(event: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({"standard": "sledgit-factory", "version": "1.2.0", "event": event, "data": [data]})));
}

fn valid_name(n: &str) -> bool {
    (2..=MAX_NAME).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !n.starts_with('-') && !n.ends_with('-')
}

/// Free balance after storage and money already owed to creators.
fn spendable(balance: u128, storage_cost: u128, owed: u128) -> u128 {
    balance.saturating_sub(storage_cost).saturating_sub(owed)
}

fn storage_cost() -> u128 { env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128 }

/// Per-token ceiling on a vault owner's net deposits, handed to every vault this factory creates.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct DepositCap {
    pub token: AccountId,
    pub max: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    code_hash: Base58CryptoHash,
    exchange_id: AccountId,
    intents_id: AccountId,
    mpc_id: AccountId,
    min_deposit: NearToken,
    max_deposit: NearToken,
    vaults: Vector<AccountId>,
    /// Refunds recorded because the runtime's own refund hadn't arrived when `on_created` ran.
    refunds: LookupMap<AccountId, NearToken>,
    owed: NearToken,
    deposit_caps: Vec<DepositCap>,
    admin: Option<AccountId>,
    proposed_admin: Option<AccountId>,
    /// Next vault index to receive the current caps. `set_deposit_caps` resets it, so each change reaches each vault
    /// once and repeated pushes can't spam vault histories.
    push_cursor: u32,
}

fn validate_caps(caps: &[DepositCap]) {
    // Must equal the vault's policy::MAX_TOKENS, or every create_vault would fail.
    require!(caps.len() <= 8, "too many deposit caps");
    for (i, c) in caps.iter().enumerate() {
        require!(c.max.0 > 0, "deposit cap must be above 0");
        require!(caps[..i].iter().all(|d| d.token != c.token), "duplicate deposit cap");
    }
}

fn validate_bounds(min: u128, max: u128) {
    require!(min > LISTING_FEE.as_yoctonear(), "min_deposit must cover the listing fee");
    require!(max <= MAX_DEPOSIT.as_yoctonear(), "max_deposit above the hard ceiling (100 NEAR)");
    require!(max >= min, "max_deposit below min_deposit");
}

#[near]
impl Factory {
    /// `max_deposit` is the season maximum (at most `MAX_DEPOSIT`); omitted, it is `MAX_DEPOSIT`.
    #[init]
    #[private]
    pub fn new(code_hash: Base58CryptoHash, exchange_id: AccountId, intents_id: AccountId, mpc_id: AccountId,
               min_deposit: U128, max_deposit: Option<U128>, deposit_caps: Option<Vec<DepositCap>>, admin: Option<AccountId>) -> Self {
        let max = max_deposit.map(|m| m.0).unwrap_or(MAX_DEPOSIT.as_yoctonear());
        validate_bounds(min_deposit.0, max);
        let deposit_caps = deposit_caps.unwrap_or_default();
        validate_caps(&deposit_caps);
        emit("init", json!({"code_hash": code_hash, "exchange_id": exchange_id, "intents_id": intents_id, "mpc_id": mpc_id,
            "min_deposit": min_deposit, "max_deposit": U128(max), "deposit_caps": deposit_caps, "admin": admin}));
        Self { code_hash, exchange_id, intents_id, mpc_id, min_deposit: NearToken::from_yoctonear(min_deposit.0),
            max_deposit: NearToken::from_yoctonear(max), vaults: Vector::new(b"v"), refunds: LookupMap::new(b"r"),
            owed: NearToken::from_yoctonear(0), deposit_caps, admin, proposed_admin: None, push_cursor: 0 }
    }

    /// Create the vault `<name>.<factory>`. The attached NEAR (less a small listing fee) becomes the vault's balance;
    /// the vault validates `policy` itself, and if it refuses, nothing is created and the deposit comes back.
    #[payable]
    pub fn create_vault(&mut self, name: String, owner_id: AccountId, agent_id: AccountId, policy: Value) -> Promise {
        require!(valid_name(&name), "name: 2-32 chars of a-z, 0-9 and inner '-'");
        let deposit = env::attached_deposit();
        require!(deposit >= self.min_deposit, format!("attach at least {} yoctoNEAR", self.min_deposit.as_yoctonear()));
        require!(deposit <= self.max_deposit, format!("attach at most {} yoctoNEAR (season maximum)", self.max_deposit.as_yoctonear()));
        // Names are first come, first served; tying the owner to the caller stops anyone registering a vault in
        // someone else's name.
        require!(owner_id == env::predecessor_account_id(), "the caller must be the vault's owner");
        let vault: AccountId = format!("{name}.{}", env::current_account_id()).parse().unwrap_or_else(|_| env::panic_str("bad vault id"));
        let args = json!({"owner_id": owner_id, "agent_id": agent_id, "exchange_id": self.exchange_id,
            "intents_id": self.intents_id, "mpc_id": self.mpc_id, "policy": policy, "deposit_caps": self.deposit_caps})
            .to_string().into_bytes();
        Promise::new(vault.clone())
            .create_account()
            .transfer(deposit.saturating_sub(LISTING_FEE))
            .use_global_contract(self.code_hash)
            .function_call("new".to_string(), args, NearToken::from_yoctonear(0), Gas::from_tgas(30))
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(20))
                .on_created(vault, owner_id, env::predecessor_account_id(), U128(deposit.as_yoctonear())))
    }

    #[private]
    pub fn on_created(&mut self, vault: AccountId, owner_id: AccountId, creator: AccountId, deposit: U128) -> bool {
        let ok = env::promise_results_count() == 1 && env::promise_result_checked(0, 64).is_ok();
        if ok {
            self.vaults.push(vault.clone());
            emit("vault_created", json!({"vault": vault, "owner_id": owner_id, "creator": creator, "code_hash": self.code_hash}));
            return true;
        }
        // The failed batch's own refund may or may not have arrived yet: pay now only if it's covered either way.
        let amount = NearToken::from_yoctonear(deposit.0);
        let balance = env::account_balance().as_yoctonear();
        if spendable(balance, storage_cost(), self.owed.as_yoctonear()) >= deposit.0 {
            Promise::new(creator.clone()).transfer(amount).detach();
            emit("vault_create_failed", json!({"vault": vault, "creator": creator, "refunded": deposit, "pending": "0",
                "factory_balance": U128(balance)}));
        } else {
            // The listing fee never left the factory; it stays to pay for this record's storage.
            let pending = amount.saturating_sub(LISTING_FEE);
            let prev = self.refunds.get(&creator).copied().unwrap_or(NearToken::from_yoctonear(0));
            self.refunds.insert(creator.clone(), prev.saturating_add(pending));
            self.owed = self.owed.saturating_add(pending);
            emit("vault_create_failed", json!({"vault": vault, "creator": creator, "refunded": "0",
                "pending": U128(pending.as_yoctonear()), "kept_for_record_storage": U128(LISTING_FEE.as_yoctonear()),
                "factory_balance": U128(balance)}));
        }
        false
    }

    /// Pay `account_id` its recorded refund. Anyone may call it; the money only ever goes to the creator. Fails, and
    /// can be retried, while the runtime's refund for the failed batch hasn't reached the factory yet.
    pub fn claim_refund(&mut self, account_id: AccountId) -> U128 {
        let amount = self.refunds.get(&account_id).copied().unwrap_or_else(|| env::panic_str("no refund recorded for this account"));
        // Only the other creators' owed refunds stay reserved.
        let others = self.owed.as_yoctonear().saturating_sub(amount.as_yoctonear());
        let free = spendable(env::account_balance().as_yoctonear(), storage_cost(), others);
        require!(free >= amount.as_yoctonear(), "refund not arrived yet; retry in a few blocks");
        self.refunds.remove(&account_id);
        self.owed = self.owed.saturating_sub(amount);
        Promise::new(account_id.clone()).transfer(amount).detach();
        emit("refund_claimed", json!({"creator": account_id, "amount": U128(amount.as_yoctonear())}));
        U128(amount.as_yoctonear())
    }

    // ---------------------------------------------------------------- admin (beta settings only)

    fn assert_admin(&self) {
        require!(self.admin.as_ref() == Some(&env::predecessor_account_id()), "admin only");
        // A function-call key can't attach a deposit: a full-access key (or the admin's multisig) signed.
        require!(env::attached_deposit() == ONE_YOCTO, "attach 1 yoctoNEAR");
    }

    /// New deposit caps for every vault: new vaults get them at creation; existing ones via `push_deposit_caps`.
    #[payable]
    pub fn set_deposit_caps(&mut self, deposit_caps: Vec<DepositCap>) {
        self.assert_admin();
        validate_caps(&deposit_caps);
        emit("deposit_caps_set", json!({"deposit_caps": deposit_caps}));
        self.deposit_caps = deposit_caps;
        self.push_cursor = 0;
    }

    /// Send the current caps to the next `limit` vaults that haven't had them since the last change (at most 25 per
    /// call). Anyone may call it: it only copies the admin's setting, the caller pays the gas, and each vault gets each
    /// change once. Returns how many were sent; 0 when every vault is up to date. The admin re-sends by setting again.
    pub fn push_deposit_caps(&mut self, limit: u32) -> u32 {
        let n = limit.min(MAX_PUSH).min(self.vaults.len().saturating_sub(self.push_cursor));
        let need = (TG_PUSH + TG_PUSH_FEES) * n as u64 + 10;
        require!(env::prepaid_gas() >= Gas::from_tgas(need), format!("attach at least {need} Tgas"));
        let args = json!({"deposit_caps": self.deposit_caps}).to_string().into_bytes();
        let from = self.push_cursor;
        for v in self.vaults.iter().skip(from as usize).take(n as usize) {
            Promise::new(v.clone()).function_call("set_deposit_caps".to_string(), args.clone(), NearToken::from_yoctonear(0), Gas::from_tgas(TG_PUSH)).detach();
        }
        self.push_cursor = from + n;
        if n > 0 { emit("deposit_caps_pushed", json!({"from_index": from, "count": n})); }
        n
    }

    /// NEAR deposit bounds for vaults created from now on.
    #[payable]
    pub fn set_deposit_bounds(&mut self, min_deposit: U128, max_deposit: U128) {
        self.assert_admin();
        validate_bounds(min_deposit.0, max_deposit.0);
        emit("deposit_bounds_set", json!({"min_deposit": min_deposit, "max_deposit": max_deposit}));
        self.min_deposit = NearToken::from_yoctonear(min_deposit.0);
        self.max_deposit = NearToken::from_yoctonear(max_deposit.0);
    }

    #[payable]
    pub fn propose_admin(&mut self, account_id: AccountId) {
        self.assert_admin();
        emit("admin_proposed", json!({"account_id": account_id}));
        self.proposed_admin = Some(account_id);
    }

    #[payable]
    pub fn accept_admin(&mut self) {
        let who = env::predecessor_account_id();
        require!(self.proposed_admin.as_ref() == Some(&who), "not the proposed admin");
        require!(env::attached_deposit() == ONE_YOCTO, "attach 1 yoctoNEAR");
        emit("admin_accepted", json!({"account_id": who}));
        self.admin = Some(who);
        self.proposed_admin = None;
    }

    /// Give up the admin role for good: the caps and bounds can never change again.
    #[payable]
    pub fn renounce_admin(&mut self) {
        self.assert_admin();
        emit("admin_renounced", json!({}));
        self.admin = None;
        self.proposed_admin = None;
    }

    pub fn get_refund(&self, account_id: AccountId) -> U128 {
        U128(self.refunds.get(&account_id).map(|n| n.as_yoctonear()).unwrap_or(0))
    }

    pub fn get_config(&self) -> Value {
        json!({"code_hash": self.code_hash, "exchange_id": self.exchange_id, "intents_id": self.intents_id, "mpc_id": self.mpc_id,
            "min_deposit": U128(self.min_deposit.as_yoctonear()), "max_deposit": U128(self.max_deposit.as_yoctonear()),
            "owed_refunds": U128(self.owed.as_yoctonear()), "vaults": self.vaults.len(), "deposit_caps": self.deposit_caps,
            "admin": self.admin, "proposed_admin": self.proposed_admin, "push_cursor": self.push_cursor,
            "version": env!("CARGO_PKG_VERSION")})
    }

    pub fn get_vaults(&self, from_index: u32, limit: u32) -> Vec<AccountId> {
        self.vaults.iter().skip(from_index as usize).take(limit.min(100) as usize).cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        for ok in ["ab", "claude-1", "qwen36-tee", "a1-b2"] { assert!(valid_name(ok), "{ok}"); }
        for bad in ["a", "-ab", "ab-", "Ab", "a.b", "a_b", &"x".repeat(33)] { assert!(!valid_name(bad), "{bad}"); }
    }

    #[test]
    fn owed_refunds_are_never_spent() {
        // 10 balance, 2 storage, 5 owed to others: only 3 is free for an immediate refund.
        assert_eq!(spendable(10, 2, 5), 3);
        assert_eq!(spendable(1, 2, 5), 0, "never underflows");
    }

    fn init(min: u128, max: Option<u128>) -> Factory {
        let ctx = near_sdk::test_utils::VMContextBuilder::new().current_account_id("f.near".parse().unwrap())
            .predecessor_account_id("f.near".parse().unwrap()).build();
        near_sdk::testing_env!(ctx);
        let a = |s: &str| -> AccountId { s.parse().unwrap() };
        Factory::new("5ePvrzPrKn8WGzZh8LnSLjaxcCPebA5E6nFJ4HxwR3iQ".parse().unwrap(), a("v2.ref-finance.near"), a("intents.near"),
            a("v1.signer"), U128(min), max.map(U128), None, Some(a("admin.near")))
    }

    /// The callback runs before the runtime's refund has arrived (balance = storage only): nothing is paid from money
    /// the factory doesn't have; the refund is recorded, claimable once the runtime's refund lands, and only once.
    #[test]
    fn refund_is_recorded_when_the_runtime_refund_is_late() {
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::PromiseResult;
        let near = |n: u128| NearToken::from_near(n).as_yoctonear();
        let mut f = init(near(1), None);
        let a = |s: &str| -> AccountId { s.parse().unwrap() };
        let me = a("f.near");
        let storage = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        let ctx = |balance: u128, pred: &AccountId| VMContextBuilder::new().current_account_id(me.clone())
            .predecessor_account_id(pred.clone()).account_balance(NearToken::from_yoctonear(balance)).build();

        // Callback, factory holds only its storage: the 3 NEAR deposit is recorded, not paid.
        near_sdk::testing_env!(ctx(storage, &me), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Failed]);
        assert!(!f.on_created(a("x.f.near"), a("alice.near"), a("alice.near"), U128(near(3))));
        let due = near(3) - LISTING_FEE.as_yoctonear();
        assert_eq!(f.get_refund(a("alice.near")).0, due, "the listing fee stays for the record's storage");
        assert_eq!(f.owed, NearToken::from_yoctonear(due));

        // Claim before the runtime refund arrives: refused, nothing changes.
        near_sdk::testing_env!(ctx(storage + near(1), &a("eve.near")));
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { f.claim_refund(a("alice.near")); })).is_err());
        assert_eq!(f.get_refund(a("alice.near")).0, due);

        // Runtime refund in (deposit less the fee, plus the fee that never left): the claim goes to alice, once.
        near_sdk::testing_env!(ctx(storage + near(3), &a("eve.near")));
        assert_eq!(f.claim_refund(a("alice.near")).0, due);
        assert_eq!(f.get_refund(a("alice.near")).0, 0);
        assert_eq!(f.owed, NearToken::from_yoctonear(0));
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { f.claim_refund(a("alice.near")); })).is_err());

        // A second creator's pending refund isn't spent on a third's immediate one.
        near_sdk::testing_env!(ctx(storage, &me), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Failed]);
        f.on_created(a("y.f.near"), a("bob.near"), a("bob.near"), U128(near(2)));
        near_sdk::testing_env!(ctx(storage + near(2), &me), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Failed]);
        f.on_created(a("z.f.near"), a("carol.near"), a("carol.near"), U128(near(2)));
        assert_eq!(f.get_refund(a("carol.near")).0, near(2) - LISTING_FEE.as_yoctonear(),
            "bob's refund is reserved, so carol's is recorded, not pushed");
    }

    /// Round 3 L-5: records take storage. Each keeps its listing fee, so once the runtime refunds land, every claim
    /// succeeds with no float, however many records exist at once. Storage is flushed so it really grows here.
    #[test]
    fn many_records_never_deadlock_claims() {
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::PromiseResult;
        let near = |n: u128| NearToken::from_near(n).as_yoctonear();
        let a = |s: &str| -> AccountId { s.parse().unwrap() };
        let me = a("f.near");
        let mut f = init(near(1), None);
        let base_storage = storage_cost();
        let ctx = |balance: u128, usage: u64, pred: &AccountId| VMContextBuilder::new().current_account_id(me.clone())
            .predecessor_account_id(pred.clone()).storage_usage(usage).account_balance(NearToken::from_yoctonear(balance)).build();
        let byte = env::storage_byte_cost().as_yoctonear();
        // The factory holds exactly its storage: no float at all.
        let mut balance = base_storage;
        let mut usage = env::storage_usage();
        let n = 300u128;
        for i in 0..n {
            let who = a(&format!("c{i}.near"));
            near_sdk::testing_env!(ctx(balance, usage, &me), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(),
                Default::default(), vec![PromiseResult::Failed]);
            f.on_created(a(&format!("v{i}.f.near")), who.clone(), who, U128(near(1)));
            f.refunds.flush();
            usage = env::storage_usage();
            // The fee arrived with the call and stayed; the runtime refund of the rest lands later.
            balance += LISTING_FEE.as_yoctonear();
        }
        assert!(storage_cost() > base_storage, "records really took storage");
        assert!((usage as u128 - base_storage / byte) * byte <= n * LISTING_FEE.as_yoctonear(), "each record costs less than its fee");
        balance += n * (near(1) - LISTING_FEE.as_yoctonear());
        for i in 0..n {
            near_sdk::testing_env!(ctx(balance, usage, &a("anyone.near")));
            let paid = f.claim_refund(a(&format!("c{i}.near"))).0;
            f.refunds.flush();
            usage = env::storage_usage();
            balance -= paid;
        }
        assert_eq!(f.owed, NearToken::from_yoctonear(0));
        assert!(balance >= storage_cost(), "storage still covered after every claim");
    }

    #[test]
    fn season_maximum_is_bounded() {
        let near = |n: u128| NearToken::from_near(n).as_yoctonear();
        assert_eq!(init(near(1), None).max_deposit, MAX_DEPOSIT);
        assert_eq!(init(near(1), Some(near(10))).max_deposit, NearToken::from_near(10));
        assert!(std::panic::catch_unwind(|| init(near(1), Some(near(101)))).is_err(), "above the 100 NEAR ceiling");
        assert!(std::panic::catch_unwind(|| init(near(5), Some(near(2)))).is_err(), "max below min");
    }

    #[test]
    fn deposit_caps_are_validated_and_shown() {
        let a = |s: &str| -> AccountId { s.parse().unwrap() };
        let cap = |t: &str, m: u128| DepositCap { token: a(t), max: U128(m) };
        let mk = |caps: Vec<DepositCap>| {
            let ctx = near_sdk::test_utils::VMContextBuilder::new().current_account_id(a("f.near")).predecessor_account_id(a("f.near")).build();
            near_sdk::testing_env!(ctx);
            Factory::new("5ePvrzPrKn8WGzZh8LnSLjaxcCPebA5E6nFJ4HxwR3iQ".parse().unwrap(), a("v2.ref-finance.near"), a("intents.near"),
                a("v1.signer"), U128(NearToken::from_near(1).as_yoctonear()), None, Some(caps), Some(a("admin.near")))
        };
        let f = mk(vec![cap("usdc.near", 20_000_000), cap("wrap.near", 5)]);
        assert_eq!(f.get_config()["deposit_caps"][0]["max"], near_sdk::serde_json::json!("20000000"));
        assert!(std::panic::catch_unwind(|| mk(vec![cap("usdc.near", 0)])).is_err(), "zero cap");
        assert!(std::panic::catch_unwind(|| mk(vec![cap("usdc.near", 1), cap("usdc.near", 2)])).is_err(), "duplicate");
    }

    fn as_who(who: &str, yocto: u128) {
        let ctx = near_sdk::test_utils::VMContextBuilder::new().current_account_id("f.near".parse().unwrap())
            .predecessor_account_id(who.parse().unwrap()).attached_deposit(NearToken::from_yoctonear(yocto))
            .prepaid_gas(Gas::from_tgas(300)).build();
        near_sdk::testing_env!(ctx);
    }

    #[test]
    fn admin_changes_caps_and_bounds_others_cannot() {
        let near = |n: u128| NearToken::from_near(n).as_yoctonear();
        let mut f = init(near(1), Some(near(10)));
        let cap = |m: u128| vec![DepositCap { token: "usdc.near".parse().unwrap(), max: U128(m) }];
        for who in ["eve.near", "f.near"] {
            as_who(who, 1);
            assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.set_deposit_caps(cap(5)))).is_err(), "{who} isn't admin");
        }
        as_who("admin.near", 0);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.set_deposit_caps(cap(5)))).is_err(), "needs 1 yocto");
        as_who("admin.near", 1);
        f.set_deposit_caps(cap(50));
        assert_eq!(f.get_config()["deposit_caps"][0]["max"], near_sdk::serde_json::json!("50"));
        f.set_deposit_bounds(U128(near(1)), U128(near(20)));
        assert_eq!(f.max_deposit, NearToken::from_near(20));
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.set_deposit_bounds(U128(near(1)), U128(near(101))))).is_err(), "ceiling still holds");
    }

    #[test]
    fn admin_handover_is_two_step_and_renounce_is_final() {
        let mut f = init(NearToken::from_near(1).as_yoctonear(), None);
        as_who("admin.near", 1);
        f.propose_admin("multisig.near".parse().unwrap());
        assert_eq!(f.admin.as_ref().map(|a| a.as_str()), Some("admin.near"), "not yet");
        as_who("eve.near", 1);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.accept_admin())).is_err());
        as_who("multisig.near", 1);
        f.accept_admin();
        assert_eq!(f.admin.as_ref().map(|a| a.as_str()), Some("multisig.near"));
        f.renounce_admin();
        assert!(f.admin.is_none());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.set_deposit_caps(vec![]))).is_err(), "nobody can change caps now");
    }

    #[test]
    fn push_needs_gas_and_is_bounded() {
        let mut f = init(NearToken::from_near(1).as_yoctonear(), None);
        as_who("anyone.near", 0);
        assert_eq!(f.push_deposit_caps(100), 0, "no vaults yet");
        for i in 0..30 { f.vaults.push(format!("v{i}.f.near").parse().unwrap()); }
        let gas = |t: u64| {
            let ctx = near_sdk::test_utils::VMContextBuilder::new().current_account_id("f.near".parse().unwrap())
                .predecessor_account_id("anyone.near".parse().unwrap()).prepaid_gas(Gas::from_tgas(t)).build();
            near_sdk::testing_env!(ctx);
        };
        gas(259);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.push_deposit_caps(25))).is_err(), "25 vaults need 260 Tgas");
        // Batching and the cursor run in the sandbox (this mock can't schedule many detached calls).
        f.push_cursor = 10;
        as_who("admin.near", 1);
        f.set_deposit_caps(vec![]);
        assert_eq!(f.get_config()["push_cursor"], near_sdk::serde_json::json!(0), "a new setting starts over");
    }
}
