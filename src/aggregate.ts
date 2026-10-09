import fs from 'node:fs';
import { DATA_PATH } from "./transactions";

// ---------------------------------------------------------------------------
// aggregate report data: keeps historical stats for matched trade groups that
// get physically removed from the main trade file by extractMatched, plus a
// log of known external eth/strk transfers (manual top-ups) so reports can
// tell them apart from trading gains.
// ---------------------------------------------------------------------------

export type MatchedGroupSummary = {
    // hash of the closing tx of the group, used to avoid summarizing the same group twice
    closingHash: string,
    tradeCount: number,
    fromTimestamp: number,
    toTimestamp: number,
    soldEth: string,
    boughtEth: string,
    txFeesEth: string,
    failedFeesEth: string,
    closingFeeKnown?: boolean,
    closingFeeEstimated?: boolean,
}

export type ExternalTransfer = {
    timestamp: number,
    ethAmount?: string,
    strkAmount?: string,
    note?: string,
}

export type AggregateData = {
    matchedGroups: MatchedGroupSummary[],
    externalTransfers: ExternalTransfer[],
}

export const AGGREGATE_PATH = process.env.AGGREGATE_FILE || (DATA_PATH || '').replace('.json', '_aggregate.json')

export async function getAggregateData(): Promise<AggregateData> {
    return new Promise((resolve, reject) => {
        fs.readFile(AGGREGATE_PATH, 'utf8', (err, data) => {
            if (err) {
                if (err.code === 'ENOENT') {
                    resolve({ matchedGroups: [], externalTransfers: [] })
                    return
                }
                reject(err)
                return
            }
            if (!data) {
                resolve({ matchedGroups: [], externalTransfers: [] })
                return
            }
            resolve(JSON.parse(data))
        })
    })
}

export async function saveAggregateData(data: AggregateData): Promise<boolean> {
    return new Promise((resolve, reject) => {
        fs.writeFile(AGGREGATE_PATH, JSON.stringify(data, null, '\t'), err => {
            if (err) {
                reject(err)
                return
            }
            resolve(true)
        })
    })
}

// inserts new groups and refreshes existing summaries (by closingHash)
export async function upsertMatchedGroupSummaries(newGroups: MatchedGroupSummary[]): Promise<number> {
    const aggregate = await getAggregateData()
    const byClosingHash = new Map(aggregate.matchedGroups.map((group, index) => [group.closingHash, index]))
    let changed = 0
    for (const group of newGroups) {
        const index = byClosingHash.get(group.closingHash)
        if (index === undefined) {
            byClosingHash.set(group.closingHash, aggregate.matchedGroups.length)
            aggregate.matchedGroups.push(group)
        } else {
            aggregate.matchedGroups[index] = group
        }
        changed++
    }
    if (!changed) return 0
    await saveAggregateData(aggregate)
    return changed
}
