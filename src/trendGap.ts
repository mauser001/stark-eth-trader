import { BigNumber } from "@ethersproject/bignumber"
import { EthOrStrk, TxData } from "./types"
import { getRatio } from "./math"

// trade ratio (strk per eth * RATIO_MULTI) of one of our trades, kept separately from the trade file so
// archiving matched trades (extractMatched) doesn't remove the history the trend gap needs
export type RatioPoint = { hash: string, timestamp: number, sell: EthOrStrk, ratio: number }

// refRatio: median ratio of our trades at least `days` old, mult: opening-gap multiplier in an adverse trend
export type TrendGap = { refRatio: number, mult: number, hourlyVol: number }

export type TrendGapOptions = {
    days: number,
    // relative ratio move (e.g. 0.1 = 10%) that counts as an adverse trend
    move: number,
    volK: number,
    volDays: number,
    // cap for the multiplier, <= 0 or undefined = no cap
    maxMult?: number,
    // base opening gap as a fraction (TRADE_DIFFERENCE_1000 / 1000)
    baseDifference: number
}

const DAY = 86_400_000
// a trade whose ratio is this far off its same-direction neighbours on both sides is treated as a data glitch
const SPIKE = 0.1
const REF_TRADES = 5

export function toRatioPoints(transactions: TxData[]): RatioPoint[] {
    const points: RatioPoint[] = []
    for (const t of transactions) {
        if (t.hash === 'initial' || !t.sell || !t.sellAmount || !t.buyAmount || !t.timestamp || t.status === 'REVERTED') continue
        const sellAmount = BigNumber.from(t.sellAmount)
        const buyAmount = BigNumber.from(t.buyAmount)
        if (sellAmount.lte(0) || buyAmount.lte(0)) continue
        const ratio = t.sell === 'eth' ? getRatio(buyAmount, sellAmount) : getRatio(sellAmount, buyAmount)
        if (ratio.lte(0)) continue
        points.push({ hash: t.hash, timestamp: t.timestamp, sell: t.sell, ratio: Number(ratio.toString()) })
    }
    return points.sort((a, b) => a.timestamp - b.timestamp)
}

export function mergeRatioPoints(...lists: RatioPoint[][]): RatioPoint[] {
    const byHash = new Map<string, RatioPoint>()
    for (const list of lists) for (const p of list) byHash.set(p.hash, p)
    return [...byHash.values()].sort((a, b) => a.timestamp - b.timestamp)
}

// keeps everything within keepDays plus the newest REF_TRADES older points (trend reference after a long pause)
export function pruneRatioPoints(points: RatioPoint[], now: number, keepDays: number): RatioPoint[] {
    const cutoff = now - keepDays * DAY
    const older = points.filter((p) => p.timestamp < cutoff).slice(-REF_TRADES)
    return [...older, ...points.filter((p) => p.timestamp >= cutoff)]
}

function median(values: number[]): number {
    const s = [...values].sort((a, b) => a - b)
    const mid = s.length >> 1
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// drops isolated glitches: a point off by more than SPIKE from the median of its 2 previous and of its 2 next
// same-direction trades. A real jump only differs from one side, so it is kept
export function removeSpikes(points: RatioPoint[]): RatioPoint[] {
    const drop = new Set<RatioPoint>()
    for (const sell of ['eth', 'strk'] as EthOrStrk[]) {
        const series = points.filter((p) => p.sell === sell)
        series.forEach((p, i) => {
            const prev = series.slice(Math.max(0, i - 2), i).map((x) => x.ratio)
            const next = series.slice(i + 1, i + 3).map((x) => x.ratio)
            if (!prev.length || !next.length) return
            if (Math.abs(Math.log(p.ratio / median(prev))) > SPIKE && Math.abs(Math.log(p.ratio / median(next))) > SPIKE)
                drop.add(p)
        })
    }
    return points.filter((p) => !drop.has(p))
}

// hourly volatility of the eth/strk ratio from our own trades. Steps are only taken between trades of the same
// sell direction: eth and strk sells at the same market price differ by the round-trip fees, which would inflate the vol
export function getHourlyVol(points: RatioPoint[], now: number, volDays: number): number | undefined {
    const variances: number[] = []
    for (const sell of ['eth', 'strk'] as EthOrStrk[]) {
        const series = points.filter((p) => p.sell === sell && p.timestamp <= now)
        const first = series.findIndex((p) => p.timestamp >= now - volDays * DAY)
        if (first < 0) continue
        const window = series.slice(Math.max(0, first - 1))
        if (window.length < 3) continue
        let sum = 0
        for (let i = 1; i < window.length; i++) {
            const step = Math.log(window[i].ratio / window[i - 1].ratio)
            sum += step * step
        }
        variances.push(sum / (volDays * 24))
    }
    if (!variances.length) return
    return Math.sqrt(variances.reduce((a, b) => a + b, 0) / variances.length)
}

export function getTrendGap(points: RatioPoint[], now: number, options: TrendGapOptions): TrendGap | undefined {
    if (options.days <= 0 || options.volK <= 0) return
    const clean = removeSpikes(points.filter((p) => p.timestamp <= now))
    const reference = clean.filter((p) => p.timestamp <= now - options.days * DAY).slice(-REF_TRADES)
    if (!reference.length) return
    const hourlyVol = getHourlyVol(clean, now, options.volDays)
    if (hourlyVol === undefined) return
    return {
        refRatio: median(reference.map((p) => p.ratio)),
        mult: Math.max(1, Math.min(options.maxMult && options.maxMult > 0 ? options.maxMult : Infinity, options.volK * hourlyVol / options.baseDifference)),
        hourlyVol
    }
}

// widens the opening gap when the ratio moved more than `move` against the coin this trade would buy:
// a rising ratio (more strk per eth) means strk fell, so selling eth (buying strk) needs the wider gap, and vice versa
export function applyTrendGap(sell: EthOrStrk, openDifference: BigNumber, trendGap: TrendGap | undefined, currentRatio: BigNumber, move: number): { difference: BigNumber, move?: number } {
    if (!trendGap || currentRatio.lte(0)) return { difference: openDifference }
    const ratioMove = Math.log(Number(currentRatio.toString()) / trendGap.refRatio)
    const adverse = sell === 'eth' ? ratioMove > move : ratioMove < -move
    if (!adverse || trendGap.mult <= 1) return { difference: openDifference, move: ratioMove }
    return { difference: openDifference.mul(Math.round(trendGap.mult * 100)).div(100), move: ratioMove }
}
