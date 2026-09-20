import { DATA_PATH, getTransactionData } from "./transactions";
import { computeMatchGroupTotals, getAverageActualFeesStrk, getMatchGroups, toReportTransactions } from "./matching";
import { appendMatchedGroupSummaries, MatchedGroupSummary } from "./aggregate";
import { loadArchivedTransactions } from "./archives";
import { TxData } from "./types";

// one-off backfill: reconstructs matched-group totals for trades that were already extracted by
// extractMatched.ts in the past (the "trades_prod_matched_*.json" files). Those archives only
// contain the "opener" trades of each group - the closing trade's own buy/sell amounts are needed
// too, and it normally still lives in the current active trade file (or in a later archive, if it
// was itself later matched again). So we merge every archive + the current file into one combined
// set of trades, then recompute match groups the same way reportMatched does, and store the
// results in the aggregate file so `matched`/`matched-detail` reports show the full history.
async function backfill() {
    if (!DATA_PATH) {
        console.log('TRADE_FILE is not set')
        return
    }
    const byHash = new Map<string, TxData>()
    for (const t of loadArchivedTransactions()) {
        byHash.set(t.hash, t)
    }
    const current = await getTransactionData()
    for (const t of current) {
        byHash.set(t.hash, t)
    }

    const combined = Array.from(byHash.values())
    console.log(`combined ${combined.length} unique trade(s) from archives + current file`)

    const reportTransactions = toReportTransactions(combined)
    const { groups } = getMatchGroups(reportTransactions)
    const fallbackFeeStrk = getAverageActualFeesStrk(reportTransactions)
    const summaries: MatchedGroupSummary[] = groups.map(({ trades }) => {
        const totals = computeMatchGroupTotals(trades, fallbackFeeStrk)
        return {
            closingHash: trades[trades.length - 1].hash,
            tradeCount: trades.length,
            fromTimestamp: trades[0].date.getTime(),
            toTimestamp: trades[trades.length - 1].date.getTime(),
            soldEth: totals.soldEth.toString(),
            boughtEth: totals.boughtEth.toString(),
            txFeesEth: totals.txFeesEth.toString(),
            failedFeesEth: totals.failedFeesEth.toString(),
        }
    })
    const added = await appendMatchedGroupSummaries(summaries)
    console.log(`backfilled ${added} new matched group(s) into the aggregate report data (${groups.length} group(s) found in total)`)
}

backfill()
