import { formatEther } from "ethers";
import { getTransactionData } from "./transactions";
import { BigNumber } from "@ethersproject/bignumber";
import { RATIO_MULTI } from "./conts";
import { getTxRatio } from "./quote";
import { TxData } from "./types";
import { MatchedEntry, ReportTransaction, buildBalanceTurningPoints, buildMatchedEntries, buildProgressSeries, computeMatchGroupTotals, getAverageActualFeesStrk, getMatchGroups, toReportTransactions } from "./matching";
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
        ethOpenSellAmount: BigNumber.from(0),
        ethMatched: 0,
        strkSell: 0,
        strkOpenSellAmount: BigNumber.from(0),
        strkMatched: 0,
    }
    for (const t of transactions) {
        const isMatched = matchedHashes.has(t.hash) || (!!t.matchedBy && t.matchedBy !== 'initial')
        if (t.isSellingEth) {
            count.ethSell++
            if (isMatched) count.ethMatched++
            else count.ethOpenSellAmount = count.ethOpenSellAmount.add(t.sellAmount)
        } else {
            count.strkSell++
            if (isMatched) count.strkMatched++
            else count.strkOpenSellAmount = count.strkOpenSellAmount.add(t.sellAmount)
        }
        if (t.isSellingEth && !isMatched) {
            const ratio = t.buyAmount.mul(RATIO_MULTI).div(t.sellAmount)
            console.log(`${formatDayMonth(t.date)}: ratio: ${(ratio.toNumber() / RATIO_MULTI).toFixed(2)} ETH->STRK sell: ${formatBig8(t.sellAmount)} | buy: ${formatBig8(t.buyAmount)}`)
        }
    }
    console.log(`Tx Count-> Eth: ${count.ethSell} (open: ${count.ethSell - count.ethMatched}) | Strk: ${count.strkSell} (open: ${count.strkSell - count.strkMatched})`)
    console.log(`Eth Open sell Amount: ${formatBig8(count.ethOpenSellAmount)}`)
    console.log(`Strk Open sell Amount: ${formatBig8(count.strkOpenSellAmount)}`)
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
function archivedTotals(aggregate: AggregateData): { soldEth: BigNumber, boughtEth: BigNumber, txFeesEth: BigNumber, failedFeesEth: BigNumber, unknownClosingFeeCount: number, estimatedClosingFeeCount: number, groupCount: number } {
    let soldEth = BigNumber.from(0)
    let boughtEth = BigNumber.from(0)
    let txFeesEth = BigNumber.from(0)
    let failedFeesEth = BigNumber.from(0)
    let unknownClosingFeeCount = 0
    let estimatedClosingFeeCount = 0
    for (const g of aggregate.matchedGroups) {
        soldEth = soldEth.add(g.soldEth)
        boughtEth = boughtEth.add(g.boughtEth)
        if (g.closingFeeKnown === true || g.closingFeeEstimated === true) txFeesEth = txFeesEth.add(g.txFeesEth)
        failedFeesEth = failedFeesEth.add(g.failedFeesEth)
        if (g.closingFeeEstimated === true) estimatedClosingFeeCount++
        else if (g.closingFeeKnown !== true) unknownClosingFeeCount++
    }
    return { soldEth, boughtEth, txFeesEth, failedFeesEth, unknownClosingFeeCount, estimatedClosingFeeCount, groupCount: aggregate.matchedGroups.length }
}

function reportMatched(transactions: ReportTransaction[], aggregate: AggregateData) {
    console.log('-----------------------Matched trades------------------------');
    const { groups } = getMatchGroups(transactions)
    const archived = archivedTotals(aggregate)
    let totalSoldEth = archived.soldEth
    let totalBoughtEth = archived.boughtEth
    let totalTxFeesEth = archived.txFeesEth
    let totalFailedFeesEth = archived.failedFeesEth
    let unknownClosingFeeCount = archived.unknownClosingFeeCount
    let estimatedClosingFeeCount = archived.estimatedClosingFeeCount
    if (archived.groupCount) {
        console.log(`(including ${archived.groupCount} archived group(s) from previous extractMatched runs)`)
    }

    // always show every group still in the live file, but keep at least MIN_ENTRIES visible by
    // filling up with the most recent archived groups when extractMatched removed too many
    const MIN_ENTRIES = 20
    const missing = Math.max(0, MIN_ENTRIES - groups.length)
    const fallbackFeeStrk = getAverageActualFeesStrk(transactions)
    const filledFromArchive = [...aggregate.matchedGroups]
        .sort((a, b) => b.toTimestamp - a.toTimestamp)
        .slice(0, missing)
    const displayEntries: { date: Date, label: string, netEth: BigNumber, closingFeeKnown: boolean, closingFeeEstimated: boolean }[] = filledFromArchive.map(g => ({
        date: new Date(g.toTimestamp),
        label: `matched ${g.tradeCount - 1} tx (archived)`,
        netEth: BigNumber.from(g.boughtEth).sub(g.soldEth).sub(
            g.closingFeeKnown === true || g.closingFeeEstimated === true ? g.txFeesEth : 0),
        closingFeeKnown: g.closingFeeKnown === true,
        closingFeeEstimated: g.closingFeeEstimated === true
    }))

    for (const { trades } of groups) {
        const { soldEth, boughtEth, txFeesEth, failedFeesEth, closingFeeKnown, closingFeeEstimated } = computeMatchGroupTotals(trades, fallbackFeeStrk)
        totalSoldEth = totalSoldEth.add(soldEth)
        totalBoughtEth = totalBoughtEth.add(boughtEth)
        totalTxFeesEth = totalTxFeesEth.add(txFeesEth)
        totalFailedFeesEth = totalFailedFeesEth.add(failedFeesEth)
        if (closingFeeEstimated) estimatedClosingFeeCount++
        else if (!closingFeeKnown) unknownClosingFeeCount++
        const netEth = boughtEth.sub(soldEth).sub(txFeesEth)
        displayEntries.push({ date: trades[trades.length - 1].date, label: groupDateLabel(trades), netEth, closingFeeKnown, closingFeeEstimated })
    }

    for (const { date, label, netEth, closingFeeKnown, closingFeeEstimated } of displayEntries.sort((a, b) => a.date.getTime() - b.date.getTime())) {
        const closingDate = formatDayMonth(date)
        const feeNote = closingFeeEstimated ? ' after estimated closing fee' : closingFeeKnown ? '' : ' before unknown closing fee'
        if (netEth.isNegative()) {
            console.warn(`${closingDate}: ${label}: We lost ${formatBig8(netEth.abs())} Eth${feeNote}`)
        } else {
            console.log(`${closingDate}: ${label}: We made ${formatBig8(netEth)} Eth${feeNote}`)
        }
    }
    if (totalSoldEth.isZero() && totalBoughtEth.isZero()) {
        console.warn('No matched trades, cannot compare totals')
    } else {
        const totalNetEth = totalBoughtEth.sub(totalSoldEth).sub(totalTxFeesEth)
        if (totalNetEth.isNegative()) {
            console.warn(`In total we lost ${formatBig8(totalNetEth.abs())} Eth after ${formatBig8(totalTxFeesEth)} Eth in known/estimated closing tx fees; ${estimatedClosingFeeCount} estimated, ${unknownClosingFeeCount} unknown (failed tx fees excluded)`)
        } else {
            console.log(`In total we made ${formatBig8(totalNetEth)} Eth after ${formatBig8(totalTxFeesEth)} Eth in known/estimated closing tx fees; ${estimatedClosingFeeCount} estimated, ${unknownClosingFeeCount} unknown (failed tx fees excluded)`)
        }
    }
}

function reportMatchedDetail(transactions: ReportTransaction[], aggregate: AggregateData) {
    console.log('-----------------------Matched trades (detail)------------------------');
    const { groups } = getMatchGroups(transactions)
    const archived = archivedTotals(aggregate)
    let totalSoldEth = archived.soldEth
    let totalBoughtEth = archived.boughtEth
    let totalTxFeesEth = archived.txFeesEth
    let totalFailedFeesEth = archived.failedFeesEth
    let unknownClosingFeeCount = archived.unknownClosingFeeCount
    let estimatedClosingFeeCount = archived.estimatedClosingFeeCount
    const fallbackFeeStrk = getAverageActualFeesStrk(transactions)
    if (archived.groupCount) {
        console.log(`(including ${archived.groupCount} archived group(s) from previous extractMatched runs, totals only)`)
    }
    for (const { hash, trades } of groups) {
        const { soldEth, boughtEth, txFeesEth, failedFeesEth, closingFeeKnown, closingFeeEstimated } = computeMatchGroupTotals(trades, fallbackFeeStrk)
        totalSoldEth = totalSoldEth.add(soldEth)
        totalBoughtEth = totalBoughtEth.add(boughtEth)
        totalTxFeesEth = totalTxFeesEth.add(txFeesEth)
        totalFailedFeesEth = totalFailedFeesEth.add(failedFeesEth)
        if (closingFeeEstimated) estimatedClosingFeeCount++
        else if (!closingFeeKnown) unknownClosingFeeCount++
        const netEth = boughtEth.sub(soldEth).sub(txFeesEth)
        const feeNote = closingFeeEstimated
            ? `${formatBig8(txFeesEth)} Eth estimated closing tx fee`
            : closingFeeKnown
                ? `${formatBig8(txFeesEth)} Eth actual closing tx fee`
                : 'closing tx fee unknown'
        if (netEth.isNegative()) {
            console.warn(`We lost ${formatBig8(netEth.abs())} Eth after ${feeNote} (failed tx fees excluded), closing tx: ${hash}`)
        } else {
            console.log(`We made ${formatBig8(netEth)} Eth after ${feeNote} (failed tx fees excluded), closing tx: ${hash}`)
        }
    }
    if (totalSoldEth.isZero() && totalBoughtEth.isZero()) {
        console.warn('No matched trades, cannot compare totals')
    } else {
        const totalNetEth = totalBoughtEth.sub(totalSoldEth).sub(totalTxFeesEth)
        if (totalNetEth.isNegative()) {
            console.warn(`In total we lost ${formatBig8(totalNetEth.abs())} Eth after ${formatBig8(totalTxFeesEth)} Eth in known/estimated closing tx fees; ${estimatedClosingFeeCount} estimated, ${unknownClosingFeeCount} unknown (failed tx fees excluded)`)
        } else {
            console.log(`In total we made ${formatBig8(totalNetEth)} Eth after ${formatBig8(totalTxFeesEth)} Eth in known/estimated closing tx fees; ${estimatedClosingFeeCount} estimated, ${unknownClosingFeeCount} unknown (failed tx fees excluded)`)
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
    const buckets = new Map<string, { date: Date, netEth: BigNumber, tradeCount: number, unknownClosingFeeCount: number, estimatedClosingFeeCount: number }>()
    for (const e of entries) {
        const key = periodLabel(e.date)
        const bucket = buckets.get(key) ?? { date: e.date, netEth: BigNumber.from(0), tradeCount: 0, unknownClosingFeeCount: 0, estimatedClosingFeeCount: 0 }
        bucket.netEth = bucket.netEth.add(e.netEth)
        bucket.tradeCount += e.tradeCount
        bucket.unknownClosingFeeCount += e.unknownClosingFeeCount
        bucket.estimatedClosingFeeCount += e.estimatedClosingFeeCount
        buckets.set(key, bucket)
    }
    for (const [label, b] of Array.from(buckets.entries()).sort((a, b) => a[1].date.getTime() - b[1].date.getTime())) {
        const result = b.netEth.isNegative()
            ? `lost ${formatBig8(b.netEth.abs())}`
            : `made ${formatBig8(b.netEth)}`
        const feeStatus = b.unknownClosingFeeCount && b.estimatedClosingFeeCount
            ? ` after ${b.estimatedClosingFeeCount} estimated closing fee(s); ${b.unknownClosingFeeCount} closing fee(s) unknown`
            : b.unknownClosingFeeCount
                ? ` before ${b.unknownClosingFeeCount} unknown closing fee(s)`
                : b.estimatedClosingFeeCount
                    ? ` after ${b.estimatedClosingFeeCount} estimated closing fee(s)`
                    : ' after actual closing fees'
        console.log(`${label} we ${result} ETH${feeStatus} on ${b.tradeCount} trades`)
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

function reportBackwards(transactions: ReportTransaction[]) {
    console.log('-----------------------Analyse backwards------------------------')
    const latest = transactions[transactions.length - 1];
    printBalance('Latest Balance', latest.balanceEth, latest.balanceStrk, latest.date);

    const points = buildBalanceTurningPoints(transactions)
    for (const p of points) {
        const label = p.direction === 'down' ? 'Down' : 'Up'
        console.log(`${label} ${formatDayMonthYear(p.date)} Eth: ${formatBig8(p.diffEth)} Strk: ${formatBig8(p.diffStrk)}`)
    }

    console.log('Total change')
    const earliest = transactions[0]
    if (earliest.balanceEth.lt(latest.balanceEth) && earliest.balanceStrk.lt(latest.balanceStrk)) {
        console.log(`Up ${formatDayMonthYear(earliest.date)} Eth: ${formatBig8(latest.balanceEth.sub(earliest.balanceEth))} Strk: ${formatBig8(latest.balanceStrk.sub(earliest.balanceStrk))}`)
    } else if (earliest.balanceEth.gt(latest.balanceEth) && earliest.balanceStrk.gt(latest.balanceStrk)) {
        console.log(`Down ${formatDayMonthYear(earliest.date)} Eth: ${formatBig8(earliest.balanceEth.sub(latest.balanceEth))} Strk: ${formatBig8(earliest.balanceStrk.sub(latest.balanceStrk))}`)
    }
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
// report: progress (raw realized balance over time, open positions factored out)
// ---------------------------------------------------------------------------

const PROGRESS_DAYS = 14

// A raw balance snapshot also contains the open (not yet matched) positions: an open eth sell
// is eth missing and strk surplus, so snapshots taken with a different open inventory can't be
// compared directly. Subtracting the open positions leaves only what closed groups produced.
function reportProgress(transactions: ReportTransaction[]) {
    console.log('-----------------------Realized progress (raw balances, no fees/conversion)------------------------')
    const { days, externalEth, externalStrk } = buildProgressSeries(transactions)
    const recent = days.slice(-PROGRESS_DAYS)
    let previous = days[days.length - recent.length - 1]
    for (const d of recent) {
        const dEth = previous ? d.realizedEth.sub(previous.realizedEth) : BigNumber.from(0)
        const dStrk = previous ? d.realizedStrk.sub(previous.realizedStrk) : BigNumber.from(0)
        console.log(`${formatDayMonthYear(d.date)} realized change Eth: ${formatBig8(dEth)} Strk: ${formatBig8(dStrk)} | realized total Eth: ${formatBig8(d.realizedEth)} Strk: ${formatBig8(d.realizedStrk)} | open Eth: ${formatBig8(d.openEth)} Strk: ${formatBig8(d.openStrk)}`)
        previous = d
    }
    const first = days[0]
    const last = days[days.length - 1]
    console.log(`Realized since ${formatDayMonthYear(first.date)} Eth: ${formatBig8(last.realizedEth.sub(first.realizedEth))} Strk: ${formatBig8(last.realizedStrk.sub(first.realizedStrk))} (excluding deposits Eth: ${formatBig8(externalEth)} Strk: ${formatBig8(externalStrk)})`)
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
    progress: { description: 'raw realized balance per day with open positions factored out (includes archived trades)', run: (_t, raw) => reportProgress(buildBackwardsTransactions(raw)) },
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