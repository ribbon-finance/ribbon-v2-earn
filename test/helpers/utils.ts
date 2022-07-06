import { ethers, network, artifacts } from "hardhat";
import { increaseTo } from "./time";
import WBTC_ABI from "../../constants/abis/WBTC.json";
import {
  CHAINID,
  USDC_ADDRESS,
  APE_ADDRESS,
  RETH_ADDRESS,
  WBTC_ADDRESS,
  SAVAX_ADDRESS,
  SAVAX_PRICER,
} from "../../constants/constants";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signers";
import { BigNumberish, Contract } from "ethers";
import { wmul } from "../helpers/math";

const { getDefaultProvider } = ethers;
const { parseEther } = ethers.utils;
const chainId = network.config.chainId;

require("dotenv").config();

export async function deployProxy(
  logicContractName: string,
  adminSigner: SignerWithAddress,
  initializeArgs: any[], // eslint-disable-line @typescript-eslint/no-explicit-any
  logicDeployParams = [],
  factoryOptions = {}
) {
  const AdminUpgradeabilityProxy = await ethers.getContractFactory(
    "AdminUpgradeabilityProxy",
    adminSigner
  );
  const LogicContract = await ethers.getContractFactory(
    logicContractName,
    factoryOptions || {}
  );
  const logic = await LogicContract.deploy(...logicDeployParams);

  const initBytes = LogicContract.interface.encodeFunctionData(
    "initialize",
    initializeArgs
  );

  const proxy = await AdminUpgradeabilityProxy.deploy(
    logic.address,
    await adminSigner.getAddress(),
    initBytes
  );
  return await ethers.getContractAt(logicContractName, proxy.address);
}

export async function parseLog(
  contractName: string,
  log: { topics: string[]; data: string }
) {
  if (typeof contractName !== "string") {
    throw new Error("contractName must be string");
  }
  const abi = (await artifacts.readArtifact(contractName)).abi;
  const iface = new ethers.utils.Interface(abi);
  const event = iface.parseLog(log);
  return event;
}

export async function generateWallet(
  asset: Contract,
  amount: BigNumber,
  owner: SignerWithAddress,
  weth: Contract
) {
  let provider = new ethers.providers.JsonRpcProvider(process.env.TEST_URI);
  let signer = new ethers.Wallet(
    "0ce495bd7bab5341ae5a7ac195173fba1aa56f6561e35e1fec6176e2519ab8da",
    provider
  );

  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [signer.address],
  });

  await asset.connect(owner).transfer(signer.address, amount);

  // Create a transaction object
  let tx = {
    to: signer.address,
    // Convert currency unit from ether to wei
    value: ethers.utils.parseEther("10"),
  };

  await owner.sendTransaction(tx);

  return signer;
}
export async function mintAndApprove(
  tokenAddress: string,
  userSigner: SignerWithAddress,
  spender: string,
  amount: BigNumber
) {
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: ["0xca06411bd7a7296d7dbdd0050dfc846e95febeb7"],
  });
  const wbtcMinter = await ethers.provider.getSigner(
    "0xca06411bd7a7296d7dbdd0050dfc846e95febeb7"
  );
  const forceSendContract = await ethers.getContractFactory("ForceSend");
  const forceSend = await forceSendContract.deploy(); // force Send is a contract that forces the sending of Ether to WBTC minter (which is a contract with no receive() function)
  await forceSend.deployed();
  await forceSend.go("0xca06411bd7a7296d7dbdd0050dfc846e95febeb7", {
    value: parseEther("1"),
  });

  const WBTCToken = await ethers.getContractAt(WBTC_ABI, tokenAddress);
  await WBTCToken.connect(wbtcMinter).mint(userSigner.address, amount);
  await WBTCToken.connect(userSigner).approve(
    spender,
    amount.mul(BigNumber.from("10"))
  );
}

export async function getAssetPricer(
  pricer: string,
  signer: SignerWithAddress
) {
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [pricer],
  });

  const ownerSigner = await provider.getSigner(pricer);

  const pricerContract = await ethers.getContractAt("IYearnPricer", pricer);

  const forceSendContract = await ethers.getContractFactory("ForceSend");
  const forceSend = await forceSendContract.deploy(); // force Send is a contract that forces the sending of Ether to WBTC minter (which is a contract with no receive() function)
  await forceSend.connect(signer).go(pricer, { value: parseEther("0.5") });

  return await pricerContract.connect(ownerSigner);
}

export async function addMinter(
  contract: Contract,
  contractOwner: string,
  minter: string
) {
  const tokenOwnerSigner = await ethers.provider.getSigner(contractOwner);

  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [contractOwner],
  });

  const forceSendContract = await ethers.getContractFactory("ForceSend");
  const forceSend = await forceSendContract.deploy(); // Some contract do not have receive(), so we force send
  await forceSend.deployed();
  await forceSend.go(contractOwner, {
    value: parseEther("10"),
  });

  await contract.connect(tokenOwnerSigner).addMinter(minter);

  await network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [contractOwner],
  });
}

export async function mintToken(
  contract: Contract,
  contractOwner: string,
  recipient: string,
  spender: string,
  amount: BigNumberish
) {
  const tokenOwnerSigner = await ethers.provider.getSigner(contractOwner);

  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [contractOwner],
  });

  const forceSendContract = await ethers.getContractFactory("ForceSend");
  const forceSend = await forceSendContract.deploy(); // Some contract do not have receive(), so we force send
  await forceSend.deployed();
  await forceSend.go(contractOwner, {
    value: parseEther("10"),
  });

  if (isBridgeToken(chainId, contract.address)) {
    // Avax mainnet uses BridgeTokens which have a special mint function
    const txid = ethers.utils.formatBytes32String("Hello World!");
    await contract
      .connect(tokenOwnerSigner)
      .mint(recipient, amount, recipient, 0, txid);
  } else if (
    contract.address === USDC_ADDRESS[chainId] ||
    contract.address === SAVAX_ADDRESS[chainId] ||
    contract.address === APE_ADDRESS[chainId] ||
    contract.address === RETH_ADDRESS[chainId]
  ) {
    await contract.connect(tokenOwnerSigner).transfer(recipient, amount);
  } else {
    await contract.connect(tokenOwnerSigner).mint(recipient, amount);
  }

  const recipientSigner = await ethers.provider.getSigner(recipient);
  await contract.connect(recipientSigner).approve(spender, amount);

  await network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [contractOwner],
  });
}

export const isBridgeToken = (chainId: number, address: string) =>
  chainId === CHAINID.AVAX_MAINNET &&
  (address === WBTC_ADDRESS[chainId] || address === USDC_ADDRESS[chainId]);

export async function lockedBalanceForRollover(vault: Contract) {
  let currentBalance = await vault.totalBalance();
  let newPricePerShare = await vault.pricePerShare();

  let queuedWithdrawAmount = await sharesToAsset(
    (
      await vault.vaultState()
    ).queuedWithdrawShares,
    newPricePerShare,
    (
      await vault.vaultParams()
    ).decimals
  );

  let balanceSansQueued = currentBalance.sub(queuedWithdrawAmount);
  return [balanceSansQueued, queuedWithdrawAmount];
}

async function sharesToAsset(
  shares: BigNumber,
  assetPerShare: BigNumber,
  decimals: BigNumber
) {
  return shares
    .mul(assetPerShare)
    .div(BigNumber.from(10).pow(decimals.toString()));
}

/* eslint @typescript-eslint/no-explicit-any: "off" */
export const objectEquals = (a: any, b: any) => {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  if (!a || !b || (typeof a !== "object" && typeof b !== "object"))
    return a === b;
  /* eslint no-undefined: "off" */
  if (a === null || a === undefined || b === null || b === undefined)
    return false;
  if (a.prototype !== b.prototype) return false;
  let keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => objectEquals(a[k], b[k]));
};

export const serializeMap = (map: Record<string, unknown>) => {
  return Object.fromEntries(
    Object.keys(map).map((key) => {
      return [key, serializeToObject(map[key])];
    })
  );
};

export const serializeToObject = (solidityValue: unknown) => {
  if (BigNumber.isBigNumber(solidityValue)) {
    return solidityValue.toString();
  }
  // Handle structs recursively
  if (Array.isArray(solidityValue)) {
    return solidityValue.map((val) => serializeToObject(val));
  }
  return solidityValue;
};

export const getPricerAsset = async (pricer: Contract) => {
  switch (pricer.address) {
    case SAVAX_PRICER:
      return await pricer.sAVAX();
    default:
      return await pricer.asset();
  }
};
