import { formatEther } from "ethers";
import { getTransactionData } from "./transactions";
import { BigNumber } from "@ethersproject/bignumber";
import { RATIO_MULTI } from "./conts";
import { getTxRatio } from "./quote";
import { TxData } from "./types";
import { MatchedEntry, ReportTransaction, buildMatchedEntries, computeMatchGroupTotals, getAverageActualFeesStrk, getMatchGroups, toReportTransactions } from "./matching";
import { AggregateData, ExternalTransfer, getAggregateData } from "./aggregate";
import { loadArchivedTransactions } from "./archives";

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function formatBig(value: BigNumber): string {
    return formatEther(value.toBigInt())
}

function printBalance(label: string, eth: BigNumber, strk: BigNumber, date: Date) {
    console.log(`${label} - Eth: ${formatBig(eth)} | Strk: ${formatBig(strk)} | date: ${date?.toDateString()}`)
}

// ratio between two amounts scaled by 1000, e.g. 1250 means actual is 125% of expected
function ratioPermille(actual: BigNumber, expected?: BigNumber): BigNumber | undefined {
    if (!expected || expected.isZero()) return undefined
    return actual.mul(1000).div(expected)
}

function formatPercent(permille?: BigNumber): string {
    if (!permille) return 'n/a'
    return `${(permille.toNumber() / 10).toFixed(1)}%`
}

// ---------------------------------------------------------------------------
// report: overview (balances and gain/loss in eth terms)
// ---------------------------------------------------------------------------

// sum of manually recorded external eth/strk top-ups within [from, to], so they can be excluded
// from the trading gain/loss calc below (they are deposits, not trading profit)
function sumExternalTransfers(transfers: ExternalTransfer[], from: number, to: number): { eth: BigNumber, strk: BigNumber } {
    let eth = BigNumber.from(0)
    let strk = BigNumber.from(0)
    for (const t of transfers) {
        if (t.timestamp < from || t.timestamp > to) continue
        if (t.ethAmount) eth = eth.add(t.ethAmount)
        if (t.strkAmount) strk = strk.add(t.strkAmount)
    }
    return { eth, strk }
}

function reportOverview(transactions: ReportTransaction[], aggregate: AggregateData) {
    console.log('-----------------------Overview------------------------');
    const firstMatchedTradeIndex = transactions.findIndex(({ matchedBy }, i) => i > 0 && !!matchedBy)
    if (firstMatchedTradeIndex < 0) {
        console.log(`No matched trades yet of ${transactions.length} trades`)
    } else {
        console.log(`Trades before first matched trade: ${firstMatchedTradeIndex} of ${transactions.length}`)
    }
    const firstTrade = transactions[0]
    printBalance('Initial Balance', firstTrade.balanceEth, firstTrade.balanceStrk, firstTrade.date)
    const lastTrade = transactions[transactions.length - 1]
    printBalance('Last Balance', lastTrade.balanceEth, lastTrade.balanceStrk, lastTrade.date)

    const { eth: transferredEth, strk: transferredStrk } = sumExternalTransfers(
        aggregate.externalTransfers, firstTrade.date.getTime(), lastTrade.date.getTime())
    if (transferredEth.gt(0) || transferredStrk.gt(0)) {
        console.log(`Excluding known external transfers in this range: ${formatBig(transferredEth)} Eth, ${formatBig(transferredStrk)} Strk`)
    }

    const firstBalanceEth = firstTrade.balanceEth
    const firstBalanceStrk = firstTrade.balanceStrk
    // deposits inflate the last balance, so subtract them before comparing to the initial balance
    const lastBalanceEth = lastTrade.balanceEth.sub(transferredEth)
    const lastBalanceStrk = lastTrade.balanceStrk.sub(transferredStrk)

    if (firstBalanceEth.lt(lastBalanceEth)) {
        console.log(`We have more ${formatBig(lastBalanceEth.sub(firstBalanceEth))} Eth on matched trades`)
    } else {
        console.log(`We have less ${formatBig(firstBalanceEth.sub(lastBalanceEth))} Eth on matched trades`)
    }
    if (firstBalanceStrk.lt(lastBalanceStrk)) {
        console.log(`We have more ${formatBig(lastBalanceStrk.sub(firstBalanceStrk))} Strk on matched trades`)
    } else {
        console.log(`We have less ${formatBig(firstBalanceStrk.sub(lastBalanceStrk))} Strk on matched trades`)
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
}

// ---------------------------------------------------------------------------
// reports: open (open trades + counts) and matched (matched groups + totals)
// ---------------------------------------------------------------------------

function reportOpen(transactions: ReportTransaction[]) {
    console.log('-----------------------Open trades------------------------');
    const { matchedHashes } = getMatchGroups(transactions)
    const count = {
        ethSell: 0,
        ethMatched: 0,
        strkSell: 0,
        strkMatched: 0,
    }
    for (const t of transactions) {
        const isMatched = matchedHashes.has(t.hash) || (!!t.matchedBy && t.matchedBy !== 'initial')
        if (t.isSellingEth) {
            count.ethSell++
            if (isMatched) count.ethMatched++
        } else {
            count.strkSell++
            if (isMatched) count.strkMatched++
        }
        if (t.isSellingEth && !isMatched) {
            const ratio = t.buyAmount.mul(RATIO_MULTI).div(t.sellAmount)
            console.log(`${formatDayMonth(t.date)}: ratio: ${(ratio.toNumber() / RATIO_MULTI).toFixed(2)} ETH->STRK sell: ${formatBig8(t.sellAmount)} | buy: ${formatBig8(t.buyAmount)}`)
        }
    }
    console.log(`Tx Count-> Eth: ${count.ethSell} (matched: ${count.ethMatched}) | Strk: ${count.strkSell} (matched: ${count.strkMatched})`)
}

// rounds to 8 decimal places using BigNumber math (avoids float precision loss)
function formatBig8(value: BigNumber): string {
    const isNeg = value.isNegative()
    const unit = BigNumber.from(10).pow(10) // 18 - 8 decimals to drop
    const rounded = value.abs().add(unit.div(2)).div(unit).mul(unit)
    const full = formatEther((isNeg ? rounded.mul(-1) : rounded).toBigInt())
    const [intPart, decPart = ''] = full.split('.')
    return `${intPart}.${decPart.padEnd(8, '0').slice(0, 8)}`
}

function formatDayMonth(date: Date): string {
    return `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}`
}

function formatDayMonthYear(date: Date): string {
    return `${formatDayMonth(date)}.${(date.getFullYear() % 100).toString().padStart(2, '0')}`
}

function groupDateLabel(trades: ReportTransaction[]): string {
    const matchedTrades = trades.slice(0, -1) // exclude the closing tx from the count
    const first = formatDayMonth(matchedTrades[0].date)
    if (matchedTrades.length === 1) return `matched 1 tx from ${first}`
    const last = formatDayMonth(matchedTrades[matchedTrades.length - 1].date)
    return `matched ${matchedTrades.length} tx between ${first} - ${last}`
}

// totals of matched groups already archived by extractMatched (their opener trades no longer
// exist in the live trade file, so they can only be recovered from the aggregate data)
function archivedTotals(aggregate: AggregateData): { soldEth: BigNumber, boughtEth: BigNumber, txFeesEth: BigNumber, failedFeesEth: BigNumber, groupCount: number } {
    let soldEth = BigNumber.from(0)
    let boughtEth = BigNumber.from(0)
    let txFeesEth = BigNumber.from(0)
    let failedFeesEth = BigNumber.from(0)
    for (const g of aggregate.matchedGroups) {
        soldEth = soldEth.add(g.soldEth)
        boughtEth = boughtEth.add(g.boughtEth)
        txFeesEth = txFeesEth.add(g.txFeesEth)
        failedFeesEth = failedFeesEth.add(g.failedFeesEth)
    }
    return { soldEth, boughtEth, txFeesEth, failedFeesEth, groupCount: aggregate.matchedGroups.length }
}

function reportMatched(transactions: ReportTransaction[], aggregate: AggregateData) {
    console.log('-----------------------Matched trades------------------------');
    const { groups } = getMatchGroups(transactions)
    const archived = archivedTotals(aggregate)
    const fallbackFeeStrk = getAverageActualFeesStrk(transactions)
    let totalSoldEth = archived.soldEth
    let totalBoughtEth = archived.boughtEth
    let totalTxFeesEth = archived.txFeesEth
    let totalFailedFeesEth = archived.failedFeesEth
    if (archived.groupCount) {
        console.log(`(including ${archived.groupCount} archived group(s) from previous extractMatched runs)`)
    }

    // always show every group still in the live file, but keep at least MIN_ENTRIES visible by
    // filling up with the most recent archived groups when extractMatched removed too many
    const MIN_ENTRIES = 20
    const missing = Math.max(0, MIN_ENTRIES - groups.length)
    const filledFromArchive = [...aggregate.matchedGroups]
        .sort((a, b) => b.toTimestamp - a.toTimestamp)
        .slice(0, missing)
    const displayEntries: { date: Date, label: string, netEth: BigNumber }[] = filledFromArchive.map(g => ({
        date: new Date(g.toTimestamp),
        label: `matched ${g.tradeCount - 1} tx (archived)`,
        netEth: BigNumber.from(g.boughtEth).sub(g.soldEth).sub(g.txFeesEth).sub(g.failedFeesEth)
    }))

    for (const { trades } of groups) {
        const { soldEth, boughtEth, txFeesEth, failedFeesEth } = computeMatchGroupTotals(trades, fallbackFeeStrk)
        totalSoldEth = totalSoldEth.add(soldEth)
        totalBoughtEth = totalBoughtEth.add(boughtEth)
        totalTxFeesEth = totalTxFeesEth.add(txFeesEth)
        totalFailedFeesEth = totalFailedFeesEth.add(failedFeesEth)
        const netEth = boughtEth.sub(soldEth).sub(txFeesEth).sub(failedFeesEth)
        displayEntries.push({ date: trades[trades.length - 1].date, label: groupDateLabel(trades), netEth })
    }

    for (const { date, label, netEth } of displayEntries.sort((a, b) => a.date.getTime() - b.date.getTime())) {
        const closingDate = formatDayMonth(date)
        if (netEth.isNegative()) {
            console.warn(`${closingDate}: ${label}: We lost ${formatBig8(netEth.abs())} Eth`)
        } else {
            console.log(`${closingDate}: ${label}: We made ${formatBig8(netEth)} Eth`)
        }
    }
    if (totalSoldEth.isZero() && totalBoughtEth.isZero()) {
        console.warn('No matched trades, cannot compare totals')
    } else {
        const totalNetEth = totalBoughtEth.sub(totalSoldEth).sub(totalTxFeesEth).sub(totalFailedFeesEth)
        if (totalNetEth.isNegative()) {
            console.warn(`In total we lost ${formatBig8(totalNetEth.abs())} Eth after ${formatBig8(totalTxFeesEth)} Eth in applicable tx fees and ${formatBig8(totalFailedFeesEth)} Eth in failed tx fees`)
        } else {
            console.log(`In total we made ${formatBig8(totalNetEth)} Eth after ${formatBig8(totalTxFeesEth)} Eth in applicable tx fees and ${formatBig8(totalFailedFeesEth)} Eth in failed tx fees`)
        }
    }
}

function reportMatchedDetail(transactions: ReportTransaction[], aggregate: AggregateData) {
    console.log('-----------------------Matched trades (detail)------------------------');
    const { groups } = getMatchGroups(transactions)
    const archived = archivedTotals(aggregate)
    const fallbackFeeStrk = getAverageActualFeesStrk(transactions)
    let totalSoldEth = archived.soldEth
    let totalBoughtEth = archived.boughtEth
    let totalTxFeesEth = archived.txFeesEth
    let totalFailedFeesEth = archived.failedFeesEth
    if (archived.groupCount) {
        console.log(`(including ${archived.groupCount} archived group(s) from previous extractMatched runs, totals only)`)
    }
    for (const { hash, trades } of groups) {
        const { soldEth, boughtEth, txFeesEth, failedFeesEth } = computeMatchGroupTotals(trades, fallbackFeeStrk)
        totalSoldEth = totalSoldEth.add(soldEth)
        totalBoughtEth = totalBoughtEth.add(boughtEth)
        totalTxFeesEth = totalTxFeesEth.add(txFeesEth)
        totalFailedFeesEth = totalFailedFeesEth.add(failedFeesEth)
        const netEth = boughtEth.sub(soldEth).sub(txFeesEth).sub(failedFeesEth)
        if (netEth.isNegative()) {
            console.warn(`We lost ${formatBig8(netEth.abs())} Eth after ${formatBig8(txFeesEth)} Eth in applicable tx fees and ${formatBig8(failedFeesEth)} Eth in failed tx fees, closing tx: ${hash}`)
        } else {
            console.log(`We made ${formatBig8(netEth)} Eth after ${formatBig8(txFeesEth)} Eth in applicable tx fees and ${formatBig8(failedFeesEth)} Eth in failed tx fees, closing tx: ${hash}`)
        }
    }
    if (totalSoldEth.isZero() && totalBoughtEth.isZero()) {
        console.warn('No matched trades, cannot compare totals')
    } else {
        const totalNetEth = totalBoughtEth.sub(totalSoldEth).sub(totalTxFeesEth).sub(totalFailedFeesEth)
        if (totalNetEth.isNegative()) {
            console.warn(`In total we lost ${formatBig8(totalNetEth.abs())} Eth after ${formatBig8(totalTxFeesEth)} Eth in applicable tx fees and ${formatBig8(totalFailedFeesEth)} Eth in failed tx fees`)
        } else {
            console.log(`In total we made ${formatBig8(totalNetEth)} Eth after ${formatBig8(totalTxFeesEth)} Eth in applicable tx fees and ${formatBig8(totalFailedFeesEth)} Eth in failed tx fees`)
        }
    }
}

// ---------------------------------------------------------------------------
// reports: matched-daily / matched-monthly (net gain/loss grouped by closing date)
// ---------------------------------------------------------------------------

function formatMonthYear(date: Date): string {
    return `${(date.getMonth() + 1).toString().padStart(2, '0')}.${(date.getFullYear() % 100).toString().padStart(2, '0')}`
}

function reportMatchedByPeriod(entries: MatchedEntry[], periodLabel: (date: Date) => string) {
    const buckets = new Map<string, { date: Date, netEth: BigNumber, tradeCount: number }>()
    for (const e of entries) {
        const key = periodLabel(e.date)
        const bucket = buckets.get(key) ?? { date: e.date, netEth: BigNumber.from(0), tradeCount: 0 }
        bucket.netEth = bucket.netEth.add(e.netEth)
        bucket.tradeCount += e.tradeCount
        buckets.set(key, bucket)
    }
    for (const [label, b] of Array.from(buckets.entries()).sort((a, b) => a[1].date.getTime() - b[1].date.getTime())) {
        if (b.netEth.isNegative()) {
            console.warn(`${label} we lost ${formatBig8(b.netEth.abs())} ETH on ${b.tradeCount} trades`)
        } else {
            console.log(`${label} we made ${formatBig8(b.netEth)} ETH on ${b.tradeCount} trades`)
        }
    }
}

function reportMatchedDaily(transactions: ReportTransaction[], aggregate: AggregateData) {
    console.log('-----------------------Matched trades per day------------------------');
    const entries = buildMatchedEntries(transactions, aggregate, getAverageActualFeesStrk(transactions))
    reportMatchedByPeriod(entries, formatDayMonthYear)
}

function reportMatchedMonthly(transactions: ReportTransaction[], aggregate: AggregateData) {
    console.log('-----------------------Matched trades per month------------------------');
    const entries = buildMatchedEntries(transactions, aggregate, getAverageActualFeesStrk(transactions))
    reportMatchedByPeriod(entries, formatMonthYear)
}

// ---------------------------------------------------------------------------
// report: unmatched (latest open trades, same ratio calc used when picking a trade to fill)
// ---------------------------------------------------------------------------

function reportUnmatched(transactions: ReportTransaction[]) {
    console.log('-----------------------Latest unmatched trades------------------------');
    const unmatched = transactions.filter(t => !t.matchedBy)
    const latest = unmatched.slice(-10)
    if (!latest.length) {
        console.log('no unmatched trades')
        return
    }
    for (const t of latest) {
        const sell = t.isSellingEth ? 'eth' : 'strk'
        const ratio = getTxRatio(sell, t.sellAmount, t.buyAmount)
        const direction = t.isSellingEth ? 'ETH->STRK' : 'STRK->ETH'
        console.log(`${formatDayMonth(t.date)}: ratio: ${(ratio.toNumber() / RATIO_MULTI).toFixed(2)} ${direction} sell: ${formatBig8(t.sellAmount)} | buy: ${formatBig8(t.buyAmount)}`)
    }
    console.log(`${unmatched.length} unmatched trade(s) total, showing latest ${latest.length}`)
}

// ---------------------------------------------------------------------------
// report: backwards (balance changes walking back from the latest trade)
// ---------------------------------------------------------------------------

function haveBothChangedDirection(t: ReportTransaction, compare: ReportTransaction): ReportTransaction {
    if (t.balanceEth.gt(compare.balanceEth) && t.balanceStrk.gt(compare.balanceStrk)) {
        const diffEth = t.balanceEth.sub(compare.balanceEth)
        const diffStrk = t.balanceStrk.sub(compare.balanceStrk)
        console.log(`Down ${formatDayMonthYear(t.date)} Eth: ${formatBig8(diffEth)} Strk: ${formatBig8(diffStrk)}`)
        return t;
    } else if (t.balanceEth.lt(compare.balanceEth) && t.balanceStrk.lt(compare.balanceStrk)) {
        const diffEth = compare.balanceEth.sub(t.balanceEth)
        const diffStrk = compare.balanceStrk.sub(t.balanceStrk)
        console.log(`Up ${formatDayMonthYear(t.date)} Eth: ${formatBig8(diffEth)} Strk: ${formatBig8(diffStrk)}`)
        return t;
    }
    return compare;
}

function reportBackwards(transactions: ReportTransaction[]) {
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

// merges the archived (already-extracted) trades back in with the live ones and re-sorts by
// timestamp, so the balance walk isn't cut short at the point of the last extractMatched run
function buildBackwardsTransactions(rawTransactions: TxData[]): ReportTransaction[] {
    const byHash = new Map(rawTransactions.map(t => [t.hash, t]))
    for (const t of loadArchivedTransactions()) {
        if (!byHash.has(t.hash)) byHash.set(t.hash, t)
    }
    return toReportTransactions(Array.from(byHash.values()))
}

// ---------------------------------------------------------------------------
// report: fees (actual tx fees vs. the estimates we traded with)
// ---------------------------------------------------------------------------

function expectedFeesInStrk(t: TxData): BigNumber | undefined {
    return t.expectedFeesStrk ? BigNumber.from(t.expectedFeesStrk) : undefined
}

function reportFees(rawTransactions: TxData[]) {
    console.log('-----------------------Tx fee analytics------------------------')
    const txs = rawTransactions
        .filter(t => t.timestamp && t.actualFees && expectedFeesInStrk(t))
        .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
    const skipped = rawTransactions.filter(t => t.timestamp).length - txs.length
    if (skipped > 0) {
        console.log(`skipping ${skipped} trades without actualFees or expectedFeesStrk`)
    }
    if (!txs.length) {
        console.log('no trades with actual fees yet')
        return
    }

    let sumActual = BigNumber.from(0)
    let nOurs = 0, nMax = 0
    let sumRatioOurs = BigNumber.from(0), sumRatioMax = BigNumber.from(0)
    let maxRatioMax = BigNumber.from(0)
    let overOurs = 0, overMax = 0

    const recentFrom = txs.length - 20
    txs.forEach((t, i) => {
        const actual = BigNumber.from(t.actualFees)
        const ours = expectedFeesInStrk(t)
        const max = t.expectedMaxFees ? BigNumber.from(t.expectedMaxFees) : undefined
        sumActual = sumActual.add(actual)

        const ratioOurs = ratioPermille(actual, ours)
        const ratioMax = ratioPermille(actual, max)
        if (ratioOurs) {
            nOurs++; sumRatioOurs = sumRatioOurs.add(ratioOurs)
            if (actual.gt(ours!)) overOurs++
        }
        if (ratioMax) {
            nMax++; sumRatioMax = sumRatioMax.add(ratioMax)
            if (actual.gt(max!)) overMax++
            if (ratioMax.gt(maxRatioMax)) maxRatioMax = ratioMax
        }

        // only print the most recent trades plus the ones where an estimate was exceeded
        if (i >= recentFrom || (ours && actual.gt(ours)) || (max && actual.gt(max))) {
            const date = formatDayMonth(new Date(t.timestamp ?? 0))
            console.log(`${date}: sell ${t.sell ?? '?'} | actual: ${formatBig8(actual)} | ours: ${ours ? formatBig8(ours) : '-'} (${formatPercent(ratioOurs)}) | max: ${max ? formatBig8(max) : '-'} (${formatPercent(ratioMax)})`)
        }
    })

    console.log(`trades with actual fees: ${txs.length}, total fees paid: ${formatBig8(sumActual)} STRK, avg: ${formatBig8(sumActual.div(txs.length))} STRK`)
    if (nOurs) console.log(`actual vs our expectedFee: avg ${formatPercent(sumRatioOurs.div(nOurs))} | actual was higher in ${overOurs}/${nOurs} trades`)
    if (nMax) console.log(`actual vs expectedMaxFee: avg ${formatPercent(sumRatioMax.div(nMax))} | worst ${formatPercent(maxRatioMax)} | over max: ${overMax} (should always be 0)`)
}

// ---------------------------------------------------------------------------
// entry point: npm run report-prod -- <report>
// ---------------------------------------------------------------------------

type Report = {
    description: string,
    run: (transactions: ReportTransaction[], rawTransactions: TxData[], aggregate: AggregateData) => void
}

const reports: Record<string, Report> = {
    overview: { description: 'balances and gain/loss in eth terms', run: (t, _raw, agg) => reportOverview(t, agg) },
    open: { description: 'open trades (ratios of unmatched eth sells) and trade counts', run: (t) => reportOpen(t) },
    matched: { description: 'matched trade groups and sold vs bought comparison (rounded, totals only)', run: (t, _raw, agg) => reportMatched(t, agg) },
    'matched-detail': { description: 'matched trade groups with per-group fee breakdown and closing tx hash', run: (t, _raw, agg) => reportMatchedDetail(t, agg) },
    'matched-daily': { description: 'net gain/loss and trade count grouped by closing day (includes archived groups)', run: (t, _raw, agg) => reportMatchedDaily(t, agg) },
    'matched-monthly': { description: 'net gain/loss and trade count grouped by closing month (includes archived groups)', run: (t, _raw, agg) => reportMatchedMonthly(t, agg) },
    unmatched: { description: 'latest 10 unmatched trades with amounts and ratios', run: (t) => reportUnmatched(t) },
    backwards: { description: 'balance changes walking backwards from the latest trade (includes archived trades)', run: (_t, raw) => reportBackwards(buildBackwardsTransactions(raw)) },
    fees: { description: 'tx fee analytics: actual fees vs avnu/our/max estimates', run: (_t, raw) => reportFees(raw) },
}

async function analyseTrades() {
    const reportName = (process.argv[2] ?? 'all').toLowerCase()
    const rawTransactions = await getTransactionData()
    if (!rawTransactions || rawTransactions.length < 2) {
        console.log('no transaction done')
        return
    }
    const transactions = toReportTransactions(rawTransactions)
    if (transactions.length < 2) {
        console.log('not enough completed transactions')
        return
    }
    const aggregate = await getAggregateData()

    if (reportName === 'all') {
        for (const name of Object.keys(reports)) {
            reports[name].run(transactions, rawTransactions, aggregate)
        }
        return
    }
    const report = reports[reportName]
    if (!report) {
        console.log(`unknown report '${reportName}'. Usage: npm run report-prod -- <report>`)
        for (const [name, r] of Object.entries(reports)) {
            console.log(`  ${name.padEnd(10)} ${r.description}`)
        }
        console.log('  all        run every report (default)')
        return
    }
    report.run(transactions, rawTransactions, aggregate)
}

analyseTrades()