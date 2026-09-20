import { ExternalTransfer, getAggregateData, saveAggregateData } from "./aggregate";
import { BigNumber } from "@ethersproject/bignumber";

// records a manual eth/strk deposit (e.g. topping up the wallet) so report gain/loss calculations
// (reportOverview) can exclude it from trading profit.
// usage: npm run add-transfer-prod -- <ethAmount|-> <strkAmount|-> [note...]
// amounts are in wei (18 decimals), use '-' to omit one of them, timestamp defaults to now.
async function addTransfer() {
    const [ethArg, strkArg, ...noteParts] = process.argv.slice(2)
    if (!ethArg || !strkArg) {
        console.log('usage: npm run add-transfer-prod -- <ethAmount|-> <strkAmount|-> [note...]')
        console.log('amounts are in wei (18 decimals); use - to omit eth or strk')
        return
    }
    const transfer: ExternalTransfer = {
        timestamp: Date.now(),
        ethAmount: ethArg === '-' ? undefined : BigNumber.from(ethArg).toString(),
        strkAmount: strkArg === '-' ? undefined : BigNumber.from(strkArg).toString(),
        note: noteParts.join(' ') || undefined,
    }
    const aggregate = await getAggregateData()
    aggregate.externalTransfers.push(transfer)
    await saveAggregateData(aggregate)
    console.log('recorded external transfer', transfer)
}

addTransfer()
