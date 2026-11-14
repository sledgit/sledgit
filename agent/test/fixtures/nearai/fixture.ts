// Fixed inputs behind the captured NEAR AI Cloud report: its nonce is deriveNonce(vault, salt, request).
export const FIXTURE = {
  vault: "fixture.irontrade.testnet",
  salt: "00112233445566778899aabbccddeeff",
  model: "Qwen/Qwen3.6-35B-A3B-FP8",
  request: JSON.stringify({ model: "Qwen/Qwen3.6-35B-A3B-FP8", max_tokens: 4000, stream: false,
    messages: [{ role: "system", content: "fixture system prompt" }, { role: "user", content: "{\"fixture\":true}" }] }),
};
