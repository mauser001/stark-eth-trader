import { Quote } from "@avnu/avnu-sdk";
import { BigNumber } from "@ethersproject/bignumber";

export type EthOrStrk = 'eth' | 'strk'

export type TxData = {
    hash: string;
    status?: 'SUCCEEDED' | 'REVERTED' | 'NOT_FOUND',
    sell?: EthOrStrk,
    matchedBy?: string,
    sellAmount?: string,
    buyAmount?: string,
    balanceEth?: string,
    balanceStrk?: string,
    expectedFees?: string,
    expectedBuyAmount?: string,
    expectedGasFees?: string,
    estimatedSlippage?: number,
    timestamp?: number,
    block?: number,
    failedFeesIncluded?: string
}

export type QuoteData = {
    quote?: Quote,
    ratio: BigNumber,
    wasMatch?: boolean,
    matchedTx?: string[],
    sell?: EthOrStrk,
    fees?: BigNumber
}

export type FailedTransactions = {
    currentFailedAmmount: string,
    failedCount: number,
    failedHashes: string[]
}