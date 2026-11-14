# TEE pill: pinned NEAR AI Cloud measurements (policy v2)

`nearai-policy.json` lists the NEAR AI Cloud software the "Attested model (TEE)" pill accepts. NEAR's docs leave the
accepted measurements to each verifier ([verification policy](https://github.com/nearai/docs/blob/main/cloud/verification/reference/verification-policy.mdx),
[image provenance](https://github.com/nearai/docs/blob/main/cloud/verification/cloud-api/image-provenance.mdx)), so the
list is ours. Anything not on it means no pill. The file is schema-checked on load: exact keys, lowercase hex of the
right length, exact `repo@sha256:` digests.

## What is pinned, and where each value is read

| Field | Read from | Why it is trustworthy |
|---|---|---|
| `vms` | MRTD and RTMR0-2 of the Intel-verified quote, together with the OS image hash they belong to | measured by the TDX module and firmware before the guest OS runs; a custom OS gives other values |
| `app_ids` | the `app-id` event in the RTMR3 event log | the log is replayed against the RTMR3 in the verified quote; each pinned event must appear exactly once, before `system-ready` (a runtime append can't override it) |
| `compose_hashes` | the `compose-hash` event, and sha256 of `app_compose` | equals the quote's MRCONFIGID (`01 ‖ sha256 ‖ 0×15`) |
| `os_image_hashes` | the `os-image-hash` event | RTMR3 replay, and it must match the `vms` entry for the quote's boot measurements |
| `key_providers` | the `key-provider` event (dstack KMS public key) | RTMR3 replay |
| `images` | every service in `app_compose`, parsed as YAML (exact `repo@sha256:digest`; `build:` and image-less services are refused) | inside the MRCONFIGID-bound config |
| `signers` (per model) | the model report's `signing_address` | report_data in the verified quote binds it; NEAR gives every instance of a model one key, held by its KMS |
| `api` | the bundle's `api` | self-declared by the bundle; it names where the collector sent the request, nothing more |
| `max_evidence_age_secs` | the enclave-signed reply `created` vs the anchor block's time, and the decision's block time vs `created` | the reply bytes are covered by the model signature; block times come from the chain |

## What binds a reply to one decision (bundle format v2)

- The request is the published template, byte for byte: `{model, max_tokens: 4000, stream: false, messages: [system,
  user]}`. Extra parameters (guided decoding, `logit_bias`, `chat_template`, tools, duplicate keys) fail.
- The user message is the tick's inputs plus `tee_binding: {network, vault, salt, block_height, block_hash}`. The block
  must exist on that chain with that hash, and the reply must be signed after it, within the age bound. A reply can't be
  moved to another vault, and wasn't requested before that block.
- The receipt's decision must be exactly what the reply says (parsed as the arena parses it).
- The vault's on-chain event must record that decision, within the age bound after the reply. A season (`verify-attestation
  <receipts.jsonl>`) needs every on-chain decision from `--from-seq` on to have a receipt, and no evidence may back two
  receipts.

Bundles in the pre-binding format (v1) are reported as "attested under policy v1 (pre-binding format): badge not awarded
under policy v2". The first on-chain decision (`H1JLa3EJMgSygtVanU82iks6kLBegvoVKcDeUzorxvxP`, seq 1) is one.

## Sources of the pinned values

Taken on 2026-10-29 from reports NEAR AI Cloud served for `Qwen/Qwen3.6-35B-A3B-FP8`. Each passed every other check:
TDX quote `UpToDate`, debug off, report_data, RTMR3, MRCONFIGID, NVIDIA GPU verdict, and the `provider_tee` signature.
- `agent/test/fixtures/nearai/real-bundle.json` (gateway compose `9d93…`, OS `da9a…`, MRTD `f06d…`)
- `deploy/testnet/receipts-arena/qwen36-tee/attestations/*.json` (gateway compose `f571…`, OS `8db4…`, MRTD `7fe6…`)
- the model enclave in all of them: OS `91fd…`, MRTD `df4d…`, signer `0xfdbd…8ddf`
- a keyless `GET /v1/attestation/report?model=…&provider=near` the same day (unchanged)

The images match NEAR's published repositories on Docker Hub (`nearaidev/*`). We have **not** cryptographically
verified their build provenance (Sigstore).

## Refreshing

When NEAR AI redeploys, new decisions lose the pill (fail closed) until the list is refreshed:

```sh
cd agent && node bin/sledgit.mjs attest-policy --model Qwen/Qwen3.6-35B-A3B-FP8
```

This fetches a fresh report without a key and runs the quote, report_data, RTMR3 and MRCONFIGID checks. Only for a report
that passes them does it print each measured value (including the VM's boot measurements) as "pinned" or "NEW"; a report
that fails prints only which checks failed. A person reviews every NEW value: the image diff, and the NEAR AI changelog or
announcement. Then they add it to the JSON in a reviewed change. **Never auto-accept.** Keep old values while receipts
that use them are still in a season.

## Known gaps (stated in every result's `does_not_prove`)

1. **Model weights aren't measured.** `model_name` is a label tied to a per-model key NEAR's KMS assigns.
2. **The serving code at the time of the reply isn't pinned.** The measured compose runs a launcher that installs any
   `compose-manager` release NEAR's CI signs (channel `latest`, no minimum age) and restores the last one from an
   unmeasured volume. The pinned digests are boot defaults only, and the enclave hosts many models. In effect, the trust
   root for the serving code is NEAR's CI signing.
3. **No binding to the gateway or TLS session.** A model signature isn't bound to the gateway's report (NEAR's docs say
   so), so "the request went through NEAR AI Cloud's attested gateway" isn't proven.
4. **The GPU isn't bound to the VM.** The GPU evidence shares the nonce, not the TD. NVIDIA's verdict is read from its
   HTTPS answer; the JWT signature isn't checked locally.
5. **Rerolls:** the agent can ask several times and keep one reply.
6. **Collateral of the day:** quotes are checked against Intel's collateral at verification time, not at production time.
7. **No cryptographic image provenance** (Sigstore/SLSA) for the pinned digests.
