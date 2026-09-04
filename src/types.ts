import { Quote } from "@avnu/avnu-sdk";
import { BigNumber } from "@ethersproject/bignumber";

export type EthOrStrk = 'eth' | 'strk'

// JSON-serializable version of starknet.js ResourceBoundsBN (bigint -> string),
// so we can persist the fee estimates of each trade and later compare them with actualFees
export type StoredResourceBound = {
    max_amount: string,
    max_price_per_unit: string
}

export type StoredResourceBounds = {
    l1_gas?: StoredResourceBound,
    l2_gas?: StoredResourceBound,
    l1_data_gas?: StoredResourceBound
}

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
    expectedMaxFees?: string,
    resourceBounds?: StoredResourceBounds,
    expectedBuyAmount?: string,
    expectedGasFees?: string,
    estimatedSlippage?: number,
    timestamp?: number,
    block?: number,
    failedFeesIncluded?: string,
    actualFees?: string
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