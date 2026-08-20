import { DATA_PATH, getTransactionData, saveTransactionData } from "./transactions";
import { BigNumber } from "@ethersproject/bignumber";
import { TxData } from "./types";


async function combine(transactions: TxData[]) {
    let didCombine = false
    transactions = transactions.reduce((list, t) => {
        if (!list.length) {
            return [t]
        } else if (t.matchedBy) {
            return [...list, t]
        }
        const last = list.findLast((lt) => !lt.matchedBy && lt.sell === t.sell)
        if (!last) {
            console.log('no last found')
            return [...list, t]
        }
        const lastRatio = BigNumber.from(last.buyAmount).div(BigNumber.from(last.sellAmount))
        const currentRatio = BigNumber.from(t.buyAmount).div(BigNumber.from(t.sellAmount))
        if (lastRatio.lt(currentRatio)) {
            return [...list, t]
        }
        console.log('combining', last.hash, 'and', t.hash, 'with ratio', lastRatio.toString(), 'and', currentRatio.toString())
        didCombine = true
        return [
            ...list.slice(0, list.length - 1),
            {
                ...t,
                buyAmount: BigNumber.from(last.buyAmount).add(t.buyAmount ?? BigNumber.from(0)).toString(),
                sellAmount: BigNumber.from(last.sellAmount).add(t.sellAmount ?? BigNumber.from(0)).toString()
            }
        ]

    }, [] as TxData[])

    return { didCombine, combinedTransactions: transactions }
}


async function loop() {
    let transactions = await getTransactionData()
    if (transactions?.length < 2) {
        console.log('no transaction done')
    }
    const first = transactions.splice(0, 1)[0]
    let didCombineTransactions = true
    while (didCombineTransactions) {
        const { didCombine, combinedTransactions } = await combine(transactions);
        transactions = combinedTransactions
        didCombineTransactions = didCombine;
        console.log('did combine', didCombine)
    }

    await saveTransactionData([first, ...transactions], DATA_PATH)
}

loop()