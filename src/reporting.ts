import { formatEther } from "ethers";
import { getTransactionData } from "./transactions";
import { BigNumber } from "@ethersproject/bignumber";

function printBalance(label: string, eth: string = '', strk: string = '', date: string = '') {
    console.log(`${label} in wei: Eth: ${eth} |  Strk: ${strk} | date: ${date}`)
    console.log(`${label} formated: Eth: ${formatEther(eth)} | Strk: ${formatEther(strk)} | date: ${date}`)
}

async function analyseTades() {
    let transactions = await getTransactionData()
    if (transactions?.length < 2) {
        console.log('no transaction done')
    }

    const firstMatchedTradeIndex = transactions.findIndex(({ matchedBy }, i) => i > 0 && !!matchedBy)
    console.log('Trades unmatched: ', firstMatchedTradeIndex - 1, ' of ', transactions.length)
    transactions = transactions.slice(firstMatchedTradeIndex - 1)
    const firstTrade = transactions[0]
    printBalance('Initial Balance', firstTrade.balanceEth, firstTrade.balanceStrk, new Date(firstTrade.timestamp).toDateString())
    const lastTrade = transactions[transactions.length - 1]
    printBalance('Last Balance', lastTrade.balanceEth, lastTrade.balanceStrk, new Date(lastTrade.timestamp).toDateString())

    const firstBalanceEth = BigNumber.from(firstTrade.balanceEth)
    const firstBalanceStrk = BigNumber.from(firstTrade.balanceStrk)
    const lastBalanceEth = BigNumber.from(lastTrade.balanceEth)
    const lastBalanceStrk = BigNumber.from(lastTrade.balanceStrk)

    if (firstBalanceEth.lt(lastBalanceEth)) {
        console.log(`We have more ${formatEther(lastBalanceEth.sub(firstBalanceEth).toString())} Eth  on matched trades`)
    } else {
        console.log(`We have less ${formatEther(firstBalanceEth.sub(lastBalanceEth).toString())} Eth  on matched trades`)
    }
    if (firstBalanceStrk.lt(lastBalanceStrk)) {
        console.log(`We have more ${formatEther(lastBalanceStrk.sub(firstBalanceStrk).toString())} Strk on matched trades`)
    } else {
        console.log(`We have less ${formatEther(firstBalanceStrk.sub(lastBalanceStrk).toString())} Strk  on matched trades`)
    }
    const lastTradeEth = BigNumber.from(lastTrade.sell === 'eth' ? lastTrade.sellAmount : lastTrade.buyAmount)
    const lastTradeStrk = BigNumber.from(lastTrade.sell === 'strk' ? lastTrade.sellAmount : lastTrade.buyAmount)
    const totalBalanceStart = firstBalanceEth.add(firstBalanceStrk.mul(lastTradeEth).div(lastTradeStrk))
    const totalBalanceEnd = lastBalanceEth.add(lastBalanceStrk.mul(lastTradeEth).div(lastTradeStrk))
    if (totalBalanceStart.lt(totalBalanceEnd)) {
        console.log(`In total we have more ${formatEther(totalBalanceEnd.sub(totalBalanceStart).toString())} Eth on matched trades`)
    } else {
        console.log(`In total we have less ${formatEther(totalBalanceStart.sub(totalBalanceEnd).toString())} Eth on matched trades`)
    }
    const count = {
        ethSell: 0,
        ethMatched: 0,
        strkSell: 0,
        strkMatched: 0,
    }
    transactions.slice(1).forEach(t => {
        if (t.sell === 'eth' && !t.matchedBy) {
            const ratio = BigNumber.from(t.buyAmount).div(BigNumber.from(t.sellAmount))
            console.log('Ratio: ', ratio.toString(), new Date(t.timestamp).toDateString())
        }
        if (t.sell === 'eth') {
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
    console.log(`Tx Count-> Eth: ${count.ethSell} (matched: ${count.ethMatched}) | Strk: ${count.strkSell} (matched: ${count.strkMatched})`)
}

analyseTades()