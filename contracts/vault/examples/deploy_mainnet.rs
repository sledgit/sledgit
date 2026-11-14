//! Mainnet: publish the vault code (global, by hash), deploy a factory pinned to it, prove it with a canary vault, then
//! delete the factory's only key. Default is PLAN mode: every check runs against the chain (read-only) and the exact
//! transactions are printed; nothing is signed or sent.
//!
//!   IT_FACTORY=arena.sledgit.near cargo run --example deploy_mainnet                 # plan (read-only)
//!   IT_FACTORY=arena.sledgit.near SLEDGIT_MAINNET_CONFIRM=arena.sledgit.near \
//!     IT_EXPECT_VAULT_HASH=<b58> IT_EXPECT_FACTORY_HASH=<b58> IT_CANARY_POLICY=deploy/mainnet/canary-policy.json \
//!     cargo run --example deploy_mainnet                                               # send
//!
//! Env:
//! - IT_FACTORY (sub-account to create, under IT_PARENT, default the factory's parent).
//! - IT_OWNER (canary vault owner; must not share a key with the parent). IT_PAYER (pays the global publish, default
//!   the parent).
//! - IT_MIN_DEPOSIT / IT_MAX_DEPOSIT (millinear, default 100 / 10000).
//! - IT_ADMIN (default the parent; `none` = no admin, settings fixed forever): the factory's beta-settings admin
//!   (deposit caps and bounds only; never funds).
//! - IT_DEPOSIT_CAPS: JSON file `[{"token": "<id>", "max": "<raw units>"}]`, the per-vault net-deposit caps every vault
//!   gets for life. Required on mainnet; tokens outside the list can't be deposited into a capped vault.
//! - IT_FACTORY_FUND (millinear, default 3000: storage + a margin; a recorded refund keeps its listing fee for its own
//!   storage, so refunds need no float beyond that).
//! - IT_EXPECT_SOURCE_REV (mainnet send): the git commit of the reproducible build. The factory's and the canary's
//!   `contract_source_metadata` must name it (NEP-330). Only possible once the repo is public and built reproducibly.
//! - IT_KEY_DIR (default ~/.config/sledgit; files `<target>-*.json`, never printed). IT_OUT_DIR (default deploy/<target>).
//! - IT_RESUME=1 finishes an interrupted run from its pending key file.
//! - IT_TARGET=sandbox (tests only) with IT_RPC, IT_REF, IT_INTENTS, IT_MPC, IT_SUFFIX: refused if the RPC reports mainnet
//!   or testnet.
//! Fails closed: any mismatch stops before the factory key is deleted. Vaults other people create from the factory
//! before the lock are accepted only if each is genuine (0 keys, pinned code, the factory's ids).
//! Results (no secrets): deploy/<target>/lock-<ts>.json; progress: deploy/<target>/lock-progress-<factory>.json.
use near_api::types::transaction::result::TransactionResult;
use near_api::{AccountId, NearToken, NetworkConfig, Signer};
use near_sdk::serde_json::{self, json, Value};
use k256::sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
#[path = "shared/local.rs"] mod local;

type R<T = ()> = Result<T, Box<dyn std::error::Error>>;
const MILLI: u128 = 1_000_000_000_000_000_000_000;
/// sha256 of the exact binaries the sandbox suites test against (contracts/vault/tests/res, SOURCES.md), base58.
const RHEA_CODE: &str = "GZmkbfVLcN7ErxU9RDxP24YTaKmoVixhM6XyycP15Qvi";
const INTENTS_CODE: &str = "BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk";
use sledgit_vault::MPC_PATH; // one source of truth with the vault

/// Where the run goes. Mainnet constants are fixed; the sandbox target exists only so tests can run the whole flow.
struct Target { name: &'static str, rpc: String, reference: String, intents: String, mpc: String, suffix: String }

impl Target {
    fn from_env() -> R<Target> {
        if env_or("IT_TARGET", "mainnet") == "sandbox" {
            let need = |k: &str| std::env::var(k).map_err(|_| fail(format!("IT_TARGET=sandbox needs {k}")));
            return Ok(Target { name: "sandbox", rpc: need("IT_RPC")?, reference: need("IT_REF")?, intents: need("IT_INTENTS")?,
                mpc: need("IT_MPC")?, suffix: need("IT_SUFFIX")? });
        }
        Ok(Target { name: "mainnet", rpc: env_or("IT_RPC", "https://rpc.mainnet.fastnear.com"), reference: "v2.ref-finance.near".into(),
            intents: "intents.near".into(), mpc: "v1.signer".into(), suffix: ".near".into() })
    }
}

fn id(s: &str) -> AccountId { s.parse().unwrap() }
fn env_or(k: &str, d: &str) -> String { std::env::var(k).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| d.to_string()) }
fn flag(k: &str) -> bool { env_or(k, "") == "1" }
fn b58_sha256(b: &[u8]) -> String { bs58::encode(Sha256::digest(b)).into_string() }
fn fail(msg: impl Into<String>) -> Box<dyn std::error::Error> { msg.into().into() }
fn near(y: u128) -> f64 { y as f64 / 1e24 }

/// Sending is allowed only on an explicit confirmation naming this factory; mainnet needs both expected hashes too.
fn may_send(t: &str, chain: &str, confirm: Option<&str>, factory: &str, hashes_pinned: bool) -> Result<bool, String> {
    match (t, chain) {
        ("mainnet", "mainnet") => {}
        ("sandbox", c) if c != "mainnet" && c != "testnet" => {}
        _ => return Err(format!("target {t} but the RPC reports chain {chain}")),
    }
    match confirm {
        None => Ok(false),
        Some(c) if c != factory => Err(format!("SLEDGIT_MAINNET_CONFIRM={c} doesn't name the factory {factory}")),
        Some(_) if !hashes_pinned => Err("sending needs IT_EXPECT_VAULT_HASH and IT_EXPECT_FACTORY_HASH matching the local build".into()),
        Some(_) => Ok(true),
    }
}

/// Names on the right network, the factory one level under its parent, and an owner that is neither the parent nor
/// the (soon keyless) factory.
fn names_ok(t: &Target, factory: &str, parent: &str, owner: &str) -> Result<(), String> {
    for (what, a) in [("factory", factory), ("parent", parent), ("owner", owner)] {
        if !a.ends_with(&t.suffix) { return Err(format!("{what} {a} isn't a {} account", t.suffix)); }
    }
    if t.name == "mainnet" && [factory, parent, owner].iter().any(|a| a.ends_with(".testnet")) { return Err("testnet name on mainnet".into()); }
    if factory.split_once('.').map(|x| x.1) != Some(parent) { return Err(format!("{factory} isn't a direct sub-account of {parent}")); }
    if owner == parent { return Err("the owner must not be the parent account (separate keys)".into()); }
    if owner == factory { return Err("the owner must not be the factory (it ends up keyless; the canary's deposit would be stranded)".into()); }
    Ok(())
}

/// An unguessable canary name, so nobody can take it before the run creates it.
fn canary_name() -> String {
    let mut b = [0u8; 6];
    getrandom(&mut b);
    format!("canary-{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())
}

/// Six random bytes from the OS (no extra dependency): /dev/urandom on unix.
fn getrandom(buf: &mut [u8]) {
    use std::io::Read;
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(buf)).expect("/dev/urandom");
}

/// NEP-330 `contract_source_metadata` names `rev` (the git commit of the reproducible build).
fn source_names_rev(meta: &Value, rev: &str) -> bool {
    !rev.is_empty() && meta["build_info"]["source_code_snapshot"].as_str().is_some_and(|s| s.contains(rev))
}

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

/// A vault is genuine when it is this factory's child with 0 keys, runs the pinned code and carries the factory's ids.
async fn genuine(net: &NetworkConfig, t: &Target, factory: &str, code_hash: &str, v: &str) -> R<Result<(), String>> {
    if v.split_once('.').map(|x| x.1) != Some(factory) { return Ok(Err("not a direct child of the factory".into())); }
    let keys = near_api::Account(id(v)).list_keys().fetch_from(net).await?.data;
    if !keys.is_empty() { return Ok(Err(format!("{} access keys", keys.len()))); }
    let acct = near_api::Account(id(v)).view().fetch_from(net).await?.data;
    if !format!("{acct:?}").contains(code_hash) { return Ok(Err(format!("code {:?}", acct.contract_state))); }
    let c: Value = near_api::Contract(id(v)).call_function("get_config", json!({})).read_only().fetch_from(net).await?.data;
    if c["exchange_id"] != t.reference.as_str() || c["intents_id"] != t.intents.as_str() || c["mpc_id"] != t.mpc.as_str() {
        return Ok(Err(format!("config {c}")));
    }
    Ok(Ok(()))
}

#[derive(Debug, PartialEq)]
enum Plan { Fresh, Deploy, Canary, Lock, Refuse(&'static str) }
fn plan(exists: bool, code_deployed: bool, has_canary: bool, resume: bool, pending_key: bool, keys: usize) -> Plan {
    if !exists { return Plan::Fresh; }
    if !resume { return Plan::Refuse("factory already exists; set IT_RESUME=1 to finish an interrupted run, or pick a new IT_FACTORY"); }
    if !pending_key { return Plan::Refuse("IT_RESUME=1 but no pending key file for this factory"); }
    if keys != 1 { return Plan::Refuse("factory doesn't have exactly one key (already locked, or not ours)"); }
    match (code_deployed, has_canary) { (false, _) => Plan::Deploy, (true, false) => Plan::Canary, (true, true) => Plan::Lock }
}

fn key_dir() -> R<std::path::PathBuf> {
    Ok(std::env::var("IT_KEY_DIR").map(std::path::PathBuf::from)
        .unwrap_or(local::key_dir()?))
}

/// Account -> signer from `<target>-*.json` key files (never printed).
fn load_keys(target: &str) -> R<HashMap<String, Arc<Signer>>> {
    let mut keys = HashMap::new();
    let Ok(dir) = std::fs::read_dir(key_dir()?) else { return Ok(keys) };
    for e in dir {
        let p = e?.path();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        if !name.starts_with(&format!("{target}-")) || !name.ends_with(".json") { continue; }
        let d: Value = serde_json::from_str(&std::fs::read_to_string(&p)?)?;
        if let (Some(sk), Some(accts)) = (d["secret_key"].as_str(), d["accounts"].as_array()) {
            for a in accts { if let Some(a) = a.as_str() { keys.insert(a.to_string(), Signer::from_secret_key(sk.parse()?)?); } }
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

fn txh(r: &TransactionResult) -> String {
    r.clone().into_full().and_then(|f| f.outcomes().first().map(|o| o.transaction_hash.to_string())).unwrap_or_default()
}

async fn chain_id(rpc: &str) -> R<String> {
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": "status", "params": []}).to_string();
    let out = std::process::Command::new("curl").args(["-s", "-m", "20", "-H", "content-type: application/json", "-d", &body, rpc]).output()?;
    let v: Value = serde_json::from_slice(&out.stdout)?;
    v["result"]["chain_id"].as_str().map(String::from).ok_or_else(|| fail("RPC status has no chain_id"))
}

async fn code_hash_of(net: &NetworkConfig, a: &str) -> R<String> {
    let acct = near_api::Account(id(a)).view().fetch_from(net).await?.data;
    Ok(format!("{:?}", acct.contract_state))
}

async fn free_yocto(net: &NetworkConfig, a: &str) -> u128 {
    near_api::Tokens::account(id(a)).near_balance().fetch_from(net).await
        .map(|b| b.total.as_yoctonear().saturating_sub(b.storage_locked.as_yoctonear())).unwrap_or(0)
}

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

struct Report { ok: bool }
impl Report {
    fn check(&mut self, name: &str, ok: bool, got: impl std::fmt::Display) {
        if ok { println!("  PASS {name}"); } else { println!("  FAIL {name} (got {got})"); self.ok = false; }
    }
}

/// The contracts every vault will trust, checked independently of our own config.
async fn dependencies(net: &NetworkConfig, t: &Target, rep: &mut Report, factory: &str) -> R {
    for (what, a, want) in [("Rhea", &t.reference, RHEA_CODE), ("NEAR Intents", &t.intents, INTENTS_CODE)] {
        let got = code_hash_of(net, a).await.unwrap_or_else(|e| format!("error {e}"));
        rep.check(&format!("{what} {a} runs the binary the sandbox suites test ({want})"), got.contains(want), got);
    }
    // The signer: a live contract that derives keys for the vault's path. Its code is upgraded by its own
    // governance, so the hash is recorded, not pinned.
    let probe = format!("probe.{factory}");
    let derived = near_api::Contract(id(&t.mpc)).call_function("derived_public_key",
        json!({"path": MPC_PATH, "predecessor": probe, "domain_id": 0})).read_only::<Value>().fetch_from(net).await;
    let ok = matches!(&derived, Ok(d) if d.data.as_str().map(|s| s.starts_with("secp256k1:")).unwrap_or(false));
    rep.check(&format!("{} derives a secp256k1 key for {MPC_PATH}", t.mpc), ok, format!("{:?}", derived.map(|d| d.data)));
    println!("  INFO {} code {}", t.mpc, code_hash_of(net, &t.mpc).await.unwrap_or_default());
    Ok(())
}

fn print_tx(n: usize, signer: &str, receiver: &str, what: &str) { println!("  tx {n}: {signer} -> {receiver}: {what}"); }

#[tokio::main]
async fn main() -> R {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs();
    let t = Target::from_env()?;
    let chain = chain_id(&t.rpc).await?;
    let net = NetworkConfig::from_rpc_url(t.name, t.rpc.parse()?);

    let factory = env_or("IT_FACTORY", &format!("arena.sledgit{}", t.suffix));
    let parent = env_or("IT_PARENT", factory.split_once('.').map(|x| x.1).unwrap_or(""));
    let owner = env_or("IT_OWNER", &format!("owner.sledgit{}", t.suffix));
    let payer = env_or("IT_PAYER", &parent);
    let admin = env_or("IT_ADMIN", &parent);
    let admin_json = if admin == "none" { Value::Null } else { json!(admin) };
    // The canary's agent is never used to trade; it only has to differ from the owner (the vault refuses owner = agent).
    let canary_agent = env_or("IT_CANARY_AGENT", &format!("canary-agent.{parent}"));
    let min_deposit = env_or("IT_MIN_DEPOSIT", "100").parse::<u128>()? * MILLI;
    let max_deposit = env_or("IT_MAX_DEPOSIT", "10000").parse::<u128>()? * MILLI;
    let fund = NearToken::from_millinear(env_or("IT_FACTORY_FUND", "3000").parse()?);
    names_ok(&t, &factory, &parent, &owner).map_err(fail)?;
    if max_deposit > 100_000 * MILLI || max_deposit < min_deposit { return Err(fail("deposit bounds: min ≤ max ≤ 100 NEAR")); }

    let vault_code = std::fs::read("../target/near/sledgit_vault/sledgit_vault.wasm")?;
    let factory_code = std::fs::read("../target/near/sledgit_factory/sledgit_factory.wasm")?;
    let (code_hash, factory_hash) = (b58_sha256(&vault_code), b58_sha256(&factory_code));
    let expect_v = std::env::var("IT_EXPECT_VAULT_HASH").ok();
    let expect_f = std::env::var("IT_EXPECT_FACTORY_HASH").ok();
    let pinned = expect_v.as_deref() == Some(code_hash.as_str()) && expect_f.as_deref() == Some(factory_hash.as_str());
    let source_rev = env_or("IT_EXPECT_SOURCE_REV", "");
    let confirm = local::mainnet_confirm();
    let send = may_send(t.name, &chain, confirm.as_deref(), &factory, pinned).map_err(fail)?;

    println!("{} run on chain '{chain}' ({})", if send { "SEND" } else { "PLAN (read-only)" }, t.rpc);
    println!("factory {factory}  parent {parent}  canary owner {owner}  payer {payer}  admin {admin} (beta caps and bounds only)");
    println!("vault code   {} bytes  {code_hash}  expected {}", vault_code.len(), expect_v.as_deref().unwrap_or("(not set)"));
    println!("factory code {} bytes  {factory_hash}  expected {}", factory_code.len(), expect_f.as_deref().unwrap_or("(not set)"));
    println!("deposits: min {:.3} NEAR, season max {:.3} NEAR", near(min_deposit), near(max_deposit));

    let mut rep = Report { ok: true };
    println!("checks:");
    rep.check("expected vault + factory hashes match the local build", pinned, "set IT_EXPECT_VAULT_HASH / IT_EXPECT_FACTORY_HASH from the reproducible build");
    if t.name == "mainnet" {
        rep.check("source commit of the reproducible build given (IT_EXPECT_SOURCE_REV)", !source_rev.is_empty(),
            "not set: needs the public repo and `cargo near build reproducible-wasm`");
    }
    dependencies(&net, &t, &mut rep, &factory).await?;
    let parent_exists = near_api::Account(id(&parent)).view().fetch_from(&net).await.is_ok();
    rep.check(&format!("parent {parent} exists"), parent_exists, "missing");
    let owner_exists = near_api::Account(id(&owner)).view().fetch_from(&net).await.is_ok();
    rep.check(&format!("canary owner {owner} exists"), owner_exists, "missing");

    let keys = load_keys(t.name)?;
    let pk = |a: &str| keys.get(a).cloned();
    let (parent_signer, owner_signer) = (pk(&parent), pk(&owner));
    if let (Some(p), Some(o)) = (&parent_signer, &owner_signer) {
        rep.check("owner and parent use different keys", p.get_public_key().await? != o.get_public_key().await?, "same key");
    } else {
        println!("  INFO key files for {parent} / {owner} not found in {} (needed only to send)", key_dir()?.display());
    }
    let policy: Option<Value> = match std::env::var("IT_CANARY_POLICY") {
        Ok(p) => Some(serde_json::from_str(&std::fs::read_to_string(&p)?)?),
        Err(_) => None,
    };
    rep.check("canary policy given (IT_CANARY_POLICY)", policy.is_some(), "not set");
    let caps: Value = match std::env::var("IT_DEPOSIT_CAPS") {
        Ok(p) => serde_json::from_str(&std::fs::read_to_string(&p)?)?,
        Err(_) => json!([]),
    };
    let caps_ok = caps.as_array().map(|a| a.iter().all(|c| c["token"].is_string()
        && c["max"].as_str().and_then(|m| m.parse::<u128>().ok()).is_some_and(|m| m > 0))).unwrap_or(false);
    // Human units before a permanent send: decimals from each token's own metadata (raw if unreadable).
    for c in caps.as_array().into_iter().flatten() {
        let tok = c["token"].as_str().unwrap_or("?");
        let meta = near_api::Contract(id(tok)).call_function("ft_metadata", json!({})).read_only::<Value>().fetch_from(&net).await.map(|d| d.data);
        match (meta, c["max"].as_str().and_then(|m| m.parse::<u128>().ok())) {
            (Ok(m), Some(max)) if m["decimals"].is_u64() => {
                let d = m["decimals"].as_u64().unwrap_or(0) as i32;
                println!("deposit cap: {} {} ({tok}, raw {max})", max as f64 / 10f64.powi(d), m["symbol"].as_str().unwrap_or("?"));
            }
            (r, _) => println!("deposit cap: {c} (metadata unreadable: {:?})", r.err()),
        }
    }
    rep.check("deposit caps well formed (IT_DEPOSIT_CAPS)", caps_ok, &caps);
    if t.name == "mainnet" {
        rep.check("deposit caps set (required on mainnet)", caps.as_array().is_some_and(|a| !a.is_empty()), "not set");
        if let Some(pt) = policy.as_ref().and_then(|p| p["tokens"].as_array()) {
            let capped = |tok: &Value| caps.as_array().is_some_and(|a| a.iter().any(|c| &c["token"] == tok));
            rep.check("every canary policy token has a cap", pt.iter().all(|x| capped(&x["token"])), &caps);
        }
    }

    let global = global_published(&net, &code_hash).await?;
    let acct = near_api::Account(id(&factory)).view().fetch_from(&net).await.ok();
    let fkeys = if acct.is_some() { near_api::Account(id(&factory)).list_keys().fetch_from(&net).await?.data } else { vec![] };
    let code_deployed = acct.as_ref().map(|a| !format!("{:?}", a.data.contract_state).contains("None")).unwrap_or(false);
    let kpath = key_dir()?.join(format!("{}-lockpending-{factory}.json", t.name));
    // The canary's name is random and kept in the pending key file, so a resumed run finds the same one.
    let pending: Option<Value> = std::fs::read_to_string(&kpath).ok().and_then(|s| serde_json::from_str(&s).ok());
    let canary_label = pending.as_ref().and_then(|v| v["canary"].as_str().map(String::from)).unwrap_or_else(canary_name);
    let canary = format!("{canary_label}.{factory}");
    let has_canary = near_api::Account(id(&canary)).view().fetch_from(&net).await.is_ok();
    let p = plan(acct.is_some(), code_deployed, has_canary, flag("IT_RESUME"), kpath.exists(), fkeys.len());
    if let Plan::Refuse(why) = p { return Err(fail(format!("{factory}: {why}"))); }

    // The exact transactions, in order.
    println!("transactions (plan: {p:?}):");
    let mut n = 0;
    let mut step = |s: &str, r: &str, w: &str| { n += 1; print_tx(n, s, r, w); };
    if !global { step(&payer, &payer, &format!("deploy_global_contract_code by hash {code_hash} ({} bytes, ~{:.2} NEAR burnt)", vault_code.len(), vault_code.len() as f64 * 1e-4)); }
    if p == Plan::Fresh { step(&parent, &factory, &format!("create_account + transfer {:.3} NEAR + add_key <fresh full-access key>", near(fund.as_yoctonear()))); }
    if matches!(p, Plan::Fresh | Plan::Deploy) {
        step(&factory, &factory, &format!("deploy factory ({factory_hash}) + new(code_hash={code_hash}, exchange={}, intents={}, mpc={}, min_deposit={}, max_deposit={}, deposit_caps=<IT_DEPOSIT_CAPS>, admin={admin})",
            t.reference, t.intents, t.mpc, min_deposit, max_deposit));
    }
    if p != Plan::Lock { step(&owner, &factory, &format!("create_vault(name={canary_label}, owner={owner}, agent={canary_agent}, policy=<IT_CANARY_POLICY>) attaching {:.3} NEAR", near(min_deposit))); }
    step(&factory, &factory, "delete_key <the fresh key>  (irreversible: the factory can never change again)");

    if !send {
        println!("{}", if rep.ok { "PLAN: all read-only checks pass; nothing was sent" } else { "PLAN: a check FAILS; fix it before sending" });
        return if rep.ok { Ok(()) } else { Err(fail("plan found a failing check")) };
    }
    if !rep.ok { return Err(fail("a check failed; nothing sent")); }
    let parent_signer = parent_signer.ok_or_else(|| fail(format!("no key file for {parent}")))?;
    let owner_signer = owner_signer.ok_or_else(|| fail(format!("no key file for {owner}")))?;
    let policy = policy.ok_or_else(|| fail("IT_CANARY_POLICY"))?;
    let out_dir = env_or("IT_OUT_DIR", &format!("../../deploy/{}", t.name));
    let progress = std::path::PathBuf::from(format!("{out_dir}/lock-progress-{factory}.json"));
    std::fs::create_dir_all(progress.parent().unwrap())?;
    let mut txs: Vec<Value> = vec![];
    let record = |txs: &[Value]| std::fs::write(&progress, serde_json::to_string_pretty(&json!({"steps": txs})).unwrap());

    // 1. Global vault code, by hash; skipped when the chain already serves it (fetched and re-hashed).
    if !global {
        let payer_signer = keys.get(&payer).cloned().ok_or_else(|| fail(format!("no key for payer {payer}")))?;
        let r = near_api::Contract::deploy_global_contract_code(vault_code.clone()).as_hash()
            .with_signer(id(&payer), payer_signer).send_to(&net).await?;
        let h = txh(&r);
        r.into_result().map_err(|e| fail(format!("global publish failed: {e:?}")))?;
        if !global_published(&net, &code_hash).await? { return Err(fail("global code not served by hash after publishing")); }
        txs.push(json!({"step": "publish_global_code", "tx": h})); record(&txs)?;
    }

    // 2. Factory account with a fresh key, kept on disk (0600) until it is deleted.
    let fsigner = if p == Plan::Fresh {
        let sk = near_api::signer::generate_secret_key()?;
        let s = Signer::from_secret_key(sk.clone())?;
        write_secret(&kpath, &json!({"network": t.name, "secret_key": sk.to_string(), "accounts": [factory], "canary": canary_label}))?;
        let r = near_api::Account::create_account(id(&factory)).fund_myself(id(&parent), fund).with_public_key(s.get_public_key().await?)
            .with_signer(parent_signer).send_to(&net).await?;
        let h = txh(&r);
        r.into_result().map_err(|e| fail(format!("create {factory} failed: {e:?}")))?;
        txs.push(json!({"step": "create_factory_account", "tx": h})); record(&txs)?;
        s
    } else {
        let s = load_keys(t.name)?.get(&factory).cloned().ok_or_else(|| fail("pending key file unreadable"))?;
        if fkeys.len() != 1 || fkeys[0].0 != s.get_public_key().await? { return Err(fail("the factory's key isn't the pending key on disk")); }
        txs.push(json!({"step": "resume", "from": format!("{p:?}")}));
        s
    };
    let fpk = fsigner.get_public_key().await?;

    // 3. Deploy and init.
    if matches!(p, Plan::Fresh | Plan::Deploy) {
        let r = near_api::Contract::deploy(id(&factory)).use_code(factory_code.clone())
            .with_init_call("new", json!({"code_hash": code_hash, "exchange_id": t.reference, "intents_id": t.intents, "mpc_id": t.mpc,
                "min_deposit": min_deposit.to_string(), "max_deposit": max_deposit.to_string(), "deposit_caps": caps, "admin": admin_json}))?
            .with_signer(fsigner.clone()).send_to(&net).await?;
        let h = txh(&r);
        r.into_result().map_err(|e| fail(format!("deploy failed: {e:?} (key kept at {}; rerun with IT_RESUME=1)", kpath.display())))?;
        txs.push(json!({"step": "deploy_factory", "tx": h})); record(&txs)?;
    }

    // 4. Factory checks: code, config, nothing owed.
    let cfg: Value = near_api::Contract(id(&factory)).call_function("get_config", json!({})).read_only().fetch_from(&net).await?.data;
    let onchain = code_hash_of(&net, &factory).await?;
    println!("factory checks:");
    rep.check("factory code hash", onchain.contains(&factory_hash), &onchain);
    rep.check("pinned vault code hash", cfg["code_hash"] == code_hash.as_str(), &cfg["code_hash"]);
    rep.check("exchange", cfg["exchange_id"] == t.reference.as_str(), &cfg["exchange_id"]);
    rep.check("intents", cfg["intents_id"] == t.intents.as_str(), &cfg["intents_id"]);
    rep.check("mpc", cfg["mpc_id"] == t.mpc.as_str(), &cfg["mpc_id"]);
    rep.check("deposit bounds", cfg["min_deposit"] == min_deposit.to_string().as_str() && cfg["max_deposit"] == max_deposit.to_string().as_str(), &cfg);
    rep.check("no refunds owed", cfg["owed_refunds"] == "0", &cfg["owed_refunds"]);
    rep.check("deposit caps", cfg["deposit_caps"] == caps, &cfg["deposit_caps"]);
    rep.check("beta-settings admin", cfg["admin"] == admin_json && cfg["proposed_admin"].is_null(), &cfg["admin"]);
    if t.name == "mainnet" {
        let meta = near_api::Contract(id(&factory)).call_function("contract_source_metadata", json!({})).read_only::<Value>()
            .fetch_from(&net).await.map(|d| d.data).unwrap_or(Value::Null);
        rep.check("factory source metadata names the commit", source_names_rev(&meta, &source_rev), &meta);
    }
    if !rep.ok { return Err(fail(format!("factory checks failed; key NOT deleted (kept at {}); rerun with IT_RESUME=1 after fixing", kpath.display()))); }

    // 5. Canary vault: created through the factory by the owner, then inspected like any user's vault would be.
    if p != Plan::Lock {
        let r = near_api::Contract(id(&factory)).call_function("create_vault", json!({"name": canary_label, "owner_id": owner, "agent_id": canary_agent, "policy": policy}))
            .transaction().deposit(NearToken::from_yoctonear(min_deposit)).gas(near_api::NearGas::from_tgas(150))
            .with_signer(id(&owner), owner_signer).send_to(&net).await?;
        let h = txh(&r);
        let logs = r.logs().join("\n");
        r.into_result().map_err(|e| fail(format!("canary create failed: {e:?}")))?;
        // The outer call succeeds even when the batch fails; only the factory's event says the vault exists.
        if !logs.contains("\"event\":\"vault_created\"") { return Err(fail(format!("canary not created (key NOT deleted): {logs}"))); }
        txs.push(json!({"step": "create_canary_vault", "tx": h})); record(&txs)?;
    }
    println!("canary checks:");
    let exists = near_api::Account(id(&canary)).view().fetch_from(&net).await.is_ok();
    rep.check("canary account exists", exists, "missing");
    if !exists { return Err(fail(format!("no canary vault; key NOT deleted (kept at {})", kpath.display()))); }
    let ckeys = near_api::Account(id(&canary)).list_keys().fetch_from(&net).await?.data;
    rep.check("canary vault has 0 access keys", ckeys.is_empty(), ckeys.len());
    let cacct = near_api::Account(id(&canary)).view().fetch_from(&net).await?.data;
    rep.check("canary runs the pinned global code", format!("{cacct:?}").contains(&code_hash), format!("{:?}", cacct.contract_state));
    let vcfg: Value = near_api::Contract(id(&canary)).call_function("get_config", json!({})).read_only().fetch_from(&net).await?.data;
    rep.check("canary config ids, owner and agent", vcfg["exchange_id"] == t.reference.as_str() && vcfg["intents_id"] == t.intents.as_str()
        && vcfg["mpc_id"] == t.mpc.as_str() && vcfg["owner_id"] == owner.as_str() && vcfg["agent_id"] == canary_agent.as_str(), &vcfg);
    let vcaps: Value = near_api::Contract(id(&canary)).call_function("get_deposit_caps", json!({})).read_only().fetch_from(&net).await?.data;
    let maxes = |v: &Value| v.as_array().map(|a| a.iter().map(|c| (c["token"].clone(), c["max"].clone())).collect::<Vec<_>>());
    rep.check("canary carries the factory's deposit caps", maxes(&vcaps) == maxes(&caps), &vcaps);
    let vpolicy: Value = near_api::Contract(id(&canary)).call_function("get_policy", json!({})).read_only().fetch_from(&net).await?.data;
    let as_policy = |v: &Value| serde_json::from_value::<sledgit_vault::Policy>(v.clone()).ok();
    rep.check("canary policy is exactly IT_CANARY_POLICY", as_policy(&vpolicy).is_some() && as_policy(&vpolicy) == as_policy(&policy), &vpolicy);
    let pair = &policy["pairs"][0];
    let preview = near_api::Contract(id(&canary)).call_function("preview_swap", json!({"token_in": pair["token_in"], "token_out": pair["token_out"],
        "amount_in": "1", "min_amount_out": "1"})).read_only::<Value>().fetch_from(&net).await;
    rep.check("canary accepts a 1-unit preview of its first pair", matches!(&preview, Ok(v) if v.data["ok"] == true), format!("{:?}", preview.map(|v| v.data)));
    if t.name == "mainnet" {
        let meta = near_api::Contract(id(&canary)).call_function("contract_source_metadata", json!({})).read_only::<Value>()
            .fetch_from(&net).await.map(|d| d.data).unwrap_or(Value::Null);
        rep.check("canary source metadata names the commit", source_names_rev(&meta, &source_rev), &meta);
    }
    // Anyone may create vaults before the lock; each must be genuine, and the canary must be among them.
    let listed = listed_vaults(&net, &factory).await?;
    rep.check("factory lists the canary", listed.contains(&canary), format!("{listed:?}"));
    for v in &listed {
        let g = genuine(&net, &t, &factory, &code_hash, v).await?;
        rep.check(&format!("listed vault {v} is genuine"), g.is_ok(), g.err().unwrap_or_default());
    }
    if !rep.ok { return Err(fail(format!("canary checks failed; key NOT deleted (kept at {})", kpath.display()))); }

    // 6. Lock.
    let before = near_api::Account(id(&factory)).list_keys().fetch_from(&net).await?.data;
    if before.len() != 1 || before[0].0 != fpk { return Err(fail(format!("expected exactly our one key on {factory}, found {}", before.len()))); }
    let r = near_api::Account(id(&factory)).delete_key(fpk).with_signer(fsigner).send_to(&net).await?;
    let h = txh(&r);
    r.into_result().map_err(|e| fail(format!("delete_key failed: {e:?}")))?;
    txs.push(json!({"step": "delete_factory_key", "tx": h})); record(&txs)?;
    let after = near_api::Account(id(&factory)).list_keys().fetch_from(&net).await?.data;
    if !after.is_empty() { return Err(fail(format!("{factory} still has {} key(s)", after.len()))); }
    std::fs::remove_file(&kpath)?;
    println!("LOCKED: {factory} has 0 access keys");
    let out = format!("{out_dir}/lock-{ts}.json");
    std::fs::write(&out, serde_json::to_string_pretty(&json!({"date_unix": ts, "network": t.name, "chain_id": chain, "factory": factory,
        "parent": parent, "owner": owner, "vault_code_hash": code_hash, "factory_code_hash": factory_hash, "config": cfg,
        "canary": canary, "listed_vaults": listed.len(), "factory_free_near": near(free_yocto(&net, &factory).await), "access_keys_after_lock": 0, "txs": txs}))?)?;
    println!("result: {out}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mainnet() -> Target {
        Target { name: "mainnet", rpc: String::new(), reference: "v2.ref-finance.near".into(), intents: "intents.near".into(),
            mpc: "v1.signer".into(), suffix: ".near".into() }
    }

    #[test]
    fn sends_only_with_matching_confirmation_and_pinned_hashes() {
        let f = "arena.sledgit.near";
        assert_eq!(may_send("mainnet", "mainnet", None, f, true), Ok(false), "no confirmation = plan only");
        assert!(may_send("mainnet", "mainnet", Some("arena2.sledgit.near"), f, true).is_err(), "confirmation must name the factory");
        assert!(may_send("mainnet", "mainnet", Some(f), f, false).is_err(), "hashes must be pinned");
        assert_eq!(may_send("mainnet", "mainnet", Some(f), f, true), Ok(true));
        assert!(may_send("mainnet", "testnet", Some(f), f, true).is_err(), "mainnet target on a testnet RPC");
        assert!(may_send("sandbox", "mainnet", Some(f), f, true).is_err(), "the sandbox target must never reach mainnet");
        assert!(may_send("sandbox", "testnet", Some(f), f, true).is_err());
    }

    #[test]
    fn names_stay_on_mainnet_and_owner_is_separate() {
        let t = mainnet();
        assert!(names_ok(&t, "arena.sledgit.near", "sledgit.near", "owner.sledgit.near").is_ok());
        assert!(names_ok(&t, "arena.irontrade.testnet", "irontrade.testnet", "o.testnet").is_err());
        assert!(names_ok(&t, "arena.x.sledgit.near", "sledgit.near", "owner.sledgit.near").is_err(), "direct sub-account only");
        assert!(names_ok(&t, "arena.sledgit.near", "sledgit.near", "sledgit.near").is_err(), "owner must not be the parent");
        assert!(names_ok(&t, "arena.sledgit.near", "sledgit.near", "arena.sledgit.near").is_err(), "owner must not be the factory");
    }

    #[test]
    fn canary_names_are_unguessable_and_valid() {
        let (a, b) = (canary_name(), canary_name());
        assert_ne!(a, b);
        assert!(a.starts_with("canary-") && a.len() == 19 && a[7..].bytes().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn source_metadata_must_name_the_commit() {
        let m = json!({"build_info": {"source_code_snapshot": "git+https://github.com/x/sledgit?rev=abc123"}});
        assert!(source_names_rev(&m, "abc123"));
        assert!(!source_names_rev(&m, "def456"));
        assert!(!source_names_rev(&m, ""), "an empty commit never matches");
        assert!(!source_names_rev(&Value::Null, "abc123"), "no metadata (non-reproducible build) fails");
    }

    #[test]
    fn resume_never_repeats_or_guesses() {
        assert_eq!(plan(false, false, false, false, false, 0), Plan::Fresh);
        assert!(matches!(plan(true, true, false, false, true, 1), Plan::Refuse(_)));
        assert!(matches!(plan(true, true, false, true, false, 1), Plan::Refuse(_)));
        assert!(matches!(plan(true, true, true, true, true, 0), Plan::Refuse(_)), "already locked");
        assert_eq!(plan(true, false, false, true, true, 1), Plan::Deploy);
        assert_eq!(plan(true, true, false, true, true, 1), Plan::Canary);
        assert_eq!(plan(true, true, true, true, true, 1), Plan::Lock);
    }
}
