# Spike: NEAR Chain Signatures signing Hyperliquid orders

Can a NEAR account (later, the vault contract) control a Hyperliquid account? Testnet only; no funds at risk.

```
../near-ai-tee/venv/bin/python spike.py   # needs pynacl, eth_account (in that venv)
```

The script creates a NEAR testnet account from the faucet (key in `~/.config/sledgit/testnet-chainsig.json`,
chmod 600), derives its secp256k1 address from `v1.signer-prod.testnet`, builds a Hyperliquid testnet order with
the same EIP-712 scheme as the official SDK, has Chain Signatures sign it, and posts it to Hyperliquid testnet.
The account holds no USDC, so Hyperliquid rejects the order, naming the address it recovered from the signature.

## Result (2026-10-28): 4/4 PASS

| Check | Result |
|---|---|
| Control: a local key's order recovers to that key (digest scheme correct) | PASS |
| Chain Signatures signature recovers locally to the derived address | PASS |
| Hyperliquid recovered the derived address `0x7a5F…f652` | PASS (`User or API Wallet 0x7a5f… does not exist`) |
| Signing latency | 5.6 s (NEAR tx `EJ7UGddgrHRug6AjvXo6FRtK72eBgb66PtoBzXD7NJoH`) |

Not yet shown: a filled order (needs testnet USDC on the derived address), the vault contract making the `sign`
call only after its rule checks (the derived address then belongs to the contract account), and mainnet
(`v1.signer`, same scheme). 5.6 s is fine for daily strategies, not for anything fast.
