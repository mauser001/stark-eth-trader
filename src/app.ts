import {
    AvnuOptions,
    quoteToCalls,
} from '@avnu/avnu-sdk';
import { constants, provider } from 'starknet'
import { getBestRatio, getQuote } from './quote';
import { BigNumber } from '@ethersproject/bignumber';
import { getAccount } from './account';
import { addTransaction, checkTransactions, getBlock, getFailedTransactions } from './transactions';
import { getMaxTotalFee, getRatio, serializeResourceBounds } from './math';
import { FEE_BUFFER_1000, MAX_GAS_FEES, MIN_SEL_AMOUNT_ETH, MIN_SEL_AMOUNT_STRK, SELL_PERCENT, TIP } from './conts';
import { QuoteData } from './types';
import { notifyRunSucceeded, restartEthernetAdapterIfNetworkIssue } from './ethernet';

const useTestnet = process.env.USE_TESTNET === 'true'
const chainId = useTestnet ? constants.StarknetChainId.SN_SEPOLIA : constants.StarknetChainId.SN_MAIN
const nodeUrl = process.env.NODE_RPC || provider.getDefaultNodeUrl(useTestnet ? constants.NetworkName.SN_SEPOLIA : constants.NetworkName.SN_MAIN)
const avnuOptions: AvnuOptions = { baseUrl: useTestnet ? 'https://goerli.api.avnu.fi' : 'https://starknet.api.avnu.fi' }
let latestBlock = 0

async function run() {
    console.log(`${new Date().toLocaleString()} run useTestnet: ${useTestnet}, chainId: ${chainId}`)
    // Get account
    const { account, provider } = await getAccount({ chainId, nodeUrl })

    // First let's get the latest transactions
    const { finished, tx, unMatched, latest, maxFee } = await checkTransactions(provider, account)
    if (!finished || !tx) {
        return
    }
    if (!latestBlock || latestBlock <= (latest?.block ?? 0) + 1) {
        latestBlock = await getBlock(provider)
        if (latest?.block && latestBlock <= latest.block) {
            console.log('we need to wait for the next block after', latest.block)
            return
        }
    }
    const { currentFailedAmmount } = await getFailedTransactions()
    const failedFees = BigNumber.from(currentFailedAmmount)

    console.log('lets check tx', latestBlock, tx.block, tx.hash, tx.sell)
    // take the balances ether from the last tx or from the initial balance
    let eth: BigNumber, strk: BigNumber
    const isInitial = tx.matchedBy === 'initial'
    if (isInitial) {
        eth = BigNumber.from(tx.balanceEth)
        strk = BigNumber.from(tx.balanceStrk)
    } else {
        eth = tx.sell === 'eth' ? BigNumber.from(tx.sellAmount) : BigNumber.from(tx.buyAmount)
        strk = tx.sell === 'strk' ? BigNumber.from(tx.sellAmount) : BigNumber.from(tx.buyAmount)
    }
    // ratio of the open tx we'd directly match, used only when we try to fill that exact tx
    const matchRatio = getRatio(strk, eth)
    // Prefer open trades for the ratio; only use the latest trade when no open trades exist.
    const ratioTxs = unMatched.length ? unMatched : [latest]

    // If we have an open unmatched tx where we sold eth and try to get more. If we have no open tx where we sold eth we we try to sell a defined percentage
    const isEthMatch = !tx.matchedBy && tx.sell === 'eth'
    const sellStrk = isEthMatch ? BigNumber.from(tx.buyAmount) : getSellAmount(BigNumber.from(latest.balanceStrk), SELL_PERCENT, MIN_SEL_AMOUNT_STRK)
    const strkRatio = isEthMatch ? matchRatio : getBestRatio('strk', ratioTxs) ?? matchRatio
    let quote: QuoteData | undefined = undefined;
    if (sellStrk)
        quote = await getQuote('strk', sellStrk, account, avnuOptions, strkRatio, tx, unMatched, failedFees, maxFee)
    else
        console.log('Not enough strk balance: ', latest.balanceStrk)
    if (!quote?.quote) {
        // if we don't find a good quote for strk we try to get eth for a good price
        const isStrkMatch = !tx.matchedBy && tx.sell === 'strk'
        const sellEth = isStrkMatch ? BigNumber.from(tx.buyAmount) : getSellAmount(BigNumber.from(latest.balanceEth), SELL_PERCENT, MIN_SEL_AMOUNT_ETH)
        const ethRatio = isStrkMatch ? matchRatio : getBestRatio('eth', ratioTxs) ?? matchRatio
        if (sellEth)
            quote = await getQuote('eth', sellEth, account, avnuOptions, ethRatio, tx, unMatched, failedFees, maxFee)
        else
            console.log('Not enough ethe balance: ', latest.balanceStrk)
    }

    if (quote?.quote) {
        console.log("We found a good trade matching: ", quote.sell, quote.matchedTx?.join(","), BigNumber.from(quote.quote.sellAmount).toString(), BigNumber.from(quote.quote.buyAmount).toString(), BigNumber.from(quote.quote.gasFees).toString())

        const { calls } = await quoteToCalls({ quoteId: quote.quote.quoteId, takerAddress: account.address, slippage: quote.quote.estimatedSlippage || 0.005, executeApprove: true }, avnuOptions)
        const estimate = await account.estimateInvokeFee(calls, { tip: TIP })
        const maxTotalFee = BigNumber.from(getMaxTotalFee(estimate.resourceBounds, TIP).toString())
        console.log(`estimated max total fee: ${maxTotalFee.toString()} FRI, our calculated fee was: ${quote.fees?.toString()}`)
        if (MAX_GAS_FEES.gt(0) && maxTotalFee.gt(MAX_GAS_FEES)) {
            console.warn(`skipping trade: fee ${maxTotalFee.toString()} exceeds the configured limit ${MAX_GAS_FEES.toString()}`)
            return
        }
        if (quote.fees) {
            const expectedFeeLimit = quote.fees.mul(BigNumber.from('1000').add(FEE_BUFFER_1000)).div(1000)
            if (maxTotalFee.gt(expectedFeeLimit)) {
                console.warn(`skipping trade: fee ${maxTotalFee.toString()} exceeds our calculated fee ${quote.fees.toString()} (+${FEE_BUFFER_1000}‰ buffer)`)
                return
            }
        }

        const response = await account.execute(calls, { tip: TIP, resourceBounds: estimate.resourceBounds })
        console.log("tx hash of new trade: ", response.transaction_hash)
        let matchedBy: string | undefined = undefined
        if (quote.wasMatch && quote.matchedTx?.length) {
            matchedBy = quote.matchedTx[0]
        }
        await addTransaction(
            {
                hash: response.transaction_hash,
                sell: quote.sell,
                matchedBy,
                ...{ failedFeesIncluded: matchedBy && failedFees.gt(0) ? failedFees.toString() : undefined },
                timestamp: Date.now(),
                expectedFees: quote.fees?.toString(),
                expectedMaxFees: maxTotalFee.toString(),
                resourceBounds: serializeResourceBounds(estimate.resourceBounds),
                expectedBuyAmount: quote.quote.buyAmount.toString(),
                estimatedSlippage: quote.quote.estimatedSlippage,
                expectedGasFees: quote.quote.gasFees.toString()
            },
            quote.matchedTx
        )
    }
}

function getSellAmount(balance: BigNumber, percentage: BigNumber, minAmount: BigNumber): BigNumber | undefined {
    if (balance.lt(minAmount))
        return

    const part = BigNumber.from(balance).mul(percentage).div(100)
    return part.gt(minAmount) ? part : minAmount
}

async function loop() {
    try {
        await run()
        notifyRunSucceeded()
    } catch (e) {
        try {
            await restartEthernetAdapterIfNetworkIssue(e)
        } catch (restartError) {
            console.warn('Ethernet adapter restart failed: ', restartError)
        }
        try {
            console.warn('run failed: ', JSON.stringify(e))
        } catch {
            console.warn('run failed: ', e)
        }
    }
    setTimeout(() => loop(), 10000)
}

loop()

process.on('uncaughtException', function (err) {
    console.log('Caught exception: ' + err);
});