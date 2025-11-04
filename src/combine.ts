import { DATA_PATH, getTransactionData, saveTransactionData } from "./transactions";
import { BigNumber } from "@ethersproject/bignumber";


async function combine() {
    let transactions = await getTransactionData()
    if (transactions?.length < 2) {
        console.log('no transaction done')
    }
    const first = transactions.splice(0, 1)[0]
    transactions = transactions.reduce((list, t) => {
        if (!list.length) {
            return [t]
        }
        const last = list[list.length - 1]
        const lastRatio = BigNumber.from(last.buyAmount).div(BigNumber.from(last.sellAmount))
        const currentRatio = BigNumber.from(t.buyAmount).div(BigNumber.from(t.sellAmount))
        if (lastRatio.lt(currentRatio)) {
            return [...list, t]
        }
        return [
            ...list.slice(0, list.length - 1),
            {
                ...t,
                buyAmount: BigNumber.from(last.buyAmount).add(t.buyAmount).toString(),
                sellAmount: BigNumber.from(last.sellAmount).add(t.sellAmount).toString()
            }
        ]

    }, [])

    const now = new Date()
    await saveTransactionData([first, ...transactions], DATA_PATH)
}

combine()