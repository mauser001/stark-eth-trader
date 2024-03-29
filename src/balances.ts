import { BigNumber } from "@ethersproject/bignumber";
import { Account, Contract, RpcProvider } from "starknet";

// getting the token balance of the account
async function getBalance(provider: RpcProvider, account: Account, address: string) {
    const { abi: testAbi } = await provider.getClassAt(address);
    if (testAbi === undefined) {
        throw new Error('no abi.');
    }
    const contract = new Contract(testAbi, address, provider);

    const balance = await contract.balanceOf(account.address)
    console.log("get balance account.address", account.address, balance.toString(), address)
    return BigNumber.from(balance);
}

// getting the eth and strk balances 
export async function getBalances(provider: RpcProvider, account: Account) {
    return {
        eth: await getBalance(provider, account, process.env.ETH_TOKEN),
        strk: await getBalance(provider, account, process.env.STARK_TOKEN)
    }
}