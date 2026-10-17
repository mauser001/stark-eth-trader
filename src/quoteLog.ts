import fs from "node:fs"
import path from "node:path"
import { EthOrStrk } from "./types"

// Optional market log for simulations: one csv row per run with the avnu quote ratios of both directions
// (strk per eth * RATIO_MULTI, before fees). Enabled by setting QUOTE_LOG_DIR, one file per month (UTC)
const HEADER = 'ts,strkToEth,ethToStrk\n'

type PendingRow = { ts: number, strkToEth?: string, ethToStrk?: string }
let pending: PendingRow | undefined

export function getQuoteLogDir(): string | undefined {
    const dir = process.env.QUOTE_LOG_DIR?.trim()
    return dir ? dir : undefined
}

// keeps the first quote ratio per direction of the current run (later combined re-quotes use other amounts)
export function recordQuoteRatio(sell: EthOrStrk, ratio: string, now: number = Date.now()) {
    if (!getQuoteLogDir()) return
    if (!pending) pending = { ts: now }
    if (sell === 'strk') pending.strkToEth ??= ratio
    else pending.ethToStrk ??= ratio
}

export function getQuoteLogFile(dir: string, ts: number): string {
    const d = new Date(ts)
    return path.join(dir, `quotes-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.csv`)
}

// appends the pending row (if any quote was recorded); a failing write must never stop trading
export function flushQuoteLog() {
    const row = pending
    pending = undefined
    const dir = getQuoteLogDir()
    if (!row || !dir) return
    try {
        const file = getQuoteLogFile(dir, row.ts)
        fs.mkdirSync(dir, { recursive: true })
        const line = `${row.ts},${row.strkToEth ?? ''},${row.ethToStrk ?? ''}\n`
        fs.appendFileSync(file, fs.existsSync(file) ? line : HEADER + line)
    } catch (e) {
        console.warn('quote log write failed: ', e)
    }
}
