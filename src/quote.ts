import { AvnuOptions, Quote, QuoteRequest, getQuotes } from "@avnu/avnu-sdk"
import { BigNumber } from "@ethersproject/bignumber"
import { Account } from "starknet"
import { MIN_GAS_FEES, TIP_FEE_STRK, TRADE_DIFFERENCE_1000 } from "./conts"
import { EthOrStrk, QuoteData, TxData } from "./types"
import { applyRatio, getRatio } from "./math"

export async function getQuote(sell: EthOrStrk, sellAmount: BigNumber, account: Account, avnuOptions: AvnuOptions, ratio: BigNumber, tx: TxData, unMatched: TxData[] = [], failedFees: BigNumber = BigNumber.from('0'), maxTrackedFee?: BigNumber): Promise<QuoteData | undefined> {
    // We get the quotes for the amount we want to sell and then check if we make enough profit
    const quotes: Quote[] = await getAvnuQuotes(sell, sellAmount, account.address, avnuOptions)
    let quote: QuoteData | undefined
    // We get a list of quotes - it seems we always get one, but maybe in the future there will be more so we compare them
    quotes.forEach((q) => {
        const data = checkQuote(sell, q, quote?.ratio || ratio, tx, failedFees, maxTrackedFee)
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
            if (quote.quote) break;
            const testTx = unMatched[i]
            if (testTx?.sell && testTx.sell !== sell) {
                let testRatio = getTxRatio(testTx.sell, BigNumber.from(testTx.sellAmount), BigNumber.from(testTx.buyAmount))
                if (!isGoodRatio(sell, testRatio, quote.ratio)) {
                    console.log(' tx has not a good ratio', sell, testTx.sellAmount, testTx.buyAmount, quote.ratio.toString(), testRatio.toString())
                    break
                }
                console.log('tx has a good ratio', sell, testTx.sellAmount, testTx.buyAmount, quote.ratio.toString(), testRatio.toString())

                newSellAmount = newSellAmount.add(BigNumber.from(testTx.sellAmount))
                newBuyAmount = newBuyAmount.add(BigNumber.from(testTx.buyAmount))
                matchedTx.push(testTx.hash)

                if (matchedTx.length > 1) {
                    console.log(`we found ${matchedTx.length} tx to combine`)
                    const quotes: Quote[] = await getAvnuQuotes(sell, newBuyAmount, account.address, avnuOptions)
                    const txSell = sell === 'eth' ? 'strk' : 'eth'
                    const combinedTestTx: TxData = {
                        sellAmount: newSellAmount.toString(),
                        buyAmount: newBuyAmount.toString(),
                        sell: txSell,
                        hash: 'combined'
                    }
                    testRatio = getTxRatio(txSell, newSellAmount, newBuyAmount)
                    // We get a list of quotes - it seems we always get one, but maybe in the future there will be more so we compare them
                    quotes.forEach((q) => {
                        const data = checkQuote(sell, q, testRatio, combinedTestTx, failedFees, maxTrackedFee)
                        if (data?.quote) {
                            quote = { ...data, matchedTx }
                            testRatio = quote.ratio
                        }
                    })
                    if (!quote?.quote) {
                        await new Promise((resolve) => setTimeout(() => resolve(true), 500))
                    }
                }
            }
        }

        if (matchedTx.length <= 1) {
            console.log(`no new tx's found for selling ${sell}`)
        }
    }
    return quote
}

// check the quote for selling 
function checkQuote(sell: EthOrStrk, quote: Quote, ratio: BigNumber, tx: TxData, failedFees: BigNumber, maxTrackedFee?: BigNumber): QuoteData | undefined {
    const buyAmount = BigNumber.from(quote.buyAmount)
    const sellAmount = BigNumber.from(quote.sellAmount)
    // calculate the ratio of the quote
    const originTradeRatio = getTxRatio(sell, sellAmount, buyAmount)
    let tradeRatio = originTradeRatio

    let doTrade = false
    let wasMatch = false
    console.log(`check quote for ${sell}, sell: ${sellAmount.toString()}, buy: ${buyAmount.toString()} -> ratio: ${tradeRatio.toString()}, estimatedFees: ${quote.gasFees.toString()}`)
    // Only if the quote is good enough we make more test
    if (!isGoodRatio(sell, ratio, tradeRatio)) {
        console.log(`no selling ${sell} because ratio is to low target: ${ratio.toString()}, trade: ${tradeRatio.toString()}`)
        return
    }
    console.log(`maybe ${sell} because ratio is ok target: ${ratio.toString()}, trade: ${tradeRatio.toString()}`)
    // Let's get the fees and make a quick check if the fees are higher then the buy amount
    const fees = getFees(sell, quote, ratio, maxTrackedFee)
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
        console.log(`no selling ${sell} because trade is not good enough for fixed amount ${fixedBuyAmount.toString()}`)
        if (!tx.matchedBy && tx.sell !== sell) {
            return {
                ratio: originTradeRatio
            }
        }
        return
    }
    // if there is an open tx where we sold eth then we compare the quote with it
    if (tx.sellAmount !== undefined && !tx.matchedBy && tx.sell !== sell) {
        if (checkTxGain(sell, BigNumber.from(tx.sellAmount), fixedBuyAmount, failedFees, tradeRatio, quote.estimatedSlippage)) {
            doTrade = true
            wasMatch = true
        } else {
            console.log(`no selling ${sell} against tx sell amount: ${tx.sellAmount.toString()} vs. buy ${fixedBuyAmount.toString()} with fees: ${fees.toString()}`)
            return {
                ratio: originTradeRatio
            }
        }
        // If not we compare the ratios 
    } else {
        if (fixedBuyAmount && checkNextTradeDifference(sell, fixedBuyAmount, ratio, tradeRatio, quote.estimatedSlippage)) {
            doTrade = true
        } else {
            console.log(`no selling ${sell} as trade is not good enough with fixed trade amount: ${fixedBuyAmount.toString()}`)
        }
    }
    if (doTrade) {
        return {
            quote,
            ratio: tradeRatio,
            wasMatch,
            sell,
            fees
        }
    }
}

export function getTxRatio(sell: EthOrStrk, sellAmount: BigNumber, buyAmount: BigNumber) {
    return sell === 'eth' ? getRatio(buyAmount, sellAmount) : getRatio(sellAmount, buyAmount)
}

export function isGoodRatio(sell: EthOrStrk, targetRatio: BigNumber, tradeRatio: BigNumber) {
    return sell === 'eth' ? targetRatio.lt(tradeRatio) : targetRatio.gt(tradeRatio)
}

// picks the most demanding ratio (highest when about to sell eth, lowest when about to sell strk) among the given transactions,
// so a single small/noisy trade can't lower the bar we compare new quotes against
export function getBestRatio(sell: EthOrStrk, txs: TxData[]): BigNumber | undefined {
    let best: BigNumber | undefined
    for (const t of txs) {
        if (!t.sell || !t.sellAmount || !t.buyAmount) continue
        const txRatio = getTxRatio(t.sell, BigNumber.from(t.sellAmount), BigNumber.from(t.buyAmount))
        if (!best || isGoodRatio(sell, best, txRatio)) {
            best = txRatio
        }
    }
    return best
}

// picks the open position whose own ratio is closest to being matched right now (same extreme as getBestRatio,
// e.g. the highest sell ratio among eth sells), since that's the trade needing the smallest market move to close,
// so we prioritize attempting the one most likely to actually fill soon instead of a long-shot older one.
// Assumes the given txs were all sold in the same direction, which holds since they only get matched together
export function getBestTx(txs: TxData[]): TxData | undefined {
    let best: TxData | undefined
    let bestRatio: BigNumber | undefined
    for (const t of txs) {
        if (!t.sell || !t.sellAmount || !t.buyAmount) continue
        const txRatio = getTxRatio(t.sell, BigNumber.from(t.sellAmount), BigNumber.from(t.buyAmount))
        if (!best || isGoodRatio(t.sell, bestRatio!, txRatio)) {
            best = t
            bestRatio = txRatio
        }
    }
    return best
}

function addPercentPoint(amount: BigNumber, percent: BigNumber): BigNumber {
    const oneThousand = BigNumber.from('1000')
    return amount.mul(oneThousand.add(percent)).div(oneThousand)
}

function checkTxGain(sell: EthOrStrk, targetAmount: BigNumber, tradeAmount: BigNumber, failedFees: BigNumber, ratio: BigNumber, slippage = 0.005) {
    const ajustedFailedFees = sell === 'eth' || failedFees.eq(BigNumber.from('0')) ? failedFees : applyRatio(ratio, failedFees, undefined)
    const totalTarget = addPercentPoint(targetAmount, TRADE_DIFFERENCE_1000).add(ajustedFailedFees)
    let isGood = totalTarget.lt(tradeAmount)
    const dif = tradeAmount.mul(1000).div(totalTarget);
    console.log(`checkTxGain isGood: ${isGood} sell:${sell}, target: ${targetAmount.toString()}, sell percent: ${TRADE_DIFFERENCE_1000}, total target: ${totalTarget.toString()}, with failed fees: ${failedFees.toString()}, ajustedFailedFees: ${ajustedFailedFees.toString()}, trade: ${tradeAmount.toString()}, div: ${dif.toString()}%`)
    if (isGood) {
        const withSlippage = addSlippage(totalTarget, slippage)
        isGood = withSlippage.lt(tradeAmount)
        console.log(`checkTxGain isGood: ${isGood} after slippage: ${slippage}, target with Slippage: ${withSlippage.toString()}`)
    }

    return isGood
}

function addSlippage(amount: BigNumber, slippage = 0.01) {
    const multi = 100000;
    const bigSlippage = BigNumber.from(Math.floor(multi * slippage));
    const toAdd = amount.mul(bigSlippage).div(BigNumber.from(multi));
    return amount.add(toAdd);
}

function checkNextTradeDifference(sell: EthOrStrk, tradeAmount: BigNumber, oldRatio: BigNumber, newRatio: BigNumber, slippage = 0.005) {
    let withOldRatio: BigNumber
    if (sell === 'eth') {
        withOldRatio = tradeAmount.mul(oldRatio).div(newRatio)
    } else {
        withOldRatio = tradeAmount.mul(newRatio).div(oldRatio)
    }
    const totalTarget = addPercentPoint(withOldRatio, TRADE_DIFFERENCE_1000)
    let isGood = totalTarget.lt(tradeAmount)
    const dif = tradeAmount.mul(1000).div(totalTarget);
    console.log(`checkNextTradeDifference isGood: ${isGood} sell:${sell} with old ratio: ${withOldRatio} min percent gain: ${TRADE_DIFFERENCE_1000} total target: ${totalTarget.toString()} trade: ${tradeAmount.toString()}, div: ${dif.toString()}%`)
    if (isGood) {
        const withSlippage = addSlippage(totalTarget, slippage)
        isGood = withSlippage.lt(tradeAmount)
        console.log(`checkNextTradeDifference isGood: ${isGood} after slippage: ${slippage}, target with Slippage: ${withSlippage.toString()}`)
    }

    return isGood
}

function getFees(sell: EthOrStrk, quote: Quote, ratio: BigNumber, maxTrackedFee?: BigNumber): BigNumber {
    // avnu always quotes gasFees in STRK (FRI), regardless of sell/buy token or fee.feeToken
    const gasFeesStrk = BigNumber.from(quote.gasFees)
    // quoted gas fees can be underestimated, so we never go below the highest fee actually paid recently (falls back to MIN_GAS_FEES)
    const floor = maxTrackedFee && maxTrackedFee.gt(MIN_GAS_FEES) ? maxTrackedFee : MIN_GAS_FEES
    const flooredFeesStrk = gasFeesStrk.gt(floor) ? gasFeesStrk : floor
    // the priority tip is paid on top at execution time and isn't part of avnu's quoted gasFees
    const totalFeesStrk = flooredFeesStrk.add(TIP_FEE_STRK)
    const baseFee = sell === 'strk' ? applyRatio(ratio, totalFeesStrk) : totalFeesStrk
    console.log(`baseFee: ${baseFee}, gasFeesStrk: ${gasFeesStrk}, floor: ${floor}, tipFeeStrk: ${TIP_FEE_STRK.toString()}, quote.estimatedSlippage: ${quote.estimatedSlippage}`)
    return baseFee
}

async function getAvnuQuotes(sell: EthOrStrk, sellAmount: BigNumber, takerAddress: string, avnuOptions: AvnuOptions) {
    const params: QuoteRequest = {
        size: 5,
        sellTokenAddress: (sell === 'eth' ? process.env.ETH_TOKEN : process.env.STARK_TOKEN) as string,
        buyTokenAddress: (sell !== 'eth' ? process.env.ETH_TOKEN : process.env.STARK_TOKEN) as string,
        sellAmount: BigInt(sellAmount.toString()),
        takerAddress: takerAddress
    }
    // We get the quotes for the amount we want to sell and then check if we make enough profit
    return await getQuotes(params, avnuOptions)
}