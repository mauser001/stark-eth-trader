import { Quote } from "@avnu/avnu-sdk";
import { BigNumber } from "@ethersproject/bignumber";

export type EthOrStrk = 'eth' | 'strk'

export type TxData = {
    hash: string;
    status?: 'SUCCEEDED' | 'REVERTED',
    sell?: EthOrStrk,
    matchedBy?: string,
    sellAmount?: string,
    buyAmount?: string,
    balanceEth?: string,
    balanceStrk?: string,
    expectedFees?: string,
    expectedBuyAmount?: string,
    expectedByAmountWithoutFees?: string,
    expectedGasFees?: string,
    timestamp?: number,
    block?: number,
}

export type QuoteData = {
    quote?: Quote,
    ratio: BigNumber,
    wasMatch?: boolean,
    matchedTx?: string[],
    sell?: EthOrStrk,
    fees?: BigNumber
}