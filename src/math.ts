import { BigNumber } from "@ethersproject/bignumber";
import { RATIO_MULTI } from "./conts";

export function checkPromilleChange(origin: BigNumber, newValue: BigNumber, min: BigNumber) {
    const hundred = BigNumber.from(1000).add(min)
    const percent = newValue.mul(1000).div(origin)
    console.log("checkPromilleChange", origin.toString(), newValue.toString(), percent.toString())
    return hundred.lte(percent)
}

export function getRatio(strk: BigNumber, eth: BigNumber) {
    return strk.mul(RATIO_MULTI).div(eth)
}

export function applyRatio(ratio: BigNumber, strk?: BigNumber, eth?: BigNumber) {
    if (strk) {
        return strk.mul(RATIO_MULTI).div(ratio)
    }
    if (eth) {
        return eth.mul(ratio).div(RATIO_MULTI)
    }
}