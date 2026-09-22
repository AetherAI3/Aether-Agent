# Nano strategy library

This directory is Nano's contribution-ready, trading-oriented **strategy library and conformance corpus**. It is a place to learn from familiar ideas, compare clear signal contracts, and contribute new source/IR pairs—not a live-strategy service, a performance claim, or investment advice.

Every entry has two files:

- `<name>.nano` - source written in the locked Nano grammar
- `<name>_ir.json` - the canonical IR expected from that source

`tests/test_library.py` verifies that each pair compiles to exactly that IR, round-trips through its loader, and replays deterministically.

## Two corpora, one directory

The library holds two kinds of entry, and the difference is worth understanding before you add one.

| | **Baseline entries** | **v1 entries** |
| --- | --- | --- |
| Count | 41 | 14 |
| Source shape | one `every`, one `if`, AND-chained comparisons of a named signal against a literal | `param`/`input`/`let` declarations, arithmetic, `else`, offsets |
| Where the numbers come from | the **host** computes every indicator and injects it as a named series | the host supplies **OHLCV**; Nano computes the indicators |
| Compiled IR | `0.1.0`, byte-stable | `1.0.0`, carries `sourceHash` and `moduleHash` |
| Runs on | `nano.runtime.interpreter.execute` | `nano.runtime.vm.run_module` |

Both are first-class and neither is deprecated. Baseline entries are the older artifacts and hosts have pinned their fixtures, so `tests/test_library.py::test_baseline_entries_stay_on_baseline_ir` fails if one ever drifts up a version. v1 entries exist because some ideas cannot be written any other way: a ratio of an indicator to a moving average of *itself*, a two-bar reclaim, or a channel breakout that must read `HIGHEST(high, 20)[1]` rather than the unshifted channel that includes the current bar.

The practical difference for a host is the size of the contract. A baseline entry asks the host to implement and agree on `DONCHIAN_POS`; a v1 entry asks for `high`, `low`, and `close`.

## Learn, compare, contribute

The current library contains 55 strategies across eight categories — seven trading, one for deterministic watchdog controls — in two corpora: 41 baseline and 14 v1. Browse an entry to see the source, its expected IR, and the data contract it assumes. When you are ready, a well-documented strategy pair is the most direct contribution to Nano.

[Walk through a first contribution →](../../docs/first-contribution.md) · [Add a strategy →](../../CONTRIBUTING.md#add-a-strategy) · [Open a proposal →](https://github.com/AetherAI3/Nano/issues/new?template=strategy-library.yml)

One command checks an entry before you push it, and writes the `_ir.json` partner for you:

```bash
python scripts/check_contribution.py --write nano/library/<category>/<name>.nano
```

## Categories

**v1 entries are marked with a dagger (†).**

| Category | Strategies |
| --- | --- |
| `momentum/` | `rsi_oversold_reversal`, `stochastic_oversold`, `williams_r_reversal`, `roc_momentum`, `absolute_momentum_filter`†, `stochastic_reclaim`† |
| `mean_reversion/` | `bollinger_band_touch`, `zscore_reversion`, `cci_extreme`, `bollinger_lower_reclaim`†, `zscore_fade_trend_filtered`†, `opening_gap_fade`†, `volatility_percentile_reclaim`† |
| `trend/` | `golden_cross`, `macd_histogram_flip`, `donchian_breakout`, `supertrend_flip_long`, `ema_pullback_continuation`†, `macd_zero_line_reclaim`†, `donchian_high_breakout`†, `volume_confirmed_channel_breakout`† |
| `volatility/` | `atr_volatility_halt`, `bb_squeeze_breakout`, `squeeze_release_expansion`†, `atr_regime_halt`† |
| `volume/` | `volume_spike_confirmation`, `obv_trend`, `volume_climax_reversal`†, `vwap_band_reversion`† |
| `risk/` | `max_drawdown_breaker`, `daily_loss_limit`, `position_concentration_cap`, `correlation_cluster_guard`, `stale_data_halt`, `leverage_ceiling`, `consecutive_loss_circuit` |
| `event_volatility/` | `event_impulse_pullback_long`, `event_impulse_pullback_short`, `cpi_impulse_pullback_long`, `cpi_impulse_pullback_short`, `event_false_first_move_long`, `event_false_first_move_short`, `event_second_leg_long`, `event_second_leg_short`, `event_liquidity_halt`, `event_release_integrity_halt`, `event_whipsaw_halt` |
| `watchdog/` | `trusted_route_guard`, `credential_age_alert`, `aether_release_notes_coverage`, `aether_release_notes_batch_unaccounted`, `aether_release_notes_proof_missing`, `aether_release_notes_copy_unvalidated`, `aether_release_notes_uncovered_merge`, `aether_release_notes_candidate_unattached` |

## The comment header

Every entry opens with a `//` header, and it is not decoration — it is the part
a reviewer reads to decide whether the rule is *right*, as opposed to whether it
compiles. The source already says what the rule computes. The header says when
it is meant to fire and, more usefully, when it is wrong.

Five fields, all required, all checked by
`python scripts/check_contribution.py`:

| Field | What it answers |
| --- | --- |
| `REGIME:` | Which market or system state this is for — and, often more useful, which one it must **not** fire in |
| `CONDITIONS:` | What has to already be true before the rule is armed |
| `INVALIDATION:` | What makes it wrong. A rule nobody can disprove is not a rule |
| `SHAPE:` | The timeframe and the picture being described, and why that timeframe |
| `CALIBRATED ON:` | Where the numbers came from, and specifically what does *not* travel to another instrument or site |

A `NOT <other_entry>:` line is the convention for the near-neighbour problem:
name the existing entry yours is most likely to be confused with, and say what
distinguishes them. Every current entry carries one.

Signals get documented too. If your rule uses a signal already in the tables
below, the table is its definition. If it introduces a new one, define it in
your header — formula or data source, unit or range, normalization, lookback
convention — because the host has to implement it.

### Provenance

`SOURCE:` is an optional, contributor-supplied provenance claim:

```text
// SOURCE: <public work or account you actually consulted>
```

Use exactly one non-empty `SOURCE:` line when you can truthfully identify the
public material you consulted. Do not invent a citation to make the header look
complete. Omitting the line means only **provenance not recorded**; it does not
claim the rule is original work. `scripts/check_contribution.py` checks that
mechanical rule, while review must verify the claim itself. Existing entries
without a `SOURCE:` line remain explicitly unspecified rather than receiving
guessed attributions after the fact.

Authorship is recorded by git and the pull request, so there is no author field.
The contribution policy forbids copying, adapting, or translating Pine, MQL, or
other proprietary platform source. Indicator names such as Bollinger Bands are
used nominatively to identify a calculation; no affiliation or endorsement is
implied.

## Signal conventions (baseline entries)

Baseline entries compare **host-provided named signal series** with numeric literals, which is what keeps them on byte-stable v0.1.0 IR. A v1 entry does the opposite — it declares its inputs and lets Nano compute the indicator from the 40 deterministic kernels, which is what puts it on v1.0 IR; see [Data contract (v1 entries)](#data-contract-v1-entries). Nano never fetches market data in either form. The names and transformations below are conventions a host data feed must implement.

| Pine-style expression | Nano signal | Feed convention |
| --- | --- | --- |
| `ta.rsi(close, 14)` | `RSI(14)` | Raw RSI, 0-100 |
| `ta.stoch(...)` %K | `STOCH_K(14)` | Raw %K, 0-100 |
| `ta.wpr(14)` | `WILLR_POS(14)` | Williams %R + 100 (0-100) |
| `ta.roc(close, 10)` | `ROC(10)` | Percent change over the window |
| Bollinger %B | `BB_PCT_B(20)` | `(close - lower) / (upper - lower)` |
| Bollinger width | `BB_WIDTH(20)` | `(upper - lower) / middle * 100` |
| z-score | `ZSCORE_NEG(20)` | Negated z-score |
| `ta.cci(20)` | `CCI_NEG(20)` | Negated CCI |
| `ta.crossover(sma50, sma200)` | `SMA_SPREAD(50)` | `SMA(50) - SMA(200)` |
| MACD histogram | `MACD_HIST(9)` | MACD line minus signal line |
| Donchian breakout | `DONCHIAN_POS(20)` | `(close - lower) / (upper - lower)` |
| `ta.atr(14) / close` | `ATR_PCT(14)` | ATR as a percentage of price |
| SuperTrend flip up | `SUPERTREND_FLIP_BULL(10)` | 1 on the bar `SUPERTREND_DIR` turned bullish, else 0 |
| planned stop distance | `STOP_DISTANCE_ATR(10)` | `(entry - protective stop) / ATR(10)` |
| planned reward:risk | `TARGET_R` | planned target distance / planned stop distance |
| `ta.mom(close, 10)` | `MOM(10)` | `close - close[10]` |
| volume spike | `VOL_RATIO(20)` | `volume / sma(volume, 20)` |
| OBV trend | `OBV_SLOPE(20)` | Linear-regression slope of OBV |
| equity drawdown | `DRAWDOWN` | Portfolio drawdown percentage |

### Book-control signals (`risk/`)

Risk entries read **portfolio and infrastructure state**, not bar indicators. Every series is nonnegative and rises as the situation worsens, so a control is always a `>=` against a ceiling — the same direction on every rule, which is what makes a stack of them readable at a glance. These rules emit `pause` and `observe` only; none of them proposes a direction.

| Book measurement | Nano signal | Feed convention |
| --- | --- | --- |
| session loss | `DAY_LOSS_PCT` | Realised session loss as a positive percentage of starting equity; host owns the session boundary |
| largest position | `MAX_POSITION_PCT` | Largest single position as a percentage of gross exposure |
| cluster exposure | `CLUSTER_EXPOSURE_PCT` | Largest correlated-cluster exposure as a percentage of gross; host owns cluster assignment |
| feed freshness | `FEED_AGE_SEC` | Seconds since the last accepted tick |
| gross leverage | `GROSS_LEVERAGE` | Gross exposure divided by equity |
| losing streak | `CONSECUTIVE_LOSSES` | Count of consecutive losing closed decisions; host defines close and loss |

### Watchdog signals (`watchdog/`)

Watchdog rules read **host-measured system and policy state** — not markets at
all. They exist because the same three properties that make a trading rule
auditable (deterministic, replayable, unable to reach outside the host) are what
a security or compliance control needs most. See
[deterministic watchdogs and compliance controls](../../README.md#deterministic-watchdogs-and-compliance-controls)
for the boundary this sits inside.

They follow the `risk/` direction convention: every series is nonnegative and
rises as the situation worsens, so a control is always a `>=` against a ceiling.
A stack of them reads the same way top to bottom, which is the point. If your
natural measurement falls as things get worse — availability, remaining budget,
a health score — the host publishes the complement, and the header documents the
transform.

A **magnitude** follows that convention exactly. A **fact** — a host boolean in
the `0/1` domain — has no worse direction to rise in, so a rule reads it as
`>= 1` for true and `<= 0` for false. Both spellings appear in the
release-note family below. The alternative, minting a `NOT_` complement for
every fact the host publishes, doubles the contract surface and creates two
names that can disagree; `0/1` and its two comparisons cannot.

Watchdog rules emit `pause` and `observe` only. A rule proposing a direction is
a trading rule and belongs in another category; `tests/test_library.py` enforces
this.

This category is the corpus for the [Watchdog profile](../../docs/watchdog_profile.md)
in `nano/watchdog/`, which is the runtime side of the same idea: it admits a rule
under a narrower contract — an opcode allow-list, `PAUSE`/`OBSERVE` only, one
cadence, and a declared signal contract — then evaluates it and issues a receipt.
Every entry here is admissible under that profile, and a test pins it, so the
corpus and the runtime cannot drift apart. Nothing extra is required of you when
contributing: writing an entry that follows the two category rules above is
enough. The signal contract itself belongs to the host deploying the rule, not to
the library.

| System measurement | Nano signal | Feed convention |
| --- | --- | --- |
| trusted route unavailable | `TRUSTED_ROUTE_DOWN` | 0 while the host's connectivity check verifies the route, 1 while it does not; host owns debouncing |
| credential age | `CREDENTIAL_AGE_DAYS` | Age in whole days of the oldest in-scope credential or signing key |

#### Release-note signals

Six entries (`aether_release_notes_*`) gate the publication of release notes for
a repository programme. Read the boundary in each header before deploying them:
their `pause` proposals hold **release-note publication only** and must never be
wired to a branch, a deploy, or an engineering merge.

| System measurement | Nano signal | Feed convention |
| --- | --- | --- |
| merged | `MERGED` | 0/1; the pull request under examination has merged |
| canonical repository | `CANONICAL_REPOSITORY` | 0/1; the merge landed in the repository this programme publishes notes for |
| canonical base | `CANONICAL_BASE` | 0/1; the merge landed on that repository's release branch |
| release-note pull request | `IS_RELEASE_NOTES_PR` | 0/1; the pull request *is* the release note, so it does not need covering |
| candidate exists | `HAS_RELEASE_CANDIDATE` | 0/1; some draft release note already covers this merge |
| candidate attached | `HAS_SOURCE_ATTACHMENT` | 0/1; the draft carries the merge, commit or artifact it describes |
| candidate age | `PENDING_AGE_SECONDS` | Whole seconds the candidate has held its current state; host resets it on revision |
| public surface | `PUBLIC_CANDIDATE` | 0/1; the candidate is bound for a surface outside the organisation |
| proof retrievable | `REQUIRED_PROOF_AVAILABLE` | 0/1; every claim the host requires evidence for can actually be fetched |
| copy validated | `COPY_VALIDATED` | 0/1; the text passed the host's validation, whatever that host defines it to be |
| unaccounted merges | `UNACCOUNTED_MERGE_COUNT` | Count of merges on the canonical base that no candidate covers; published only from a completed scan, absent otherwise |
| merge coverage | `MERGE_COVERAGE_AVAILABLE`, `MERGE_COVERAGE_EMPTY`, `MERGE_COVERAGE_UNAVAILABLE`, `MERGE_COVERAGE_ERROR`, `MERGE_COVERAGE_STALE` | The host's five-value coverage vocabulary as five independent 0/1 facts, exactly one of which is 1 on a bar |

`MERGE_COVERAGE_*` is the encoding worth reading twice. The host's coverage
state is a closed vocabulary — *available, empty, unavailable, error, stale* —
with no ordering, so it is published as five independent booleans rather than
flattened onto one number: `unknown=0, degraded=1, healthy=2` invents the claim
that degraded sits between the other two, and every `>=` written against it
inherits the invention. Nano cannot detect that mistake, which is why the
encoding is a review matter and is written down here.

`empty` and `unavailable` are the pair that has to stay apart. `empty` means the
forge answered and there was nothing to count; `unavailable` and `error` mean it
did not answer. A host that lets an error path fall through to an empty result
publishes a zero that reads exactly like a clean scan, and
`aether_release_notes_coverage` is the rule that refuses to believe it: it names
the two states that permit publication and holds on everything else, so a sixth
coverage state added later is held rather than waved through.

Four further signals — `BATCH_ACCOUNTING_COMPLETE`, `WAITING_PROOF_COUNT`,
`ROLLING_PR_EXISTS` and `ROLLING_PR_CI_GREEN` — belong to the same host feed and
are deliberately read by no rule here. They are host bookkeeping about the
publishing mechanism, and no entry reads a signal it does not need: a condition
added to make a contract look complete is a condition that can only weaken the
rule it was added to.

The category has grown from two entries; the signal tables above are still not a
catalogue. Rules for authentication-failure bursts, unsigned release artifacts,
endpoint posture, and release-approval thresholds are
[open issues](https://github.com/AetherAI3/Nano/labels/good%20first%20issue),
not omissions.

### Macro-event signals (`event_volatility/`)

Event strategies consume a **host event engine** rather than bar indicators: the host arms a scheduled release window, measures the post-release tape deterministically, and publishes nonnegative bounded scores. Bull and bear terms are always separate series (never one signed value), which is what keeps twin-armed branches mutually exclusive and inside baseline IR. The full measurement definitions live in [`docs/event_signal_contract.md`](../../docs/event_signal_contract.md).

| Event measurement | Nano signal | Feed convention |
| --- | --- | --- |
| armed event window | `EVENT_READY` | 0 or 1; scheduled high-impact window verified |
| entry window | `ENTRY_WINDOW_OPEN` | 0 or 1; host-enforced T+5s..T+180s |
| confirmed release | `RELEASE_CONFIRMED` | 0 or 1; release packet status CONFIRMED only |
| release integrity | `RELEASE_CONFLICT` | 0 or 1; any source/hash/schedule conflict |
| cool CPI print | `CPI_COOL_SCORE` | 0..1 from standardized forecast errors |
| hot CPI print | `CPI_HOT_SCORE` | 0..1; published beside `CPI_COOL_SCORE` |
| upward impulse | `UPSIDE_IMPULSE_ATR` | max upward excursion from event anchor / pre-event 1m ATR |
| downward impulse | `DOWNSIDE_IMPULSE_ATR` | max downward excursion from event anchor / pre-event 1m ATR |
| retracement hold | `RETRACE_HOLD_SCORE` | 1 - retracement/impulse, clamped 0..1 |
| failed breakout | `BREAK_FAILURE_SCORE` | 0..1; range break then deterministic reclaim |
| range break up/down | `PRE_EVENT_RANGE_BREAK_UP` / `_DOWN` | 0..1 against the versioned T-5m range |
| anchor reclaim/reject | `EVENT_ANCHOR_RECLAIM` / `EVENT_ANCHOR_REJECT` | 0..1 at the T-10s..T-1s median mid anchor |
| second leg | `SECOND_LEG_SCORE` | 0..1; impulse, compression, then fresh extreme, in order |
| cross-market agreement | `BULL_CROSS_CONFIRM` / `BEAR_CROSS_CONFIRM` | 0..1 MES/MNQ + flow agreement |
| order-flow confirmation | `BULL_FLOW_CONFIRM` / `BEAR_FLOW_CONFIRM` | 0..1 from the host futures feature fabric |
| liquidity normalized | `LIQUIDITY_OK` | 0 or 1; spread and depth renormalized |
| spread stress | `SPREAD_STRESS` | 0 = baseline, 1+ = severely stressed |
| tape churn | `WHIPSAW_SCORE` | 0..1 normalized anchor crossings in the window |

Two baseline details matter:

1. Baseline IR cannot carry a negative literal, so signals with negative natural ranges are shifted (`WILLR_POS`) or negated (`ZSCORE_NEG`) by the feed. Document the transform in a `//` comment. A v1 entry has unary minus and writes `-entry_z` directly — compare `zscore_reversion` with `zscore_fade_trend_filtered`.
2. The parenthesized integer is documentation only. `RSI(14)` and `RSI` compile to the same `ConditionNode(signal="RSI", ...)`; the feed owns the actual lookback calculation. In a v1 entry `RSI(close, 14)` is the opposite: the `14` is a real period and Nano computes the series.

## Data contract (v1 entries)

A v1 entry declares what it needs and Nano derives the rest, so the host contract is raw bars rather than a vocabulary of agreed indicator names. Every declared `input` must be present in the `MarketFrame` under exactly that name.

| Entry | Declared inputs | Computed from them |
| --- | --- | --- |
| `trend/ema_pullback_continuation` | `close` | `EMA(close, 20)`, `EMA(close, 50)` |
| `trend/macd_zero_line_reclaim` | `close` | `MACD_LINE(close, 12, 26)` and its prior bar |
| `trend/donchian_high_breakout` | `high`, `low`, `close` | `HIGHEST(high, 20)[1]`, `LOWEST(low, 20)[1]` |
| `momentum/absolute_momentum_filter` | `close` | `ROC(close, 126)`, `ROC(close, 21)` |
| `momentum/stochastic_reclaim` | `high`, `low`, `close` | `STOCH_K(high, low, close, 14)` and its prior bar |
| `mean_reversion/bollinger_lower_reclaim` | `close` | `BB_LOWER(close, 20, 2.0)` and its prior bar |
| `mean_reversion/zscore_fade_trend_filtered` | `close` | `ZSCORE(close, 20)`, `SMA(close, 200)` |
| `mean_reversion/opening_gap_fade` | `open`, `high`, `low`, `close` | `ATR(high, low, close, 14)[1]`, `open - close[1]` |
| `volatility/squeeze_release_expansion` | `close` | `BB_WIDTH`, `LOWEST(BB_WIDTH, 50)`, `BB_MIDDLE` |
| `volatility/atr_regime_halt` | `high`, `low`, `close` | `ATR(…, 14)` over `SMA(ATR(…, 14), 100)` |
| `volume/volume_climax_reversal` | `high`, `low`, `close`, `volume` | `SMA(volume, 20)`, `ATR`, `(close - low) / (high - low)` |
| `volume/vwap_band_reversion` | `close`, `volume` | `VWAP(close, volume, 20)`, `RSI(close, 14)` |

Only indicators in `nano/indicators/registry.py` may be used — 40 of them. If an idea needs one that is not there, express it with the existing kernels and arithmetic or leave it out; inventing a name silently turns a computed call back into a feed signal the host must supply.

Warm-up is a consequence of the periods, not a setting: `zscore_fade_trend_filtered` cannot emit anything for its first 199 bars, and the VM reports how many bars it discarded rather than counting them as no-signal.

## Intent boundary

```text
host MarketFrame -> Nano reference runtime -> Intent(s)
                 -> host DecisionGate -> Decision record(s)
```

A corpus strategy can emit `BUY`, `SELL`, `EXECUTE`, `PAUSE`, or `OBSERVE` intents. It cannot place a trade or call an external API. The host owns policy and any real-world action.

An intent carries an action, an asset, and a confidence — and nothing else. There is no field for a stop price, a target price, or a quantity, in baseline IR or in v1.0. A rule whose setup has a bracket, such as `trend/supertrend_flip_long`, therefore expresses it as *preconditions* the host must already have measured (`STOP_DISTANCE_ATR`, `TARGET_R`) rather than as output. Nano can assert that a plan meeting those floors existed on the bar; it cannot hand the plan to anyone. The host that published those series recomputes the bracket and owns it.

## Adding a strategy

[`docs/first-contribution.md`](../../docs/first-contribution.md) walks the whole
path once, with a real rule. The short version:

1. Choose an existing category or propose a new one, and decide which corpus the entry belongs to. If the host already publishes the number, write a baseline entry. If the idea needs arithmetic, an offset, a second branch, or an indicator of an indicator, write a v1 entry.
2. Add `<name>.nano`. A baseline entry stays inside the [v0.1.0 subset](../../docs/language.md) — one `every` block, one `if` rule, AND-chained conditions, and supported intent actions — which is what keeps its checked-in IR byte-stable. A v1 entry may declare `param`/`input`/`let` and use expressions, offsets, and `else`.
3. Write the [comment header](#the-comment-header) — five fields, plus a `NOT` line, plus any new signal's definition.
4. Keep the file at `nano/library/<category>/<name>.nano`. Packaging globs exactly one directory deep, so a strategy in a nested subdirectory is silently dropped from the wheel.
5. Generate the `_ir.json` partner and check everything at once:

   ```bash
   python scripts/check_contribution.py --write nano/library/<category>/<name>.nano
   ```

   `--write` produces the IR in the library's format, so nothing has to be
   hand-reflowed to match its neighbours. Re-run without `--write` and it should
   print `1 entry ready for review.` A hand-edited fixture no longer describes its
   source, and a v1 entry's IR carries a `sourceHash` over the whole file, so
   **editing even a comment means regenerating it**.
6. Add a fire/no-fire test in `tests/test_library.py`. **Never a no-fire assertion alone.** A rule that can never fire passes one unchanged, so every silence assertion ships beside a positive control on the same strategy, ideally on a frame that differs only in the term being tested.
7. Run `python -m pytest tests/test_library.py -q`, then the full suite.

The pair must compile to the checked-in IR, round-trip through the validator, and replay deterministically under the test frames before it is ready to merge. CI runs the same checker over the whole library on every pull request.

## What this library does not claim

No entry here carries a performance, win-rate, or profitability claim, and none
is a live signal. The `CALIBRATED ON` line in each header says which instrument
and cadence its numbers were written against and where they stop travelling;
the optional `SOURCE:` line is the only per-entry provenance claim. Treat every
entry as an executable specification of an idea, not as advice.

An example of the v1 shape, in full:

```nano
strategy DocExample {

    param window: int = 20
    param mult: float = 2.0

    input close: series<float>

    let lower = BB_LOWER(close, window, mult)

    every 1d {

        if close > lower and close[1] <= lower[1] {

            buy(SPY, 0.6)

        }

    }

}
```
