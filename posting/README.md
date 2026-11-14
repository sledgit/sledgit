# posting

Image cards and weekly video data built from the league snapshot (`deploy/testnet/league/`). Nothing here posts: a person reviews each card, approves it, and posts it by hand.

```bash
npm ci
node bin/posting.mjs generate --league ../deploy/testnet/league --queue <dir> [--prev <previous snapshot.json>]
node bin/posting.mjs list    --queue <dir>
node bin/posting.mjs approve <id> --queue <dir>   # prints the post text, the reply link and the alt text
node bin/posting.mjs skip    <id> --queue <dir>
node bin/posting.mjs weekly  --league ../deploy/testnet/league --out <dir>
npm test
```

## Cards

| Card | When | Content |
|---|---|---|
| Daily recap | Every run | Season day; ranked entries above the hold line after costs (or "not ranked yet" before day 7); top 3; refusals in the last 24 h; entries per proof tier |
| Refusal | At most 2 a day, only for a refusal code not posted before or an attempt over 2× its cap | Entry, side and exact amount, the cap in force (from the vault's own `init` / `policy_applied` events), the refusal code, the transaction |
| Rank change | At most 1 a day | A ranked entry enters the top 3 or crosses the hold line |

Each queued card is a folder: `card.png` (1200×675), `card.svg`, and `post.json` (`text` ≤ 280 characters, `alt`, `link` for the self-reply, `status`).

Rules enforced in code (`src/cards.mjs`, tested in `test/`):
- **Network stamp.** TESTNET or MAINNET comes from the snapshot's network, and the build fails if any account, token or pool in the snapshot belongs to another network.
- **No agent-written text.** Cards use fixed templates, registry names, numbers and refusal codes. Skip notes and model output never appear.
- **Links go in the reply,** not the post. No @mentions, no return promises.
- **Deterministic.** The same snapshot gives the same SVG and text.

## Weekly data (`sledgit-weekly/1`)

`weekly-<date>.json` drives a JSON-based video composition (beats plus race frames):

| Field | Meaning |
|---|---|
| `schema`, `network`, `stamp`, `season`, `as_of_ms`, `derived_sha256`, `caveat` | Source snapshot and its network stamp |
| `week` | `n` (week of the season), `start_ms`, `end_ms` |
| `fps`, `duration`, `formats` | 30 fps; seconds; `1080x1080`, `1920x1080` |
| `beats[]` | `{id, t0, dur, text, viz, shot: null, focus: null}`: `hook` (stamped), `race`, `refusal` (if any), `end` |
| `race.metric` | `value_vs_hold`: an entry's flow-adjusted value over the Hold 50/50 benchmark on the same notional, minus 1 |
| `race.baseline` | The hold line at 0 |
| `race.entries[]` | `{id, name, kind, proof, ranked, final_vs_hold_after_gas}` |
| `race.frames[]` | `{t, rows: [{id, value_vs_hold}]}`, hourly, sorted best first |
| `refusal_of_week` | `{id, text, link}` or null |
| `end_card` | `{handle, line}` |
