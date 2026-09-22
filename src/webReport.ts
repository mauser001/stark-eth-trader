import { BigNumber } from "@ethersproject/bignumber";
import { getTransactionData } from "./transactions";
import { ReportTransaction, computeMatchGroupTotals, dayKey, getAverageActualFeesStrk, getMatchGroups, toReportTransactions } from "./matching";
import { TxData } from "./types";

// ---------------------------------------------------------------------------
// reports a compact snapshot to the small PHP webapp after every confirmed trade
// (see webapp/ingest.php) - failures here must never break the trading loop
// ---------------------------------------------------------------------------

const WEBAPP_URL = process.env.WEBAPP_URL
const WEBAPP_SECRET = process.env.WEBAPP_SECRET

function tradeToWeb(t: ReportTransaction, netEth?: BigNumber) {
    return {
        hash: t.hash,
        timestamp: t.date.getTime(),
        sell: t.isSellingEth ? 'eth' : 'strk',
        sellAmount: t.sellAmount.toString(),
        buyAmount: t.buyAmount.toString(),
        actualFees: t.actualFees?.toString(),
        matched: !!t.matchedBy,
        netEth: netEth?.toString()
    }
}

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
        let netEth: BigNumber | undefined
        let dailyEntry: { date: string, netEth: string, tradeCount: number } | undefined
        if (closingGroup) {
            const fallbackFeeStrk = getAverageActualFeesStrk(transactions)
            const totals = computeMatchGroupTotals(closingGroup.trades, fallbackFeeStrk)
            netEth = totals.boughtEth.sub(totals.soldEth).sub(totals.txFeesEth).sub(totals.failedFeesEth)

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

        await postToWebapp({ current, balancePoint, trade: tradeToWeb(latest, netEth), dailyEntry })
    } catch (e) {
        console.warn('failed to report trade to webapp: ', e)
    }
}
