//! Create N fresh testnet accounts from the faucet sharing one new key (testnet only).
//!   cargo run --example faucet -- <prefix> <count>
//! The key is written to ~/.config/sledgit/testnet-faucet-<prefix>.json (created 0600; an existing file is refused).
use near_api::{NetworkConfig, Signer};
use near_sdk::serde_json::json;
use std::time::Duration;
#[path = "shared/local.rs"] mod local;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let (prefix, n): (&str, usize) = (&args[1], args[2].parse()?);
    let net = NetworkConfig::from_rpc_url("testnet", "https://rpc.testnet.fastnear.com".parse()?);
    let sk = near_api::signer::generate_secret_key()?;
    let pk = Signer::from_secret_key(sk.clone())?.get_public_key().await?;
    let path = local::key_dir()?.join(format!("testnet-faucet-{prefix}.json"));
    if path.exists() { return Err(format!("{} exists; pick a new prefix (key files are never replaced)", path.display()).into()); }
    let mut made = vec![];
    for i in 0..n {
        let name = format!("{prefix}-{i}.testnet");
        let r = near_api::Account::create_account(name.parse()?).sponsor_by_faucet_service().with_public_key(pk)?
            .send_to_testnet_faucet().await?;
        if !r.status().is_success() { println!("{name}: faucet {}", r.status()); break; }
        made.push(name.clone());
        println!("{name}: created");
        // Created 0600 from the first byte; later writes in this run only add accounts to our own file.
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create(true).truncate(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; o.mode(0o600); }
        std::io::Write::write_all(&mut o.open(&path)?, json!({"network": "testnet", "secret_key": sk.to_string(), "accounts": made}).to_string().as_bytes())?;
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    let _ = net;
    Ok(())
}
