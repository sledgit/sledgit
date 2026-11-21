//! Season 1 vaults, one entry at a time, each signed by THAT entry's own owner and agent accounts. Default is PLAN
//! mode: the config is validated, read-only checks run against the chain, and every transaction is printed with the
//! NEAR and tokens each account must hold. Nothing is signed or sent.
//!
//!   IT_SEASON_CONFIG=deploy/mainnet/season1.json cargo run --example season1_mainnet               # plan
//!   IT_SEASON_CONFIG=... IT_ENTRY=house-trend SLEDGIT_MAINNET_CONFIRM=house-trend \
//!     cargo run --example season1_mainnet                                                          # send one entry
//!
//! Each vault is created by its owner through the locked factory's `create_vault`.
//!
//! Separation (refused): an account used by two entries, an owner that is also an agent, any entry account equal to
//! the factory, its parent or a vault. A public key shared between two entries' accounts is reported.
//! Send needs the config's network to match the RPC's chain_id, SLEDGIT_MAINNET_CONFIRM naming the entry (on every
//! network, so a testnet rehearsal exercises the same gate), an expected code hash that isn't a placeholder, and the
//! factory locked on that code with the configured exchange/intents/MPC.
//! Steps are skipped when already done on chain, so a rerun never pays twice. The agent account ends with exactly one
//! function-call key (the vault, the agent methods, a finite allowance) for the agent software, and exactly one
//! full-access RECOVERY key that John holds offline (`recovery_public_key` in the entry, or generated into
//! ~/.config/sledgit/RECOVERY-<network>-agent-<name>.json, 0600, to be moved offline). The agent's NEAR stays
//! recoverable through it.
//! Keys: ~/.config/sledgit/<network>-*.json listing the account ids they sign for (never printed).
//! Results (no secrets): deploy/<network>/season1-<entry>-<ts>.json.
use near_api::types::transaction::actions::FunctionCallPermission;
use near_api::types::transaction::result::TransactionResult;
use near_api::types::AccessKeyPermission;
use near_api::{AccountId, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::serde_json::{self, json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
#[path = "shared/local.rs"] mod local;

type R<T = ()> = Result<T, Box<dyn std::error::Error>>;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const AGENT_METHODS: [&str; 6] = ["request_swap", "request_intent_swap", "log_skip", "intents_cancel", "intents_settle", "freeze"];
/// Mainnet storage_balance_bounds for wrap.near and native USDC; Rhea account storage for 2 tokens, with margin.
const FT_STORAGE: u128 = NEAR / 800; // 0.00125
const EXCHANGE_STORAGE: u128 = NEAR / 50; // 0.02
/// Gas budget per owner (≈ 10 transactions at mainnet prices) and the agent account's own storage reserve.
// Prepaid gas is reserved at a pessimistic price (~0.1 NEAR per 100 Tgas); unspent gas comes back.
const OWNER_GAS: u128 = NEAR * 15 / 100; // 0.15
const AGENT_RESERVE: u128 = NEAR / 100; // 0.01
/// The vault's own state and the recovery key's storage, with margin.
const VAULT_STATE: u128 = NEAR / 20; // 0.05
const KEY_STORAGE: u128 = NEAR / 1000; // 0.001
/// The vault's withdraw_near keeps this much native NEAR above storage, so a smaller float never comes back.
const VAULT_NEAR_RESERVE: u128 = NEAR / 2;
/// An expected code hash that still says this is a placeholder (the reproducible build arrives with the 1 Nov tag).
fn placeholder(h: &str) -> bool { h.is_empty() || h.starts_with("REPLACE") || h.starts_with('<') }

fn fail(m: impl Into<String>) -> Box<dyn std::error::Error> { m.into().into() }
fn id(s: &str) -> AccountId { s.parse().unwrap() }

// ---------- pure plan builder (unit-tested) ----------

/// Exact human decimal → raw integer with `dec` decimals. Refuses more fractional digits than the token has.
fn to_raw(s: &str, dec: u32) -> Result<u128, String> {
    let s = s.trim();
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    if int.is_empty() && frac.is_empty() || !int.chars().chain(frac.chars()).all(|c| c.is_ascii_digit()) {
        return Err(format!("'{s}' is not a plain decimal"));
    }
    if frac.len() as u32 > dec { return Err(format!("'{s}' has more than {dec} decimals")); }
    let i: u128 = if int.is_empty() { 0 } else { int.parse().map_err(|_| format!("'{s}' too large"))? };
    let f: u128 = if frac.is_empty() { 0 } else { frac.parse::<u128>().unwrap() * 10u128.pow(dec - frac.len() as u32) };
    i.checked_mul(10u128.pow(dec)).and_then(|x| x.checked_add(f)).ok_or_else(|| format!("'{s}' too large"))
}

fn gcd(a: u128, b: u128) -> u128 { if b == 0 { a } else { gcd(b, a % b) } }

/// A human price (`out` units per 1 `in` unit) as the vault's raw band: floor_out_raw = ceil(in_raw * num / den).
fn price_band(p: &str, dec_in: u32, dec_out: u32) -> Result<(u128, u128), String> {
    let (_, frac) = p.trim().split_once('.').unwrap_or((p.trim(), ""));
    let digits = to_raw(p, frac.len() as u32)?;
    if digits == 0 { return Err(format!("price '{p}' must be above 0")); }
    let num = digits.checked_mul(10u128.pow(dec_out)).ok_or("price overflow")?;
    let den = 10u128.pow(frac.len() as u32).checked_mul(10u128.pow(dec_in)).ok_or("price overflow")?;
    let g = gcd(num, den);
    Ok((num / g, den / g))
}

fn implicit(a: &str) -> bool { a.len() == 64 && a.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }

fn account_ok(a: &str, network: &str) -> bool {
    if a.parse::<AccountId>().is_err() || a.starts_with('<') { return false; }
    match network { "mainnet" => !a.ends_with(".testnet") && (a.ends_with(".near") || implicit(a)), _ => a.ends_with(".testnet") || implicit(a) }
}

#[derive(Debug, Clone)]
struct Tx { signer: String, receiver: String, method: String, args: Value, deposit: u128, tgas: u64, note: String }

#[derive(Debug)]
struct EntryPlan {
    name: String, vault: String, owner: String, agent: String,
    policy: Value, deposit: u128, fund_base: u128, fund_quote: u128,
    owner_near: u128, owner_quote: u128, agent_near: u128, allowance: u128,
    /// The agent's recovery public key, if the config gives one (else generated at send).
    recovery_pk: Option<String>,
    /// NEAR spent for good (listing fee, state, registrations) vs NEAR that stays withdrawable or recoverable.
    locked_near: u128, recoverable_near: u128,
    txs: Vec<Tx>,
}

fn s<'a>(v: &'a Value, k: &str) -> Result<&'a str, String> { v[k].as_str().ok_or_else(|| format!("config: '{k}' missing")) }

/// The policy a Season 1 vault gets, built from the config; mirrors the contract's validate() rules. A staked entry
/// also gets the staking token and the base <-> staking-token pairs on `stake.pool_id` (a rated pool).
fn policy(cfg: &Value, staked: bool) -> Result<Value, String> {
    let (b, q) = (&cfg["tokens"]["base"], &cfg["tokens"]["quote"]);
    let (bd, qd) = (b["decimals"].as_u64().ok_or("base decimals")? as u32, q["decimals"].as_u64().ok_or("quote decimals")? as u32);
    let p = &cfg["policy"];
    let cap = |side: &str, k: &str, d: u32| -> Result<u128, String> { to_raw(s(&p[side], k)?, d) };
    let (bt, bday, qt, qday) = (cap("base", "max_per_trade", bd)?, cap("base", "max_per_day", bd)?, cap("quote", "max_per_trade", qd)?, cap("quote", "max_per_day", qd)?);
    for (t, d, n) in [(bt, bday, "base"), (qt, qday, "quote")] {
        if t == 0 || t > d { return Err(format!("policy: {n} per-trade cap must be >0 and <= the daily cap")); }
    }
    let rate = p["max_trades_per_hour"].as_u64().ok_or("max_trades_per_hour")?;
    let slip = p["max_slippage_bps"].as_u64().ok_or("max_slippage_bps")?;
    if !(1..=60).contains(&rate) { return Err("policy: 1-60 trades per hour".into()); }
    if slip > 500 { return Err("policy: slippage above 5%".into()); }
    let pool = cfg["pool_id"].as_u64().ok_or("pool_id")?;
    let (sn, sd) = price_band(s(p, "min_price_sell")?, bd, qd)?; // base -> quote: quote per base
    let (bn, bdn) = price_band(s(p, "min_price_buy")?, qd, bd)?; // quote -> base: base per quote
    // The vault computes amount_in * num in u128; prove the largest trade can't overflow.
    if bt.checked_mul(sn).is_none() || qt.checked_mul(bn).is_none() { return Err("policy: price band overflows at the cap".into()); }
    let (bid, qid) = (s(b, "id")?, s(q, "id")?);
    let mut out = json!({"tokens": [
            {"token": bid, "max_per_trade": bt.to_string(), "max_per_day": bday.to_string()},
            {"token": qid, "max_per_trade": qt.to_string(), "max_per_day": qday.to_string()}],
        "pairs": [{"token_in": bid, "token_out": qid, "pool_id": pool, "min_price_num": sn.to_string(), "min_price_den": sd.to_string()},
                  {"token_in": qid, "token_out": bid, "pool_id": pool, "min_price_num": bn.to_string(), "min_price_den": bdn.to_string()}],
        "max_trades_per_hour": rate, "max_slippage_bps": slip});
    if staked {
        let st = &cfg["stake"];
        let (sid, sdec) = (s(st, "id")?, st["decimals"].as_u64().ok_or("stake decimals")? as u32);
        let spool = st["pool_id"].as_u64().ok_or("stake.pool_id")?;
        let (stt, stday) = (to_raw(s(st, "max_per_trade")?, sdec)?, to_raw(s(st, "max_per_day")?, sdec)?);
        if stt == 0 || stt > stday { return Err("policy: stake per-trade cap must be >0 and <= the daily cap".into()); }
        let (in_n, in_d) = price_band(s(st, "min_price_stake")?, bd, sdec)?; // base -> stake: stake per base
        let (out_n, out_d) = price_band(s(st, "min_price_unstake")?, sdec, bd)?; // stake -> base: base per stake
        if bt.checked_mul(in_n).is_none() || stt.checked_mul(out_n).is_none() { return Err("policy: stake band overflows at the cap".into()); }
        out["tokens"].as_array_mut().unwrap().push(json!({"token": sid, "max_per_trade": stt.to_string(), "max_per_day": stday.to_string()}));
        let pairs = out["pairs"].as_array_mut().unwrap();
        pairs.push(json!({"token_in": bid, "token_out": sid, "pool_id": spool, "min_price_num": in_n.to_string(), "min_price_den": in_d.to_string()}));
        pairs.push(json!({"token_in": sid, "token_out": bid, "pool_id": spool, "min_price_num": out_n.to_string(), "min_price_den": out_d.to_string()}));
    }
    Ok(out)
}

/// Validates the whole config (separation, accounts, deposits, policy) and builds each entry's transactions.
/// `bounds` is the factory's (min, max) deposit when known (read from the chain), else 0.1-10 NEAR.
/// Funding transfers above the factory's deposit caps (a capped vault would keep only the cap and send the rest back,
/// or refuse a token without a cap). Empty caps = uncapped.
fn over_caps(e: &EntryPlan, caps: &Value) -> Vec<String> {
    let caps = caps.as_array().cloned().unwrap_or_default();
    if caps.is_empty() { return vec![]; }
    e.txs.iter().filter(|t| t.method == "ft_transfer_call").filter_map(|t| {
        let amount = t.args["amount"].as_str().and_then(|a| a.parse::<u128>().ok()).unwrap_or(u128::MAX);
        let max = caps.iter().find(|c| c["token"] == t.receiver.as_str()).and_then(|c| c["max"].as_str()?.parse::<u128>().ok()).unwrap_or(0);
        (amount > max).then(|| format!("{}: funds {amount} of {} but the factory's deposit cap is {max}", e.name, t.receiver))
    }).collect()
}

fn build_plan(cfg: &Value, bounds: Option<(u128, u128)>) -> Result<Vec<EntryPlan>, String> {
    let net = s(cfg, "network")?;
    let factory = s(cfg, "factory")?;
    let parent = factory.split_once('.').map(|x| x.1).unwrap_or("");
    let exchange = s(cfg, "exchange")?;
    let (b, q) = (&cfg["tokens"]["base"], &cfg["tokens"]["quote"]);
    let (bid, qid) = (s(b, "id")?, s(q, "id")?);
    let (bd, qd) = (b["decimals"].as_u64().ok_or("base decimals")? as u32, q["decimals"].as_u64().ok_or("quote decimals")? as u32);
    let allowance = to_raw(s(&cfg["agent"], "allowance_near")?, 24)?;
    let agent_bal = to_raw(s(&cfg["agent"], "balance_near")?, 24)?;
    // near-api-js checks the allowance against the worst-case gas price (~0.3 NEAR for a 300 Tgas call), so the
    // allowance must cover at least that, and the account must hold the allowance plus its own storage.
    if allowance < 35 * NEAR / 100 { return Err("agent.allowance_near below 0.35: too close to the ~0.3 NEAR a 300 Tgas call reserves (the runner warns below 0.35)".into()); }
    if agent_bal < allowance + AGENT_RESERVE + KEY_STORAGE { return Err("agent.balance_near must cover the allowance plus 0.011 NEAR storage (account + recovery key)".into()); }
    let (min, max) = bounds.unwrap_or((NEAR / 10, 10 * NEAR));
    let entries = cfg["entries"].as_array().ok_or("config: entries")?;
    let mut seen: HashMap<String, String> = HashMap::new();
    let mut vaults = HashSet::new();
    for e in entries { vaults.insert(format!("{}.{factory}", s(e, "name")?)); }
    let mut out = vec![];
    for e in entries {
        let name = s(e, "name")?.to_string();
        if !(2..=32).contains(&name.len()) || name.starts_with('-') || name.ends_with('-')
            || !name.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') {
            return Err(format!("{name}: vault name must be 2-32 of a-z, 0-9 and inner '-'"));
        }
        let (owner, agent) = (s(e, "owner")?.to_string(), s(e, "agent")?.to_string());
        for (role, a) in [("owner", &owner), ("agent", &agent)] {
            if !account_ok(a, net) { return Err(format!("{name}: {role} '{a}' is not a {net} account (fill the placeholder)")); }
            if a == factory || a == parent || vaults.contains(a.as_str()) {
                return Err(format!("{name}: {role} '{a}' is the factory, its parent or a vault"));
            }
            if let Some(prev) = seen.insert(a.clone(), format!("{name} ({role})")) {
                return Err(format!("separation: '{a}' is used by {prev} and {name} ({role}); every entry needs its own accounts"));
            }
        }
        let vault = format!("{name}.{factory}");
        if vault.len() > 64 { return Err(format!("{name}: '{vault}' is longer than 64 characters")); }
        let recovery_pk = match e["recovery_public_key"].as_str() {
            None => None,
            Some(k) if k.starts_with("ed25519:") && k.len() > 40 && k.parse::<near_api::PublicKey>().is_ok() => Some(k.to_string()),
            Some(k) => return Err(format!("{name}: recovery_public_key '{k}' is not an ed25519 public key")),
        };
        let staked = e["stake"].as_bool().unwrap_or(false);
        let pol = policy(cfg, staked)?;
        let deposit = to_raw(s(e, "deposit_near")?, 24)?;
        if deposit < min || deposit > max { return Err(format!("{name}: deposit outside the factory's bounds")); }
        let (fb, fq) = (to_raw(s(&e["fund"], "base")?, bd)?, to_raw(s(&e["fund"], "quote")?, qd)?);
        let t = |signer: &str, receiver: &str, method: &str, args: Value, deposit: u128, tgas: u64, note: &str| Tx {
            signer: signer.into(), receiver: receiver.into(), method: method.into(), args, deposit, tgas, note: note.into() };
        let mut txs = vec![
            t(&owner, factory, "create_vault", json!({"name": name, "owner_id": owner, "agent_id": agent, "policy": pol}), deposit, 150,
              "creates the vault (0 keys, pinned code); the deposit becomes its NEAR balance"),
            t(&owner, bid, "storage_deposit", json!({"account_id": vault, "registration_only": true}), FT_STORAGE, 30, "vault registered on the base token"),
            t(&owner, qid, "storage_deposit", json!({"account_id": vault, "registration_only": true}), FT_STORAGE, 30, "vault registered on the quote token"),
            t(&owner, &vault, "exchange_storage_deposit", json!({}), EXCHANGE_STORAGE, 50, &format!("vault storage on {exchange}")),
        ];
        if staked {
            txs.push(t(&owner, s(&cfg["stake"], "id")?, "storage_deposit", json!({"account_id": vault, "registration_only": true}), FT_STORAGE, 30,
                "vault registered on the staking token"));
        }
        txs.push(t(&owner, &vault, "exchange_register_tokens", json!({}), 1, 50, "register the policy's tokens on the exchange"));
        if fb > 0 {
            txs.push(t(&owner, bid, "storage_deposit", json!({"account_id": owner, "registration_only": true}), FT_STORAGE, 30, "owner registered on the base token (skipped if already)"));
            txs.push(t(&owner, bid, "near_deposit", json!({}), fb, 30, "wrap the owner's NEAR"));
            txs.push(t(&owner, bid, "ft_transfer_call", json!({"receiver_id": vault, "amount": fb.to_string(), "msg": ""}), 1, 100, "fund the vault (base)"));
        }
        if fq > 0 {
            txs.push(t(&owner, qid, "ft_transfer_call", json!({"receiver_id": vault, "amount": fq.to_string(), "msg": ""}), 1, 100, "fund the vault (quote; the owner must already hold it)"));
        }
        txs.push(t(&agent, &agent, "add_key(function-call)", json!({"receiver_id": vault, "method_names": AGENT_METHODS, "allowance": allowance.to_string()}), 0, 0,
            "the agent software's only key: this vault, the agent methods, a finite allowance"));
        txs.push(t(&agent, &agent, "add_key(recovery)", json!({"public_key": recovery_pk.clone().unwrap_or_else(|| "generated at send; file to move offline".into())}), 0, 0,
            "a full-access RECOVERY key John holds offline: the agent's NEAR stays recoverable"));
        txs.push(t(&agent, &agent, "delete_key(setup)", json!({}), 0, 0, "every other full-access key goes; the recovery key stays"));
        let registrations = if staked { 3 } else { 2 } * FT_STORAGE + EXCHANGE_STORAGE;
        let owner_near = deposit + registrations + if fb > 0 { FT_STORAGE + fb } else { 0 } + OWNER_GAS;
        // Spent for good: the listing fee, the vault's state, the registrations, and the vault's native NEAR up to
        // withdraw_near's reserve. Recoverable: native NEAR above that reserve, the trading funds (owner withdraw) and
        // the agent's balance (recovery key).
        let native = deposit.saturating_sub(NEAR / 100 + VAULT_STATE);
        let native_back = native.saturating_sub(VAULT_NEAR_RESERVE);
        let locked_near = NEAR / 100 + VAULT_STATE + registrations + if fb > 0 { FT_STORAGE } else { 0 } + (native - native_back);
        let recoverable_near = native_back + fb + agent_bal;
        out.push(EntryPlan { name, vault, owner, agent, policy: pol.clone(), deposit, fund_base: fb, fund_quote: fq,
            owner_near, owner_quote: fq, agent_near: agent_bal, allowance, recovery_pk, locked_near, recoverable_near, txs });
    }
    if out.is_empty() { return Err("config: no entries".into()); }
    Ok(out)
}

/// Send only when the chain matches the config and the confirmation names this entry.
fn may_send(cfg_net: &str, chain: &str, entry: Option<&str>, confirm: Option<&str>) -> Result<bool, String> {
    let (Some(e), Some(c)) = (entry, confirm) else { return Ok(false) };
    if c != e { return Err(format!("SLEDGIT_MAINNET_CONFIRM={c} doesn't name the entry {e}")); }
    if chain != cfg_net { return Err(format!("the RPC reports chain '{chain}' but the config is for '{cfg_net}'")); }
    Ok(true)
}

fn near_s(y: u128) -> String { format!("{:.5}", y as f64 / 1e24) }
fn units(y: u128, d: u32) -> String { format!("{}", y as f64 / 10f64.powi(d as i32)) }

// ---------- chain access ----------

struct Chain { net: NetworkConfig, rpc: String }

fn unknown_account(v: &Value) -> bool {
    v["error"]["cause"]["name"] == "UNKNOWN_ACCOUNT" || v["error"]["data"].as_str().is_some_and(|d| d.contains("does not exist"))
}

impl Chain {
    async fn rpc(&self, method: &str, params: Value) -> R<Value> {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).to_string();
        let out = std::process::Command::new("curl").args(["-s", "-m", "20", "-H", "content-type: application/json", "-d", &body, &self.rpc]).output()?;
        Ok(serde_json::from_slice(&out.stdout)?)
    }
    async fn chain_id(&self) -> R<String> {
        self.rpc("status", json!([])).await?["result"]["chain_id"].as_str().map(String::from).ok_or_else(|| fail("RPC status has no chain_id"))
    }
    /// None only for UNKNOWN_ACCOUNT; any other RPC error fails closed (final review 2 F2-08).
    async fn account(&self, a: &str) -> R<Option<Value>> {
        let v = self.rpc("query", json!({"request_type": "view_account", "finality": "final", "account_id": a})).await?;
        if let Some(r) = v.get("result") { return Ok(Some(r.clone())); }
        if unknown_account(&v) { return Ok(None); }
        Err(fail(format!("view_account {a}: {}", v["error"])))
    }
    /// An account that doesn't exist has no keys; any other RPC error fails closed (never "0 keys").
    async fn keys(&self, a: &str) -> R<Vec<Value>> {
        let v = self.rpc("query", json!({"request_type": "view_access_key_list", "finality": "final", "account_id": a})).await?;
        if let Some(k) = v["result"]["keys"].as_array() { return Ok(k.clone()); }
        if unknown_account(&v) { return Ok(vec![]); }
        Err(fail(format!("view_access_key_list {a}: {}", v["error"])))
    }
    async fn view(&self, c: &str, m: &str, args: Value) -> R<Value> {
        use near_sdk::base64::Engine;
        let a = near_sdk::base64::engine::general_purpose::STANDARD.encode(args.to_string());
        let v = self.rpc("query", json!({"request_type": "call_function", "finality": "final", "account_id": c, "method_name": m, "args_base64": a})).await?;
        let bytes: Vec<u8> = v["result"]["result"].as_array().ok_or_else(|| fail(format!("{c}.{m}: {}", v["error"])))?
            .iter().map(|x| x.as_u64().unwrap_or(0) as u8).collect();
        Ok(serde_json::from_slice(&bytes)?)
    }
    async fn free(&self, a: &str) -> R<u128> {
        let Some(acc) = self.account(a).await? else { return Ok(0) };
        let amount: u128 = acc["amount"].as_str().unwrap_or("0").parse()?;
        let locked = acc["storage_usage"].as_u64().unwrap_or(0) as u128 * NEAR / 100_000;
        Ok(amount.saturating_sub(locked))
    }
    async fn ft(&self, token: &str, a: &str) -> R<u128> {
        Ok(self.view(token, "ft_balance_of", json!({"account_id": a})).await?.as_str().unwrap_or("0").parse()?)
    }
}

/// Account -> signer from `<network>-*.json` key files that list it (never printed). Refuses group/world-readable files.
fn load_keys(network: &str) -> R<HashMap<String, Arc<Signer>>> {
    let dir = std::env::var("IT_KEY_DIR").map(std::path::PathBuf::from)
        .unwrap_or(local::key_dir()?);
    let mut keys = HashMap::new();
    let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(keys) };
    for e in rd {
        let p = e?.path();
        let n = p.file_name().unwrap().to_string_lossy().to_string();
        if !n.starts_with(&format!("{network}-")) || !n.ends_with(".json") { continue; }
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&p)?.permissions().mode();
            if mode & 0o077 != 0 { return Err(fail(format!("{} is readable by other users (mode {:o}): chmod 600 it", p.display(), mode & 0o777))); }
        }
        let d: Value = serde_json::from_str(&std::fs::read_to_string(&p)?)?;
        // Agent function-call key files (written by this tool) never sign setup steps: the agent's full-access key does.
        if d["permission"] == "function-call" { continue; }
        if let (Some(sk), Some(accts)) = (d["secret_key"].as_str(), d["accounts"].as_array()) {
            for a in accts { if let Some(a) = a.as_str() { keys.insert(a.to_string(), Signer::from_secret_key(sk.parse()?)?); } }
        }
    }
    Ok(keys)
}

fn txh(r: &TransactionResult) -> String {
    r.clone().into_full().and_then(|f| f.outcomes().first().map(|o| o.transaction_hash.to_string())).unwrap_or_default()
}
fn done(r: TransactionResult, what: &str) -> R<String> {
    let h = txh(&r);
    r.into_result().map_err(|e| fail(format!("{what} failed ({h}): {e:?}")))?;
    Ok(h)
}

/// A function-call key for exactly this vault, the agent methods and a finite allowance.
fn scoped(k: &Value, vault: &str) -> bool {
    let fc = &k["access_key"]["permission"]["FunctionCall"];
    let mut m: Vec<&str> = fc["method_names"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default();
    let mut want = AGENT_METHODS.to_vec(); m.sort(); want.sort();
    fc["receiver_id"] == vault && !fc["allowance"].is_null() && m == want
}
fn full_access(k: &Value) -> bool { k["access_key"]["permission"] == "FullAccess" }

/// The agent account's end state: exactly one scoped function-call key (the agent software's) and exactly one
/// full-access key, the recovery key (its public key must match when known), and nothing else.
fn agent_done(keys: &[Value], vault: &str, recovery: Option<&str>) -> bool {
    let fcs = keys.iter().filter(|k| scoped(k, vault)).count();
    let fas: Vec<&Value> = keys.iter().filter(|k| full_access(k)).collect();
    keys.len() == 2 && fcs == 1 && fas.len() == 1 && recovery.is_none_or(|r| fas[0]["public_key"] == r)
}

/// The agent's recovery public key: the config's, or a generated one kept in a 0600 file to move offline (reused on resume).
async fn recovery_key(netname: &str, e: &EntryPlan) -> R<(String, Option<std::path::PathBuf>)> {
    if let Some(pk) = &e.recovery_pk { return Ok((pk.clone(), None)); }
    let kpath = local::key_dir()?.join(format!("RECOVERY-{netname}-agent-{}.json", e.name));
    let sk: near_api::SecretKey = if kpath.exists() {
        let d: Value = serde_json::from_str(&std::fs::read_to_string(&kpath)?)?;
        if d["account_id"] != e.agent.as_str() { return Err(fail(format!("{} is for another account", kpath.display()))); }
        d["secret_key"].as_str().ok_or_else(|| fail("recovery file has no secret_key"))?.parse()?
    } else {
        let sk = near_api::signer::generate_secret_key()?;
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&kpath)
            .map_err(|x| fail(format!("{} not written ({x}); never replaced", kpath.display())))?;
        f.write_all(json!({"network": netname, "secret_key": sk.to_string(), "account_id": e.agent, "role": "RECOVERY (full access): move this file OFFLINE, then delete it here"}).to_string().as_bytes())?;
        sk
    };
    Ok((Signer::from_secret_key(sk)?.get_public_key().await?.to_string(), Some(kpath)))
}

#[tokio::main]
async fn main() -> R {
    let path = std::env::var("IT_SEASON_CONFIG").unwrap_or_else(|_| "deploy/mainnet/season1.json".into());
    let cfg: Value = serde_json::from_str(&std::fs::read_to_string(&path).map_err(|e| fail(format!("{path}: {e}")))?)?;
    let netname = s(&cfg, "network")?.to_string();
    let rpc = std::env::var("IT_RPC").unwrap_or_else(|_| if netname == "mainnet" { "https://free.rpc.fastnear.com".into() } else { "https://rpc.testnet.fastnear.com".into() });
    let chain = Chain { net: NetworkConfig::from_rpc_url(if netname == "mainnet" { "mainnet" } else { "testnet" }, rpc.parse()?), rpc };
    let chain_id = chain.chain_id().await?;
    let host = s(&cfg, "factory")?.to_string();
    let expect = s(&cfg, "expect_vault_code_hash")?.to_string();
    println!("Season 1 plan: {path} (config network {netname}, RPC chain {chain_id}, factory {host})");

    // Read-only checks that don't depend on entries. Problems that mention "blocking" stop every send.
    let mut problems: Vec<String> = vec![];
    let mut bounds = None;
    let mut factory_caps = json!([]);
    if placeholder(&expect) { problems.push(format!("blocking: expect_vault_code_hash is a placeholder ({expect}); set the reproducible-build hash (1 Nov tag)")); }
        match chain.account(&host).await? {
            None => problems.push(format!("factory {host} doesn't exist yet (expected before the deploy-and-lock run)")),
            Some(_) => {
                let keys = chain.keys(&host).await?.len();
                if keys != 0 { problems.push(format!("factory {host} still has {keys} access key(s): not locked")); }
                match chain.view(&host, "get_config", json!({})).await {
                    Ok(fc) => {
                        if fc["code_hash"] != expect.as_str() { problems.push(format!("factory pins vault code {} but the config expects {expect}", fc["code_hash"])); }
                        for (k, ck) in [("exchange_id", "exchange"), ("intents_id", "intents"), ("mpc_id", "mpc")] {
                            match cfg[ck].as_str() {
                                Some(w) if fc[k] == w => {}
                                Some(w) => problems.push(format!("factory {k} is {} but the config expects {w}", fc[k])),
                                None => problems.push(format!("config has no {ck} to check the factory's {k} against")),
                            }
                        }
                        if let (Some(a), Some(b)) = (fc["min_deposit"].as_str(), fc["max_deposit"].as_str()) { bounds = Some((a.parse()?, b.parse()?)); }
                        factory_caps = fc["deposit_caps"].clone();
                    }
                    Err(e) => problems.push(format!("factory get_config: {e}")),
                }
            }
        }
    let (b, q) = (&cfg["tokens"]["base"], &cfg["tokens"]["quote"]);
    for t in [b, q] {
        match chain.view(s(t, "id")?, "ft_metadata", json!({})).await {
            Ok(m) if m["decimals"] == t["decimals"] => {}
            Ok(m) => return Err(fail(format!("{} has {} decimals on chain, the config says {}", s(t, "id")?, m["decimals"], t["decimals"]))),
            Err(e) => problems.push(format!("{} ft_metadata: {e}", s(t, "id")?)),
        }
    }
    let pool = chain.view(s(&cfg, "exchange")?, "get_pool", json!({"pool_id": cfg["pool_id"]})).await;
    match &pool {
        Ok(p) => {
            let ids: Vec<&str> = p["token_account_ids"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default();
            if !(ids.contains(&s(b, "id")?) && ids.contains(&s(q, "id")?)) { return Err(fail(format!("pool {} trades {ids:?}, not the config's pair", cfg["pool_id"]))); }
        }
        Err(e) => problems.push(format!("pool {}: {e}", cfg["pool_id"])),
    }
    // Staked entries: the staking token's decimals and its pool with base, as the config says.
    if cfg["entries"].as_array().is_some_and(|es| es.iter().any(|e| e["stake"] == true)) {
        let st = &cfg["stake"];
        match chain.view(s(st, "id")?, "ft_metadata", json!({})).await {
            Ok(m) if m["decimals"] == st["decimals"] => {}
            Ok(m) => return Err(fail(format!("{} has {} decimals on chain, the config says {}", s(st, "id")?, m["decimals"], st["decimals"]))),
            Err(e) => problems.push(format!("{} ft_metadata: {e}", s(st, "id")?)),
        }
        match chain.view(s(&cfg, "exchange")?, "get_pool", json!({"pool_id": st["pool_id"]})).await {
            Ok(p) => {
                let ids: Vec<&str> = p["token_account_ids"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default();
                if !(ids.contains(&s(b, "id")?) && ids.contains(&s(st, "id")?)) { return Err(fail(format!("stake pool {} trades {ids:?}, not base and the staking token", st["pool_id"]))); }
            }
            Err(e) => problems.push(format!("stake pool {}: {e}", st["pool_id"])),
        }
    }

    let plan = build_plan(&cfg, bounds).map_err(fail)?;
    for e in &plan { problems.extend(over_caps(e, &factory_caps).into_iter().map(|m| format!("blocking: {m}"))); }
    let (bd, qd) = (b["decimals"].as_u64().unwrap() as u32, q["decimals"].as_u64().unwrap() as u32);
    let (bs, qs) = (s(b, "symbol")?, s(q, "symbol")?);

    // Keys shared between entries: separation of control, reported (ids are already refused above).
    let mut key_owner: HashMap<String, String> = HashMap::new();
    for e in &plan {
        for (role, a) in [("owner", &e.owner), ("agent", &e.agent)] {
            for k in chain.keys(a).await? {
                let pk = k["public_key"].as_str().unwrap_or("").to_string();
                if let Some(prev) = key_owner.insert(pk.clone(), format!("{} {role} {a}", e.name))
                    && !prev.starts_with(&format!("{} ", e.name)) {
                    problems.push(format!("public key shared by {prev} and {} {role} {a}", e.name));
                }
            }
        }
    }

    let (mut tot_owner, mut tot_quote, mut tot_agent, mut tot_locked, mut tot_back) = (0u128, 0u128, 0u128, 0u128, 0u128);
    for e in &plan {
        println!("\n== {} -> {}", e.name, e.vault);
        println!("   owner {} must hold {} NEAR free + {} {qs}; agent {} must hold {} NEAR (allowance {} NEAR); recovery key {}",
            e.owner, near_s(e.owner_near), units(e.owner_quote, qd), e.agent, near_s(e.agent_near), near_s(e.allowance),
            e.recovery_pk.as_deref().unwrap_or("generated at send (file to move offline)"));
        println!("   spent for good {} NEAR; recoverable {} NEAR + {} {qs} (trading funds, agent balance)",
            near_s(e.locked_near), near_s(e.recoverable_near), units(e.fund_quote, qd));
        let (ofree, afree) = (chain.free(&e.owner).await?, chain.free(&e.agent).await?);
        let vault_exists = chain.account(&e.vault).await?.is_some();
        let owner_q = if chain.account(&e.owner).await?.is_some() { chain.ft(s(q, "id")?, &e.owner).await.unwrap_or(0) } else { 0 };
        println!("   on chain: owner {} NEAR free, {} {qs}; agent {} NEAR free; vault {}",
            near_s(ofree), units(owner_q, qd), near_s(afree), if vault_exists { "exists" } else { "not created" });
        if !vault_exists {
            if ofree < e.owner_near { problems.push(format!("{}: owner {} holds {} NEAR free, needs {}", e.name, e.owner, near_s(ofree), near_s(e.owner_near))); }
            if owner_q < e.owner_quote { problems.push(format!("{}: owner {} holds {} {qs}, needs {}", e.name, e.owner, units(owner_q, qd), units(e.owner_quote, qd))); }
        }
        let akeys = chain.keys(&e.agent).await?;
        if afree < e.agent_near && !akeys.iter().any(|k| scoped(k, &e.vault)) {
            problems.push(format!("{}: agent {} holds {} NEAR free, needs {}", e.name, e.agent, near_s(afree), near_s(e.agent_near)));
        }
        for (i, t) in e.txs.iter().enumerate() {
            let dep = if t.deposit == 0 { String::new() } else if t.deposit == 1 { " 1 yocto".into() } else { format!(" {} NEAR", near_s(t.deposit)) };
            let gas = if t.tgas == 0 { String::new() } else { format!(", {} Tgas", t.tgas) };
            println!("   tx {}: {} -> {}.{}{dep}{gas}: {}", i + 1, t.signer, t.receiver, t.method, t.note);
        }
        println!("   funds the vault with {} {bs} + {} {qs}", units(e.fund_base, bd), units(e.fund_quote, qd));
        tot_owner += e.owner_near; tot_quote += e.owner_quote; tot_agent += e.agent_near;
        tot_locked += e.locked_near; tot_back += e.recoverable_near;
    }
    println!("\nTotals for {} entries: owners {} NEAR + {} {qs}; agents {} NEAR; all {} NEAR + {} {qs}",
        plan.len(), near_s(tot_owner), units(tot_quote, qd), near_s(tot_agent), near_s(tot_owner + tot_agent), units(tot_quote, qd));
    println!("Of that: spent for good {} NEAR; recoverable {} NEAR + {} {qs} (minus trading results)", near_s(tot_locked), near_s(tot_back), units(tot_quote, qd));
    if let Ok(p) = &pool {
        let a = p["amounts"].as_array().cloned().unwrap_or_default();
        let ids: Vec<&str> = p["token_account_ids"].as_array().map(|x| x.iter().filter_map(|y| y.as_str()).collect()).unwrap_or_default();
        let ib = ids.iter().position(|x| *x == s(b, "id").unwrap()).unwrap_or(0);
        let (rb, rq): (f64, f64) = (a[ib].as_str().unwrap_or("0").parse()?, a[1 - ib].as_str().unwrap_or("0").parse()?);
        let px = (rq / 10f64.powi(qd as i32)) / (rb / 10f64.powi(bd as i32));
        let usd = (tot_owner + tot_agent) as f64 / 1e24 * px + tot_quote as f64 / 10f64.powi(qd as i32);
        let spent = tot_locked as f64 / 1e24 * px;
        println!("At the pool price ({px:.3} {qs}/{bs}): about ${usd:.0} in all, of which about ${spent:.0} is spent for good");
    }
    for p in &problems { println!("CHECK: {p}"); }

    let entry = std::env::var("IT_ENTRY").ok();
    let confirm = local::mainnet_confirm();
    if !may_send(&netname, &chain_id, entry.as_deref(), confirm.as_deref()).map_err(fail)? {
        println!("\nPLAN only. To send one entry: IT_ENTRY=<name> SLEDGIT_MAINNET_CONFIRM=<name>.");
        return Ok(());
    }
    let e = plan.iter().find(|p| Some(p.name.as_str()) == entry.as_deref()).ok_or_else(|| fail("IT_ENTRY isn't in the config"))?;
    let blocking: Vec<&String> = problems.iter().filter(|p| p.starts_with("blocking") || p.contains("factory") || p.contains(&e.name) || p.contains("shared")).collect();
    if !blocking.is_empty() { return Err(fail(format!("refusing to send {}: {blocking:?}", e.name))); }
    let keys = load_keys(&netname)?;
    let osig = keys.get(&e.owner).ok_or_else(|| fail(format!("no key file lists the owner {}", e.owner)))?.clone();
    let (rpk, rfile) = recovery_key(&netname, e).await?;
    let mut sent = vec![];
    for t in &e.txs {
        // Skip what the chain already shows as done, so a rerun never pays twice.
        let akeys = chain.keys(&e.agent).await?;
        let skip = match t.method.as_str() {
            "create_vault" => match chain.account(&e.vault).await? {
                None => false,
                // A vault with this name exists: only ours if owner, agent, policy, code and keylessness all match (F2-07).
                Some(acc) => {
                    let vc = chain.view(&e.vault, "get_config", json!({})).await?;
                    let vp = chain.view(&e.vault, "get_policy", json!({})).await?;
                    let vk = chain.keys(&e.vault).await?.len();
                    let code_ok = acc["global_contract_hash"] == expect.as_str();
                    if vc["owner_id"] != e.owner.as_str() || vc["agent_id"] != e.agent.as_str() || vp != e.policy || vk != 0 || !code_ok {
                        return Err(fail(format!("{} already exists but isn't this entry's (owner {}, agent {}, policy {}, keys {vk}, code {}): refusing",
                            e.vault, vc["owner_id"], vc["agent_id"], if vp == e.policy { "same" } else { "different" }, acc["global_contract_hash"])));
                    }
                    true
                }
            },
            "storage_deposit" => !chain.view(&t.receiver, "storage_balance_of", json!({"account_id": t.args["account_id"]})).await?.is_null(),
            "exchange_storage_deposit" | "exchange_register_tokens" => chain.view(s(&cfg, "exchange")?, "get_deposits", json!({"account_id": e.vault})).await
                .map(|d| d.as_object().map(|o| o.len() >= 2).unwrap_or(false)).unwrap_or(false),
            // Skip when the vault is funded or the owner already holds the wrapped base (a rerun after a failed fund).
            "near_deposit" => chain.ft(&t.receiver, &e.vault).await? >= e.fund_base || chain.ft(&t.receiver, &t.signer).await? >= e.fund_base,
            "ft_transfer_call" => chain.ft(&t.receiver, &e.vault).await? >= t.args["amount"].as_str().unwrap_or("0").parse::<u128>()?,
            "add_key(function-call)" => akeys.iter().any(|k| scoped(k, &e.vault)),
            "add_key(recovery)" => akeys.iter().any(|k| full_access(k) && k["public_key"] == rpk.as_str()),
            "delete_key(setup)" => agent_done(&akeys, &e.vault, Some(&rpk)),
            _ => false,
        };
        if skip { println!("   skip {}.{} (already done on chain)", t.receiver, t.method); continue; }
        let h = match t.method.as_str() {
            "add_key(function-call)" => {
                let asig = keys.get(&e.agent).ok_or_else(|| fail(format!("no key file lists the agent {} (its setup key)", e.agent)))?.clone();
                let kdir = local::key_dir()?;
                let kpath = kdir.join(format!("{netname}-agent-{}.json", e.name));
                // Resume: a key file from an interrupted run is reused (never replaced), so a rerun adds the same key.
                let sk = if kpath.exists() {
                    let d: Value = serde_json::from_str(&std::fs::read_to_string(&kpath)?)?;
                    if d["account_id"] != e.agent.as_str() || d["vault"] != e.vault.as_str() { return Err(fail(format!("{} is for another agent or vault", kpath.display()))); }
                    println!("   reusing the agent key in {} (interrupted run)", kpath.display());
                    d["secret_key"].as_str().ok_or_else(|| fail("key file has no secret_key"))?.parse()?
                } else { near_api::signer::generate_secret_key()? };
                let pk = Signer::from_secret_key(sk.clone())?.get_public_key().await?;
                if !kpath.exists() {
                    use std::io::Write;
                    use std::os::unix::fs::OpenOptionsExt;
                    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&kpath)
                        .map_err(|x| fail(format!("{} not written ({x}); never replaced", kpath.display())))?;
                    f.write_all(json!({"network": netname, "secret_key": sk.to_string(), "account_id": e.agent, "accounts": [e.agent],
                        "vault": e.vault, "permission": "function-call"}).to_string().as_bytes())?;
                }
                let perm = AccessKeyPermission::FunctionCall(FunctionCallPermission {
                    allowance: Some(NearToken::from_yoctonear(e.allowance)), receiver_id: e.vault.clone(),
                    method_names: AGENT_METHODS.iter().map(|m| m.to_string()).collect() });
                done(near_api::Account(id(&e.agent)).add_key(perm, pk).with_signer(asig).send_to(&chain.net).await?, "add agent key")?
            }
            "add_key(recovery)" => {
                let asig = keys.get(&e.agent).ok_or_else(|| fail(format!("no key file lists the agent {} (its setup key)", e.agent)))?.clone();
                let pk: near_api::PublicKey = rpk.parse()?;
                done(near_api::Account(id(&e.agent)).add_key(AccessKeyPermission::FullAccess, pk).with_signer(asig).send_to(&chain.net).await?, "add recovery key")?
            }
            "delete_key(setup)" => {
                let asig = keys.get(&e.agent).ok_or_else(|| fail(format!("no key file lists the agent {}", e.agent)))?.clone();
                let mine = asig.get_public_key().await?.to_string();
                if !chain.keys(&e.agent).await?.iter().any(|k| full_access(k) && k["public_key"] == rpk.as_str()) {
                    return Err(fail("the recovery key isn't on the agent account: refusing to delete the setup key"));
                }
                let mut last = String::new();
                // Every full-access key except the recovery key goes; the signing key last, so the run can always finish.
                let mut full: Vec<String> = chain.keys(&e.agent).await?.into_iter()
                    .filter(|k| full_access(k) && k["public_key"] != rpk.as_str()).filter_map(|k| k["public_key"].as_str().map(String::from)).collect();
                full.sort_by_key(|k| *k == mine);
                for k in full {
                    let pk: near_api::PublicKey = k.parse()?;
                    last = done(near_api::Account(id(&e.agent)).delete_key(pk).with_signer(asig.clone()).send_to(&chain.net).await?, "delete agent setup key")?;
                }
                last
            }
            _ => done(near_api::Contract(id(&t.receiver)).call_function(&t.method, t.args.clone()).transaction()
                .gas(NearGas::from_tgas(t.tgas)).deposit(NearToken::from_yoctonear(t.deposit))
                .with_signer(id(&t.signer), osig.clone()).send_to(&chain.net).await?, &format!("{}.{}", t.receiver, t.method))?,
        };
        println!("   sent {}.{}: {h}", t.receiver, t.method);
        sent.push(json!({"step": format!("{}.{}", t.receiver, t.method), "tx": h}));
    }
    // Verify the result independently.
    let vacc = chain.account(&e.vault).await?.ok_or_else(|| fail("vault missing after the run"))?;
    let vkeys = chain.keys(&e.vault).await?.len();
    let vcfg = chain.view(&e.vault, "get_config", json!({})).await?;
    let code_ok = vacc["global_contract_hash"] == expect.as_str();
    let bound_ok = [("exchange_id", "exchange"), ("intents_id", "intents"), ("mpc_id", "mpc")].iter().all(|(k, ck)| cfg[*ck].as_str().is_some_and(|w| vcfg[*k] == w));
    let pv = chain.view(&e.vault, "preview_swap", json!({"token_in": s(b, "id")?, "token_out": s(q, "id")?, "amount_in": "1", "min_amount_out": "1"})).await?;
    let agent_ok = agent_done(&chain.keys(&e.agent).await?, &e.vault, Some(&rpk));
    let roles_ok = vcfg["owner_id"] == e.owner && vcfg["agent_id"] == e.agent;
    // Funding really arrived (a cap or a refusal would leave the transaction successful but the vault short).
    let mut funded_ok = true;
    for t in e.txs.iter().filter(|t| t.method == "ft_transfer_call") {
        let want = t.args["amount"].as_str().unwrap_or("0").parse::<u128>()?;
        if chain.ft(&t.receiver, &e.vault).await? < want { funded_ok = false; }
    }
    let ok = vkeys == 0 && code_ok && bound_ok && roles_ok && pv["ok"].is_boolean() && agent_ok && funded_ok;
    println!("   verify: vault keys {vkeys}, code {}, exchange/intents/mpc {}, owner/agent {}, preview answers {}, agent keys (1 scoped + recovery) {}, funded {}",
        code_ok, bound_ok, roles_ok, pv["ok"].is_boolean(), agent_ok, funded_ok);
    if !ok { return Err(fail("post-check failed")); }
    if let Some(f) = &rfile { println!("   RECOVERY key for {}: {} -> MOVE IT OFFLINE now, then delete it from this Mac.", e.agent, f.display()); }
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs();
    let dir = format!("{}/../../deploy/{netname}", env!("CARGO_MANIFEST_DIR"));
    std::fs::create_dir_all(&dir)?;
    let out = format!("{dir}/season1-{}-{ts}.json", e.name);
    std::fs::write(&out, serde_json::to_string_pretty(&json!({"date_unix": ts, "network": netname, "chain_id": chain_id,
        "factory": host,
        "vault_code_hash": expect, "entry": e.name, "vault": e.vault, "owner": e.owner, "agent": e.agent,
        "agent_recovery_public_key": rpk, "policy": e.policy,
        "deposit": e.deposit.to_string(), "allowance": e.allowance.to_string(), "txs": sent}))?)?;
    println!("result: {out}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Value {
        serde_json::from_str(include_str!("../../../deploy/mainnet/season1.example.json")).unwrap()
    }
    fn filled() -> Value {
        let mut c = cfg();
        for (i, e) in c["entries"].as_array_mut().unwrap().iter_mut().enumerate() {
            e["owner"] = json!(format!("owner{i}.near"));
            e["agent"] = json!(format!("{:064x}", i + 1));
        }
        c
    }
    #[test]
    fn a_staked_entry_gets_the_staking_token_and_its_pairs() {
        let mut c = filled();
        c["entries"][1]["stake"] = json!(true);
        let p = build_plan(&c, None).unwrap();
        let (plain, staked) = (&p[0], &p[1]);
        assert_eq!(plain.policy["tokens"].as_array().unwrap().len(), 2, "unstaked entries are unchanged");
        assert_eq!(staked.policy["tokens"][2]["token"], "meta-pool.near");
        let pairs = staked.policy["pairs"].as_array().unwrap();
        assert_eq!(pairs.len(), 4);
        assert_eq!((pairs[2]["token_in"].as_str(), pairs[2]["token_out"].as_str(), pairs[2]["pool_id"].as_u64()), (Some("wrap.near"), Some("meta-pool.near"), Some(3514)));
        // 0.64 stNEAR per wNEAR and 1.47 wNEAR per stNEAR (both 24 decimals): floor = in * num / den.
        assert_eq!((pairs[2]["min_price_num"].as_str(), pairs[2]["min_price_den"].as_str()), (Some("16"), Some("25")));
        assert_eq!((pairs[3]["min_price_num"].as_str(), pairs[3]["min_price_den"].as_str()), (Some("147"), Some("100")));
        assert!(staked.txs.iter().any(|t| t.receiver == "meta-pool.near" && t.method == "storage_deposit"), "vault registered on stNEAR");
        assert_eq!(staked.locked_near, plain.locked_near + FT_STORAGE);
        c["stake"]["min_price_stake"] = json!("0");
        assert!(build_plan(&c, None).unwrap_err().contains("above 0"));
    }

    #[test]
    fn rpc_errors_fail_closed_only_unknown_account_means_absent() {
        assert!(unknown_account(&json!({"error": {"cause": {"name": "UNKNOWN_ACCOUNT"}}})));
        assert!(unknown_account(&json!({"error": {"data": "account x.near does not exist while viewing"}})));
        assert!(!unknown_account(&json!({"error": {"cause": {"name": "TOO_MANY_REQUESTS"}}})), "a rate limit is not 'no account'");
        assert!(!unknown_account(&json!({"error": {"cause": {"name": "TIMEOUT_ERROR"}}})));
        assert!(!unknown_account(&json!({})), "an empty answer is not 'no account'");
    }

    #[test]
    fn raw_amounts_are_exact() {
        assert_eq!(to_raw("1.2", 24).unwrap(), 1_200_000_000_000_000_000_000_000);
        assert_eq!(to_raw("5", 6).unwrap(), 5_000_000);
        assert_eq!(to_raw("0.000001", 6).unwrap(), 1);
        assert!(to_raw("0.0000001", 6).is_err());
        assert!(to_raw("1e3", 6).is_err() && to_raw("-1", 6).is_err() && to_raw("", 6).is_err());
    }

    #[test]
    fn price_bands_match_the_vault_formula() {
        let (n, d) = price_band("3.0", 24, 6).unwrap();
        assert_eq!((1_200_000_000_000_000_000_000_000u128 * n).div_ceil(d), 3_600_000);
        let (n, d) = price_band("0.17", 6, 24).unwrap();
        assert_eq!((5_000_000u128 * n).div_ceil(d), 850_000_000_000_000_000_000_000);
        assert!(price_band("0", 24, 6).is_err());
    }

    #[test]
    fn each_entry_is_created_from_the_factory_by_its_own_owner() {
        let p = build_plan(&filled(), None).unwrap();
        assert_eq!(p.len(), 3, "Season 1 = 3 reference entries");
        let e = &p[0];
        assert_eq!(e.vault, "house-rebalancer.arena.sledgit.near");
        let t0 = &e.txs[0];
        assert_eq!((t0.signer.as_str(), t0.receiver.as_str(), t0.method.as_str()), (e.owner.as_str(), "arena.sledgit.near", "create_vault"));
        assert_eq!(t0.deposit, NEAR / 5);
        assert_eq!(e.policy["pairs"][0]["pool_id"], 4512);
        assert!(e.txs.iter().filter(|t| t.method.contains("key")).all(|t| t.signer == e.agent));
        assert!(e.txs.iter().any(|t| t.method == "add_key(recovery)"), "the agent keeps a recovery key");
        // The 0.2 NEAR deposit stays below withdraw_near's 0.5 NEAR reserve: spent for good, like the registrations.
        assert_eq!(e.locked_near, NEAR / 5 + 3 * FT_STORAGE + EXCHANGE_STORAGE);
        assert_eq!(e.recoverable_near, NEAR + NEAR * 3 / 2, "wrapped NEAR (owner withdraws) + agent balance (recovery key)");
        let mut c = filled();
        c["entries"][0]["deposit_near"] = json!("0.05");
        assert!(build_plan(&c, None).unwrap_err().contains("bounds"));
        assert!(build_plan(&filled(), Some((NEAR, 10 * NEAR))).unwrap_err().contains("bounds"), "the factory's live bounds win");
    }

    #[test]
    fn placeholders_are_refused() {
        assert!(build_plan(&cfg(), None).unwrap_err().contains("placeholder"));
        assert!(placeholder(cfg()["expect_vault_code_hash"].as_str().unwrap()), "the example's hash is a placeholder until 1 Nov");
        assert!(!placeholder("2ZP4H1ENzFKyN4nVSZf9vKf3pEpgoup9DVU6NbjbE2Gg"));
    }

    #[test]
    fn a_shared_account_is_refused() {
        let mut c = filled();
        c["entries"][1]["owner"] = c["entries"][0]["owner"].clone();
        assert!(build_plan(&c, None).unwrap_err().contains("separation"));
        let mut c = filled();
        c["entries"][2]["agent"] = c["entries"][2]["owner"].clone();
        assert!(build_plan(&c, None).unwrap_err().contains("separation"));
        let mut c = filled();
        c["entries"][0]["owner"] = json!("sledgit.near");
        assert!(build_plan(&c, None).unwrap_err().contains("factory, its parent"), "the factory's parent is never an entry account");
        let mut c = filled();
        c["entries"][0]["agent"] = json!("house-trend.arena.sledgit.near");
        assert!(build_plan(&c, None).unwrap_err().contains("vault"));
    }

    #[test]
    fn policy_and_agent_limits_are_enforced() {
        let mut c = filled();
        c["policy"]["quote"]["max_per_trade"] = json!("20");
        assert!(build_plan(&c, None).unwrap_err().contains("daily cap"));
        let mut c = filled();
        c["policy"]["max_slippage_bps"] = json!(600);
        assert!(build_plan(&c, None).is_err());
        let mut c = filled();
        c["agent"]["allowance_near"] = json!("0.32");
        assert!(build_plan(&c, None).unwrap_err().contains("0.35"));
        let mut c = filled();
        c["agent"]["balance_near"] = json!("1.005");
        assert!(build_plan(&c, None).unwrap_err().contains("recovery key"), "the balance must cover the recovery key's storage too");
        let mut c = filled();
        c["entries"][0]["owner"] = json!("someone.testnet");
        assert!(build_plan(&c, None).unwrap_err().contains("mainnet account"));
        let mut c = filled();
        c["entries"][0]["recovery_public_key"] = json!("not-a-key");
        assert!(build_plan(&c, None).unwrap_err().contains("recovery_public_key"));
        let mut c = filled();
        c["entries"][0]["recovery_public_key"] = json!("ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp");
        assert_eq!(build_plan(&c, None).unwrap()[0].recovery_pk.as_deref(), Some("ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"));
    }

    #[test]
    fn sending_needs_the_entry_named_and_the_right_chain() {
        assert!(!may_send("mainnet", "mainnet", Some("house-trend"), None).unwrap());
        assert!(may_send("mainnet", "mainnet", Some("house-trend"), Some("house-luck")).is_err());
        assert!(may_send("mainnet", "testnet", Some("house-trend"), Some("house-trend")).is_err());
        assert!(may_send("mainnet", "mainnet", Some("house-trend"), Some("house-trend")).unwrap());
    }

    #[test]
    fn agent_end_state_is_one_scoped_key_plus_the_recovery_key() {
        let fc = |recv: &str, allowance: Value, methods: Vec<&str>| json!({"public_key": "ed25519:fc", "access_key": {"permission": {"FunctionCall":
            {"receiver_id": recv, "allowance": allowance, "method_names": methods}}}});
        let fa = |pk: &str| json!({"public_key": pk, "access_key": {"permission": "FullAccess"}});
        let v = "a.sledgit.near";
        let good = fc(v, json!("1"), AGENT_METHODS.to_vec());
        assert!(agent_done(&[good.clone(), fa("ed25519:rec")], v, Some("ed25519:rec")));
        assert!(agent_done(&[good.clone(), fa("ed25519:rec")], v, None));
        assert!(!agent_done(&[good.clone()], v, None), "no recovery key: the agent's NEAR would be stranded");
        assert!(!agent_done(&[good.clone(), fa("ed25519:setup")], v, Some("ed25519:rec")), "the wrong full-access key stayed");
        assert!(!agent_done(&[good.clone(), fa("ed25519:rec"), fa("ed25519:setup")], v, Some("ed25519:rec")), "the setup key must go");
        assert!(!agent_done(&[fc(v, Value::Null, AGENT_METHODS.to_vec()), fa("ed25519:rec")], v, None), "no allowance");
        assert!(!agent_done(&[fc("other.near", json!("1"), AGENT_METHODS.to_vec()), fa("ed25519:rec")], v, None));
        assert!(!agent_done(&[fc(v, json!("1"), vec!["request_swap"]), fa("ed25519:rec")], v, None));
    }

    #[test]
    fn funding_above_the_factory_caps_is_refused() {
        let p = build_plan(&filled(), None).unwrap();
        let e = &p[0];
        let fund: Vec<(String, u128)> = e.txs.iter().filter(|t| t.method == "ft_transfer_call")
            .map(|t| (t.receiver.clone(), t.args["amount"].as_str().unwrap().parse().unwrap())).collect();
        assert!(!fund.is_empty());
        assert!(over_caps(e, &json!([])).is_empty(), "no caps: nothing to check");
        let exact = json!(fund.iter().map(|(t, a)| json!({"token": t, "max": a.to_string()})).collect::<Vec<_>>());
        assert!(over_caps(e, &exact).is_empty(), "funding exactly at the caps is fine");
        let low = json!(fund.iter().map(|(t, a)| json!({"token": t, "max": (a - 1).to_string()})).collect::<Vec<_>>());
        assert_eq!(over_caps(e, &low).len(), fund.len());
        let missing = json!([{"token": "other.near", "max": "1000000000000000000000000000"}]);
        assert_eq!(over_caps(e, &missing).len(), fund.len(), "a token without a cap can't be deposited");
    }
}
