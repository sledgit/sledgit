//! NEAR Intents path: the vault trades through intents.near with no outside key.
//!
//! The vault owns an intents.near account under its own name. Deposits and withdrawals are direct calls
//! (intents.near authenticates the vault as predecessor). Swaps are `token_diff` intents: the agent proposes one,
//! the vault checks it against the same policy as Rhea swaps, prices it at the pair's own Rhea pool quote (never
//! below the pair's price band), builds the whole intent itself (signer, deadline, versioned nonce, amounts) and has
//! the Chain Signatures network sign it under this vault's derivation path. The key is registered on the vault's
//! intents.near account, so only this contract's code can authorize anything for it.
//!
//! A signed intent is an open offer until its deadline. Its amount counts against the cap from the moment signing is
//! requested. Whatever happens next (signed, unparsable reply, signer timeout), the outcome is decided only by
//! intents.near: `intents_settle` asks whether the nonce was used and records a fill; an unused nonce counts as an
//! expiry (releasing the cap) only while its salt is still valid, because intents.near may delete used nonces once
//! their salt is invalidated. One intent at a time; the owner or agent can cancel it by burning its nonce.
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, ext_contract, near, require, AccountId, Promise, PromiseOrValue};

use crate::{emit, ext_exchange, ext_ft, floor, result_bytes, tgas, valid_hash, Vault, VaultExt, ONE_YOCTO, STUCK_NS};

pub const MPC_PATH: &str = "sledgit/intents-1";
pub const INTENT_TTL_SEC: u64 = 120;
/// The nonce outlives the intent by this much, so intents.near's deadline-based cleanup can't remove a used nonce
/// before the vault has recorded the outcome. Its other cleanup (salt invalidated) is caught by `on_settle_salt`.
pub const NONCE_TTL_SEC: u64 = 30 * 86_400;
/// After an intent's deadline, how long settlement gets before the owner may abandon an unresolvable intent.
pub const ABANDON_GRACE_NS: u64 = 3_600 * 1_000_000_000;
const ERC191_PREFIX: &[u8] = b"\x19Ethereum Signed Message:\n";
/// intents.near versioned nonce: magic prefix, then borsh(VersionedNonce::V1(salt, deadline_ns, 15 random bytes)).
const NONCE_MAGIC: [u8; 4] = [0x56, 0x28, 0xf6, 0xc6];
const MAX_MPC_RESULT: usize = 512;

// The spike burned ~13 Tgas signing; 150 leaves room for the MPC yield/resume. Confirm on testnet.
const TG_MPC_SIGN: u64 = 150;
const TG_VIEW: u64 = 10;
const TG_ON_SIGNED: u64 = 15;
const TG_EXECUTE: u64 = 50;
const TG_ON_INTENT_QUOTE: u64 = TG_MPC_SIGN + TG_ON_SIGNED + 25;
pub const TG_MIN_INTENT_REQUEST: u64 = 2 * TG_VIEW + TG_ON_INTENT_QUOTE + 20;
const TG_ON_CANCEL_SIGNED: u64 = TG_EXECUTE + 10 + 25;
pub const TG_MIN_CANCEL: u64 = TG_MPC_SIGN + TG_ON_CANCEL_SIGNED + 20;
const TG_ON_SETTLE_SALT: u64 = 10;
/// is_nonce_used, then (for a possible expiry) is_valid_salt, then the record.
const TG_ON_SETTLE: u64 = TG_VIEW + TG_ON_SETTLE_SALT + 10;
pub const TG_MIN_SETTLE: u64 = TG_VIEW + TG_ON_SETTLE + 20;

#[allow(dead_code)]
#[ext_contract(ext_mpc)]
trait Mpc {
    fn derived_public_key(&self, path: String, predecessor: AccountId, domain_id: u32) -> String;
    fn sign(&mut self, request: Value) -> Value;
}

#[allow(dead_code)]
#[ext_contract(ext_intents)]
trait Intents {
    fn add_public_key(&mut self, public_key: String);
    fn ft_withdraw(&mut self, token: AccountId, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: Option<String>) -> U128;
    fn execute_intents(&mut self, signed: Vec<Value>);
    fn current_salt(&self) -> String;
    fn is_nonce_used(&self, account_id: AccountId, nonce: String) -> bool;
    fn is_valid_salt(&self, salt: String) -> bool;
    fn has_public_key(&self, account_id: AccountId, public_key: String) -> bool;
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum IntentStage { Quote, Sign, Open, Cancelling }

/// The one intent allowed at a time, from request until `intents_settle` records its outcome.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct OpenIntent {
    pub seq: u64,
    pub pool_id: u64,
    pub token_in: AccountId,
    pub token_out: AccountId,
    pub amount_in: U128,
    pub min_amount_out: U128,
    pub band_floor: U128,
    pub receipt_hash: String,
    pub started_at: U64,
    pub reserved_hour: U64,
    pub stage: IntentStage,
    /// Base64 nonce and RFC 3339 deadline, set once a signature has been requested.
    pub nonce: Option<String>,
    pub deadline: Option<String>,
    pub deadline_ns: U64,
    /// The vault parsed a signature (it was published in `intent_authorized`).
    pub signed: bool,
    /// Past this, intents.near may have deleted the nonce, so is_nonce_used can no longer tell fill from expiry.
    pub nonce_deadline_ns: U64,
    /// A cancel was sent; a used nonce may then be the burn rather than a fill.
    pub burn_attempted: bool,
}

impl OpenIntent {
    /// Can still change state on its own: being quoted (until the stuck timeout) or signable/fillable (until deadline).
    pub fn live(&self, now: u64) -> bool {
        match self.stage {
            IntentStage::Quote => now < self.started_at.0.saturating_add(STUCK_NS),
            // intents.near accepts an intent at exactly its deadline, so it is live through `now == deadline`.
            _ => now <= self.deadline_ns.0,
        }
    }
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

/// intents.near V1 nonce: MAGIC || 0x00 (V1) || salt (4) || deadline_ns as i64 LE (8) || random (15). 32 bytes.
pub fn v1_nonce(salt: [u8; 4], deadline_ns: u64, random: &[u8; 15]) -> [u8; 32] {
    let mut n = [0u8; 32];
    n[..4].copy_from_slice(&NONCE_MAGIC);
    n[4] = 0;
    n[5..9].copy_from_slice(&salt);
    n[9..17].copy_from_slice(&(deadline_ns as i64).to_le_bytes());
    n[17..].copy_from_slice(random);
    n
}

/// The salt a V1 nonce was made with, as intents.near's hex string ("a1b2c3d4"), from its base64 form.
pub fn nonce_salt(nonce_b64: &str) -> Option<String> {
    let bytes = serde_json::from_value::<Base64VecU8>(json!(nonce_b64)).ok()?.0;
    (bytes.len() == 32 && bytes[..5] == [NONCE_MAGIC[0], NONCE_MAGIC[1], NONCE_MAGIC[2], NONCE_MAGIC[3], 0]).then(|| hex(&bytes[5..9]))
}

/// The 4-byte salt from intents.near's `current_salt` reply (hex string, e.g. "a1b2c3d4").
pub fn parse_salt(raw: &[u8]) -> Option<[u8; 4]> {
    let s: String = serde_json::from_slice(raw).ok()?;
    if s.len() != 8 || !s.is_ascii() { return None; }
    let b: Vec<u8> = (0..8).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect::<Option<_>>()?;
    b.try_into().ok()
}

fn b64(bytes: &[u8]) -> String {
    serde_json::to_value(Base64VecU8(bytes.to_vec())).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

/// The exact message intents.near parses, and the ERC-191 hash the MPC signs. `intents` is the JSON array of intents.
pub fn build_payload(signer_id: &str, verifying_contract: &str, deadline: &str, nonce: &[u8; 32], intents: Value) -> (String, [u8; 32]) {
    let payload = json!({
        "signer_id": signer_id,
        "verifying_contract": verifying_contract,
        "deadline": deadline,
        "nonce": b64(nonce),
        "intents": intents,
    }).to_string();
    let mut msg = ERC191_PREFIX.to_vec();
    msg.extend_from_slice(payload.len().to_string().as_bytes());
    msg.extend_from_slice(payload.as_bytes());
    (payload, env::keccak256_array(&msg))
}

pub fn token_diff(token_in: &str, amount_in: u128, token_out: &str, min_out: u128) -> Value {
    json!([{"intent": "token_diff", "diff": {
        format!("nep141:{token_in}"): format!("-{amount_in}"),
        format!("nep141:{token_out}"): min_out.to_string()}}])
}

/// "secp256k1:<base58 64-byte key>" from the MPC's derived_public_key reply (64 or 65 bytes).
pub fn normalize_key(reply: &str) -> Option<String> {
    let key = bs58::decode(reply.strip_prefix("secp256k1:")?).into_vec().ok()?;
    let xy: &[u8] = match key.len() { 64 => &key, 65 if key[0] == 4 => &key[1..], _ => return None };
    Some(format!("secp256k1:{}", bs58::encode(xy).into_string()))
}

/// The MPC sign reply as intents.near's signature string: base58(r || s || v).
pub fn signature_from_mpc(raw: &[u8]) -> Option<String> {
    let out: Value = serde_json::from_slice(raw).ok()?;
    let decode = |h: &str| (0..h.len()).step_by(2).map(|i| u8::from_str_radix(h.get(i..i + 2)?, 16).ok()).collect::<Option<Vec<u8>>>();
    let r = decode(out["big_r"]["affine_point"].as_str()?)?;
    let s = decode(out["s"]["scalar"].as_str()?)?;
    let v = out["recovery_id"].as_u64()?;
    if r.len() != 33 || s.len() != 32 || v > 1 { return None; }
    let mut sig = r[1..].to_vec();
    sig.extend_from_slice(&s);
    sig.push(v as u8);
    Some(format!("secp256k1:{}", bs58::encode(sig).into_string()))
}

fn mpc_result() -> Option<Vec<u8>> {
    if env::promise_results_count() != 1 { return None; }
    env::promise_result_checked(0, MAX_MPC_RESULT).ok()
}

fn sign_request(hash: &[u8; 32]) -> Value {
    json!({"payload_v2": {"Ecdsa": hex(hash)}, "path": MPC_PATH, "domain_id": 0})
}

#[near]
impl Vault {
    // ---------------------------------------------------------------- owner: setup and funds

    /// Derive this vault's signing key and register it on its intents.near account. Run once after deploy.
    #[payable]
    pub fn intents_setup(&mut self) -> Promise {
        self.assert_owner();
        require!(self.intents_key.is_none(), "already set up");
        ext_mpc::ext(self.mpc_id.clone()).with_static_gas(tgas(TG_VIEW))
            .derived_public_key(MPC_PATH.into(), env::current_account_id(), 0)
            .then(Self::ext(env::current_account_id()).with_static_gas(tgas(60)).on_intents_key())
    }

    #[private]
    pub fn on_intents_key(&mut self) -> PromiseOrValue<bool> {
        let key = mpc_result().and_then(|b| serde_json::from_slice::<String>(&b).ok()).and_then(|s| normalize_key(&s));
        let Some(key) = key else {
            emit("intents_key_failed", json!({"reason": "no key from the signer"}));
            return PromiseOrValue::Value(false);
        };
        PromiseOrValue::Promise(ext_intents::ext(self.intents_id.clone()).with_attached_deposit(ONE_YOCTO)
            .with_static_gas(tgas(15)).add_public_key(key.clone())
            .then(Self::ext(env::current_account_id()).with_static_gas(tgas(25)).on_key_registered(key)))
    }

    /// The key is usable only once intents.near has registered it. If the add reports failure (e.g. the key is already
    /// there from an earlier attempt whose callback ran out of gas), ask intents.near before giving up, so setup can't
    /// be bricked by a half-finished run.
    #[private]
    pub fn on_key_registered(&mut self, key: String) -> PromiseOrValue<bool> {
        if result_bytes().is_some() { return PromiseOrValue::Value(self.key_ready(key)); }
        PromiseOrValue::Promise(ext_intents::ext(self.intents_id.clone()).with_static_gas(tgas(TG_VIEW))
            .has_public_key(env::current_account_id(), key.clone())
            .then(Self::ext(env::current_account_id()).with_static_gas(tgas(5)).on_key_check(key)))
    }

    #[private]
    pub fn on_key_check(&mut self, key: String) -> bool {
        if result_bytes().and_then(|b| serde_json::from_slice::<bool>(&b).ok()) == Some(true) { return self.key_ready(key); }
        emit("intents_key_failed", json!({"reason": "intents.near did not register the key", "public_key": key}));
        false
    }

    /// Move an allowed token from the vault into its own intents.near balance (recorded once it arrived).
    #[payable]
    pub fn intents_deposit(&mut self, token: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        require!(self.policy.limit(&token).is_some(), "token not allowed");
        require!(amount.0 > 0, "zero amount");
        // An empty msg credits the sender: this vault's own intents.near account.
        ext_ft::ext(token.clone()).with_attached_deposit(ONE_YOCTO).with_static_gas(tgas(60))
            .ft_transfer_call(self.intents_id.clone(), amount, None, String::new())
            .then(Self::ext(env::current_account_id()).with_static_gas(tgas(5))
                .on_moved("intents_deposit".into(), token.to_string(), amount, self.intents_id.clone()))
    }

    /// Bring tokens back from intents.near. The receiver is always this vault.
    #[payable]
    pub fn intents_withdraw(&mut self, token: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0, "zero amount");
        ext_intents::ext(self.intents_id.clone()).with_attached_deposit(ONE_YOCTO).with_static_gas(tgas(60))
            .ft_withdraw(token.clone(), env::current_account_id(), amount, None, None)
            .then(Self::ext(env::current_account_id()).with_static_gas(tgas(5))
                .on_moved("intents_withdraw".into(), token.to_string(), amount, env::current_account_id()))
    }

    // ---------------------------------------------------------------- agent: swaps

    /// Ask for a swap through NEAR Intents. Same policy as `request_swap`. The intent is signed at the pair pool's Rhea
    /// quote (never below the price band); on success `intent_authorized` carries the signed intent to publish.
    pub fn request_intent_swap(&mut self, token_in: AccountId, token_out: AccountId, amount_in: U128,
                               min_amount_out: U128, receipt_hash: String) -> PromiseOrValue<bool> {
        self.assert_agent();
        require!(valid_hash(&receipt_hash), "receipt_hash must be 64 lowercase hex chars");
        require!(env::prepaid_gas() >= tgas(TG_MIN_INTENT_REQUEST), format!("attach at least {TG_MIN_INTENT_REQUEST} Tgas"));
        self.seq += 1;
        let seq = self.seq;
        self.usage = self.rolled();
        let checked = if self.intents_key.is_none() { Err(("intents_not_set_up", "intents_setup has not run".to_string())) }
            else { self.check(&self.usage, &token_in, &token_out, amount_in.0, min_amount_out.0) };
        let pair = match checked {
            Ok(p) => p,
            Err((code, why)) => {
                emit("refuse", json!({"seq": seq, "receipt_hash": receipt_hash, "venue": "intents", "token_in": token_in,
                    "token_out": token_out, "amount_in": amount_in, "code": code, "reason": why}));
                return PromiseOrValue::Value(false);
            }
        };
        self.reserve(&token_in, amount_in.0);
        emit("request", json!({"seq": seq, "receipt_hash": receipt_hash, "venue": "intents", "pool_id": pair.pool_id,
            "token_in": token_in, "token_out": token_out, "amount_in": amount_in, "min_amount_out": min_amount_out}));
        let band = pair.band_floor(amount_in.0).unwrap_or(u128::MAX);
        self.open_intent = Some(OpenIntent { seq, pool_id: pair.pool_id, token_in: token_in.clone(), token_out: token_out.clone(),
            amount_in, min_amount_out, band_floor: U128(band), receipt_hash, started_at: U64(env::block_timestamp()),
            reserved_hour: self.usage.hour, stage: IntentStage::Quote, nonce: None, deadline: None, deadline_ns: U64(0), signed: false,
            nonce_deadline_ns: U64(0), burn_attempted: false });
        PromiseOrValue::Promise(
            ext_exchange::ext(self.exchange_id.clone()).with_static_gas(tgas(TG_VIEW))
                .get_return(pair.pool_id, token_in, amount_in, token_out)
                .and(ext_intents::ext(self.intents_id.clone()).with_static_gas(tgas(TG_VIEW)).current_salt())
                .then(Self::ext(env::current_account_id()).with_static_gas(tgas(TG_ON_INTENT_QUOTE)).with_unused_gas_weight(0)
                    .on_intent_quote(seq)),
        )
    }

    #[private]
    pub fn on_intent_quote(&mut self, seq: u64) -> PromiseOrValue<bool> {
        let Some(o) = self.open_intent.clone().filter(|o| o.seq == seq && o.stage == IntentStage::Quote) else {
            return PromiseOrValue::Value(false);
        };
        if self.frozen { return self.intent_fail(seq, "vault frozen before signing"); }
        let read = |i: u64, max: usize| (env::promise_results_count() == 2).then(|| env::promise_result_checked(i, max).ok()).flatten();
        let quote = read(0, 128).and_then(|b| serde_json::from_slice::<U128>(&b).ok()).map(|v| v.0).filter(|q| *q > 0);
        let salt = read(1, 64).and_then(|b| parse_salt(&b));
        let (Some(quote), Some(salt)) = (quote, salt) else { return self.intent_fail(seq, "quote or salt unavailable") };
        if o.band_floor.0 > quote {
            return self.intent_fail(seq, &format!("Rhea quote {quote} below the price band {}", o.band_floor.0));
        }
        // Agent's price, floored at Rhea less the owner's slippage and at the band.
        let min_out = o.min_amount_out.0.max(floor(quote, self.policy.max_slippage_bps)).max(o.band_floor.0);
        let deadline_s = env::block_timestamp() / 1_000_000_000 + INTENT_TTL_SEC;
        let deadline_ns = deadline_s * 1_000_000_000;
        let nonce_deadline_ns = (deadline_s + NONCE_TTL_SEC) * 1_000_000_000;
        let mut seed = env::current_account_id().as_bytes().to_vec();
        seed.extend_from_slice(&seq.to_le_bytes());
        seed.extend_from_slice(&env::random_seed());
        let random: [u8; 15] = env::sha256_array(&seed)[..15].try_into().unwrap();
        let nonce = v1_nonce(salt, nonce_deadline_ns, &random);
        let deadline = rfc3339(deadline_s);
        let (payload, hash) = build_payload(env::current_account_id().as_str(), self.intents_id.as_str(), &deadline, &nonce,
            token_diff(o.token_in.as_str(), o.amount_in.0, o.token_out.as_str(), min_out));
        if let Some(f) = self.open_intent.as_mut() {
            f.stage = IntentStage::Sign;
            f.min_amount_out = U128(min_out);
            f.nonce = Some(b64(&nonce));
            f.deadline = Some(deadline);
            f.deadline_ns = U64(deadline_ns);
            f.nonce_deadline_ns = U64(nonce_deadline_ns);
        }
        PromiseOrValue::Promise(
            ext_mpc::ext(self.mpc_id.clone()).with_attached_deposit(ONE_YOCTO).with_static_gas(tgas(TG_MPC_SIGN))
                .sign(sign_request(&hash))
                .then(Self::ext(env::current_account_id()).with_static_gas(tgas(TG_ON_SIGNED)).with_unused_gas_weight(0)
                    .on_intent_signed(seq, payload, U128(quote))),
        )
    }

    /// Once a signature has been requested it may exist even if this callback can't read it (signer timeout, reply
    /// format change), so the cap stays reserved and only `intents_settle` decides the outcome.
    #[private]
    pub fn on_intent_signed(&mut self, seq: u64, payload: String, quote: U128) -> Option<Value> {
        let o = self.open_intent.clone().filter(|o| o.seq == seq && o.stage == IntentStage::Sign)?;
        let signature = mpc_result().and_then(|b| signature_from_mpc(&b));
        if let Some(f) = self.open_intent.as_mut() { f.stage = IntentStage::Open; f.signed = signature.is_some(); }
        let Some(signature) = signature else {
            emit("intent_unsigned", json!({"seq": seq, "receipt_hash": o.receipt_hash, "nonce": o.nonce, "deadline": o.deadline,
                "reason": "no readable signature; the cap stays reserved until intents_settle after the deadline"}));
            return None;
        };
        let multi = json!({"standard": "erc191", "payload": payload, "signature": signature});
        emit("intent_authorized", json!({"seq": seq, "receipt_hash": o.receipt_hash, "pool_id": o.pool_id,
            "token_in": o.token_in, "amount_in": o.amount_in, "token_out": o.token_out, "min_amount_out": o.min_amount_out,
            "quote": quote, "nonce": o.nonce, "deadline": o.deadline, "multi_payload": multi}));
        Some(multi)
    }

    /// Record what happened to the current intent. Anyone may call it. A used nonce is a fill (the vault paid
    /// exactly amount_in and received exactly min_amount_out). An unused nonce after the deadline is an expiry, which
    /// releases the cap, only if its salt is still valid; otherwise it is unresolved and the cap stays. Also clears an
    /// intent stuck before signing.
    pub fn intents_settle(&mut self) -> PromiseOrValue<bool> {
        let o = self.open_intent.clone().unwrap_or_else(|| env::panic_str("no intent to settle"));
        let now = env::block_timestamp();
        if o.stage == IntentStage::Quote {
            require!(!o.live(now), "intent is still being quoted");
            return self.intent_fail(o.seq, "stuck before signing");
        }
        require!(o.stage != IntentStage::Cancelling || !o.live(now), "a cancel is in progress");
        require!(env::prepaid_gas() >= tgas(TG_MIN_SETTLE), format!("attach at least {TG_MIN_SETTLE} Tgas"));
        if now > o.nonce_deadline_ns.0 {
            // intents.near may have deleted the nonce: a fill and an expiry now look the same. Record that honestly and
            // keep the cap (it rolled off the 24 h window long ago anyway).
            emit("intent_unresolved", json!({"seq": o.seq, "receipt_hash": o.receipt_hash, "venue": "intents", "nonce": o.nonce,
                "reason": "settled after the nonce deadline; fill or expiry can no longer be told apart"}));
            self.open_intent = None;
            return PromiseOrValue::Value(false);
        }
        // Whether this can be an expiry is decided now, when the check is made, not when the callback runs: a fill can
        // land between the two, before the deadline.
        let may_expire = !o.live(now);
        PromiseOrValue::Promise(
            ext_intents::ext(self.intents_id.clone()).with_static_gas(tgas(TG_VIEW))
                .is_nonce_used(env::current_account_id(), o.nonce.clone().unwrap_or_default())
                .then(Self::ext(env::current_account_id()).with_static_gas(tgas(TG_ON_SETTLE)).with_unused_gas_weight(0)
                    .on_settle(o.seq, may_expire)),
        )
    }

    #[private]
    pub fn on_settle(&mut self, seq: u64, may_expire: bool) -> PromiseOrValue<bool> {
        let no = PromiseOrValue::Value(false);
        let Some(o) = self.open_intent.clone().filter(|o| o.seq == seq) else { return no };
        let Some(used) = result_bytes().and_then(|b| serde_json::from_slice::<bool>(&b).ok()) else { return no };
        let base = json!({"seq": seq, "receipt_hash": o.receipt_hash, "venue": "intents", "nonce": o.nonce,
            "token_in": o.token_in, "amount_in": o.amount_in, "token_out": o.token_out});
        if used && o.burn_attempted {
            // The nonce was used either by our own cancel (whose callback never reported) or by a fill.
            let mut e = base;
            e["reason"] = json!("nonce used after a cancel was sent: cancel or fill");
            emit("intent_closed", e);
            self.open_intent = None;
            return no;
        }
        if used {
            let mut e = base;
            e["amount_out"] = json!(o.min_amount_out);
            emit("trade", e);
            self.open_intent = None;
            return PromiseOrValue::Value(true);
        }
        if !may_expire { return no; }
        // Unused. intents.near may delete even a used nonce once its salt is invalidated, so this is an expiry only if
        // the salt is still valid now, after the nonce was read: salts never become valid again.
        let Some(salt) = o.nonce.as_deref().and_then(nonce_salt) else { return no };
        PromiseOrValue::Promise(
            ext_intents::ext(self.intents_id.clone()).with_static_gas(tgas(TG_VIEW)).is_valid_salt(salt)
                .then(Self::ext(env::current_account_id()).with_static_gas(tgas(TG_ON_SETTLE_SALT)).on_settle_salt(seq)),
        )
    }

    #[private]
    pub fn on_settle_salt(&mut self, seq: u64) -> bool {
        let Some(o) = self.open_intent.clone().filter(|o| o.seq == seq) else { return false };
        let base = json!({"seq": seq, "receipt_hash": o.receipt_hash, "venue": "intents", "nonce": o.nonce,
            "token_in": o.token_in, "amount_in": o.amount_in, "token_out": o.token_out});
        match result_bytes().and_then(|b| serde_json::from_slice::<bool>(&b).ok()) {
            Some(true) => {
                emit("intent_expired", base);
                self.release(&o.token_in, o.amount_in.0, o.reserved_hour.0);
                self.open_intent = None;
            }
            Some(false) => {
                let mut e = base;
                e["reason"] = json!("nonce unused but its salt was invalidated: intents.near may have deleted a used nonce");
                emit("intent_unresolved", e);
                self.open_intent = None;
            }
            // Unreadable: nothing is decided; settle again later (or the owner abandons it).
            None => {}
        }
        false
    }

    /// Owner's way out when settlement can't resolve an intent (e.g. intents.near's views changed): only after the
    /// deadline plus a grace hour, recorded as unresolved, and the cap stays reserved, so it can never free a cap.
    #[payable]
    pub fn intents_abandon(&mut self) {
        self.assert_owner();
        let o = self.open_intent.clone().unwrap_or_else(|| env::panic_str("no intent to abandon"));
        require!(o.stage != IntentStage::Quote, "not signed yet: use intents_settle");
        let now = env::block_timestamp();
        require!(!o.live(now) && now >= o.deadline_ns.0.saturating_add(ABANDON_GRACE_NS),
            "allowed only an hour after the intent's deadline");
        emit("intent_unresolved", json!({"seq": o.seq, "receipt_hash": o.receipt_hash, "venue": "intents", "nonce": o.nonce,
            "token_in": o.token_in, "amount_in": o.amount_in, "token_out": o.token_out,
            "reason": "abandoned by the owner: settlement could not resolve it"}));
        self.open_intent = None;
    }

    /// Withdraw the open intent's authorization by burning its nonce: the vault signs an empty intent with the same
    /// nonce and executes it itself. Owner or agent; the agent may only make the vault safer.
    #[payable]
    pub fn intents_cancel(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        if who == self.owner_id { require!(env::attached_deposit() == ONE_YOCTO, "attach 1 yoctoNEAR"); }
        else { require!(who == self.agent_id, "owner or agent only"); }
        require!(env::prepaid_gas() >= tgas(TG_MIN_CANCEL), format!("attach at least {TG_MIN_CANCEL} Tgas"));
        let o = self.open_intent.clone().filter(|o| o.stage == IntentStage::Open && env::block_timestamp() <= o.deadline_ns.0)
            .unwrap_or_else(|| env::panic_str("no open intent"));
        let nonce: [u8; 32] = serde_json::from_value::<Base64VecU8>(json!(o.nonce)).ok().and_then(|b| b.0.try_into().ok())
            .unwrap_or_else(|| env::panic_str("bad nonce"));
        let (payload, hash) = build_payload(env::current_account_id().as_str(), self.intents_id.as_str(),
            o.deadline.as_deref().unwrap_or_default(), &nonce, json!([]));
        if let Some(f) = self.open_intent.as_mut() { f.stage = IntentStage::Cancelling; f.burn_attempted = true; }
        ext_mpc::ext(self.mpc_id.clone()).with_attached_deposit(ONE_YOCTO).with_static_gas(tgas(TG_MPC_SIGN))
            .sign(sign_request(&hash))
            .then(Self::ext(env::current_account_id()).with_static_gas(tgas(TG_ON_CANCEL_SIGNED)).with_unused_gas_weight(0)
                .on_cancel_signed(o.seq, payload))
    }

    #[private]
    pub fn on_cancel_signed(&mut self, seq: u64, payload: String) -> PromiseOrValue<bool> {
        let Some(signature) = mpc_result().and_then(|b| signature_from_mpc(&b)) else {
            // Nothing was sent to intents.near, so a later used nonce is a fill.
            if let Some(f) = self.open_intent.as_mut().filter(|f| f.seq == seq) { f.stage = IntentStage::Open; f.burn_attempted = false; }
            emit("intent_cancel_failed", json!({"seq": seq, "reason": "signing failed"}));
            return PromiseOrValue::Value(false);
        };
        let multi = json!({"standard": "erc191", "payload": payload, "signature": signature});
        PromiseOrValue::Promise(
            ext_intents::ext(self.intents_id.clone()).with_static_gas(tgas(TG_EXECUTE)).execute_intents(vec![multi])
                .then(Self::ext(env::current_account_id()).with_static_gas(tgas(10)).on_cancelled(seq)),
        )
    }

    #[private]
    pub fn on_cancelled(&mut self, seq: u64) -> bool {
        // execute_intents fails if the nonce was already used, i.e. a solver filled the intent first.
        let burned = env::promise_results_count() == 1 && env::promise_result_checked(0, 64).is_ok();
        let Some(o) = self.open_intent.clone().filter(|o| o.seq == seq) else { return false };
        if burned {
            self.release(&o.token_in, o.amount_in.0, o.reserved_hour.0);
            self.open_intent = None;
            emit("intent_cancelled", json!({"seq": seq, "receipt_hash": o.receipt_hash, "nonce": o.nonce}));
        } else {
            // The burn did not execute: a used nonce is now known to be a fill.
            if let Some(f) = self.open_intent.as_mut() { f.stage = IntentStage::Open; f.burn_attempted = false; }
            emit("intent_cancel_failed", json!({"seq": seq, "reason": "nonce already used or expired: run intents_settle"}));
        }
        burned
    }

    pub fn get_intents(&self) -> Value {
        json!({"intents_id": self.intents_id, "mpc_id": self.mpc_id, "public_key": self.intents_key,
            "open_intent": self.open_intent, "path": MPC_PATH})
    }

    fn key_ready(&mut self, key: String) -> bool {
        emit("intents_key", json!({"public_key": key, "path": MPC_PATH, "intents_id": self.intents_id}));
        self.intents_key = Some(key);
        true
    }

    /// End an intent that never reached signing: no signature can exist, so the cap is released.
    fn intent_fail(&mut self, seq: u64, reason: &str) -> PromiseOrValue<bool> {
        if let Some(o) = self.open_intent.take() {
            self.release(&o.token_in, o.amount_in.0, o.reserved_hour.0);
            emit("failed", json!({"seq": seq, "receipt_hash": o.receipt_hash, "venue": "intents", "reason": reason}));
        }
        PromiseOrValue::Value(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_known_dates() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339(1_793_198_645), "2026-10-28T14:44:05Z");
    }

    /// Vector produced independently in Python with eth_account (spikes/chainsig-intents/vector.py).
    #[test]
    fn erc191_hash_matches_python() {
        let (payload, hash) = build_payload("0x0000000000000000000000000000000000000001", "intents.near",
            "2026-10-28T13:29:05Z", &[7u8; 32], token_diff("wrap.near", 1_000, "usdc.near", 4));
        assert_eq!(payload, include_str!("testdata/vector_payload.txt").trim_end());
        assert_eq!(hex(&hash), include_str!("testdata/vector_hash.txt").trim());
    }

    /// Layout per intents.near core/src/nonce (VersionedNonce::V1(SaltedNonce{salt, ExpirableNonce{deadline i64 ns, [u8;15]}})).
    #[test]
    fn v1_nonce_layout() {
        let n = v1_nonce([1, 2, 3, 4], 0x0102_0304_0506_0708, &[9u8; 15]);
        assert_eq!(&n[..4], &[0x56, 0x28, 0xf6, 0xc6]);
        assert_eq!(n[4], 0);
        assert_eq!(&n[5..9], &[1, 2, 3, 4]);
        assert_eq!(&n[9..17], &[8, 7, 6, 5, 4, 3, 2, 1]);
        assert_eq!(&n[17..], &[9u8; 15]);
        assert_eq!(parse_salt(b"\"a1b2c3d4\""), Some([0xa1, 0xb2, 0xc3, 0xd4]));
        assert_eq!(parse_salt(b"\"a1b2\""), None);
    }

    #[test]
    fn key_and_signature_parsing() {
        let k64 = bs58::encode([1u8; 64]).into_string();
        let mut k65 = vec![4u8]; k65.extend([1u8; 64]);
        assert_eq!(normalize_key(&format!("secp256k1:{k64}")), Some(format!("secp256k1:{k64}")));
        assert_eq!(normalize_key(&format!("secp256k1:{}", bs58::encode(&k65).into_string())), Some(format!("secp256k1:{k64}")));
        assert_eq!(normalize_key("ed25519:abc"), None);
        let ok = json!({"big_r": {"affine_point": format!("02{}", "11".repeat(32))}, "s": {"scalar": "22".repeat(32)}, "recovery_id": 1});
        let sig = signature_from_mpc(ok.to_string().as_bytes()).unwrap();
        let raw = bs58::decode(sig.strip_prefix("secp256k1:").unwrap()).into_vec().unwrap();
        assert_eq!((raw.len(), raw[0], raw[32], raw[64]), (65, 0x11, 0x22, 1));
        let bad = json!({"big_r": {"affine_point": "02"}, "s": {"scalar": "22"}, "recovery_id": 1});
        assert_eq!(signature_from_mpc(bad.to_string().as_bytes()), None);
        assert_eq!(signature_from_mpc(b"not json"), None);
    }
}
