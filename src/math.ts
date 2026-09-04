import { BigNumber } from "@ethersproject/bignumber";
import { ResourceBoundsBN } from "starknet";
import { RATIO_MULTI } from "./conts";
import { StoredResourceBound, StoredResourceBounds } from "./types";

// converts bigint resource bounds to a JSON-serializable form so they can be stored with each trade
export function serializeResourceBounds(resourceBounds: ResourceBoundsBN): StoredResourceBounds {
    const toStored = (bound: { max_amount: bigint, max_price_per_unit: bigint }): StoredResourceBound => ({
        max_amount: bound.max_amount.toString(),
        max_price_per_unit: bound.max_price_per_unit.toString()
    })
    return {
        l1_gas: resourceBounds.l1_gas && toStored(resourceBounds.l1_gas),
        l2_gas: resourceBounds.l2_gas && toStored(resourceBounds.l2_gas),
        l1_data_gas: resourceBounds.l1_data_gas && toStored(resourceBounds.l1_data_gas)
    }
}

// sums up the worst-case cost of every resource bound, mirroring how the sequencer caps the total fee for a v3 tx
export function getMaxTotalFee(resourceBounds: ResourceBoundsBN, tip: bigint): bigint {
    const { l1_gas, l1_data_gas, l2_gas } = resourceBounds
    console.log('Calculating max total fee with resource bounds: l1_gas.max_amount:', l1_gas.max_amount.toString(), 'l1_gas.max_price_per_unit:', l1_gas.max_price_per_unit.toString(), 'l1_data_gas.max_amount:', l1_data_gas.max_amount.toString(), 'l1_data_gas.max_price_per_unit:', l1_data_gas.max_price_per_unit.toString(), 'l2_gas.max_amount:', l2_gas.max_amount.toString(), 'l2_gas.max_price_per_unit:', l2_gas.max_price_per_unit.toString(), 'and tip:', tip)

    return l1_gas.max_amount * l1_gas.max_price_per_unit +
        l1_data_gas.max_amount * l1_data_gas.max_price_per_unit +
        l2_gas.max_amount * (l2_gas.max_price_per_unit + tip)
}

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
    throw new Error('Either strk or eth must be provided')
}