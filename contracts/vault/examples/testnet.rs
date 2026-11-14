//! Deploy and exercise the vault on NEAR testnet against real contracts: Rhea (ref-finance-101.testnet), the real
//! Chain Signatures network (v1.signer-prod.testnet) and our own testnet copy of the mainnet intents.near binary
//! (NEAR Intents is not deployed on testnet).
//!
//!   cargo run --example testnet
//!   IT_REUSE=~/.config/sledgit/testnet-deploy-<ts>.json cargo run --example testnet
//!       reuse a previous run's owner, agent and intents copy (the faucet rate-limits); the owner funds a new vault
//!       sub-account `v<ts>.<owner>`, the way owners will fund real vaults. IT_INTENTS=<account> picks the intents copy.
//!
//! Creates fresh faucet accounts each run. Keys go to ~/.config/sledgit/testnet-deploy-<ts>.json (mode 600),
//! never into the repo. Results (no secrets) go to deploy/testnet/result-<ts>.json. Spends only testnet NEAR.
#![allow(unused_must_use)]
use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
use near_api::types::transaction::result::TransactionResult;
use near_api::{AccountId, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::{self, json, Value};
use sha3::{Digest, Keccak256};
use std::sync::Arc;
use std::time::{Duration, Instant};
#[path = "shared/local.rs"] mod local;

type R<T = ()> = Result<T, Box<dyn std::error::Error>>;

const RPC: &str = "https://rpc.testnet.fastnear.com";
const REF: &str = "ref-finance-101.testnet";
const MPC: &str = "v1.signer-prod.testnet";
const WRAP: &str = "wrap.testnet";
const USDC: &str = "usdc.itachicara.testnet"; // 24 decimals on testnet
const POOL: u64 = 1103;
const E24: u128 = 1_000_000_000_000_000_000_000_000;
const SECP_N_HALF: [u8; 32] = [0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0];

struct T { net: NetworkConfig, signer: Arc<Signer>, log: Vec<Value>, checks: Vec<(String, bool)> }

fn id(s: &str) -> AccountId { s.parse().unwrap() }
fn keccak(b: &[u8]) -> [u8; 32] { Keccak256::digest(b).into() }

fn events(r: &TransactionResult, kind: &str) -> Vec<Value> {
    r.logs().iter().filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|j| serde_json::from_str::<Value>(j).ok())
        .filter(|e| (e["standard"] == "sledgit" || e["standard"] == "irontrade") && e["event"] == kind).map(|e| e["data"][0].clone()).collect() // irontrade: pre-rename code
}

impl T {
    async fn call(&mut self, label: &str, who: &AccountId, contract: &str, method: &str, args: Value, deposit: NearToken, tgas: u64) -> R<TransactionResult> {
        let t0 = Instant::now();
        let r = near_api::Contract(id(contract)).call_function(method, args).transaction()
            .gas(NearGas::from_tgas(tgas)).deposit(deposit).with_signer(who.clone(), self.signer.clone())
            .send_to(&self.net).await?;
        let full = r.clone().into_full();
        let hash = full.as_ref().and_then(|f| f.outcomes().first().map(|o| o.transaction_hash.to_string())).unwrap_or_default();
        let gas = full.as_ref().map(|f| f.total_gas_burnt.as_tgas()).unwrap_or(0);
        let ok = r.clone().into_result().is_ok();
        println!("{:<34} {} {:>4} Tgas {:>5.1}s  {}", label, if ok { "ok  " } else { "FAIL" }, gas, t0.elapsed().as_secs_f32(), hash);
        if !ok { println!("    {}", format!("{:?}", r.clone().into_result().err()).chars().take(400).collect::<String>()); }
        self.log.push(json!({"step": label, "ok": ok, "tx": hash, "gas_tgas": gas, "seconds": t0.elapsed().as_secs_f32()}));
        Ok(r)
    }
    async fn view<V: near_sdk::serde::de::DeserializeOwned + Send + Sync>(&self, contract: &str, method: &str, args: Value) -> R<V> {
        Ok(near_api::Contract(id(contract)).call_function(method, args).read_only().fetch_from(&self.net).await?.data)
    }
    async fn bal(&self, token: &str, who: &AccountId) -> R<u128> {
        let v: String = self.view(token, "ft_balance_of", json!({"account_id": who})).await?;
        Ok(v.parse()?)
    }
    fn check(&mut self, name: &str, ok: bool) {
        println!("  {} {}", if ok { "PASS" } else { "FAIL" }, name);
        self.checks.push((name.into(), ok));
    }
}

async fn faucet_account(net: &NetworkConfig, name: &str, pk: near_api::PublicKey) -> R<AccountId> {
    let acc = id(name);
    near_api::Account::create_account(acc.clone()).sponsor_by_faucet_service().with_public_key(pk)?
        .send_to_testnet_faucet().await?.error_for_status()?;
    for _ in 0..30 {
        if near_api::Account(acc.clone()).view().fetch_from(net).await.is_ok() { return Ok(acc); }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    Err(format!("{name} did not appear").into())
}

/// A market maker with its own secp256k1 key; on intents.near its account is the implicit 0x address.
fn solver_intent(key: &SigningKey, addr: &str, intents: &str, give_usdc: u128, take_wnear: u128) -> Value {
    let payload = json!({"signer_id": addr, "verifying_contract": intents, "deadline": "2030-01-01T00:00:00Z",
        "nonce": serde_json::to_value(Base64VecU8(keccak(format!("{addr}{give_usdc}{take_wnear}").as_bytes()).to_vec())).unwrap(),
        "intents": [{"intent": "token_diff", "diff": {format!("nep141:{WRAP}"): take_wnear.to_string(),
            format!("nep141:{USDC}"): format!("-{give_usdc}")}}]}).to_string();
    let mut msg = format!("\x19Ethereum Signed Message:\n{}", payload.len()).into_bytes();
    msg.extend_from_slice(payload.as_bytes());
    let (sig, recid) = key.sign_prehash_recoverable(&keccak(&msg)).unwrap();
    let mut raw = sig.to_bytes().to_vec();
    raw.push(u8::from(recid.is_y_odd()));
    json!({"standard": "erc191", "payload": payload, "signature": format!("secp256k1:{}", bs58::encode(raw).into_string())})
}

/// Recover the signer of an erc191 MultiPayload; also report whether s is in the low half (intents.near requires it).
fn recover(multi: &Value) -> Option<(String, bool)> {
    let payload = multi["payload"].as_str()?;
    let raw = bs58::decode(multi["signature"].as_str()?.strip_prefix("secp256k1:")?).into_vec().ok()?;
    let mut msg = format!("\x19Ethereum Signed Message:\n{}", payload.len()).into_bytes();
    msg.extend_from_slice(payload.as_bytes());
    let sig = Signature::from_slice(&raw[..64]).ok()?;
    let vk = VerifyingKey::recover_from_prehash(&keccak(&msg), &sig, RecoveryId::from_byte(raw[64])?).ok()?;
    let point = vk.to_encoded_point(false);
    Some((format!("secp256k1:{}", bs58::encode(&point.as_bytes()[1..]).into_string()), raw[32..64] <= SECP_N_HALF[..]))
}

#[tokio::main]
async fn main() -> R {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs();
    let net = NetworkConfig::from_rpc_url("testnet", RPC.parse()?);
    let dir = local::key_dir()?;
    std::fs::create_dir_all(&dir)?;
    let reuse = std::env::var("IT_REUSE").ok().filter(|p| !p.is_empty());
    let (sk, names): (near_api::SecretKey, Vec<String>) = match &reuse {
        Some(p) => {
            let d: Value = serde_json::from_str(&std::fs::read_to_string(p.replace('~', &dirs_home().to_string_lossy()))?)?;
            (d["secret_key"].as_str().ok_or("no secret_key")?.parse()?,
             d["accounts"].as_array().ok_or("no accounts")?.iter().filter_map(|a| a.as_str().map(String::from)).collect())
        }
        None => (near_api::signer::generate_secret_key()?,
                 ["owner", "agent", "vault", "intents", "fund1", "fund2"].iter().map(|n| format!("it{ts}-{n}.testnet")).collect()),
    };
    let signer = Signer::from_secret_key(sk.clone())?;
    let pk = signer.get_public_key().await?;
    if reuse.is_none() {
        let keyfile = dir.join(format!("testnet-deploy-{ts}.json"));
        std::fs::write(&keyfile, json!({"network": "testnet", "secret_key": sk.to_string(), "accounts": names}).to_string())?;
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&keyfile, std::fs::Permissions::from_mode(0o600))?; }
    }
    let mut t = T { net, signer: signer.clone(), log: vec![], checks: vec![] };
    let (owner, agent, intents, fund1) = (id(&names[0]), id(&names[1]), id(&names[3]), id(&names[4]));
    // A reused run may not have its own intents copy: IT_INTENTS names the one to use (e.g. it1793205011-intents.testnet).
    let intents = std::env::var("IT_INTENTS").map(|s| id(&s)).unwrap_or(intents);
    let vault: AccountId;

    if reuse.is_none() {
        println!("== accounts (faucet)");
        for n in &names { faucet_account(&t.net, n, pk).await?; tokio::time::sleep(Duration::from_secs(2)).await; }
        for f in [&names[4], &names[5]] {
            near_api::Tokens::account(id(f)).send_to(intents.clone()).near(NearToken::from_millinear(9_500))
                .with_signer(signer.clone()).send_to(&t.net).await?.assert_success();
        }
        println!("== intents.near copy (mainnet binary v0.4.5)");
        let wasm = std::fs::read("tests/res/intents_mainnet.wasm")?;
        near_api::Contract::deploy(intents.clone()).use_code(wasm)
            .with_init_call("new", json!({"config": {"wnear_id": WRAP, "fees": {"fee": 0, "fee_collector": owner}, "roles": {}}}))?
            .with_signer(signer.clone()).send_to(&t.net).await?.assert_success();
        vault = id(&names[2]);
    } else {
        if let Ok(f) = std::env::var("IT_FUND_FROM") {
            // Top up the reused owner from another run's spare account (testnet only).
            let d: Value = serde_json::from_str(&std::fs::read_to_string(f.replace('~', &dirs_home().to_string_lossy()))?)?;
            let s2 = Signer::from_secret_key(d["secret_key"].as_str().ok_or("no key")?.parse()?)?;
            let from = id(d["accounts"][0].as_str().ok_or("no account")?);
            near_api::Tokens::account(from).send_to(owner.clone()).near(NearToken::from_near(9))
                .with_signer(s2).send_to(&t.net).await?.assert_success();
        }
        println!("== new vault account, funded by the owner");
        vault = id(&format!("v{ts}.{owner}"));
        near_api::Account::create_account(vault.clone()).fund_myself(owner.clone(), NearToken::from_near(4))
            .with_public_key(pk).with_signer(signer.clone()).send_to(&t.net).await?.assert_success();
    }

    println!("== vault");
    let policy = json!({
        "tokens": [{"token": WRAP, "max_per_trade": E24.to_string(), "max_per_day": (3 * E24).to_string()},
                   {"token": USDC, "max_per_trade": (3 * E24).to_string(), "max_per_day": (9 * E24).to_string()}],
        "pairs": [{"token_in": WRAP, "token_out": USDC, "pool_id": POOL, "min_price_num": "14", "min_price_den": "10"},
                  {"token_in": USDC, "token_out": WRAP, "pool_id": POOL, "min_price_num": "33", "min_price_den": "100"}],
        "max_trades_per_hour": 10, "max_slippage_bps": 100});
    let vwasm = std::fs::read("../target/near/sledgit_vault/sledgit_vault.wasm")?;
    near_api::Contract::deploy(vault.clone()).use_code(vwasm)
        .with_init_call("new", json!({"owner_id": owner, "agent_id": agent, "exchange_id": REF, "intents_id": intents,
            "mpc_id": MPC, "policy": policy,
            // Beta deposit caps: 1.2 wNEAR and 5 USDC, net of withdrawals.
            "deposit_caps": [{"token": WRAP, "max": (12 * E24 / 10).to_string()}, {"token": USDC, "max": (5 * E24).to_string()}]}))?
        .with_signer(signer.clone()).send_to(&t.net).await?.assert_success();

    println!("== setup (owner)");
    let y1 = NearToken::from_yoctonear(1);
    for (who, token) in [(&vault, WRAP), (&vault, USDC), (&owner, WRAP), (&owner, USDC), (&intents, WRAP), (&intents, USDC)] {
        t.call(&format!("storage_deposit {token}"), &owner, token, "storage_deposit", json!({"account_id": who}), NearToken::from_millinear(10), 30).await?;
    }
    t.call("exchange_storage_deposit", &owner, vault.as_str(), "exchange_storage_deposit", json!({}), NearToken::from_millinear(100), 50).await?;
    t.call("exchange_register_tokens", &owner, vault.as_str(), "exchange_register_tokens", json!({}), y1, 50).await?;
    t.call("wrap 1.5 NEAR", &owner, WRAP, "near_deposit", json!({}), NearToken::from_millinear(1_500), 30).await?;
    t.call("fund vault 1 wNEAR", &owner, WRAP, "ft_transfer_call", json!({"receiver_id": vault, "amount": E24.to_string(), "msg": ""}), y1, 100).await?;

    println!("== deposit cap (1.2 wNEAR)");
    let before = t.bal(WRAP, &owner).await?;
    t.call("fund 0.5 wNEAR more (0.2 room)", &owner, WRAP, "ft_transfer_call", json!({"receiver_id": vault, "amount": (5 * E24 / 10).to_string(), "msg": ""}), y1, 100).await?;
    let (v, o) = (t.bal(WRAP, &vault).await?, t.bal(WRAP, &owner).await?);
    if v != 12 * E24 / 10 || before - o != 2 * E24 / 10 { return Err(format!("cap: vault {v}, owner paid {}", before - o).into()); }
    t.call("fund 0.1 wNEAR at the cap", &owner, WRAP, "ft_transfer_call", json!({"receiver_id": vault, "amount": (E24 / 10).to_string(), "msg": ""}), y1, 100).await?;
    if t.bal(WRAP, &vault).await? != 12 * E24 / 10 { return Err("cap: deposit at the cap was kept".into()); }
    let caps: Value = t.view(vault.as_str(), "get_deposit_caps", json!({})).await?;
    println!("   cap held: vault 1.2 wNEAR, excess returned; get_deposit_caps {caps}");

    println!("== Rhea swap via the vault");
    let receipt: String = keccak(b"iron-trade testnet receipt").iter().map(|b| format!("{b:02x}")).collect();
    let r = t.call("request_swap 0.25 wNEAR->USDC", &agent, vault.as_str(), "request_swap", json!({"token_in": WRAP, "token_out": USDC,
        "amount_in": (E24 / 4).to_string(), "min_amount_out": "1", "receipt_hash": receipt}), NearToken::from_yoctonear(0), 300).await?;
    let trade = events(&r, "trade");
    t.check("Rhea trade event", trade.len() == 1);
    let usdc_in_vault = t.bal(USDC, &vault).await?;
    t.check("event amount_out equals the vault's USDC balance", trade.first().and_then(|e| e["amount_out"].as_str()) == Some(&usdc_in_vault.to_string()));
    println!("    0.25 wNEAR -> {} USDC", usdc_in_vault as f64 / E24 as f64);

    println!("== NEAR Intents with the real Chain Signatures network");
    let r = t.call("intents_setup (real MPC key)", &owner, vault.as_str(), "intents_setup", json!({}), y1, 100).await?;
    let key = events(&r, "intents_key").first().and_then(|e| e["public_key"].as_str().map(String::from)).unwrap_or_default();
    let keys: Vec<String> = t.view(intents.as_str(), "public_keys_of", json!({"account_id": vault})).await?;
    t.check("vault's MPC key registered on intents", !key.is_empty() && keys.contains(&key));
    let r = t.call("intents_deposit 0.4 wNEAR", &owner, vault.as_str(), "intents_deposit", json!({"token": WRAP, "amount": (4 * E24 / 10).to_string()}), y1, 100).await?;
    t.check("intents_deposit recorded only once it arrived", events(&r, "intents_deposit").len() == 1);
    let r = t.call("request_intent_swap 0.2 wNEAR", &agent, vault.as_str(), "request_intent_swap", json!({"token_in": WRAP, "token_out": USDC,
        "amount_in": (2 * E24 / 10).to_string(), "min_amount_out": "1", "receipt_hash": receipt}), NearToken::from_yoctonear(0), 300).await?;
    let auth = events(&r, "intent_authorized");
    t.check("real MPC signed the intent (intent_authorized)", auth.len() == 1);
    let Some(a) = auth.first().cloned() else { return finish(t, ts, &names).await };
    let (rec, low_s) = recover(&a["multi_payload"]).unwrap_or_default();
    t.check("signature recovers to the vault's registered key", rec == key);
    t.check("signature is low-s (intents.near requirement)", low_s);
    let min_out: u128 = a["min_amount_out"].as_str().unwrap_or("0").parse()?;

    // Solver: gets USDC from the owner (vault -> owner withdraw), deposits it on intents for its 0x account, fills.
    let solver = SigningKey::from_bytes(&keccak(format!("solver{ts}").as_bytes()).into())?;
    let p = solver.verifying_key().to_encoded_point(false);
    let saddr = format!("0x{}", keccak(&p.as_bytes()[1..])[12..].iter().map(|b| format!("{b:02x}")).collect::<String>());
    t.call("owner withdraws vault USDC", &owner, vault.as_str(), "withdraw", json!({"token": USDC, "amount": usdc_in_vault.to_string()}), y1, 50).await?;
    t.call("solver USDC onto intents", &owner, USDC, "ft_transfer_call", json!({"receiver_id": intents, "amount": usdc_in_vault.to_string(), "msg": saddr}), y1, 100).await?;
    // The solver's USDC is what the vault's Rhea swap bought (~0.53); the 0.2 wNEAR intent needs ~0.42.
    let fill = solver_intent(&solver, &saddr, intents.as_str(), min_out, 2 * E24 / 10);
    let r = t.call("execute_intents (vault + solver)", &owner, intents.as_str(), "execute_intents", json!({"signed": [a["multi_payload"], fill]}), NearToken::from_yoctonear(0), 300).await?;
    t.check("intent settled on intents.near", r.into_result().is_ok());
    let r = t.call("intents_settle (anyone)", &fund1, vault.as_str(), "intents_settle", json!({}), NearToken::from_yoctonear(0), 50).await?;
    t.check("settle records the fill as a trade", events(&r, "trade").first().and_then(|e| e["amount_out"].as_str()) == Some(&min_out.to_string()));

    println!("== cancel with the real Chain Signatures network");
    let r = t.call("request_intent_swap 0.05 wNEAR", &agent, vault.as_str(), "request_intent_swap", json!({"token_in": WRAP, "token_out": USDC,
        "amount_in": (E24 / 20).to_string(), "min_amount_out": "1", "receipt_hash": receipt}), NearToken::from_yoctonear(0), 300).await?;
    let a2 = events(&r, "intent_authorized").first().cloned();
    t.check("second intent authorized after the first was settled", a2.is_some());
    let r = t.call("intents_cancel (agent)", &agent, vault.as_str(), "intents_cancel", json!({}), NearToken::from_yoctonear(0), 300).await?;
    t.check("cancel burned the nonce (intent_cancelled)", events(&r, "intent_cancelled").len() == 1);
    if let Some(a2) = a2 {
        let fill = solver_intent(&solver, &saddr, intents.as_str(), 1, E24 / 20);
        let r = t.call("execute cancelled intent", &owner, intents.as_str(), "execute_intents", json!({"signed": [a2["multi_payload"], fill]}), NearToken::from_yoctonear(0), 300).await?;
        t.check("cancelled intent cannot be filled", r.into_result().is_err());
    }

    println!("== lock the vault (delete its keys)");
    near_api::Account(vault.clone()).delete_key(pk).with_signer(signer.clone()).send_to(&t.net).await?.assert_success();
    let keys = near_api::Account(vault.clone()).list_keys().fetch_from(&t.net).await?.data;
    t.check("vault has no access keys", keys.is_empty());
    let r = t.call("owner withdraws after lock", &owner, vault.as_str(), "withdraw", json!({"token": WRAP, "amount": "1000"}), y1, 50).await?;
    t.check("owner can still withdraw from a locked vault", events(&r, "withdraw").len() == 1);
    finish(t, ts, &names).await
}

async fn finish(t: T, ts: u64, names: &[String]) -> R {
    let pass = t.checks.iter().filter(|(_, ok)| *ok).count();
    println!("\n{pass}/{} checks passed", t.checks.len());
    std::fs::create_dir_all("../../deploy/testnet")?;
    let out = json!({"date_unix": ts, "accounts": names, "contracts": {"rhea": REF, "mpc": MPC, "pool": POOL, "wrap": WRAP, "usdc": USDC},
        "checks": t.checks.iter().map(|(n, ok)| json!({"check": n, "pass": ok})).collect::<Vec<_>>(), "steps": t.log});
    std::fs::write(format!("../../deploy/testnet/result-{ts}.json"), serde_json::to_string_pretty(&out)?)?;
    if pass != t.checks.len() { std::process::exit(1); }
    Ok(())
}

fn dirs_home() -> std::path::PathBuf { std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())) }
