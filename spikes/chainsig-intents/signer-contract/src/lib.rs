//! Spike: a contract authorizes NEAR Intents swaps itself.
//!
//! The agent proposes a swap. The contract checks it against a fixed policy, builds the whole intent payload
//! (signer, deadline, nonce, token_diff) itself, hashes it per ERC-191 and asks the Chain Signatures MPC network
//! to sign that hash under this contract's own derivation path. The result is a `MultiPayload` that intents.near
//! verifies by ecrecover. Only this contract's code can ask the MPC to sign for its path, so once the account's
//! keys are deleted, no person's key can authorize anything.
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{self, Value, json};
use near_sdk::{AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, env, near, require};

pub const MPC_PATH: &str = "iron-trade/intents-1";
const TTL_SEC: u64 = 300;
const ERC191_PREFIX: &[u8] = b"\x19Ethereum Signed Message:\n";
const MAX_RESULT: usize = 512;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Pair {
    /// Token ids in NEAR Intents form, e.g. "nep141:wrap.near".
    pub token_in: String,
    pub token_out: String,
    pub max_in: U128,
    /// Worst accepted price: min_amount_out / amount_in >= min_out_num / min_out_den (smallest units).
    pub min_out_num: U128,
    pub min_out_den: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct IntentsSigner {
    agent: AccountId,
    mpc: AccountId,
    verifying_contract: AccountId,
    pairs: Vec<Pair>,
    /// 0x address of this contract's MPC-derived secp256k1 key; the intents.near implicit account.
    signer_id: Option<String>,
    counter: u64,
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({"standard": "irontrade-intents", "version": "0.1.0", "event": event, "data": [data]})));
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// UTC RFC 3339 with whole seconds, e.g. "2026-10-28T15:04:05Z" (civil-from-days, Howard Hinnant).
pub fn rfc3339(unix: u64) -> String {
    let (days, secs) = ((unix / 86_400) as i64, unix % 86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", secs / 3600, secs / 60 % 60, secs % 60)
}

/// The exact message intents.near will parse, and the ERC-191 hash the MPC signs.
#[allow(clippy::too_many_arguments)]
pub fn build_payload(signer_id: &str, verifying_contract: &str, deadline: &str, nonce: &[u8; 32],
                     token_in: &str, amount_in: u128, token_out: &str, min_out: u128) -> (String, [u8; 32]) {
    let nonce_b64 = serde_json::to_value(Base64VecU8(nonce.to_vec())).unwrap();
    let payload = json!({
        "signer_id": signer_id,
        "verifying_contract": verifying_contract,
        "deadline": deadline,
        "nonce": nonce_b64,
        "intents": [{"intent": "token_diff", "diff": {token_in: format!("-{amount_in}"), token_out: min_out.to_string()}}],
    }).to_string();
    let mut msg = ERC191_PREFIX.to_vec();
    msg.extend_from_slice(payload.len().to_string().as_bytes());
    msg.extend_from_slice(payload.as_bytes());
    let hash: [u8; 32] = env::keccak256_array(&msg);
    (payload, hash)
}

/// Policy check. Returns a refusal reason, or None if the swap may be signed.
pub fn check(pairs: &[Pair], token_in: &str, amount_in: u128, token_out: &str, min_out: u128) -> Option<String> {
    let Some(p) = pairs.iter().find(|p| p.token_in == token_in && p.token_out == token_out) else {
        return Some(format!("pair {token_in} -> {token_out} not allowed"));
    };
    if amount_in == 0 || min_out == 0 { return Some("zero amount".into()); }
    if amount_in > p.max_in.0 { return Some(format!("amount_in above cap {}", p.max_in.0)); }
    // min_out / amount_in >= num / den  <=>  min_out * den >= amount_in * num (checked, no overflow)
    let lhs = min_out.checked_mul(p.min_out_den.0);
    let rhs = amount_in.checked_mul(p.min_out_num.0);
    match (lhs, rhs) {
        (Some(l), Some(r)) if l >= r => None,
        (Some(_), Some(_)) => Some("price worse than the policy floor".into()),
        _ => Some("amount overflow".into()),
    }
}

#[near]
impl IntentsSigner {
    #[init]
    #[private]
    pub fn new(agent: AccountId, mpc: AccountId, verifying_contract: AccountId, pairs: Vec<Pair>) -> Self {
        require!(!pairs.is_empty() && pairs.len() <= 8, "1-8 pairs");
        for p in &pairs { require!(p.min_out_den.0 > 0 && p.max_in.0 > 0, "bad pair"); }
        Self { agent, mpc, verifying_contract, pairs, signer_id: None, counter: 0 }
    }

    /// Ask the MPC contract for this contract's derived key and store its 0x address. Anyone may call it;
    /// the result depends only on this account id and the fixed path.
    pub fn refresh_signer_id(&mut self) -> Promise {
        Promise::new(self.mpc.clone())
            .function_call("derived_public_key",
                json!({"path": MPC_PATH, "predecessor": env::current_account_id(), "domain_id": 0}).to_string().into_bytes(),
                NearToken::from_yoctonear(0), Gas::from_tgas(10))
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(10)).on_derived())
    }

    #[private]
    pub fn on_derived(&mut self) -> Option<String> {
        let raw = env::promise_result_checked(0, MAX_RESULT).ok()?;
        let s: String = serde_json::from_slice(&raw).ok()?;
        let key = bs58::decode(s.strip_prefix("secp256k1:")?).into_vec().ok()?;
        let xy: &[u8] = match key.len() { 64 => &key, 65 => &key[1..], _ => return None };
        let addr = format!("0x{}", hex(&env::keccak256_array(xy)[12..]));
        emit("signer_id", json!({"signer_id": addr, "path": MPC_PATH}));
        self.signer_id = Some(addr.clone());
        Some(addr)
    }

    /// The agent proposes a swap; the contract decides whether it is signed.
    pub fn authorize_swap(&mut self, token_in: String, amount_in: U128, token_out: String, min_amount_out: U128) -> PromiseOrValue<Value> {
        require!(env::predecessor_account_id() == self.agent, "agent only");
        let signer_id = self.signer_id.clone().unwrap_or_else(|| env::panic_str("call refresh_signer_id first"));
        require!(env::prepaid_gas() >= Gas::from_tgas(290), "attach 300 Tgas");
        if let Some(why) = check(&self.pairs, &token_in, amount_in.0, &token_out, min_amount_out.0) {
            emit("refuse", json!({"token_in": token_in, "amount_in": amount_in, "token_out": token_out, "min_amount_out": min_amount_out, "reason": why}));
            return PromiseOrValue::Value(json!({"refused": why}));
        }
        // The contract picks the nonce and deadline, so the agent cannot replay or extend an authorization.
        self.counter += 1;
        let mut seed = env::current_account_id().as_bytes().to_vec();
        seed.extend_from_slice(&self.counter.to_le_bytes());
        seed.extend_from_slice(&env::random_seed());
        let nonce = env::sha256_array(&seed);
        let deadline = rfc3339(env::block_timestamp() / 1_000_000_000 + TTL_SEC);
        let (payload, hash) = build_payload(&signer_id, self.verifying_contract.as_str(), &deadline, &nonce,
            &token_in, amount_in.0, &token_out, min_amount_out.0);
        emit("sign_request", json!({"payload": payload, "erc191_hash": hex(&hash)}));
        let args = json!({"request": {"payload_v2": {"Ecdsa": hex(&hash)}, "path": MPC_PATH, "domain_id": 0}});
        PromiseOrValue::Promise(
            Promise::new(self.mpc.clone())
                .function_call("sign", args.to_string().into_bytes(), NearToken::from_yoctonear(1), Gas::from_tgas(250))
                .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(15)).on_signed(payload)),
        )
    }

    /// Turn the MPC response into the MultiPayload intents.near accepts.
    #[private]
    pub fn on_signed(&mut self, payload: String) -> Value {
        let parsed = env::promise_result_checked(0, MAX_RESULT).ok()
            .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok());
        let Some(out) = parsed else {
            emit("sign_failed", json!({"payload": payload}));
            return json!({"error": "mpc sign failed"});
        };
        let r = out["big_r"]["affine_point"].as_str().unwrap_or_default();
        let s = out["s"]["scalar"].as_str().unwrap_or_default();
        let v = out["recovery_id"].as_u64().unwrap_or(99);
        let decode = |h: &str| (0..h.len()).step_by(2).map(|i| u8::from_str_radix(h.get(i..i + 2)?, 16).ok()).collect::<Option<Vec<u8>>>();
        let (Some(r), Some(s)) = (decode(r), decode(s)) else { return json!({"error": "bad mpc response"}) };
        if r.len() != 33 || s.len() != 32 || v > 1 { return json!({"error": "bad mpc response"}); }
        let mut sig = r[1..].to_vec();
        sig.extend_from_slice(&s);
        sig.push(v as u8);
        let multi = json!({"standard": "erc191", "payload": payload,
            "signature": format!("secp256k1:{}", bs58::encode(sig).into_string())});
        emit("authorized", json!({"multi_payload": multi}));
        multi
    }

    pub fn get_config(&self) -> Value {
        json!({"agent": self.agent, "mpc": self.mpc, "verifying_contract": self.verifying_contract,
            "pairs": self.pairs, "signer_id": self.signer_id, "path": MPC_PATH})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs() -> Vec<Pair> {
        vec![Pair { token_in: "nep141:wrap.near".into(), token_out: "nep141:usdc.near".into(),
            max_in: U128(10u128.pow(24)), min_out_num: U128(4_000_000), min_out_den: U128(10u128.pow(24)) }]
    }

    #[test]
    fn rfc3339_known_dates() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339(1_793_198_645), "2026-10-28T14:44:05Z");
    }

    #[test]
    fn policy() {
        let p = pairs();
        assert!(check(&p, "nep141:wrap.near", 10u128.pow(24), "nep141:usdc.near", 4_000_000).is_none());
        assert!(check(&p, "nep141:wrap.near", 10u128.pow(24), "nep141:usdc.near", 3_999_999).unwrap().contains("price"));
        assert!(check(&p, "nep141:wrap.near", 2 * 10u128.pow(24), "nep141:usdc.near", 9_000_000).unwrap().contains("cap"));
        assert!(check(&p, "nep141:usdc.near", 1, "nep141:wrap.near", 1).unwrap().contains("not allowed"));
        assert!(check(&p, "nep141:wrap.near", 0, "nep141:usdc.near", 1).unwrap().contains("zero"));
    }

    /// Vector produced independently in Python with eth_account.messages.encode_defunct (see ../vector.py).
    #[test]
    fn erc191_hash_matches_python() {
        let (payload, hash) = build_payload("0x0000000000000000000000000000000000000001", "intents.near",
            "2026-10-28T13:29:05Z", &[7u8; 32], "nep141:wrap.near", 1_000, "nep141:usdc.near", 4);
        assert_eq!(payload, include_str!("../../vector_payload.txt").trim_end());
        assert_eq!(hex(&hash), include_str!("../../vector_hash.txt").trim());
    }
}
