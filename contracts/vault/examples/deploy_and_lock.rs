//! Publish the vault code (global, by hash), deploy a factory pinned to it, check it, then delete the factory's only
//! key so nobody can change it. Testnet only; the mainnet run mirrors these steps and checks.
//!
//!   IT_FACTORY=arena.irontrade.testnet cargo run --example deploy_and_lock
//!
//! Env: IT_FACTORY (sub-account to create), IT_PARENT (its parent, default the factory's parent), IT_PARENT_KEY_OF
//! (whose key file signs for the parent, default the treasury), IT_PAYER (pays the global publish, default the
//! treasury), IT_MIN_SPARE (millinear the factory must hold free before the lock, default 500: the current factory
//! records a refund it can't cover, keeping its listing fee for the record's storage, and pays it via claim_refund,
//! so it needs no refund float; set 100000 for a factory built before that change), IT_FACTORY_FUND
//! (millinear, default IT_MIN_SPARE + 3000),
//! IT_RESUME=1 (finish a run that stopped after creating the factory, using its pending key file),
//! IT_CHECK_ONLY=1 (run every pre-lock check against an existing factory; sends nothing).
//! The global publish is skipped when the chain already has code under that hash (checked by fetching it).
//! Fails closed: any mismatch stops before the key is deleted. Vaults someone else creates before the lock are accepted
//! only if each is genuine (direct child, 0 keys, pinned code, the factory's ids). Results (no secrets): deploy/testnet/lock-<ts>.json,
//! progress: deploy/testnet/lock-progress-<factory>.json.
use near_api::types::transaction::result::TransactionResult;
use near_api::{AccountId, NearToken, NetworkConfig, Signer};
use near_sdk::serde_json::{self, json, Value};
use k256::sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
#[path = "shared/local.rs"] mod local;

type R<T = ()> = Result<T, Box<dyn std::error::Error>>;
const RPC: &str = "https://rpc.testnet.fastnear.com";
const REF: &str = "ref-finance-101.testnet";
const INTENTS: &str = "it1793205011-intents.testnet";
const MPC: &str = "v1.signer-prod.testnet";
const TREASURY: &str = "it1793205219-owner.testnet";
const MIN_DEPOSIT: u128 = 1_000_000_000_000_000_000_000_000;
/// Deposit bounds passed to the factory's `new`, in yoctoNEAR: IT_MIN_DEPOSIT_MILLI (default 1000) and
/// IT_MAX_DEPOSIT_MILLI (default the 100 NEAR ceiling).
fn deposit_bounds() -> (u128, u128) {
    let milli = |k: &str, d: u128| std::env::var(k).ok().and_then(|v| v.parse::<u128>().ok()).unwrap_or(d);
    (milli("IT_MIN_DEPOSIT_MILLI", MIN_DEPOSIT / 1_000_000_000_000_000_000_000) * 1_000_000_000_000_000_000_000,
     milli("IT_MAX_DEPOSIT_MILLI", 100_000) * 1_000_000_000_000_000_000_000)
}
/// The factory's MAX_DEPOSIT (contracts/factory/src/lib.rs), in millinear.
#[cfg(test)]
const MAX_DEPOSIT_MILLI: u128 = 100_000;
const MILLI: u128 = 1_000_000_000_000_000_000_000;

fn id(s: &str) -> AccountId { s.parse().unwrap() }
fn env_or(k: &str, d: &str) -> String { std::env::var(k).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| d.to_string()) }
fn flag(k: &str) -> bool { env_or(k, "") == "1" }
fn b58_sha256(b: &[u8]) -> String { bs58::encode(Sha256::digest(b)).into_string() }

fn key_dir() -> R<std::path::PathBuf> { Ok(local::key_dir()?) }

/// Account -> signer from ~/.config/sledgit/testnet-*.json (never printed).
fn load_keys() -> R<HashMap<String, Arc<Signer>>> {
    let mut keys = HashMap::new();
    for e in std::fs::read_dir(key_dir()?)? {
        let p = e?.path();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        if !name.starts_with("testnet-") || !name.ends_with(".json") { continue; }
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&p)?.permissions().mode();
            if mode & 0o077 != 0 { return Err(format!("{} is readable by other users (mode {:o}): chmod 600 it", p.display(), mode & 0o777).into()); }
        }
        let d: Value = serde_json::from_str(&std::fs::read_to_string(&p)?)?;
        if let (Some(sk), Some(accts)) = (d["secret_key"].as_str(), d["accounts"].as_array()) {
            for a in accts { if let Some(a) = a.as_str() { keys.insert(a.to_string(), Signer::from_secret_key(sk.parse()?)?); } }
        }
        if let Some(list) = d["keys"].as_array() {
            for k in list {
                if let (Some(a), Some(sk)) = (k["account_id"].as_str(), k["secret_key"].as_str()) {
                    keys.insert(a.to_string(), Signer::from_secret_key(sk.parse()?)?);
                }
            }
        }
    }
    Ok(keys)
}

/// Creates the file 0600 from the first byte and refuses to replace an existing one.
fn write_secret(path: &std::path::Path, v: &Value) -> R {
    use std::io::Write;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; o.mode(0o600); }
    let mut f = o.open(path).map_err(|e| fail(format!("{} not written ({e}); an existing key file is never replaced", path.display())))?;
    f.write_all(v.to_string().as_bytes())?;
    Ok(())
}

async fn free_yocto(net: &NetworkConfig, a: &str) -> u128 {
    near_api::Tokens::account(id(a)).near_balance().fetch_from(net).await
        .map(|b| b.total.as_yoctonear().saturating_sub(b.storage_locked.as_yoctonear())).unwrap_or(0)
}
fn near(y: u128) -> f64 { y as f64 / 1e24 }

/// Every vault the factory lists, page by page.
async fn listed_vaults(net: &NetworkConfig, factory: &str) -> R<Vec<String>> {
    let mut all = vec![];
    loop {
        let page: Vec<String> = near_api::Contract(id(factory)).call_function("get_vaults",
            json!({"from_index": all.len(), "limit": 100})).read_only().fetch_from(net).await?.data;
        let n = page.len();
        all.extend(page);
        if n < 100 { return Ok(all); }
    }
}

/// A direct child of the factory with 0 keys, running the pinned code, with the factory's ids.
async fn genuine(net: &NetworkConfig, factory: &str, code_hash: &str, v: &str) -> R<Result<(), String>> {
    if v.split_once('.').map(|x| x.1) != Some(factory) { return Ok(Err("not a direct child of the factory".into())); }
    let keys = near_api::Account(id(v)).list_keys().fetch_from(net).await?.data;
    if !keys.is_empty() { return Ok(Err(format!("{} access keys", keys.len()))); }
    let acct = near_api::Account(id(v)).view().fetch_from(net).await?.data;
    if !format!("{acct:?}").contains(code_hash) { return Ok(Err(format!("code {:?}", acct.contract_state))); }
    let c: Value = near_api::Contract(id(v)).call_function("get_config", json!({})).read_only().fetch_from(net).await?.data;
    if c["exchange_id"] != REF || c["intents_id"] != INTENTS || c["mpc_id"] != MPC { return Ok(Err(format!("config {c}"))); }
    Ok(Ok(()))
}

/// The factory must hold at least `min_spare` free before its key is deleted (a small storage margin; see IT_MIN_SPARE).
fn spare_ok(free: u128, min_spare: u128) -> bool { free >= min_spare }

/// What the run still has to do, from what the chain shows. Paid steps already done are never repeated.
#[derive(Debug, PartialEq)]
enum Plan { Fresh, Deploy, Check, Refuse(&'static str) }
fn plan(factory_exists: bool, code_deployed: bool, resume: bool, have_pending_key: bool, keys_on_factory: usize) -> Plan {
    if !factory_exists { return Plan::Fresh; }
    if !resume { return Plan::Refuse("factory already exists; set IT_RESUME=1 to finish an interrupted run, or pick a new IT_FACTORY"); }
    if !have_pending_key { return Plan::Refuse("IT_RESUME=1 but no pending key file for this factory"); }
    if keys_on_factory != 1 { return Plan::Refuse("factory doesn't have exactly one key (already locked, or not ours)"); }
    if code_deployed { Plan::Check } else { Plan::Deploy }
}

fn txh(r: &TransactionResult) -> String {
    r.clone().into_full().and_then(|f| f.outcomes().first().map(|o| o.transaction_hash.to_string())).unwrap_or_default()
}

fn fail(msg: impl Into<String>) -> Box<dyn std::error::Error> { msg.into().into() }

/// Progress file (no secrets): every finished step and its tx, so an interrupted run is visible and resumable.
fn record(progress: &std::path::Path, txs: &[Value]) -> R {
    std::fs::write(progress, serde_json::to_string_pretty(&json!({"steps": txs}))?)?;
    Ok(())
}

/// Is code with this hash already published as a global contract? Fetches it and re-hashes the bytes.
async fn global_published(net: &NetworkConfig, code_hash: &str) -> R<bool> {
    use near_sdk::base64::Engine;
    match near_api::Contract::global_wasm().by_hash(code_hash.parse()?).fetch_from(net).await {
        Ok(d) => {
            let bytes = near_sdk::base64::engine::general_purpose::STANDARD.decode(&d.data.code_base64)?;
            if b58_sha256(&bytes) != code_hash { return Err(fail("chain returned global code whose hash doesn't match")); }
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}

#[tokio::main]
async fn main() -> R {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs();
    let net = NetworkConfig::from_rpc_url("testnet", RPC.parse()?);
    // Network check: `.testnet` accounts exist only on testnet, so the real testnet signer must be visible.
    if near_api::Account(id(MPC)).view().fetch_from(&net).await.is_err() { return Err(fail("RPC is not testnet (v1.signer-prod.testnet not found)")); }

    let factory = env_or("IT_FACTORY", "arena.irontrade.testnet");
    let parent = env_or("IT_PARENT", factory.split_once('.').map(|x| x.1).ok_or_else(|| fail("IT_FACTORY has no parent"))?);
    let parent_key_of = env_or("IT_PARENT_KEY_OF", TREASURY);
    let payer = env_or("IT_PAYER", TREASURY);
    let min_spare_milli: u128 = env_or("IT_MIN_SPARE", "500").parse()?;
    let min_spare = min_spare_milli * MILLI;
    let fund = NearToken::from_millinear(env_or("IT_FACTORY_FUND", &(min_spare_milli + 3000).to_string()).parse()?);
    if !factory.ends_with(".testnet") || !factory.ends_with(&format!(".{parent}")) { return Err(fail("factory must be a testnet sub-account of IT_PARENT")); }

    let vault_code = std::fs::read("../target/near/sledgit_vault/sledgit_vault.wasm")?;
    let factory_code = std::fs::read("../target/near/sledgit_factory/sledgit_factory.wasm")?;
    let (code_hash, factory_hash) = (b58_sha256(&vault_code), b58_sha256(&factory_code));
    println!("vault code   {} bytes  {code_hash}", vault_code.len());
    println!("factory code {} bytes  {factory_hash}", factory_code.len());
    let kpath = key_dir()?.join(format!("testnet-lockpending-{factory}.json"));
    std::fs::create_dir_all("../../deploy/testnet")?;
    let progress = std::path::PathBuf::from(format!("../../deploy/testnet/lock-progress-{factory}.json"));
    let mut txs: Vec<Value> = vec![];

    let acct = near_api::Account(id(&factory)).view().fetch_from(&net).await.ok();
    let factory_keys = if acct.is_some() { near_api::Account(id(&factory)).list_keys().fetch_from(&net).await?.data } else { vec![] };
    let code_deployed = acct.as_ref().map(|a| !format!("{:?}", a.data.contract_state).contains("None")).unwrap_or(false);

    // Check-only: every pre-lock check on an existing factory; nothing is sent or deleted.
    if flag("IT_CHECK_ONLY") {
        if acct.is_none() { return Err(fail(format!("{factory} doesn't exist"))); }
        let free = free_yocto(&net, &factory).await;
        let (ok, _) = checks(&net, &factory, &code_hash, &factory_hash).await?;
        let spare = spare_ok(free, min_spare);
        println!("  {} spare: {:.3} NEAR free, needs {:.3}", if spare { "PASS" } else { "FAIL" }, near(free), near(min_spare));
        println!("  keys on factory: {}", factory_keys.len());
        println!("  global vault code {code_hash} on chain: {}", global_published(&net, &code_hash).await?);
        println!("CHECK-ONLY: {}", if ok && spare { "all pre-lock checks pass" } else { "a pre-lock check FAILS" });
        return if ok && spare { Ok(()) } else { Err(fail("check-only found a failing check")) };
    }

    let keys = load_keys()?;
    let pending = keys.get(&factory).cloned().filter(|_| kpath.exists());
    let p = plan(acct.is_some(), code_deployed, flag("IT_RESUME"), pending.is_some(), factory_keys.len());
    println!("plan: {p:?}");
    if let Plan::Refuse(why) = p { return Err(fail(format!("{factory}: {why}"))); }

    // 1. Global vault code, by hash; skipped when the chain already serves it.
    if global_published(&net, &code_hash).await? {
        println!("global vault code {code_hash} already published; not paying again");
        txs.push(json!({"step": "publish_global_code", "skipped": "already on chain (fetched and re-hashed)"}));
    } else {
        let need = vault_code.len() as f64 * 1e-4 + 0.5;
        let have = near(free_yocto(&net, &payer).await);
        if have < need { return Err(fail(format!("{payer} has {have:.2} NEAR free, the global publish needs ~{need:.2}"))); }
        let payer_signer = keys.get(&payer).cloned().ok_or_else(|| fail(format!("no key for payer {payer}")))?;
        let r = near_api::Contract::deploy_global_contract_code(vault_code.clone()).as_hash()
            .with_signer(id(&payer), payer_signer).send_to(&net).await?;
        let hash = txh(&r);
        r.into_result().map_err(|e| fail(format!("global publish failed: {e:?}")))?;
        txs.push(json!({"step": "publish_global_code", "tx": hash}));
        record(&progress, &txs)?;
        println!("published global vault code {code_hash}");
    }

    let fsigner = match (&p, pending) {
        (Plan::Fresh, _) => {
            // The parent funds the factory account; top it up from the payer if it can't.
            let parent_free = near(free_yocto(&net, &parent).await);
            let want = near(fund.as_yoctonear()) + 0.2;
            if parent_free < want {
                let payer_signer = keys.get(&payer).cloned().ok_or_else(|| fail(format!("no key for payer {payer}")))?;
                let top = NearToken::from_millinear(((want - parent_free) * 1000.0).ceil() as u128);
                let r = near_api::Tokens::account(id(&payer)).send_to(id(&parent)).near(top).with_signer(payer_signer).send_to(&net).await?;
                let hash = txh(&r);
                r.into_result().map_err(|e| fail(format!("top-up of {parent} failed: {e:?}")))?;
                txs.push(json!({"step": "top_up_parent", "tx": hash}));
            }
            // 2. Factory account with a fresh key, kept on disk (600) until it is deleted.
            let parent_signer = keys.get(&parent_key_of).cloned().ok_or_else(|| fail(format!("no key file for {parent_key_of}")))?;
            let sk = near_api::signer::generate_secret_key()?;
            let fsigner = Signer::from_secret_key(sk.clone())?;
            let fpk = fsigner.get_public_key().await?;
            write_secret(&kpath, &json!({"network": "testnet", "secret_key": sk.to_string(), "accounts": [factory]}))?;
            let r = near_api::Account::create_account(id(&factory)).fund_myself(id(&parent), fund).with_public_key(fpk)
                .with_signer(parent_signer).send_to(&net).await?;
            let hash = txh(&r);
            r.into_result().map_err(|e| fail(format!("create {factory} failed: {e:?}")))?;
            txs.push(json!({"step": "create_factory_account", "tx": hash}));
            record(&progress, &txs)?;
            fsigner
        }
        (_, Some(s)) => {
            // Resume: the factory's only key must be the pending one.
            let pk = s.get_public_key().await?;
            if factory_keys.len() != 1 || factory_keys[0].0 != pk { return Err(fail("the factory's key isn't the pending key on disk")); }
            txs.push(json!({"step": "resume", "from": format!("{p:?}")}));
            s
        }
        _ => return Err(fail("no signer for the factory")),
    };
    let fpk = fsigner.get_public_key().await?;

    // 3. Deploy and init (skipped when resuming a factory that already has its code).
    if p != Plan::Check {
        let r = near_api::Contract::deploy(id(&factory)).use_code(factory_code.clone())
            .with_init_call("new", json!({"code_hash": code_hash, "exchange_id": REF, "intents_id": INTENTS, "mpc_id": MPC,
                "min_deposit": deposit_bounds().0.to_string(), "max_deposit": deposit_bounds().1.to_string()}))?
            .with_signer(fsigner.clone()).send_to(&net).await?;
        let hash = txh(&r);
        r.into_result().map_err(|e| fail(format!("deploy {factory} failed: {e:?} (key kept at {}; rerun with IT_RESUME=1)", kpath.display())))?;
        txs.push(json!({"step": "deploy_factory", "tx": hash}));
        record(&progress, &txs)?;
    }

    // 4. Check everything that can't be changed after the lock, including the refund float.
    let (ok, cfg) = checks(&net, &factory, &code_hash, &factory_hash).await?;
    let free = free_yocto(&net, &factory).await;
    let spare = spare_ok(free, min_spare);
    println!("  {} spare float: {:.3} NEAR free, needs {:.3}", if spare { "PASS" } else { "FAIL" }, near(free), near(min_spare));
    // Anyone may call create_vault before the lock (round 3 L-3): every listed vault must be genuine, not absent.
    let mut empty = true;
    for v in listed_vaults(&net, &factory).await? {
        let g = genuine(&net, &factory, &code_hash, &v).await?;
        println!("  {} listed vault {v} is genuine{}", if g.is_ok() { "PASS" } else { "FAIL" }, g.as_ref().err().map(|e| format!(" ({e})")).unwrap_or_default());
        empty &= g.is_ok();
    }
    if !ok || !spare || !empty {
        return Err(fail(format!("checks failed; the factory key is NOT deleted (kept at {}); fix, then rerun with IT_RESUME=1", kpath.display())));
    }

    // 5. Lock: delete the only key, then prove there are none.
    let keys_before = near_api::Account(id(&factory)).list_keys().fetch_from(&net).await?.data;
    if keys_before.len() != 1 || keys_before[0].0 != fpk { return Err(fail(format!("expected exactly our one key on {factory}, found {}", keys_before.len()))); }
    let r = near_api::Account(id(&factory)).delete_key(fpk).with_signer(fsigner).send_to(&net).await?;
    let hash = txh(&r);
    r.into_result().map_err(|e| fail(format!("delete_key failed: {e:?}")))?;
    txs.push(json!({"step": "delete_factory_key", "tx": hash}));
    record(&progress, &txs)?;
    let keys_after = near_api::Account(id(&factory)).list_keys().fetch_from(&net).await?.data;
    if !keys_after.is_empty() { return Err(fail(format!("{factory} still has {} key(s)", keys_after.len()))); }
    std::fs::remove_file(&kpath)?;
    println!("LOCKED: {factory} has 0 access keys");

    let out = format!("../../deploy/testnet/lock-{ts}.json");
    std::fs::write(&out, serde_json::to_string_pretty(&json!({"date_unix": ts, "network": "testnet", "factory": factory,
        "parent": parent, "vault_code_hash": code_hash, "vault_wasm_bytes": vault_code.len(), "factory_code_hash": factory_hash,
        "config": cfg, "spare_free_near": near(free), "min_spare_near": near(min_spare), "access_keys_after_lock": 0, "txs": txs,
        "build": "cargo near build non-reproducible-wasm (reproducible build needs a committed repo; after 1 Nov)"}))?)?;
    println!("result: deploy/testnet/lock-{ts}.json");
    Ok(())
}

/// The pre-lock checks: code and config the lock makes permanent.
async fn checks(net: &NetworkConfig, factory: &str, code_hash: &str, factory_hash: &str) -> R<(bool, Value)> {
    let cfg: Value = near_api::Contract(id(factory)).call_function("get_config", json!({})).read_only().fetch_from(net).await?.data;
    let acct = near_api::Account(id(factory)).view().fetch_from(net).await?.data;
    let onchain_code = format!("{:?}", acct.contract_state);
    let checks = [
        ("factory code hash", onchain_code.contains(factory_hash), onchain_code.clone()),
        ("pinned vault code hash", cfg["code_hash"] == code_hash, cfg["code_hash"].to_string()),
        ("exchange", cfg["exchange_id"] == REF, cfg["exchange_id"].to_string()),
        ("intents", cfg["intents_id"] == INTENTS, cfg["intents_id"].to_string()),
        ("mpc is the real testnet signer", cfg["mpc_id"] == MPC, cfg["mpc_id"].to_string()),
        ("min deposit", cfg["min_deposit"] == deposit_bounds().0.to_string(), cfg["min_deposit"].to_string()),
        ("max deposit", cfg["max_deposit"] == deposit_bounds().1.to_string(), cfg["max_deposit"].to_string()),
    ];
    for (name, ok, got) in &checks { println!("  {} {name}{}", if *ok { "PASS" } else { "FAIL" }, if *ok { String::new() } else { format!(" (got {got})") }); }
    Ok((checks.iter().all(|c| c.1), cfg))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_refuses_below_the_refund_float() {
        let min = MAX_DEPOSIT_MILLI * MILLI;
        assert!(!spare_ok(min - 1, min));
        assert!(spare_ok(min, min));
        assert!(!spare_ok(1_009_800 * MILLI / 1000, min), "the live arena float (~1.01 NEAR) must fail");
    }

    #[test]
    fn resume_never_repeats_or_guesses() {
        assert_eq!(plan(false, false, false, false, 0), Plan::Fresh);
        assert!(matches!(plan(true, true, false, true, 1), Plan::Refuse(_)), "an existing factory needs IT_RESUME");
        assert!(matches!(plan(true, true, true, false, 1), Plan::Refuse(_)), "resume needs the pending key");
        assert!(matches!(plan(true, true, true, true, 0), Plan::Refuse(_)), "a locked factory can't be resumed");
        assert!(matches!(plan(true, true, true, true, 2), Plan::Refuse(_)), "two keys: not ours alone");
        assert_eq!(plan(true, false, true, true, 1), Plan::Deploy);
        assert_eq!(plan(true, true, true, true, 1), Plan::Check);
    }

    #[test]
    fn key_files_are_private_and_never_replaced() {
        let dir = std::env::temp_dir().join(format!("it-keytest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("k.json");
        let _ = std::fs::remove_file(&p);
        write_secret(&p, &json!({"secret_key": "x"})).unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(write_secret(&p, &json!({"secret_key": "y"})).is_err(), "an existing key file must not be overwritten");
        assert!(std::fs::read_to_string(&p).unwrap().contains("\"x\""));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
