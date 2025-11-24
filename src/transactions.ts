import { Account, RpcProvider, SuccessfulTransactionReceiptResponse } from "starknet";
import fs from 'node:fs';
import { getBalances } from "./balances";
import { BigNumber } from "@ethersproject/bignumber";
import { FailedTransactions, TxData } from "./types";

const NOT_FOUND = 'NOT_FOUND' as const;

export async function getStatus(hash: string, provider: RpcProvider, timestamp: number) {
    try {
        return await provider.getTransactionStatus(hash);
    }
    catch (e) {
        console.log(`error getting status for tx ${hash} at ${timestamp}: ${JSON.stringify(e)}`);
        if (e.baseError && e.baseError.code === 29 && new Date().getTime() - timestamp > 1000 * 60 * 20) {
            return {
                execution_status: NOT_FOUND,
                finality_status: NOT_FOUND
            };
        }
        throw e;
    }
}

async function getFees(hash: string, provider: RpcProvider): Promise<BigNumber> {
    if (hash === 'initial')
        return BigNumber.from('0')

    try {
        const tx = await provider.getTransactionReceipt(hash)
        const value = (tx.value as SuccessfulTransactionReceiptResponse)
        return BigNumber.from(value.actual_fee.amount)
    }
    catch (e) {
        return BigNumber.from('0')
    }
}

export async function getFailedTransactions(): Promise<FailedTransactions> {
    const failedData = await readFile<FailedTransactions | undefined>(process.env.FAILED_TRADE_FILE || 'failedTrades.json', true);
    return failedData || {
        currentFailedAmmount: '0',
        failedCount: 0,
        failedHashes: []
    }
}

async function trackFailedTransaction(hash: string, provider: RpcProvider) {
    const [fees, failedTransactions] = await Promise.all([getFees(hash, provider), getFailedTransactions()]);
    return saveFailedTransactions({
        currentFailedAmmount: BigNumber.from(failedTransactions.currentFailedAmmount).add(fees).toString(),
        failedCount: failedTransactions.failedCount + 1,
        failedHashes: [...failedTransactions.failedHashes, hash]
    })
}

export async function clearFailedTransaction(): Promise<boolean> {
    const failedTransactions = await getFailedTransactions();
    return await saveFailedTransactions({
        ...failedTransactions,
        currentFailedAmmount: '0'
    })
}

async function saveFailedTransactions(failedTransactions: FailedTransactions): Promise<boolean> {
    return await saveFile(failedTransactions, process.env.FAILED_TRADE_FILE || 'failedTrades.json')
}

export async function getBlock(provider: RpcProvider) {
    return (await provider.getBlockLatestAccepted()).block_number
}

export const DATA_PATH = process.env.TRADE_FILE


async function saveFile<T>(list: T, path: string): Promise<boolean> {
    return await new Promise((resolve, reject) => {
        fs.writeFile(path, JSON.stringify(list, null, '\t'), err => {
            if (err) {
                reject(err)
                return
            }
            resolve(true);
        })
    })
}

export async function saveTransactionData(list: TxData[], path?: string): Promise<boolean> {
    return await saveFile(list, path || DATA_PATH || '')
}

async function readFile<T>(path: string, canBeUndefined = false): Promise<T> {
    return new Promise((resolve, reject) => {
        fs.readFile(path || DATA_PATH || '', 'utf8', (err, data) => {
            if (err) {
                reject(err)
                return
            }
            if (!data) {
                if (canBeUndefined)
                    resolve(undefined as unknown as T)
                reject('no data')
                return
            }
            resolve(JSON.parse(data));
        })
    })
}

export async function getTransactionData(): Promise<TxData[]> {
    return await readFile<TxData[]>(DATA_PATH || '')
}

export async function addTransaction(tx: TxData, matchedTx?: string[]) {
    const transactions = await getTransactionData()
    transactions.forEach((t) => {
        if (matchedTx?.includes(t.hash)) {
            t.matchedBy = tx.hash
        }
    })
    transactions.push(tx)
    await saveTransactionData(transactions)
}

// getting the transactions and checking them. Trying the get the latest tx that we need for trading.
export async function checkTransactions(provider: RpcProvider, account: Account) {
    const transactions = await getTransactionData()
    const latest = transactions[transactions.length - 1]
    let needToSave = false
    // we the last state of the tx was not successfull we check the state via the api
    if (latest.status !== 'SUCCEEDED') {
        const { execution_status, finality_status } = await getStatus(latest.hash, provider, latest.timestamp || 0)
        if (execution_status === 'SUCCEEDED' && finality_status === 'RECEIVED') {
            console.log('execution SUCCEEDED but finality is still RECEIVED')
            return { finished: false }
        }
        if (latest.status !== execution_status) {
            latest.status = execution_status
            needToSave = true
        }
        if (latest.status === 'REVERTED') {
            await trackFailedTransaction(latest.hash, provider)
        }
        // oh no our tx got reverted, so we remove it from our list
        if (latest.status === 'REVERTED' || latest.status === NOT_FOUND) {
            transactions.splice(transactions.length - 1, 1)
            transactions.forEach(tx => {
                if (tx.matchedBy === latest.hash) {
                    delete tx.matchedBy
                }
            })
            await saveTransactionData(transactions)
            return checkTransactions(provider, account)
        } else if (needToSave) {
            latest.block = await getBlock(provider)
        }
    }

    const finished = latest.status === 'SUCCEEDED'

    // we only need to get a tx for trading if all tx' have succeeded ... otherwise we wait.
    if (finished && !latest.balanceEth) {
        const { eth, strk } = await getBalances(provider, account)
        if (eth.toString() === "0") {
            console.log("did not get any balances")
            return {
                finished: false
            }
        }
        // we get the balance difference to the last transaction to get our transaction amounts 
        if (transactions.length > 1) {
            const prev = transactions[transactions.length - 2]
            const prevEth = BigNumber.from(prev.balanceEth)
            const prevStrk = BigNumber.from(prev.balanceStrk)
            if (prevEth.eq(eth) || prevStrk.eq(strk)) {
                console.log("no balance change so we wait")
                return {
                    finished: false
                }
            }
            if (prevEth.gt(eth)) {
                latest.sell = 'eth'
                latest.sellAmount = prevEth.sub(eth).toString()
                latest.buyAmount = strk.sub(prevStrk).toString()
            } else {
                latest.sell = 'strk'
                latest.sellAmount = prevStrk.sub(strk).toString()
                latest.buyAmount = eth.sub(prevEth).toString()
            }
        }
        latest.balanceEth = eth.toString()
        latest.balanceStrk = strk.toString()
        needToSave = true
        try {
            if (latest.matchedBy)
                await clearFailedTransaction()
        } catch (e) {
            console.log('clearFailedTransaction error', e)
        }
    }
    if (needToSave) {
        await saveTransactionData(transactions)
    }
    let tx: TxData | undefined = undefined
    if (finished && latest.balanceEth) {
        // all transactions are confirmed, so we get the most recent tx that was not filled
        for (let i = transactions.length - 1; i >= 0; i--) {
            if (!tx || !transactions[i].matchedBy) {
                tx = transactions[i]
                if (!tx.matchedBy) {
                    break
                }
            }
        }
    }

    return {
        finished,
        tx,
        latest,
        unMatched: transactions.filter((t) => !t.matchedBy)
    }
}