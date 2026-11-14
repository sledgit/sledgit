# Third-party notices

demo-trader is MIT-licensed, like the rest of this repository. It doesn't vendor third-party code. It borrows one design and can optionally run one model, both MIT-licensed:

| Project | What we use | Licence | Pinned |
|---|---|---|---|
| **trader-skill** (github.com/Jakeschincariol/trader-skill), Copyright (c) 2026 Jake Schincariol | The role design only (screener → analyst → risk → budget → broker, with the broker gated by risk). We wrote no code from it; our broker is a Sledgit vault instead of a stock broker. | MIT | commit `5189e79b9a480755a3733ac9713f5353981dbe18` (read for the design) |
| **Kronos** (github.com/shiyu-coder/Kronos), Copyright (c) 2025 ShiYu | Optional forecast. `kronos/forecast.py` imports the Kronos source from a separate checkout you provide. Kronos isn't copied here. | MIT | commit `67b630e67f6a18c9e9be918d9b4337c960db1e9a` |
| **Kronos-small** weights (huggingface.co/NeoQuasar/Kronos-small) | Forecast model, 24.7M parameters | MIT | `model.safetensors` sha256 `b082dfcbd8e8c142a725c8bbb99781802f38fec81210e13479effb32b3c3e020` |
| **Kronos-Tokenizer-base** weights (huggingface.co/NeoQuasar/Kronos-Tokenizer-base) | Candle tokenizer | MIT | `model.safetensors` sha256 `59d85f6af76a2c3b8240ea06cb21db4213b4eeca053f246b23e29cf832fc6bee` |

The runner refuses weights whose sha256 differs from the pinned values. Each receipt records both hashes.

The Kronos Python dependencies we tested (in a dedicated venv, Python 3.12) were torch 2.9.1, numpy < 2.4, pandas 2.3.3, einops 0.8.1, huggingface_hub 0.33.1, safetensors 0.6.2 and tqdm 4.67.1.

These projects don't endorse Sledgit or demo-trader. Kronos is a research model for candlestick data. Nothing here claims it predicts profitably.
