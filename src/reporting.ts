import { formatEther } from "ethers";
import { getTransactionData } from "./transactions";
import { BigNumber } from "@ethersproject/bignumber";

function printBalance(label: string, eth: BigNumber = BigNumber.from('0'), strk: BigNumber = BigNumber.from('0'), date: Date) {
    console.log(`${label} - Eth: ${formatEther(eth.toBigInt())} | Strk: ${formatEther(strk.toBigInt())} | date: ${date?.toDateString()}`)
}

interface ReportTransaction {
    hash: string
    date: Date
    isSellingEth: boolean,
    buyAmount: BigNumber,
    sellAmount: BigNumber,
    balanceEth: BigNumber,
    balanceStrk: BigNumber,
    matchedBy?: string
}

function formatBig(value: BigNumber): string {
    return formatEther(value.toBigInt())
}

function analyseRatioAndTotals(transactions: ReportTransaction[]) {
    console.log('-----------------------Analyse ratios------------------------');
    const count = {
        ethSell: 0,
        ethMatched: 0,
        strkSell: 0,
        strkMatched: 0,
    }
    const soledEthPerMatchedTrade = {} as Record<string, BigNumber>
    const boughtEthPerMatchedTrade = {} as Record<string, BigNumber>
    let totalSoldEth = BigNumber.from('0');
    let totalBoughtEth = BigNumber.from('0');
    transactions.slice(1).forEach(t => {
        if (t.isSellingEth && !t.matchedBy) {
            const ratio = t.buyAmount.div(t.sellAmount)
            console.log('Ratio: ', ratio.toBigInt(), t.date.toDateString(), 'Sell Eth: ', formatBig(t.sellAmount), ' Buy Strk: ', formatBig(t.buyAmount))
        } else if (t.isSellingEth) {
            totalSoldEth = totalSoldEth.add(t.sellAmount)
            soledEthPerMatchedTrade[t.matchedBy!] = soledEthPerMatchedTrade[t.matchedBy!] ? soledEthPerMatchedTrade[t.matchedBy!].add(t.sellAmount) : t.sellAmount
        } else if (!t.isSellingEth) {
            totalBoughtEth = totalBoughtEth.add(t.buyAmount)
            boughtEthPerMatchedTrade[t.hash] = t.buyAmount
        }
        if (t.isSellingEth) {
            count.ethSell++
            if (t.matchedBy) {
                count.ethMatched++
            }
        } else {
            count.strkSell++
            if (t.matchedBy) {
                count.strkMatched++
            }
        }
    })

    console.log('-----------------------Analyse trades------------------------');
    for (const matchedHash in soledEthPerMatchedTrade) {
        const soldEth = soledEthPerMatchedTrade[matchedHash]
        const boughtEth = boughtEthPerMatchedTrade[matchedHash]
        if (!boughtEth) {
            console.warn(`No boughtEth for matched trade ${matchedHash}`)
        } else if (soldEth.gt(boughtEth)) {
            console.warn(`We sold more Eth than we bought by ${formatBig(soldEth.sub(boughtEth))} Eth`)
        } else {
            console.log(`We bought more Eth than we sold by ${formatBig(boughtEth.sub(soldEth))} Eth, hash: ${matchedHash}`)
        }
    }
    if (!totalSoldEth || !totalBoughtEth) {
        console.warn('No sold or bought Eth, cannot compare')
    } else if (totalSoldEth.gt(totalBoughtEth)) {
        console.warn(`In total we sold more Eth than we bought by ${formatBig(totalSoldEth.sub(totalBoughtEth))} Eth`)
    } else {
        console.log(`In total we bought more Eth than we sold by ${formatBig(totalBoughtEth.sub(totalSoldEth))} Eth`)
    }
    console.log(`Tx Count-> Eth: ${count.ethSell} (matched: ${count.ethMatched}) | Strk: ${count.strkSell} (matched: ${count.strkMatched})`)
}

function haveBothChangedDirection(t: ReportTransaction, compare: ReportTransaction): ReportTransaction {
    if (t.balanceEth.gt(compare.balanceEth) && t.balanceStrk.gt(compare.balanceStrk)) {
        printBalance('< Blances have decreased', t.balanceEth, t.balanceStrk, t.date);
        const diffEth = t.balanceEth.sub(compare.balanceEth)
        const diffStrk = t.balanceStrk.sub(compare.balanceStrk)
        console.log(`---< We have less ${formatBig(diffEth)} Eth and ${formatBig(diffStrk)} Strk since then`)
        return t;
    } else if (t.balanceEth.lt(compare.balanceEth) && t.balanceStrk.lt(compare.balanceStrk)) {
        printBalance('> Blances have increased', t.balanceEth, t.balanceStrk, t.date);
        const diffEth = compare.balanceEth.sub(t.balanceEth)
        const diffStrk = compare.balanceStrk.sub(t.balanceStrk)
        console.log(`---> We have more ${formatBig(diffEth)} Eth and ${formatBig(diffStrk)} Strk since then`)
        return t;
    }
    return compare;
}


function analyseBackwards(transactions: ReportTransaction[]) {
    console.log('-----------------------Analyse backwards------------------------')
    const latest = transactions[transactions.length - 1];
    let matched: ReportTransaction = latest;
    printBalance('Latest Balance', latest.balanceEth, latest.balanceStrk, latest.date);

    for (let i = transactions.length - 2; i >= 0; i--) {
        matched = haveBothChangedDirection(transactions[i], matched)
    }

    console.log('Total change')
    haveBothChangedDirection(matched, latest)
}

async function analyseTades() {
    let rawTransactions = await getTransactionData()
    if (rawTransactions?.length < 2) {
        console.log('no transaction done')
    }
    let transactions: ReportTransaction[] = rawTransactions.filter(t => t.timestamp && t.buyAmount && t.sellAmount && t.balanceEth && t.balanceStrk).map(t => {
        const isSellingEth = t.sell === 'eth'
        return {
            hash: t.hash,
            date: new Date(t.timestamp ?? 0),
            isSellingEth,
            buyAmount: BigNumber.from(t.buyAmount),
            sellAmount: BigNumber.from(t.sellAmount),
            balanceEth: BigNumber.from(t.balanceEth),
            balanceStrk: BigNumber.from(t.balanceStrk),
            matchedBy: t.matchedBy
        } as ReportTransaction
    }).sort((a, b) => a.date.getTime() - b.date.getTime())

    const firstMatchedTradeIndex = transactions.findIndex(({ matchedBy }, i) => i > 0 && !!matchedBy)
    console.log('Trades unmatched: ', firstMatchedTradeIndex - 1, ' of ', transactions.length)
    //transactions = transactions.slice(firstMatchedTradeIndex - 1)
    const firstTrade = transactions[0]
    printBalance('Initial Balance', firstTrade.balanceEth, firstTrade.balanceStrk, firstTrade.date)
    const lastTrade = transactions[transactions.length - 1]
    printBalance('Last Balance', lastTrade.balanceEth, lastTrade.balanceStrk, lastTrade.date)

    const firstBalanceEth = BigNumber.from(firstTrade.balanceEth)
    const firstBalanceStrk = BigNumber.from(firstTrade.balanceStrk)
    const lastBalanceEth = BigNumber.from(lastTrade.balanceEth)
    const lastBalanceStrk = BigNumber.from(lastTrade.balanceStrk)

    if (firstBalanceEth.lt(lastBalanceEth)) {
        console.log(`We have more ${formatBig(lastBalanceEth.sub(firstBalanceEth))} Eth  on matched trades`)
    } else {
        console.log(`We have less ${formatBig(firstBalanceEth.sub(lastBalanceEth))} Eth  on matched trades`)
    }
    if (firstBalanceStrk.lt(lastBalanceStrk)) {
        console.log(`We have more ${formatBig(lastBalanceStrk.sub(firstBalanceStrk))} Strk on matched trades`)
    } else {
        console.log(`We have less ${formatBig(firstBalanceStrk.sub(lastBalanceStrk))} Strk  on matched trades`)
    }
    const lastTradeEth = lastTrade.isSellingEth ? lastTrade.sellAmount : lastTrade.buyAmount
    const lastTradeStrk = lastTrade.isSellingEth ? lastTrade.buyAmount : lastTrade.sellAmount
    const totalBalanceStart = firstBalanceEth.add(firstBalanceStrk.mul(lastTradeEth).div(lastTradeStrk))
    const totalBalanceEnd = lastBalanceEth.add(lastBalanceStrk.mul(lastTradeEth).div(lastTradeStrk))
    if (totalBalanceStart.lt(totalBalanceEnd)) {
        console.log(`In total we have more ${formatBig(totalBalanceEnd.sub(totalBalanceStart))} Eth on matched trades`)
    } else {
        console.log(`In total we have less ${formatBig(totalBalanceStart.sub(totalBalanceEnd))} Eth on matched trades`)
    }

    analyseRatioAndTotals(transactions);
    analyseBackwards(transactions);
}

analyseTades()