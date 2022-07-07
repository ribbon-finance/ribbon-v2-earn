import { run } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { CHAINID, WETH_ADDRESS } from "../../constants/constants";
import {
  MANAGEMENT_FEE,
  PERFORMANCE_FEE,
  LOAN_TERM_LENGTH,
  BORROWER,
  OPTION_SELLER,
  LOAN_TERM_LENGTH,
  OPTION_PURCHASE_FREQ,
  LOAN_ALLOCATION_PCT,
  OPTION_ALLOCATION_PCT,
} from "../utils/constants";

const TOKEN_NAME = {
  [CHAINID.ETH_MAINNET]: "Ribbon USDC Earn Vault",
  [CHAINID.ETH_KOVAN]: "Ribbon USDC Earn Vault",
  [CHAINID.AVAX_MAINNET]: "Ribbon USDC Earn Vault",
  [CHAINID.AVAX_FUJI]: "Ribbon USDC Earn Vault",
};

const TOKEN_SYMBOL = {
  [CHAINID.ETH_MAINNET]: "rUSDC-EARN",
  [CHAINID.ETH_KOVAN]: "rUSDC-EARN",
  [CHAINID.AVAX_MAINNET]: "rUSDC-EARN",
  [CHAINID.AVAX_FUJI]: "rUSDC-EARN",
};

const main = async ({
  network,
  deployments,
  ethers,
  getNamedAccounts,
}: HardhatRuntimeEnvironment) => {
  const { BigNumber } = ethers;
  const { parseEther } = ethers.utils;
  const { deploy } = deployments;
  const { deployer, owner, keeper, admin, feeRecipient } =
    await getNamedAccounts();
  console.log(`02 - Deploying USDC Earn Vault on ${network.name}`);

  const chainId = network.config.chainId;

  const lifecycle = await deployments.get("VaultLifecycleEarn");
  const logicDeployment = await deployments.get("RibbonEarnVaultLogic");
  const RibbonEarnVault = await ethers.getContractFactory("RibbonEarnVault", {
    libraries: {
      VaultLifecycle: lifecycle.address,
    },
  });

  const initArgs = [
    {
      _owner: owner,
      _keeper: keeper,
      _borrower: BORROWER["GENESIS"],
      _optionSeller: OPTION_SELLER["ORBIT"],
      _feeRecipient: feeRecipient,
      _managementFee: MANAGEMENT_FEE,
      _performanceFee: PERFORMANCE_FEE,
      _tokenName: TOKEN_NAME[chainId],
      _tokenSymbol: TOKEN_SYMBOL[chainId],
    },
    {
      decimals: 6,
      asset: USDC_ADDRESS[chainId],
      minimumSupply: BigNumber.from(10).pow(8),
      cap: BigNumber.from("1000000").mul(BigNumber.from(10).pow(6)),
    },
    {
      currentLoanTermLength: LOAN_TERM_LENGTH,
      currentOptionPurchaseFreq: OPTION_PURCHASE_FREQ,
      loanAllocationPCT: LOAN_ALLOCATION_PCT,
      optionAllocationPCT: OPTION_ALLOCATION_PCT,
    },
  ];

  const initData = RibbonEarnVault.interface.encodeFunctionData(
    "initialize",
    initArgs
  );

  const proxy = await deploy("RibbonEarnVaultUSDC", {
    contract: "AdminUpgradeabilityProxy",
    from: deployer,
    args: [logicDeployment.address, admin, initData],
  });

  console.log(`RibbonEarnVaultUSDC Proxy @ ${proxy.address}`);

  try {
    await run("verify:verify", {
      address: proxy.address,
      constructorArguments: [logicDeployment.address, admin, initData],
    });
  } catch (error) {
    console.log(error);
  }
};
main.tags = ["RibbonEarnVaultUSDC"];
main.dependencies = ["RibbonEarnVaultLogic"];

export default main;
