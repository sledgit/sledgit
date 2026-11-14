# TEE attestation verifier: dispositions (policy v2)

Findings: `attest-pinning-review.md`. Every PoC there is now a regression test in `agent/test/attest.test.ts`; each fails
against the policy-v1 code and passes after the fix.

| ID | Severity | Disposition | Fix | Test |
|---|---|---|---|---|
| A1 | Critical | **Fixed** | `bindingChecks` requires `receipt.decision` to equal what the arena derives from the attested reply (`expectedDecision`: `parseDecision`, invalid output → the fixed `invalid_output:<code>` hold, amount precision). With the on-chain event, `eventMatches` requires the vault's event to record that decision (skip for hold; request/refuse with token and amount; or a `refused:` skip). | `A1: a real receipt re-sealed with another decision no longer binds…`; the decision tamper in `pill: a receipt whose model_output or inputs were edited…` |
| A2 | High | **Fixed** | Bundle format v2: the user message carries `tee_binding` (network, vault, salt, final block height and hash), so the request hash (signed by the enclave) commits to them; the verifier rebuilds it from the receipt's inputs. The anchor block must exist with that hash, and the signed reply `created` must fall within 900 s after it. With the on-chain event, the decision's block time must fall within 900 s after `created` (the operator-written `ts` no longer counts). The season rejects a chat id, bundle or reply that backs more than one receipt. | `A2: a signed reply moved to another vault…`; `evidence age (A2)…` (stale anchor, wrong anchor hash, decision block an hour late or before the reply); reuse in `A7…` |
| A3 | High | **Fixed** | The request must equal the published template byte for byte (`templateRequest`: model, max_tokens 4000, stream false, exactly a system and a user message with only role/content). Extra fields, duplicate keys and reordering all fail. | `A3: extra request parameters…` (guided_choice, structured_outputs, logit_bias, chat_template, temperature; a duplicated key) |
| A4 | Medium | **Fixed** | Policy `vms`: MRTD and RTMR0-2 from the verified quote must match a pinned tuple for the measured OS image hash (2 gateway shapes, 1 model shape, from the recorded reports). Each pinned event (app-id, compose-hash, os-image-hash, key-provider) must appear exactly once in RTMR3, before `system-ready`; the first (boot) value is the one read. | `A4: a pinned event appended after boot…`; the boot-measurement variant in `policy: each pinned value is enforced on its own…` |
| A5 | Medium | **Fixed (documented)** | `PROVES.does_not_prove`, POLICY.md and README state that the launcher installs any compose-manager release NEAR's CI signs (channel `latest`, no minimum age), restores the last one from an unmeasured volume, and serves many models: the pinned digests are boot defaults, and the trust root for serving code is NEAR's CI signing. Verifying `compose_manager_attestation` is kept as future hardening (NEAR doesn't document it as signed). | `policy (P1-4)…` asserts the result states what stays unproven |
| A6 | Medium | **Fixed** | `PROVES` reworded: the signer key and verified quote; the template and binding; the decision and its on-chain time. Moved to `does_not_prove`: gateway route and TLS session, GPU-in-the-same-VM and NRAS token signature, freshness of the report itself (now carried by the chain anchor). The `api` check is renamed "bundle names the pinned gateway URL" (self-declared). | wording; `policy (P1-4)…` |
| A7 | Medium | **Fixed** | `verify-attestation <receipts.jsonl>` checks the season against the chain (`attest/season.ts`): genuine vault (provenance.ts); all `request`/`refuse`/`skip` events the vault emitted from `--from-seq` (default 1) read from FastNEAR (succeeded receipts only), seq contiguous; one receipt per event; each attested against its own event; no-model ticks must be skips. | `A7: the season covers every on-chain decision…` (missing receipt, seq gap, non-genuine vault, reused evidence) |
| A8 | Low | **Fixed** | Images are read by parsing the compose as YAML (`yaml` 2.9.1, exact pin): every service needs exactly one image; `build:` and image-less services are problems that fail the images check. | `A8: compose images are parsed as YAML…` |
| A9 | Low | **Fixed** | `validatePolicy` on load and on any injected policy: exact keys, lowercase hex of the right lengths, exact `repo@sha256:` digests, `api` constant, age 60-3600 s, version ≥ 2. An invalid policy fails one check ("measurement policy valid"). | `A9: the policy file is schema-checked…` |
| A10 | Low | **Fixed** | NRAS errors become a failed GPU check with the reason; a missing or malformed report fails "gateway report present" / "report present"; `attestDecision` and `verifySeason` catch per decision. | `A10: an NVIDIA outage or a bundle with no report…` |
| A11 | Low | **Kept** | The NRAS JWT signature, `eat_nonce` and `exp` aren't validated locally (stated in `does_not_prove`). The GPU check adds little next to the signer pin, and the GPU isn't bound to the VM anyway (A6). Planned with the other badge hardening (README roadmap 4). | — |
| A12 | Info | **Fixed** | `parseHex`: hex digits only, even length, exact byte length; used for addresses, nonces, signatures and quotes. | `A12: a junk-suffixed hex address…` |
| A13 | Info | **Fixed** | `attest-policy` prints only the failed check names for a report that fails its own checks (no unverified values offered for pinning), includes the VM's boot measurements, and compares the signer in lowercase. | live `attest-policy --model Qwen/Qwen3.6-35B-A3B-FP8` (2026-10-29): exit 0, gateway and model report checks pass, every value pinned, including the VM boot measurements |
| A14 | Info | **Fixed** | "signer matches exactly one verified model report" explains an ambiguous result: "N verified reports share this key". | `sig: the signer must match exactly one…` |
| A15 | Info | **Kept** | Quotes are checked against Intel's collateral of the verification day (stated in `does_not_prove`). Saving the collateral with each bundle is planned with the badge hardening. | — |

## Live result (testnet, 2026-10-29)

- The first on-chain attested decision (seq 1, tx `H1JLa3EJMgSygtVanU82iks6kLBegvoVKcDeUzorxvxP`, bundle v1) is reported
  as "attested under policy v1 (pre-binding format): badge not awarded under policy v2". Every other check on its
  evidence still passes.
- A new decision with the fixed collector: Qwen3.6 via NEAR AI Cloud, `qwen36-tee.arena.irontrade.testnet`, hold,
  recorded as a skip at seq 2, tx `8RhTCrzynmsx9mMhrJVGe2wkD9pkU6ZBPGx1TXQfUqZC`, bundle `d9220ec1…`.
  - `verify`: 2 of 2 on chain, both `ok`, genuine vault.
  - `verify-attestation … --from-seq 2`: `tee_pill: true`, exit 0; 54 of 54 checks with live Intel collateral, NVIDIA
    NRAS and testnet RPC. Anchor block testnet #275262213; reply signed 8 s after it; skip recorded 21 s after the reply.
  - `verify-attestation` from seq 1: `tee_pill: false` (seq 1 pre-binding), exit 1.
- The new bundle's six gitleaks hits are the gateway's and model's public OHTTP `key_config` and Ed25519 `signing_key`,
  byte-identical to the values in the already-reviewed bundles; one narrow fingerprint line was added. The NEAR AI API
  key appears in no file.
