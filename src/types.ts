import { Quote } from "@avnu/avnu-sdk";
import { BigNumber } from "@ethersproject/bignumber";
import { RouteSuccess } from "fibrous-router-sdk";

export type EthOrStrk = 'eth' | 'strk'
export type Aggregator = 'Avnu' | 'Fibrous'

export type TxData = {
    hash: string;
    status?: 'SUCCEEDED' | 'REVERTED',
    sell?: EthOrStrk,
    matchedBy?: string,
    sellAmount?: string,
    buyAmount?: string,
    balanceEth?: string,
    balanceStrk?: string,
    timestamp?: number,
    aggregator?: Aggregator
}

export type QuoteData = {
    quote?: Quote, // from Avnu
    route?: RouteSuccess, // from Fibrous
    ratio: BigNumber,
    wasMatch: boolean,
    sell: EthOrStrk,
}