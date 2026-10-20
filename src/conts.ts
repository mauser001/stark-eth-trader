import { BigNumber } from "@ethersproject/bignumber"

export const RATIO_MULTI = 100000
export const SELL_PERCENT = BigNumber.from(process.env.SELL_PERCENT)
export const TRADE_DIFFERENCE_1000 = BigNumber.from(process.env.TRADE_DIFFERENCE_1000)
// number of most recent transactions the falling-knife counter counts still-unmatched trades over
export const FALLING_KNIFE_TX_COUNT = 40
// shorter window for the buy-back credits: matched counter trades only reduce the counter while they are
// among this many most recent transactions (early trigger, long escalation)
export const FALLING_KNIFE_MATCH_COUNT = 10
// gap steps each falling-knife counter point adds to the opening gap: gap = TRADE_DIFFERENCE_1000 * (1 + strength * counter)
export const FALLING_KNIFE_STRENGTH = 2
// subtract one counter point per interval since the last opening; 0 disables decay
export const FALLING_KNIFE_DECAY_HOURS = 4
// cap for the stored counter when it raises the buy-back target (TRADE_DIFFERENCE_1000 * min(counter, cap))
export const FALLING_KNIFE_BUYBACK_CAP = 1
// trend gap: when the eth/strk ratio moved more than TREND_GAP_MOVE_1000 (per mille) against the coin a new trade would buy,
// compared with the median of our trades at least TREND_GAP_DAYS old, that trade's opening gap is multiplied by
// max(1, TREND_GAP_VOL_K * hourly vol / TRADE_DIFFERENCE_1000), hourly vol from our trades of the last TREND_GAP_VOL_DAYS days.
// The multiplier is capped at TREND_GAP_MAX_MULT (0 = no cap).
// It stacks with the falling knife. TREND_GAP_DAYS = 0 disables it
export const TREND_GAP_DAYS = 14
export const TREND_GAP_MOVE_1000 = 100
export const TREND_GAP_VOL_K = 4
export const TREND_GAP_VOL_DAYS = 30
export const TREND_GAP_MAX_MULT = 6
// trades of this many days are needed for the trend gap, extract-prod keeps them in the trade file
export const TREND_GAP_HISTORY_DAYS = Math.max(TREND_GAP_DAYS, TREND_GAP_VOL_DAYS) + 7
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
