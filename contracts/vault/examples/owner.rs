//! Owner-only escape hatches of a vault (testnet only; the owner's key from ~/.config/sledgit/).
//!   cargo run --example owner -- <vault> abandon
//!   cargo run --example owner -- <vault> claim-lostfound <token>
//! Both take 1 yocto (the owner check). `abandon` closes an intent that can't be settled, an hour past its deadline, as
//! unresolved; the cap stays used. `claim-lostfound` asks the exchange for a payout it parked in the vault's lostfound.
//! The agent runner never makes these calls: it holds only the agent key and never attaches a deposit.
use near_api::{NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::serde_json::{json, Value};
#[path = "shared/local.rs"] mod local;

const TREASURY: &str = "it1793205219-owner.testnet";
/// lib.rs TG_MIN_CLAIM_LOSTFOUND is the exchange-withdraw minimum (115 Tgas); leave headroom.
const TG_CLAIM: u64 = 150;
const TG_ABANDON: u64 = 30;

type R<T> = Result<T, Box<dyn std::error::Error>>;

fn owner_signer() -> R<std::sync::Arc<Signer>> {
    let dir = local::key_dir()?;
    for e in std::fs::read_dir(&dir)? {
        let p = e?.path();
        if !p.file_name().unwrap().to_string_lossy().starts_with("testnet-") { continue; }
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&p)?.permissions().mode();
            if mode & 0o077 != 0 { return Err(format!("{} is readable by other users (mode {:o}): chmod 600 it", p.display(), mode & 0o777).into()); }
        }
        let d: Value = near_sdk::serde_json::from_str(&std::fs::read_to_string(&p)?)?;
        if d["accounts"].as_array().is_some_and(|l| l.iter().any(|x| x == TREASURY)) {
            if let Some(sk) = d["secret_key"].as_str() { return Ok(Signer::from_secret_key(sk.parse()?)?); }
        }
    }
    Err("no key for the owner".into())
}

#[tokio::main]
async fn main() -> R<()> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let (vault, op) = (a.first().ok_or("usage: owner <vault> abandon|claim-lostfound [token]")?, a.get(1).map(String::as_str));
    if !vault.ends_with(".testnet") { return Err(format!("{vault} is not a testnet account").into()); }
    let (method, args, tg) = match op {
        Some("abandon") => ("intents_abandon", json!({}), TG_ABANDON),
        Some("claim-lostfound") => ("exchange_claim_lostfound", json!({"token": a.get(2).ok_or("claim-lostfound <token>")?}), TG_CLAIM),
        _ => return Err("usage: owner <vault> abandon|claim-lostfound [token]".into()),
    };
    let net = NetworkConfig::from_rpc_url("testnet", "https://rpc.testnet.fastnear.com".parse()?);
    let r = near_api::Contract(vault.parse()?).call_function(method, args).transaction()
        .gas(NearGas::from_tgas(tg)).deposit(NearToken::from_yoctonear(1))
        .with_signer(TREASURY.parse()?, owner_signer()?).send_to(&net).await?;
    let events: Vec<&str> = r.logs().into_iter().filter(|l| l.starts_with("EVENT_JSON:")).collect();
    println!("{method}: ok={} events={events:?}", r.clone().into_result().is_ok());
    Ok(())
}
