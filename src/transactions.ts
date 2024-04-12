import { Account, RpcProvider, transaction } from "starknet";
import fs from 'node:fs';
import { getBalances } from "./balances";
import { BigNumber } from "@ethersproject/bignumber";
import { TxData } from "./types";

export async function getStatus(hash: string, provider: RpcProvider) {
    return await provider.getTransactionStatus(hash)
}

export async function getBlock(provider: RpcProvider) {
    return (await provider.getBlockLatestAccepted()).block_number
}

const dataPath = process.env.TRADE_FILE

// save the transactions into a json file
async function saveTransactionData(list: TxData[]): Promise<boolean> {
    return await new Promise((resolve, reject) => {
        fs.writeFile(dataPath, JSON.stringify(list, null, '\t'), err => {
            if (err) {
                reject(err)
                return
            }
            resolve(true);
        })
    })
}

// getting the transactions from the file
export async function getTransactionData(): Promise<TxData[]> {
    return new Promise((resolve, reject) => {
        fs.readFile(dataPath, 'utf8', (err, data) => {
            if (err) {
                reject(err)
                return
            }
            if (!data) {
                reject('no data')
                return
            }
            resolve(JSON.parse(data));
        })
    })
}

// adding a transaction to the transactions file
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
        const { execution_status, finality_status } = await getStatus(latest.hash, provider)
        if (execution_status === 'SUCCEEDED' && finality_status === 'RECEIVED') {
            console.log('execution SUCCEEDED but finality is still RECEIVED')
            return { finished: false }
        }
        if (latest.status !== execution_status) {
            latest.status = execution_status
            needToSave = true
        }
        // oh no our tx got reverted, so we remove it from our list
        if (latest.status === 'REVERTED') {
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
    }
    if (needToSave) {
        await saveTransactionData(transactions)
    }
    let tx: TxData
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
        lastBlock: latest?.block,
        unMatched: transactions.filter((t) => !t.matchedBy)
    }
}