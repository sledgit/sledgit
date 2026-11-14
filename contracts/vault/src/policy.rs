use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

pub const MAX_TOKENS: usize = 8;
pub const MAX_PAIRS: usize = 16;
pub const MAX_SLIPPAGE_BPS: u16 = 500;

/// Per-token limits, in the token's smallest unit. Caps apply over a rolling 24 hours.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TokenLimit {
    pub token: AccountId,
    pub max_per_trade: U128,
    pub max_per_day: U128,
}

/// One allowed direction of trade. The owner fixes the Rhea pool that prices it and a price band, so a request can
/// never be priced off a pool or a price the agent chose.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Pair {
    pub token_in: AccountId,
    pub token_out: AccountId,
    pub pool_id: u64,
    /// Worst accepted price, in smallest units: amount_out >= amount_in * min_price_num / min_price_den.
    pub min_price_num: U128,
    pub min_price_den: U128,
}

/// The rules every swap request is checked against.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    pub tokens: Vec<TokenLimit>,
    pub pairs: Vec<Pair>,
    pub max_trades_per_hour: u32,
    /// Rhea swaps only: how far below Rhea's own quote a fill may land. NEAR Intents are signed at the quote.
    pub max_slippage_bps: u16,
}

impl Policy {
    pub fn validate(&self) {
        let ok = |c: bool, m: &str| near_sdk::require!(c, m);
        ok(!self.tokens.is_empty() && self.tokens.len() <= MAX_TOKENS, "policy: 1-8 tokens");
        ok(!self.pairs.is_empty() && self.pairs.len() <= MAX_PAIRS, "policy: 1-16 pairs");
        ok(self.max_trades_per_hour >= 1 && self.max_trades_per_hour <= 60, "policy: 1-60 trades per hour");
        ok(self.max_slippage_bps <= MAX_SLIPPAGE_BPS, "policy: slippage above 5%");
        for (i, t) in self.tokens.iter().enumerate() {
            ok(t.max_per_trade.0 > 0, "policy: zero per-trade cap");
            ok(t.max_per_trade.0 <= t.max_per_day.0, "policy: per-trade cap above daily cap");
            ok(!self.tokens[..i].iter().any(|u| u.token == t.token), "policy: duplicate token");
        }
        for (i, p) in self.pairs.iter().enumerate() {
            ok(p.token_in != p.token_out, "policy: pair trades a token for itself");
            ok(self.limit(&p.token_in).is_some() && self.limit(&p.token_out).is_some(), "policy: pair token not in tokens");
            ok(p.min_price_num.0 > 0 && p.min_price_den.0 > 0, "policy: pair needs a price band");
            ok(!self.pairs[..i].iter().any(|q| q.token_in == p.token_in && q.token_out == p.token_out), "policy: duplicate pair");
        }
    }

    pub fn limit(&self, token: &AccountId) -> Option<&TokenLimit> {
        self.tokens.iter().find(|t| &t.token == token)
    }

    pub fn pair(&self, token_in: &AccountId, token_out: &AccountId) -> Option<&Pair> {
        self.pairs.iter().find(|p| &p.token_in == token_in && &p.token_out == token_out)
    }
}

impl Pair {
    /// Lowest output the band allows for `amount_in`, rounded up; None if it overflows (treated as unpriceable).
    pub fn band_floor(&self, amount_in: u128) -> Option<u128> {
        let n = amount_in.checked_mul(self.min_price_num.0)?;
        Some(n.div_ceil(self.min_price_den.0))
    }
}
