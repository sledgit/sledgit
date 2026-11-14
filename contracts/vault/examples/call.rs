//! Send one testnet function call as an account whose key is in ~/.config/sledgit/ (testnet only).
//!   cargo run --example call -- <signer> <contract> <method> '<json args>' [deposit_yocto] [tgas]
use near_api::{NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::serde_json::Value;
#[path = "shared/local.rs"] mod local;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let a: Vec<String> = std::env::args().collect();
    let (who, contract, method, args) = (&a[1], &a[2], &a[3], serde_json_parse(&a[4])?);
    let deposit: u128 = a.get(5).map(|s| s.parse()).transpose()?.unwrap_or(0);
    let tgas: u64 = a.get(6).map(|s| s.parse()).transpose()?.unwrap_or(100);
    let dir = local::key_dir()?;
    let mut sk = None;
    for e in std::fs::read_dir(&dir)? {
        let p = e?.path();
        if !p.file_name().unwrap().to_string_lossy().starts_with("testnet-") { continue; }
        let d: Value = near_sdk::serde_json::from_str(&std::fs::read_to_string(&p)?)?;
        if d["accounts"].as_array().is_some_and(|l| l.iter().any(|x| x == who.as_str())) { sk = d["secret_key"].as_str().map(String::from); }
        if let Some(l) = d["keys"].as_array() { for k in l { if k["account_id"] == who.as_str() { sk = k["secret_key"].as_str().map(String::from); } } }
    }
    let signer = Signer::from_secret_key(sk.ok_or("no key for signer")?.parse()?)?;
    let net = NetworkConfig::from_rpc_url("testnet", "https://rpc.testnet.fastnear.com".parse()?);
    let r = near_api::Contract(contract.parse()?).call_function(method, args).transaction()
        .gas(NearGas::from_tgas(tgas)).deposit(NearToken::from_yoctonear(deposit))
        .with_signer(who.parse()?, signer).send_to(&net).await?;
    println!("ok={} logs={:?}", r.clone().into_result().is_ok(), r.logs());
    Ok(())
}
fn serde_json_parse(s: &str) -> Result<Value, Box<dyn std::error::Error>> { Ok(near_sdk::serde_json::from_str(s)?) }
