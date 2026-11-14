//! Sandbox suite: the real vault WASM against the real Rhea exchange code from mainnet (tests/res).
#![allow(unused_must_use)]
use near_api::{AccountId, NearGas, NearToken, Signer};
use near_api::types::transaction::actions::{Action, FunctionCallAction};
use near_api::types::transaction::result::TransactionResult;
use near_sdk::serde_json::{json, Value};
use std::sync::Arc;

type R<T = ()> = testresult::TestResult<T>;

const RHEA_SHA256: &str = "e7447d9ceb34085acfde8b1f62b0667a3a0a81326f24c211523bb549f1873d87";
const INTENTS_SHA256: &str = "a1afab98916d9f213746544dcf8e4e6bdb22c0be6bc5dfbd8ea8814c9922b547";
const HASH: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const E6: u128 = 1_000_000;            // USDC has 6 decimals
const E24: u128 = 1_000_000_000_000_000_000_000_000;

struct Env {
    _sandbox: near_sandbox::Sandbox,
    net: near_api::NetworkConfig,
    signer: Arc<Signer>,
    ex: AccountId, usdc: AccountId, wnear: AccountId,
    vault: AccountId, owner: AccountId, agent: AccountId, eve: AccountId, lp: AccountId,
    intents: AccountId, mpc: AccountId,
    pool: u64,
}

fn id(s: &str) -> AccountId { s.parse().unwrap() }

impl Env {
    async fn call(&self, who: &AccountId, contract: &AccountId, method: &str, args: Value, yocto: u128, tgas: u64) -> R<TransactionResult> {
        Ok(near_api::Contract(contract.clone()).call_function(method, args).transaction()
            .gas(NearGas::from_tgas(tgas)).deposit(NearToken::from_yoctonear(yocto))
            .with_signer(who.clone(), self.signer.clone()).send_to(&self.net).await?)
    }
    async fn ok(&self, who: &AccountId, contract: &AccountId, method: &str, args: Value, yocto: u128, tgas: u64) -> R<TransactionResult> {
        let r = self.call(who, contract, method, args.clone(), yocto, tgas).await?;
        if let Err(e) = r.clone().into_result() {
            let msg = format!("{e:?}");
            let why = msg.find("ExecutionError(").map(|i| &msg[i..(i + 300).min(msg.len())]).unwrap_or(&msg[..msg.len().min(300)]);
            panic!("{method} {args} failed: {why}");
        }
        Ok(r)
    }
    async fn view<T: near_sdk::serde::de::DeserializeOwned + Send + Sync>(&self, contract: &AccountId, method: &str, args: Value) -> R<T> {
        Ok(near_api::Contract(contract.clone()).call_function(method, args).read_only()
            .fetch_from(&self.net).await?.data)
    }
    async fn bal(&self, token: &AccountId, who: &AccountId) -> R<u128> {
        let v: String = self.view(token, "ft_balance_of", json!({"account_id": who})).await?;
        Ok(v.parse()?)
    }
    async fn rhea_deposits(&self, who: &AccountId) -> R<Value> {
        self.view(&self.ex, "get_deposits", json!({"account_id": who})).await
    }
    async fn swap(&self, amount: u128, min_out: u128) -> R<TransactionResult> {
        self.call(&self.agent, &self.vault, "request_swap", json!({"token_in": self.usdc,
            "token_out": self.wnear, "amount_in": amount.to_string(), "min_amount_out": min_out.to_string(),
            "receipt_hash": HASH}), 0, 300).await
    }
}

fn events(r: &TransactionResult, kind: &str) -> Vec<Value> {
    r.logs().iter().filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|j| near_sdk::serde_json::from_str::<Value>(j).ok())
        .filter(|e| e["standard"] == "sledgit" && e["event"] == kind)
        .map(|e| e["data"][0].clone()).collect()
}

async fn assert_nothing_held(env: &Env) -> R {
    let d = env.rhea_deposits(&env.vault).await?;
    assert!(d.as_object().unwrap().values().all(|v| v == "0"), "left on the exchange: {d}");
    Ok(())
}

fn wasm(path: &str) -> R<Vec<u8>> { Ok(std::fs::read(path)?) }

fn sha256_hex(b: &[u8]) -> String {
    // Uses the system shasum, which tests/run.sh checks for.
    let out = std::process::Command::new("shasum").args(["-a", "256"]).stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped()).spawn().and_then(|mut c| {
            use std::io::Write;
            c.stdin.take().unwrap().write_all(b)?;
            c.wait_with_output()
        }).expect("shasum");
    String::from_utf8_lossy(&out.stdout).split_whitespace().next().unwrap_or("").to_string()
}

fn policy(e_usdc: &AccountId, e_wnear: &AccountId, pool: u64) -> Value {
    json!({"tokens": [
            {"token": e_usdc, "max_per_trade": (50 * E6).to_string(), "max_per_day": (100 * E6).to_string()},
            {"token": e_wnear, "max_per_trade": (20 * E24).to_string(), "max_per_day": (40 * E24).to_string()}],
        // Band: at least 4.00 USDC per wNEAR and 0.10 wNEAR per USDC (smallest units), well below the $4.60 pool.
        "pairs": [
            {"token_in": e_usdc, "token_out": e_wnear, "pool_id": pool, "min_price_num": (E24 / 10).to_string(), "min_price_den": E6.to_string()},
            {"token_in": e_wnear, "token_out": e_usdc, "pool_id": pool, "min_price_num": (4 * E6).to_string(), "min_price_den": E24.to_string()}],
        "max_trades_per_hour": 10, "max_slippage_bps": 100})
}

/// Build everything: tokens, Rhea with a USDC/wNEAR pool at $4.60, a funded vault.
async fn setup(register_vault_on_wnear: bool) -> R<Env> {
    // NEAR_SANDBOX_VERSION picks the nearcore release (tests/run.sh runs mainnet's and the next one).
    let sandbox = match std::env::var("NEAR_SANDBOX_VERSION") {
        Ok(v) if !v.is_empty() => near_sandbox::Sandbox::start_sandbox_with_version(&v).await?,
        _ => near_sandbox::Sandbox::start_sandbox().await?,
    };
    let net = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
    let names = ["ex", "usdc", "wnear", "vault", "owner", "agent", "eve", "lp", "intents", "mpc"];
    for n in names {
        // near-sandbox and near-api pin different near-account-id versions; cross via the string form.
        sandbox.create_account(format!("{n}.sandbox").parse()?).initial_balance(near_sdk::NearToken::from_near(100)).send().await?;
    }
    let a = |n: &str| id(&format!("{n}.sandbox"));
    let mut env = Env { _sandbox: sandbox, net, signer: signer.clone(), ex: a("ex"), usdc: a("usdc"), wnear: a("wnear"),
        vault: a("vault"), owner: a("owner"), agent: a("agent"), eve: a("eve"), lp: a("lp"),
        intents: a("intents"), mpc: a("mpc"), pool: 0 };

    let rhea = wasm("tests/res/rhea_exchange_mainnet.wasm")?;
    assert_eq!(sha256_hex(&rhea), RHEA_SHA256, "tests/res/rhea_exchange_mainnet.wasm changed; see tests/res/SOURCES.md");
    let token = wasm("../target/near/test_token/test_token.wasm")?;
    let vault = wasm("../target/near/sledgit_vault/sledgit_vault.wasm")?;

    // Tokens: the LP holds the supply and funds the owner.
    for (t, sym, dec, supply) in [(&env.usdc, "USDC", 6u8, 10_000_000 * E6), (&env.wnear, "wNEAR", 24u8, 10_000_000 * E24)] {
        near_api::Contract::deploy(t.clone()).use_code(token.clone())
            .with_init_call("new", json!({"owner_id": env.lp, "total_supply": supply.to_string(), "symbol": sym, "decimals": dec}))?
            .with_signer(signer.clone()).send_to(&env.net).await?.assert_success();
        let mut who = vec![&env.ex, &env.owner, &env.eve, &env.intents];
        if t == &env.usdc || register_vault_on_wnear { who.push(&env.vault); }
        for w in who {
            env.ok(&env.lp, t, "storage_deposit", json!({"account_id": w}), NearToken::from_millinear(10).as_yoctonear(), 30).await?;
        }
    }
    env.ok(&env.lp, &env.usdc, "ft_transfer", json!({"receiver_id": env.owner, "amount": (1_000 * E6).to_string()}), 1, 30).await?;
    env.ok(&env.lp, &env.usdc, "ft_transfer", json!({"receiver_id": env.eve, "amount": (1_000 * E6).to_string()}), 1, 30).await?;

    // Rhea: init, whitelist, pool, liquidity (100k USDC : ~21.7k wNEAR = $4.60).
    near_api::Contract::deploy(env.ex.clone()).use_code(rhea)
        .with_init_call("new", json!({"owner_id": env.ex, "boost_farm_id": env.ex, "burrowland_id": env.ex, "exchange_fee": 0, "referral_fee": 0}))?
        .with_signer(signer.clone()).send_to(&env.net).await?.assert_success();
    env.ok(&env.ex, &env.ex, "extend_whitelisted_tokens", json!({"tokens": [env.usdc, env.wnear]}), 1, 30).await?;
    let r = env.ok(&env.lp, &env.ex, "add_simple_pool", json!({"tokens": [env.usdc, env.wnear], "fee": 30}),
        NearToken::from_millinear(100).as_yoctonear(), 30).await?;
    env.pool = r.into_result()?.json::<u64>()?;
    env.ok(&env.lp, &env.ex, "storage_deposit", json!({}), NearToken::from_near(1).as_yoctonear(), 30).await?;
    let (usd, near) = (100_000 * E6, 100_000 * E24 * 100 / 460);
    for (t, amt) in [(&env.usdc, usd), (&env.wnear, near)] {
        env.ok(&env.lp, t, "ft_transfer_call", json!({"receiver_id": env.ex, "amount": amt.to_string(), "msg": ""}), 1, 100).await?;
    }
    env.ok(&env.lp, &env.ex, "add_liquidity", json!({"pool_id": env.pool, "amounts": [usd.to_string(), near.to_string()]}),
        NearToken::from_millinear(100).as_yoctonear(), 100).await?;

    // NEAR Intents: the real mainnet verifier, no fees; and the stand-in Chain Signatures signer.
    let intents = wasm("tests/res/intents_mainnet.wasm")?;
    assert_eq!(sha256_hex(&intents), INTENTS_SHA256, "tests/res/intents_mainnet.wasm changed; see tests/res/SOURCES.md");
    near_api::Contract::deploy(env.intents.clone()).use_code(intents)
        // `lp` holds the DAO role so tests can rotate salts and clean nonces the way intents.near's operators may.
        .with_init_call("new", json!({"config": {"wnear_id": env.wnear, "fees": {"fee": 0, "fee_collector": env.ex},
            "roles": {"grantees": {"DAO": [env.lp]}}}}))?
        .with_signer(signer.clone()).send_to(&env.net).await?.assert_success();
    near_api::Contract::deploy(env.mpc.clone()).use_code(wasm("../target/near/mock_mpc/mock_mpc.wasm")?)
        .without_init_call().with_signer(signer.clone()).send_to(&env.net).await?.assert_success();

    // Vault: deploy + init in one transaction signed by the vault account (`new` is private).
    near_api::Contract::deploy(env.vault.clone()).use_code(vault)
        .with_init_call("new", json!({"owner_id": env.owner, "agent_id": env.agent, "exchange_id": env.ex,
            "intents_id": env.intents, "mpc_id": env.mpc, "policy": policy(&env.usdc, &env.wnear, env.pool)}))?
        .with_signer(signer.clone()).send_to(&env.net).await?.assert_success();
    env.ok(&env.owner, &env.vault, "exchange_storage_deposit", json!({}), NearToken::from_millinear(100).as_yoctonear(), 50).await?;
    env.ok(&env.owner, &env.vault, "exchange_register_tokens", json!({}), 1, 50).await?;
    env.ok(&env.owner, &env.usdc, "ft_transfer_call", json!({"receiver_id": env.vault, "amount": (500 * E6).to_string(), "msg": ""}), 1, 100).await?;
    Ok(env)
}

// ------------------------------------------------------------------------------------------------

#[tokio::test]
async fn full_swap_against_real_rhea() -> R {
    let env = setup(true).await?;
    let (u0, n0) = (env.bal(&env.usdc, &env.vault).await?, env.bal(&env.wnear, &env.vault).await?);
    assert_eq!(u0, 500 * E6);
    let r = env.swap(46 * E6, 1).await?;
    let gas = r.clone().into_result().map(|s| s.total_gas_burnt).ok();
    let t = events(&r, "trade");
    assert_eq!(t.len(), 1, "no trade event: {:?}", r.logs());
    let out: u128 = t[0]["amount_out"].as_str().unwrap().parse()?;
    assert_eq!(t[0]["receipt_hash"], HASH);
    assert_eq!(env.bal(&env.usdc, &env.vault).await?, u0 - 46 * E6);
    assert_eq!(env.bal(&env.wnear, &env.vault).await?, n0 + out, "event amount_out must equal the balance change");
    // ~10 wNEAR for $46 at $4.60 less the 0.3% pool fee and price impact.
    assert!(out > 99 * E24 / 10 && out < 10 * E24, "out {out}");
    assert_nothing_held(&env).await?;
    assert!(env.view::<Option<Value>>(&env.vault, "get_in_flight", json!({})).await?.is_none());
    println!("swap gas burnt: {gas:?}");
    Ok(())
}

#[tokio::test]
async fn refusal_is_recorded_on_chain_and_moves_nothing() -> R {
    let env = setup(true).await?;
    let r = env.swap(60 * E6, 1).await?;
    assert!(r.clone().into_result().is_ok(), "a refusal must not fail the transaction");
    assert_eq!(events(&r, "refuse")[0]["code"], "trade_cap");
    assert_eq!(env.bal(&env.usdc, &env.vault).await?, 500 * E6);
    let p: Value = env.view(&env.vault, "preview_swap", json!({"token_in": env.usdc, "token_out": env.wnear,
        "amount_in": (60 * E6).to_string(), "min_amount_out": "1"})).await?;
    assert_eq!(p["code"], "trade_cap");
    Ok(())
}

#[tokio::test]
async fn min_above_quote_fails_before_funds_move() -> R {
    let env = setup(true).await?;
    let r = env.swap(10 * E6, 1_000 * E24).await?;
    assert!(events(&r, "failed")[0]["reason"].as_str().unwrap().contains("above the exchange quote"));
    assert_eq!(env.bal(&env.usdc, &env.vault).await?, 500 * E6);
    assert_nothing_held(&env).await?;
    Ok(())
}

#[tokio::test]
async fn private_methods_cannot_be_called_from_outside() -> R {
    let env = setup(true).await?;
    for (m, args) in [("on_quote", json!({"seq": 1})), ("on_deposit", json!({"seq": 1, "quote": "1"})),
                      ("on_swap", json!({"seq": 1, "quote": "1"})),
                      ("on_withdraw", json!({"seq": 1, "quote": "1", "swapped": true, "token": env.usdc, "amount": "1"})),
                      ("new", json!({"owner_id": env.eve, "agent_id": env.agent, "exchange_id": env.ex,
                                     "intents_id": "intents.sandbox", "mpc_id": "mpc.sandbox",
                                     "policy": policy(&env.usdc, &env.wnear, env.pool)}))] {
        let r = env.call(&env.eve, &env.vault, m, args, 0, 50).await?;
        assert!(r.into_result().is_err(), "{m} must reject outside callers");
    }
    Ok(())
}

#[tokio::test]
async fn only_agent_trades_and_only_owner_withdraws() -> R {
    let env = setup(true).await?;
    let r = env.call(&env.eve, &env.vault, "request_swap", json!({"token_in": env.usdc, "token_out": env.wnear,
        "amount_in": "1", "min_amount_out": "1", "receipt_hash": HASH}), 0, 300).await?;
    assert!(r.into_result().is_err());
    for who in [&env.agent, &env.eve] {
        let r = env.call(who, &env.vault, "withdraw", json!({"token": env.usdc, "amount": "1"}), 1, 50).await?;
        assert!(r.into_result().is_err(), "{who} withdrew");
    }
    // Owner without the 1-yocto proof of a full-access key is rejected.
    assert!(env.call(&env.owner, &env.vault, "withdraw", json!({"token": env.usdc, "amount": "1"}), 0, 50).await?.into_result().is_err());
    let before = env.bal(&env.usdc, &env.owner).await?;
    env.ok(&env.owner, &env.vault, "withdraw", json!({"token": env.usdc, "amount": (100 * E6).to_string()}), 1, 50).await?;
    assert_eq!(env.bal(&env.usdc, &env.owner).await?, before + 100 * E6);
    Ok(())
}

#[tokio::test]
async fn deposits_from_strangers_are_refunded() -> R {
    let env = setup(true).await?;
    let before = env.bal(&env.usdc, &env.eve).await?;
    env.ok(&env.eve, &env.usdc, "ft_transfer_call", json!({"receiver_id": env.vault, "amount": (5 * E6).to_string(), "msg": ""}), 1, 100).await?;
    assert_eq!(env.bal(&env.usdc, &env.eve).await?, before);
    assert_eq!(env.bal(&env.usdc, &env.vault).await?, 500 * E6);
    Ok(())
}

#[tokio::test]
async fn agent_freeze_stops_trading_until_owner_unfreezes() -> R {
    let env = setup(true).await?;
    env.ok(&env.agent, &env.vault, "freeze", json!({}), 0, 30).await?;
    assert_eq!(events(&env.swap(10 * E6, 1).await?, "refuse")[0]["code"], "frozen");
    assert!(env.call(&env.agent, &env.vault, "unfreeze", json!({}), 1, 30).await?.into_result().is_err());
    env.ok(&env.owner, &env.vault, "unfreeze", json!({}), 1, 30).await?;
    assert_eq!(events(&env.swap(10 * E6, 1).await?, "trade").len(), 1);
    Ok(())
}

/// Settles audit question 4: what the vault sees when Rhea cannot pay it out.
#[tokio::test]
async fn payout_to_unregistered_vault_is_detected_and_recoverable() -> R {
    let env = setup(false).await?;
    let r = env.swap(46 * E6, 1).await?;
    let trade = events(&r, "trade");
    let deposits = env.rhea_deposits(&env.vault).await?;
    println!("trade event: {trade:?}\nleft on exchange: {deposits}");
    assert_eq!(env.bal(&env.wnear, &env.vault).await?, 0);
    let stuck: u128 = deposits[env.wnear.as_str()].as_str().unwrap_or("0").parse()?;
    assert!(stuck > 0, "output should be held on the exchange for the vault");
    assert_eq!(trade[0]["returned"], false, "the record must not claim the output reached the vault");
    // Recovery: register the vault on the token, then pull the balance back.
    env.ok(&env.lp, &env.wnear, "storage_deposit", json!({"account_id": env.vault}), NearToken::from_millinear(10).as_yoctonear(), 30).await?;
    env.ok(&env.owner, &env.vault, "exchange_withdraw", json!({"token": env.wnear, "amount": stuck.to_string()}), 1, 200).await?;
    assert_eq!(env.bal(&env.wnear, &env.vault).await?, stuck);
    Ok(())
}

/// Round 3 L-1: Rhea parks a payout it can neither deliver nor re-credit in the vault's lostfound (or, short of spare
/// NEAR, gives it to its own owner). The vault's record counts a payout as returned only when its own balance rose, and
/// the owner can claim a lostfound balance back, recorded at what arrived.
#[tokio::test]
async fn lostfound_payout_is_detected_and_claimed() -> R {
    let env = setup(false).await?; // the vault isn't registered on wNEAR, so Rhea can't pay it out
    env.swap(46 * E6, 1).await?;
    let stuck: u128 = env.rhea_deposits(&env.vault).await?[env.wnear.as_str()].as_str().unwrap_or("0").parse()?;
    assert!(stuck > 0);
    // Rhea parks a payout in a user's lostfound only while it has spare NEAR of its own (otherwise the exchange owner
    // gets it, which the vault also counts as "not back"); fund it like a live exchange.
    near_api::Tokens::account(id("sandbox")).send_to(env.ex.clone()).near(NearToken::from_near(5_000))
        .with_signer(env.signer.clone()).send_to(&env.net).await?.assert_success();
    // Force Rhea's lostfound path (sandbox only: the vault account still holds the genesis key here). Withdraw with
    // unregister=true and, in the same receipt, take back the exchange storage, so the failed payout can't be re-credited.
    let fc = |m: &str, args: Value| Action::FunctionCall(Box::new(FunctionCallAction { method_name: m.into(),
        args: args.to_string().into_bytes(), gas: NearGas::from_tgas(100), deposit: NearToken::from_yoctonear(1) }));
    let r = near_api::Transaction::construct(env.vault.clone(), env.ex.clone())
        .add_action(fc("withdraw", json!({"token_id": env.wnear, "amount": stuck.to_string(), "unregister": true})))
        .add_action(fc("storage_withdraw", json!({})))
        .with_signer(env.signer.clone()).send_to(&env.net).await?;
    assert!(r.logs().iter().any(|l| l.contains("Depositing to user lostfound account")), "{:?}", r.logs());
    let lost = |env: &Env| { let (ex, v, t) = (env.ex.clone(), env.vault.clone(), env.wnear.clone());
        let net = env.net.clone();
        async move { near_api::Contract(ex).call_function("get_lostfound_token", json!({"account_id": v, "token_id": t}))
            .read_only::<String>().fetch_from(&net).await.map(|d| d.data.parse::<u128>().unwrap()) } };
    assert_eq!(lost(&env).await?, stuck, "the payout sits in the vault's lostfound");
    // A later trade whose output really arrives is "returned"; the parked payout doesn't taint it.
    env.ok(&env.lp, &env.wnear, "storage_deposit", json!({"account_id": env.vault}), NearToken::from_millinear(10).as_yoctonear(), 30).await?;
    env.ok(&env.owner, &env.vault, "exchange_storage_deposit", json!({}), NearToken::from_millinear(100).as_yoctonear(), 50).await?;
    env.ok(&env.owner, &env.vault, "exchange_register_tokens", json!({}), 1, 50).await?;
    let t = events(&env.swap(2 * E6, 1).await?, "trade");
    assert_eq!(t[0]["returned"], true, "{t:?}");
    // The owner claims it; only what reached the vault is recorded.
    let before = env.bal(&env.wnear, &env.vault).await?;
    let r = env.ok(&env.owner, &env.vault, "exchange_claim_lostfound", json!({"token": env.wnear}), 1, 200).await?;
    let c = events(&r, "exchange_lostfound_claim");
    assert_eq!(c[0]["amount"], stuck.to_string(), "{:?}", r.logs());
    assert_eq!(env.bal(&env.wnear, &env.vault).await?, before + stuck);
    assert_eq!(lost(&env).await?, 0);
    // Only the owner may claim.
    assert!(env.call(&env.agent, &env.vault, "exchange_claim_lostfound", json!({"token": env.wnear}), 1, 200).await?.into_result().is_err());
    Ok(())
}

#[tokio::test]
async fn locked_vault_cannot_be_redeployed() -> R {
    let env = setup(true).await?;
    let pk = env.signer.get_public_key().await?;
    near_api::Account(env.vault.clone()).delete_key(pk).with_signer(env.signer.clone()).send_to(&env.net).await?.assert_success();
    let r = near_api::Contract::deploy(env.vault.clone()).use_code(wasm("../target/near/test_token/test_token.wasm")?)
        .without_init_call().with_signer(env.signer.clone()).send_to(&env.net).await;
    assert!(r.is_err() || r.unwrap().into_result().is_err(), "a keyless vault must not accept new code");
    // Still works for the owner after locking.
    env.ok(&env.owner, &env.vault, "withdraw", json!({"token": env.usdc, "amount": "1"}), 1, 50).await?;
    Ok(())
}

// ------------------------------------------------------------------------------------------------ NEAR Intents

mod intents {
    use super::*;
    use k256::ecdsa::SigningKey;
    use near_sdk::json_types::Base64VecU8;
    use sha3::{Digest, Keccak256};

    fn keccak(b: &[u8]) -> [u8; 32] { Keccak256::digest(b).into() }

    /// A market maker with its own secp256k1 key; on intents.near its account is the implicit 0x address.
    struct Solver { key: SigningKey, addr: String }

    impl Solver {
        fn new() -> Self {
            let key = SigningKey::from_bytes(&[42u8; 32].into()).unwrap();
            let point = key.verifying_key().to_encoded_point(false);
            let addr = format!("0x{}", keccak(&point.as_bytes()[1..])[12..].iter().map(|b| format!("{b:02x}")).collect::<String>());
            Self { key, addr }
        }
        /// The counter-intent: gives `out` of token_out, takes `amount_in` of token_in.
        fn quote(&self, env: &Env, amount_in: u128, out: u128, nonce: u8) -> Value {
            let payload = json!({"signer_id": self.addr, "verifying_contract": env.intents, "deadline": "2030-01-01T00:00:00Z",
                "nonce": near_sdk::serde_json::to_value(Base64VecU8(vec![nonce; 32])).unwrap(),
                "intents": [{"intent": "token_diff", "diff": {
                    format!("nep141:{}", env.usdc): amount_in.to_string(), format!("nep141:{}", env.wnear): format!("-{out}")}}]}).to_string();
            let mut msg = format!("\x19Ethereum Signed Message:\n{}", payload.len()).into_bytes();
            msg.extend_from_slice(payload.as_bytes());
            let (sig, recid) = self.key.sign_prehash_recoverable(&keccak(&msg)).unwrap();
            let mut raw = sig.to_bytes().to_vec();
            raw.push(u8::from(recid.is_y_odd()));
            json!({"standard": "erc191", "payload": payload, "signature": format!("secp256k1:{}", bs58::encode(raw).into_string())})
        }
    }

    async fn ibal(env: &Env, who: &str, token: &AccountId) -> R<u128> {
        let v: String = env.view(&env.intents, "mt_balance_of", json!({"account_id": who, "token_id": format!("nep141:{token}")})).await?;
        Ok(v.parse()?)
    }

    /// Vault with its key registered, 100 USDC on intents.near; a solver holding 100 wNEAR there.
    async fn ready() -> R<(Env, Solver)> {
        let env = setup(true).await?;
        env.ok(&env.owner, &env.vault, "intents_setup", json!({}), 1, 100).await?;
        let cfg: Value = env.view(&env.vault, "get_intents", json!({})).await?;
        let keys: Vec<String> = env.view(&env.intents, "public_keys_of", json!({"account_id": env.vault})).await?;
        assert!(keys.contains(&cfg["public_key"].as_str().unwrap().to_string()), "vault key not registered: {keys:?} vs {cfg}");
        env.ok(&env.owner, &env.vault, "intents_deposit", json!({"token": env.usdc, "amount": (100 * E6).to_string()}), 1, 150).await?;
        assert_eq!(ibal(&env, env.vault.as_str(), &env.usdc).await?, 100 * E6);
        let solver = Solver::new();
        env.ok(&env.lp, &env.wnear, "ft_transfer_call", json!({"receiver_id": env.intents, "amount": (100 * E24).to_string(),
            "msg": solver.addr}), 1, 100).await?;
        assert_eq!(ibal(&env, &solver.addr, &env.wnear).await?, 100 * E24);
        Ok((env, solver))
    }

    async fn authorize(env: &Env, amount: u128) -> R<Value> {
        let r = env.call(&env.agent, &env.vault, "request_intent_swap", json!({"token_in": env.usdc,
            "token_out": env.wnear, "amount_in": amount.to_string(), "min_amount_out": "1", "receipt_hash": HASH}), 0, 300).await?;
        let a = events(&r, "intent_authorized");
        assert_eq!(a.len(), 1, "not authorized: {:?}", r.logs());
        Ok(a[0].clone())
    }

    async fn execute(env: &Env, signed: Vec<Value>) -> R<bool> {
        Ok(env.call(&env.lp, &env.intents, "execute_intents", json!({"signed": signed}), 0, 300).await?.into_result().is_ok())
    }

    #[tokio::test]
    async fn swap_settles_against_a_solver_and_withdraws() -> R {
        let (env, solver) = ready().await?;
        let a = authorize(&env, 46 * E6).await?;
        let min_out: u128 = a["min_amount_out"].as_str().unwrap().parse()?;
        let quote: u128 = a["quote"].as_str().unwrap().parse()?;
        assert_eq!(min_out, quote / 10_000 * 9_900 + quote % 10_000 * 9_900 / 10_000, "Rhea quote less the policy's 1% slippage");
        let nonce = near_sdk::serde_json::from_value::<Base64VecU8>(a["nonce"].clone())?.0;
        assert_eq!(&nonce[..5], &[0x56, 0x28, 0xf6, 0xc6, 0], "versioned V1 nonce");
        assert!(execute(&env, vec![a["multi_payload"].clone(), solver.quote(&env, 46 * E6, min_out, 1)]).await?, "settlement failed");
        // Anyone records the outcome: intents.near says the nonce was used, so it is a trade at exactly min_out.
        let r = env.ok(&env.eve, &env.vault, "intents_settle", json!({}), 0, 100).await?;
        let t = events(&r, "trade");
        assert_eq!((t[0]["venue"].as_str(), t[0]["amount_out"].as_str()), (Some("intents"), a["min_amount_out"].as_str()));
        assert_eq!(ibal(&env, env.vault.as_str(), &env.usdc).await?, 54 * E6);
        assert_eq!(ibal(&env, env.vault.as_str(), &env.wnear).await?, min_out);
        assert_eq!(ibal(&env, &solver.addr, &env.usdc).await?, 46 * E6);
        // The same signed intent cannot be used twice.
        assert!(!execute(&env, vec![a["multi_payload"].clone(), solver.quote(&env, 46 * E6, min_out, 2)]).await?, "replay settled");
        // Back to the vault itself.
        let before = env.bal(&env.wnear, &env.vault).await?;
        env.ok(&env.owner, &env.vault, "intents_withdraw", json!({"token": env.wnear, "amount": min_out.to_string()}), 1, 100).await?;
        assert_eq!(env.bal(&env.wnear, &env.vault).await?, before + min_out);
        assert_eq!(ibal(&env, env.vault.as_str(), &env.wnear).await?, 0);
        Ok(())
    }

    #[tokio::test]
    async fn solver_cannot_pay_less_or_tamper() -> R {
        let (env, solver) = ready().await?;
        let a = authorize(&env, 46 * E6).await?;
        let min_out: u128 = a["min_amount_out"].as_str().unwrap().parse()?;
        assert!(!execute(&env, vec![a["multi_payload"].clone(), solver.quote(&env, 46 * E6, min_out - 1, 3)]).await?, "underpaid fill settled");
        let mut forged = a["multi_payload"].clone();
        let p = forged["payload"].as_str().unwrap().replace(&format!("\"{min_out}\""), &format!("\"{}\"", min_out / 2));
        forged["payload"] = json!(p);
        assert!(!execute(&env, vec![forged, solver.quote(&env, 46 * E6, min_out / 2, 4)]).await?, "tampered intent settled");
        assert_eq!(ibal(&env, env.vault.as_str(), &env.usdc).await?, 100 * E6);
        Ok(())
    }

    #[tokio::test]
    async fn cancel_burns_the_nonce_and_releases_the_cap() -> R {
        let (env, solver) = ready().await?;
        let a = authorize(&env, 46 * E6).await?;
        let min_out: u128 = a["min_amount_out"].as_str().unwrap().parse()?;
        let r = env.call(&env.agent, &env.vault, "intents_cancel", json!({}), 0, 300).await?;
        assert_eq!(events(&r, "intent_cancelled").len(), 1, "not cancelled: {:?}", r.logs());
        assert!(!execute(&env, vec![a["multi_payload"].clone(), solver.quote(&env, 46 * E6, min_out, 5)]).await?, "cancelled intent settled");
        let u: Value = env.view(&env.vault, "get_usage", json!({})).await?;
        assert_eq!(u["spent"][0][1], "0");
        Ok(())
    }

    /// Settle (anyone may), retrying while the sandbox clock passes the deadline; returns the settle's events.
    async fn settle_after_deadline(env: &Env) -> R<TransactionResult> {
        env._sandbox.fast_forward(400).await?;
        for _ in 0..40 {
            let r = env.call(&env.eve, &env.vault, "intents_settle", json!({}), 0, 100).await?;
            if r.logs().iter().any(|l| ["intent_expired", "intent_unresolved", "\"event\":\"trade\""].iter().any(|k| l.contains(k))) {
                return Ok(r);
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
        Err("settle never recorded an outcome".into())
    }

    async fn spent_usdc(env: &Env) -> R<String> {
        let u: Value = env.view(&env.vault, "get_usage", json!({})).await?;
        Ok(u["spent"][0][1].as_str().unwrap_or("").to_string())
    }

    /// Round 3 M-1 (the round 3 PoC, now a regression test): after a real fill, intents.near's salt rotation plus
    /// garbage collection deletes the used nonce. The vault must not call that an expiry or give the cap back.
    #[tokio::test]
    async fn salt_invalidation_after_a_fill_is_unresolved_not_expired() -> R {
        let (env, solver) = ready().await?;
        let a = authorize(&env, 46 * E6).await?;
        let min_out: u128 = a["min_amount_out"].as_str().unwrap().parse()?;
        assert!(execute(&env, vec![a["multi_payload"].clone(), solver.quote(&env, 46 * E6, min_out, 1)]).await?);
        assert_eq!(ibal(&env, env.vault.as_str(), &env.usdc).await?, 54 * E6, "the fill happened");
        let salt: String = env.view(&env.intents, "current_salt", json!({})).await?;
        env.ok(&env.lp, &env.intents, "invalidate_salts", json!({"salts": [salt]}), 1, 50).await?;
        env.ok(&env.lp, &env.intents, "cleanup_nonces", json!({"nonces": [[env.vault, [a["nonce"]]]]}), 1, 100).await?;
        let used: bool = env.view(&env.intents, "is_nonce_used", json!({"account_id": env.vault, "nonce": a["nonce"]})).await?;
        assert!(!used, "intents.near really deleted the used nonce");
        let r = settle_after_deadline(&env).await?;
        assert!(events(&r, "intent_expired").is_empty(), "a fill recorded as an expiry: {:?}", r.logs());
        assert_eq!(events(&r, "intent_unresolved").len(), 1, "{:?}", r.logs());
        assert_eq!(spent_usdc(&env).await?, (46 * E6).to_string(), "the cap stays reserved");
        Ok(())
    }

    /// The same nonce check, salt untouched: an unfilled intent past its deadline is an expiry and frees its cap
    /// (shows the vault's `is_valid_salt` call matches the real intents.near).
    #[tokio::test]
    async fn unfilled_intent_with_a_valid_salt_expires_and_releases() -> R {
        let (env, _) = ready().await?;
        authorize(&env, 46 * E6).await?;
        let r = settle_after_deadline(&env).await?;
        assert_eq!(events(&r, "intent_expired").len(), 1, "{:?}", r.logs());
        assert_eq!(spent_usdc(&env).await?, "0");
        Ok(())
    }

    /// Unfilled, but the salt was rotated: intents.near could have cleaned a used nonce, so it's unresolved, cap kept.
    #[tokio::test]
    async fn unfilled_intent_with_an_invalidated_salt_keeps_the_cap() -> R {
        let (env, _) = ready().await?;
        authorize(&env, 46 * E6).await?;
        let salt: String = env.view(&env.intents, "current_salt", json!({})).await?;
        env.ok(&env.lp, &env.intents, "invalidate_salts", json!({"salts": [salt]}), 1, 50).await?;
        let r = settle_after_deadline(&env).await?;
        assert_eq!(events(&r, "intent_unresolved").len(), 1, "{:?}", r.logs());
        assert_eq!(spent_usdc(&env).await?, (46 * E6).to_string());
        Ok(())
    }

    #[tokio::test]
    async fn policy_and_one_open_intent() -> R {
        let (env, _) = ready().await?;
        let r = env.call(&env.agent, &env.vault, "request_intent_swap", json!({"token_in": env.usdc,
            "token_out": env.wnear, "amount_in": (60 * E6).to_string(), "min_amount_out": "1", "receipt_hash": HASH}), 0, 300).await?;
        assert_eq!(events(&r, "refuse")[0]["code"], "trade_cap");
        authorize(&env, 10 * E6).await?;
        let r = env.call(&env.agent, &env.vault, "request_intent_swap", json!({"token_in": env.usdc,
            "token_out": env.wnear, "amount_in": (10 * E6).to_string(), "min_amount_out": "1", "receipt_hash": HASH}), 0, 300).await?;
        assert_eq!(events(&r, "refuse")[0]["code"], "busy");
        assert_eq!(events(&env.swap(10 * E6, 1).await?, "refuse")[0]["code"], "busy");
        Ok(())
    }

    #[tokio::test]
    async fn only_the_owner_moves_funds_and_callbacks_are_private() -> R {
        let (env, _) = ready().await?;
        for who in [&env.agent, &env.eve] {
            for (m, args) in [("intents_deposit", json!({"token": env.usdc, "amount": "1"})),
                              ("intents_withdraw", json!({"token": env.usdc, "amount": "1"})),
                              ("intents_setup", json!({}))] {
                assert!(env.call(who, &env.vault, m, args, 1, 100).await?.into_result().is_err(), "{who} called {m}");
            }
        }
        for (m, args) in [("on_intents_key", json!({})), ("on_intent_quote", json!({"seq": 1})),
                          ("on_intent_signed", json!({"seq": 1, "payload": "x", "quote": "1"})),
                          ("on_cancel_signed", json!({"seq": 1, "payload": "x"})), ("on_cancelled", json!({"seq": 1})),
                          ("on_settle", json!({"seq": 1, "may_expire": true})), ("on_settle_salt", json!({"seq": 1}))] {
            assert!(env.call(&env.eve, &env.vault, m, args, 0, 50).await?.into_result().is_err(), "{m} is callable from outside");
        }
        // Nobody but the vault's code can sign for its intents account: a direct execute with a key-less payload fails.
        let solver = Solver::new();
        let mut fake = solver.quote(&env, 1, 1, 9);
        let p = fake["payload"].as_str().unwrap().replace(&solver.addr, env.vault.as_str());
        fake["payload"] = json!(p);
        assert!(!execute(&env, vec![fake]).await?, "a foreign key signed for the vault");
        Ok(())
    }
}

// ------------------------------------------------------------------------------------------------ factory

mod factory {
    use super::*;

    fn b58_sha256(code: &[u8]) -> String {
        let hex = sha256_hex(code);
        let bytes: Vec<u8> = (0..64).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
        bs58::encode(bytes).into_string()
    }

    /// Publish the vault code once (global, by hash) and deploy a factory pinned to it.
    async fn factory(env: &Env) -> R<(AccountId, String)> { factory_with(env, NearToken::from_near(50), None).await }
    async fn factory_capped(env: &Env, caps: Value) -> R<(AccountId, String)> {
        factory_args(env, NearToken::from_near(50), None, Some(caps)).await
    }

    /// A factory with a given starting balance and season maximum deposit.
    async fn factory_with(env: &Env, balance: NearToken, max_deposit: Option<NearToken>) -> R<(AccountId, String)> {
        factory_args(env, balance, max_deposit, None).await
    }
    async fn factory_args(env: &Env, balance: NearToken, max_deposit: Option<NearToken>, caps: Option<Value>) -> R<(AccountId, String)> {
        let code = wasm("../target/near/sledgit_vault/sledgit_vault.wasm")?;
        let hash = b58_sha256(&code);
        near_api::Contract::deploy_global_contract_code(code).as_hash()
            .with_signer(env.lp.clone(), env.signer.clone()).send_to(&env.net).await?.assert_success();
        let f = id("factory.sandbox");
        env._sandbox.create_account(f.as_str().parse()?).initial_balance(near_sdk::NearToken::from_yoctonear(balance.as_yoctonear()))
            .send().await?;
        let mut args = json!({"code_hash": hash, "exchange_id": env.ex, "intents_id": env.intents, "mpc_id": env.mpc,
            "min_deposit": NearToken::from_near(1).as_yoctonear().to_string()});
        if let Some(m) = max_deposit { args["max_deposit"] = json!(m.as_yoctonear().to_string()); }
        if let Some(c) = caps { args["deposit_caps"] = c; }
        args["admin"] = json!(env.lp);
        near_api::Contract::deploy(f.clone()).use_code(wasm("../target/near/sledgit_factory/sledgit_factory.wasm")?)
            .with_init_call("new", args)?
            .with_signer(env.signer.clone()).send_to(&env.net).await?.assert_success();
        Ok((f, hash))
    }

    async fn free(env: &Env, a: &AccountId) -> R<u128> {
        let b = near_api::Tokens::account(a.clone()).near_balance().fetch_from(&env.net).await?;
        Ok(b.total.as_yoctonear().saturating_sub(b.storage_locked.as_yoctonear()))
    }
    async fn total(env: &Env, a: &AccountId) -> R<u128> {
        Ok(near_api::Tokens::account(a.clone()).near_balance().fetch_from(&env.net).await?.total.as_yoctonear())
    }

    async fn create(env: &Env, f: &AccountId, name: &str, policy_json: Value) -> R<TransactionResult> {
        env.call(&env.owner, f, "create_vault", json!({"name": name, "owner_id": env.owner, "agent_id": env.agent, "policy": policy_json}),
            NearToken::from_near(3).as_yoctonear(), 150).await
    }

    fn fevents(r: &TransactionResult, kind: &str) -> usize {
        r.logs().iter().filter(|l| l.contains("\"standard\":\"sledgit-factory\"") && l.contains(&format!("\"event\":\"{kind}\""))).count()
    }

    #[tokio::test]
    async fn factory_vault_is_keyless_pinned_and_trades() -> R {
        let env = setup(true).await?;
        let (f, hash) = factory(&env).await?;
        let r = create(&env, &f, "claude", policy(&env.usdc, &env.wnear, env.pool)).await?;
        assert_eq!(fevents(&r, "vault_created"), 1, "{:?}", r.logs());
        let v = id("claude.factory.sandbox");
        // Contracts come from the factory, not the creator.
        let cfg: Value = env.view(&v, "get_config", json!({})).await?;
        assert_eq!((cfg["exchange_id"].as_str(), cfg["mpc_id"].as_str()), (Some(env.ex.as_str()), Some(env.mpc.as_str())));
        let keys = near_api::Account(v.clone()).list_keys().fetch_from(&env.net).await?.data;
        assert!(keys.is_empty(), "factory vault must have no access keys");
        let account = near_api::Account(v.clone()).view().fetch_from(&env.net).await?.data;
        assert!(format!("{account:?}").contains(&hash), "vault must run the pinned global code: {account:?}");
        let listed: Vec<String> = env.view(&f, "get_vaults", json!({"from_index": 0, "limit": 10})).await?;
        assert_eq!(listed, vec![v.to_string()]);
        // The vault works like a directly deployed one: set up and trade on Rhea.
        for t in [&env.usdc, &env.wnear] {
            env.ok(&env.lp, t, "storage_deposit", json!({"account_id": v}), NearToken::from_millinear(10).as_yoctonear(), 30).await?;
        }
        env.ok(&env.owner, &v, "exchange_storage_deposit", json!({}), NearToken::from_millinear(100).as_yoctonear(), 50).await?;
        env.ok(&env.owner, &v, "exchange_register_tokens", json!({}), 1, 50).await?;
        env.ok(&env.owner, &env.usdc, "ft_transfer_call", json!({"receiver_id": v, "amount": (100 * E6).to_string(), "msg": ""}), 1, 100).await?;
        let r = env.call(&env.agent, &v, "request_swap", json!({"token_in": env.usdc, "token_out": env.wnear,
            "amount_in": (20 * E6).to_string(), "min_amount_out": "1", "receipt_hash": HASH}), 0, 300).await?;
        assert_eq!(events(&r, "trade").len(), 1, "{:?}", r.logs());
        // Nobody can re-initialise it.
        let r = env.call(&env.eve, &v, "new", json!({"owner_id": env.eve, "agent_id": env.agent, "exchange_id": env.ex,
            "intents_id": env.intents, "mpc_id": env.eve, "policy": policy(&env.usdc, &env.wnear, env.pool)}), 0, 50).await?;
        assert!(r.into_result().is_err());
        Ok(())
    }

    #[tokio::test]
    async fn factory_deposit_cap_returns_the_excess_on_chain() -> R {
        let env = setup(true).await?;
        let (f, _) = factory_capped(&env, json!([{"token": env.usdc, "max": (20 * E6).to_string()}])).await?;
        let r = create(&env, &f, "capped", policy(&env.usdc, &env.wnear, env.pool)).await?;
        assert_eq!(fevents(&r, "vault_created"), 1, "{:?}", r.logs());
        let v = id("capped.factory.sandbox");
        let fcfg: Value = env.view(&f, "get_config", json!({})).await?;
        assert_eq!(fcfg["deposit_caps"][0]["max"], json!((20 * E6).to_string()));
        for t in [&env.usdc, &env.wnear] {
            env.ok(&env.lp, t, "storage_deposit", json!({"account_id": v}), NearToken::from_millinear(10).as_yoctonear(), 30).await?;
        }
        let before = env.bal(&env.usdc, &env.owner).await?;
        // 30 USDC against a 20 USDC cap: 20 stay, 10 come back in the same call.
        env.ok(&env.owner, &env.usdc, "ft_transfer_call", json!({"receiver_id": v, "amount": (30 * E6).to_string(), "msg": ""}), 1, 100).await?;
        assert_eq!(env.bal(&env.usdc, &v).await?, 20 * E6);
        assert_eq!(before - env.bal(&env.usdc, &env.owner).await?, 20 * E6);
        // At the cap: everything comes back.
        env.ok(&env.owner, &env.usdc, "ft_transfer_call", json!({"receiver_id": v, "amount": (1 * E6).to_string(), "msg": ""}), 1, 100).await?;
        assert_eq!(env.bal(&env.usdc, &v).await?, 20 * E6);
        // Withdrawing frees the room again.
        env.ok(&env.owner, &v, "withdraw", json!({"token": env.usdc, "amount": (5 * E6).to_string()}), 1, 100).await?;
        let caps: Value = env.view(&v, "get_deposit_caps", json!({})).await?;
        assert_eq!(caps[0]["net_deposited"], json!((15 * E6).to_string()));
        env.ok(&env.owner, &env.usdc, "ft_transfer_call", json!({"receiver_id": v, "amount": (5 * E6).to_string(), "msg": ""}), 1, 100).await?;
        assert_eq!(env.bal(&env.usdc, &v).await?, 20 * E6);
        Ok(())
    }

    #[tokio::test]
    async fn admin_raises_the_cap_and_pushes_it_to_existing_vaults() -> R {
        let env = setup(true).await?;
        let (f, _) = factory_capped(&env, json!([{"token": env.usdc, "max": (20 * E6).to_string()}])).await?;
        create(&env, &f, "later", policy(&env.usdc, &env.wnear, env.pool)).await?;
        let v = id("later.factory.sandbox");
        env.ok(&env.lp, &env.usdc, "storage_deposit", json!({"account_id": v}), NearToken::from_millinear(10).as_yoctonear(), 30).await?;
        env.ok(&env.owner, &env.usdc, "ft_transfer_call", json!({"receiver_id": v, "amount": (30 * E6).to_string(), "msg": ""}), 1, 100).await?;
        assert_eq!(env.bal(&env.usdc, &v).await?, 20 * E6, "old cap holds");
        // Only the admin can change it, and the vault only takes caps from its factory.
        let r = env.call(&env.owner, &f, "set_deposit_caps", json!({"deposit_caps": []}), 1, 30).await?;
        assert!(r.into_result().is_err(), "owner isn't admin");
        let r = env.call(&env.owner, &v, "set_deposit_caps", json!({"deposit_caps": []}), 0, 30).await?;
        assert!(r.into_result().is_err(), "the vault takes caps only from its factory");
        env.ok(&env.lp, &f, "set_deposit_caps", json!({"deposit_caps": [{"token": env.usdc, "max": (50 * E6).to_string()}]}), 1, 30).await?;
        env.ok(&env.eve, &f, "push_deposit_caps", json!({"limit": 25}), 0, 300).await?;
        let caps: Value = env.view(&v, "get_deposit_caps", json!({})).await?;
        assert_eq!(caps[0]["max"], json!((50 * E6).to_string()));
        env.ok(&env.owner, &env.usdc, "ft_transfer_call", json!({"receiver_id": v, "amount": (30 * E6).to_string(), "msg": ""}), 1, 100).await?;
        assert_eq!(env.bal(&env.usdc, &v).await?, 50 * E6, "new cap applies to the existing vault");
        // Renounced: nobody can change it again.
        env.ok(&env.lp, &f, "renounce_admin", json!({}), 1, 30).await?;
        let r = env.call(&env.lp, &f, "set_deposit_caps", json!({"deposit_caps": []}), 1, 30).await?;
        assert!(r.into_result().is_err());
        Ok(())
    }

    #[tokio::test]
    async fn push_reaches_each_vault_once_at_the_minimum_gas() -> R {
        let env = setup(true).await?;
        let (f, _) = factory_capped(&env, json!([{"token": env.usdc, "max": (20 * E6).to_string()}])).await?;
        for n in ["pa", "pb", "pc"] { create(&env, &f, n, policy(&env.usdc, &env.wnear, env.pool)).await?; }
        env.ok(&env.lp, &f, "set_deposit_caps", json!({"deposit_caps": [{"token": env.usdc, "max": (7 * E6).to_string()}]}), 1, 30).await?;
        // 3 vaults: (8 + 2) * 3 + 10 = 40 Tgas, exactly what the contract asks for.
        let r = env.call(&env.eve, &f, "push_deposit_caps", json!({"limit": 25}), 0, 39).await?;
        assert!(r.into_result().is_err(), "39 Tgas is refused");
        env.ok(&env.eve, &f, "push_deposit_caps", json!({"limit": 25}), 0, 40).await?;
        for n in ["pa", "pb", "pc"] {
            let caps: Value = env.view(&id(&format!("{n}.factory.sandbox")), "get_deposit_caps", json!({})).await?;
            assert_eq!(caps[0]["max"], json!((7 * E6).to_string()), "{n} updated with the minimum gas");
        }
        // Everything is up to date: a repeat push sends nothing (no history spam).
        let r = env.ok(&env.eve, &f, "push_deposit_caps", json!({"limit": 25}), 0, 300).await?;
        assert!(!r.logs().iter().any(|l| l.contains("deposit_caps_pushed")), "{:?}", r.logs());
        let cfg: Value = env.view(&f, "get_config", json!({})).await?;
        assert_eq!(cfg["push_cursor"], json!(3));
        Ok(())
    }

    #[tokio::test]
    async fn failed_creation_creates_nothing_and_refunds() -> R {
        let env = setup(true).await?;
        let (f, _) = factory(&env).await?;
        create(&env, &f, "dup", policy(&env.usdc, &env.wnear, env.pool)).await?;
        let before = near_api::Tokens::account(env.owner.clone()).near_balance().fetch_from(&env.net).await?.total;
        // Same name again, and an invalid policy: both refused by the batch, deposit refunded.
        let r = create(&env, &f, "dup", policy(&env.usdc, &env.wnear, env.pool)).await?;
        assert_eq!(fevents(&r, "vault_create_failed"), 1, "{:?}", r.logs());
        let mut bad = policy(&env.usdc, &env.wnear, env.pool);
        bad["max_slippage_bps"] = json!(9_999);
        let r = create(&env, &f, "badpolicy", bad).await?;
        assert_eq!(fevents(&r, "vault_create_failed"), 1, "{:?}", r.logs());
        assert!(near_api::Account(id("badpolicy.factory.sandbox")).view().fetch_from(&env.net).await.is_err(), "no account may be left behind");
        let after = near_api::Tokens::account(env.owner.clone()).near_balance().fetch_from(&env.net).await?.total;
        assert!(after <= before, "never over-refunded: {before} -> {after}");
        assert!(before.saturating_sub(after) < NearToken::from_millinear(100), "deposits refunded (only gas spent): {before} -> {after}");
        let listed: Vec<String> = env.view(&f, "get_vaults", json!({"from_index": 0, "limit": 10})).await?;
        assert_eq!(listed.len(), 1);
        // Bad names and small deposits are refused up front.
        assert!(create(&env, &f, "Bad.Name", policy(&env.usdc, &env.wnear, env.pool)).await?.into_result().is_err());
        let r = env.call(&env.owner, &f, "create_vault", json!({"name": "cheap", "owner_id": env.owner, "agent_id": env.agent,
            "policy": policy(&env.usdc, &env.wnear, env.pool)}), NearToken::from_millinear(100).as_yoctonear(), 150).await?;
        assert!(r.into_result().is_err());
        Ok(())
    }

    /// Round 2 L-5 / Phase 2 P2-1: a factory with almost no spare NEAR must never strand a failed creation's deposit.
    /// The deposit (3 NEAR) is far above the factory's free balance, so an immediate refund is only possible if the
    /// runtime's refund has already arrived; otherwise it's recorded and claimable. Either way the creator is made whole.
    #[tokio::test]
    async fn failed_creation_with_no_float_is_refunded_or_claimable() -> R {
        let env = setup(true).await?;
        // The factory wasm needs ~2 NEAR of storage; give it barely more.
        let (f, _) = factory_with(&env, NearToken::from_millinear(2_600), None).await?;
        let float = free(&env, &f).await?;
        assert!(float < NearToken::from_near(1).as_yoctonear(), "test needs a factory float below the deposit: {float}");
        create(&env, &f, "dup", policy(&env.usdc, &env.wnear, env.pool)).await?;
        let before = total(&env, &env.owner).await?;
        let r = create(&env, &f, "dup", policy(&env.usdc, &env.wnear, env.pool)).await?;
        let failed: Vec<Value> = r.logs().iter().filter(|l| l.contains("vault_create_failed"))
            .map(|l| near_sdk::serde_json::from_str::<Value>(&l["EVENT_JSON:".len()..]).unwrap()["data"][0].clone()).collect();
        assert_eq!(failed.len(), 1, "{:?}", r.logs());
        let ev = &failed[0];
        // Record which receipt came first in this run: the factory's balance inside on_created says.
        println!("ORDERING factory_balance_in_callback={} refunded={} pending={}", ev["factory_balance"], ev["refunded"], ev["pending"]);
        if ev["pending"] != "0" {
            // Pull path: the runtime refund lands within a few blocks; the claim then pays, and a third party may trigger it.
            let owed: String = env.view(&f, "get_refund", json!({"account_id": env.owner})).await?;
            // The listing fee stays with the factory to pay for this record's storage (round 3 L-5).
            assert_eq!(owed, (NearToken::from_near(3).as_yoctonear() - NearToken::from_millinear(10).as_yoctonear()).to_string());
            let mut paid = false;
            for _ in 0..10 {
                if env.call(&env.eve, &f, "claim_refund", json!({"account_id": env.owner}), 0, 30).await?.into_result().is_ok() { paid = true; break; }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
            assert!(paid, "claim never succeeded");
            assert!(env.call(&env.eve, &f, "claim_refund", json!({"account_id": env.owner}), 0, 30).await?.into_result().is_err(),
                "a refund can be claimed only once");
        }
        let after = total(&env, &env.owner).await?;
        assert!(after <= before, "never over-refunded: {before} -> {after}");
        assert!(before.saturating_sub(after) < NearToken::from_millinear(50).as_yoctonear(), "owner made whole (gas + at most the listing fee): {before} -> {after}");
        let cfg: Value = env.view(&f, "get_config", json!({})).await?;
        assert_eq!(cfg["owed_refunds"], "0", "{cfg}");
        // The factory never went below its own storage: it's still callable and its float is intact (plus fees).
        assert!(free(&env, &f).await? + NearToken::from_millinear(20).as_yoctonear() >= float);
        Ok(())
    }

    #[tokio::test]
    async fn season_maximum_deposit_is_enforced() -> R {
        let env = setup(true).await?;
        let (f, _) = factory_with(&env, NearToken::from_near(50), Some(NearToken::from_near(2))).await?;
        let cfg: Value = env.view(&f, "get_config", json!({})).await?;
        assert_eq!(cfg["max_deposit"], NearToken::from_near(2).as_yoctonear().to_string());
        // create() attaches 3 NEAR: refused up front, nothing created, deposit back by the runtime.
        assert!(create(&env, &f, "big", policy(&env.usdc, &env.wnear, env.pool)).await?.into_result().is_err());
        let r = env.call(&env.owner, &f, "create_vault", json!({"name": "ok", "owner_id": env.owner, "agent_id": env.agent,
            "policy": policy(&env.usdc, &env.wnear, env.pool)}), NearToken::from_near(2).as_yoctonear(), 150).await?;
        assert_eq!(fevents(&r, "vault_created"), 1, "{:?}", r.logs());
        Ok(())
    }

    /// What a vault really costs to set up, from the minimum deposit, measured on the real Rhea binary.
    #[tokio::test]
    async fn setup_cost_is_measured() -> R {
        let env = setup(true).await?;
        let (f, _) = factory(&env).await?;
        let r = env.call(&env.owner, &f, "create_vault", json!({"name": "cost", "owner_id": env.owner, "agent_id": env.agent,
            "policy": policy(&env.usdc, &env.wnear, env.pool)}), NearToken::from_near(1).as_yoctonear(), 150).await?;
        assert_eq!(fevents(&r, "vault_created"), 1, "{:?}", r.logs());
        let v = id("cost.factory.sandbox");
        let b = near_api::Tokens::account(v.clone()).near_balance().fetch_from(&env.net).await?;
        let vault_storage = b.storage_locked.as_yoctonear();
        // Token registrations (paid by whoever registers the vault) and Rhea's minimum account storage.
        let tb: Value = env.view(&env.usdc, "storage_balance_bounds", json!({})).await?;
        let rb: Value = env.view(&env.ex, "storage_balance_bounds", json!({})).await?;
        let o0 = total(&env, &env.owner).await?;
        env.ok(&env.owner, &v, "exchange_storage_deposit", json!({}), NearToken::from_millinear(100).as_yoctonear(), 50).await?;
        env.ok(&env.owner, &v, "exchange_register_tokens", json!({}), 1, 50).await?;
        let rhea_spent = o0.saturating_sub(total(&env, &env.owner).await?);
        let rhea_bal: Value = env.view(&env.ex, "storage_balance_of", json!({"account_id": v})).await?;
        let v0 = total(&env, &v).await?;
        env.ok(&env.owner, &v, "intents_setup", json!({}), 1, 100).await?;
        let intents_cost = v0.saturating_sub(total(&env, &v).await?);
        println!("SETUP_COST {}", json!({"vault_storage_locked": vault_storage.to_string(), "vault_storage_bytes": near_api::Account(v.clone())
            .view().fetch_from(&env.net).await?.data.storage_usage, "token_storage_min": tb["min"], "rhea_storage_bounds": rb,
            "rhea_storage_balance_after": rhea_bal, "owner_spent_on_rhea_setup_incl_gas": rhea_spent.to_string(),
            "vault_spent_on_intents_setup_incl_gas": intents_cost.to_string(), "listing_fee": NearToken::from_millinear(10).as_yoctonear().to_string()}));
        assert!(vault_storage < NearToken::from_millinear(500).as_yoctonear(), "vault storage should be well under 0.5 NEAR");
        Ok(())
    }

    /// The mainnet deploy script, run end to end against a sandbox: plan first (sends nothing), then a real run that
    /// publishes, deploys, proves a canary vault and deletes the factory key. Same binary, sandbox constants.
    #[tokio::test]
    async fn mainnet_script_runs_end_to_end_in_sandbox() -> R {
        let env = setup(true).await?;
        let dir = std::env::temp_dir().join(format!("it-mainnet-script-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("keys"))?;
        std::fs::create_dir_all(dir.join("out"))?;
        // Root and owner with different keys, as on mainnet.
        let keyfile = |name: &str, acct: &str| -> R<String> {
            let sk = near_api::signer::generate_secret_key()?;
            let pk = Signer::from_secret_key(sk.clone())?;
            let _ = pk;
            std::fs::write(dir.join("keys").join(format!("sandbox-{name}.json")),
                json!({"secret_key": sk.to_string(), "accounts": [acct]}).to_string())?;
            Ok(sk.public_key().to_string())
        };
        let root_pk = keyfile("root", "sledgit.sandbox")?;
        let owner_pk = keyfile("owner", "owner2.sandbox")?;
        env._sandbox.create_account("sledgit.sandbox".parse()?).initial_balance(near_sdk::NearToken::from_near(60))
            .public_key(root_pk).send().await?;
        env._sandbox.create_account("owner2.sandbox".parse()?).initial_balance(near_sdk::NearToken::from_near(10))
            .public_key(owner_pk).send().await?;
        let policy_path = dir.join("policy.json");
        std::fs::write(&policy_path, policy(&env.usdc, &env.wnear, env.pool).to_string())?;
        let vh = b58_sha256(&wasm("../target/near/sledgit_vault/sledgit_vault.wasm")?);
        let fh = b58_sha256(&wasm("../target/near/sledgit_factory/sledgit_factory.wasm")?);
        assert!(std::process::Command::new("cargo").args(["build", "-q", "--example", "deploy_mainnet"]).status()?.success());
        let bin = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/debug/examples/deploy_mainnet");
        let run = |extra: &[(&str, &str)]| -> R<(bool, String)> {
            let mut c = std::process::Command::new(&bin);
            c.env("IT_TARGET", "sandbox").env("IT_RPC", env._sandbox.rpc_addr.as_str()).env("IT_REF", env.ex.as_str())
                .env("IT_INTENTS", env.intents.as_str()).env("IT_MPC", env.mpc.as_str()).env("IT_SUFFIX", ".sandbox")
                .env("IT_FACTORY", "arena.sledgit.sandbox").env("IT_OWNER", "owner2.sandbox")
                .env("IT_KEY_DIR", dir.join("keys")).env("IT_OUT_DIR", dir.join("out"))
                .env("IT_CANARY_POLICY", &policy_path).env("IT_EXPECT_VAULT_HASH", &vh).env("IT_EXPECT_FACTORY_HASH", &fh);
            for (k, v) in extra { c.env(k, v); }
            let o = c.output()?;
            Ok((o.status.success(), format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))))
        };
        // Plan: in the sandbox the Rhea/Intents code checks pass (same binaries) and the mock signer derives keys.
        let (ok, out) = run(&[])?;
        println!("{out}");
        assert!(ok, "plan should pass: {out}");
        assert!(out.contains("PLAN (read-only)") && out.contains("tx 5:"), "{out}");
        assert!(near_api::Account(id("arena.sledgit.sandbox")).view().fetch_from(&env.net).await.is_err(), "plan sent nothing");
        // A confirmation naming another factory is refused before anything is sent.
        let (ok, out) = run(&[("SLEDGIT_MAINNET_CONFIRM", "other.sledgit.sandbox")])?;
        assert!(!ok && out.contains("doesn't name the factory"), "{out}");
        // A run whose canary can't be created stops before the lock, key kept.
        let mut bad = policy(&env.usdc, &env.wnear, env.pool);
        bad["max_slippage_bps"] = json!(9_999);
        let bad_path = dir.join("bad-policy.json");
        std::fs::write(&bad_path, bad.to_string())?;
        let (ok, out) = run(&[("SLEDGIT_MAINNET_CONFIRM", "arena.sledgit.sandbox"), ("IT_CANARY_POLICY", bad_path.to_str().unwrap())])?;
        assert!(!ok && out.contains("key NOT deleted"), "{out}");
        // Round 3 L-3: someone else creates a vault from the factory before the lock. A genuine one doesn't block it.
        let r = env.call(&env.eve, &id("arena.sledgit.sandbox"), "create_vault", json!({"name": "early", "owner_id": env.eve,
            "agent_id": env.agent, "policy": policy(&env.usdc, &env.wnear, env.pool)}), NearToken::from_near(1).as_yoctonear(), 150).await?;
        assert_eq!(fevents(&r, "vault_created"), 1, "{:?}", r.logs());
        let (ok, out) = run(&[("SLEDGIT_MAINNET_CONFIRM", "arena.sledgit.sandbox"), ("IT_RESUME", "1")])?;
        println!("{out}");
        assert!(ok, "resumed run failed: {out}");
        assert!(out.contains("PASS listed vault early.arena.sledgit.sandbox is genuine"), "{out}");
        assert!(out.contains("LOCKED: arena.sledgit.sandbox has 0 access keys"), "{out}");
        let fkeys = near_api::Account(id("arena.sledgit.sandbox")).list_keys().fetch_from(&env.net).await?.data;
        assert!(fkeys.is_empty());
        // The canary has an unguessable name, recorded in the result.
        let result = std::fs::read_dir(dir.join("out"))?.filter_map(|e| e.ok()).map(|e| e.path())
            .find(|p| p.file_name().unwrap().to_string_lossy().starts_with("lock-1")).ok_or("no result file")?;
        let res: Value = near_sdk::serde_json::from_str(&std::fs::read_to_string(result)?)?;
        let canary = res["canary"].as_str().unwrap().to_string();
        assert!(canary.starts_with("canary-") && canary.ends_with(".arena.sledgit.sandbox"), "{canary}");
        let ckeys = near_api::Account(id(&canary)).list_keys().fetch_from(&env.net).await?.data;
        assert!(ckeys.is_empty());
        // A rerun refuses (the factory exists and is locked) instead of paying again.
        let (ok, out) = run(&[("SLEDGIT_MAINNET_CONFIRM", "arena.sledgit.sandbox"), ("IT_RESUME", "1")])?;
        assert!(!ok, "a locked factory can't be re-run: {out}");
        assert!(!dir.join("keys").join("sandbox-lockpending-arena.sledgit.sandbox.json").exists(), "pending key removed after the lock");
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }
}
