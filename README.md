# The Stak-Eth Trader

This tool is open source. Feel free to use / copy / modify it.

## Disclaimer
**Use at your own risk!**
This is not a financial tool, you can loose all your coins!
It is just an experiment and should not be used to to try to gain money!

## Description
This tool tries to trade Strk vs Eth on Starknet via the Avnu Dex aggregator . It tries to gain the amount of tokens.

Used tech / Prerequisites:
- NodeJs
- [Starknet Sdk](https://github.com/starknet-io/starknet.js)
- [Avnu Sdk](https://github.com/avnu-labs/avnu-sdk)

ää Installation
- clone git repo
- run ```script npm install```
- copy the .env.example to .env and set the Private and Public key
- in th package.json change the path's of the .env and data file to your liking (and also name and place the related files accordingly)
```script
    "prod": "npm run build && node --env-file=prod.env dist/app.js"
```
- then run ```script npm run prod``` (if you first want to try it on Testnet you can run 'npm run dev', but at creation of this Sepolia was not yet supported by Avnu and Görli was about to die)

ää .env file
USE_TESTNET - true/false
ETH_TOKEN - eth token address 
STARK_TOKEN - strk token address (in theory you could also use another supported token address to trade against eth)
WALLET - your public wallet address
X - your private key
SELL_PERCENT - percent of your total amount that should be traded within one trade 
TRADE_GAIN - percent gain you want minimum for a trade
TRADE_FILE - relative path to the trading data file, make sure it exists and has the initial content:
```json
[
	{
		"hash": "initial",
		"status": "SUCCEEDED",
		"matchedBy": "initial"
	}
]
```

## Program logic

- Initially it gets your token balances
- It then get the trading quotes from Avnu
- If the ratio is good enough the trade is concluded
- Then in the future if the price goes in the other direction it then tries to sell the stack back to gain coins.
