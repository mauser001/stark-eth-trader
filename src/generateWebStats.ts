import { BigNumber } from "@ethersproject/bignumber";
import { getTransactionData } from "./transactions";
import { loadArchivedTransactions } from "./archives";
import { ReportTransaction, buildMatchedEntries, computeMatchGroupTotals, dayKey, getAverageActualFeesStrk, getMatchGroups, toReportTransactions } from "./matching";
import { getAggregateData } from "./aggregate";
import { TxData } from "./types";

const WEBAPP_URL = process.env.WEBAPP_URL
const WEBAPP_SECRET = process.env.WEBAPP_SECRET

// one-off (re-runnable) seed: builds the full historic dataset the webapp needs from all known
// trades (archives + live file) and replaces everything stored server-side in one go.
async function seed() {
    if (!WEBAPP_URL || !WEBAPP_SECRET) {
        console.log('WEBAPP_URL / WEBAPP_SECRET are not set')
        return
    }
    const byHash = new Map<string, TxData>()
    for (const t of loadArchivedTransactions()) byHash.set(t.hash, t)
    for (const t of await getTransactionData()) byHash.set(t.hash, t)
    const transactions = toReportTransactions(Array.from(byHash.values()))
    if (!transactions.length) {
        console.log('no transactions found')
        return
    }

    const aggregate = await getAggregateData()
    const fallbackFeeStrk = getAverageActualFeesStrk(transactions)

    // one balance point per day (last balance seen that day)
    const balancesByDay = new Map<string, ReportTransaction>()
    for (const t of transactions) balancesByDay.set(dayKey(t.date.getTime()), t)
    const balances = Array.from(balancesByDay.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, t]) => ({ date, eth: t.balanceEth.toString(), strk: t.balanceStrk.toString() }))

    // net gain/loss per closing hash, so the last-100 trades list can show it for closing trades
    const { groups } = getMatchGroups(transactions)
    const netEthByClosingHash = new Map<string, string>()
    for (const g of groups) {
        const totals = computeMatchGroupTotals(g.trades, fallbackFeeStrk)
        netEthByClosingHash.set(g.hash, totals.boughtEth.sub(totals.soldEth).sub(totals.txFeesEth).sub(totals.failedFeesEth).toString())
    }
    const trades = transactions.slice(-100).map(t => ({
        hash: t.hash,
        timestamp: t.date.getTime(),
        sell: t.isSellingEth ? 'eth' : 'strk',
        sellAmount: t.sellAmount.toString(),
        buyAmount: t.buyAmount.toString(),
        actualFees: t.actualFees?.toString(),
        matched: !!t.matchedBy,
        netEth: netEthByClosingHash.get(t.hash)
    }))

    const entries = buildMatchedEntries(transactions, aggregate, fallbackFeeStrk)
    const dailyByDate = new Map<string, { date: string, netEth: BigNumber, tradeCount: number }>()
    for (const e of entries) {
        const date = dayKey(e.date.getTime())
        const bucket = dailyByDate.get(date) ?? { date, netEth: BigNumber.from(0), tradeCount: 0 }
        bucket.netEth = bucket.netEth.add(e.netEth)
        bucket.tradeCount += e.tradeCount
        dailyByDate.set(date, bucket)
    }
    const dailyMatched = Array.from(dailyByDate.values())
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(d => ({ date: d.date, netEth: d.netEth.toString(), tradeCount: d.tradeCount }))

    const last = transactions[transactions.length - 1]
    const current = { eth: last.balanceEth.toString(), strk: last.balanceStrk.toString(), timestamp: last.date.getTime(), hash: last.hash }

    const res = await fetch(WEBAPP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Report-Secret': WEBAPP_SECRET },
        body: JSON.stringify({ seed: { current, balances, trades, dailyMatched } })
    })
    const text = await res.text().catch(() => '')
    // ingest.php always replies with json - anything else means the request never actually
    // reached it (e.g. WEBAPP_URL points at a folder/redirect instead of ingest.php)
    let parsed: { ok?: boolean } | undefined
    try {
        parsed = text ? JSON.parse(text) : undefined
    } catch {
        parsed = undefined
    }
    if (res.ok && parsed?.ok) {
        console.log(`seeded webapp: ${balances.length} balance point(s), ${trades.length} trade(s), ${dailyMatched.length} daily entrie(s)`)
    } else {
        console.log(`seed failed: ${res.status} ${text}`)
    }
}

seed()
