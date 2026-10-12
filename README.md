# dsh-session-cost

[English](README.md) | [中文](README.zh.md)

A **session cost** chip for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): it sits in the same row as the built-in stats pills under the composer and answers two questions at a glance — *what has this conversation cost*, and *what did the last turn cost* — with a per-turn breakdown of cache-hit versus cache-miss spend.

```
     12 turns · 84 tok/s      Token 24.1K · 缓存命中 96%      ◎ ¥3.42 · ¥0.19
                                                              ↑ dsh-session-cost
```

Click it and the panel opens **upwards** — the same anchor geometry, gap and viewport clamping as the two built-in stats dialogs:

```
        ┌──────────────────────────────────────────┐
        │ ◎ 本对话费用                     [ 刷新 ] │
        │ 价目：官方页 · 10/13 02:06                │
        │ ─────────────────────────────────────────│
        │ 命中缓存                          ¥1.195 │
        │ 未命中                            ¥1.084 │
        │ ─────────────────────────────────────────│
        │ 第 5 轮                           ¥0.0710│
        │   命中缓存                        ¥0.0509│
        │   未命中                          ¥0.0201│
        │ 第 6 轮                           ¥0.1949│
        │   命中缓存                        ¥0.1490│
        │   未命中                          ¥0.0459│
        └──────────────────────────────────────────┘
              ↑ the scrolling window is exactly two turn blocks tall
```

## What it does

| You do | You get |
| --- | --- |
| Glance at the chip | This conversation's total spend, then the latest turn's spend |
| Click the chip | The panel opens upward, pinned above the composer |
| Look at the fixed header | **Cache-hit spend** and **cache-miss spend** for the whole conversation |
| Scroll the list | Every turn's total / hit / miss, starting at the newest turn |
| Review a long conversation | Scroll up to walk back through earlier turns |
| Click **刷新** | Fetches the official price page, shows what changed, and applies it only after you confirm |
| Have no billable turn yet | The chip stays hidden, exactly like the built-in stats pills |

Three rows per turn: **total / cache-hit / miss**. The two numbers in the fixed header always add up to the total on the chip — the identity `total = hit + miss` holds by construction, not by rounding luck.

## Where the numbers come from

Only the **official DeepSeek routes** have a published price list, so only they produce money:

| | |
| --- | --- |
| **Hit spend** | cache-read tokens × hit price |
| **Miss spend** | (uncached input + cache-write) × miss price **+** output tokens × output price |
| **Peak / off-peak** | Beijing time Mon–Fri 09:00–12:00 and 14:00–18:00 are peak (double price); weekends and Chinese public holidays are off-peak all day |
| **When it is priced** | At the instant each call happened, taken from the session event's own timestamp — so replaying months-old history is priced with the tariff of *that* moment, not today's |
| **Other providers** | Never guessed at ¥0: they show as *unpriced*, and the panel reports how many calls were unpriced |

Scope is the **current conversation's own turns**. A subagent is a different session and is deliberately not folded in, so the chip's numbers line up one-to-one with the turns you can see.

### It is an estimate, not a bill

Prices are estimated from token counts and the published tariff. The plugin never reads your balance, never touches credentials, and cannot see what DeepSeek actually deducted.

### The `deepseek-v4-pro` tier is disputed

The price rules carry a time fence (inherited from [`@linxin666/dsh-usage`](https://github.com/zhu1090093659/dsh-web)): **after 2026-09-14 12:00 Beijing, `deepseek-v4-pro` requests are billed at the Flash row.**

The official price page still lists `deepseek-v4-pro` on **its own, 3–7.5× more expensive row** (miss 4.5/9.0, output 13.5/27.0). The documentation cannot prove which tier the runtime actually charges. Rather than guess, the plugin keeps the fence and **marks the affected turns** with `按Flash档估`, plus a summary line in the panel. To price them at the official pro row instead, set `V4_PRO_FOLDED_INTO_FLASH_AT_MS` in `lib/pricing.js` to `0`.

## Refresh the price list

Click **刷新** in the panel:

1. The host fetches the **official Chinese price page** (`api-docs.deepseek.com/zh-cn/quick_start/pricing`, which quotes CNY; the English page quotes USD and is not used).
2. It parses the table and validates all 12 unit prices — if any single one is missing or implausible, the whole parse is rejected.
3. It shows you **the diff** (which line changed, from what to what). Only **采用** applies it.

That extra confirmation step is deliberate: DeepSeek publishes **no machine-readable price API**, only a human-facing docs page, so parsing it is inherently fragile. A bad parse applied silently would corrupt every number you look at.

**Where the money is computed** deserves its own sentence: the projection state stores only *token facts* — which model, which price row, peak or off-peak, how many tokens — and **the browser computes the money from the currently active price book**. So adopting a new price list re-prices the entire conversation instantly, with no history rewritten and no two generations of prices mixed into one ledger. The price book is never stored in session checkpoints; it lives in `<DSH_HOME>/dsh-session-cost/pricebook.json` (atomic write).

A failed fetch (offline, timeout, redesigned page) is reported and **keeps the current prices**; the built-in table remains the first-run fallback.

### Capability boundary

- **One outbound request**, to the public docs page above, **only when you click 刷新**. Nothing else ever leaves the machine.
- **One file written**: `<DSH_HOME>/dsh-session-cost/pricebook.json`.
- The three price routes are **loopback + same-origin fenced** (the same guard sibling DSH plugins use).
- The host half reads no credentials, writes no session data, and runs no timers.

## Install

### From the plugin market (once listed)

DSH plugins are distributed as packages; look for **dsh-session-cost** in [dshmarket](https://github.com/dsh-market/dsh-market). Until it is listed, use the manual route below.

### Manual install from this repository

```sh
git clone https://github.com/LanFeng97/dsh-session-cost
cd dsh-session-cost
node tools/install.mjs
```

That copies the package into your DSH profile's `node_modules` and appends one loader line to the profile's `cordis.patch.yml`. It resolves your DSH home the same way the harness does — `$DSH_HOME`, then `~/.dsh` — and it is idempotent: re-run it after pulling to sync an update.

**Then restart DeepSeek Harness.** The host half is a Node module, so a config reload alone will not import it. After that, changing `lib/client.js` only needs a page refresh; changing `lib/index.js` still needs a restart.

```sh
node tools/install.mjs --dry-run        # print what it would do, write nothing
node tools/install.mjs web              # target another profile (default: desktop)
```

Installing by **copy** rather than a directory junction is intentional: on Windows a junction is realpath-resolved back into the clone, and the plugin's `zod` import would then resolve from the clone directory, where there is no `node_modules` — the plugin would fail at load time.

## How it works

### Official extension points, not DOM injection

- The chip registers into the built-in slot **`conversation.composer.dock`** (`order: 1`; the shipped `stats` pills take `order: 0`). That slot *is* the stats row under the composer, a `display:flex; gap:12px` row, so the chip is a first-class sibling of the built-in pills — no DOM poking, no fight with re-renders.
- The panel reuses `useAnchoredPosition` and `useDismissOnOutsidePointer` from `@deepseek-ai/dsh-client-ui-primitives`, the same pair the built-in stats dialogs use, so placement, clamping, outside-click and Esc behave identically.
- All styling goes through theme CSS variables (`--dsw-*`), so it follows your theme instead of hard-coding colors.

### Token facts travel as a session projection

The host registers a **session projection unit** (`sessionCost`) and the browser reads it with `useProjection('sessionCost')`. That buys three things for free:

- **History backfill.** The projection registry replays a late-registered unit over the in-memory log on first touch, so after installing or restarting DSH the turns that *already happened* in the current conversation are folded in — the chip does not start at ¥0.
- **Persistence.** State rides the harness's projection checkpoint cache, so the plugin writes no data files of its own.
- **Push, not polling.** Values arrive on the session control stream; there is no timer and no fetch loop.

### Layered so it can be tested without DSH

| File | Role |
| --- | --- |
| `lib/fold.js` | Pure fold: session events → per-turn token facts. Zero dependencies. |
| `lib/pricing.js` | Pure pricing: peak/off-peak clock, model→price-row decision, tokens→money. Zero dependencies. |
| `lib/pricebook.js` | Pure price book: built-in table, strict validation, official-page parser. Zero dependencies. |
| `lib/projection.js` | Thin adapter: zod schemas + the client view. |
| `lib/pricebook-store.js` | Fetch, stage a candidate, apply, persist. |
| `lib/routes.js`, `lib/guard.js` | Loopback-fenced HTTP translation. |
| `lib/client.js` | The chip and the panel; computes money from facts × the active book. |

## Tests

```sh
npm test              # node tools/selftest.mjs — 66 checks, no network
npm run test:live     # node tools/live-check.mjs — fetch the real page, parse, persist, read back
npm run test:schema   # node tools/schema-check.mjs — schema ↔ state ↔ view consistency, from the installed copy
```

`selftest` covers peak/off-peak and holiday exceptions, the parser (against a checked-in snapshot of the official page), price-book validation, re-pricing under a different book, per-bucket aggregation, replay idempotence, JSON-safe state, list trimming, and the client's i18n key set.

`test:schema` exists because `selftest` deliberately has no third-party imports (it must run without `node_modules`) and therefore **cannot see the zod schemas** — a mismatch between `viewOf()` and the view schema makes every projection read throw at runtime, and that seam did break once. It has its own guard now.

## Compatibility

- DSH **≥ 0.2.0-rc.2** (built and verified against 0.2.0-rc.2).
- Node **≥ 20**.
- One runtime dependency: `zod` ^4, for the projection schemas.

## License

[MIT](LICENSE) © 2026 LanFeng97.

Two pieces are not original to this plugin and keep their upstream credit:

- `lib/holidays.js` — Chinese public-holiday dates from [bastengao/chinese-holidays-node](https://github.com/bastengao/chinese-holidays-node) (MIT).
- The peak/off-peak rules and the price-row decision in `lib/pricing.js`, plus the built-in table in `lib/pricebook.js` — same tariff interpretation as [@linxin666/dsh-usage](https://github.com/zhu1090093659/dsh-web) (Apache-2.0).

## Related

- [dsh-workspace-create-dialog](https://github.com/LanFeng97/dsh-workspace-create-dialog) — the sibling plugin by the same author, for the Create Workspace dialog.
