import { TxData } from "./types"

export function effectiveCounter(raw: number, now: number, lastOpening: number, decayHours: number): number {
    return Math.max(0, raw - (decayHours > 0 ? Math.floor(Math.max(0, now - lastOpening) / (decayHours * 3600000)) : 0))
}

export function getLastOpeningTimestamp(transactions: TxData[], now: number): number {
    const indices = new Map(transactions.map((t, i) => [t.hash, i]))
    for (let i = transactions.length - 1; i >= 0; i--) {
        const t = transactions[i]
        if (t.hash === 'initial' || !t.sell) continue
        // Openers point forward to their closer; closers point back to an opener.
        if (!t.matchedBy || (indices.get(t.matchedBy) ?? -1) > i)
            return t.timestamp ?? now
    }
    return 0
}
