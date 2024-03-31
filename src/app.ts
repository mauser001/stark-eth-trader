import {
    AvnuOptions,
    InvokeSwapResponse,
    executeSwap,
} from '@avnu/avnu-sdk';
import { Call, constants } from 'starknet'
import { getQuote } from './quote';
import { BigNumber } from '@ethersproject/bignumber';
import { getAccount } from './account';
import { addTransaction, checkTransactions } from './transactions';
import { getRatio } from './math';
import { SELL_PERCENT } from './conts';
import { Aggregator } from './types';
import { Router as FibrousRouter } from "fibrous-router-sdk";

const useTestnet = process.env.USE_TESTNET === 'true'
const chainId = useTestnet ? constants.StarknetChainId.SN_GOERLI : constants.StarknetChainId.SN_MAIN
const nodeUrl = useTestnet ? constants.RPC_GOERLI_NODES[0] : constants.RPC_MAINNET_NODES[0]
const avnuOptions: AvnuOptions = { baseUrl: useTestnet ? 'https://goerli.api.avnu.fi' : 'https://starknet.api.avnu.fi' }

async function run() {
    console.log(`${new Date().toLocaleString()} run useTestnet: ${useTestnet}, chainId: ${chainId},node url: ${nodeUrl}`)
    // Get account
    const { account, provider } = await getAccount({ chainId, nodeUrl })

    // First let's get the latest transactions
    const { finished, tx } = await checkTransactions(provider, account)
    if (!finished || !tx) {
        return
    }

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
    // Calculate the strk - eth ratio ... this ratio will be used to compare to the quotes
    const ratio = getRatio(strk, eth)

    // If we have an open unmatched tx where we sold eth and try to get more. If we have no open tx where we sold eth we we try to sell e defined percentage
    const sellStrk = !tx.matchedBy && tx.sell === 'eth' ? BigNumber.from(tx.buyAmount) : BigNumber.from(tx.balanceStrk).div(SELL_PERCENT)
    let quote = await getQuote('strk', sellStrk, account, avnuOptions, ratio, tx)
    if (!quote) {
        // if we don't find a good quote for eth we try to get strk for a good price
        const sellEth = !tx.matchedBy && tx.sell === 'strk' ? BigNumber.from(tx.buyAmount) : BigNumber.from(tx.balanceEth).div(SELL_PERCENT)
        quote = await getQuote('eth', sellEth, account, avnuOptions, ratio, tx)
    }

    if (quote) {
        const aggregator: Aggregator = quote.quote ? 'Avnu' : 'Fibrous'
        console.log(`We found a good trade as ${aggregator}, matching an open tx=${quote.wasMatch}, sellAmount: ${BigNumber.from(quote.quote?.sellAmount || quote.route?.inputAmount).toString()}, buyAmount: ${BigNumber.from(quote.quote?.buyAmount || quote.route?.outputAmount).toString()}, fees: ${BigNumber.from(quote.quote?.gasFees || quote.route?.estimatedGasUsed).toString()}`)

        let transactionHash: string
        if (quote.quote) {
            const response: InvokeSwapResponse = await executeSwap(account, quote.quote, { executeApprove: true }, avnuOptions)
            transactionHash = response.transactionHash
        } else {
            const slippage = 0.01; // %1 slippage

            const router = new FibrousRouter()

            const approveCall: Call = await router.buildApprove(
                BigNumber.from(quote.route.inputAmount),
                quote.route.inputToken.address,
            );

            const swapCall: Call = await router.buildTransaction(
                BigNumber.from(quote.route.inputAmount),
                quote.route.inputToken.address,
                quote.route.outputToken.address,
                slippage,
                account.address
            );

            const result = await account.execute([approveCall, swapCall]);
            transactionHash = result.transaction_hash
        }

        if (!transactionHash) {
            console.log('something went wrong with the transaction')
            return
        }
        console.log(`trade  transactionHash ${transactionHash}`)
        let matchedBy: string
        if (quote.wasMatch) {
            tx.matchedBy = transactionHash
            matchedBy = tx.hash
        }
        await addTransaction({ hash: transactionHash, aggregator, sell: quote.sell, matchedBy, timestamp: Date.now() }, quote.wasMatch ? tx.hash : undefined)
    }
}

async function loop() {
    try {
        await run()
    } catch (e) {
        console.log('run failed', e)
    }
    setTimeout(() => loop(), 30000)
}

loop()

process.on('uncaughtException', function (err) {
    console.log('Caught exception: ' + err);
});