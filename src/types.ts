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
}

export type QuoteData = {
    quote: Quote,
    ratio: BigNumber,
    wasMatch: boolean,
    sell: EthOrStrk,
}