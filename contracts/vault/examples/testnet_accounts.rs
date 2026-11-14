//! Create testnet sub-accounts of the treasury, each with its own new full-access key, funded from the treasury
//! (testnet only; used to rehearse flows that need separate owner and agent accounts).
//!
//!   cargo run --example testnet_accounts -- <name>:<millinear> [<name>:<millinear>...]
//!
//! Account `<name>.<treasury>`; its key goes to ~/.config/sledgit/testnet-<account>.json, created 0600 and never
//! replaced. Nothing secret is printed.
use near_api::{AccountId, NearToken, NetworkConfig, Signer};
use near_sdk::serde_json::{self, json, Value};
use std::sync::Arc;
#[path = "shared/local.rs"] mod local;

type R<T = ()> = Result<T, Box<dyn std::error::Error>>;
const RPC: &str = "https://rpc.testnet.fastnear.com";
const TREASURY: &str = "it1793205219-owner.testnet";

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

#[tokio::main]
async fn main() -> R {
    let net = NetworkConfig::from_rpc_url("testnet", RPC.parse()?);
    let treasury = treasury_signer()?;
    for arg in std::env::args().skip(1) {
        let (name, milli) = arg.split_once(':').ok_or("usage: <name>:<millinear>")?;
        let milli: u128 = milli.parse()?;
        if milli > 5000 { return Err("refusing more than 5 NEAR per account".into()); }
        let acct = format!("{name}.{TREASURY}");
        let aid: AccountId = acct.parse()?;
        let sk = near_api::signer::generate_secret_key()?;
        let pk = Signer::from_secret_key(sk.clone())?.get_public_key().await?;
        let path = local::key_dir()?.join(format!("testnet-{acct}.json"));
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path)
                .map_err(|e| format!("{} not written ({e}); never replaced", path.display()))?;
            f.write_all(json!({"network": "testnet", "secret_key": sk.to_string(), "account_id": acct, "accounts": [acct]}).to_string().as_bytes())?;
        }
        let r = near_api::Account::create_account(aid).fund_myself(TREASURY.parse()?, NearToken::from_millinear(milli))
            .with_public_key(pk).with_signer(treasury.clone()).send_to(&net).await?;
        let ok = r.into_result().is_ok();
        println!("{acct}: {} ({} NEAR)", if ok { "created" } else { "FAILED" }, milli as f64 / 1000.0);
        if !ok { return Err("account creation failed".into()); }
    }
    Ok(())
}
