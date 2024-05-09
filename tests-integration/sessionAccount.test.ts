import { Contract, num } from "starknet";
import {
  AllowedMethod,
  ArgentX,
  BackendService,
  DappService,
  StarknetKeyPair,
  deployAccount,
  deployAccountWithGuardianBackup,
  deployer,
  expectRevertWithErrorMessage,
  getSessionTypedData,
  manager,
  randomStarknetKeyPair,
  setupSession,
} from "../lib";

describe("Hybrid Session Account: execute calls", function () {
  let sessionAccountClassHash: string;
  let mockDappOneContract: Contract;
  let mockErc20Contract: Contract;
  const initialTime = 1710167933n;

  before(async () => {
    sessionAccountClassHash = await manager.declareLocalContract("ArgentAccount");

    const mockDappClassHash = await manager.declareLocalContract("MockDapp");
    const deployedmockDappOne = await deployer.deployContract({
      classHash: mockDappClassHash,
      salt: num.toHex(randomStarknetKeyPair().privateKey),
    });
    const erc20ClassHash = await manager.declareLocalContract("Erc20Mock");
    const deployedErc20 = await deployer.deployContract({
      classHash: erc20ClassHash,
      salt: num.toHex(randomStarknetKeyPair().privateKey),
    });
    mockErc20Contract = await manager.loadContract(deployedErc20.contract_address);
    mockDappOneContract = await manager.loadContract(deployedmockDappOne.contract_address);
  });

  beforeEach(async function () {
    await manager.setTime(initialTime);
  });

  it("Call a contract with backend signer", async function () {
    const { accountContract, account, guardian } = await deployAccount({ classHash: sessionAccountClassHash });

    const backendService = new BackendService(guardian as StarknetKeyPair);
    const dappService = new DappService(backendService);
    const argentX = new ArgentX(account, backendService);

    // Session creation:
    // 1. dapp request session: provides dapp pub key and policies
    const allowedMethods: AllowedMethod[] = [
      {
        "Contract Address": mockDappOneContract.address,
        selector: "set_number_double",
      },
    ];

    const sessionRequest = dappService.createSessionRequest(allowedMethods, initialTime + 150n);

    // 2. Owner and Guardian signs session
    const accountSessionSignature = await argentX.getOffchainSignature(await getSessionTypedData(sessionRequest));

    //  Every request:
    const calls = [mockDappOneContract.populateTransaction.set_number_double(2)];

    // 1. dapp requests backend signature
    // backend: can verify the parameters and check it was signed by the account then provides signature
    // 2. dapp signs tx and session, crafts signature and submits transaction
    const accountWithDappSigner = dappService.getAccountWithSessionSigner(
      account,
      sessionRequest,
      accountSessionSignature,
    );

    const { transaction_hash } = await accountWithDappSigner.execute(calls);

    await account.waitForTransaction(transaction_hash);
    await mockDappOneContract.get_number(accountContract.address).should.eventually.equal(4n);
  });

  it("Only execute tx if session not expired", async function () {
    const { accountContract, account, guardian } = await deployAccount({ classHash: sessionAccountClassHash });

    const backendService = new BackendService(guardian as StarknetKeyPair);
    const dappService = new DappService(backendService);
    const argentX = new ArgentX(account, backendService);

    const expiresAt = initialTime + 60n * 24n;

    const allowedMethods: AllowedMethod[] = [
      {
        "Contract Address": mockDappOneContract.address,
        selector: "set_number_double",
      },
    ];

    const sessionRequest = dappService.createSessionRequest(allowedMethods, expiresAt);
    const accountSessionSignature = await argentX.getOffchainSignature(await getSessionTypedData(sessionRequest));
    const calls = [mockDappOneContract.populateTransaction.set_number_double(2)];
    const accountWithDappSigner = dappService.getAccountWithSessionSigner(
      account,
      sessionRequest,
      accountSessionSignature,
    );
    const { transaction_hash } = await accountWithDappSigner.execute(calls);

    // non expired session
    await manager.setTime(expiresAt - 10800n);
    await account.waitForTransaction(transaction_hash);
    await mockDappOneContract.get_number(accountContract.address).should.eventually.equal(4n);

    // Expired session
    await manager.setTime(expiresAt + 7200n);
    await expectRevertWithErrorMessage("session/expired", () =>
      accountWithDappSigner.execute(calls, undefined, { maxFee: 1e16 }),
    );
    await mockDappOneContract.get_number(accountContract.address).should.eventually.equal(4n);
  });

  it("Call a token contract", async function () {
    const { accountContract, account, guardian } = await deployAccount({ classHash: sessionAccountClassHash });

    const backendService = new BackendService(guardian as StarknetKeyPair);
    const dappService = new DappService(backendService);
    const argentX = new ArgentX(account, backendService);

    // Session creation:
    // 1. dapp request session: provides dapp pub key and policies
    const allowedMethods: AllowedMethod[] = [
      {
        "Contract Address": mockErc20Contract.address,
        selector: "mint",
      },
      {
        "Contract Address": mockErc20Contract.address,
        selector: "approve",
      },
      {
        "Contract Address": mockErc20Contract.address,
        selector: "transfer_from",
      },
    ];

    const sessionRequest = dappService.createSessionRequest(allowedMethods, initialTime + 150n);

    // 2. Wallet signs session
    const accountSessionSignature = await argentX.getOffchainSignature(await getSessionTypedData(sessionRequest));

    //  Every request:
    const calls = [
      mockErc20Contract.populateTransaction.mint(accountContract.address, 10),
      mockErc20Contract.populateTransaction.approve(accountContract.address, 10),
      mockErc20Contract.populateTransaction.transfer_from(accountContract.address, "0x999", 10),
    ];

    // 1. dapp requests backend signature
    // backend: can verify the parameters and check it was signed by the account then provides signature
    // 2. dapp signs tx and session, crafts signature and submits transaction
    const accountWithDappSigner = dappService.getAccountWithSessionSigner(
      account,
      sessionRequest,
      accountSessionSignature,
    );

    const { transaction_hash } = await accountWithDappSigner.execute(calls);
    await account.waitForTransaction(transaction_hash);
    await mockErc20Contract.balance_of(accountContract.address).should.eventually.equal(0n);
    await mockErc20Contract.balance_of("0x999").should.eventually.equal(10n);
  });

  it("Use Session with caching enabled", async function () {
    const { accountContract, account, guardian } = await deployAccount({ classHash: sessionAccountClassHash });

    const backendService = new BackendService(guardian as StarknetKeyPair);
    const dappService = new DappService(backendService);
    const argentX = new ArgentX(account, backendService);

    // Session creation:
    // 1. dapp request session: provides dapp pub key and policies
    const allowedMethods: AllowedMethod[] = [
      {
        "Contract Address": mockDappOneContract.address,
        selector: "set_number_double",
      },
    ];

    const sessionRequest = dappService.createSessionRequest(allowedMethods, initialTime + 150n);
    const accountSessionSignature = await argentX.getOffchainSignature(await getSessionTypedData(sessionRequest));

    const calls = [mockDappOneContract.populateTransaction.set_number_double(2)];
    const accountWithDappSigner = dappService.getAccountWithSessionSigner(
      account,
      sessionRequest,
      accountSessionSignature,
      true,
    );

    const { transaction_hash } = await accountWithDappSigner.execute(calls);

    await account.waitForTransaction(transaction_hash);
    await mockDappOneContract.get_number(accountContract.address).should.eventually.equal(4n);

    const calls2 = [mockDappOneContract.populateTransaction.set_number_double(4)];

    const { transaction_hash: tx2 } = await accountWithDappSigner.execute(calls2);

    await account.waitForTransaction(tx2);
    await mockDappOneContract.get_number(accountContract.address).should.eventually.equal(8n);
  });

  it("Fail if guardian backup signed session (uncached)", async function () {
    const { account, guardian } = await deployAccountWithGuardianBackup({
      classHash: sessionAccountClassHash,
    });

    const allowedMethods: AllowedMethod[] = [
      {
        "Contract Address": mockDappOneContract.address,
        selector: "set_number_double",
      },
    ];

    const calls = [mockDappOneContract.populateTransaction.set_number_double(2)];

    const accountWithDappSigner = await setupSession(
      guardian as StarknetKeyPair,
      account,
      allowedMethods,
      initialTime + 150n,
      randomStarknetKeyPair(),
    );

    await expectRevertWithErrorMessage("session/signer-is-not-guardian", () => accountWithDappSigner.execute(calls));
  });

  it("Fail if guardian backup signed session (cached)", async function () {
    const { account, guardian } = await deployAccountWithGuardianBackup({
      classHash: sessionAccountClassHash,
    });

    const allowedMethods: AllowedMethod[] = [
      {
        "Contract Address": mockDappOneContract.address,
        selector: "set_number_double",
      },
    ];

    const calls = [mockDappOneContract.populateTransaction.set_number_double(2)];

    const accountWithDappSigner = await setupSession(
      guardian as StarknetKeyPair,
      account,
      allowedMethods,
      initialTime + 150n,
      randomStarknetKeyPair(),
      true,
    );

    await expectRevertWithErrorMessage("session/signer-is-not-guardian", () => accountWithDappSigner.execute(calls));
  });
});
