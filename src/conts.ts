import { BigNumber } from "@ethersproject/bignumber"

export const RATIO_MULTI = 100000
export const SELL_PERCENT = BigNumber.from(process.env.SELL_PERCENT)
export const TRADE_DIFFERENCE_1000 = BigNumber.from(process.env.TRADE_DIFFERENCE_1000)
export const MIN_SEL_AMOUNT_STRK = BigNumber.from(process.env.MIN_SEL_AMOUNT_STRK)
export const MIN_SEL_AMOUNT_ETH = BigNumber.from(process.env.MIN_SEL_AMOUNT_ETH)
export const MIN_GAS_FEES = BigNumber.from(process.env.MIN_GAS_FEES || '0')
// FRI per L2 gas paid on top of the base fee to prioritize inclusion; keep at 0 unless faster inclusion is required
export const TIP = BigInt(process.env.TIP || '0')
// rough L2 gas consumed by a swap, only used to translate the per-gas TIP into an approximate flat STRK cost for profitability checks
export const EST_L2_GAS = BigNumber.from(process.env.EST_L2_GAS || '17319360')
export const TIP_FEE_STRK = BigNumber.from(TIP.toString()).mul(EST_L2_GAS)
// application-level safety limit (in FRI) for the total tx fee; 0 disables the check
export const MAX_GAS_FEES = BigNumber.from(process.env.MAX_GAS_FEES || '0')
// allowed overshoot (per mille) of the actual tx fee above the fee we calculated the trade with
export const FEE_BUFFER_1000 = BigNumber.from(process.env.FEE_BUFFER_1000 || '50')
// target ETH balance; once the latest transaction's ETH balance reaches or exceeds this, the process stops trading. 0 disables the check
export const TARGET_ETH_BALANCE = BigNumber.from(process.env.TARGET_ETH_BALANCE || '0')
