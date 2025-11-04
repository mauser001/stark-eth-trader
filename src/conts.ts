import { BigNumber } from "@ethersproject/bignumber"

export const RATIO_MULTI = 100000
export const SELL_PERCENT = BigNumber.from(process.env.SELL_PERCENT)
export const TRADE_DIFFERENCE_1000 = BigNumber.from(process.env.TRADE_DIFFERENCE_1000)
export const MIN_SEL_AMOUNT_STRK = BigNumber.from(process.env.MIN_SEL_AMOUNT_STRK)
export const MIN_SEL_AMOUNT_ETH = BigNumber.from(process.env.MIN_SEL_AMOUNT_ETH)
