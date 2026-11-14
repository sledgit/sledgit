//! Stand-in for the Chain Signatures MPC contract, for sandbox tests only. Never deploy to a real network.
//!
//! Same calls and reply format as `v1.signer`: `derived_public_key` and `sign` (payload_v2 Ecdsa). The key for
//! (caller, path) is derived from a fixed seed, so the "MPC" here is a single known key per caller. That is
//! exactly what makes it a test double: the real network never reveals or holds a single key.
use k256::ecdsa::SigningKey;
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, require, AccountId, NearToken};

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn key(predecessor: &AccountId, path: &str) -> SigningKey {
    let seed = env::sha256_array(format!("mock-mpc:{predecessor}:{path}").as_bytes());
    SigningKey::from_bytes(&seed.into()).expect("valid scalar")
}

#[near(contract_state)]
#[derive(Default)]
pub struct MockMpc {}

#[near]
impl MockMpc {
    /// "secp256k1:<base58 of the 64-byte uncompressed key without the 0x04 prefix>", like v1.signer.
    pub fn derived_public_key(&self, path: String, predecessor: AccountId, domain_id: u32) -> String {
        require!(domain_id == 0, "only domain 0 (secp256k1)");
        let point = key(&predecessor, &path).verifying_key().to_encoded_point(false);
        format!("secp256k1:{}", bs58::encode(&point.as_bytes()[1..]).into_string())
    }

    /// Signs the 32-byte hash for the caller's derived key. Reply: {big_r: {affine_point}, s: {scalar}, recovery_id}.
    #[payable]
    pub fn sign(&mut self, request: Value) -> Value {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach a deposit");
        let path = request["path"].as_str().unwrap_or_else(|| env::panic_str("missing path"));
        let hash_hex = request["payload_v2"]["Ecdsa"].as_str().unwrap_or_else(|| env::panic_str("missing Ecdsa payload"));
        let hash: Vec<u8> = (0..hash_hex.len()).step_by(2)
            .map(|i| u8::from_str_radix(&hash_hex[i..i + 2], 16).unwrap_or_else(|_| env::panic_str("bad hex")))
            .collect();
        require!(hash.len() == 32, "payload must be 32 bytes");
        let (sig, recid) = key(&env::predecessor_account_id(), path).sign_prehash_recoverable(&hash)
            .unwrap_or_else(|_| env::panic_str("sign failed"));
        let (r, s) = sig.split_bytes();
        let prefix = if recid.is_y_odd() { "03" } else { "02" };
        json!({"big_r": {"affine_point": format!("{prefix}{}", hex(&r))}, "s": {"scalar": hex(&s)},
               "recovery_id": u8::from(recid.is_y_odd())})
    }
}
