import fs from 'node:fs';
import path from 'node:path';
import { DATA_PATH } from "./transactions";
import { TxData } from "./types";

// loads every matched-trade archive file created by extractMatched.ts (data/<base>_matched_*.json),
// deduped by hash. These archives only contain the "opener" trades of a match group - the closing
// trade stays in the live trade file - but each opener still carries its own balance/amount snapshot.
export function loadArchivedTransactions(): TxData[] {
    if (!DATA_PATH) return []
    const dir = path.dirname(DATA_PATH)
    const base = path.basename(DATA_PATH, '.json')
    const archiveFiles = fs.readdirSync(dir)
        .filter(f => f.startsWith(`${base}_matched_`) && f.endsWith('.json'))
        .map(f => path.join(dir, f))

    const byHash = new Map<string, TxData>()
    for (const file of archiveFiles) {
        const trades: TxData[] = JSON.parse(fs.readFileSync(file, 'utf8'))
        for (const t of trades) {
            byHash.set(t.hash, t)
        }
    }
    return Array.from(byHash.values())
}
