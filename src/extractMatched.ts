import { DATA_PATH, getTransactionData, saveTransactionData } from "./transactions";

async function extractMatched() {
    const transactions = await getTransactionData()
    if (transactions?.length < 2) {
        console.log('no transaction done')
    }

    const matched = []
    const unmatched = []
    const first = transactions.splice(0, 1)[0]
    transactions.forEach((t) => {
        if (t.matchedBy) {
            matched.push(t)
        } else {
            unmatched.push(t)
        }
    })

    console.log(`we have ${matched.length} matchted and ${unmatched.length} unmatched transactions`)
    const now = new Date()
    const matchedPath = DATA_PATH.replace('.json', `_matched_${now.getFullYear()}_${now.getMonth()}_${now.getDate()}.json`)
    await saveTransactionData(matched, matchedPath)
    await saveTransactionData([first, ...unmatched])
}

extractMatched()