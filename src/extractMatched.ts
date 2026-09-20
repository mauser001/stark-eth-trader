import { DATA_PATH, getTransactionData, saveTransactionData } from "./transactions";
import { computeMatchGroupTotals, getAverageActualFeesStrk, getMatchGroups, toReportTransactions } from "./matching";
import { appendMatchedGroupSummaries, MatchedGroupSummary } from "./aggregate";
import { TxData } from "./types";

// before we physically remove the matched (opener) trades, summarize the full match groups
// (opener trades + still-present closing trade) into the aggregate file so report totals stay
// correct even after the opener trades are gone. Groups already recorded (by closing tx hash)
// are skipped, so re-running this is safe.
async function archiveMatchGroups(transactions: TxData[]) {
    const reportTransactions = toReportTransactions(transactions)
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
    console.log(`archived ${added} new matched group(s) into the aggregate report data (${groups.length} group(s) present)`)
}

async function extractMatched() {
    const transactions = await getTransactionData()
    if (transactions?.length < 2) {
        console.log('no transaction done')
    }

    await archiveMatchGroups(transactions)

    const matched = []
    const unmatched = []
    const first = transactions.splice(0, 1)[0]

    transactions.forEach((t, index) => {
        if (t.matchedBy) {
            matched.push(t)
            // if the last transaction is matched we still want to keep it for the last balance
            if (index === transactions.length - 1) {
                unmatched.push(t)
            }
        } else {
            unmatched.push(t)
        }
    })

    console.log(`we have ${matched.length} matchted and ${unmatched.length} unmatched transactions`)
    const now = new Date()
    const matchedPath = DATA_PATH.replace('.json', `_matched_${now.getFullYear()}_${now.getMonth() + 1}_${now.getDate()}.json`)
    await saveTransactionData(matched, matchedPath)
    await saveTransactionData([first, ...unmatched])
}

extractMatched()