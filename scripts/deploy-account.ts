import "dotenv/config";
import { Account, constants } from "starknet";
import { FastProvider, declareContract, deployAccount, loadContract, provider } from "../tests/lib";

const address = process.env.ADDRESS as string;
const privateKey = process.env.PRIVATE_KEY as string;
export const deployer = new Account(provider, address, privateKey);

const argentAccountClassHash = await declareContract("ArgentAccount", false);
console.log("ArgentAccount class hash:", argentAccountClassHash);

console.log("Deploying new account");
const { account } = await deployAccount(argentAccountClassHash);
console.log("Account address:", account.address);

// const testDappClassHash = await declareContract("TestDapp");
// const { contract_address } = await deployer.deployContract({ classHash: testDappClassHash });
// const testDappContract = await loadContract(contract_address);

// testDappContract.connect(account);
// const response = await testDappContract.set_number(42);
// const receipt = await provider.waitForTransaction(response.transaction_hash);