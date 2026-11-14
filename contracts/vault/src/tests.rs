#![allow(unused_must_use)]
use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
use near_sdk::test_vm_config;

const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn acc(s: &str) -> AccountId { s.parse().unwrap() }
fn vault() -> AccountId { acc("vault.near") }
fn owner() -> AccountId { acc("owner.near") }
fn agent() -> AccountId { acc("agent.near") }
fn wnear() -> AccountId { acc("wrap.near") }
fn usdc() -> AccountId { acc("usdc.near") }

fn policy() -> Policy {
    Policy {
        tokens: vec![
            TokenLimit { token: usdc(), max_per_trade: U128(50), max_per_day: U128(100) },
            TokenLimit { token: wnear(), max_per_trade: U128(20), max_per_day: U128(40) },
        ],
        pairs: vec![
            Pair { token_in: usdc(), token_out: wnear(), pool_id: 7, min_price_num: U128(1), min_price_den: U128(1_000_000) },
            Pair { token_in: wnear(), token_out: usdc(), pool_id: 7, min_price_num: U128(1), min_price_den: U128(1_000_000) },
        ],
        max_trades_per_hour: 3,
        max_slippage_bps: 100,
    }
}

fn ctx(pred: AccountId, deposit: u128, ts: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault()).predecessor_account_id(pred.clone()).signer_account_id(pred)
        .attached_deposit(NearToken::from_yoctonear(deposit)).block_timestamp(ts)
        .prepaid_gas(Gas::from_tgas(300)).account_balance(NearToken::from_near(5)).storage_usage(1_000);
    b
}

fn set(pred: AccountId, deposit: u128, ts: u64) { testing_env!(ctx(pred, deposit, ts).build()); }

fn set_result(r: PromiseResult, ts: u64) {
    testing_env!(ctx(vault(), 0, ts).build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![r]);
}

fn new_vault() -> Vault {
    set(vault(), 0, 1);
    Vault::new(owner(), agent(), acc("v2.ref-finance.near"), acc("intents.near"), acc("v1.signer"), policy(), None)
}

fn events(kind: &str) -> Vec<Value> {
    get_logs().iter().filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str::<Value>(j).unwrap())
        .filter(|e| e["event"] == kind).map(|e| e["data"][0].clone()).collect()
}

fn ok_u128(n: u128) -> PromiseResult { PromiseResult::Successful(format!("\"{n}\"").into_bytes()) }

fn set_results(r: Vec<PromiseResult>, ts: u64) {
    testing_env!(ctx(vault(), 0, ts).build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), r);
}

/// A callback that answered directly; None when it chained another promise.
fn val(p: PromiseOrValue<bool>) -> Option<bool> { match p { PromiseOrValue::Value(b) => Some(b), _ => None } }

/// The swap's reply plus the vault's own token_out and token_in balances before the payout.
fn swapped(out: Option<u128>, out_before: u128, in_before: u128, ts: u64) {
    let swap = out.map(ok_u128).unwrap_or(PromiseResult::Failed);
    set_results(vec![swap, ok_u128(out_before), ok_u128(in_before)], ts);
}

fn request(v: &mut Vault, amount: u128, ts: u64) -> bool {
    set(agent(), 0, ts);
    matches!(v.request_swap(usdc(), wnear(), U128(amount), U128(1), HASH.into()), PromiseOrValue::Promise(_))
}

/// Drive a full successful chain: quote -> deposit -> swap -> withdraw.
fn complete(v: &mut Vault, ts: u64, out: u128) {
    let seq = v.get_in_flight().unwrap().seq;
    set_result(ok_u128(out), ts);
    v.on_quote(seq);
    let amount = v.get_in_flight().unwrap().amount_in.0;
    set_result(ok_u128(amount), ts);
    v.on_deposit(seq, U128(out));
    swapped(Some(out), 0, 0, ts);
    v.on_swap(seq, U128(out));
    set_result(PromiseResult::Successful(vec![]), ts);
    v.on_withdraw(seq, U128(out), true, wnear(), U128(out), Some(U128(0)));
    set_result(ok_u128(out), ts);
    v.on_verify(seq, U128(out), true, wnear(), U128(out), U128(0));
}

// ------------------------------------------------------------------ init and policy
// #[private] is enforced by the compiled entry point, so it is tested in tests/sandbox.rs.

#[test]
#[should_panic(expected = "owner and agent must differ")]
fn init_rejects_owner_as_agent() {
    set(vault(), 0, 1);
    Vault::new(owner(), owner(), acc("ex.near"), acc("intents.near"), acc("v1.signer"), policy(), None);
}

#[test]
#[should_panic(expected = "separate accounts")]
fn init_rejects_vault_as_agent() {
    set(vault(), 0, 1);
    Vault::new(owner(), vault(), acc("ex.near"), acc("intents.near"), acc("v1.signer"), policy(), None);
}

#[test]
fn init_by_parent_account_is_allowed() {
    set(acc("near"), 0, 1); // vault.near is a sub-account of near
    Vault::new(owner(), agent(), acc("ex.near"), acc("intents.near"), acc("v1.signer"), policy(), None);
}

#[test]
#[should_panic(expected = "only the vault account or its parent may initialise it")]
fn init_by_a_stranger_is_refused() {
    set(acc("eve.near"), 0, 1);
    Vault::new(owner(), agent(), acc("ex.near"), acc("intents.near"), acc("v1.signer"), policy(), None);
}

#[test]
fn policy_validation() {
    let bad = |f: fn(&mut Policy)| { let mut p = policy(); f(&mut p); std::panic::catch_unwind(|| p.validate()).is_err() };
    set(vault(), 0, 1);
    assert!(std::panic::catch_unwind(|| policy().validate()).is_ok());
    assert!(bad(|p| p.tokens.clear()));
    assert!(bad(|p| p.pairs.clear()));
    assert!(bad(|p| p.pairs[0].min_price_den = U128(0)));
    assert!(bad(|p| p.pairs[0].token_out = acc("other.near")));
    assert!(bad(|p| p.pairs[0].token_out = usdc()));
    assert!(bad(|p| p.max_trades_per_hour = 0));
    assert!(bad(|p| p.max_slippage_bps = 501));
    assert!(bad(|p| p.tokens[0].max_per_trade = U128(0)));
    assert!(bad(|p| p.tokens[0].max_per_trade = U128(101)));
    assert!(bad(|p| { let t = p.tokens[0].clone(); p.tokens.push(t) }));
    assert!(bad(|p| { let q = p.pairs[0].clone(); p.pairs.push(q) }));
}

// ------------------------------------------------------------------ access control

#[test]
#[should_panic(expected = "agent only")]
fn only_agent_requests() {
    let mut v = new_vault();
    set(owner(), 0, 1);
    v.request_swap(usdc(), wnear(), U128(10), U128(1), HASH.into());
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_withdraw() {
    let mut v = new_vault();
    set(agent(), 1, 1);
    v.withdraw(usdc(), U128(10));
}

#[test]
#[should_panic(expected = "attach 1 yoctoNEAR")]
fn owner_needs_full_access_key() {
    let mut v = new_vault();
    set(owner(), 0, 1);
    v.withdraw(usdc(), U128(10));
}

#[test]
#[should_panic(expected = "owner only")]
fn stranger_cannot_change_agent() {
    let mut v = new_vault();
    set(acc("eve.near"), 1, 1);
    v.set_agent(acc("eve.near"));
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_unfreeze() {
    let mut v = new_vault();
    set(agent(), 0, 1);
    v.freeze();
    set(agent(), 1, 1);
    v.unfreeze();
}

#[test]
#[should_panic(expected = "receipt_hash")]
fn receipt_hash_is_validated() {
    let mut v = new_vault();
    set(agent(), 0, 1);
    v.request_swap(usdc(), wnear(), U128(10), U128(1), "XYZ".into());
}

#[test]
#[should_panic(expected = "Tgas")]
fn low_gas_is_rejected_before_state_changes() {
    let mut v = new_vault();
    testing_env!(ctx(agent(), 0, 1).prepaid_gas(Gas::from_tgas(100)).build());
    v.request_swap(usdc(), wnear(), U128(10), U128(1), HASH.into());
}

// ------------------------------------------------------------------ refusals

#[test]
fn refusals_carry_codes_and_persist() {
    let mut v = new_vault();
    let cases: Vec<(AccountId, AccountId, u128, &str)> = vec![
        (acc("scam.near"), wnear(), 10, "pair_not_allowed"),
        (usdc(), acc("scam.near"), 10, "pair_not_allowed"),
        (usdc(), usdc(), 10, "pair_not_allowed"),
        (usdc(), wnear(), 0, "zero_amount"),
        (usdc(), wnear(), 51, "trade_cap"),
        (usdc(), wnear(), u128::MAX / 2, "trade_cap"),
    ];
    for (tin, tout, amt, code) in cases {
        set(agent(), 0, 1);
        let r = v.request_swap(tin, tout, U128(amt), U128(1), HASH.into());
        assert!(matches!(r, PromiseOrValue::Value(false)));
        assert_eq!(events("refuse")[0]["code"], code);
    }
    assert!(v.get_in_flight().is_none());
    assert_eq!(v.get_config()["seq"], 6);
}

#[test]
fn daily_cap_is_reserved_before_async_and_resets_next_day() {
    let mut v = new_vault();
    assert!(request(&mut v, 50, 10));
    complete(&mut v, 10, 5);
    assert!(request(&mut v, 50, 20));
    complete(&mut v, 20, 5);
    assert!(!request(&mut v, 1, 30));
    assert_eq!(events("refuse")[0]["code"], "daily_cap");
    assert!(request(&mut v, 50, DAY_NS + 1));
}

#[test]
fn only_one_swap_in_flight() {
    let mut v = new_vault();
    assert!(request(&mut v, 10, 1));
    assert!(!request(&mut v, 10, 1));
    assert_eq!(events("refuse")[0]["code"], "busy");
}

#[test]
fn hourly_rate_limit() {
    let mut v = new_vault();
    for i in 0..3 { assert!(request(&mut v, 1, 10 + i)); complete(&mut v, 10 + i, 1); }
    assert!(!request(&mut v, 1, 20));
    assert_eq!(events("refuse")[0]["code"], "rate_limit");
    assert!(request(&mut v, 1, HOUR_NS + 1));
}

#[test]
fn frozen_vault_refuses_and_agent_can_freeze() {
    let mut v = new_vault();
    set(agent(), 0, 1);
    v.freeze();
    assert!(!request(&mut v, 10, 2));
    assert_eq!(events("refuse")[0]["code"], "frozen");
    set(owner(), 1, 3);
    v.unfreeze();
    assert!(request(&mut v, 10, 4));
}

#[test]
fn preview_matches_request() {
    let v = new_vault();
    set(acc("anyone.near"), 0, 1);
    let ok = v.preview_swap(usdc(), wnear(), U128(10), U128(1));
    assert_eq!((ok["ok"].as_bool(), ok["pool_id"].as_u64()), (Some(true), Some(7)));
    assert_eq!(v.preview_swap(usdc(), wnear(), U128(60), U128(1))["code"], "trade_cap");
}

// ------------------------------------------------------------------ swap chain

#[test]
fn successful_trade_emits_trade_and_unlocks() {
    let mut v = new_vault();
    assert!(request(&mut v, 50, 1));
    complete(&mut v, 1, 12);
    let t = &events("trade")[0];
    assert_eq!(t["amount_out"], "12");
    assert_eq!(t["receipt_hash"], HASH);
    assert!(v.get_in_flight().is_none());
}

#[test]
fn slippage_floor_raises_agent_min() {
    let mut v = new_vault();
    assert!(request(&mut v, 50, 1));
    let seq = v.get_in_flight().unwrap().seq;
    set_result(ok_u128(1_000_000), 1);
    v.on_quote(seq);
    // 1% max slippage: the agent asked for 1, the vault demands 990_000.
    assert_eq!(v.get_in_flight().unwrap().min_amount_out, U128(990_000));
}

#[test]
fn quote_failure_releases_caps() {
    let mut v = new_vault();
    assert!(request(&mut v, 50, 1));
    let seq = v.get_in_flight().unwrap().seq;
    set_result(PromiseResult::Failed, 1);
    v.on_quote(seq);
    assert_eq!(events("failed")[0]["reason"], "quote failed");
    assert!(v.get_in_flight().is_none());
    assert_eq!(v.get_usage().spent[0].1, U128(0));
}

#[test]
fn min_above_quote_is_refused_before_funds_move() {
    let mut v = new_vault();
    set(agent(), 0, 1);
    v.request_swap(usdc(), wnear(), U128(10), U128(500), HASH.into());
    let seq = v.get_in_flight().unwrap().seq;
    set_result(ok_u128(100), 1);
    v.on_quote(seq);
    assert!(events("failed")[0]["reason"].as_str().unwrap().contains("above the exchange quote"));
    assert!(v.get_in_flight().is_none());
}

#[test]
fn deposit_failure_and_partial_deposit() {
    let mut v = new_vault();
    assert!(request(&mut v, 50, 1));
    let seq = v.get_in_flight().unwrap().seq;
    set_result(ok_u128(100), 1);
    v.on_quote(seq);
    set_result(ok_u128(0), 1);
    v.on_deposit(seq, U128(100));
    assert_eq!(events("failed")[0]["reason"], "deposit to exchange failed");
    assert_eq!(v.get_usage().spent[0].1, U128(0));

    assert!(request(&mut v, 50, 2));
    let seq = v.get_in_flight().unwrap().seq;
    set_result(ok_u128(100), 2);
    v.on_quote(seq);
    set_result(ok_u128(20), 2);
    v.on_deposit(seq, U128(100));
    assert!(events("failed")[0]["reason"].as_str().unwrap().contains("partial deposit"));
    // Funds are not known to be back: the cap stays reserved.
    assert_eq!(v.get_usage().spent[0].1, U128(50));
}

#[test]
fn failed_swap_withdraws_input_back() {
    let mut v = new_vault();
    assert!(request(&mut v, 50, 1));
    let seq = v.get_in_flight().unwrap().seq;
    set_result(ok_u128(100), 1);
    v.on_quote(seq);
    set_result(ok_u128(50), 1);
    v.on_deposit(seq, U128(100));
    swapped(None, 0, 450, 1);
    v.on_swap(seq, U128(100));
    set_result(PromiseResult::Successful(vec![]), 1);
    v.on_withdraw(seq, U128(100), false, usdc(), U128(50), Some(U128(450)));
    set_result(ok_u128(500), 1);
    assert!(!v.on_verify(seq, U128(100), false, usdc(), U128(50), U128(450)));
    assert_eq!(events("failed")[0]["reason"], "swap failed; input returned");
    assert_eq!(v.get_usage().spent[0].1, U128(0));
}

#[test]
fn stale_callback_is_ignored() {
    let mut v = new_vault();
    assert!(request(&mut v, 10, 1));
    set_result(ok_u128(100), 1);
    assert!(matches!(v.on_quote(999), PromiseOrValue::Value(false)));
    assert!(v.get_in_flight().is_some());
}

#[test]
fn stuck_swap_can_be_cleared_only_after_timeout() {
    let mut v = new_vault();
    assert!(request(&mut v, 10, 1));
    set(owner(), 1, 2);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| v.clear_stuck())).is_err());
    set(owner(), 1, 1 + STUCK_NS);
    v.clear_stuck();
    assert!(v.get_in_flight().is_none());
}

#[test]
fn payout_swallowed_by_exchange_is_not_recorded_as_returned() {
    let mut v = new_vault();
    assert!(request(&mut v, 50, 1));
    let seq = v.get_in_flight().unwrap().seq;
    set_result(ok_u128(100), 1); v.on_quote(seq);
    set_result(ok_u128(50), 1); v.on_deposit(seq, U128(100));
    swapped(Some(100), 7, 0, 1); v.on_swap(seq, U128(100));
    set_result(PromiseResult::Successful(vec![]), 1); v.on_withdraw(seq, U128(100), true, wnear(), U128(100), Some(U128(7)));
    // The exchange kept the output: the vault's balance didn't move.
    set_result(ok_u128(7), 1);
    assert!(v.on_verify(seq, U128(100), true, wnear(), U128(100), U128(7)));
    assert_eq!(events("trade")[0]["returned"], false);
}

/// Round 3 L-1: Rhea can re-credit a failed payout, park it in the vault's lostfound or hand it to its own owner;
/// in every case the vault's balance doesn't rise by the amount, so it isn't "returned". Only a real arrival counts.
#[test]
fn payout_counts_as_returned_only_if_the_vault_balance_rose() {
    // (balance before, balance after, balance view readable) -> returned
    for (before, after, readable, back) in [(7u128, 107u128, true, true), (7, 106, true, false), (7, 7, true, false),
                                            (7, 300, true, true), (7, 0, false, false)] {
        let mut v = new_vault();
        assert!(request(&mut v, 50, 1));
        let seq = v.get_in_flight().unwrap().seq;
        set_result(ok_u128(100), 1); v.on_quote(seq);
        set_result(ok_u128(50), 1); v.on_deposit(seq, U128(100));
        swapped(Some(100), before, 0, 1); v.on_swap(seq, U128(100));
        set_result(PromiseResult::Successful(vec![]), 1); v.on_withdraw(seq, U128(100), true, wnear(), U128(100), Some(U128(before)));
        set_result(if readable { ok_u128(after) } else { PromiseResult::Failed }, 1);
        v.on_verify(seq, U128(100), true, wnear(), U128(100), U128(before));
        assert_eq!(events("trade")[0]["returned"], back, "{before} -> {after}");
    }
    // No balance before (the view failed): never "returned", without even asking.
    let mut v = new_vault();
    assert!(request(&mut v, 50, 1));
    let seq = v.get_in_flight().unwrap().seq;
    set_result(ok_u128(100), 1); v.on_quote(seq);
    set_result(ok_u128(50), 1); v.on_deposit(seq, U128(100));
    set_results(vec![ok_u128(100), PromiseResult::Failed, ok_u128(0)], 1); v.on_swap(seq, U128(100));
    set_result(PromiseResult::Successful(vec![]), 1);
    assert!(matches!(v.on_withdraw(seq, U128(100), true, wnear(), U128(100), None), PromiseOrValue::Value(true)));
    assert_eq!(events("trade")[0]["returned"], false);
    // A failed swap whose input didn't come back keeps its cap.
    let mut v = new_vault();
    assert!(request(&mut v, 50, 1));
    let seq = v.get_in_flight().unwrap().seq;
    set_result(ok_u128(100), 1); v.on_quote(seq);
    set_result(ok_u128(50), 1); v.on_deposit(seq, U128(100));
    swapped(None, 0, 450, 1); v.on_swap(seq, U128(100));
    set_result(PromiseResult::Successful(vec![]), 1); v.on_withdraw(seq, U128(100), false, usdc(), U128(50), Some(U128(450)));
    set_result(ok_u128(450), 1);
    v.on_verify(seq, U128(100), false, usdc(), U128(50), U128(450));
    assert_eq!(v.get_usage().spent[0].1, U128(50), "input not known to be back: the cap stays");
}

/// Round 3 L-1: the owner claims a lostfound balance; only what reached the vault is recorded.
#[test]
fn lostfound_claim_records_what_arrived() {
    let mut v = new_vault();
    set(agent(), 1, 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { v.exchange_claim_lostfound(wnear()); })).is_err(), "owner only");
    set(owner(), 1, 1);
    v.exchange_claim_lostfound(wnear());
    set_result(ok_u128(10), 1);
    assert!(matches!(v.on_claim_before(wnear()), PromiseOrValue::Promise(_)));
    set_result(ok_u128(25), 1);
    assert!(v.on_claim_after(wnear(), U128(10)));
    assert_eq!(events("exchange_lostfound_claim")[0]["amount"], "15");
    set_result(ok_u128(10), 2);
    assert!(!v.on_claim_after(wnear(), U128(10)));
    assert_eq!(events("exchange_lostfound_claim_failed").len(), 1);
}

/// Round 3 I-2: an owner exchange operation measures balances before and after, so no swap may start meanwhile.
#[test]
fn swaps_wait_for_an_exchange_operation() {
    let mut v = new_vault();
    set(owner(), 1, 1);
    v.exchange_withdraw(usdc(), U128(5));
    assert!(!request(&mut v, 10, 2));
    assert_eq!(events("refuse")[0]["code"], "busy");
    set(owner(), 1, 2);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { v.exchange_claim_lostfound(wnear()); })).is_err(),
        "one exchange operation at a time");
    set_result(ok_u128(5), 3);
    v.on_exchange_after(usdc(), U128(5), U128(10));
    assert!(request(&mut v, 10, 4), "free again once the operation recorded");
    // A lost callback can't block trading for good.
    let mut v = new_vault();
    set(owner(), 1, 1);
    v.exchange_withdraw(usdc(), U128(5));
    assert!(!request(&mut v, 10, STUCK_NS));
    assert!(request(&mut v, 10, 1 + STUCK_NS));
}

// ------------------------------------------------------------------ deposits and policy changes

#[test]
fn deposits_only_from_owner_in_allowed_tokens() {
    let mut v = new_vault();
    set(usdc(), 0, 1);
    assert!(matches!(v.ft_on_transfer(owner(), U128(5), String::new()), PromiseOrValue::Value(U128(0))));
    assert!(matches!(v.ft_on_transfer(acc("eve.near"), U128(5), String::new()), PromiseOrValue::Value(U128(5))));
    set(acc("fake-usdc.near"), 0, 1);
    assert!(matches!(v.ft_on_transfer(owner(), U128(5), String::new()), PromiseOrValue::Value(U128(5))));
}

#[test]
fn policy_change_waits_for_timelock() {
    let mut v = new_vault();
    let mut p = policy();
    p.tokens[0].max_per_trade = U128(100);
    set(owner(), 1, 10);
    v.propose_policy(p.clone());
    set(acc("anyone.near"), 0, 10 + TIMELOCK_NS - 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| v.apply_policy())).is_err());
    set(acc("anyone.near"), 0, 10 + TIMELOCK_NS);
    v.apply_policy();
    assert_eq!(v.get_policy(), p);
}

#[test]
fn ownership_needs_acceptance() {
    let mut v = new_vault();
    set(owner(), 1, 1);
    v.propose_owner(acc("new.near"));
    assert_eq!(v.get_config()["owner_id"], "owner.near");
    set(acc("new.near"), 1, 2);
    v.accept_owner();
    assert_eq!(v.get_config()["owner_id"], "new.near");
}

#[test]
fn withdraw_near_keeps_reserve() {
    let mut v = new_vault();
    set(owner(), 1, 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { v.withdraw_near(U128(NearToken::from_near(5).as_yoctonear())); })).is_err());
    set(owner(), 1, 1);
    v.withdraw_near(U128(NearToken::from_near(4).as_yoctonear()));
}

// ------------------------------------------------------------------ property: caps can never be exceeded

mod props {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]
        #[test]
        fn spent_never_exceeds_daily_cap(amounts in proptest::collection::vec(0u128..80, 1..40), fail in proptest::collection::vec(any::<bool>(), 40)) {
            let mut v = new_vault();
            for (i, a) in amounts.iter().enumerate() {
                let ts = 1 + i as u64 * HOUR_NS / 2;
                if request(&mut v, *a, ts) {
                    if fail[i] {
                        let seq = v.get_in_flight().unwrap().seq;
                        set_result(PromiseResult::Failed, ts);
                        v.on_quote(seq);
                    } else {
                        complete(&mut v, ts, 1);
                    }
                }
                let u = v.get_usage();
                for (t, s) in &u.spent {
                    let lim = v.get_policy().limit(t).unwrap().max_per_day.0;
                    prop_assert!(s.0 <= lim);
                }
                prop_assert!(u.trades <= 3);
            }
        }
    }
}

#[test]
fn caps_roll_over_24_hours_not_at_midnight() {
    let mut v = new_vault();
    let h23 = 23 * HOUR_NS + 1;
    assert!(request(&mut v, 50, h23)); complete(&mut v, h23, 1);
    assert!(request(&mut v, 50, h23 + 1)); complete(&mut v, h23 + 1, 1);
    // One hour later is a new UTC day, but the 100 spent at 23:00 is still inside the window.
    assert!(!request(&mut v, 1, 24 * HOUR_NS + 1));
    assert_eq!(events("refuse")[0]["code"], "daily_cap");
    // The window is 24 clock-hour buckets: the 23:00 bucket rolls off when hour 47 starts, 23 to 24 hours later.
    assert!(request(&mut v, 50, 47 * HOUR_NS + 1));
}

/// Round 3 I-1 (kept, documented since round 2): hourly buckets bound the 24 h sum at 2x the daily cap and the
/// hourly trade count at 2x across a clock-hour boundary. These pin the bound so a change can't widen it unnoticed.
mod bucket_edges {
    use super::*;

    #[test]
    fn at_most_two_daily_caps_inside_any_24_hours() {
        let mut v = new_vault();
        let t0 = 23 * HOUR_NS + 59 * 60 * 1_000_000_000 + 59 * 1_000_000_000; // 23:59:59
        assert!(request(&mut v, 50, t0)); complete(&mut v, t0, 1);
        assert!(request(&mut v, 50, t0 + 1)); complete(&mut v, t0 + 1, 1);
        let t1 = 47 * HOUR_NS; // 23h00m01s later
        assert!(request(&mut v, 50, t1)); complete(&mut v, t1, 1);
        assert!(request(&mut v, 50, t1 + 1)); complete(&mut v, t1 + 1, 1);
        assert!(!request(&mut v, 1, t1 + 2), "a third cap inside the same 24 hours is refused");
        assert_eq!(events("refuse")[0]["code"], "daily_cap");
    }

    #[test]
    fn at_most_twice_the_hourly_rate_across_a_boundary() {
        let mut p = policy(); p.tokens[0].max_per_day = U128(1_000); p.tokens[0].max_per_trade = U128(1);
        set(vault(), 0, 1);
        let mut v = Vault::new(owner(), agent(), acc("ex.near"), acc("intents.near"), acc("v1.signer"), p, None);
        let t0 = HOUR_NS - 1_000_000_000;
        let mut n = 0;
        for i in 0..4 { if request(&mut v, 1, t0 + i) { n += 1; complete(&mut v, t0 + i, 1); } }
        for i in 0..4 { if request(&mut v, 1, HOUR_NS + i) { n += 1; complete(&mut v, HOUR_NS + i, 1); } }
        assert_eq!(n, 6, "3 per clock hour: at most 6 inside ~1 s, never more");
    }
}

#[test]
fn quote_below_price_band_fails_before_funds_move() {
    let mut p = policy();
    p.pairs[0].min_price_num = U128(4); p.pairs[0].min_price_den = U128(1); // at least 4 out per 1 in
    set(vault(), 0, 1);
    let mut v = Vault::new(owner(), agent(), acc("v2.ref-finance.near"), acc("intents.near"), acc("v1.signer"), p, None);
    assert!(request(&mut v, 10, 2));
    set_result(ok_u128(39), 2); // band floor is 40
    v.on_quote(1);
    assert!(events("failed")[0]["reason"].as_str().unwrap().contains("below the price band"));
    assert_eq!(v.get_usage().spent[0].1, U128(0));
    // At or above the band, the band becomes the floor.
    assert!(request(&mut v, 10, 3));
    set_result(ok_u128(41), 3);
    v.on_quote(2);
    // Rhea: 1% below the 41 quote is 40, and the band also says 40.
    assert_eq!(v.get_in_flight().unwrap().min_amount_out, U128(40));
}

/// Round 2 M-1: Rhea's withdraw reports success even when it kept the payout; only a real drop counts.
#[test]
fn exchange_withdraw_records_what_actually_left_the_exchange() {
    let mut v = new_vault();
    set_result(ok_u128(40), 1);
    assert!(v.on_exchange_after(usdc(), U128(50), U128(50)));
    assert_eq!(events("exchange_withdraw")[0]["amount"], "10");
    set_result(ok_u128(50), 2);
    assert!(!v.on_exchange_after(usdc(), U128(50), U128(50)));
    assert_eq!(events("exchange_withdraw_failed").len(), 1);
}

#[test]
fn withdraw_is_recorded_only_after_it_happened() {
    let mut v = new_vault();
    set_result(PromiseResult::Successful(vec![]), 1);
    assert!(v.on_moved("withdraw".into(), "usdc.near".into(), U128(5), owner()));
    assert_eq!(events("withdraw")[0]["amount"], "5");
    set_result(PromiseResult::Failed, 2);
    assert!(!v.on_moved("withdraw".into(), "usdc.near".into(), U128(5), owner()));
    assert_eq!(events("withdraw").len(), 0);
    assert_eq!(events("withdraw_failed").len(), 1);
    // ft_transfer_call / ft_withdraw replies carry the amount actually moved.
    set_result(ok_u128(3), 3);
    v.on_moved("intents_deposit".into(), "usdc.near".into(), U128(5), acc("intents.near"));
    assert_eq!(events("intents_deposit")[0]["amount"], "3");
}

#[test]
#[should_panic(expected = "agent must be a separate account")]
fn proposed_owner_cannot_become_agent() {
    let mut v = new_vault();
    set(owner(), 1, 1);
    v.propose_owner(acc("new.near"));
    v.set_agent(acc("new.near"));
}

// ------------------------------------------------------------------ NEAR Intents path

mod intents_path {
    use super::*;
    use crate::intents::{INTENT_TTL_SEC, rfc3339};

    const SEC: u64 = 1_000_000_000;

    fn mpc_sig() -> PromiseResult {
        PromiseResult::Successful(json!({"big_r": {"affine_point": format!("03{}", "ab".repeat(32))},
            "s": {"scalar": "cd".repeat(32)}, "recovery_id": 0}).to_string().into_bytes())
    }

    fn set_results(r: Vec<PromiseResult>, ts: u64) {
        testing_env!(ctx(vault(), 0, ts).build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), r);
    }

    fn quote_and_salt(q: u128) -> Vec<PromiseResult> {
        vec![ok_u128(q), PromiseResult::Successful(b"\"a1b2c3d4\"".to_vec())]
    }

    fn set_up(v: &mut Vault) {
        let key = format!("\"secp256k1:{}\"", bs58::encode([9u8; 64]).into_string());
        set_result(PromiseResult::Successful(key.into_bytes()), 1);
        v.on_intents_key();
        set_result(PromiseResult::Successful(vec![]), 1);
        let _ = v.on_key_registered(format!("secp256k1:{}", bs58::encode([9u8; 64]).into_string()));
    }

    fn ask(v: &mut Vault, amount: u128, min: u128, ts: u64) -> bool {
        set(agent(), 0, ts);
        matches!(v.request_intent_swap(usdc(), wnear(), U128(amount), U128(min), HASH.into()), PromiseOrValue::Promise(_))
    }

    /// Request, quote and sign at `t0`; returns the seq.
    fn authorize(v: &mut Vault, amount: u128, quote: u128, t0: u64) -> u64 { authorize_at(v, amount, 1, quote, t0) }

    fn authorize_at(v: &mut Vault, amount: u128, min: u128, quote: u128, t0: u64) -> u64 {
        assert!(ask(v, amount, min, t0));
        let seq = v.get_intents()["open_intent"]["seq"].as_u64().unwrap();
        set_results(quote_and_salt(quote), t0);
        v.on_intent_quote(seq);
        set_result(mpc_sig(), t0);
        v.on_intent_signed(seq, "PAYLOAD".into(), U128(quote));
        seq
    }

    #[test]
    fn refused_until_set_up() {
        let mut v = new_vault();
        assert!(!ask(&mut v, 10, 1, 1));
        assert_eq!(events("refuse")[0]["code"], "intents_not_set_up");
    }

    #[test]
    fn key_is_kept_only_once_registered() {
        let mut v = new_vault();
        let key = format!("\"secp256k1:{}\"", bs58::encode([9u8; 64]).into_string());
        set_result(PromiseResult::Successful(key.into_bytes()), 1);
        v.on_intents_key();
        assert!(v.get_intents()["public_key"].is_null());
        // The add failed: the vault asks intents.near whether the key is there anyway before giving up.
        set_result(PromiseResult::Failed, 1);
        assert!(matches!(v.on_key_registered("secp256k1:x".into()), PromiseOrValue::Promise(_)));
        set_result(PromiseResult::Successful(b"false".to_vec()), 1);
        assert!(!v.on_key_check("secp256k1:x".into()));
        assert!(v.get_intents()["public_key"].is_null());
        // Already registered by an earlier half-finished run (round 2 L-2): setup completes instead of bricking.
        set_result(PromiseResult::Successful(b"true".to_vec()), 1);
        assert!(v.on_key_check("secp256k1:y".into()));
        assert_eq!(v.get_intents()["public_key"], "secp256k1:y");
        let mut v = new_vault();
        set_up(&mut v);
        assert!(v.get_intents()["public_key"].as_str().unwrap().starts_with("secp256k1:"));
    }

    #[test]
    fn signs_at_the_agents_price_down_to_the_owners_slippage() {
        for (min, signed) in [(999_900u128, "999900"), (1, "990000"), (1_100_000, "1100000")] {
            let mut v = new_vault();
            set_up(&mut v);
            authorize_at(&mut v, 50, min, 1_000_000, 1_000 * SEC);
            assert_eq!(v.get_intents()["open_intent"]["min_amount_out"], signed, "agent min {min}");
        }
    }

    #[test]
    fn signs_with_v1_nonce_and_short_deadline() {
        let mut v = new_vault();
        set_up(&mut v);
        let t0 = 1_000 * SEC;
        let seq = authorize(&mut v, 50, 1_000_000, t0);
        let o = v.get_intents()["open_intent"].clone();
        assert_eq!(o["min_amount_out"], "990000", "the quote less the owner's 1% slippage");
        assert_eq!(o["deadline"], rfc3339(t0 / SEC + INTENT_TTL_SEC));
        let nonce = near_sdk::serde_json::from_value::<near_sdk::json_types::Base64VecU8>(o["nonce"].clone()).unwrap().0;
        assert_eq!((&nonce[..5], &nonce[5..9]), (&[0x56, 0x28, 0xf6, 0xc6, 0][..], &[0xa1, 0xb2, 0xc3, 0xd4][..]));
        assert_eq!(i64::from_le_bytes(nonce[9..17].try_into().unwrap()) as u64, (t0 / SEC + INTENT_TTL_SEC + crate::intents::NONCE_TTL_SEC) * SEC);
        let a = &events("intent_authorized");
        assert!(a.is_empty() || a[0]["seq"] == seq);
        assert_eq!(v.get_usage().spent[0].1, U128(50));
        assert!(!ask(&mut v, 10, 1, t0 + SEC));
        assert_eq!(events("refuse")[0]["code"], "busy");
    }

    #[test]
    fn unreadable_signature_keeps_the_cap_until_settled_after_deadline() {
        let mut v = new_vault();
        set_up(&mut v);
        assert!(ask(&mut v, 50, 1, 1));
        set_results(quote_and_salt(1_000), 1);
        v.on_intent_quote(1);
        set_result(PromiseResult::Failed, 1);
        assert!(v.on_intent_signed(1, "P".into(), U128(1_000)).is_none());
        assert_eq!(events("intent_unsigned").len(), 1);
        assert_eq!(v.get_usage().spent[0].1, U128(50), "a signature may exist: cap stays reserved");
        let after = (INTENT_TTL_SEC + 5) * SEC;
        assert!(!ask(&mut v, 10, 1, after));
        assert_eq!(events("refuse")[0]["code"], "unsettled");
        set(acc("anyone.near"), 0, after);
        v.intents_settle();
        set_result(PromiseResult::Successful(b"false".to_vec()), after);
        assert_eq!(val(v.on_settle(1, true)), None, "an unused nonce asks about its salt first");
        set_result(PromiseResult::Successful(b"true".to_vec()), after);
        v.on_settle_salt(1);
        assert_eq!(events("intent_expired").len(), 1);
        assert_eq!(v.get_usage().spent[0].1, U128(0));
        assert!(v.get_intents()["open_intent"].is_null());
    }

    #[test]
    fn settle_records_a_fill_and_keeps_the_cap() {
        let mut v = new_vault();
        set_up(&mut v);
        let seq = authorize(&mut v, 50, 1_000, 1);
        set(acc("anyone.near"), 0, 2);
        v.intents_settle();
        set_result(PromiseResult::Successful(b"true".to_vec()), 2);
        assert_eq!(val(v.on_settle(seq, false)), Some(true));
        let t = &events("trade")[0];
        assert_eq!((t["venue"].as_str(), t["amount_out"].as_str()), (Some("intents"), Some("990")));
        assert_eq!(v.get_usage().spent[0].1, U128(50));
        // Unfilled and not yet expired: nothing changes.
        let seq = authorize(&mut v, 10, 1_000, 3);
        set_result(PromiseResult::Successful(b"false".to_vec()), 4);
        assert_eq!(val(v.on_settle(seq, false)), Some(false));
        assert!(!v.get_intents()["open_intent"].is_null());
    }

    #[test]
    fn band_and_freeze_stop_signing_and_release() {
        let mut p = policy();
        p.pairs[0].min_price_num = U128(4); p.pairs[0].min_price_den = U128(1);
        set(vault(), 0, 1);
        let mut v = Vault::new(owner(), agent(), acc("v2.ref-finance.near"), acc("intents.near"), acc("v1.signer"), p, None);
        set_up(&mut v);
        assert!(ask(&mut v, 10, 1, 2));
        set_results(quote_and_salt(39), 2);
        v.on_intent_quote(1);
        assert!(events("failed")[0]["reason"].as_str().unwrap().contains("price band"));
        assert_eq!(v.get_usage().spent[0].1, U128(0));
        assert!(ask(&mut v, 10, 1, 3));
        set(agent(), 0, 3); v.freeze();
        set_results(quote_and_salt(50), 3);
        v.on_intent_quote(2);
        assert!(events("failed")[0]["reason"].as_str().unwrap().contains("frozen"));
    }

    #[test]
    fn stuck_before_signing_clears_after_timeout() {
        let mut v = new_vault();
        set_up(&mut v);
        assert!(ask(&mut v, 10, 1, 1));
        set(acc("anyone.near"), 0, 2);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { v.intents_settle(); })).is_err());
        set(acc("anyone.near"), 0, 1 + STUCK_NS);
        v.intents_settle();
        assert_eq!(events("failed")[0]["reason"], "stuck before signing");
        assert_eq!(v.get_usage().spent[0].1, U128(0));
    }

    #[test]
    fn rhea_swap_blocked_while_intent_open() {
        let mut v = new_vault();
        set_up(&mut v);
        assert!(ask(&mut v, 10, 1, 1));
        assert!(!request(&mut v, 10, 2));
        assert_eq!(events("refuse")[0]["code"], "busy");
    }

    #[test]
    fn cancel_burns_nonce_and_releases_cap_only_if_executed() {
        let mut v = new_vault();
        set_up(&mut v);
        let seq = authorize(&mut v, 50, 1_000, 1);
        set(agent(), 0, 2);
        v.intents_cancel();
        assert_eq!(v.get_intents()["open_intent"]["stage"], "Cancelling");
        set_result(mpc_sig(), 2); v.on_cancel_signed(seq, "EMPTY".into());
        set_result(PromiseResult::Failed, 2);
        assert!(!v.on_cancelled(seq));
        assert_eq!(v.get_usage().spent[0].1, U128(50));
        set(agent(), 0, 3); v.intents_cancel();
        set_result(mpc_sig(), 3); v.on_cancel_signed(seq, "EMPTY".into());
        set_result(PromiseResult::Successful(vec![]), 3);
        assert!(v.on_cancelled(seq));
        assert_eq!(v.get_usage().spent[0].1, U128(0));
    }

    /// Round 2 H-1: the check ran before the deadline, the callback after it; a fill may have landed in between.
    #[test]
    fn settle_checked_before_deadline_never_records_an_expiry() {
        let mut v = new_vault();
        set_up(&mut v);
        let seq = authorize(&mut v, 50, 1_000, 1);
        let deadline_ns = v.get_intents()["open_intent"]["deadline_ns"].as_str().unwrap().parse::<u64>().unwrap();
        set(acc("anyone.near"), 0, deadline_ns - 1);
        v.intents_settle();
        set_result(PromiseResult::Successful(b"false".to_vec()), deadline_ns + 10 * SEC);
        assert_eq!(val(v.on_settle(seq, false)), Some(false));
        assert!(events("intent_expired").is_empty());
        assert_eq!(v.get_usage().spent[0].1, U128(50));
        assert!(!v.get_intents()["open_intent"].is_null());
    }

    /// Round 2 H-2: the nonce outlives the intent by 30 days, so intents.near's cleanup can't erase a fill first;
    /// after that horizon the outcome is recorded as unresolved, never as an expiry.
    #[test]
    fn nonce_outlives_intent_and_late_settle_is_unresolved() {
        let mut v = new_vault();
        set_up(&mut v);
        authorize(&mut v, 50, 1_000, 1);
        let o = v.get_intents()["open_intent"].clone();
        let nonce = near_sdk::serde_json::from_value::<near_sdk::json_types::Base64VecU8>(o["nonce"].clone()).unwrap().0;
        let nonce_deadline = i64::from_le_bytes(nonce[9..17].try_into().unwrap()) as u64;
        let deadline = o["deadline_ns"].as_str().unwrap().parse::<u64>().unwrap();
        assert_eq!(nonce_deadline, deadline + crate::intents::NONCE_TTL_SEC * SEC);
        set(acc("anyone.near"), 0, nonce_deadline + 1);
        assert!(matches!(v.intents_settle(), PromiseOrValue::Value(false)));
        assert_eq!(events("intent_unresolved").len(), 1);
        assert!(events("intent_expired").is_empty());
        assert_eq!(v.get_usage().spent.iter().map(|(_, a)| a.0).sum::<u128>(), 0, "rolled off the 24 h window by then");
    }

    /// Round 2 L-3: a used nonce after a cancel whose callback never reported may be our own burn.
    #[test]
    fn used_nonce_after_unreported_cancel_is_not_claimed_as_a_trade() {
        let mut v = new_vault();
        set_up(&mut v);
        let seq = authorize(&mut v, 50, 1_000, 1);
        set(agent(), 0, 2);
        v.intents_cancel();
        set_result(PromiseResult::Successful(b"true".to_vec()), 2);
        assert_eq!(val(v.on_settle(seq, true)), Some(false));
        assert_eq!(events("intent_closed").len(), 1);
        assert!(events("trade").is_empty());
    }

    /// Round 3 M-1: every combination of nonce used/unused, salt valid/invalid/unreadable, before/after the deadline
    /// and burn attempted/not. Only "unused, after the deadline, salt still valid" may release the cap.
    #[test]
    fn settle_state_machine() {
        let b = |x: bool| PromiseResult::Successful(if x { b"true".to_vec() } else { b"false".to_vec() });
        for used in [true, false] { for salt in [Some(true), Some(false), None] { for after in [false, true] { for burn in [false, true] {
            let mut v = new_vault();
            set_up(&mut v);
            let seq = authorize(&mut v, 50, 1_000, 1);
            if burn { set(agent(), 0, 2); v.intents_cancel(); }
            let deadline = v.get_intents()["open_intent"]["deadline_ns"].as_str().unwrap().parse::<u64>().unwrap();
            let now = if after { deadline + SEC } else { deadline };
            set(acc("anyone.near"), 0, now);
            // A cancel in progress blocks settling until the deadline.
            if burn && !after { continue; }
            v.intents_settle();
            set_result(b(used), now);
            let r = val(v.on_settle(seq, after));
            let case = format!("used={used} salt={salt:?} after={after} burn={burn}");
            match (used, burn, after) {
                (true, true, _) => { assert_eq!(r, Some(false), "{case}"); assert_eq!(events("intent_closed").len(), 1, "{case}"); }
                (true, false, _) => { assert_eq!(r, Some(true), "{case}"); assert_eq!(events("trade").len(), 1, "{case}"); }
                (false, _, false) => { assert_eq!(r, Some(false), "{case}"); assert!(!v.get_intents()["open_intent"].is_null(), "{case}"); }
                (false, _, true) => {
                    assert_eq!(r, None, "{case}: must ask whether the salt is still valid");
                    match salt { Some(x) => set_result(b(x), now), None => set_result(PromiseResult::Failed, now) }
                    v.on_settle_salt(seq);
                    match salt {
                        Some(true) => { assert_eq!(events("intent_expired").len(), 1, "{case}"); assert_eq!(v.get_usage().spent[0].1, U128(0), "{case}"); }
                        Some(false) => {
                            assert_eq!(events("intent_unresolved").len(), 1, "{case}");
                            assert!(events("intent_expired").is_empty(), "{case}");
                            assert_eq!(v.get_usage().spent[0].1, U128(50), "{case}: cap kept");
                            assert!(v.get_intents()["open_intent"].is_null(), "{case}");
                        }
                        None => { assert!(!v.get_intents()["open_intent"].is_null(), "{case}: undecided"); assert_eq!(v.get_usage().spent[0].1, U128(50), "{case}"); }
                    }
                    continue;
                }
            }
            if !(used || after) { continue; }
            assert!(events("intent_expired").is_empty(), "{case}");
            assert_eq!(v.get_usage().spent[0].1, U128(50), "{case}: a used nonce never frees the cap");
        }}}}
    }

    #[test]
    #[should_panic(expected = "attach at least")]
    fn settle_needs_gas_for_the_salt_check() {
        let mut v = new_vault();
        set_up(&mut v);
        authorize(&mut v, 50, 1_000, 1);
        let mut c = ctx(acc("anyone.near"), 0, 10 * SEC * 1_000);
        c.prepaid_gas(Gas::from_tgas(crate::intents::TG_MIN_SETTLE - 1));
        testing_env!(c.build());
        v.intents_settle();
    }

    /// Round 3 L-2: the owner can close an intent settlement can't resolve, but only well after its deadline, and the
    /// cap stays reserved, so this can never free a cap.
    #[test]
    fn owner_can_abandon_an_unresolvable_intent_without_freeing_the_cap() {
        let mut v = new_vault();
        set_up(&mut v);
        authorize(&mut v, 50, 1_000, 1);
        let deadline = v.get_intents()["open_intent"]["deadline_ns"].as_str().unwrap().parse::<u64>().unwrap();
        let try_at = |v: &mut Vault, who: AccountId, ts: u64| {
            set(who, 1, ts);
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| v.intents_abandon())).is_ok()
        };
        assert!(!try_at(&mut v, agent(), deadline + crate::intents::ABANDON_GRACE_NS), "owner only");
        assert!(!try_at(&mut v, owner(), deadline + 1), "too early");
        assert!(try_at(&mut v, owner(), deadline + crate::intents::ABANDON_GRACE_NS));
        assert_eq!(events("intent_unresolved").len(), 1);
        assert!(events("intent_expired").is_empty());
        assert_eq!(v.get_usage().spent[0].1, U128(50));
        assert!(v.get_intents()["open_intent"].is_null());
        // Before signing there is nothing to abandon: intents_settle clears it.
        let mut v = new_vault();
        set_up(&mut v);
        assert!(ask(&mut v, 10, 1, 1));
        assert!(!try_at(&mut v, owner(), STUCK_NS * 10));
    }

    #[test]
    fn nonce_salt_round_trips() {
        let n = crate::intents::v1_nonce([0xa1, 0xb2, 0xc3, 0xd4], 5, &[3u8; 15]);
        let b64 = near_sdk::serde_json::to_value(near_sdk::json_types::Base64VecU8(n.to_vec())).unwrap();
        assert_eq!(crate::intents::nonce_salt(b64.as_str().unwrap()).as_deref(), Some("a1b2c3d4"));
        assert_eq!(crate::intents::nonce_salt("AAAA"), None);
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn agent_cannot_move_funds_into_intents() {
        let mut v = new_vault();
        set(agent(), 1, 1);
        v.intents_deposit(usdc(), U128(1));
    }
}

// ---------------------------------------------------------------- deposit caps

fn capped_vault(caps: Vec<(AccountId, u128)>) -> Vault {
    set(vault(), 0, 1);
    Vault::new(owner(), agent(), acc("v2.ref-finance.near"), acc("intents.near"), acc("v1.signer"), policy(),
        Some(caps.into_iter().map(|(token, m)| DepositCap { token, max: U128(m) }).collect()))
}

fn deposit(v: &mut Vault, token: AccountId, from: AccountId, amount: u128) -> u128 {
    set(token, 0, 1);
    match v.ft_on_transfer(from, U128(amount), String::new()) { PromiseOrValue::Value(U128(r)) => r, _ => panic!("promise") }
}

#[test]
fn no_caps_means_uncapped() {
    let mut v = new_vault();
    assert_eq!(deposit(&mut v, usdc(), owner(), 1_000_000), 0);
    assert_eq!(v.get_deposit_caps(), json!([]));
}

#[test]
fn cap_accepts_up_to_the_cap_and_returns_the_rest() {
    let mut v = capped_vault(vec![(usdc(), 20), (wnear(), 5)]);
    assert_eq!(deposit(&mut v, usdc(), owner(), 15), 0);
    assert_eq!(deposit(&mut v, usdc(), owner(), 10), 5, "only 5 of room left");
    assert_eq!(events("deposit")[0]["returned"], json!("5"));
    assert_eq!(deposit(&mut v, usdc(), owner(), 1), 1, "at the cap: all returned");
    assert_eq!(events("deposit_refused")[0]["code"], json!("deposit_cap"));
    assert_eq!(deposit(&mut v, wnear(), owner(), 5), 0, "caps are per token");
    assert_eq!(v.get_deposit_caps()[0]["net_deposited"], json!("20"));
}

#[test]
fn capped_vault_refuses_a_policy_token_without_a_cap() {
    let mut v = capped_vault(vec![(usdc(), 20)]);
    assert_eq!(deposit(&mut v, wnear(), owner(), 1), 1);
}

#[test]
fn owner_withdrawal_frees_room_but_never_below_zero() {
    let mut v = capped_vault(vec![(usdc(), 20)]);
    deposit(&mut v, usdc(), owner(), 20);
    set_result(ok_u128(30), 1);
    assert!(v.on_moved("withdraw".into(), usdc().to_string(), U128(30), owner()), "gains withdrawn");
    assert_eq!(v.get_deposit_caps()[0]["net_deposited"], json!("0"));
    assert_eq!(deposit(&mut v, usdc(), owner(), 20), 0);
}

#[test]
fn failed_or_non_owner_moves_do_not_free_room() {
    let mut v = capped_vault(vec![(usdc(), 20)]);
    deposit(&mut v, usdc(), owner(), 20);
    set_result(PromiseResult::Failed, 1);
    assert!(!v.on_moved("withdraw".into(), usdc().to_string(), U128(20), owner()));
    set_result(ok_u128(20), 1);
    v.on_moved("intents_withdraw".into(), usdc().to_string(), U128(20), vault());
    assert_eq!(v.get_deposit_caps()[0]["net_deposited"], json!("20"));
}

#[test]
fn non_owner_deposits_are_still_returned_and_not_counted() {
    let mut v = capped_vault(vec![(usdc(), 20)]);
    assert_eq!(deposit(&mut v, usdc(), agent(), 5), 5);
    assert_eq!(v.get_deposit_caps()[0]["net_deposited"], json!("0"));
}

#[test]
#[should_panic(expected = "duplicate deposit cap")]
fn init_rejects_duplicate_caps() { capped_vault(vec![(usdc(), 20), (usdc(), 30)]); }

#[test]
#[should_panic(expected = "deposit cap must be above 0")]
fn init_rejects_zero_cap() { capped_vault(vec![(usdc(), 0)]); }

fn caps_of(v: &[(AccountId, u128)]) -> Vec<DepositCap> { v.iter().map(|(t, m)| DepositCap { token: t.clone(), max: U128(*m) }).collect() }

#[test]
fn parent_can_change_caps_and_room_follows() {
    // vault.near's direct parent is "near".
    let mut v = capped_vault(vec![(usdc(), 20)]);
    deposit(&mut v, usdc(), owner(), 20);
    set(acc("near"), 0, 1);
    v.set_deposit_caps(caps_of(&[(usdc(), 50), (wnear(), 5)]));
    assert_eq!(events("deposit_caps_set").len(), 1);
    assert_eq!(deposit(&mut v, usdc(), owner(), 40), 10, "raised: 30 more room");
    assert_eq!(deposit(&mut v, wnear(), owner(), 5), 0, "a newly capped token can be deposited");
    set(acc("near"), 0, 1);
    v.set_deposit_caps(caps_of(&[(usdc(), 10)]));
    assert_eq!(deposit(&mut v, usdc(), owner(), 1), 1, "lowered below what's in: no room, nothing moves");
    assert_eq!(v.get_deposit_caps()[0]["net_deposited"], json!("50"));
    set(acc("near"), 0, 1);
    v.set_deposit_caps(vec![]);
    assert_eq!(deposit(&mut v, usdc(), owner(), 1_000), 0, "empty = uncapped");
}

#[test]
#[should_panic(expected = "only the vault's parent")]
fn owner_cannot_change_caps() {
    let mut v = capped_vault(vec![(usdc(), 20)]);
    set(owner(), 0, 1);
    v.set_deposit_caps(vec![]);
}

#[test]
#[should_panic(expected = "only the vault's parent")]
fn agent_cannot_change_caps() {
    let mut v = capped_vault(vec![(usdc(), 20)]);
    set(agent(), 0, 1);
    v.set_deposit_caps(vec![]);
}

#[test]
#[should_panic(expected = "duplicate deposit cap")]
fn parent_caps_are_validated() {
    let mut v = capped_vault(vec![(usdc(), 20)]);
    set(acc("near"), 0, 1);
    v.set_deposit_caps(caps_of(&[(usdc(), 1), (usdc(), 2)]));
}
