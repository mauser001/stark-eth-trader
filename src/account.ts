import { Account, RpcProvider, RpcProviderOptions, Signer } from "starknet";

// getting the account
export async function getAccount(options: RpcProviderOptions) {
    const provider = new RpcProvider(options);
    const accountAddress = process.env.WALLET;
    const signer = new Signer(process.env.X)
    const account = new Account({ provider, address: accountAddress, signer });
    return { account, provider }
}