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

// appends any groups not already recorded (by closingHash), returns how many were added
export async function appendMatchedGroupSummaries(newGroups: MatchedGroupSummary[]): Promise<number> {
    const aggregate = await getAggregateData()
    const known = new Set(aggregate.matchedGroups.map(g => g.closingHash))
    const toAdd = newGroups.filter(g => !known.has(g.closingHash))
    if (!toAdd.length) return 0
    aggregate.matchedGroups.push(...toAdd)
    await saveAggregateData(aggregate)
    return toAdd.length
}
