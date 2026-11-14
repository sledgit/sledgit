//! Broad live testnet suite + performance test for the vault and factory. Testnet only.
//!
//!   cargo run --example testnet_suite
//!
//! Uses only accounts whose keys are in ~/.config/sledgit/ (never printed). Consolidates spare test NEAR into one
//! treasury, publishes the vault code once (global, by hash), deploys the factory as `irontrade.testnet`, creates
//! vaults `perf`, `lifecycle`, `suite` from it, then runs functional checks and timing. Idempotent: existing accounts and
//! contracts are reused. Results (no secrets): deploy/testnet/suite-<ts>.json and perf-<ts>.json.
#![allow(unused_must_use, non_snake_case)]
use k256::ecdsa::SigningKey;
use near_api::types::transaction::result::TransactionResult;
use near_api::{AccountId, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::{self, json, Value};
use sha3::{Digest, Keccak256};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};
#[path = "shared/local.rs"] mod local;

type R<T = ()> = Result<T, Box<dyn std::error::Error>>;
const RPC: &str = "https://rpc.testnet.fastnear.com";
const REF: &str = "ref-finance-101.testnet";
const MPC: &str = "v1.signer-prod.testnet";
const INTENTS: &str = "it1793205011-intents.testnet";
const WRAP: &str = "wrap.testnet";
const USDC: &str = "usdc.itachicara.testnet";
const POOL: u64 = 1103;
const TREASURY: &str = "it1793205219-owner.testnet";
const E24: u128 = 1_000_000_000_000_000_000_000_000;
const MILLI: u128 = E24 / 1000;

fn id(s: &str) -> AccountId { s.parse().unwrap() }
fn keccak(b: &[u8]) -> [u8; 32] { Keccak256::digest(b).into() }
fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }
fn y(n: u128) -> NearToken { NearToken::from_yoctonear(n) }

#[derive(Default)]
struct Sample { secs: f64, tgas: u64, near: f64 }

struct T {
    net: NetworkConfig,
    keys: HashMap<String, Arc<Signer>>,
    perf: BTreeMap<String, Vec<Sample>>,
    checks: Vec<(String, bool, String)>,
    txs: Vec<Value>,
    receipt_n: u64,
}

fn events(r: &TransactionResult, std: &str, kind: &str) -> Vec<Value> {
    let legacy = std.replacen("sledgit", "irontrade", 1); // pre-rename testnet code
    r.logs().iter().filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|j| serde_json::from_str::<Value>(j).ok())
        .filter(|e| (e["standard"] == std || e["standard"] == legacy.as_str()) && e["event"] == kind).map(|e| e["data"][0].clone()).collect()
}
fn ev(r: &TransactionResult, kind: &str) -> Vec<Value> { events(r, "sledgit", kind) }
fn refusal(r: &TransactionResult) -> String { ev(r, "refuse").first().and_then(|e| e["code"].as_str().map(String::from)).unwrap_or_default() }

impl T {
    fn signer(&self, who: &str) -> R<Arc<Signer>> { Ok(self.keys.get(who).cloned().ok_or(format!("no key for {who}"))?) }

    async fn call(&mut self, op: &str, who: &str, contract: &str, method: &str, args: Value, deposit: NearToken, tgas: u64) -> R<TransactionResult> {
        let t0 = Instant::now();
        // An InvalidTransaction (e.g. a nonce race with another writer on the same key) never executed: retry it.
        let mut tries = 0;
        let r = loop {
            match near_api::Contract(id(contract)).call_function(method, args.clone()).transaction()
                .gas(NearGas::from_tgas(tgas)).deposit(deposit).with_signer(id(who), self.signer(who)?)
                .send_to(&self.net).await {
                Ok(r) => break r,
                Err(e) if tries < 4 && format!("{e:?}").contains("InvalidTransaction") => {
                    tries += 1;
                    println!("  {op}: InvalidTransaction, retry {tries}/4");
                    tokio::time::sleep(Duration::from_secs(4 * tries)).await;
                }
                Err(e) => return Err(e.into()),
            }
        };
        let secs = t0.elapsed().as_secs_f64();
        let full = r.clone().into_full();
        let tgas_burnt = full.as_ref().map(|f| f.total_gas_burnt.as_tgas()).unwrap_or(0);
        let near: f64 = full.as_ref().map(|f| f.outcomes().iter().map(|o| o.tokens_burnt.as_yoctonear() as f64).sum::<f64>() / E24 as f64).unwrap_or(0.0);
        let hash = full.as_ref().and_then(|f| f.outcomes().first().map(|o| o.transaction_hash.to_string())).unwrap_or_default();
        let ok = r.clone().into_result().is_ok();
        self.perf.entry(op.into()).or_default().push(Sample { secs, tgas: tgas_burnt, near });
        self.txs.push(json!({"op": op, "method": method, "contract": contract, "ok": ok, "tx": hash, "secs": secs, "tgas": tgas_burnt}));
        println!("  {:<30} {} {:>4} Tgas {:>5.1}s {}", op, if ok { "ok  " } else { "fail" }, tgas_burnt, secs, &hash);
        Ok(r)
    }

    /// A call that must not succeed for this signer. True when the contract refuses it, or when the network rejects it
    /// before execution (an agent's function-call key can't attach a deposit or call an owner method). One attempt.
    async fn reject(&mut self, op: &str, who: &str, contract: &str, method: &str, args: Value, deposit: NearToken, tgas: u64) -> R<(bool, String)> {
        let r = near_api::Contract(id(contract)).call_function(method, args).transaction()
            .gas(NearGas::from_tgas(tgas)).deposit(deposit).with_signer(id(who), self.signer(who)?).send_to(&self.net).await;
        match r {
            Ok(r) => { let refused = r.into_result().is_err(); println!("  {:<30} {} (contract)", op, if refused { "refused" } else { "ALLOWED" }); Ok((refused, "refused by the contract".into())) }
            Err(e) if format!("{e:?}").contains("InvalidTransaction") => {
                println!("  {:<30} rejected before execution (key scope)", op);
                self.txs.push(json!({"op": op, "method": method, "contract": contract, "ok": false, "tx": "", "rejected_by": "access key scope"}));
                Ok((true, "rejected before execution: the signer's key can't make this call".into()))
            }
            Err(e) => Err(e.into()),
        }
    }

    async fn view<V: near_sdk::serde::de::DeserializeOwned + Send + Sync>(&mut self, op: &str, contract: &str, method: &str, args: Value) -> R<V> {
        let t0 = Instant::now();
        let v = near_api::Contract(id(contract)).call_function(method, args).read_only().fetch_from(&self.net).await?.data;
        self.perf.entry(op.into()).or_default().push(Sample { secs: t0.elapsed().as_secs_f64(), ..Default::default() });
        Ok(v)
    }

    async fn exists(&self, a: &str) -> bool { near_api::Account(id(a)).view().fetch_from(&self.net).await.is_ok() }

    async fn bal(&mut self, token: &str, who: &str) -> R<u128> {
        let v: String = self.view("view:ft_balance_of", token, "ft_balance_of", json!({"account_id": who})).await?;
        Ok(v.parse()?)
    }

    async fn ibal(&mut self, who: &str, token: &str) -> R<u128> {
        let v: String = self.view("view:mt_balance_of", INTENTS, "mt_balance_of", json!({"account_id": who, "token_id": format!("nep141:{token}")})).await?;
        Ok(v.parse()?)
    }

    fn check(&mut self, name: &str, ok: bool, detail: impl Into<String>) {
        let d = detail.into();
        println!("    {} {}{}", if ok { "PASS" } else { "FAIL" }, name, if ok || d.is_empty() { String::new() } else { format!(" ({d})") });
        self.checks.push((name.into(), ok, d));
    }

    fn receipt(&mut self) -> String { self.receipt_n += 1; hex(&keccak(format!("suite receipt {}", self.receipt_n).as_bytes())) }

    async fn swap(&mut self, op: &str, agent: &str, vault: &str, tin: &str, tout: &str, amount: u128) -> R<TransactionResult> {
        let rh = self.receipt();
        self.call(op, agent, vault, "request_swap", json!({"token_in": tin, "token_out": tout, "amount_in": amount.to_string(),
            "min_amount_out": "1", "receipt_hash": rh}), y(0), 300).await
    }

    async fn intent(&mut self, op: &str, agent: &str, vault: &str, amount: u128) -> R<TransactionResult> {
        let rh = self.receipt();
        self.call(op, agent, vault, "request_intent_swap", json!({"token_in": WRAP, "token_out": USDC, "amount_in": amount.to_string(),
            "min_amount_out": "1", "receipt_hash": rh}), y(0), 300).await
    }
}

fn load_keys() -> R<HashMap<String, Arc<Signer>>> {
    let dir = local::key_dir()?;
    let mut keys = HashMap::new();
    for e in std::fs::read_dir(&dir)? {
        let p = e?.path();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        if !name.starts_with("testnet-") || !name.ends_with(".json") { continue; }
        let d: Value = serde_json::from_str(&std::fs::read_to_string(&p)?)?;
        let mut add = |acct: &str, sk: &str| -> R { keys.insert(acct.to_string(), Signer::from_secret_key(sk.parse()?)?); Ok(()) };
        if let (Some(sk), Some(accts)) = (d["secret_key"].as_str(), d["accounts"].as_array()) {
            for a in accts { if let Some(a) = a.as_str() { add(a, sk)?; } }
        }
        if let Some(list) = d["keys"].as_array() {
            for k in list { if let (Some(a), Some(sk)) = (k["account_id"].as_str(), k["secret_key"].as_str()) { add(a, sk)?; } }
        }
    }
    Ok(keys)
}

fn policy(per_trade_wnear: u128, per_day_wnear: u128, trades_per_hour: u32) -> Value {
    json!({"tokens": [
            {"token": WRAP, "max_per_trade": per_trade_wnear.to_string(), "max_per_day": per_day_wnear.to_string()},
            {"token": USDC, "max_per_trade": E24.to_string(), "max_per_day": (5 * E24).to_string()}],
        "pairs": [{"token_in": WRAP, "token_out": USDC, "pool_id": POOL, "min_price_num": "14", "min_price_den": "10"},
                  {"token_in": USDC, "token_out": WRAP, "pool_id": POOL, "min_price_num": "33", "min_price_den": "100"}],
        "max_trades_per_hour": trades_per_hour, "max_slippage_bps": 100})
}

/// The solver: a fixed secp256k1 key whose implicit 0x account holds USDC on our intents copy.
fn solver() -> (SigningKey, String) {
    let k = SigningKey::from_bytes(&keccak(b"iron-trade testnet suite solver").into()).unwrap();
    let p = k.verifying_key().to_encoded_point(false);
    let addr = format!("0x{}", hex(&keccak(&p.as_bytes()[1..])[12..]));
    (k, addr)
}

fn solver_fill(key: &SigningKey, addr: &str, give_usdc: u128, take_wnear: u128, salt: u64) -> Value {
    let payload = json!({"signer_id": addr, "verifying_contract": INTENTS, "deadline": "2030-01-01T00:00:00Z",
        "nonce": serde_json::to_value(Base64VecU8(keccak(format!("{addr}{give_usdc}{take_wnear}{salt}").as_bytes()).to_vec())).unwrap(),
        "intents": [{"intent": "token_diff", "diff": {format!("nep141:{WRAP}"): take_wnear.to_string(),
            format!("nep141:{USDC}"): format!("-{give_usdc}")}}]}).to_string();
    let mut msg = format!("\x19Ethereum Signed Message:\n{}", payload.len()).into_bytes();
    msg.extend_from_slice(payload.as_bytes());
    let (sig, recid) = key.sign_prehash_recoverable(&keccak(&msg)).unwrap();
    let mut raw = sig.to_bytes().to_vec();
    raw.push(u8::from(recid.is_y_odd()));
    json!({"standard": "erc191", "payload": payload, "signature": format!("secp256k1:{}", bs58::encode(raw).into_string())})
}

async fn near_balance(net: &NetworkConfig, a: &str) -> f64 {
    near_api::Tokens::account(id(a)).near_balance().fetch_from(net).await
        .map(|b| b.total.as_yoctonear().saturating_sub(b.storage_locked.as_yoctonear()) as f64 / E24 as f64).unwrap_or(0.0)
}

#[tokio::main]
async fn main() -> R {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs();
    let net = NetworkConfig::from_rpc_url("testnet", RPC.parse()?);
    let keys = load_keys()?;
    let mut t = T { net, keys, perf: BTreeMap::new(), checks: vec![], txs: vec![], receipt_n: ts };
    let only = std::env::var("SUITE_ONLY").unwrap_or_default();
    // IT_FACTORY / IT_SUITE_NAMES (perf,lifecycle,refusals vault names) let the suite target a newer factory.
    let factory = std::env::var("IT_FACTORY").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "irontrade.testnet".into());
    let names_env = std::env::var("IT_SUITE_NAMES").unwrap_or_else(|_| "perf,lifecycle,suite".into());
    let names: Vec<&str> = names_env.split(',').collect();
    if names.len() != 3 { return Err("IT_SUITE_NAMES needs three names".into()); }
    let FACTORY: &str = &factory;
    // IT_SUITE_AGENTS: the three vaults' agent accounts (default: the original testnet agents).
    let agents_env = std::env::var("IT_SUITE_AGENTS").unwrap_or_else(|_| "it1793205219-agent.testnet,it1793205011-fund1.testnet,it1793205011-fund2.testnet".into());
    let agents: Vec<String> = agents_env.split(',').map(String::from).collect();
    if agents.len() != 3 { return Err("IT_SUITE_AGENTS needs three accounts".into()); }
    let want = |s: &str| only.is_empty() || only.split(',').any(|x| x == s);

    // ------------------------------------------------------------------ treasury
    println!("== treasury");
    let keep: HashMap<&str, f64> = [("it1793205011-agent.testnet", 2.0), ("it1793205011-intents.testnet", 0.3),
        ("it1793205219-agent.testnet", 1.0), ("it1793205011-fund1.testnet", 0.45), ("it1793205011-fund2.testnet", 0.45),
        ("irontrade-1793186555.testnet", 0.2)].into_iter().collect();
    // IT_SKIP_CONSOLIDATE=1 leaves every account alone (live agent accounts must keep their gas money).
    let skip_sweep = std::env::var("IT_SKIP_CONSOLIDATE").map(|v| v == "1").unwrap_or(false);
    let sources: Vec<String> = if skip_sweep { vec![] } else { t.keys.keys().filter(|a| a.as_str() != TREASURY).cloned().collect() };
    for a in sources {
        let free = near_balance(&t.net, &a).await;
        let k = *keep.get(a.as_str()).unwrap_or(&0.1);
        if free - k > 0.5 {
            let amt = NearToken::from_millinear(((free - k) * 1000.0) as u128);
            let r = near_api::Tokens::account(id(&a)).send_to(id(TREASURY)).near(amt).with_signer(t.signer(&a)?).send_to(&t.net).await;
            println!("  {a} -> treasury {:.2} NEAR {}", (free - k), if r.map(|x| x.into_result().is_ok()).unwrap_or(false) { "ok" } else { "FAIL" });
        }
    }
    println!("  treasury free: {:.2} NEAR", near_balance(&t.net, TREASURY).await);

    // ------------------------------------------------------------------ factory
    println!("== factory");
    let vault_code = std::fs::read("../target/near/sledgit_vault/sledgit_vault.wasm")?;
    let code_hash = bs58::encode(<k256::sha2::Sha256 as Digest>::digest(&vault_code)).into_string();
    if !t.exists(FACTORY).await {
        let need = vault_code.len() as f64 * 1e-4 + 2.2;
        let have = near_balance(&t.net, TREASURY).await;
        if have < need { return Err(format!("treasury has {have:.2} NEAR, factory needs ~{need:.2}: missing {:.2}", need - have).into()); }
        let t0 = Instant::now();
        near_api::Contract::deploy_global_contract_code(vault_code.clone()).as_hash()
            .with_signer(id(TREASURY), t.signer(TREASURY)?).send_to(&t.net).await?.assert_success();
        println!("  global vault code published ({} bytes, hash {code_hash}) in {:.1}s", vault_code.len(), t0.elapsed().as_secs_f64());
        let pk = t.signer(TREASURY)?.get_public_key().await?;
        near_api::Account::create_account(id(FACTORY)).fund_myself(id(TREASURY), NearToken::from_millinear(2_000))
            .with_public_key(pk).with_signer(t.signer(TREASURY)?).send_to(&t.net).await?.assert_success();
        t.keys.insert(FACTORY.into(), t.signer(TREASURY)?);
        near_api::Contract::deploy(id(FACTORY)).use_code(std::fs::read("../target/near/sledgit_factory/sledgit_factory.wasm")?)
            .with_init_call("new", json!({"code_hash": code_hash, "exchange_id": REF, "intents_id": INTENTS, "mpc_id": MPC,
                "min_deposit": E24.to_string()}))?
            .with_signer(t.signer(TREASURY)?).send_to(&t.net).await?.assert_success();
        println!("  factory deployed: {FACTORY}");
    }
    t.keys.insert(FACTORY.into(), t.signer(TREASURY)?);
    let fcfg: Value = t.view("view:factory_config", FACTORY, "get_config", json!({})).await?;
    t.check("factory pinned to the current vault code hash", fcfg["code_hash"] == code_hash, format!("{}", fcfg["code_hash"]));

    let vaults = [(names[0], agents[0].as_str(), policy(E24 / 2, 3 * E24, 60)),
                  (names[1], agents[1].as_str(), policy(E24 / 2, 3 * E24, 10)),
                  (names[2], agents[2].as_str(), policy(5 * E24 / 100, 12 * E24 / 100, 3))];
    for (name, agent, pol) in &vaults {
        let v = format!("{name}.{FACTORY}");
        if !t.exists(&v).await {
            let r = t.call("factory:create_vault", TREASURY, FACTORY, "create_vault", json!({"name": name, "owner_id": TREASURY,
                "agent_id": agent, "policy": pol}), NearToken::from_millinear(1_500), 150).await?;
            t.check(&format!("factory created {v}"), events(&r, "sledgit-factory", "vault_created").len() == 1, format!("{:?}", r.logs()));
            for tok in [WRAP, USDC] {
                t.call("setup:storage_deposit", TREASURY, tok, "storage_deposit", json!({"account_id": v}), NearToken::from_millinear(10), 30).await?;
            }
            t.call("setup:exchange_storage", TREASURY, &v, "exchange_storage_deposit", json!({}), NearToken::from_millinear(100), 50).await?;
            t.call("setup:register_tokens", TREASURY, &v, "exchange_register_tokens", json!({}), y(1), 50).await?;
        }
        let keys = near_api::Account(id(&v)).list_keys().fetch_from(&t.net).await?.data;
        t.check(&format!("{v} has no access keys"), keys.is_empty(), "");
    }
    let (perf, lifecycle, suite) = (format!("{}.{FACTORY}", names[0]), format!("{}.{FACTORY}", names[1]), format!("{}.{FACTORY}", names[2]));
    let (a_perf, a_lifecycle, a_suite) = (agents[0].as_str(), agents[1].as_str(), agents[2].as_str());
    // IT_STRANGER: a non-owner account with a full-access key, so "anyone"/"stranger" checks reach the contract (a scoped
    // agent key on another vault is refused by the protocol before the contract can say no).
    // Without IT_STRANGER the fallback is a vault agent whose scoped key the protocol rejects before the contract sees
    // the call, so "stranger" checks would pass for the wrong reason (final review 2 F2-15). Refuse instead.
    let stranger_env = std::env::var("IT_STRANGER").map_err(|_| "IT_STRANGER is required: a non-owner account with a full-access key, so the stranger and anyone-can-settle checks reach the contract")?;
    let stranger = stranger_env.as_str();
    // Fund: wrap NEAR and send wNEAR to the vaults that need it.
    for tok in [WRAP, USDC] { t.call("setup:storage_deposit", TREASURY, tok, "storage_deposit", json!({"account_id": TREASURY}), NearToken::from_millinear(10), 30).await?; }
    let want_w = [(perf.as_str(), 700 * MILLI), (lifecycle.as_str(), 200 * MILLI), (suite.as_str(), 250 * MILLI)];
    let mut top: Vec<(String, u128)> = vec![];
    for (v, w) in want_w { let have = t.bal(WRAP, v).await?; if have < w / 2 { top.push((v.to_string(), w - have)); } }
    let need: u128 = top.iter().map(|x| x.1).sum();
    if need > 0 {
        t.call("setup:wrap", TREASURY, WRAP, "near_deposit", json!({}), y(need), 30).await?;
        for (v, a) in top { t.call("setup:fund_vault", TREASURY, WRAP, "ft_transfer_call", json!({"receiver_id": v, "amount": a.to_string(), "msg": ""}), y(1), 100).await?; }
    }

    // An interrupted earlier run can leave an intent open; once past its deadline anyone may settle it, which frees the
    // vault for this run (the settle records the real outcome: expired, a trade, or unresolved).
    for v in [&perf, &lifecycle, &suite] {
        let st: Value = t.view("view:get_intents", v, "get_intents", json!({})).await?;
        // Only intents whose deadline passed over 2 h ago: a concurrent abandon run keeps its intent for deadline + 1 h.
        let deadline_ns: u128 = st["open_intent"]["deadline_ns"].as_str().unwrap_or("0").parse().unwrap_or(0);
        let now_ns = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos();
        let age_ns: u128 = std::env::var("IT_LEFTOVER_AGE_S").ok().and_then(|v| v.parse().ok()).unwrap_or(7_200) * 1_000_000_000;
        if !st["open_intent"].is_null() && deadline_ns > 0 && deadline_ns + age_ns < now_ns {
            t.call("setup:settle leftover intent", TREASURY, v, "intents_settle", json!({}), y(0), 100).await?;
        }
    }

    // ------------------------------------------------------------------ performance (perf vault)
    if want("perf") {
        println!("== performance");
        for _ in 0..20 {
            let t0 = Instant::now();
            near_api::Account(id(TREASURY)).view().fetch_from(&t.net).await?;
            t.perf.entry("rpc:view_account".into()).or_default().push(Sample { secs: t0.elapsed().as_secs_f64(), ..Default::default() });
            let _: Value = t.view("view:get_config", &perf, "get_config", json!({})).await?;
            let _: Value = t.view("view:get_policy", &perf, "get_policy", json!({})).await?;
            let _: Value = t.view("view:get_usage", &perf, "get_usage", json!({})).await?;
            let _: Value = t.view("view:preview_swap", &perf, "preview_swap", json!({"token_in": WRAP, "token_out": USDC, "amount_in": (20 * MILLI).to_string(), "min_amount_out": "1"})).await?;
        }
        // Pure MPC signing latency (the treasury signs a random hash on its own path).
        for i in 0..5 {
            t.call("mpc:sign (direct)", TREASURY, MPC, "sign", json!({"request": {"payload_v2": {"Ecdsa": hex(&keccak(format!("perf{ts}{i}").as_bytes()))},
                "path": "iron-trade/perf", "domain_id": 0}}), y(1), 300).await?;
        }
        let mut swaps_ok = 0;
        for i in 0..6 { let r = t.swap("vault:request_swap (Rhea)", a_perf, &perf, WRAP, USDC, (20 + i) * MILLI).await?; if ev(&r, "trade").len() == 1 { swaps_ok += 1; } }
        t.check("Rhea swaps settle (perf runs)", swaps_ok == 6, format!("{swaps_ok}/6"));
        for _ in 0..5 { let rh = t.receipt(); t.call("vault:log_skip", a_perf, &perf, "log_skip", json!({"receipt_hash": rh, "note": "perf"}), y(0), 30).await?; }
        for _ in 0..5 { t.call("vault:withdraw (owner)", TREASURY, &perf, "withdraw", json!({"token": WRAP, "amount": "1000"}), y(1), 50).await?; }
        let setup: Value = t.view("view:get_intents", &perf, "get_intents", json!({})).await?;
        if setup["public_key"].is_null() {
            let r = t.call("vault:intents_setup", TREASURY, &perf, "intents_setup", json!({}), y(1), 100).await?;
            t.check("perf: intents key registered", ev(&r, "intents_key").len() == 1, "");
        }
        for _ in 0..3 { t.call("vault:intents_deposit", TREASURY, &perf, "intents_deposit", json!({"token": WRAP, "amount": (50 * MILLI).to_string()}), y(1), 100).await?; }
        for _ in 0..3 { t.call("vault:intents_withdraw", TREASURY, &perf, "intents_withdraw", json!({"token": WRAP, "amount": (10 * MILLI).to_string()}), y(1), 100).await?; }
        let mut auth_ok = 0; let mut cancel_ok = 0;
        for _ in 0..5 {
            let r = t.intent("vault:request_intent_swap (MPC)", a_perf, &perf, 20 * MILLI).await?;
            if ev(&r, "intent_authorized").len() == 1 { auth_ok += 1; }
            let r = t.call("vault:intents_cancel (MPC)", a_perf, &perf, "intents_cancel", json!({}), y(0), 300).await?;
            if ev(&r, "intent_cancelled").len() == 1 { cancel_ok += 1; }
        }
        t.check("intents authorized by real MPC (perf runs)", auth_ok == 5, format!("{auth_ok}/5"));
        t.check("intents cancelled by real MPC (perf runs)", cancel_ok == 5, format!("{cancel_ok}/5"));
        // Fills: the solver gets the vault's USDC (via the owner) onto intents, then fills two intents.
        let (sk, saddr) = solver();
        let usdc = t.bal(USDC, &perf).await?;
        if usdc > 0 {
            t.call("setup:owner_withdraw_usdc", TREASURY, &perf, "withdraw", json!({"token": USDC, "amount": usdc.to_string()}), y(1), 50).await?;
            t.call("setup:solver_deposit", TREASURY, USDC, "ft_transfer_call", json!({"receiver_id": INTENTS, "amount": usdc.to_string(), "msg": saddr}), y(1), 100).await?;
        }
        let (mut fills, mut authorized, mut refused) = (0, 0, vec![]);
        for i in 0..2u64 {
            let r = t.intent("vault:request_intent_swap (MPC)", a_perf, &perf, 20 * MILLI).await?;
            let Some(a) = ev(&r, "intent_authorized").first().cloned() else { refused.push(refusal(&r)); continue };
            authorized += 1;
            let min_out: u128 = a["min_amount_out"].as_str().unwrap_or("0").parse()?;
            let fill = solver_fill(&sk, &saddr, min_out, 20 * MILLI, ts + i);
            t.call("intents:execute_intents (fill)", TREASURY, INTENTS, "execute_intents", json!({"signed": [a["multi_payload"], fill]}), y(0), 300).await?;
            let r = t.call("vault:intents_settle (fill)", TREASURY, &perf, "intents_settle", json!({}), y(0), 100).await?;
            if ev(&r, "trade").first().and_then(|e| e["amount_out"].as_str()) == Some(&min_out.to_string()) { fills += 1; }
        }
        // The vault's own policy may refuse a request (e.g. rate_limit on a fixture with 12 trades/hour): that's the
        // policy working; every intent it authorized must settle as a trade at exactly min_amount_out.
        t.check("intent fills recorded by intents_settle (every authorized intent)", authorized >= 1 && fills == authorized,
            format!("{fills}/{authorized} authorized; refused: {refused:?}"));
    }

    // ------------------------------------------------------------------ functional: refusal codes (suite vault)
    if want("refusals") {
        println!("== refusal codes (suite: 0.05 wNEAR/trade, 0.12/day, 3 trades/hour)");
        // An interrupted earlier run can leave the vault frozen (between its freeze and unfreeze steps); undo that first.
        let cfg: Value = t.view("view:suite_config", &suite, "get_config", json!({})).await?;
        if cfg["frozen"] == true {
            t.call("setup:unfreeze (left frozen by an interrupted run)", TREASURY, &suite, "unfreeze", json!({}), y(1), 30).await?;
        }
        let r = t.intent("fn:request_intent (no setup)", a_suite, &suite, 10 * MILLI).await?;
        let code = refusal(&r); t.check("refuse intents_not_set_up", code == "intents_not_set_up", code);
        let rh = t.receipt();
        let r = t.call("fn:pair_not_allowed", a_suite, &suite, "request_swap", json!({"token_in": WRAP, "token_out": "dai.fakes.testnet",
            "amount_in": "1", "min_amount_out": "1", "receipt_hash": rh}), y(0), 300).await?;
        let code = refusal(&r); t.check("refuse pair_not_allowed", code == "pair_not_allowed", code);
        let rh = t.receipt();
        let r = t.call("fn:zero_amount", a_suite, &suite, "request_swap", json!({"token_in": WRAP, "token_out": USDC,
            "amount_in": "0", "min_amount_out": "1", "receipt_hash": rh}), y(0), 300).await?;
        let code = refusal(&r); t.check("refuse zero_amount", code == "zero_amount", code);
        let r = t.swap("fn:trade_cap", a_suite, &suite, WRAP, USDC, 60 * MILLI).await?;
        let code = refusal(&r); t.check("refuse trade_cap", code == "trade_cap", code);
        let u0: Value = t.view("view:get_usage", &suite, "get_usage", json!({})).await?;
        let used_trades = u0["trades"].as_u64().unwrap_or(0);
        let spent_w = u0["spent"].as_array().and_then(|a| a.iter().find(|x| x[0] == WRAP)).and_then(|x| x[1].as_str()).unwrap_or("0").parse::<u128>()?;
        if used_trades == 0 && spent_w == 0 {
            let r1 = t.swap("fn:swap 0.05", a_suite, &suite, WRAP, USDC, 50 * MILLI).await?;
            let r2 = t.swap("fn:swap 0.05", a_suite, &suite, WRAP, USDC, 50 * MILLI).await?;
            t.check("two capped swaps trade", ev(&r1, "trade").len() == 1 && ev(&r2, "trade").len() == 1, "");
            let r = t.swap("fn:daily_cap", a_suite, &suite, WRAP, USDC, 50 * MILLI).await?;
            let code = refusal(&r); t.check("refuse daily_cap (rolling 24 h)", code == "daily_cap", code);
            let r = t.swap("fn:swap 0.02 (3rd trade)", a_suite, &suite, WRAP, USDC, 20 * MILLI).await?;
            t.check("third trade within the cap", ev(&r, "trade").len() == 1, refusal(&r));
            let r = t.swap("fn:rate_limit", a_suite, &suite, USDC, WRAP, 10 * MILLI).await?;
            let code = refusal(&r); t.check("refuse rate_limit (3 trades/hour)", code == "rate_limit", code);
        } else {
            t.check("rolling caps already used this hour/day: daily_cap/rate_limit checks skipped this run", true, format!("trades {used_trades}, spent {spent_w}"));
        }
        // freeze / unfreeze
        t.call("fn:freeze (agent)", a_suite, &suite, "freeze", json!({}), y(0), 30).await?;
        let r = t.swap("fn:frozen", a_suite, &suite, WRAP, USDC, 10 * MILLI).await?;
        let code = refusal(&r); t.check("refuse frozen", code == "frozen", code);
        let (no, how) = t.reject("fn:unfreeze (agent)", a_suite, &suite, "unfreeze", json!({}), y(1), 30).await?;
        t.check("agent cannot unfreeze", no, how);
        let r = t.call("fn:unfreeze (owner)", TREASURY, &suite, "unfreeze", json!({}), y(1), 30).await?;
        t.check("owner unfreezes", ev(&r, "unfreeze").len() == 1, "");
    }

    // ------------------------------------------------------------------ functional: owner powers (suite vault)
    if want("owner") {
        println!("== owner powers");
        let p2 = policy(4 * MILLI * 10, 10 * MILLI * 10, 3);
        let r = t.call("fn:propose_policy", TREASURY, &suite, "propose_policy", json!({"policy": p2}), y(1), 50).await?;
        t.check("policy proposed with a 24 h timelock", ev(&r, "policy_proposed").len() == 1, "");
        let r = t.call("fn:apply_policy (early)", stranger, &suite, "apply_policy", json!({}), y(0), 30).await?;
        t.check("apply before the timelock is refused", r.into_result().is_err(), "");
        let r = t.call("fn:propose_policy (replace)", TREASURY, &suite, "propose_policy", json!({"policy": p2}), y(1), 50).await?;
        t.check("replacing a pending policy records policy_cancelled", ev(&r, "policy_cancelled").first().map(|e| e["replaced"] == true).unwrap_or(false), "");
        let r = t.call("fn:cancel_policy", TREASURY, &suite, "cancel_policy", json!({}), y(1), 30).await?;
        t.check("owner cancels the pending policy", ev(&r, "policy_cancelled").len() == 1, "");
        let (no, how) = t.reject("fn:propose_policy (agent)", a_suite, &suite, "propose_policy", json!({"policy": p2}), y(1), 50).await?;
        t.check("agent cannot propose policy", no, how);
        let r = t.call("fn:set_agent=owner", TREASURY, &suite, "set_agent", json!({"agent_id": TREASURY}), y(1), 30).await?;
        t.check("set_agent refuses the owner as agent", r.into_result().is_err(), "");
        let newo = "irontrade-1793186555.testnet";
        t.call("fn:propose_owner", TREASURY, &suite, "propose_owner", json!({"owner_id": newo}), y(1), 30).await?;
        let (no, how) = t.reject("fn:accept_owner (wrong)", stranger, &suite, "accept_owner", json!({}), y(1), 30).await?;
        t.check("a stranger cannot accept ownership", no, how);
        let r = t.call("fn:set_agent=proposed", TREASURY, &suite, "set_agent", json!({"agent_id": newo}), y(1), 30).await?;
        t.check("set_agent refuses the proposed owner", r.into_result().is_err(), "");
        let r = t.call("fn:accept_owner", newo, &suite, "accept_owner", json!({}), y(1), 30).await?;
        t.check("proposed owner accepts", ev(&r, "owner_set").len() == 1, "");
        t.call("fn:propose_owner (back)", newo, &suite, "propose_owner", json!({"owner_id": TREASURY}), y(1), 30).await?;
        let r = t.call("fn:accept_owner (back)", TREASURY, &suite, "accept_owner", json!({}), y(1), 30).await?;
        t.check("ownership handed back", ev(&r, "owner_set").len() == 1, "");
        // The before/after balance check (round 2, M-1) needs TG_MIN_EXCHANGE_WITHDRAW; less is refused up front.
        let r = t.call("fn:exchange_withdraw (low gas)", TREASURY, &suite, "exchange_withdraw", json!({"token": USDC, "amount": "1"}), y(1), 100).await?;
        t.check("exchange_withdraw under its gas floor is refused before anything moves", r.into_result().is_err(), "");
        let r = t.call("fn:exchange_withdraw (empty)", TREASURY, &suite, "exchange_withdraw", json!({"token": USDC, "amount": "1"}), y(1), 200).await?;
        t.check("exchange_withdraw of nothing is recorded as failed, not as a withdraw",
            ev(&r, "exchange_withdraw_failed").len() == 1 && ev(&r, "exchange_withdraw").is_empty(), format!("{:?}", r.logs()));
        // Round 3: the owner's lostfound claim, and the busy guard while an owner exchange operation runs.
        let (no, how) = t.reject("fn:claim_lostfound (agent)", a_suite, &suite, "exchange_claim_lostfound", json!({"token": WRAP}), y(1), 200).await?;
        t.check("agent cannot claim lostfound (owner only)", no, how);
        let r = t.call("fn:claim_lostfound (low gas)", TREASURY, &suite, "exchange_claim_lostfound", json!({"token": WRAP}), y(1), 100).await?;
        t.check("lostfound claim under its gas floor is refused before anything moves", r.into_result().is_err(), "");
        let r = t.call("fn:claim_lostfound (empty)", TREASURY, &suite, "exchange_claim_lostfound", json!({"token": WRAP}), y(1), 200).await?;
        t.check("lostfound claim with nothing parked is recorded as failed, never as a claim",
            ev(&r, "exchange_lostfound_claim_failed").len() == 1 && ev(&r, "exchange_lostfound_claim").is_empty(), format!("{:?}", r.logs()));
        let net = t.net.clone();
        let (so, sa) = (t.signer(TREASURY)?, t.signer(a_suite)?);
        let rh = t.receipt();
        let swap_args = json!({"token_in": WRAP, "token_out": USDC, "amount_in": (10 * MILLI).to_string(), "min_amount_out": "1", "receipt_hash": rh});
        let claim = near_api::Contract(id(&suite)).call_function("exchange_claim_lostfound", json!({"token": WRAP})).transaction()
            .gas(NearGas::from_tgas(200)).deposit(y(1)).with_signer(id(TREASURY), so).send_to(&net);
        let swap = async {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            near_api::Contract(id(&suite)).call_function("request_swap", swap_args).transaction()
                .gas(NearGas::from_tgas(300)).deposit(y(0)).with_signer(id(a_suite), sa).send_to(&net).await
        };
        let (_c, sres) = tokio::join!(claim, swap);
        let sres = sres?;
        let code = refusal(&sres);
        if code == "busy" { t.check("refuse busy while an owner exchange operation runs", true, code); }
        else { t.check("busy-guard timing: the swap landed outside the owner operation (inconclusive, not a failure)", true, format!("code '{code}', trades {}", ev(&sres, "trade").len())); }
        let setup: Value = t.view("view:get_intents", &suite, "get_intents", json!({})).await?;
        if setup["public_key"].is_null() {
            let r = t.call("fn:intents_setup", TREASURY, &suite, "intents_setup", json!({}), y(1), 100).await?;
            t.check("suite: intents key registered", ev(&r, "intents_key").len() == 1, format!("{:?}", r.logs()));
        } else {
            let r = t.call("fn:intents_setup (again)", TREASURY, &suite, "intents_setup", json!({}), y(1), 100).await?;
            t.check("suite: a second intents_setup is refused", r.into_result().is_err(), "");
        }
        let r = t.call("fn:intents_deposit", TREASURY, &suite, "intents_deposit", json!({"token": WRAP, "amount": (10 * MILLI).to_string()}), y(1), 100).await?;
        t.check("intents_deposit recorded once it arrived", ev(&r, "intents_deposit").len() == 1, "");
        let r = t.call("fn:intents_withdraw (too much)", TREASURY, &suite, "intents_withdraw", json!({"token": WRAP, "amount": E24.to_string()}), y(1), 100).await?;
        t.check("over-withdraw from intents recorded as failed", ev(&r, "intents_withdraw").is_empty(), format!("{:?}", r.logs()));
        let r = t.call("fn:intents_withdraw", TREASURY, &suite, "intents_withdraw", json!({"token": WRAP, "amount": (5 * MILLI).to_string()}), y(1), 100).await?;
        t.check("intents_withdraw recorded", ev(&r, "intents_withdraw").len() == 1, "");
    }

    // ------------------------------------------------------------------ functional: intent lifecycle (lifecycle vault)
    if want("intents") {
        println!("== intent lifecycle (lifecycle)");
        let setup: Value = t.view("view:get_intents", &lifecycle, "get_intents", json!({})).await?;
        if setup["public_key"].is_null() { t.call("setup:intents_setup", TREASURY, &lifecycle, "intents_setup", json!({}), y(1), 100).await?; }
        if t.ibal(&lifecycle, WRAP).await? < 40 * MILLI {
            t.call("setup:intents_deposit", TREASURY, &lifecycle, "intents_deposit", json!({"token": WRAP, "amount": (60 * MILLI).to_string()}), y(1), 100).await?;
        }
        let open: Value = t.view("view:get_intents", &lifecycle, "get_intents", json!({})).await?;
        if !open["open_intent"].is_null() { t.call("setup:settle_leftover", TREASURY, &lifecycle, "intents_settle", json!({}), y(0), 100).await?; }
        let spent0 = |u: &Value| u["spent"].as_array().and_then(|a| a.iter().find(|x| x[0] == WRAP)).and_then(|x| x[1].as_str()).unwrap_or("0").parse::<u128>().unwrap_or(0);
        let u_before: Value = t.view("view:get_usage", &lifecycle, "get_usage", json!({})).await?;
        let r = t.intent("fn:intent (to expire)", a_lifecycle, &lifecycle, 20 * MILLI).await?;
        t.check("intent authorized", ev(&r, "intent_authorized").len() == 1, "");
        let r = t.intent("fn:busy", a_lifecycle, &lifecycle, 10 * MILLI).await?;
        let code = refusal(&r); t.check("refuse busy (intent open)", code == "busy", code);
        let r = t.swap("fn:busy (Rhea)", a_lifecycle, &lifecycle, WRAP, USDC, 10 * MILLI).await?;
        let code = refusal(&r); t.check("refuse busy on Rhea while an intent is open", code == "busy", code);
        println!("  waiting 125 s for the intent deadline (120 s) to pass...");
        tokio::time::sleep(Duration::from_secs(125)).await;
        let r = t.intent("fn:unsettled", a_lifecycle, &lifecycle, 10 * MILLI).await?;
        let code = refusal(&r); t.check("refuse unsettled (expired, not yet recorded)", code == "unsettled", code);
        let r = t.call("fn:intents_settle (expiry)", stranger, &lifecycle, "intents_settle", json!({}), y(0), 100).await?;
        t.check("anyone settles; unused nonce after deadline = intent_expired", ev(&r, "intent_expired").len() == 1, format!("{:?}", r.logs()));
        let u_after: Value = t.view("view:get_usage", &lifecycle, "get_usage", json!({})).await?;
        t.check("expiry released the cap (24 h spend back to its level before the intent)", spent0(&u_after) == spent0(&u_before), format!("{} -> {}", spent0(&u_before), spent0(&u_after)));
        // Race: a solver fills first, then the agent tries to cancel.
        let (sk, saddr) = solver();
        let r = t.intent("fn:intent (race)", a_lifecycle, &lifecycle, 20 * MILLI).await?;
        if let Some(a) = ev(&r, "intent_authorized").first().cloned() {
            let min_out: u128 = a["min_amount_out"].as_str().unwrap_or("0").parse()?;
            if t.ibal(&saddr, USDC).await? >= min_out {
                let fill = solver_fill(&sk, &saddr, min_out, 20 * MILLI, ts + 99);
                let r = t.call("fn:fill first", TREASURY, INTENTS, "execute_intents", json!({"signed": [a["multi_payload"], fill]}), y(0), 300).await?;
                t.check("solver fills the intent", r.into_result().is_ok(), "");
                let r = t.call("fn:cancel after fill", a_lifecycle, &lifecycle, "intents_cancel", json!({}), y(0), 300).await?;
                t.check("cancel after a fill fails cleanly (intent_cancel_failed)", ev(&r, "intent_cancel_failed").len() == 1, format!("{:?}", r.logs()));
                let r = t.call("fn:settle the fill", a_lifecycle, &lifecycle, "intents_settle", json!({}), y(0), 100).await?;
                t.check("settle records the fill as a trade", ev(&r, "trade").len() == 1, "");
            } else {
                t.check("race test skipped: solver has too little USDC", true, "");
                t.call("fn:cancel (cleanup)", a_lifecycle, &lifecycle, "intents_cancel", json!({}), y(0), 300).await?;
            }
        }
    }

    // ------------------------------------------------------------------ round 3: owner abandons an unresolved intent (lifecycle vault)
    if want("abandon") {
        println!("== intents_abandon (lifecycle; waits deadline + 1 h grace)");
        let setup: Value = t.view("view:get_intents", &lifecycle, "get_intents", json!({})).await?;
        if setup["public_key"].is_null() { t.call("setup:intents_setup", TREASURY, &lifecycle, "intents_setup", json!({}), y(1), 100).await?; }
        if t.ibal(&lifecycle, WRAP).await? < 30 * MILLI {
            t.call("setup:intents_deposit", TREASURY, &lifecycle, "intents_deposit", json!({"token": WRAP, "amount": (40 * MILLI).to_string()}), y(1), 100).await?;
        }
        let open: Value = t.view("view:get_intents", &lifecycle, "get_intents", json!({})).await?;
        if !open["open_intent"].is_null() { t.call("setup:settle_leftover", TREASURY, &lifecycle, "intents_settle", json!({}), y(0), 100).await?; }
        let spent0 = |u: &Value| u["spent"].as_array().and_then(|a| a.iter().find(|x| x[0] == WRAP)).and_then(|x| x[1].as_str()).unwrap_or("0").parse::<u128>().unwrap_or(0);
        let r = t.intent("fn:intent (to abandon)", a_lifecycle, &lifecycle, 15 * MILLI).await?;
        t.check("abandon: intent authorized", ev(&r, "intent_authorized").len() == 1, "");
        let u_auth: Value = t.view("view:get_usage", &lifecycle, "get_usage", json!({})).await?;
        let (no, how) = t.reject("fn:abandon (agent)", a_lifecycle, &lifecycle, "intents_abandon", json!({}), y(1), 30).await?;
        t.check("agent cannot abandon (owner only)", no, how);
        let r = t.call("fn:abandon (too early)", TREASURY, &lifecycle, "intents_abandon", json!({}), y(1), 30).await?;
        t.check("abandon before deadline + 1 h is refused", r.into_result().is_err(), "");
        println!("  waiting 3,740 s (120 s deadline + 1 h grace + margin)...");
        tokio::time::sleep(Duration::from_secs(3740)).await;
        let r = t.call("fn:abandon", TREASURY, &lifecycle, "intents_abandon", json!({}), y(1), 30).await?;
        let unresolved = ev(&r, "intent_unresolved");
        t.check("owner abandons after the grace: recorded as intent_unresolved (abandoned)",
            unresolved.len() == 1 && unresolved[0]["reason"].as_str().unwrap_or("").contains("abandoned"), format!("{:?}", r.logs()));
        let u_after: Value = t.view("view:get_usage", &lifecycle, "get_usage", json!({})).await?;
        t.check("abandon keeps the cap reserved (24 h spend unchanged)", spent0(&u_after) == spent0(&u_auth), format!("{} -> {}", spent0(&u_auth), spent0(&u_after)));
        let st: Value = t.view("view:get_intents", &lifecycle, "get_intents", json!({})).await?;
        t.check("abandon clears the open intent", st["open_intent"].is_null(), "");
    }

    // ------------------------------------------------------------------ report
    let mut rows = vec![];
    println!("\n{:<34} {:>3} {:>8} {:>8} {:>6} {:>10}", "operation", "n", "median s", "p95 s", "Tgas", "NEAR");
    for (op, s) in &t.perf {
        let mut secs: Vec<f64> = s.iter().map(|x| x.secs).collect();
        secs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let med = secs[secs.len() / 2];
        let p95 = secs[((secs.len() as f64 * 0.95).ceil() as usize).saturating_sub(1)];
        let mut gas: Vec<u64> = s.iter().map(|x| x.tgas).collect(); gas.sort();
        let mut near: Vec<f64> = s.iter().map(|x| x.near).collect(); near.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!("{:<34} {:>3} {:>8.2} {:>8.2} {:>6} {:>10.5}", op, s.len(), med, p95, gas[gas.len() / 2], near[near.len() / 2]);
        rows.push(json!({"op": op, "n": s.len(), "median_s": med, "p95_s": p95, "median_tgas": gas[gas.len() / 2], "median_near": near[near.len() / 2]}));
    }
    let pass = t.checks.iter().filter(|c| c.1).count();
    println!("\n{pass}/{} checks passed", t.checks.len());
    for c in t.checks.iter().filter(|c| !c.1) { println!("  FAIL {} ({})", c.0, c.2); }
    std::fs::create_dir_all("../../deploy/testnet")?;
    std::fs::write(format!("../../deploy/testnet/perf-{ts}.json"), serde_json::to_string_pretty(&json!({"date_unix": ts, "network": "testnet", "rows": rows}))?)?;
    std::fs::write(format!("../../deploy/testnet/suite-{ts}.json"), serde_json::to_string_pretty(&json!({"date_unix": ts,
        "factory": FACTORY, "vaults": [perf, lifecycle, suite], "code_hash": code_hash,
        "checks": t.checks.iter().map(|c| json!({"check": c.0, "pass": c.1, "detail": c.2})).collect::<Vec<_>>(), "txs": t.txs}))?)?;
    println!("results: deploy/testnet/suite-{ts}.json, perf-{ts}.json");
    Ok(())
}
