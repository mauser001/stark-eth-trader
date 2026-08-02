import { execFile } from 'child_process';

const ethernetAdapterName = process.env.ETHERNET_ADAPTER_NAME || 'Ethernet'
const ethernetRestartCooldownMs = Number(process.env.ETHERNET_RESTART_COOLDOWN_MS || '7200000')
const ethernetRestartErrorWindowMs = Number(process.env.ETHERNET_RESTART_ERROR_WINDOW_MS || '600000')
const networkErrorCodes = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNABORTED',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT'
])
const networkErrorTextMarkers = [
    'network error',
    'fetch failed',
    'socket hang up',
    'connection reset',
    'timeout',
    'econnreset',
    'etimedout',
    'ehostunreach',
    'enetunreach'
]

let lastEthernetRestartAt = 0
let ethernetRestartInProgress = false
let networkErrorStreakStartedAt = 0

function resetNetworkErrorStreak() {
    networkErrorStreakStartedAt = 0
}

function collectErrorTokens(error: unknown, seen = new WeakSet<object>()): string[] {
    if (error === undefined || error === null) {
        return []
    }
    if (typeof error === 'string' || typeof error === 'number' || typeof error === 'boolean') {
        return [String(error)]
    }
    if (Array.isArray(error)) {
        return error.flatMap((item) => collectErrorTokens(item, seen))
    }
    if (typeof error !== 'object') {
        return [String(error)]
    }
    if (seen.has(error)) {
        return []
    }
    seen.add(error)

    const current = error as Record<string, unknown>
    const tokens: string[] = []
    for (const key of ['code', 'message', 'name', 'errno', 'type']) {
        const value = current[key]
        if (typeof value === 'string' || typeof value === 'number') {
            tokens.push(String(value))
        }
    }
    for (const key of ['cause', 'baseError', 'error', 'reason']) {
        if (current[key] !== undefined) {
            tokens.push(...collectErrorTokens(current[key], seen))
        }
    }
    return tokens
}

function shouldRestartEthernetAdapter(error: unknown): boolean {
    const tokens = collectErrorTokens(error)
    if (!tokens.length) {
        return false
    }
    if (tokens.some((token) => networkErrorCodes.has(token.toUpperCase()))) {
        return true
    }
    const normalized = tokens.join(' ').toLowerCase()
    return networkErrorTextMarkers.some((marker) => normalized.includes(marker))
}

function restartEthernetAdapter(adapterName: string): Promise<void> {
    const escapedAdapterName = adapterName.replace(/'/g, "''")
    const command = `Restart-NetAdapter -Name '${escapedAdapterName}' -Confirm:$false`
    return new Promise((resolve, reject) => {
        execFile(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
            (error, stdout, stderr) => {
                if (stdout?.trim()) {
                    console.warn('Restart-NetAdapter stdout:', stdout.trim())
                }
                if (stderr?.trim()) {
                    console.warn('Restart-NetAdapter stderr:', stderr.trim())
                }
                if (error) {
                    reject(error)
                    return
                }
                resolve()
            }
        )
    })
}

export async function restartEthernetAdapterIfNetworkIssue(error: unknown) {
    if (process.platform !== 'win32' || !shouldRestartEthernetAdapter(error)) {
        return
    }
    const now = Date.now()
    if (!networkErrorStreakStartedAt) {
        networkErrorStreakStartedAt = now
        console.warn(`Detected network transport error. Starting sustained error timer (${Math.ceil(ethernetRestartErrorWindowMs / 1000)}s) before adapter restart`)
        return
    }
    const streakDuration = now - networkErrorStreakStartedAt
    if (streakDuration < ethernetRestartErrorWindowMs) {
        console.warn(`Network transport errors still ongoing. Waiting ${Math.ceil((ethernetRestartErrorWindowMs - streakDuration) / 1000)}s more before adapter restart`)
        return
    }
    if (ethernetRestartInProgress) {
        console.warn('Ethernet adapter restart skipped: restart already in progress')
        return
    }
    const elapsed = now - lastEthernetRestartAt
    if (elapsed < ethernetRestartCooldownMs) {
        console.warn(`Ethernet adapter restart skipped: cooldown active (${Math.ceil((ethernetRestartCooldownMs - elapsed) / 1000)}s left)`)
        return
    }

    ethernetRestartInProgress = true
    console.warn(`Detected network transport error. Restarting Ethernet adapter "${ethernetAdapterName}"...`)
    try {
        await restartEthernetAdapter(ethernetAdapterName)
        lastEthernetRestartAt = Date.now()
        resetNetworkErrorStreak()
        console.warn(`Ethernet adapter "${ethernetAdapterName}" restart command completed`)
    } finally {
        ethernetRestartInProgress = false
    }
}

export function notifyRunSucceeded() {
    resetNetworkErrorStreak()
}
