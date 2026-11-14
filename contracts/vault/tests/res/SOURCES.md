# Test binaries

`rhea_exchange_mainnet.wasm`: the exact code deployed at `v2.ref-finance.near` (Rhea exchange, metadata version 1.9.21),
fetched with RPC `view_code` at mainnet block 224227674 on 2026-11-12 (Rhea upgraded from 1.9.20, pinned 2026-10-28;
the pre-mainnet plan run caught the change).

- sha256: `e7447d9ceb34085acfde8b1f62b0667a3a0a81326f24c211523bb549f1873d87`
- NEAR code_hash (base58 sha256): `GZmkbfVLcN7ErxU9RDxP24YTaKmoVixhM6XyycP15Qvi` (matches the account's on-chain code_hash)

The sandbox tests deploy this binary so the vault is tested against the real exchange code, not a mock.
To refresh, fetch again and update this file; the test suite checks the hash before use.

`intents_mainnet.wasm`: the exact code deployed at `intents.near` (NEAR Intents verifier, source github.com/near/intents, MIT),
fetched with RPC `view_code` at mainnet block 221991639 on 2026-10-28.

- sha256: `a1afab98916d9f213746544dcf8e4e6bdb22c0be6bc5dfbd8ea8814c9922b547`
- NEAR code_hash: `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk` (matches the account's on-chain code_hash)
