import { BigNumber } from "@ethersproject/bignumber";
import { getTransactionData } from "./transactions";
import { ReportTransaction, buildBalanceTurningPoints, buildWebTradeEntries, computeMatchGroupTotals, dayKey, getAverageActualFeesStrk, getMatchGroups, openerHashesOf, toReportTransactions } from "./matching";
import { TxData } from "./types";

// ---------------------------------------------------------------------------
// reports a compact snapshot to the small PHP webapp after every confirmed trade
// (see webapp/ingest.php) - failures here must never break the trading loop
// ---------------------------------------------------------------------------

const WEBAPP_URL = process.env.WEBAPP_URL
const WEBAPP_SECRET = process.env.WEBAPP_SECRET

async function postToWebapp(body: object): Promise<void> {
    const res = await fetch(WEBAPP_URL!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Report-Secret': WEBAPP_SECRET! },
        body: JSON.stringify(body)
    })
    const text = await res.text().catch(() => '')
    // ingest.php always replies with json - anything else (e.g. an html page from a wrong/redirected
    // URL) means the request never actually reached it, even if the http status was 200
    let parsed: { ok?: boolean } | undefined
    try {
        parsed = text ? JSON.parse(text) : undefined
    } catch {
        parsed = undefined
    }
    if (!res.ok || !parsed?.ok) {
        console.warn(`webapp report failed: ${res.status} ${text}`)
    }
}

// called right after a new trade has been persisted locally
export async function reportTradeToWebapp(newTx: TxData): Promise<void> {
    if (!WEBAPP_URL || !WEBAPP_SECRET) return
    try {
        const raw = await getTransactionData()
        const transactions = toReportTransactions(raw)
        const latest = transactions.find(t => t.hash === newTx.hash) ?? transactions[transactions.length - 1]
        if (!latest) return

        const current = {
            eth: latest.balanceEth.toString(),
            strk: latest.balanceStrk.toString(),
            timestamp: latest.date.getTime(),
            hash: latest.hash
        }
        const balancePoint = { date: dayKey(latest.date.getTime()), eth: current.eth, strk: current.strk }

        // if this trade closed a match group, attach its net gain/loss and refresh today's bucket
        const { groups } = getMatchGroups(transactions)
        const closingGroup = groups.find(g => g.hash === latest.hash)
        const fallbackFeeStrk = getAverageActualFeesStrk(transactions)
        let dailyEntry: { date: string, netEth: string, tradeCount: number } | undefined
        // openers absorbed into this newly-closed group are no longer their own open/closed
        // entry, so they must be dropped from the server's stored trade list
        const removeTradeHashes = closingGroup ? openerHashesOf(closingGroup) : []
        if (closingGroup) {
            const date = dayKey(latest.date.getTime())
            let dayNetEth = BigNumber.from(0)
            let dayTradeCount = 0
            for (const g of groups) {
                if (dayKey(g.trades[g.trades.length - 1].date.getTime()) !== date) continue
                const t = computeMatchGroupTotals(g.trades, fallbackFeeStrk)
                dayNetEth = dayNetEth.add(t.boughtEth.sub(t.soldEth).sub(t.txFeesEth).sub(t.failedFeesEth))
                dayTradeCount += g.trades.length
            }
            dailyEntry = { date, netEth: dayNetEth.toString(), tradeCount: dayTradeCount }
        }

        const trade = buildWebTradeEntries(transactions, fallbackFeeStrk).find(t => t.hash === latest.hash)
        if (!trade) return
        const turningPoints = buildBalanceTurningPoints(transactions).map(p => ({ date: dayKey(p.date.getTime()), direction: p.direction, diffEth: p.diffEth.toString(), diffStrk: p.diffStrk.toString() }))

        await postToWebapp({ current, balancePoint, trade, removeTradeHashes, dailyEntry, turningPoints })
    } catch (e) {
        console.warn('failed to report trade to webapp: ', e)
    }
}
