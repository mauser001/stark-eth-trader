# The Stak-Eth Trader

This tool is open source. Feel free to use / copy / modify it.

## Disclaimer
**Use at your own risk!**
This is not a financial tool, you can loose all your coins!
It is just an experimental tool and should not be used to to try to gain money!

## Description
This tool tries to trade Strk vs Eth on Starknet via the Avnu Dex aggregator . It tries to gain the amount of tokens.

Used tech / Prerequisites:
- NodeJs
- [Starknet Sdk](https://github.com/starknet-io/starknet.js)
- [Avnu Sdk](https://github.com/avnu-labs/avnu-sdk)

## Installation
- clone git repo
- run ```script npm install```
- copy the .env.example to .env and set the Private and Public key
- in th package.json change the path's of the .env and data file to your liking (and also name and place the related files accordingly)
```script
    "prod": "npm run build && node --env-file=prod.env dist/app.js"
```
- then run ```script npm run prod``` (if you first want to try it on Testnet you can run 'npm run dev', but at creation of this Sepolia was not yet supported by Avnu and Görli was about to die)

## .env file
- USE_TESTNET - true/false
- ETH_TOKEN - eth token address 
- STARK_TOKEN - strk token address (in theory you could also use another supported token address to trade against eth)
- WALLET - your public wallet address
- X - your private key
- SELL_PERCENT - percent of your total amount that should be traded within one trade 
- MIN_SEL_AMOUNT_ETH - min amount of eth to sell (if sell percent is lower we use this amount, if not enough balance in wallet we don't trade)
- MIN_SEL_AMOUNT_STRK - min amount of strk to sell
- TRADE_DIFFERENCE_1000 - difference needed for a good trade in 10th of a percent
- MIN_GAS_FEES - if gas fees fluctuate use to set min gas for logic
- NODE_RPC - will be used to replace the default node rpc
- TRADE_FILE - relative path to the trading data file, make sure it exists and has the initial content:
```json
[
	{
		"hash": "initial",
		"status": "SUCCEEDED",
		"matchedBy": "initial"
	}
]
```
- FAILED_TRADE_FILE - relative path to the file tracking failed trades / their fees (defaults to `failedTrades.json`)
- AGGREGATE_FILE - relative path to the aggregate report file that keeps totals for trades removed by `extractMatched` (defaults to `<TRADE_FILE base>_aggregate.json`)
- TIP - FRI per L2 gas paid on top of the base fee to prioritize inclusion; keep at 0 unless faster inclusion is required
- EST_L2_GAS - rough L2 gas consumed by a swap, only used to translate the per-gas TIP into an approximate flat STRK cost for profitability checks
- MAX_GAS_FEES - application-level safety limit (in FRI) for the total tx fee; 0 disables the check
- FEE_BUFFER_1000 - allowed overshoot (per mille) of the actual tx fee above the fee the trade was calculated with
- TARGET_ETH_BALANCE - once the latest transaction's ETH balance reaches/exceeds this, the process stops trading; 0 disables the check
- ETHERNET_ADAPTER_NAME / ETHERNET_RESTART_COOLDOWN_MS / ETHERNET_RESTART_ERROR_WINDOW_MS - optional, used to auto-restart a flaky ethernet adapter on repeated network errors (see `src/ethernet.ts`)
- WEBAPP_URL / WEBAPP_SECRET - optional, endpoint + shared secret for reporting trades to the webapp dashboard (see [Webapp dashboard](#webapp-dashboard) below); leave both empty to disable reporting entirely

## Program logic

- Initially it gets your token balances
- It then get the trading quotes from Avnu
- If the ratio is good enough the trade is concluded
- Then in the future if the price goes in the other direction it then tries to sell the stack back to gain coins.

## Reporting

Run ```script npm run report-prod ``` to get a short summary of your trades

### Local data & aggregate reports

All trade data lives locally in `TRADE_FILE` (plus `FAILED_TRADE_FILE` for failed-tx fees). Since old matched trades get moved out of the live file by `extract-prod`, running totals for those closed positions are kept separately in `AGGREGATE_FILE` so reports still stay accurate - `npm run backfill-aggregate-prod` (re-)builds it from scratch from the live file + archives, and `npm run add-transfer-prod -- <ethWei|-> <strkWei|-> [note]` records manual wallet top-ups so they aren't counted as trading profit.

## Cleanup

Run ```script npm extract-prod ``` to to extract already matched trades in ha separate file

## Webapp dashboard

The `webapp/` folder is a small, self-contained PHP + static site (not built by `tsc`) you can deploy to any plain PHP host (e.g. via FTP) to see your stats in a browser: current ETH/STRK balance, a balance-over-time chart, a daily matched-trades chart (net ETH + trade count) and the last 100 trades.

The trader is the only source of truth - after every confirmed trade it POSTs a small snapshot to `webapp/ingest.php` (see `WEBAPP_URL`/`WEBAPP_SECRET` above), which just persists it into small, bounded json files under `webapp/data/`. This never blocks or crashes the trading loop: the local trade file is always saved first, and any reporting failure (offline server, wrong URL, etc.) is only logged as a warning.

To deploy:
1. Upload the whole `webapp/` folder to your PHP host.
2. On the server, copy `webapp/config.sample.php` to `webapp/config.php` and fill in `ingestSecret` (must match `WEBAPP_SECRET`), `viewerPassword` (what you'll type on the dashboard) and `dataDir`.
3. Set `WEBAPP_URL` (pointing at `.../webapp/ingest.php`, not just the folder) and `WEBAPP_SECRET` in `prod.env`.
4. Run `npm run seed-webapp-prod` once to backfill the dashboard with your full trade history (merges archives + live file); safe to re-run any time to fully reseed.
5. Open `index.html` in a browser, enter the viewer password once (it's cached in `localStorage` afterwards).

