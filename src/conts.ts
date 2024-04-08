import { BigNumber } from "@ethersproject/bignumber"

export const RATIO_MULTI = 100000
export const SELL_PERCENT = BigNumber.from(process.env.SELL_PERCENT)
export const MIN_GAIN_ETH = BigNumber.from(process.env.MIN_GAIN_ETH)
export const MIN_GAIN_STRK = BigNumber.from(process.env.MIN_GAIN_STRK)
