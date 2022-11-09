import { run } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { CHAINID, STETH_ADDRESS } from "../../constants/constants";
import {
  MANAGEMENT_FEE,
  PERFORMANCE_FEE,
  OPTION_SELLER,
  LOAN_TERM_LENGTH,
  OPTION_PURCHASE_FREQ,
  LOAN_ALLOCATION_PCT,
  OPTION_ALLOCATION_PCT,
} from "../utils/constants";

const TOKEN_NAME = {
  [CHAINID.ETH_MAINNET]: "Ribbon stETH Earn Vault",
  [CHAINID.ETH_KOVAN]: "Ribbon stETH Earn Vault",
  [CHAINID.AVAX_MAINNET]: "Ribbon stETH Earn Vault",
  [CHAINID.AVAX_FUJI]: "Ribbon stETH Earn Vault",
};

const TOKEN_SYMBOL = {
  [CHAINID.ETH_MAINNET]: "rEARN-stETH",
  [CHAINID.ETH_KOVAN]: "rEARN-stETH",
  [CHAINID.AVAX_MAINNET]: "rEARN-stETH",
  [CHAINID.AVAX_FUJI]: "rEARN-stETH",
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
  console.log(`04 - Deploying stETH Earn Vault on ${network.name}`);

  const chainId = network.config.chainId;

  const lifecycle = await deployments.get("VaultLifecycleEarn");
  const logicDeployment = await deployments.get(
    "RibbonEarnVaultFixedRateLogic"
  );
  const RibbonEarnVault = await ethers.getContractFactory(
    "RibbonEarnVaultFixedRate",
    {
      libraries: {
        VaultLifecycleEarn: lifecycle.address,
      },
    }
  );

  const initArgs = [
    {
      _owner: owner,
      _keeper: keeper,
      _borrowers: [],
      _borrowerWeights: [],
      _optionSeller: OPTION_SELLER.ORBIT,
      _feeRecipient: feeRecipient,
      _managementFee: MANAGEMENT_FEE,
      _performanceFee: PERFORMANCE_FEE,
      _tokenName: TOKEN_NAME[chainId],
      _tokenSymbol: TOKEN_SYMBOL[chainId],
    },
    {
      decimals: 18,
      asset: STETH_ADDRESS[chainId],
      minimumSupply: BigNumber.from(10).pow(18),
      cap: BigNumber.from("2000").mul(BigNumber.from(10).pow(18)),
    },
    {
      nextLoanTermLength: 0,
      nextOptionPurchaseFreq: 0,
      currentLoanTermLength: LOAN_TERM_LENGTH["stETH"],
      currentOptionPurchaseFreq: OPTION_PURCHASE_FREQ["stETH"],
      loanAllocationPCT: LOAN_ALLOCATION_PCT["stETH"],
      optionAllocationPCT: OPTION_ALLOCATION_PCT["stETH"],
      loanAllocation: 0,
      optionAllocation: 0,
    },
  ];

  const initData = RibbonEarnVault.interface.encodeFunctionData(
    "initialize",
    initArgs
  );

  const proxy = await deploy("RibbonEarnVaultSTETH", {
    contract: "AdminUpgradeabilityProxy",
    from: deployer,
    args: [logicDeployment.address, admin, initData],
  });

  console.log(`RibbonEarnVaultSTETH Proxy @ ${proxy.address}`);

  try {
    await run("verify:verify", {
      address: proxy.address,
      constructorArguments: [logicDeployment.address, admin, initData],
    });
  } catch (error) {
    console.log(error);
  }
};
main.tags = ["RibbonEarnVaultSTETH"];
main.dependencies = ["RibbonEarnVaultFixedRateLogic"];

export default main;
