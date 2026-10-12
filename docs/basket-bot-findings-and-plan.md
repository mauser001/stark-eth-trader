# Basket bot: findings and implementation plan

Status: research result, nothing implemented. The existing ETH/STRK bot is **not touched**. The basket bot is a separate new bot (own folder, own config, own wallet, own data files, own process).

All research code and data live in `data/history/` (git-ignored). Key files: `bt4.py` (strategy engine), `sweep5.py` / `sweep6.py` (parameter search), `analyze5.py` (scoring and walk-forward), `forward5.py` (stress scenarios), `sim_bot.py` (replica of the current bot).

## 1. Conclusion in short

- The goal metric is **ETH-equivalent of the wallet versus holding the same starting coins (plus the same deposits/withdrawals)**. Everything below is measured that way.
- The basket logic does **not reliably amplify returns**. On rolling 6- and 12-month windows (Apr 2024 to Oct 2026) the best configurations sit at about **1.00x hold at the median, 0.93-0.96x in the worst window**. In 2026 YTD they are 1.02-1.08x.
- What it does reliably: it **avoids the worst of a falling coin** (trend filter, caps, latch) and **harvests ranges**. In synthetic range-bound markets it ends 2-5% ahead of hold per year at moderate activity, 12% ahead with a tight threshold.
- ETH/BTC/USDC alone has essentially **no edge over hold** (about 0.99-1.00x median). Adding STRK (the volatile coin) is what creates both the opportunity and the risk, and STRK in the basket also keeps a gas reserve automatically.
- Trade count is **much lower** than the current bot (roughly 25-60 swaps per year with X=8-12%, about 110 with X=6%), because the entry threshold is much wider.
- Honest expectation: a risk-managed rotation that is about neutral to hold in trending years and a few percent ahead in ranging years. It is worth running as a small experiment, not as a proven amplifier.

## 2. The strategy (what to build)

Prices are tracked as **ETH-ratio per coin**: `er[k] = price_k / price_ETH`. Any pair ratio is `er[a]/er[b]`, so one ratio per coin is enough.

State:
- `ref[k]`: `er[k]` at the last trade that involved coin k.
- `free[k]`: units of coin k not tied to an open lot.
- Open lots: `{coin, units, er_at_open (vector), cost_usd, opened_at}`. Archived lots are kept in a history file.
- `flag[k]`: value-cap latch (below).

Rules, evaluated on every price tick (hourly is enough in simulation; the live bot can check every 1-5 minutes):

1. **Strength**: `chg[k] = er[k] / ref[k]`.
2. **Open a lot**: if the strongest coin `a` (with free balance) has `chg[a] / chg[b] >= 1 + X_eff` against the weakest allowed coin `b`, sell 5% of `free[a]` into `b`. Set `ref[a]` and `ref[b]` to the current ratios. If `b` is blocked (rules below) try the next weakest.
3. **Close a lot (counter trade)**: for every coin `b` that was bought in lots, take the lot with the **worst (highest) entry ratio** for that coin. If `(er[b]/er[c]) / (er_open[b]/er_open[c]) >= 1 + X_eff` (after fees) against the currently **weakest allowed coin `c`**, trade the lot into `c`.
   - **Chaining**: the result becomes a **new open lot** in `c` (so it can be counter-traded again); the old lot is archived. This keeps the open-lot list from growing. `chain=False` (proceeds to free balance) is a valid variant that was slightly worse in the search.
4. **Volatility scaling**: `X_eff = X * max(1, vol_k * max(vol_a, vol_b) / vol_ETH)`, with volatility as a 30-day exponential average of hourly log returns. This is what makes the same rule work for ETH/BTC (calm) and STRK (wild).
5. **Blocks** (a coin may not be bought into if any is true):
   - **Value cap**: its total holding (free plus lots) is >= 50% of total portfolio value.
   - **Value-cap latch** (your idea): when a purchase pushes a coin to the cap, set `flag[k]`; it stays blocked **even if the coin later falls below 50%**. It is cleared only when we trade out of that coin. Variant `all` (clear when the last lot of the coin is gone) and `any` (clear on any closing trade out of it) performed the same.
   - **Cost cap**: cost basis of its open lots >= 60% of portfolio value (this matters when a coin crashes: market share shrinks but money is still tied up).
   - **Trend filter**: price below 92% of its 90-day average (do not buy a falling knife).
6. **Costs**: 0.3% per swap is assumed in all tests (avnu showed 0.05-0.3% all-in plus roughly $0.01-0.07 gas).

Reading of "worst eth ratio" used for counter trades: the lot whose entry `er` for that coin was highest (bought most expensively, so furthest underwater in ETH terms). `each` (all qualifying lots) and `best` (lowest entry) were tested too; `worst` was the most robust.

## 3. Recommended starting parameters

| Parameter | Value | Note |
|---|---|---|
| Coins | ETH, WBTC, USDC, STRK | SOL dropped: the wrapped-SOL pool on avnu has 55-98% slippage |
| X (entry and close threshold) | 12% (8% = more activity, 6% = even more) | applies after volatility scaling |
| Close threshold ratio | 1.0 (same as X) | 0.5-0.75 gave no benefit |
| Tranche | 5% of free balance of the selling coin | 3% was equal |
| vol_k | 1.5 | 2.5 equal |
| Value cap | 50% with latch | 35% equal or slightly better in some cuts |
| Cost cap | 60% | |
| Trend filter | price >= 0.92 x 90-day average | strongest single improvement for the STRK basket |
| Chaining | on | |
| Selection | worst-lot | |
| Minimum lot | $50-100 | gas is about $0.05 per swap |

## 4. Evidence

### 4.1 How the design was found

Data: hourly Binance prices for ETH, BTC, STRK (2024-04-30 to 2026-10-10); 1-minute data for ETH and STRK for the current-bot replica. Benchmark: equal value start, hold. Fee 0.3% per swap.

- Earlier design (7-day-average entry, fixed 10% spread): basket with STRK lost to hold (0.65x full period, 0.89x rolling 6-month median). Cause: a fixed spread is ordinary noise for a volatile coin, so lots pile up in the falling coin. Volatility scaling fixed most of this (1.00x 2026, 1.09x full).
- Ratio-reference design (this document): 2026 YTD 1.15-1.30x for hand-picked variants, but only about 1.00x on rolling windows. The 2026 number alone overstated the edge.
- Random search (160 configs for four coins, 120 for three), then a focused grid (192 configs) around the good region. Score = mix of rolling 6-month and 12-month log ratios, the 10th percentile, 2026 YTD and full period.

Factor effects in the random search (mean score; higher = better):
- Wider X is better (0.12/0.10/0.08 beat 0.03-0.06).
- Trend filter helps (0.85 best of 0.0/0.6/0.75/0.85; the grid then preferred 0.92/0.85).
- `worst` selection beats `best` and `each`.
- Smaller tranche (3%) at least as good as 8-12%.
- Value cap with latch beat no cap and cap without latch.
- Volatility scaling 1.5 beat 0 and 1.0.

### 4.2 Final candidate on history (four coins)

X=12%, 5% tranche, value cap 50% with latch, cost cap 60%, vol_k 1.5, trend 0.92, chained, worst-lot.

| Measure | Result |
|---|---|
| 2026 YTD vs hold | 1.04x |
| Full period (2024-04 to now) vs hold | about 1.5x (mostly because the filter avoids buying STRK on the way down; not a harvesting gain) |
| Rolling 6-month windows (24, 30-day steps) | median 1.004, 10th percentile 0.98, worst 0.957, share at or above 1.0: 71% |
| Rolling 12-month windows | median 1.000, worst 0.966 |
| Walk-forward (pick on earlier data, test on later windows) | 0.999-1.006x test result; the median of all configs on the same test windows was 1.000-1.003x |

The walk-forward result is the key honesty check: tuning on earlier data barely beat the average config on later data. The edge is small.

### 4.3 Forward scenarios (12 months, 8 paths each, reshuffled 2026 moves, 0.3% fee)

| Scenario | X=12% bot/hold (worst) | X=8% bot/hold (worst) | X=6%, 0.15% fee (worst) |
|---|---|---|---|
| Range-bound (2026 min-max) | 1.035 (1.001) | 1.054 (1.012) | 1.124 (1.004) |
| STRK bleeds -70% vs ETH | 0.996 (0.872) | 1.008 (0.828) | 1.036 (0.779) |
| STRK rises 3x vs ETH | 0.997 (0.841) | 0.946 (0.675) | 0.910 (0.571) |
| BTC rises 1.5x vs ETH | 1.042 (0.919) | 1.041 (0.903) | 1.080 (0.834) |
| STRK and BTC both -50% vs ETH | 0.976 (0.909) | 0.999 (0.911) | 0.976 (0.882) |

Three-coin basket (ETH/BTC/USDC, X=12%): 1.02x range, 1.01-1.02x elsewhere, 0.97x when BTC and STRK both drop.

Reading:
- A wider X is safer; a tighter X earns more in a range and loses more when a coin trends up (the bot keeps selling a strong coin, which is the same weakness the current bot shows in a rising-STRK month).
- In a strong one-way market the bot ends close to hold, which means it **cannot create an edge from trend**, only from oscillation.

### 4.4 Questions answered along the way

- Per-coin ETH ratio is enough; pair ratios can be derived.
- Stable coin: behaves as another coin (its ETH ratio just moves inversely to ETH). It is a useful low-volatility sink, nothing more.
- Minimum capital: about 500 EUR per token (about 2,500 EUR total) is enough with a $50-100 minimum lot; gas drag is about 3-5% over 2.6 years at the old-style trade count and much less here.
- avnu liquidity: ETH, STRK, WBTC and USDC are fine at $50-2,500 (all-in 0.05-0.3%).

## 5. Known weaknesses and risks

1. The edge is about 0-5% a year and sits inside the noise of the tests. Parameters were chosen on the same history they were scored on; walk-forward shows only a tiny real gain.
2. History is dominated by a STRK bleed of about 97%. A real recovery is not in the data. The forward scenarios are synthetic.
3. STRK strongly rising is the weak case (bot sells the winner and ends below hold).
4. Slippage and failed transactions are not modelled beyond a flat 0.3% fee.
5. The 7-day-average ("old") logic and this one disagree on 2026; the validation windows are short. Treat the first 3-6 months of live running as the real test.
6. The strategy only makes sense if you accept lower trade frequency than the current bot.

## 6. Implementation plan

Hard requirement: **the current ETH/STRK bot continues unchanged.** The new bot lives in its own folder and shares nothing at runtime.

### 6.1 Layout

```
basket-bot/
  package.json            own dependencies (can copy versions from the old bot)
  tsconfig.json
  config/
    basket.env.example    all parameters below, no secrets committed
  src/
    config.ts             reads env, validates (coins, thresholds, caps)
    prices.ts             avnu quotes -> ETH ratios, volatility and 90-day trend state
    engine.ts             pure functions: decide open / close / blocks (no I/O)
    execute.ts            builds and sends swaps through avnu, handles slippage and failures
    state.ts              loads/saves state, lot archive, flags
    report.ts             progress metrics (section 6.4)
    main.ts               loop
  test/
    engine.parity.test.ts golden tests against the Python engine (bt4.py)
  data/                   git-ignored: state.json, lots_archive.jsonl, trades.jsonl, flows.jsonl, prices.jsonl
```

Separate from the old bot: own wallet (new Starknet account and key), own env file, own process/service, own data directory, own report. Nothing imports from `src/` of the old bot (copy the small helpers you need instead).

### 6.2 Phases

0. **Port and verify (no money).** Write `engine.ts` as pure functions and a test harness that replays the same hourly data through both the TypeScript engine and `bt4.py` and requires identical trades. This catches porting bugs before they cost money.
1. **Paper trading (no money).** Run the bot against live avnu quotes for 4-8 weeks, writing decisions and hypothetical fills (using quoted prices and gas) to the data files. Compare against the Python replay of the same live prices.
2. **Bootstrap with small capital.** About 500 EUR per coin (about 2,500 EUR total) in the dedicated wallet, see 6.3.
3. **Review after 3 months, then 6.** Decide on scaling, tightening X, or stopping, using the criteria in 6.5.

### 6.3 Bootstrap

1. Create the new wallet. Fund it from your main wallet; record every deposit/withdrawal in `flows.jsonl` (the old bot lost this information and it made evaluation harder).
2. Initial allocation by value: 25% each in ETH, WBTC, USDC, STRK (or 30/30/30/10 if you want less STRK risk; the 10% STRK weight performed about the same in earlier tests).
3. Keep a gas reserve of about 100-200 STRK in the STRK share; the bot never sells below that reserve.
4. Set `ref[k] = er[k]` at the start, `free[k]` = the bought amounts, no lots, all flags cleared.
5. Record the **hold benchmark**: starting units of each coin. This is the number everything is compared to.
6. Warm-up: load 90 days of hourly prices (Binance or avnu history) before the first decision so volatility and the trend filter are valid on day 1.
7. Do not trade until the first full state snapshot and the benchmark file are written.

### 6.4 Tracking progress (what the report must show)

Computed on every run and written to a daily report:

1. **Main metric**: `ETH-value of wallet / ETH-value of hold benchmark` (benchmark = start units plus all recorded deposits/withdrawals). Also the same numbers in USD for reference.
2. **Units view**: units of each coin now versus start (and versus hold). Shows where the gains are.
3. **Realized gain per closed lot** in units of the sold coin, summed per coin (the same unit-based tracking used in `bt3.py`).
4. **Open lots**: count, total cost, age (median, maximum), unrealised result per lot in ETH terms, and the worst lot.
5. **Concentration**: market-value share and cost share per coin versus the 50% / 60% caps; list of coins with the latch set and since when.
6. **Activity**: swaps per week, fees plus gas paid (in ETH-equivalent), failed transactions.
7. **Benchmarks**: wallet versus hold, versus the simulation replayed on the same live prices (should be close; a large gap means an execution or modelling problem).
8. Equity curve (daily points) of ratio-to-hold and ETH-value.

### 6.5 Guard rails and stop criteria

- **Pause trading** (keep monitoring) if ratio-to-hold is below 0.90 for 30 days, or any coin share exceeds 60%.
- **Stop and review** if failed-transaction rate exceeds 5%, or realised slippage is above 0.5% on average, or fees plus gas exceed 20% of realised gains over a quarter.
- **Success after 6 months**: ratio-to-hold at or above 1.00 with at least 30 closed lots, and a simulation replay on the same prices within +-2%.
- **Scale up only after** two consecutive quarters at or above 1.00, or tighten X (8%, then 6%) in small steps.

### 6.6 Execution details to decide before coding

- avnu quote slippage limit (suggest 0.5%) and max price-impact check; no trade if exceeded.
- One swap at a time; state written before and after each swap (crash-safe, idempotent re-run).
- Treat a failed swap as no trade and do not update `ref` or lots.
- Minimum trade size $50-100; skip otherwise.
- Check interval: 1-5 minutes is enough (the strategy is not high-frequency).
- Lot archive: closed lots go to `lots_archive.jsonl` with open/close ratios, units and gain; only open lots stay in `state.json`.

## 7. Open points for you

- STRK weight: 25% (tested) or 10%.
- X: 12% (safest), 8% (middle), 6% (most trading, most risk).
- Whether you want a separate small "gas reserve" instead of STRK in the basket (the ETH/BTC/USDC-only basket had no measurable edge).
- How strict the stop criteria should be.

## 8. Follow-up research (Oct 2026): original trades, replica calibration, trailing exits

All code is in `data/history/` (git-ignored research scripts, Python). Metric everywhere: wallet value in ETH divided by "hold" (same starting units plus real flows). Costs: 0.12% per leg, 0.5 STRK gas per swap unless stated.

### 8.1 "Original trades" design (hop between coins, close back to the origin)
Engine `bt5.py`/`bt6.py`, sweeps `cmp5/6/7.py`, `wf7.py`, `fwd5/7.py`.
- Does not beat the ref-ratio basket engine (section 2). Median about 1.00x hold; lock-in removes the 2026 edge (1.04 to 1.00) but improves tails. Hops are rare.
- Fixed 1 STRK gas: tight X (3-5%) looks good in 2026 only; worst windows 0.84-0.91. X=12% stays the most robust.
- `Y% per hop` (closing or hop threshold): no measurable effect.
- Failed-tx fees added to the counter-trade target (as in `checkTxGain`): barely changes medians.
- Walk-forward: test 1.010-1.017 vs pool median 1.008-1.020, so tuning adds nothing. Plain threshold rebalancing is clearly worse.
- Trailing entry (~3%) helps in synthetic range/bleed paths, neutral on later history. Reference drift and drawdown pause: no effect.

### 8.2 Do simulations transfer to the live bot (about 15-22 trades/day)?
- Actual trades/day over the last 10 months: 5, 7, 10, 11, 12, 14, 17, 20, 25, 31 per 30 days (higher when the ETH/STRK ratio moves a lot). The "100 swaps/day" is not what the data shows (peak month about 78/day).
- Replica of the live ladder (`sim_bot.py`, 1-minute data) seeded with actual balances per 30-day window (`res11.py`): correlation with actual 0.84 (trades/day) and 0.85 (result vs hold). Replica trades about 1.4x more in calm months and exaggerates the worst month (0.61 vs 0.84 actual).
- Over 12 windows (347 days) the actual bot ends at about 0.73 of hold; only about 4 of 12 months beat hold. Replica by diff (3% sell): 0.5% gives 0.49, 1% 0.64, 2% 0.79, 5% 0.90, 10% 0.96, 12% 0.97 (`res12.py`). Wider diff loses less.
- The basket engine only trades about 1 swap/day on 1-minute data, so basket results say little about the high-frequency regime.
- Not modelled: avnu quote vs Binance, size-dependent slippage, MEV, real failure clustering.

### 8.3 Why "more trades = more loss" although each close is profitable
Each closed rung earns about diff minus fees, but the inventory stays on the falling coin (ETH/STRK fell about 58% in the last window). Value vs hold at an arbitrary end date mostly measures drift and entry timing. Judge with return-to-start-ratio paths instead (see 8.4).

### 8.4 Synthetic cycles (ratio returns to start; `res13.py`)
50/50 start, 4% daily noise, ladder at 3% sell, wallet/hold (flat / x3 up and back / two x3 cycles / down 60% and back), 180 days:
- diff 0.5%: 1.087 / 0.997 / 0.999 / 1.026 (about 20 trades/day flat)
- diff 1%: 1.089 / 1.016 / 1.016 / 1.032
- diff 2%: 1.073 / 1.030 / 1.032 / 1.040
- diff 5%: 1.047 / 1.030 / 1.034 / 1.032
Takeaway: the ladder gains tokens when the ratio returns, but the gain is small (1-4%). A noise-free x3 round trip confirms the cause: every rung closes at its own entry plus diff, so profit scales with the number of rungs times diff, not with the swing amplitude (162 open rungs at the peak, 0.998 at 0.5% diff). A diff of 1-2% is the best compromise (within about 1 point of the best everywhere, 3-9 trades/day instead of 20).

### 8.5 Trailing-exit ladder (`trail.py`, `res14-17.py`)
Idea: open a rung every `open_d` (times `1 + esc * open rungs in that direction`, so deep stacks need bigger moves), close a rung only after the ratio retraces `trail` from its best point and the close is profitable after costs.
- Plain trailing exit without escalation: falling-knife stack (about 60 open rungs); 0.65-0.80 of hold on trend shapes.
- Escalation (esc=1) is the useful part: real 12 months product 0.70 to 0.90-0.92, worst month 0.93, 6 of 12 months at or above hold, 1.8 trades/day. Wider trail (2%) beats 1%.
- A 10/20/40% take-profit exit changed nothing (removed).
- Still below the plain 2% ladder on smooth synthetic cycles (0.92-0.96 vs 1.03). Decomposition (`res16.py`): realized profit from closes is positive (+2.5 to +4%) but the open rungs at the end are marked -8 to -10% (about 11 rungs). Gas/fees are not the problem.
- "Sweep" variant (when one rung hits its retrace, also close every other profitable rung, min gain 0.2%): not better (real 12 months 0.87 vs 0.92, 2.5x more trades).
- Stale-rung stop-loss after N days was rejected by design (cycles can be long).

| Config (180d synthetic / real 12 months) | x3 back | flat | real prod | worst month | trades/day |
|---|---|---|---|---|---|
| Plain ladder 2% | 1.031 | 1.072 | 0.782 | 0.803 | 4.1 |
| Live ladder 0.5% | 1.002 | 1.087 | 0.555 | 0.681 | 20.4 |
| Trailing open 2%, trail 2%, esc 1 | 0.936 | 1.023 | 0.918 | 0.930 | 1.8 |
| Same + sweep 0.2% | 0.937 | 1.001 | 0.873 | 0.920 | 5.1 |

### 8.6 Conclusions and open ideas
- Nothing tested beats hold on the real (drifting) history; the live ladder at 0.5% diff is the worst variant tested. Raising its diff to 1-2% should cut losses at little cost in cyclical markets.
- Open rungs on the losing coin are the structural cost of any sell-into-strength design. They are only recovered if the ratio returns, which neither the history nor the simulations can confirm for STRK.
- The user's hypothesis (STRK can still make a 3x vs other coins with big swings, so the ladder harvests more tokens) is plausible and supported by 8.4 in direction, but the synthetic gain is modest and the paths are smoother than reality.
- Next steps: (0) calibrate fee handling, see 8.7 first; (1) paper-trade the plain 2% ladder and the escalating trailing exit next to the live bot and compare token counts over a full swing; (2) find spans in real history where the ratio returned within 3% and compare token counts; (3) a fix for underwater rungs that does not sell at a loss (for example partial re-entry or a cap on the escalation); (4) yield (staking/lending) on idle balances as a separate edge, untested.

### 8.7 Open calibration point: fee check vs actual fee (user observation)
The live bot requires a gain above max(1 STRK, average of the last 10 trade fees) plus the slippage implied by the quote/route, but the real cost is lower in at least 9 of 10 trades, so each trade keeps a small surplus. This matters most for many small trades. The fee optimisation went live around the beginning of summer 2026, which is when the bot's results visibly improved. The replica (`sim_bot.py`) used one cost for both the check and the payment, so it is too pessimistic at tight diff, and all comparisons against the live bot are tilted against it. Before 2026-06 the live bot should be compared with a replica without the surplus, afterwards with it. See the results below if already filled in.

Results (`res18.py`, `sim_bot` now has `gas_chk` and `slip_chk` = cost used in the profit check, separate from the cost actually paid; 12 x 30-day windows, live 0.5% diff / 3% sell, product of wallet/hold):

| Variant | all 12 | first 8 (pre-summer) | last 4 | trades/day |
|---|---|---|---|---|
| ACTUAL bot | 0.730 | 0.894 | 0.817 | 21.6 |
| old replica (check = paid 0.5 STRK) | 0.492 | 0.793 | 0.620 | 29.6 |
| check 1 STRK, paid 0.5 | 0.500 | 0.806 | 0.620 | 25.4 |
| check 1 STRK, paid 0.2 | 0.538 | 0.856 | 0.628 | 26.4 |
| check 1 STRK + 0.3% slippage margin, paid 0.2, leg 0.06% | 0.565 | 0.870 | 0.649 | 23.4 |
| check 1 STRK + 0.3% slippage, paid 0.1, leg 0.03% | 0.563 | 0.884 | 0.637 | 25.7 |
| diff 1%, check 1, paid 0.2 | 0.676 | 0.923 | 0.732 | 12.5 |
| diff 2%, check 1, paid 0.2 | 0.804 | 0.991 | 0.811 | 4.8 |

- The check-vs-paid surplus explains most of the gap in the first 8 windows (replica 0.79 to 0.87-0.88 vs actual 0.894) and brings trades/day closer (23-26 vs 21.6).
- The last 4 windows stay far off (0.62-0.65 vs 0.82), but the per-month view (`res19.py`) shows this is almost entirely the last window (from 2026-09-10, ETH/STRK x0.42). Over the first 10 windows the fee-surplus replica matches the actual bot (0.878 vs 0.871; old replica 0.794). In the last month the replica gets 0.63 vs actual 0.84 and trades 53/day vs 31. The user says the fee optimisations went live around August, so the later months are also the first under the new fee logic, plausibly why the bot traded much less than the replica there. Still unmodelled: open rungs at window start and quote-based skipping in fast markets.
- Even with the surplus the ladder at 0.5% stays below hold; wider diff (1-2%) is still clearly better in the replica (2%: 0.99 pre-summer, 0.80 overall).
- Still to do: measure the real surplus per closed trade from actual data (actual fee vs the check value), and seed the replica with the real open rungs.
### 8.8 Real fee log, and basket tests of "reserve" and "falling-knife delay" (2026-10-11)
Real fee log (about 100 live trades on 2026-10-11): the bot's check value was 1.0-2.05 STRK, the actual fee mostly 0.10-0.30 STRK (5-30% of the check value), with occasional spikes (up to 2.0 and 1.4 STRK) that the next trades compensate. So the real surplus is about 0.8-1.9 STRK per trade. In the replica (`res18b.py`: check 1.4, paid 0.18) the 0.5% ladder gets 0.53 (12 months), 0.85 for the first 8 windows; with 0.06% leg cost plus 0.3% slippage margin 0.57 / 0.88 (actual 0.73 / 0.894). 2% diff with the same fees: 0.805 overall, 0.994 for the first 8 windows.

Basket engine (`bt6.run6`, new switches `reserve`, `rel_x`, `knife`, `gas_pay`; harness `cmp8.py`, `cmp9.py`, outputs `cmp8.txt`, `cmp9.txt`; fee 0.1%, 5% failed tx; metrics: rolling 6 months median / p10 / worst, 12 months worst):
- Falling-knife delay: open threshold = X * (1 + knife * max(0, opens - buybacks in the last 10 open/back events)). Very effective against tails: X=3%: worst 6-month 0.83 to 0.96, p10 0.91 to 0.975, swaps/yr 212 to 52. But medians fall to about 1.00 and the 2026 edge (1.16) disappears (0.99). X=5%: worst 0.90 to 0.976. X=12%: no real change (already safe). knife 1 is as good as knife 2 and trades more.
- Reserved share per token (release when the free part runs out and spread >= rel_x * X): no measurable help. Median and tails about the same as without it (X=5%: p10 0.95 vs 0.93, worst 0.92 vs 0.90, but 12-month worst 0.895 vs 0.903); `rel_x` 1/2/3 gave identical results, so the release almost never triggers in the history (a coin rarely runs out). Reserve 0.4 is slightly better for X=5% (geo 1.005 vs 1.000), within noise.
- Real fee surplus in the basket (check 1.4, paid 0.18 STRK): lifts tight X slightly (X=3%: median 1.014 to 1.020, 12-month worst 0.765 to 0.806; X=5%: 1.006 to 1.011), X=8-12% unchanged. Tails of tight X without knife remain weak.
- Overall: nothing found yet gives a clearly positive edge for the 4-coin basket. X=3-5% plus fee surplus is the most profitable at the median (about +1-2% per 6 months) but with p10 around 0.91-0.95; adding knife delay turns it into a "safe 1.00" (p10 0.98-0.99, worst 0.96-0.98). The basket stays a risk-reducing hold, not a profit machine. The live ladder's profit potential comes from its high trade count with the fee surplus, which the basket does not reach (the basket engine trades 10-200 swaps per year, the live bot about 15-22 per day).
- Not yet done: a lot-based high-frequency basket (many small rungs per pair, like the live ladder but across 4 coins with escalation), tested with the fee surplus and the 1-minute data. This is the most promising untested direction for the stated goal.

### 8.9 High-frequency multi-coin ladder (pairwise lots across 4 coins, 1-minute data)
Engine `ml1.py` (data/history, git-ignored): the live ladder logic per pair (6 pairs from ETH/BTC/USDC/STRK, one shared wallet, lots closed when the ratio retraces by diff + costs, sell 3% of the balance per rung). Harness `ml2.py`, output `ml2.txt`: nine non-overlapping 90-day windows (2024-05 to 2026-10), real fee model (leg 0.06%, check slippage 0.3%, check gas 1.4 STRK, paid gas 0.18 STRK), start capital 100k USD split equally, metric = wallet / hold of the same start.
Validation: at realistic wallet size the engine reproduces `sim_bot` exactly on ETH/STRK (e.g. 726 vs 728 trades, 1.0184 vs 1.0184). With a tiny 3k wallet gas is 1.3% of a lot and the lots differ slightly (ml stores lots net of the opening gas, sim does not).

| config | product 9 windows | worst | windows >= 1 | trades/day | open lots (avg) |
|---|---|---|---|---|---|
| 2-coin ETH/STRK d0.5 | 0.634 | 0.666 | 6/9 | 25.6 | 55 |
| 4-coin d0.5 | 0.496 | 0.700 | 5/9 | 87.3 | 278 |
| 4-coin d1 | 0.615 | 0.762 | 5/9 | 45.6 | 163 |
| 4-coin d2 | 0.759 | 0.847 | 5/9 | 17.8 | 90 |
| 3-coin (no USDC) d0.5 | 0.464 | 0.674 | 4/9 | 52.4 | 156 |
| 4-coin d0.5 + knife 1 | 0.617 | 0.782 | 5/9 | 61.5 | 153 |
| 4-coin d0.5, sell 1% | 0.712 | 0.839 | 5/9 | 99.6 | 277 |

Findings:
- The multi-coin ladder does leverage the swings: 3.4x more trades than ETH/STRK alone (87 vs 26 per day, 4-coin d0.5). The earlier basket engine (10-200 swaps per year) was too slow.
- But more trades do not turn into more value versus hold. The product stays below 1 (0.50-0.76) and is not better than 2-coin. Gains in the good windows (up to 1.19) are cancelled by drift losses in the bad ones (0.70-0.75): lots stay open on coins that fall against the others (278 open on average).
- Cheapest improvements: smaller rungs (sell 1%: 0.50 to 0.71, worst 0.70 to 0.84), knife delay 1 (0.62, worst 0.78), wider diff (2%: 0.76, worst 0.85). Everything is still below hold over the nine windows; USDC in the basket does help (3-coin without USDC worse).
- Windows are drift windows (no return to start ratio), so they mostly measure drift and entry timing, as noted before. Still untested: concentration cap per coin, hop to the best counter pair, per-coin escalation, per-coin top-up when a coin is drained, sell 1% + knife + d1 combined, and the same on return-to-start paths.

### 8.10 Combined test: knife delay + per-coin reserve/top-up + pair hopping, 4k wallet (1000 USD per coin)
`ml1.ladder` gained `reserve` (USD locked per coin, not sellable), `rel_frac` (share of the lock released per top-up) and `tk` (extra knife multiplier on a coin per top-up). Rule: when a sale is blocked and the top-2 coins (by performance since window start) both have no free balance, release `rel_frac` of the top-1 coin's lock (then top-2, iterating) and raise that coin's open threshold by `tk` x diff per top-up; the lock and multiplier reset once the coin's balance is back at its start amount. "Hopping" = per tick the pair with the largest excess over its threshold acts first (closes before opens), so the counter pair is the most profitable one. Real fee model, 9 x 90-day windows, harness `ml3.py`, output `ml3.txt`.

| config (4 coins unless noted, sell 1%) | product | worst | >= 1 | trades/day |
|---|---|---|---|---|
| 2-coin d0.5 (sell 3%) | 0.594 | 0.660 | 6/9 | 11.8 |
| d0.5 | 0.611 | 0.832 | 3/9 | 32.0 |
| d0.5 + knife 1 | 0.891 | 0.930 | 4/9 | 13.5 |
| d0.5 + reserve 300 | 0.601 | 0.829 | 3/9 | 27.2 |
| d0.5 + knife + reserve 300 (tk 1 or 2) | 0.891 | 0.930 | 4/9 | 13.5 |
| d0.5 + knife + reserve 500 | 0.882 | 0.928 | 4/9 | 12.6 |
| d1 + knife + reserve 300 | 0.920 | 0.949 | 4/9 | 8.0 |

- The knife delay is the only element that matters (0.61 to 0.89, worst 0.83 to 0.93). It also cuts trades from 32 to 13.5/day, i.e. it removes the "more trades" the user wanted.
- Reserve/top-up has no effect: alone it changes nothing measurable, with knife the result is identical (the knife already keeps coins from being drained). Top-up almost never fires.
- 4k wallet trades fewer than 100k (gas 0.18 STRK is a bigger share of a 10 USD lot). 
- Still below hold over drift windows (0.89-0.92 over nine windows, about -1% per quarter); good windows are +3-6%, bad ones -5 to -7%. Not yet tested: return-to-start paths, max-share cap, concentration per coin, smaller min lot.

### 8.11 Return-to-start test, max-share cap and rank-gated opening (4k wallet, full 2.4 years, 2026-10-11)
New: `max_share` (flag a coin once its value share exceeds the cap, no more buys of it until it is sold again), `topk` (open only if the sold coin is in the top-k and the bought coin in the bottom-k by 7-day return; closes always allowed = counter hop first), harness `ml4.py` (real path) and `ml5.py` (return-to-start: real path followed by its time reversal, so every coin ends at its start price and hold = 1.0). Real fee model, 1000 USD per coin, sell 1%, min lot 3 USD (kept, lower is not worth it with fees). Outputs `ml4.txt`, `ml5.txt`.

| config | real path full / thirds | return-to-start full / thirds (4.8 y total) | trades/day (rts) |
|---|---|---|---|
| 2-coin d0.5 sell 1% | n/a | 1.176 / 1.11 1.36 1.23 | 1.7 |
| 4c knife 1 | 0.800 / 0.83 1.07 1.10 | **1.614** / 1.16 1.39 1.25 | 12.1 |
| 4c knife + cap 50% | identical (cap never binds) | identical | 12.1 |
| 4c knife + cap 40% | 0.795 | 1.608 | 11.9 |
| 4c knife + cap50 + top1 | 0.900 / 0.91 1.03 1.03 | 1.179 / 1.05 1.10 1.06 | 3.4 |
| 4c knife + cap50 + top2 | 0.863 | 1.332 | 6.7 |
| 4c cap50 top2 no knife | 0.552 | 1.207 | 5.5 |
| 4c cap50 top2 knife d1 | 0.910 | 1.284 | 4.3 |

- Return-to-start is the metric that favours the ladder: the plain 4-coin ladder with knife delay makes +61% over a full there-and-back cycle (about +17%/year) with only 14 open lots at the end, 12 trades/day, and beats 2-coin (+18%). Each third round trip is also positive (+16/+39/+25%).
- On the real drift path the same config ends at 0.80 (first third 0.83: the 2024-25 STRK collapse, still 314 open lots at the end), then 1.07 and 1.10 in the last two thirds. So the result depends on whether the coins come back; the bot gains when the ratios mean-revert and loses (unrealised) when a coin drifts away.
- The 50% cap never binds (knife + 1% rungs keep shares balanced); 40% costs a little. Keep the cap as a safety net, it is free.
- Rank-gated opening (best sells / worst buys, counter hop first) reduces drift loss (0.80 to 0.86-0.91 real path) but cuts the round-trip gain (1.61 to 1.18-1.33) because it removes most trades. Not better overall; knife already provides the protection.
- Min lot: stays at 3 USD.
- Caveat: the mirrored path has the real volatility, so the gain is a mean-reversion best case; no avnu quote differences, size-dependent slippage or MEV. Recommendation: paper trade the "4-coin, 1% rungs, knife 1, X 0.5%, cap 50%" config before real funds.

### 8.12 "Original trade with hops" engine (first test, 2026-10-11)
Engine `ot.py` (harness `ot_run.py`, output `ot_run.txt`): each lot stores origin coin, sold amount S, current coin, amount held, hops and the best amount ever held per coin (initialised with the origin-ratio equivalents, e.g. 200 C / 100 B for 50 A). Hop to coin c when the quote (check fees) beats best[c] by hop_x; close when the origin-coin amount reaches S*(1+X+Y*hops). Lot amounts are gross (gas paid from the STRK balance, not deducted from lots). Opens as in the pairwise ladder with knife 1 (per pair spacing), 1% rungs, 4k wallet, 5-minute steps.

| config | real path | return-to-start (4.8 y) | thirds (rts) | trades/day | hops per close |
|---|---|---|---|---|---|
| no hops (per-lot ladder, knife) | 0.740 | 1.160 | 1.19 1.68 1.30 | 17.1 | 0 |
| hops Y 0.5% hop_x 0.5% | 0.556 | 0.609 | 1.03 1.28 1.16 | 13.9 | 3.3 |
| hops Y 0 | 0.539 | 0.540 | 1.00 1.15 1.10 | 14.5 | 2.2 |
| hops hop_x 1% | 0.547 | 0.624 | 1.02 1.28 1.17 | 13.0 | 2.6 |
| hops, no knife | 0.162 | 1.042 | 1.05 1.36 1.16 | 3.6 | 1.6 |
| hops, X 1% hop_x 1% Y 1% | 0.705 | 0.799 | 1.03 1.34 1.14 | 9.5 | 5.4 |

- Sanity (3-year slice, return-to-start): without any fees hops 1.39 vs no hops 1.57, with fees 1.03 vs 1.18, so no accounting bug; the hop rule itself is worse.
- Why: hopping triggers whenever a coin is cheaper than at the origin ratio (units, not value), so it keeps buying a falling coin (knife) and churns (88k hops vs 4.2k closes without fees) instead of closing; lots drift away from their origin coin and need extra Y per hop. Y per hop and a wider hop_x do not fix it. Thirds are positive but weaker than the plain ladder.
- Side finding: the STRK balance (which pays all gas) is drained to about 40-120 USD at the end in the fee runs; STRK needs a gas reserve in a basket.
- Next ideas: hop only when the hop also gains vs the origin coin in value terms, cap hops per lot, hop only into the coin that is weakest vs the origin.

### 8.13 Hop lots analysis and "rebook after hop" (2026-10-11)
- Lot inspection (3-year return-to-start slice, `ot.py`): with fees lots hop only 0.7 times on average (max 4; 1784 hops vs 1167 closes), so there is no churning or repeated buying of a falling coin (the earlier "falling knife" explanation was wrong). The 129 lots left open are worth 0.988 of their origin value on average (29 below 0.97). Only in the no-fee run do hops run away (about 120 per lot, up to 625).
- Why hops still lose: a hop guarantees more units of the new coin than the lot ever held of it, not more value in the origin coin; if that coin then falls against the origin, the lot waits. Plus gas per hop.
- Rebook variant (new `rebook` flag): after a hop the lot becomes a plain lot "origin A, holding C" registered under pair A/C at its effective ratio, hops reset, no extra Y. Return-to-start 0.62 (hop_x 0.5%), 0.67 (1%), 0.75 (2%) vs no hops 1.16 and the plain pairwise ladder 1.61; real path 0.43-0.50 vs 0.74. Worse than no hops: more open lots (440-550 vs 340) because rebooked lots count in the pair spacing and the knife of the new pair, so the engine opens more new rungs.
- Conclusion for now: hopping inside an original trade does not beat independent per-pair ladders with the knife delay (8.11). A hop only converts value into units of another coin; the gain is real only if the closing leg later pays, and in the tests it did not pay for the extra gas and tied-up lots.

### 8.14 Hop-coin knife instead of per-pair knife (2026-10-11)
Idea (user): with rebook, switch off the per-pair knife and delay only the coin received by a hop. New flag `hk` in `ot.py`: each hop into coin C adds 1 to a per-coin counter, a close of a lot holding C subtracts 1, and opening a lot that buys C needs `hk` extra diff steps per counter point. Harness `ot_run3.py`, output `ot_run3.txt`.

| config (rebook, Y 0) | real path | return-to-start | thirds (rts) | trades/day | open (rts) |
|---|---|---|---|---|---|
| pair knife 1, hop_x 1% (before) | 0.464 | 0.671 | 0.97 1.24 1.20 | 15.8 | 528 |
| no knife at all | 0.175 | 1.003 | 1.01 1.38 1.24 | 4.1 | 318 |
| hop-coin knife hk 1 | 0.683 | 0.920 | 1.00 1.03 1.03 | 2.8 | 47 |
| hop-coin knife hk 2 | 0.703 | 0.949 | 1.02 1.03 1.02 | 2.3 | 48 |
| hk 2, hop_x 0.5% | 0.885 | 0.995 | 1.04 1.02 1.02 | 1.4 | 5 |
| hk 1, hop_x 2% | 0.678 | 0.890 | 1.00 1.05 1.13 | 4.1 | 98 |

- It reduces the drift loss strongly (real path 0.18 without knife to 0.68-0.89) and keeps the lot count tiny (5-48), but the trade count collapses to 1.4-4/day, so the return-to-start gain disappears (about 1.0). It does not reach the plain pairwise ladder with the per-pair knife (rts 1.61, 12 trades/day, real 0.80).
- Net: the hop variants are all a safer-but-flat hold; none improves on 8.11. The hop-coin knife is the closest to "risk-free" (hk 2, hop_x 0.5%: real 0.885, rts 0.995) but earns nothing.

### 8.15 Combining the pairs: per-coin knife and per-coin ladder vs basket index (2026-10-12)
The plain pairwise ladder is effectively six independent 1-on-1 bots on one wallet. Two ways to link them were tested (4k wallet, sell 1%, X 0.5%, real fee model; outputs `ml6.txt`, `ml6r.txt`, `ci_run.txt`).
1. Knife per coin (`kcoin` in `ml1.py`): a pair's open threshold counts opens minus closes of lots into the coin it would buy, across all pairs (instead of that pair's own history).
2. Per-coin ladder vs basket index (`ci.py`): x_c = price / geometric mean of the four coins. A coin rising by X above its open lots sells into the currently weakest coin (a falling coin is bought with the strongest coin); each lot closes when its holding buys back S*(1+X+slip) of the origin coin; knife per (coin, direction) or per coin.

| config | real path | return-to-start | trades/day (rts) | open (rts) |
|---|---|---|---|---|
| pair ladder, pair knife 1 (reference) | 0.800 | 1.614 | 12.1 | 14 |
| pair knife 2 | 0.906 | 1.561 | 10.7 | 15 |
| coin knife 1 | 0.816 | 1.610 | 11.6 | 15 |
| coin knife 2 | 0.900 | 1.505 | 9.6 | 25 |
| coin knife 1, X 1% | n/a | 1.502 | 7.5 | 23 |
| index ladder, knife per dir | 0.836 | 0.963 | 7.4 | 138 |
| index ladder, knife per coin | 0.800 | 1.029 | 9.0 | 163 |
| index ladder, no knife | 0.580 | 1.061 | 6.7 | 290 |
| index ladder, sell side only | 0.905 | 0.982 | 5.2 | 60 |
| index ladder, X 1% | 0.896 | 0.989 | 4.7 | 66 |

- The per-coin knife changes nothing material (1.61 vs 1.61; real path 0.82 vs 0.80). Knife 2 is the useful knob: real path 0.80 to 0.90 for rts 1.61 to 1.56 (pair or coin version, same).
- The index ladder is clearly worse on return-to-start (about 1.0 vs 1.61), better only on the drift path (0.84-0.90). It trades half as much: relative-to-index triggers fire less often than the per-pair ratios. Per-pair ratios are the better source of swings.
- Idea "best single action per tick": the engine already executes closes first and then the pair furthest past its threshold, one action per tick, so this is already in the reference.
- Triangular netting of lots (idea 4): no cheap, correct rule found (lots hold amounts per pair at different ratios); expected impact low, not built.
- Best candidate so far: pair ladder, 1% rungs, X 0.5%, knife 1-2 (rts 1.56-1.61, real 0.80-0.91).

### 8.16 Live-bot falling knife (bigger rungs + higher buy back) on all three bots (2026-10-12)
Logic as now implemented in the live 1:1 bot (`src/quote.ts` `getFallingKnife`): per pair, over the last 10 transactions, `counter = unmatched - matched` (matched of the opposite direction of the unmatched; "same" = previous version). If counter > 1 the new rung sells `sell% x counter` and stores the counter; "higher bb" = its buy back needs `diff x max(counter)`, "normal bb" = plain diff. No opening delay. New switches `fk`, `fk_bb`, `fk_same`, `fk_cap` in `ml1.py` and `ot.py` (defaults off, earlier results reproduce exactly). Harness `fk_run.py`, report `fk_report.py`, outputs `fk_run_*.json`, `fk_caps_*.json`. Real fee model; 1:1 = ETH/STRK sell 3% (4k and 100k wallet), 4c ladder and 4c hop (hop_x 0.5%, Y 0.5%) = 4k, sell 1%; all X 0.5%.

| bot | variant | real path | rts | 9x90d product (worst) | trades/day (rts) |
|---|---|---|---|---|---|
| 1:1 100k | none | 0.173 | 1.129 | 0.635 (0.665) | 3.7 |
| 1:1 100k | old knife (delay) | 0.239 | 1.220 | 0.730 (0.709) | 8.9 |
| 1:1 100k | fk higher bb, opp (live) | 0.149 | 1.098 | 0.585 (0.592) | 0.2 |
| 1:1 100k | fk higher bb, same | 0.151 | 1.105 | 0.548 (0.591) | 0.3 |
| 1:1 100k | fk normal bb, opp | 0.166 | 1.119 | 0.655 (0.656) | 1.0 |
| 1:1 100k | old + fk higher, cap 2 | 0.226 | 1.209 | 0.732 (0.710) | 8.0 |
| 1:1 4k | old knife (delay) | 0.389 | 1.298 | 0.779 (0.760) | 3.0 |
| 1:1 4k | fk higher bb, opp (live) | 0.150 | 1.096 | 0.547 (0.605) | 0.1 |
| 1:1 4k | old + fk higher, cap 2 | 0.310 | 1.249 | 0.784 (0.751) | 2.0 |
| 4c ladder | none | 0.211 | 1.430 | 0.610 (0.832) | 8.1 |
| 4c ladder | old knife (delay) | 0.800 | 1.614 | 0.880 (0.931) | 12.1 |
| 4c ladder | fk higher bb, opp | 0.101 | 1.377 | 0.390 (0.663) | 0.6 |
| 4c ladder | fk higher bb, same | 0.102 | 1.420 | 0.398 (0.665) | 0.7 |
| 4c ladder | fk normal bb, opp | 0.099 | 1.190 | 0.381 (0.650) | 1.0 |
| 4c ladder | fk higher, opp, cap 2 | 0.125 | 1.248 | 0.509 (0.755) | 2.6 |
| 4c ladder | old + fk higher, cap 2 | 0.665 | 1.636 | 0.865 (0.926) | 10.9 |
| 4c hop | none | 0.162 | 1.042 | 0.590 (0.791) | 3.6 |
| 4c hop | old knife (delay) | 0.556 | 0.609 | 0.808 (0.888) | 13.9 |
| 4c hop | fk higher bb, opp | 0.097 | 1.168 | 0.370 (0.637) | 0.8 |
| 4c hop | old + fk higher, opp | 0.228 | 0.870 | 0.581 (0.743) | 5.0 |

- The size knife alone is a martingale: the counter reaches 10 in every bot, rungs grow to 10x, the wallet ends up in the falling coin and the bot stalls (0.1-1 trades/day; on return-to-start the full result equals the first third). Real path and 90-day windows are worse than no knife at all (4c ladder 0.10 vs 0.21 real, 0.39 vs 0.61 windows). It only shines when a deep move fully reverts (rts middle third 2.0-3.0), which is the martingale payoff.
- Higher vs normal buy back: higher is better on return-to-start (4c 1.38 vs 1.19), about equal on the drift tests; with the delay knife and cap 3 the difference is within noise (4c rts 1.68 vs 1.65, windows 0.855 vs 0.840; 1:1 100k 1.211 vs 1.198).
- Matched opposite vs same direction: small and mixed. Across the 8 bot/buy-back combinations, "opposite" wins the 90-day windows 5 of 8 (e.g. 1:1 100k 0.585 vs 0.548, hop 0.370 vs 0.336; but 1:1 4k 0.547 vs 0.608), "same" wins return-to-start 7 of 8 by 0.01-0.04 (1:1 4k normal bb 1.25 vs 1.09 is the only large gap). Inside 10 transactions most open/close pairs fall in the window together and count the same either way.
- Capping the counter (2-3) removes most of the damage but the size knife alone still loses to the delay knife. Adding the capped size knife on top of the delay knife is neutral (4c rts 1.61 to 1.64, windows 0.88 to 0.87, real 0.80 to 0.67; 1:1 about equal).
- Conclusion: the delay knife (open threshold `diff x counter`) stays the best variant on all three bots; the size multiplier should be capped (2) or dropped, the higher buy back is a small optional plus.

### 8.17 Statistical structure of the 4 coins, and volatility-matched rung spacing (2026-10-12)
Historical exploratory results: the initial rolling-vol implementation included one future hourly return. Section 8.19 corrects that implementation and supersedes the implementation/parity and transfer claims below. Low unconditional correlations and variance ratios alone do not establish or exclude a tradable edge.
Question: is there exploitable cross-asset structure beyond running parallel ladders? Analysis `an1.py` (1-minute data, 893 days), new `ml1.py` switches `pair_filter` (only pairs containing one coin), `ema_z`/`ema_hl` (open a rung only when the log ratio is stretched >= z sigma from its EMA), `vol_k`/`vol_roll` (per-pair open spacing = max(diff, vol_k x hourly vol of that pair's ratio), static or trailing 30-day; close target stays at diff). Harness `ms_run.py`, outputs `ms_run.json`, `ms_tune.json`, `ms_tune2.json`. Defaults off, regression (1.614 / 1.106) reproduces.

Measured structure (what there is to exploit):
- Mean reversion lives only in the STRK pairs: variance ratios (base 5m) 0.51-0.62 at every horizon from 30m to 7 days for ETH/STRK, BTC/STRK, USDC/STRK. ETH/BTC and ETH/USDC are 0.94-1.02 (random walks), BTC/USDC mildly reverting at long horizons (0.88). Grid-trading the non-STRK pairs harvests little and adds drift risk.
- Pair vols differ 4x: hourly sigma ETH/BTC 0.41%, BTC/USDC 0.49%, ETH/USDC 0.69%, ETH/STRK 0.97%, BTC/STRK 1.06%, USDC/STRK 1.25%. A fixed 0.5% grid is 1.2 sigma for ETH/BTC but only 0.4 sigma for USDC/STRK - the STRK pairs trigger on plain noise.
- Cross-sectional reversal is dead: future return of (loser minus winner vs basket) is about 0 or negative for all lookback/holding combinations 1h-7d. "Buy the laggard" stat-arb has no edge here.
- Lead-lag is dead: no coin's 5-60m return predicts another's next bar (all |corr| < 0.03). Only own-bar bounce (-0.08 to -0.11 at 5m, microstructure, eaten by fees).

Results (4k wallet, X 0.5%, real fee model; volk N = spacing N x hourly vol, kM = delay knife M, sell = rung %):

| bot | variant | real path | rts | 9x90d prod (worst) | tr/d rts |
|---|---|---|---|---|---|
| 4c ladder | ref knife1 (8.11 best) | 0.800 | 1.614 | 0.880 (0.931) | 12.1 |
| 4c ladder | strk3 knife1 (STRK pairs only) | 0.781 | 1.461 | 0.916 (0.927) | 9.4 |
| 4c ladder | ema z1 hl1d + knife1 | 0.810 | 1.330 | 0.907 (0.954) | 6.3 |
| 4c ladder | volk2 k1 | 0.940 | 1.568 | 0.904 (0.936) | 10.6 |
| 4c ladder | **volk2 k1.5 sell2** | 0.935 | 1.798 | 0.898 (0.933) | 9.9 |
| 4c ladder | volk2 k2 | 1.027 | 1.346 | 0.953 (0.970) | 6.3 |
| 4c ladder | roll30 volk2 k2 | 1.030 | 1.345 | 0.955 (0.968) | 6.4 |
| 4c ladder | roll30 volk2 k1 sell3 | 0.725 | 2.067 | 0.785 (0.882) | 11.1 |
| 1:1 4k | ref knife1 | 0.389 | 1.298 | 0.779 (0.760) | 3.0 |
| 1:1 4k | roll30 volk3 k1 | 0.756 | 1.364 | 0.893 (0.875) | 2.6 |
| 1:1 100k | ref knife1 | 0.239 | 1.220 | - | 8.9 |
| 1:1 100k | roll30 volk3 k1 | 0.610 | 1.358 | - | 4.8 |
| 4c 100k | roll30 volk2 k1.5 sell2 | 0.785 | 1.950 | - | 26.2 |
| 4c 100k | roll30 volk2 k2 | 0.965 | 1.521 | - | 22.5 |

Findings:
- **Volatility-matched spacing is the real improvement.** `volk2 k1.5 sell2` dominates the old best (knife 1) on every metric: real 0.935 vs 0.800, rts 1.798 vs 1.614, windows 0.898 vs 0.880, worst 0.933 vs 0.931. Wide vol-scaled entries + tight 0.5% close target = fewer, deeper, more profitable rungs per pair; each pair trades its own noise instead of one grid for all. The spacing knob is a clean risk dial: volk2 k2 is the first config at or above hold on the real drift path (1.03) while keeping rts +35%; volk2 k1 sell3 is the harvest end (rts 2.03-2.07, real 0.73).
- Trailing 30-day vol (no lookahead, implementable live) equals or beats full-path vol everywhere, so the result transfers.
- STRK-pairs-only (drop ETH/BTC, ETH/USDC, BTC/USDC) is not better than 6 pairs (rts 1.46 vs 1.61): the non-STRK pairs contribute little but cost nothing, and with vol spacing they self-regulate (their grid stays near 0.5-1%).
- The EMA-stretch gate (open only beyond z sigma from the EMA) protects like the knife but cuts rts to 1.33; the knife does the same job better. Without the knife the gate is not enough (real 0.31).
- Cross-sectional stat-arb and lead-lag momentum are ruled out by the data itself (see structure above) - the edge of the 4-coin wallet is only diversification of mean-reverting pairs plus shared inventory, not coin-vs-coin prediction.
- For the live 1:1 bot the same change applies: opening gap = max(0.5%, 3 x trailing hourly vol of ETH/STRK) x knife counter. On 100k it cuts the drift loss by 2.5x (0.61 vs 0.24) and raises rts (1.36 vs 1.22) with half the trades.
- Caveats: hourly vol from Binance 1m data; avnu quote spreads, size-dependent slippage and MEV unmodelled; the sell2/sell3 harvest variants concentrate more value per rung, so execution slippage matters more there.

### 8.18 4k-wallet optimisation of the vol-spaced ladder (2026-10-12)
Historical exploratory results, not an out-of-sample validation or an exact replay of the current live bot. See section 8.19 for corrected causal volatility, the hybrid counter plus capped buy-back, and comparable absolute wallet values. The event-count baselines labelled "live" below do not use the live bot's mutable matched/unmatched counter.
Both bots will run with about 4k USD, so the full grid was rerun at 4k (all with trailing 30-day vol): 1:1 `vol_k` 2-5 x `knife` 1-3 x `sell` 2-10%; 4c `vol_k` 1.5-3 x `knife` 1-2(3) x `sell` 1-5%; plus `close_k` (new in `ml1.py`: a rung's close target is max(diff, close_k x hourly vol at open) instead of the flat diff). Harness `ms_sweep.py` (env `MS_FINAL` for the finalists with thirds), report `ms_sweep_rep.py`, outputs `ms_sweep.json`, `ms_final.json`.

| bot (4k) | config | real path (thirds) | rts (thirds) | 9x90d prod (worst) | tr/d |
|---|---|---|---|---|---|
| 1:1 | live logic today (= delay knife 1) | 0.389 (0.66 0.93 1.12) | 1.298 (1.13 1.53 1.29) | 0.779 (0.760) | 3.0 |
| 1:1 | **v4 k3 s3** | 0.971 (0.96 1.04 1.05) | 1.309 (1.08 1.12 1.10) | 0.972 (0.939) | 1.7 |
| 1:1 | v4 k2 s3 | 0.943 | 1.301 | 0.966 (0.922) | 1.8 |
| 1:1 | v5 k2 s3 | 0.887 | 1.300 | 0.952 (0.947) | 1.7 |
| 4c | old best (8.11: knife 1, sell 1) | 0.800 (0.83 1.07 1.10) | 1.614 (1.16 1.39 1.25) | 0.880 (0.931) | 12.1 |
| 4c | **v2.5 k2 s2 c2** | 1.005 (0.89 1.11 1.08) | 1.715 (1.14 1.35 1.20) | 0.943 (0.955) | 4.9 |
| 4c | v2.5 k2 s2 | 0.996 | 1.680 | 0.930 (0.950) | 8.3 |
| 4c | v2.5 k2 s3 c2 (harvest) | 0.936 (0.83 1.15 1.12) | 2.059 (1.24 1.56 1.30) | 0.881 (0.935) | 5.4 |
| 4c | v2.5 k2 s1 (defensive) | 1.023 | 1.313 | 0.955 (0.968) | 5.6 |

- At 4k big rungs are poison on the drift path (1:1 sell 10%: real 0.24-0.41; 4c sell 5%: 0.39-0.71): one deep stack ties up too much of a small wallet. Sell 2-3% is the optimum for both bots.
- Knife 2-3 with wide vol spacing beats knife 1 everywhere at 4k. The best 1:1 config is near hold on the real path (0.971 vs 0.389 for the current live logic, 2.5x less drift loss) with the same rts and windows 0.972 vs 0.779.
- The vol-scaled close target (close_k 2) is a genuine small improvement on 4c: windows 0.930 to 0.943, rts 1.680 to 1.715, real 0.996 to 1.005, at almost half the trades (8.3 to 4.9/day). On 1:1 it is neutral.
- Overfit check: ranking of the top configs is the same in the first 5 and last 4 windows, and neighbours of the winners (v2-v3, k2-k3) perform within a few points - a plateau, not a spike.
- Recommended for real use: 1:1 `vol_k 4, knife 3, sell 3%`; 4c basket `vol_k 2.5, knife 2, sell 2%, close_k 2` (or sell 3% for the aggressive mean-reversion bet). Translation for the live 1:1 bot: opening gap = max(0.5%, 4 x trailing 30d hourly vol of ETH/STRK) x knife counter, trade size 3%, buy-back target plain 0.5%.

Knife window and knife strength (user questions; `kn_run.py`, `kn2_run.py`):
- A shorter knife window (6 or 8 instead of 10 transactions) does not make the knife kick in earlier - the counter rises by 1 per net unmatched trade regardless. The window only caps the counter and sets how fast old opens are forgotten; with 6 the gap relaxes during a long downtrend and the bot buys again. It is worse everywhere for the plain 1:1 bot (n6: real 0.33, windows 0.75 vs n10 0.39 / 0.78). Longer windows are better: n20 0.47 / 0.84, n40 0.56 / 0.89. For the vol-spaced configs n10 stays best (1:1) or is within noise (4c).
- Keeping the 0.5% gap (frequent trading preserved) and only strengthening the knife is the best per-trade-count option for the 1:1: `knife 2, window 40` gives real 0.677, rts 1.415 (best 1:1 rts of all variants), windows 0.939 (worst 0.854) at an unchanged 3.1 trades/day; `knife 3, n40` real 0.722, windows 0.946 at 2.6/day. The vol gap still protects more (real 0.971) but costs about 40% of the trades; the knife-only route only suppresses opens inside downtrends and keeps harvesting chop.
- Counting variants (user idea: arm earlier after a busy balanced phase; `knife_live`/`knife_open` in `ml1.py`, `kn3_run.py`): with one window the buy-backs "bank credits" (after 20 opens + 20 closes the knife arms only at the 21st new buy). Hybrid = opens counted over the last 40 txs, buy-back credits only over the last 10: 1:1 real 0.579, rts 1.516, windows 0.828 (worst 0.783) at 4.2 trades/day - more trades and the best rts, but clearly weaker drift windows than ev n40 (0.939). Credit window 6 lies between; credits 0 (counter = still-open rungs within the last 40 txs) equals ev n40 (real 0.683, windows 0.929, worst 0.867 - slightly better worst). Counter = all open rungs without any window kills trading (0.7-1.4/day). Same picture on 4c (hybrid: rts 1.715 to 1.845, windows 0.943 to 0.859). So: single long window = drift protection; short credit window = mean-reversion bet with more trades; no free lunch.

### 8.19 Corrected 4k comparison, shared inventory and portfolio rotation (2026-10-12)

Research only; no live source changes. Engines/harnesses: `ml1.py`, `portfolio_rotation.py`, `basket_round4.py`, `test_basket_round4.py`. Outputs: `basket_round4.json`, `basket_round4_followup.json`, `basket_round4_regime.json` in git-ignored `data/history`. There were 832 strategy/scenario/cost runs across these batches.

#### Corrections to earlier conclusions

- Rolling volatility previously indexed the return ending at hour h+1 at hour h. It now includes only completed hourly returns, with hourly threshold refresh instead of daily refresh. A prefix-invariance test verifies that appending future prices does not change earlier simulated trades.
- The live-style hybrid now stores its counter before the new opening is added, and uses the live buy-back cap of 2. Previous `knife_live` tests used plain 0.5% closes, while earlier "live" event-count baselines used a different counter altogether. These are still simplified price-based simulations, not exact avnu execution parity.
- The research delay knife is `1 + strength * net-event-count`; the live hybrid uses still-unmatched transactions minus recent opposite-direction matched transactions. They are distinct variants, not interchangeable labels.
- Previous split-window comparisons reused data already examined during strategy selection. They are descriptive subperiod checks, not untouched holdouts, and do not prove resistance to overfitting.
- Full-path variance ratios and small unconditional lead-lag correlations suggest hypotheses; they neither prove tradable mean reversion nor rule out all cross-asset predictive strategies.
- Funding is 4000 USD for every strategy. The 1:1 starts 50/50 ETH/STRK; the basket starts 25% each ETH/BTC/USDC/STRK. Compare both absolute ending dollars and surplus versus each strategy's own passive allocation.

#### New mechanisms

1. **Shared inventory guard:** all six ladders consult the same wallet. Block another buy into a coin once its portfolio weight exceeds its passive-basket weight by 5 or 10 percentage points. Closing remains allowed. This gate is checked before an open, not a strict post-trade weight cap.
2. **Bounded global portfolio rotation, no ladders or lots:** compute each coin's log return relative to the basket; tilt passive weights with a 20% signal multiplier, normalize, and transfer directly from the most overweight coin to the most underweight. Each trade is at most 3% of equity; only rebalance a deviation exceeding 1% of equity. Test short-term reversal, rebound-confirmed reversal, trend-gated reversal, and 7/30/60-day momentum.
   - Reversal uses deviation from a causal one-day EMA; momentum uses a bounded 7/30/60-day relative-return signal.
   - Unlike origin-bound lots, this strategy can realise losses. It is not a profitable-close-only algorithm.
   - Actual STRK gas is deducted from the wallet, with an affordability check; no fabricated negative-balance credit.
3. **Two sleeves:** allocate 75/25 or 50/50 capital to the balanced ladder and momentum rotation. Each sleeve pays its own costs. This is capital budgeting, not a fully integrated shared execution optimizer.
4. **Trend-only wide gaps:** keep the tight gap in ordinary chop. Apply volatility-wide spacing only to an opening direction that buys the losing side of a pair after a >5% seven-day relative move (or >3% one-day move). Signals update hourly; buy-back targets stay unchanged. This aims to preserve small-bounce activity without funding every rung of a sustained move.

#### Historical results

Full real path, its mirrored return-to-start (RTS), three real thirds, and nine non-overlapping 90-day windows. Real costs: 0.06% swap cost, 0.18 STRK paid gas, existing ladder profit checks. Stress costs double swap cost and paid gas. Ratios below are wallet / own passive hold; >1 means trading added value, not necessarily a positive USD return.

| 4k strategy | Real vs hold | Ending USD | RTS vs hold | 9-window product / worst | Trades/day, real |
|---|---|---|---|---|---|
| 1:1 current hybrid, higher buy-back capped at 2 | 0.582 | 990 | 1.484 | 0.873 / 0.800 | 2.7 |
| 1:1 vol defensive (v4, delay knife3) | 0.866 | 1473 | 1.276 | 0.958 / 0.938 | 1.2 |
| 1:1 hybrid, trend-only wide gap, 7d | 0.760 | 1292 | 1.695 | 0.899 / 0.837 | 2.9 |
| 4c hybrid tight, sell1 | 0.945 | 2987 | 1.678 | 0.883 / 0.947 | 8.9 |
| **4c balanced vol ladder (v2.5, knife2, sell2, close2)** | **1.063** | **3360** | **1.803** | **0.942 / 0.951** | **4.4** |
| 4c vol hybrid, sell2 | 0.954 | 3015 | 1.848 | 0.853 / 0.931 | 7.3 |
| 4c vol ladder + inventory10 | 0.941 | 2976 | 1.449 | 0.942 / 0.952 | 2.6 |
| 4c existing hopping reference | 0.556 | 1757 | 0.609 | 0.808 / 0.888 | 15.9 |
| 4c global reversal | 0.890 | 2813 | 0.815 | 0.856 / 0.965 | 4.5 |
| 4c global momentum30 | 1.090 | 3447 | 1.194 | 1.032 / 0.952 | 0.9 |
| 4c 50/50 ladder/momentum sleeves | 1.032 | 3263 | 1.395 | 0.975 / 0.980 | 3.9 |
| 4c hybrid, trend-only wide gap, 1d | 0.988 | 3125 | 1.645 | 0.916 / 0.955 | 8.3 |

Passive ending wallets are 1700 USD for ETH/STRK and 3161 USD for the four-coin basket. Thus much of the basket's absolute advantage is allocation, especially less STRK plus USDC, not the algorithm. The balanced basket adds 198 USD over its own hold; current simulated 1:1 subtracts 710 USD from its hold. All shown full-history strategies still finish below their initial 4000 USD.

The balanced basket beats current simulated 1:1 in absolute ending dollars in 8/9 quarter windows. However, its own-hold window product remains below 1. That product is a summary of separately restarted windows, not the return of a continuously compounded live wallet.

Double-cost results: balanced basket real 1.003, RTS 1.622, windows 0.917; current 1:1 hybrid real 0.579, RTS 1.379, windows 0.811. The basket's real-path trading surplus becomes nearly zero. The tight hybrid basket drops to 0.911 real / 0.846 windows. More activity is not itself an advantage.

#### Stress paths and subperiods

Joint seven-day return-block resampling, three fixed seeds, 180-day paths. The same time blocks are used for all assets to preserve within-block cross-asset moves. Range paths remove each coin's full-path sampled drift (a synthetic scenario construction, not an input to the trading signals); drift paths retain it. Only three seeds, so this is a limited stress check, not statistical proof.

| Strategy | Range mean / worst, vs hold | Drift mean / worst, vs hold |
|---|---|---|
| 1:1 current hybrid | 1.077 / 1.047 | 0.960 / 0.699 |
| 1:1 vol defensive | 1.023 / 1.015 | 0.981 / 0.864 |
| 1:1 trend-only gap7 | 1.033 / 1.030 | 0.961 / 0.735 |
| 4c balanced vol ladder | 1.035 / 1.031 | 0.997 / 0.917 |
| 4c trend-only gap1 | 1.043 / 1.027 | 0.983 / 0.906 |
| 4c momentum30 | 0.944 / 0.899 | 0.951 / 0.898 |
| 4c 50/50 sleeves | 0.979 / 0.955 | 0.968 / 0.959 |

Momentum30 wins 6/9 historical windows and has a product above 1, but the last four windows compound to 0.976 and the synthetic tests lose. The 7/60-day variants and combined sleeves do not remove this weakness. Keep momentum as an unproven candidate, not a production recommendation.

#### What to retain

- **Best basket candidate in this round:** causal vol-balanced ladder, 2% rungs, 2x volatility close target. It improves the recovery-path payoff and drift survival, but has not established a robust positive edge versus passive holding across windows.
- **Activity-oriented alternative:** hybrid + trend-only wide gaps. The 1:1 improves both real and RTS versus its current simulated baseline at similar activity; the basket retains about 8/day but sacrifices protection relative to always-wide spacing.
- **Not improved:** legacy hop logic, global reversal, and simple shared inventory gates. Gates lower tail exposure/activity, but do not raise harvesting returns.
- **Genuinely non-ladder candidate:** bounded momentum portfolio. Good on this real history, weak on stress paths; needs fresh forward data before claiming an edge. A more sophisticated signal must beat this simple control out of sample and after costs.
- **Answer to "more profitable than 1:1?":** the basket is better in most historical dollar comparisons here and in the long mirrored path, but 1:1 wins the drift-neutral synthetic range test. No general guarantee; basket diversification and trading edge must be reported separately.

Validation: three unit tests pass (flat-price no-trade, rotation accounting/nonnegative holdings, causal prefix invariance), and legacy no-vol reference results still reproduce 1.614 and 1.106. No exact live replay, 119-open-trade seeding, size-dependent avnu slippage, MEV, failed-trade clustering, or truly new out-of-sample market data. All runs start fresh and volatility has an expanding warm-up. Research scripts/results remain git-ignored; this document is the persistent tracked record.

### 8.20 1:1 trend-only gap: trade-based trend/volatility and settings grid

Question: can the trend and volatility for the trend-only wide gap be computed from the bot's own stored transactions (ratio + timestamp) instead of a separate price history? Script `data/history/trend_gap_grid.py`; `ml1.ladder` gained `trend_src='trades'`, `vol_src='trades'` and `trend_gap_mult`. All runs: 1:1 ETH/STRK, $4k, 3% rungs, live hybrid knife (40/10, strength 2, buy-back cap 2), fresh start. 41 configs x 17 scenarios (real, RTS, nine 90-day windows, 3 synthetic range + 3 synthetic drift) x base and double costs = 1,394 runs.

Definitions (checked hourly, causal):
- **trend (trades):** `move = log(current ratio / ratio of the last own trade at least d days old)`; no such trade -> no trend.
- **vol (trades):** `sd = sqrt(sum of squared log-ratio steps between consecutive own trades in the last 30 days / hours)`; gap multiplier `max(1, k * sd / 0.5%)`; fewer than 3 trades -> 1.
- **fixed:** constant multiplier x in an adverse trend.
- The wide gap applies only to openings buying the coin that fell by more than m; it multiplies with the knife factor.

Selected base-cost results (vs own hold; windows = product / worst; synthetic = range mean, drift mean / worst):

| Config | Real (USD) | RTS | Windows | Range | Drift | Tr/day |
|---|---:|---:|---:|---:|---:|---:|
| current hybrid | 0.582 ($990) | 1.484 | 0.873 / 0.800 | 1.077 | 0.960 / 0.699 | 2.7 |
| price d7 m5% vol4 (8.19) | 0.760 ($1292) | 1.695 | 0.899 / 0.837 | 1.033 | 0.961 / 0.735 | 2.9 |
| **trades d7 m5% tvol4** | 0.829 ($1410) | 1.648 | **0.967** / 0.885 | 1.039 | 0.978 / 0.776 | 2.8 |
| trades d14 m5% tvol4 | **0.873** ($1485) | 1.697 | 0.926 / 0.863 | 1.053 | 0.965 / 0.775 | 3.0 |
| trades d14 m10% tvol4 (milder) | 0.821 ($1396) | **1.742** | 0.966 / 0.866 | 1.061 | 0.968 / 0.757 | 3.1 |
| trades d7 m5% fix4 | 0.795 ($1352) | 1.662 | 0.927 / 0.880 | 1.054 | 0.991 / 0.797 | 2.9 |
| price d3 (any) | 0.66-0.73 | 1.57-1.65 | 0.79-0.82 | ~1.055 | ~0.94 / ~0.70 | ~2.9 |

Double costs: trades d7 m5% tvol4 stays first on windows (0.930, real 0.817, RTS 1.499) versus hybrid 0.811 / 0.579 / 1.379.

Findings:
- Using the bot's own trades works as well as or better than using minute prices. The trade-based vol has a similar median (about 6.9x base vs 6.2x) but a fatter top (90th percentile about 15x vs 11x), because trade-to-trade steps grow during trends, so it widens more when it matters.
- The good region is consistent: trade-based, d 7-14, m 5-10%, k 4-8. Three-day lookbacks are too twitchy and are worse than d7/d14 everywhere. Fixed x2 adds little; fixed x4 is a simple but weaker alternative.
- Cost: every trend gate gives up some drift-neutral range harvest (1.077 -> 1.04-1.06). The milder m10% variants keep more of it.
- With trade references the gate is active (in one direction) 62-77% of the time. "Only in trends" still means one side is wide most of the time; the other side keeps the base gap.
- Caveat: 41 configs were selected on the same history; the neighbourhood consistency is the main argument against pure overfitting. No live replay, no seeding with the 119 open trades.
