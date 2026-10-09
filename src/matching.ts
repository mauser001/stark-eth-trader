import { BigNumber } from "@ethersproject/bignumber";
import { TxData } from "./types";
import { AggregateData } from "./aggregate";

// ---------------------------------------------------------------------------
// shared trade/match-group helpers used by both reporting.ts and extractMatched.ts
// ---------------------------------------------------------------------------

export interface ReportTransaction {
    hash: string
    date: Date
    isSellingEth: boolean,
    buyAmount: BigNumber,
    sellAmount: BigNumber,
    actualFees?: BigNumber,
    failedFeesIncluded?: BigNumber,
    balanceEth: BigNumber,
    balanceStrk: BigNumber,
    matchedBy?: string
}

export function toReportTransactions(rawTransactions: TxData[]): ReportTransaction[] {
    return rawTransactions
        .filter(t => t.timestamp && t.buyAmount && t.sellAmount && t.balanceEth && t.balanceStrk)
        .map(t => ({
            hash: t.hash,
            date: new Date(t.timestamp ?? 0),
            isSellingEth: t.sell === 'eth',
            buyAmount: BigNumber.from(t.buyAmount),
            sellAmount: BigNumber.from(t.sellAmount),
            actualFees: t.actualFees ? BigNumber.from(t.actualFees) : undefined,
            failedFeesIncluded: t.failedFeesIncluded ? BigNumber.from(t.failedFeesIncluded) : undefined,
            balanceEth: BigNumber.from(t.balanceEth),
            balanceStrk: BigNumber.from(t.balanceStrk),
            matchedBy: t.matchedBy
        }))
        .sort((a, b) => a.date.getTime() - b.date.getTime())
}

export interface MatchGroup {
    hash: string
    trades: ReportTransaction[]
}

// matchedBy links trades in both directions (closed trades point to the closing trade and the
// closing trade points back to the first trade it matched), so we build the match groups with
// union-find - otherwise every group would be counted once per direction
export function getMatchGroups(transactions: ReportTransaction[]): { groups: MatchGroup[], matchedHashes: Set<string> } {
    const byHash = new Map(transactions.map(t => [t.hash, t]))
    const parent = new Map<string, string>()
    const findRoot = (hash: string): string => {
        let root = hash
        while (parent.get(root) !== root) root = parent.get(root)!
        let cur = hash
        while (parent.get(cur) !== cur) {
            const next = parent.get(cur)!
            parent.set(cur, root)
            cur = next
        }
        return root
    }
    const union = (a: string, b: string) => {
        if (!parent.has(a)) parent.set(a, a)
        if (!parent.has(b)) parent.set(b, b)
        parent.set(findRoot(a), findRoot(b))
    }
    for (const t of transactions) {
        if (t.matchedBy && t.matchedBy !== 'initial' && byHash.has(t.matchedBy)) union(t.hash, t.matchedBy)
    }
    const groupsByRoot = new Map<string, ReportTransaction[]>()
    for (const t of transactions) {
        if (!parent.has(t.hash)) continue
        const root = findRoot(t.hash)
        const group = groupsByRoot.get(root) ?? []
        group.push(t)
        groupsByRoot.set(root, group)
    }
    const matchedHashes = new Set<string>()
    const groups: MatchGroup[] = []
    for (const trades of groupsByRoot.values()) {
        if (trades.length < 2) continue
        trades.forEach(t => matchedHashes.add(t.hash))
        // the newest trade of the group is the one that closed it
        groups.push({ hash: trades[trades.length - 1].hash, trades })
    }
    groups.sort((a, b) =>
        a.trades[a.trades.length - 1].date.getTime() - b.trades[b.trades.length - 1].date.getTime())
    return { groups, matchedHashes }
}

function feeInEth(trade: ReportTransaction, feeStrk: BigNumber): BigNumber {
    if (feeStrk.isZero()) return BigNumber.from(0)
    const actualFees = trade.actualFees ?? BigNumber.from(0)
    return trade.isSellingEth
        ? trade.sellAmount.mul(feeStrk).div(trade.buyAmount.add(actualFees))
        : feeStrk.mul(trade.buyAmount).div(trade.sellAmount.sub(actualFees))
}

const MAX_ESTIMATED_FEE_STRK = BigNumber.from("1000000000000000000")

// Missing historical fees use the average recorded fee, capped at 1 STRK to avoid
// letting exceptional or malformed records create implausible fee estimates.
export function getAverageActualFeesStrk(transactions: ReportTransaction[]): BigNumber | undefined {
    const known = transactions.map(t => t.actualFees).filter((f): f is BigNumber => !!f && !f.isZero())
    if (!known.length) return undefined
    const average = known.reduce((sum, fee) => sum.add(fee), BigNumber.from(0)).div(known.length)
    return average.gt(MAX_ESTIMATED_FEE_STRK) ? MAX_ESTIMATED_FEE_STRK : average
}

function getEthPerStrkFromOpener(trades: ReportTransaction[]): BigNumber | undefined {
    for (let i = trades.length - 2; i >= 0; i--) {
        const opener = trades[i]
        const actualFees = opener.actualFees ?? BigNumber.from(0)
        const ethAmount = opener.isSellingEth ? opener.sellAmount : opener.buyAmount
        const strkAmount = opener.isSellingEth
            ? opener.buyAmount.add(actualFees)
            : opener.sellAmount.sub(actualFees)
        if (ethAmount.isZero() || strkAmount.lte(0)) continue
        return ethAmount.mul(BigNumber.from(10).pow(18)).div(strkAmount)
    }
    return undefined
}

function closingFeeInEth(trades: ReportTransaction[], feeStrk: BigNumber): BigNumber {
    if (feeStrk.isZero()) return BigNumber.from(0)
    const ethPerStrk = getEthPerStrkFromOpener(trades)
    if (!ethPerStrk) return BigNumber.from(0)
    return feeStrk.mul(ethPerStrk).div(BigNumber.from(10).pow(18))
}

export interface MatchGroupTotals {
    soldEth: BigNumber
    boughtEth: BigNumber
    txFeesEth: BigNumber
    closingFeeKnown: boolean
    closingFeeEstimated: boolean
    // Kept for diagnostics/archive data, but excluded from matched P&L.
    failedFeesEth: BigNumber
}

export function computeMatchGroupTotals(trades: ReportTransaction[], fallbackFeeStrk?: BigNumber): MatchGroupTotals {
    let soldEth = BigNumber.from(0)
    let boughtEth = BigNumber.from(0)
    let failedFeesEth = BigNumber.from(0)
    for (const t of trades) {
        if (t.isSellingEth) soldEth = soldEth.add(t.sellAmount)
        else boughtEth = boughtEth.add(t.buyAmount)
        failedFeesEth = failedFeesEth.add(feeInEth(t, t.failedFeesIncluded ?? BigNumber.from(0)))
    }
    const closingTrade = trades[trades.length - 1]
    // Earlier-leg fees are already reflected in the balance-difference amounts; only the
    // closing fee is an additional cost to subtract from the group's ETH result.
    const closingFeeKnown = closingTrade.actualFees !== undefined
    const closingFeeEstimated = !closingFeeKnown && fallbackFeeStrk !== undefined
    const closingFeeStrk = closingTrade.actualFees ?? (fallbackFeeStrk ?? BigNumber.from(0))
    const txFeesEth = closingFeeInEth(trades, closingFeeStrk)
    return { soldEth, boughtEth, txFeesEth, closingFeeKnown, closingFeeEstimated, failedFeesEth }
}

// ---------------------------------------------------------------------------
// shared helpers for the webapp report + generateWebStats seed script
// ---------------------------------------------------------------------------

// local day key (YYYY-MM-DD) used to bucket balances/matched-groups per day
export function dayKey(timestamp: number): string {
    const d = new Date(timestamp)
    return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`
}

export interface MatchedEntry {
    date: Date
    netEth: BigNumber
    tradeCount: number
    unknownClosingFeeCount: number
    estimatedClosingFeeCount: number
}

// combines still-archived groups (from aggregate.ts) with groups still present in the live file
// into one list of closed positions, each with its closing date, net gain/loss and trade count
export function buildMatchedEntries(transactions: ReportTransaction[], aggregate: AggregateData, fallbackFeeStrk?: BigNumber): MatchedEntry[] {
    const entries: MatchedEntry[] = aggregate.matchedGroups.map(g => ({
        date: new Date(g.toTimestamp),
        netEth: BigNumber.from(g.boughtEth).sub(g.soldEth).sub(
            g.closingFeeKnown === true || g.closingFeeEstimated === true ? g.txFeesEth : 0),
        tradeCount: g.tradeCount,
        unknownClosingFeeCount: g.closingFeeKnown === true || g.closingFeeEstimated === true ? 0 : 1,
        estimatedClosingFeeCount: g.closingFeeEstimated === true ? 1 : 0
    }))
    const { groups } = getMatchGroups(transactions)
    for (const { trades } of groups) {
        const { soldEth, boughtEth, txFeesEth, closingFeeKnown, closingFeeEstimated } = computeMatchGroupTotals(trades, fallbackFeeStrk)
        entries.push({
            date: trades[trades.length - 1].date,
            netEth: boughtEth.sub(soldEth).sub(txFeesEth),
            tradeCount: trades.length,
            unknownClosingFeeCount: closingFeeKnown || closingFeeEstimated ? 0 : 1,
            estimatedClosingFeeCount: closingFeeEstimated ? 1 : 0
        })
    }
    return entries.sort((a, b) => a.date.getTime() - b.date.getTime())
}

// ---------------------------------------------------------------------------
// shared helper: webapp "last 100 trades" list - only genuinely open trades
// (never matched) and the closing trade of each match group (with the group's
// date range / trade count attached); intermediate "opener" trades that got
// absorbed into a closed group are left out entirely
// ---------------------------------------------------------------------------

export interface WebTradeEntry {
    hash: string
    timestamp: number
    sell: 'eth' | 'strk'
    sellAmount: string
    buyAmount: string
    actualFees?: string
    netEth?: string
    closingFeeKnown?: boolean
    closingFeeEstimated?: boolean
    status: 'open' | 'closed'
    fromTimestamp?: number
    toTimestamp?: number
    tradeCount?: number
}

export function buildWebTradeEntries(transactions: ReportTransaction[], fallbackFeeStrk?: BigNumber): WebTradeEntry[] {
    const { groups, matchedHashes } = getMatchGroups(transactions)
    const groupByClosingHash = new Map(groups.map(g => [g.hash, g]))

    return transactions
        .filter(t => !matchedHashes.has(t.hash) || groupByClosingHash.has(t.hash))
        .map(t => {
            const group = groupByClosingHash.get(t.hash)
            const totals = group ? computeMatchGroupTotals(group.trades, fallbackFeeStrk) : undefined
            // the closing trade itself doesn't count as one of the "matched" trades it closed
            const openers = group ? group.trades.slice(0, -1) : undefined
            return {
                hash: t.hash,
                timestamp: t.date.getTime(),
                sell: t.isSellingEth ? 'eth' : 'strk',
                sellAmount: t.sellAmount.toString(),
                buyAmount: t.buyAmount.toString(),
                actualFees: t.actualFees?.toString(),
                netEth: totals ? totals.boughtEth.sub(totals.soldEth).sub(totals.txFeesEth).toString() : undefined,
                closingFeeKnown: totals?.closingFeeKnown,
                closingFeeEstimated: totals?.closingFeeEstimated,
                status: group ? 'closed' : 'open',
                fromTimestamp: openers?.length ? openers[0].date.getTime() : undefined,
                toTimestamp: openers?.length ? openers[openers.length - 1].date.getTime() : undefined,
                tradeCount: openers ? openers.length : undefined
            } as WebTradeEntry
        })
}

// hashes of "opener" trades that get absorbed into the given closing group (i.e. every trade in
// the group except the closer itself) - used to drop them from the webapp's stored trade list
// when a group closes, since they no longer count as their own open/closed entry
export function openerHashesOf(group: MatchGroup): string[] {
    return group.trades.slice(0, -1).map(t => t.hash)
}

// ---------------------------------------------------------------------------
// shared helper: balance "turning points" for the webapp balances chart - the
// same direction-change detection used by the console "backwards" report
// ---------------------------------------------------------------------------

export interface BalanceTurningPoint {
    date: Date
    direction: 'up' | 'down'
    diffEth: BigNumber
    diffStrk: BigNumber
    balanceEth: BigNumber
    balanceStrk: BigNumber
}

// walking back from the latest trade, records a point every time the balance as a whole (both
// eth and strk) reversed direction since the previous recorded point - same logic the console
// "backwards" report uses. Points stay newest-first to match the backwards walk.
export function buildBalanceTurningPoints(transactions: ReportTransaction[]): BalanceTurningPoint[] {
    if (transactions.length < 2) return []
    const points: BalanceTurningPoint[] = []
    let compare = transactions[transactions.length - 1]
    for (let i = transactions.length - 2; i >= 0; i--) {
        const t = transactions[i]
        if (t.balanceEth.gt(compare.balanceEth) && t.balanceStrk.gt(compare.balanceStrk)) {
            points.push({ date: t.date, direction: 'down', diffEth: t.balanceEth.sub(compare.balanceEth), diffStrk: t.balanceStrk.sub(compare.balanceStrk), balanceEth: t.balanceEth, balanceStrk: t.balanceStrk })
            compare = t
        } else if (t.balanceEth.lt(compare.balanceEth) && t.balanceStrk.lt(compare.balanceStrk)) {
            points.push({ date: t.date, direction: 'up', diffEth: compare.balanceEth.sub(t.balanceEth), diffStrk: compare.balanceStrk.sub(t.balanceStrk), balanceEth: t.balanceEth, balanceStrk: t.balanceStrk })
            compare = t
        }
    }
    return points
}
