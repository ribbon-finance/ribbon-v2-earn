import { run } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { CHAINID, USDC_ADDRESS } from "../../constants/constants";
import {
  MANAGEMENT_FEE,
  PERFORMANCE_FEE,
  BORROWERS,
  BORROWER_WEIGHTS,
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
  [CHAINID.ETH_MAINNET]: "rEARN",
  [CHAINID.ETH_KOVAN]: "rEARN",
  [CHAINID.AVAX_MAINNET]: "rEARN",
  [CHAINID.AVAX_FUJI]: "rEARN",
};

const main = async ({
  network,
  deployments,
  ethers,
  getNamedAccounts,
}: HardhatRuntimeEnvironment) => {
  const { BigNumber } = ethers;
  const { deploy } = deployments;
  const { deployer, owner, keeper, admin, feeRecipient } =
    await getNamedAccounts();
  console.log(`03 - Deploying USDC Earn Vault on ${network.name}`);

  const chainId = network.config.chainId;

  const lifecycle = await deployments.get("VaultLifecycleEarn");
  const logicDeployment = await deployments.get("RibbonEarnVaultLogic");
  const mm = await deployments.get("MM");

  const RibbonEarnVault = await ethers.getContractFactory("RibbonEarnVault", {
    libraries: {
      VaultLifecycleEarn: lifecycle.address,
    },
  });

  const initArgs = [
    {
      _owner: owner,
      _keeper: keeper,
      _borrowers: [BORROWERS.WINTERMUTE, BORROWERS.FOLKVANG],
      _borrowerWeights: [
        BORROWER_WEIGHTS[BORROWERS.WINTERMUTE],
        BORROWER_WEIGHTS[BORROWERS.FOLKVANG],
      ],
      _optionSeller: OPTION_SELLER.ORBIT,
      _mm: mm,
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
      cap: BigNumber.from("2500000").mul(BigNumber.from(10).pow(6)),
    },
    {
      nextLoanTermLength: 0,
      nextOptionPurchaseFreq: 0,
      currentLoanTermLength: LOAN_TERM_LENGTH.USDC,
      currentOptionPurchaseFreq: OPTION_PURCHASE_FREQ.USDC,
      loanAllocationPCT: LOAN_ALLOCATION_PCT.USDC,
      optionAllocationPCT: OPTION_ALLOCATION_PCT.USDC,
      loanAllocation: 0,
      optionAllocation: 0,
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
