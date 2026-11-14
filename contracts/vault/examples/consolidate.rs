//! Move spare test NEAR from the given accounts into the treasury (testnet only; keys from ~/.config/sledgit).
//!   cargo run --example consolidate -- <account> [<account>...]
//! Each account keeps 0.1 NEAR. Nothing is printed but account names and amounts.
use near_api::{AccountId, NearToken, NetworkConfig, Signer};
use near_sdk::serde_json::{self, Value};
#[path = "shared/local.rs"] mod local;

type R<T = ()> = Result<T, Box<dyn std::error::Error>>;
const TREASURY: &str = "it1793205219-owner.testnet";

fn signer_for(acct: &str) -> R<std::sync::Arc<Signer>> {
    let dir = local::key_dir()?;
    for e in std::fs::read_dir(dir)? {
        let p = e?.path();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        if !name.starts_with("testnet-") || !name.ends_with(".json") { continue; }
        let d: Value = serde_json::from_str(&std::fs::read_to_string(&p)?)?;
        let listed = d["accounts"].as_array().map(|a| a.iter().any(|x| x == acct)).unwrap_or(false);
        if let (true, Some(sk)) = (listed, d["secret_key"].as_str()) { return Ok(Signer::from_secret_key(sk.parse()?)?); }
    }
    Err(format!("no key for {acct}").into())
}

#[tokio::main]
async fn main() -> R {
    let net = NetworkConfig::from_rpc_url("testnet", "https://rpc.testnet.fastnear.com".parse()?);
    for a in std::env::args().skip(1) {
        if !a.ends_with(".testnet") { return Err(format!("{a} is not a testnet account").into()); }
        let id: AccountId = a.parse()?;
        let b = near_api::Tokens::account(id.clone()).near_balance().fetch_from(&net).await?;
        let free = b.total.as_yoctonear().saturating_sub(b.storage_locked.as_yoctonear());
        let keep = NearToken::from_millinear(100).as_yoctonear();
        if free <= keep { println!("{a}: nothing spare"); continue; }
        let amt = NearToken::from_yoctonear(free - keep);
        let r = near_api::Tokens::account(id).send_to(TREASURY.parse()?).near(amt).with_signer(signer_for(&a)?).send_to(&net).await?;
        println!("{a} -> treasury {:.3} NEAR {}", amt.as_yoctonear() as f64 / 1e24, if r.into_result().is_ok() { "ok" } else { "FAIL" });
    }
    Ok(())
}
