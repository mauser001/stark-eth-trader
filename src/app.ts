import {
    AvnuOptions,
    InvokeSwapResponse,
    executeSwap,
} from '@avnu/avnu-sdk';
import { constants } from 'starknet'
import { getQuote } from './quote';
import { BigNumber } from '@ethersproject/bignumber';
import { getAccount } from './account';
import { addTransaction, checkTransactions, getBlock } from './transactions';
import { getRatio } from './math';
import { SELL_PERCENT } from './conts';

const useTestnet = process.env.USE_TESTNET === 'true'
const chainId = useTestnet ? constants.StarknetChainId.SN_GOERLI : constants.StarknetChainId.SN_MAIN
const nodeUrl = useTestnet ? constants.RPC_GOERLI_NODES[0] : constants.RPC_MAINNET_NODES[0]
const avnuOptions: AvnuOptions = { baseUrl: useTestnet ? 'https://goerli.api.avnu.fi' : 'https://starknet.api.avnu.fi' }
let latestBlock = 0

async function run() {
    console.log(`${new Date().toLocaleString()} run useTestnet: ${useTestnet}, chainId: ${chainId},node url: ${nodeUrl}`)
    // Get account
    const { account, provider } = await getAccount({ chainId, nodeUrl })

    // First let's get the latest transactions
    const { finished, tx, unMatched, latest } = await checkTransactions(provider, account)
    if (!finished || !tx) {
        return
    }
    if (!latestBlock || latestBlock <= (latest?.block ?? 0)) {
        latestBlock = await getBlock(provider)
        if (latest?.block && latestBlock <= latest.block) {
            console.log('we need to wait for the next block after', latest.block)
            return
        }
    }
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
    // Calculate the strk - eth ratio ... this ratio will be used to compare to the quotes
    let ratio = getRatio(strk, eth)

    // If we have an open unmatched tx where we sold eth and try to get more. If we have no open tx where we sold eth we we try to sell e defined percentage
    const sellStrk = !tx.matchedBy && tx.sell === 'eth' ? BigNumber.from(tx.buyAmount) : BigNumber.from(latest.balanceStrk).mul(SELL_PERCENT).div(100)
    let quote = await getQuote('strk', sellStrk, account, avnuOptions, ratio, tx, unMatched)
    if (!quote?.quote) {
        // if we don't find a good quote for eth we try to get strk for a good price
        const sellEth = !tx.matchedBy && tx.sell === 'strk' ? BigNumber.from(tx.buyAmount) : BigNumber.from(latest.balanceEth).mul(SELL_PERCENT).div(100)
        if (tx.sell === 'eth' && !tx.matchedBy) {
            // get ratio from latest trade if the tx to match was an eth tx
            eth = latest.sell === 'eth' ? BigNumber.from(latest.sellAmount) : BigNumber.from(latest.buyAmount)
            strk = latest.sell === 'strk' ? BigNumber.from(latest.sellAmount) : BigNumber.from(latest.buyAmount)
            ratio = getRatio(strk, eth)
        }
        quote = await getQuote('eth', sellEth, account, avnuOptions, ratio, tx, unMatched)
    }

    if (quote?.quote) {
        console.log("We found a good trade matching: ", quote.sell, quote.matchedTx?.join(","), BigNumber.from(quote.quote.sellAmount).toString(), BigNumber.from(quote.quote.buyAmount).toString(), BigNumber.from(quote.quote.gasFees).toString())

        const response: InvokeSwapResponse = await executeSwap(account, quote.quote, { executeApprove: true }, avnuOptions)
        console.log("tx hash of new trade: ", response.transactionHash)
        let matchedBy: string
        if (quote.wasMatch && quote.matchedTx.length) {
            matchedBy = quote.matchedTx[0]
        }
        await addTransaction({ hash: response.transactionHash, sell: quote.sell, matchedBy, timestamp: Date.now() }, quote.matchedTx)
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