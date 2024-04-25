import { formatEther, parseEther } from "ethers";
import { DATA_PATH, getTransactionData, saveTransactionData } from "./transactions";
import { BigNumber } from "@ethersproject/bignumber";
import { TxData } from "./types";

const sortT = (a: TxData, b: TxData) => {
    const ratioA = BigNumber.from(a.buyAmount).mul(1000).div(BigNumber.from(a.sellAmount))
    const ratioB = BigNumber.from(b.buyAmount).mul(1000).div(BigNumber.from(b.sellAmount))
    const res = ratioA.gt(ratioB) ? 1 : -1
    const multi = a.sell === 'eth' ? 1 : -1
    return res * multi
}


async function sortTrades() {
    let transactions = await getTransactionData()
    if (transactions?.length < 2) {
        console.log('no transaction done')
    }
    const first = transactions.splice(0, 1)[0]
    transactions = transactions.sort(sortT)

    const now = new Date()
    await saveTransactionData([first, ...transactions], DATA_PATH.replace('.json', '_test.json'))
}

sortTrades()