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

// actualFees is only tracked from a certain point onward, so older trades without it would
// otherwise be treated as fee-free and understate the fees paid - fall back to an average instead
export function getAverageActualFeesStrk(transactions: ReportTransaction[]): BigNumber | undefined {
    const known = transactions.map(t => t.actualFees).filter((f): f is BigNumber => !!f && !f.isZero())
    if (!known.length) return undefined
    return known.reduce((sum, f) => sum.add(f), BigNumber.from(0)).div(known.length)
}

function actualFeesStrk(trade: ReportTransaction, fallbackFeeStrk?: BigNumber): BigNumber {
    return trade.actualFees ?? fallbackFeeStrk ?? BigNumber.from(0)
}

export interface MatchGroupTotals {
    soldEth: BigNumber
    boughtEth: BigNumber
    txFeesEth: BigNumber
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
    const txFeesEth = closingTrade.isSellingEth
        ? feeInEth(closingTrade, actualFeesStrk(closingTrade, fallbackFeeStrk))
        : trades.slice(0, -1).reduce((total, trade) =>
            total.add(feeInEth(trade, actualFeesStrk(trade, fallbackFeeStrk))), BigNumber.from(0))
    return { soldEth, boughtEth, txFeesEth, failedFeesEth }
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
}

// combines still-archived groups (from aggregate.ts) with groups still present in the live file
// into one list of closed positions, each with its closing date, net gain/loss and trade count
export function buildMatchedEntries(transactions: ReportTransaction[], aggregate: AggregateData, fallbackFeeStrk?: BigNumber): MatchedEntry[] {
    const entries: MatchedEntry[] = aggregate.matchedGroups.map(g => ({
        date: new Date(g.toTimestamp),
        netEth: BigNumber.from(g.boughtEth).sub(g.soldEth).sub(g.txFeesEth).sub(g.failedFeesEth),
        tradeCount: g.tradeCount
    }))
    const { groups } = getMatchGroups(transactions)
    for (const { trades } of groups) {
        const { soldEth, boughtEth, txFeesEth, failedFeesEth } = computeMatchGroupTotals(trades, fallbackFeeStrk)
        entries.push({
            date: trades[trades.length - 1].date,
            netEth: boughtEth.sub(soldEth).sub(txFeesEth).sub(failedFeesEth),
            tradeCount: trades.length
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
                netEth: totals ? totals.boughtEth.sub(totals.soldEth).sub(totals.txFeesEth).sub(totals.failedFeesEth).toString() : undefined,
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
// "backwards" report uses, returned in chronological order instead of being logged directly
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
    return points.reverse()
}
