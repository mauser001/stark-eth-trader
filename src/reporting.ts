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
    // transactions = transactions.slice(firstMatchedTradeIndex - 1)
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
    const soledEthPerMatchedTrade = {} as Record<string, BigNumber>
    const boughtEthPerMatchedTrade = {} as Record<string, BigNumber>
    let totalSoldEth = BigNumber.from('0');
    let totalBoughtEth = BigNumber.from('0');
    transactions.slice(1).forEach(t => {
        if (t.sell === 'eth' && !t.matchedBy) {
            const ratio = BigNumber.from(t.buyAmount).div(BigNumber.from(t.sellAmount))
            console.log('Ratio: ', ratio.toString(), new Date(t.timestamp).toDateString(), 'Sell Eth: ', formatEther(t.sellAmount), ' Buy Strk: ', formatEther(t.buyAmount))
        } else if (t.sell === 'eth') {
            totalSoldEth = totalSoldEth.add(BigNumber.from(t.sellAmount))
            soledEthPerMatchedTrade[t.matchedBy] = soledEthPerMatchedTrade[t.matchedBy] ? soledEthPerMatchedTrade[t.matchedBy].add(BigNumber.from(t.sellAmount)) : BigNumber.from(t.sellAmount)
        } else if (t.sell === 'strk') {
            totalBoughtEth = totalBoughtEth.add(BigNumber.from(t.buyAmount))
            boughtEthPerMatchedTrade[t.hash] = BigNumber.from(t.buyAmount)
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
    for (const matchedHash in soledEthPerMatchedTrade) {
        const soldEth = soledEthPerMatchedTrade[matchedHash]
        const boughtEth = boughtEthPerMatchedTrade[matchedHash]
        if (!boughtEth) {
            console.warn(`No boughtEth for matched trade ${matchedHash}`)
        } else if (soldEth.gt(boughtEth)) {
            console.warn(`We sold more Eth than we bought by ${formatEther(soldEth.sub(boughtEth).toString())} Eth`)
        } else {
            console.log(`We bought more Eth than we sold by ${formatEther(boughtEth.sub(soldEth).toString())} Eth`)
        }
    }
    if (!totalSoldEth || !totalBoughtEth) {
        console.warn('No sold or bought Eth, cannot compare')
    } else if (totalSoldEth.gt(totalBoughtEth)) {
        console.warn(`In total we sold more Eth than we bought by ${formatEther(totalSoldEth.sub(totalBoughtEth).toString())} Eth`)
    } else {
        console.log(`In total we bought more Eth than we sold by ${formatEther(totalBoughtEth.sub(totalSoldEth).toString())} Eth`)
    }
    console.log(`Tx Count-> Eth: ${count.ethSell} (matched: ${count.ethMatched}) | Strk: ${count.strkSell} (matched: ${count.strkMatched})`)
}

analyseTades()