import { AvnuOptions, Quote, QuoteRequest, fetchQuotes } from "@avnu/avnu-sdk"
import { BigNumber } from "@ethersproject/bignumber"
import { Account } from "starknet"
import { RATIO_MULTI, TRADE_GAIN_PROMILLE } from "./conts"
import { checkPromilleChange, getRatio } from "./math"
import { EthOrStrk, QuoteData, TxData } from "./types"

export async function getQuote(sell: EthOrStrk, sellAmount: BigNumber, account: Account, avnuOptions: AvnuOptions, ratio: BigNumber, tx: TxData, unMatched?: TxData[]) {
    const params: QuoteRequest = {
        size: 5,
        sellTokenAddress: sell === 'eth' ? process.env.ETH_TOKEN : process.env.STARK_TOKEN,
        buyTokenAddress: sell !== 'eth' ? process.env.ETH_TOKEN : process.env.STARK_TOKEN,
        sellAmount: BigInt(sellAmount.toString()),
        takerAddress: account.address
    }
    // We get the quotes for the amount we want to sell and then check if we make enough profit
    const quotes: Quote[] = await getAvnuQuotes(sell, sellAmount, account.address, avnuOptions)
    let quote: QuoteData
    // We get a list of quotes - it seems we always get one, but maybe in the future there will be more so we compare them
    quotes.forEach((q) => {
        const data = checkQuote(sell, q, quote?.ratio || ratio, tx)
        if (data) {
            quote = data
            if (quote.wasMatch) {
                quote.matchedTx = [tx.hash]
            }
        }
    })
    if (quote?.ratio && !quote.quote) {
        // we get here if the quote was good but not was not good enough (after fees)
        // so we try to find other transactions that are better then the ratio and add them up so save on tx fees an look if it works
        let newSellAmount = BigNumber.from("0")
        let newBuyAmount = BigNumber.from("0")
        const matchedTx: string[] = []
        for (let i = unMatched.length - 1; i >= 0; i--) {
            const testTx = unMatched[i]
            if (testTx.sell !== sell) {
                const testRatio = getTxRatio(testTx.sell, BigNumber.from(testTx.sellAmount), BigNumber.from(testTx.buyAmount))
                if (!isGoodRatio(sell, testRatio, quote.ratio)) {
                    console.log(' tx has not a good ratio', sell, testTx.sellAmount, testTx.buyAmount, quote.ratio.toString(), testRatio.toString())
                    break
                }
                console.log('tx has a good ratio', sell, testTx.sellAmount, testTx.buyAmount, quote.ratio.toString(), testRatio.toString())

                newSellAmount = newSellAmount.add(BigNumber.from(testTx.sellAmount))
                newBuyAmount = newBuyAmount.add(BigNumber.from(testTx.buyAmount))
                matchedTx.push(testTx.hash)
            }
        }
        if (matchedTx.length > 1) {
            console.log(`we found ${matchedTx.length} tx to combine`)
            const quotes: Quote[] = await getAvnuQuotes(sell, newSellAmount, account.address, avnuOptions)
            const txSell = sell === 'eth' ? 'strk' : 'eth'
            const testTx: TxData = {
                sellAmount: newSellAmount.toString(),
                buyAmount: newBuyAmount.toString(),
                sell: txSell,
                hash: 'combined'
            }
            let testRatio = getTxRatio(txSell, newSellAmount, newBuyAmount)
            // We get a list of quotes - it seems we always get one, but maybe in the future there will be more so we compare them
            quotes.forEach((q) => {
                const data = checkQuote(sell, q, testRatio, testTx)
                if (data?.quote) {
                    quote = { ...data, matchedTx }
                    testRatio = quote.ratio
                }
            })
        } else {
            console.log(`no new tx's found for selling ${sell}`)
        }
    }
    return quote
}

// check the quote for selling 
function checkQuote(sell: EthOrStrk, quote: Quote, ratio: BigNumber, tx: TxData): QuoteData | undefined {
    const buyAmount = BigNumber.from(quote.buyAmount)
    const sellAmount = BigNumber.from(quote.sellAmount)
    // calculate the ratio of the quote
    const originTradeRatio = getTxRatio(sell, sellAmount, buyAmount)
    let tradeRatio = originTradeRatio

    let doTrade = false
    let wasMatch = false
    console.log(`check quote for ${sell}, sell: ${sellAmount.toString()}, buy: ${buyAmount.toString()} -> ratio: ${tradeRatio.toString()}`)
    // Only if the quote is good enough we make more test
    if (!isGoodRatio(sell, ratio, tradeRatio)) {
        console.log(`no selling ${sell} because ratio is to low target: ${ratio.toString()}, trade: ${tradeRatio.toString()}`)
        return
    }
    console.log(`maybe ${sell} because ratio is ok target: ${ratio.toString()}, trade: ${tradeRatio.toString()}`)
    // Let's get the fees and make a quick check if the fees are higher then the eth we get (fees are in eth)
    const fees = getFees(sell, quote, ratio)
    if (fees.gte(buyAmount)) {
        console.log(`no selling ${sell} because fees to high: ${fees.toString()}`)
        if (!tx.matchedBy && tx.sell !== sell) {
            return {
                ratio: originTradeRatio
            }
        }
        return
    }
    // Deduct the fees from the amount we get to calculate the real ratio we get
    const fixedBuyAmount = buyAmount.sub(fees)
    tradeRatio = getTxRatio(sell, sellAmount, fixedBuyAmount)

    if (!isGoodRatio(sell, ratio, tradeRatio)) {
        console.log(`no selling ${sell} because ratio is to low after fees trade ratio: ${tradeRatio.toString()} for fixed amount ${fixedBuyAmount.toString()}`)
        if (!tx.matchedBy && tx.sell !== sell) {
            return {
                ratio: originTradeRatio
            }
        }
        return
    }
    // if there is an open tx where we sold eth then we compare the quote with it
    if (!tx.matchedBy && tx.sell !== sell) {
        if (checkPromilleChange(BigNumber.from(tx.sellAmount), fixedBuyAmount, TRADE_GAIN_PROMILLE)) {
            doTrade = true
            wasMatch = true
        } else {
            console.log(`no selling ${sell} against tx sell amount: ${tx.sellAmount.toString()} vs. buy ${fixedBuyAmount.toString()} with fees: ${fees.toString()}`)
            return {
                ratio: originTradeRatio
            }
        }
        // If not we compare the ratios 
    } else if (isGoodRatio(sell, ratio, tradeRatio) && checkTxRatioGain(sell, tradeRatio, ratio)) {
        doTrade = true
    } else {
        console.log(`no selling ${sell} as trade is not good enough ratio: ${ratio.toString()}, trade ratio: ${tradeRatio.toString()}`)
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

function getTxRatio(sell: EthOrStrk, sellAmount: BigNumber, buyAmount: BigNumber) {
    return sell === 'eth' ? getRatio(buyAmount, sellAmount) : getRatio(sellAmount, buyAmount)
}

function isGoodRatio(sell: EthOrStrk, targetRatio: BigNumber, tradeRatio: BigNumber) {
    return sell === 'eth' ? targetRatio.lt(tradeRatio) : targetRatio.gt(tradeRatio)
}

function checkTxRatioGain(sell: EthOrStrk, targetRatio: BigNumber, tradeRatio: BigNumber) {
    return sell === 'eth' ? checkPromilleChange(targetRatio, tradeRatio, TRADE_GAIN_PROMILLE) : checkPromilleChange(tradeRatio, targetRatio, TRADE_GAIN_PROMILLE)

}

function getFees(sell: EthOrStrk, quote: Quote, ratio?: BigNumber): BigNumber {
    const baseFee = sell === 'eth' ? BigNumber.from(quote.gasFees).mul(ratio).div(RATIO_MULTI) : BigNumber.from(quote.gasFees)
    console.log(`baseFee: ${baseFee}, quote.avnuFees:${quote.avnuFees}, quote.integratorFees: ${quote.integratorFees}`)
    return baseFee.add(BigNumber.from(quote.avnuFees)).add(BigNumber.from(quote.integratorFees))
}

async function getAvnuQuotes(sell: EthOrStrk, sellAmount: BigNumber, takerAddress: string, avnuOptions: AvnuOptions) {
    const params: QuoteRequest = {
        size: 5,
        sellTokenAddress: sell === 'eth' ? process.env.ETH_TOKEN : process.env.STARK_TOKEN,
        buyTokenAddress: sell !== 'eth' ? process.env.ETH_TOKEN : process.env.STARK_TOKEN,
        sellAmount: BigInt(sellAmount.toString()),
        takerAddress: takerAddress
    }
    // We get the quotes for the amount we want to sell and then check if we make enough profit
    return await fetchQuotes(params, avnuOptions)
}