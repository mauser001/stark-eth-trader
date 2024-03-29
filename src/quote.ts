import { AvnuOptions, Quote, QuoteRequest, fetchQuotes } from "@avnu/avnu-sdk"
import { BigNumber, formatFixed } from "@ethersproject/bignumber"
import { Account } from "starknet"
import { RATIO_MULTI, TRADE_GAIN_PROMILLE } from "./conts"
import { checkPromilleChange, getRatio } from "./math"
import { EthOrStrk, QuoteData, TxData } from "./types"

export async function getQuote(sell: EthOrStrk, sellAmount: BigNumber, account: Account, avnuOptions: AvnuOptions, ratio: BigNumber, tx: TxData) {
    const params: QuoteRequest = {
        size: 5,
        sellTokenAddress: sell === 'eth' ? process.env.ETH_TOKEN : process.env.STARK_TOKEN,
        buyTokenAddress: sell !== 'eth' ? process.env.ETH_TOKEN : process.env.STARK_TOKEN,
        sellAmount: BigInt(sellAmount.toString()),
        takerAddress: account.address
    }
    // We get the quotes for the amount we want to sell and then check if we make enough profit
    const quotes: Quote[] = await fetchQuotes(params, avnuOptions)
    let quote: QuoteData
    // We get a list of quotes - it seems we always get one, but maybe in the future there will be more so we compare them
    quotes.forEach((q) => {
        const data = sell === 'eth' ? checkQuoteEth(q, quote?.ratio || ratio, tx) : checkQuoteStrk(q, quote?.ratio || ratio, tx)
        if (data) {
            quote = data
        }
    })
    return quote
}

// check the quote for selling Strk 
function checkQuoteStrk(quote: Quote, ratio: BigNumber, tx: TxData): QuoteData | undefined {
    const buyAmount = BigNumber.from(quote.buyAmount)
    const sellAmount = BigNumber.from(quote.sellAmount)
    // calculate the ratio of the quote
    let tradeRatio = getRatio(sellAmount, buyAmount)

    let doTrade = false
    let wasMatch = false
    console.log('quote strk', buyAmount.toString(), sellAmount.toString(), tradeRatio.toString())
    // Only if the quote is good enough we make more test
    if (ratio.gt(tradeRatio)) {
        console.log("maybe sell strk", ratio.toString(), tradeRatio.toString())
        // Let's get the fees and make a quick check if the fees are higher then the eth we get (fees are in eth)
        const fees = getFees(quote)
        if (fees.gte(buyAmount)) {
            console.log("sell strk, fees greater then buy amount", fees.toString(), buyAmount.toString())
            return
        }
        // Deduct the fees from the amount we get to calculate the real ratio we get
        const fixedBuyAmount = buyAmount.sub(fees)
        tradeRatio = getRatio(sellAmount, fixedBuyAmount)
        // if there is an open tx where we sold eth then we compare the quote with it
        if (!tx.matchedBy && tx.sell === 'eth') {
            if (checkPromilleChange(BigNumber.from(tx.sellAmount), fixedBuyAmount, TRADE_GAIN_PROMILLE)) {
                doTrade = true
                wasMatch = true
            } else {
                console.log("no strk selling against tx", tx.sellAmount.toString(), fixedBuyAmount.toString(), fees.toString())
            }
            // If not we compare the ratios 
        } else if (ratio.gt(tradeRatio) && checkPromilleChange(tradeRatio, ratio, TRADE_GAIN_PROMILLE)) {
            doTrade = true
        } else {
            console.log("no strk selling", ratio.toString(), tradeRatio.toString(), ratio.gt(tradeRatio))
        }
    } else {
        console.log("no strk selling ratio low", ratio.toString(), tradeRatio.toString())
    }
    if (doTrade) {
        return {
            quote,
            ratio: tradeRatio,
            wasMatch,
            sell: 'strk'
        }
    }
}

// check the quote for selling eth 
function checkQuoteEth(quote: Quote, ratio: BigNumber, tx: TxData): QuoteData | undefined {
    const buyAmount = BigNumber.from(quote.buyAmount)
    const sellAmount = BigNumber.from(quote.sellAmount)
    let tradeRatio = getRatio(buyAmount, sellAmount)

    let doTrade = false
    let wasMatch = false
    console.log('quote eth', buyAmount.toString(), sellAmount.toString(), tradeRatio.toString())
    // here the ratio must be in the oposite direction as for the strk quote
    if (ratio.lt(tradeRatio)) {
        console.log("maybe sell eth", ratio.toString(), tradeRatio.toString())
        // as the fees are in eth we must convert it to strk to compare it to the strk we get
        const fees = getFees(quote).mul(tradeRatio).div(RATIO_MULTI)
        if (fees.gte(buyAmount)) {
            console.log("sell eth, fees greater then buy amount", fees.toString(), buyAmount.toString())
            return
        }
        const fixedBuyAmount = buyAmount.sub(fees)
        tradeRatio = getRatio(fixedBuyAmount, sellAmount)
        if (ratio.lt(tradeRatio)) {
            if (!tx.matchedBy && tx.sell === 'strk') {
                if (checkPromilleChange(BigNumber.from(tx.sellAmount), fixedBuyAmount, TRADE_GAIN_PROMILLE)) {
                    doTrade = true
                    wasMatch = true
                } else {
                    console.log("no eth selling against tx", tx.sellAmount.toString(), fixedBuyAmount.toString(), fees.toString())
                }
            } else {
                console.log("no eth selling", ratio.toString(), tradeRatio.toString())
            }
        } else {
            console.log("no eth selling ratio after fees too low", ratio.toString(), tradeRatio.toString())
        }
    } else {
        console.log("no eth selling ratio low", ratio.toString(), tradeRatio.toString())
    }
    if (doTrade) {
        return {
            quote,
            ratio: tradeRatio,
            wasMatch,
            sell: 'eth'
        }
    }
}

export function getFees(quote: Quote): BigNumber {
    return BigNumber.from(quote.gasFees).add(BigNumber.from(quote.avnuFees)).add(BigNumber.from(quote.integratorFees))
}