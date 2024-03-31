import { AvnuOptions, Quote, QuoteRequest, fetchQuotes } from "@avnu/avnu-sdk"
import { BigNumber } from "@ethersproject/bignumber"
import { Account } from "starknet"
import { RATIO_MULTI, TRADE_GAIN_PROMILLE } from "./conts"
import { checkPromilleChange, getRatio } from "./math"
import { EthOrStrk, QuoteData, TxData } from "./types"
import { Router as FibrousRouter } from "fibrous-router-sdk";

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
        const buyAmount = BigNumber.from(q.buyAmount)
        const sellAmount = BigNumber.from(q.sellAmount)
        const fees = getFees(q, sell === 'eth' ? ratio : undefined)

        const data = sell === 'eth' ? checkQuoteEth(buyAmount, sellAmount, fees, quote?.ratio || ratio, tx) : checkQuoteStrk(buyAmount, sellAmount, fees, quote?.ratio || ratio, tx)
        if (data) {
            console.log('Oh we found a Anvu quote: ', q.buyAmount.toString(), q.sellAmount.toString())
            quote = {
                ...data,
                quote: q
            }
        }
    })

    const router = new FibrousRouter()
    const route = await router.getBestRoute(
        sellAmount, // amount
        params.sellTokenAddress, // token input
        params.buyTokenAddress, // token output
    );
    if (route?.success) {
        console.log('now lets try the route')
        const buyAmount = BigNumber.from(route.outputAmount) //.div(100).mul(95) // remove 5%
        const sellAmount = BigNumber.from(route.inputAmount)
        let fees = route.estimatedGasUsed !== '0' ? BigNumber.from(route.estimatedGasUsed) : BigNumber.from("597025749208788") // 1 STRK in ETh ... should be enough, but we can't get a an estimate from teh route
        if (sell === 'eth') {
            fees = fees.mul(ratio).div(RATIO_MULTI)
        }
        console.log('now lets test the fibrous route')
        const data = sell === 'eth' ? checkQuoteEth(buyAmount, sellAmount, fees, quote?.ratio || ratio, tx) : checkQuoteStrk(buyAmount, sellAmount, fees, quote?.ratio || ratio, tx)

        if (data) {
            console.log('we found a better route with fibrous')
            quote = {
                ...data,
                route
            }
        }
    }
    return quote
}

// check the quote for selling Strk 
function checkQuoteStrk(buyAmount: BigNumber, sellAmount: BigNumber, fees: BigNumber, ratio: BigNumber, tx: TxData): QuoteData | undefined {
    // calculate the ratio of the quote
    let tradeRatio = getRatio(sellAmount, buyAmount)

    let doTrade = false
    let wasMatch = false
    console.log('quote strk', buyAmount.toString(), sellAmount.toString(), tradeRatio.toString(), fees.toString())
    // Only if the quote is good enough we make more test
    if (!ratio.gt(tradeRatio)) {
        console.log("no strk selling ratio low", ratio.toString(), tradeRatio.toString())
        return
    }
    console.log("maybe sell strk", ratio.toString(), tradeRatio.toString())
    // Let's check the fees
    if (fees.gte(buyAmount)) {
        console.log("sell strk, fees greater then buy amount", fees.toString(), buyAmount.toString())
        return
    }
    // Deduct the fees from the amount we get to calculate the real ratio we get
    const fixedBuyAmount = buyAmount.sub(fees)
    tradeRatio = getRatio(sellAmount, fixedBuyAmount)

    if (!ratio.gt(tradeRatio)) {
        console.log("sell strk, ratio is worse after fee", tradeRatio.toString(), buyAmount.toString(), fees.toString())
        return
    }
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
    if (doTrade) {
        return {
            ratio: tradeRatio,
            wasMatch,
            sell: 'strk'
        }
    }
}

// check the quote for selling eth 
function checkQuoteEth(buyAmount: BigNumber, sellAmount: BigNumber, fees: BigNumber, ratio: BigNumber, tx: TxData): QuoteData | undefined {
    let tradeRatio = getRatio(buyAmount, sellAmount)

    let doTrade = false
    let wasMatch = false
    console.log('quote eth', buyAmount.toString(), sellAmount.toString(), tradeRatio.toString(), fees.toString())
    // here the ratio must be in the oposite direction as for the strk quote
    if (!ratio.lt(tradeRatio)) {
        console.log("no eth selling ratio low", ratio.toString(), tradeRatio.toString())
        return
    }
    console.log("maybe sell eth", ratio.toString(), tradeRatio.toString())
    // let's check the fees
    if (fees.gte(buyAmount)) {
        console.log("sell eth, fees greater then buy amount", fees.toString(), buyAmount.toString())
        return
    }
    const fixedBuyAmount = buyAmount.sub(fees)
    tradeRatio = getRatio(fixedBuyAmount, sellAmount)
    if (!ratio.lt(tradeRatio)) {
        console.log("no eth selling ratio is worse after fees", ratio.toString(), tradeRatio.toString(), fees.toString())
        return
    }
    if (!tx.matchedBy && tx.sell === 'strk') {
        if (checkPromilleChange(BigNumber.from(tx.sellAmount), fixedBuyAmount, TRADE_GAIN_PROMILLE)) {
            doTrade = true
            wasMatch = true
        } else {
            console.log("no eth selling against tx", tx.sellAmount.toString(), fixedBuyAmount.toString(), fees.toString())
        }
    } else if (checkPromilleChange(ratio, tradeRatio, TRADE_GAIN_PROMILLE)) {
        doTrade = true
    } else {
        console.log("no eth selling", ratio.toString(), tradeRatio.toString())
    }
    if (doTrade) {
        return {
            ratio: tradeRatio,
            wasMatch,
            sell: 'eth'
        }
    }
}

function getFees(quote: Quote, ratio?: BigNumber): BigNumber {
    const baseFee = ratio ? BigNumber.from(quote.gasFees).mul(ratio).div(RATIO_MULTI) : BigNumber.from(quote.gasFees)
    return baseFee.add(BigNumber.from(quote.avnuFees)).add(BigNumber.from(quote.integratorFees))
}