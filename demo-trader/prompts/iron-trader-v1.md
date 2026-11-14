# iron-trader v1: desk spec

This file is the published spec of the iron-trader desk. Its sha256 is recorded as `prompt_sha256` in every receipt, and the runner refuses to start unless the parameter blocks below match the running code exactly. Changing a parameter changes the hash.

The desk is code, not a language model. It reads only the tick's recorded inputs (vault balances, policy and usage, the reference price, and `market`), so anyone can re-run a receipt and get the same decision.

## Roles

The roles mirror a human trading desk (after the trader-skill pack, MIT; see `../NOTICE.md`), adapted to one pair: wNEAR/USDC.

1. **Screener.** Is there something to decide on? It needs at least 50 closed daily candles, a reference price, a vault with value and no swap in flight. Otherwise it holds.
2. **Analyst.** The daily trend is **up** when the last close is above its 20-day average and the 20-day average is above the 50-day average. It is **down** in the mirror case, and **mixed** otherwise. With `--kronos`, the analyst also reads the Kronos forecast: **up** if at least 62.5% of sample paths end above the last close and the median moves at least +0.5%, **down** in the mirror case. Trend and Kronos must agree, or the view is flat. Without a Kronos forecast (`unavailable`), a `--kronos` desk holds; it never quietly trades without the signal it was started with.
3. **Risk.** The vault enforces every limit on chain. The desk only refuses what it already knows the vault would refuse: the hourly trade limit is used up, or the per-trade / rolling 24 h cap has no room.
4. **Budget.** The target NEAR weight is 0.7 when the view is up and 0.3 when it is down: tilts, never all in or all out. Each decision moves at most 25% of the vault toward the target, within balance and caps, and moves nothing below 2% of the vault. Amounts are rounded down to 6 decimals.
5. **Broker.** The Iron Trade vault. The runner calls `preview_swap`. If it passes, the runner calls `request_swap` with the vault's own price floor. If it fails, the runner calls `log_skip` with the refusal code. A hold is a `log_skip` too. Every decision gets a receipt hash-bound to its on-chain event.

## Parameters

Desk:

```json
{"sma_fast":20,"sma_slow":50,"weight_up":0.7,"weight_down":0.3,"kronos_share":0.625,"kronos_min_move_pct":0.5,"max_step":0.25,"min_trade":0.02,"decimals":6}
```

Kronos (optional, `--kronos`): the last 512 closed hourly Binance NEARUSDT bars in, 24 hours forecast out, 8 independent sample paths, CPU, fixed seed:

```json
{"interval":"1h","context":512,"pred_len":24,"paths":8,"seed":0,"T":1,"top_p":0.9}
```

Pinned weights (`model.safetensors` sha256); any other file is refused:

```json
{"model":{"repo":"NeoQuasar/Kronos-small","sha256":"b082dfcbd8e8c142a725c8bbb99781802f38fec81210e13479effb32b3c3e020"},"tokenizer":{"repo":"NeoQuasar/Kronos-Tokenizer-base","sha256":"59d85f6af76a2c3b8240ea06cb21db4213b4eeca053f246b23e29cf832fc6bee"}}
```

## What is recorded

`inputs.market.daily` holds the 60 daily candles the analyst read. `inputs.market.kronos` holds:

- the status (`ok`, `unavailable` with a code, or `off`);
- the hourly window (an exact refetch URL, first and last bar, and the sha256 of the bars as fed);
- the parameters and the weight hashes;
- the forecast summary (last close, median close, change, share of paths up).

Kronos sampling is seeded. On the same CPU type the same bars give the same forecast; across hardware, floating point can differ, so a re-run checks the inputs exactly and the forecast approximately.

## What this is not

A trend rule and a forecast model are signals to test, not edges. Kronos is a research model for candlestick data; nothing here claims it predicts profitably. Most agents won't beat holding, and the leaderboard ranks this one against holding after costs like every other entry.
