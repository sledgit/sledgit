//! Create arena vaults from a factory, each with its own agent account that holds only a function-call key scoped to
//! that vault (testnet only). The owner is the treasury.
//!
//!   IT_FACTORY=arena.irontrade.testnet cargo run --example arena_setup -- <name> [<name>...]
//!
//! Agent account `agent-<name>.<treasury>`: created with a temporary full-access key, which adds the scoped key
//! (receiver = the vault, the agent methods only) and then deletes itself. The key has no allowance cap: near-api-js
//! checks an allowance against a worst-case gas price (~0.3 NEAR per 300 Tgas call), so a small cap blocks the agent
//! after one call and can never be raised. The bound is the agent account's own balance (1 NEAR), which the key can
//! only spend on gas for vault calls. IT_REKEY=1: give an existing vault a new agent account (`agent2-<name>`) via the
//! owner's set_agent (e.g. to give a test fixture its own scoped agent); IT_AGENT_PREFIX names the agent account in both modes
//! (default `agent2`). The scoped key goes to ~/.config/sledgit/testnet-<agent account>.json, created 0600 and never
//! overwritten. The vault gets 1 NEAR, token and exchange registrations and
//! 0.5 wNEAR. Every step is checked; results (no secrets): deploy/testnet/arena-<ts>.json.
use near_api::types::transaction::actions::FunctionCallPermission;
use near_api::types::transaction::result::TransactionResult;
use near_api::types::AccessKeyPermission;
use near_api::{AccountId, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::serde_json::{self, json, Value};
use std::sync::Arc;
#[path = "shared/local.rs"] mod local;

type R<T = ()> = Result<T, Box<dyn std::error::Error>>;
const RPC: &str = "https://rpc.testnet.fastnear.com";
const TREASURY: &str = "it1793205219-owner.testnet";
const WRAP: &str = "wrap.testnet";
const USDC: &str = "usdc.itachicara.testnet";
const POOL: u64 = 1103;
const E24: u128 = 1_000_000_000_000_000_000_000_000;
const AGENT_METHODS: [&str; 6] = ["request_swap", "request_intent_swap", "log_skip", "intents_cancel", "intents_settle", "freeze"];

fn id(s: &str) -> AccountId { s.parse().unwrap() }
fn txh(r: &TransactionResult) -> String {
    r.clone().into_full().and_then(|f| f.outcomes().first().map(|o| o.transaction_hash.to_string())).unwrap_or_default()
}
fn done(r: TransactionResult, what: &str) -> R<String> {
    let h = txh(&r);
    r.into_result().map_err(|e| format!("{what} failed ({h}): {e:?}"))?;
    Ok(h)
}

/// Creates the key file 0600 from the first byte; an existing file is never replaced.
fn write_secret(path: &std::path::Path, v: &Value) -> R {
    use std::io::Write;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; o.mode(0o600); }
    let mut f = o.open(path).map_err(|e| format!("{} not written ({e}); an existing key file is never replaced", path.display()))?;
    f.write_all(v.to_string().as_bytes())?;
    Ok(())
}

/// The key's methods are exactly the agent methods (order ignored).
fn same_methods(got: &[String]) -> bool {
    let mut a: Vec<&str> = got.iter().map(|m| m.as_str()).collect();
    let mut b = AGENT_METHODS.to_vec();
    a.sort(); b.sort();
    a == b
}

fn treasury_signer() -> R<Arc<Signer>> {
    let dir = local::key_dir()?;
    for e in std::fs::read_dir(dir)? {
        let p = e?.path();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        if !name.starts_with("testnet-") || !name.ends_with(".json") { continue; }
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&p)?.permissions().mode();
            if mode & 0o077 != 0 { return Err(format!("{} is readable by other users (mode {:o}): chmod 600 it", p.display(), mode & 0o777).into()); }
        }
        let d: Value = serde_json::from_str(&std::fs::read_to_string(&p)?)?;
        let listed = d["accounts"].as_array().map(|a| a.iter().any(|x| x == TREASURY)).unwrap_or(false);
        if let (true, Some(sk)) = (listed, d["secret_key"].as_str()) { return Ok(Signer::from_secret_key(sk.parse()?)?); }
    }
    Err("no treasury key".into())
}

/// 0.5 wNEAR per trade, 3 per rolling 24 h, 12 trades an hour; pool 1103 with the suite's price bands.
/// IT_POLICY=<per-trade milli-wNEAR>,<per-day milli-wNEAR>,<trades/hour> overrides the wNEAR caps and the rate (test fixtures).
fn policy() -> Value {
    let (mut per_trade, mut per_day, mut rate) = (E24 / 2, 3 * E24, 12u64);
    if let Ok(p) = std::env::var("IT_POLICY") {
        let v: Vec<u128> = p.split(',').map(|x| x.trim().parse().expect("IT_POLICY: three integers")).collect();
        assert!(v.len() == 3, "IT_POLICY needs three values");
        (per_trade, per_day, rate) = (v[0] * (E24 / 1000), v[1] * (E24 / 1000), v[2] as u64);
    }
    json!({"tokens": [
            {"token": WRAP, "max_per_trade": per_trade.to_string(), "max_per_day": per_day.to_string()},
            {"token": USDC, "max_per_trade": E24.to_string(), "max_per_day": (5 * E24).to_string()}],
        "pairs": [{"token_in": WRAP, "token_out": USDC, "pool_id": POOL, "min_price_num": "14", "min_price_den": "10"},
                  {"token_in": USDC, "token_out": WRAP, "pool_id": POOL, "min_price_num": "33", "min_price_den": "100"}],
        "max_trades_per_hour": rate, "max_slippage_bps": 100})
}

async fn call(net: &NetworkConfig, s: &Arc<Signer>, contract: &str, method: &str, args: Value, dep: NearToken, tgas: u64) -> R<String> {
    let r = near_api::Contract(id(contract)).call_function(method, args).transaction().gas(NearGas::from_tgas(tgas)).deposit(dep)
        .with_signer(id(TREASURY), s.clone()).send_to(net).await?;
    done(r, &format!("{contract}.{method}"))
}

#[tokio::main]
async fn main() -> R {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs();
    let net = NetworkConfig::from_rpc_url("testnet", RPC.parse()?);
    let factory = std::env::var("IT_FACTORY").unwrap_or_else(|_| "arena.irontrade.testnet".into());
    if !factory.ends_with(".testnet") { return Err("testnet only".into()); }
    let names: Vec<String> = std::env::args().skip(1).collect();
    if names.is_empty() { return Err("usage: arena_setup <name>...".into()); }
    let treasury = treasury_signer()?;
    let mut out = vec![];
    call(&net, &treasury, WRAP, "storage_deposit", json!({"account_id": TREASURY}), NearToken::from_millinear(10), 30).await?;

    for name in &names {
        let vault = format!("{name}.{factory}");
        let rekey = std::env::var("IT_REKEY").map(|v| v == "1").unwrap_or(false);
        let prefix = std::env::var("IT_AGENT_PREFIX").unwrap_or_else(|_| if rekey { "agent2".into() } else { "agent".into() });
        let agent = format!("{prefix}-{name}.{TREASURY}");
        let mut txs = vec![];
        println!("== {vault} (agent {agent})");

        // 1. Agent account with a temporary full-access key.
        let tmp = Signer::from_secret_key(near_api::signer::generate_secret_key()?)?;
        let tmp_pk = tmp.get_public_key().await?;
        let r = near_api::Account::create_account(id(&agent)).fund_myself(id(TREASURY), NearToken::from_millinear(1_000))
            .with_public_key(tmp_pk).with_signer(treasury.clone()).send_to(&net).await?;
        txs.push(json!({"step": "create_agent", "tx": done(r, "create agent")?}));

        // 2. The scoped key, saved before it is added; then the temporary key deletes itself.
        let sk = near_api::signer::generate_secret_key()?;
        let pk = Signer::from_secret_key(sk.clone())?.get_public_key().await?;
        let kpath = local::key_dir()?.join(format!("testnet-{agent}.json"));
        write_secret(&kpath, &json!({"network": "testnet", "secret_key": sk.to_string(), "account_id": agent,
            "accounts": [agent], "vault": vault, "permission": "function-call"}))?;
        let perm = AccessKeyPermission::FunctionCall(FunctionCallPermission {
            allowance: None, receiver_id: vault.clone(),
            method_names: AGENT_METHODS.iter().map(|m| m.to_string()).collect() });
        let r = near_api::Account(id(&agent)).add_key(perm, pk).with_signer(tmp.clone()).send_to(&net).await?;
        txs.push(json!({"step": "add_scoped_key", "tx": done(r, "add scoped key")?}));
        let r = near_api::Account(id(&agent)).delete_key(tmp_pk).with_signer(tmp).send_to(&net).await?;
        txs.push(json!({"step": "delete_temp_key", "tx": done(r, "delete temporary key")?}));
        let keys = near_api::Account(id(&agent)).list_keys().fetch_from(&net).await?.data;
        let scoped = keys.len() == 1 && matches!(&keys[0].1.permission, AccessKeyPermission::FunctionCall(p)
            if p.receiver_id == vault && p.allowance.is_none() && same_methods(&p.method_names));
        if !scoped { return Err(format!("{agent} keys are not exactly one function-call key for {vault}: {keys:?}").into()); }
        println!("  agent holds exactly one function-call key for the vault");

        if rekey {
            txs.push(json!({"step": "set_agent", "tx": call(&net, &treasury, &vault, "set_agent", json!({"agent_id": agent}),
                NearToken::from_yoctonear(1), 30).await?}));
            let cfg: Value = near_api::Contract(id(&vault)).call_function("get_config", json!({})).read_only().fetch_from(&net).await?.data;
            if cfg["agent_id"] != agent { return Err(format!("{vault} agent is {} after set_agent", cfg["agent_id"]).into()); }
            println!("  vault agent switched to {agent}");
            out.push(json!({"name": name, "vault": vault, "agent": agent, "agent_key": "function-call (vault, agent methods)", "rekey": true, "txs": txs}));
            continue;
        }

        // 3. The vault, from the factory.
        let h = call(&net, &treasury, &factory, "create_vault", json!({"name": name, "owner_id": TREASURY, "agent_id": agent,
            "policy": policy()}), NearToken::from_near(1), 150).await?;
        txs.push(json!({"step": "create_vault", "tx": h}));
        let vkeys = near_api::Account(id(&vault)).list_keys().fetch_from(&net).await?.data;
        if !vkeys.is_empty() { return Err(format!("{vault} has {} access keys", vkeys.len()).into()); }
        let cfg: Value = near_api::Contract(id(&vault)).call_function("get_config", json!({})).read_only().fetch_from(&net).await?.data;
        if cfg["agent_id"] != agent || cfg["owner_id"] != TREASURY { return Err(format!("{vault} config mismatch: {cfg}").into()); }
        println!("  vault created, 0 keys, owner/agent as expected");

        // 4. Registrations and 0.5 wNEAR.
        for tok in [WRAP, USDC] {
            txs.push(json!({"step": format!("storage_deposit {tok}"), "tx": call(&net, &treasury, tok, "storage_deposit",
                json!({"account_id": vault}), NearToken::from_millinear(10), 30).await?}));
        }
        txs.push(json!({"step": "exchange_storage_deposit", "tx": call(&net, &treasury, &vault, "exchange_storage_deposit", json!({}),
            NearToken::from_millinear(100), 50).await?}));
        txs.push(json!({"step": "exchange_register_tokens", "tx": call(&net, &treasury, &vault, "exchange_register_tokens", json!({}),
            NearToken::from_yoctonear(1), 50).await?}));
        txs.push(json!({"step": "wrap", "tx": call(&net, &treasury, WRAP, "near_deposit", json!({}), NearToken::from_millinear(500), 30).await?}));
        txs.push(json!({"step": "fund_vault", "tx": call(&net, &treasury, WRAP, "ft_transfer_call", json!({"receiver_id": vault,
            "amount": (E24 / 2).to_string(), "msg": ""}), NearToken::from_yoctonear(1), 100).await?}));
        let bal: String = near_api::Contract(id(WRAP)).call_function("ft_balance_of", json!({"account_id": vault})).read_only().fetch_from(&net).await?.data;
        println!("  vault wNEAR balance {bal}");
        out.push(json!({"name": name, "vault": vault, "agent": agent, "agent_key": "function-call (vault, agent methods)",
            "wnear": bal, "txs": txs}));
    }
    // Anchored to the crate, not the working directory: a run from elsewhere once wrote this outside the repo.
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../deploy/testnet");
    std::fs::create_dir_all(dir)?;
    let path = format!("{dir}/arena-{ts}.json");
    std::fs::write(&path, serde_json::to_string_pretty(&json!({"date_unix": ts, "network": "testnet", "factory": factory,
        "owner": TREASURY, "policy": policy(), "vaults": out}))?)?;
    println!("result: deploy/testnet/arena-{ts}.json");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn method_list_must_match_exactly() {
        let all: Vec<String> = AGENT_METHODS.iter().rev().map(|m| m.to_string()).collect();
        assert!(same_methods(&all));
        assert!(!same_methods(&all[1..].to_vec()));
        let mut extra = all.clone(); extra.push("withdraw".into());
        assert!(!same_methods(&extra));
    }

    #[test]
    fn key_files_are_private_and_never_replaced() {
        let p = std::env::temp_dir().join(format!("it-arena-keytest-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&p);
        write_secret(&p, &json!({"secret_key": "x"})).unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(write_secret(&p, &json!({"secret_key": "y"})).is_err());
        std::fs::remove_file(&p).unwrap();
    }
}
