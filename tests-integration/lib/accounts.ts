import {
  Abi,
  Account,
  AllowArray,
  CairoOption,
  CairoOptionVariant,
  Call,
  CallData,
  Contract,
  DeployAccountContractPayload,
  DeployContractResponse,
  GetTransactionReceiptResponse,
  InvokeFunctionResponse,
  RPC,
  RawCalldata,
  UniversalDetails,
  hash,
  num,
  uint256,
} from "starknet";
import { declareContract, declareFixtureContract, ethAddress, loadContract, strkAddress } from "./contracts";
import { provider } from "./provider";
import { LegacyArgentSigner, LegacyKeyPair, LegacyMultisigSigner, LegacyStarknetKeyPair } from "./signers/legacy";
import { ArgentSigner, KeyPair, randomStarknetKeyPair } from "./signers/signers";

export class ArgentAccount extends Account {
  // Increase the gas limit by 30% to avoid failures due to gas estimation being too low with tx v3 and transactions the use escaping
  override async deployAccount(
    payload: DeployAccountContractPayload,
    details?: UniversalDetails,
  ): Promise<DeployContractResponse> {
    details ||= {};
    if (!details.skipValidate) {
      details.skipValidate = false;
    }
    return super.deployAccount(payload, details);
  }

  override async execute(
    calls: AllowArray<Call>,
    abis?: Abi[],
    details: UniversalDetails = {},
  ): Promise<InvokeFunctionResponse> {
    details ||= {};
    if (!details.skipValidate) {
      details.skipValidate = false;
    }
    if (details.resourceBounds) {
      return super.execute(calls, abis, details);
    }
    const estimate = await this.estimateFee(calls, details);
    return super.execute(calls, abis, {
      ...details,
      resourceBounds: {
        ...estimate.resourceBounds,
        l1_gas: {
          ...estimate.resourceBounds.l1_gas,
          max_amount: num.toHexString(num.addPercent(estimate.resourceBounds.l1_gas.max_amount, 30)),
        },
      },
    });
  }
}

export interface ArgentWallet {
  account: ArgentAccount;
  accountContract: Contract;
  owner: KeyPair;
}

export interface ArgentWalletWithGuardian extends ArgentWallet {
  guardian: KeyPair;
}

export interface LegacyArgentWallet {
  account: ArgentAccount;
  accountContract: Contract;
  owner: LegacyKeyPair;
  guardian: LegacyKeyPair;
}

export interface ArgentWalletWithGuardianAndBackup extends ArgentWalletWithGuardian {
  guardianBackup: KeyPair;
}

export const deployer = (() => {
  if (provider.isDevnet) {
    const devnetAddress = "0x64b48806902a367c8598f4f95c305e8c1a1acba5f082d294a43793113115691";
    const devnetPrivateKey = "0x71d7bb07b9a64f6f78ac4c816aff4da9";
    return new Account(provider, devnetAddress, devnetPrivateKey, undefined, RPC.ETransactionVersion.V2);
  }
  const address = process.env.ADDRESS;
  const privateKey = process.env.PRIVATE_KEY;
  if (address && privateKey) {
    return new Account(provider, address, privateKey, undefined, RPC.ETransactionVersion.V2);
  }
  throw new Error("Missing deployer address or private key, please set ADDRESS and PRIVATE_KEY env variables.");
})();

export const deployerV3 = setDefaultTransactionVersionV3(deployer);

export function setDefaultTransactionVersion(account: ArgentAccount, newVersion: boolean): Account {
  const newDefaultVersion = newVersion ? RPC.ETransactionVersion.V3 : RPC.ETransactionVersion.V2;
  if (account.transactionVersion === newDefaultVersion) {
    return account;
  }
  return new ArgentAccount(account, account.address, account.signer, account.cairoVersion, newDefaultVersion);
}

export function setDefaultTransactionVersionV3(account: ArgentAccount): ArgentAccount {
  return setDefaultTransactionVersion(account, true);
}

console.log("Deployer:", deployer.address);

export async function deployOldAccount(): Promise<LegacyArgentWallet> {
  const proxyClassHash = await declareFixtureContract("Proxy");
  const oldArgentAccountClassHash = await declareFixtureContract("OldArgentAccount");
  const owner = new LegacyStarknetKeyPair();
  const guardian = new LegacyStarknetKeyPair();

  const constructorCalldata = CallData.compile({
    implementation: oldArgentAccountClassHash,
    selector: hash.getSelectorFromName("initialize"),
    calldata: CallData.compile({ owner: owner.publicKey, guardian: guardian.publicKey }),
  });

  const salt = num.toHex(randomStarknetKeyPair().privateKey);
  const contractAddress = hash.calculateContractAddressFromHash(salt, proxyClassHash, constructorCalldata, 0);

  const account = new Account(provider, contractAddress, owner);
  account.signer = new LegacyMultisigSigner([owner, guardian]);

  await fundAccount(account.address, 1e16, "ETH"); // 0.01 ETH

  const { transaction_hash } = await account.deployAccount({
    classHash: proxyClassHash,
    constructorCalldata,
    contractAddress,
    addressSalt: salt,
  });
  await provider.waitForTransaction(transaction_hash);
  const accountContract = await loadContract(account.address);
  accountContract.connect(account);
  return { account, accountContract, owner, guardian };
}

async function deployAccountInner(
  params: DeployAccountParams,
): Promise<
  DeployAccountParams & { account: Account; classHash: string; owner: KeyPair; guardian?: KeyPair; salt: string }
> {
  const finalParams = {
    ...params,
    classHash: params.classHash ?? (await declareContract("ArgentAccount")),
    salt: params.salt ?? num.toHex(randomStarknetKeyPair().privateKey),
    owner: params.owner ?? randomStarknetKeyPair(),
    useTxV3: params.useTxV3 ?? false,
    selfDeploy: params.selfDeploy ?? false,
  };
  const guardian = finalParams.guardian
    ? finalParams.guardian.signerAsOption
    : new CairoOption(CairoOptionVariant.None);
  const constructorCalldata = CallData.compile({ owner: finalParams.owner.signer, guardian });

  const { classHash, salt } = finalParams;
  const contractAddress = hash.calculateContractAddressFromHash(salt, classHash, constructorCalldata, 0);
  const fundingCall = finalParams.useTxV3
    ? await fundAccountCall(contractAddress, finalParams.fundingAmount ?? 1e16, "STRK") // 0.01 STRK
    : await fundAccountCall(contractAddress, finalParams.fundingAmount ?? 1e18, "ETH"); // 1 ETH
  const calls = fundingCall ? [fundingCall] : [];

  const transactionVersion = finalParams.useTxV3 ? RPC.ETransactionVersion.V3 : RPC.ETransactionVersion.V2;
  const signer = new ArgentSigner(finalParams.owner, finalParams.guardian);
  const account = new ArgentAccount(provider, contractAddress, signer, "1", transactionVersion);

  let transactionHash;
  if (finalParams.selfDeploy) {
    const response = await deployer.execute(calls);
    await provider.waitForTransaction(response.transaction_hash);
    const { transaction_hash } = await account.deploySelf({ classHash, constructorCalldata, addressSalt: salt });
    transactionHash = transaction_hash;
  } else {
    const udcCalls = deployer.buildUDCContractPayload({ classHash, salt, constructorCalldata, unique: false });
    const { transaction_hash } = await deployer.execute([...calls, ...udcCalls]);
    transactionHash = transaction_hash;
  }

  await provider.waitForTransaction(transactionHash);
  return { ...finalParams, account };
}

export type DeployAccountParams = {
  useTxV3?: boolean;
  classHash?: string;
  owner?: KeyPair;
  guardian?: KeyPair;
  salt?: string;
  fundingAmount?: number | bigint;
  selfDeploy?: boolean;
};

export async function deployAccount(params: DeployAccountParams = {}): Promise<ArgentWalletWithGuardian> {
  params.guardian ||= randomStarknetKeyPair();
  const { account, owner } = await deployAccountInner(params);
  const accountContract = await loadContract(account.address);
  accountContract.connect(account);
  return { account, accountContract, owner, guardian: params.guardian };
}

export async function deployAccountWithoutGuardian(
  params: Omit<DeployAccountParams, "guardian"> = {},
): Promise<ArgentWallet> {
  const { account, owner } = await deployAccountInner(params);
  const accountContract = await loadContract(account.address);
  accountContract.connect(account);
  return { account, accountContract, owner };
}

export async function deployAccountWithGuardianBackup(
  params: DeployAccountParams & { guardianBackup?: KeyPair } = {},
): Promise<ArgentWalletWithGuardianAndBackup> {
  const guardianBackup = params.guardianBackup ?? randomStarknetKeyPair();

  const wallet = (await deployAccount(params)) as ArgentWalletWithGuardianAndBackup;
  await wallet.accountContract.change_guardian_backup(guardianBackup.compiledSignerAsOption);

  wallet.account.signer = new ArgentSigner(wallet.owner, guardianBackup);
  wallet.guardianBackup = guardianBackup;
  wallet.accountContract.connect(wallet.account);
  return wallet;
}

export async function deployLegacyAccount(classHash: string) {
  const owner = new LegacyStarknetKeyPair();
  const guardian = new LegacyStarknetKeyPair();
  const salt = num.toHex(owner.privateKey);
  const constructorCalldata = CallData.compile({ owner: owner.publicKey, guardian: guardian.publicKey });
  const contractAddress = hash.calculateContractAddressFromHash(salt, classHash, constructorCalldata, 0);
  await fundAccount(contractAddress, 1e15, "ETH"); // 0.001 ETH
  const account = new Account(provider, contractAddress, owner, "1");
  account.signer = new LegacyArgentSigner(owner, guardian);

  const { transaction_hash } = await account.deploySelf({
    classHash,
    constructorCalldata,
    addressSalt: salt,
  });
  await provider.waitForTransaction(transaction_hash);

  const accountContract = await loadContract(account.address);
  accountContract.connect(account);
  return { account, accountContract, owner, guardian };
}

export async function upgradeAccount(
  accountToUpgrade: Account,
  newClassHash: string,
  calldata: RawCalldata = [],
): Promise<GetTransactionReceiptResponse> {
  const { transaction_hash } = await accountToUpgrade.execute({
    contractAddress: accountToUpgrade.address,
    entrypoint: "upgrade",
    calldata: CallData.compile({ implementation: newClassHash, calldata }),
  });
  return await provider.waitForTransaction(transaction_hash);
}

export async function fundAccount(recipient: string, amount: number | bigint, token: "ETH" | "STRK") {
  const call = await fundAccountCall(recipient, amount, token);
  const response = await deployer.execute(call ? [call] : []);
  await provider.waitForTransaction(response.transaction_hash);
}

export async function fundAccountCall(
  recipient: string,
  amount: number | bigint,
  token: "ETH" | "STRK",
): Promise<Call | undefined> {
  if (amount <= 0n) {
    return;
  }
  const contractAddress = { ETH: ethAddress, STRK: strkAddress }[token];
  if (!contractAddress) {
    throw new Error(`Unsupported token ${token}`);
  }
  const calldata = CallData.compile([recipient, uint256.bnToUint256(amount)]);
  return { contractAddress, calldata, entrypoint: "transfer" };
}
