import { BigNumber } from "@ethersproject/bignumber";
import { RATIO_MULTI } from "./conts";

export function checkPercentChange(origin: BigNumber, newValue: BigNumber, min: BigNumber) {
    const hundred = BigNumber.from(100).add(min)
    const percent = newValue.mul(100).div(origin)
    console.log("checkPercentChange", origin.toString(), newValue.toString(), percent.toString())
    return hundred.lte(percent)
}

export function getRatio(strk: BigNumber, eth: BigNumber) {
    return strk.mul(RATIO_MULTI).div(eth)
}