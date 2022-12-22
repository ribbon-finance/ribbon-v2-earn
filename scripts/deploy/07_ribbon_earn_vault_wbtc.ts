import { run } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { CHAINID, WBTC_ADDRESS } from "../../constants/constants";
import { OPTION_SELLER } from "../utils/constants";

const TOKEN_NAME = {
  [CHAINID.ETH_MAINNET]: "Ribbon wBTC Earn Vault",
  [CHAINID.ETH_KOVAN]: "Ribbon wBTC Earn Vault",
  [CHAINID.AVAX_MAINNET]: "Ribbon wBTC Earn Vault",
  [CHAINID.AVAX_FUJI]: "Ribbon wBTC Earn Vault",
};

const TOKEN_SYMBOL = {
  [CHAINID.ETH_MAINNET]: "rEARN-wBTC",
  [CHAINID.ETH_KOVAN]: "rEARN-wBTC",
  [CHAINID.AVAX_MAINNET]: "rEARN-wBTC",
  [CHAINID.AVAX_FUJI]: "rEARN-wBTC",
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
  console.log(`07 - Deploying wBTC Earn Vault on ${network.name}`);

  const chainId = network.config.chainId;

  const lifecycle = await deployments.get("VaultLifecycleEarn");
  const logicDeployment = await deployments.get(
    "RibbonEarnVaultFixedRateKeeperPermissionedLogic"
  );
  const RibbonEarnVault = await ethers.getContractFactory(
    "RibbonEarnVaultFixedRateKeeperPermissioned",
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
      _optionSeller: OPTION_SELLER.ORBIT_TWO,
      _feeRecipient: feeRecipient,
      _managementFee: 0,
      _performanceFee: 0,
      _tokenName: TOKEN_NAME[chainId],
      _tokenSymbol: TOKEN_SYMBOL[chainId],
    },
    {
      decimals: 8,
      asset: WBTC_ADDRESS[chainId],
      minimumSupply: 0,
      cap: BigNumber.from("5000000000"), // 50 wBTC
    },
    {
      nextLoanTermLength: 0,
      nextOptionPurchaseFreq: 0,
      currentLoanTermLength: BigNumber.from("30").mul(86400), // 30 days
      currentOptionPurchaseFreq: BigNumber.from("30").mul(86400), // 30 days
      loanAllocationPCT: 0,
      optionAllocationPCT: 1000000, // 100%
      loanAllocation: 0,
      optionAllocation: 0,
    },
  ];

  const initData = RibbonEarnVault.interface.encodeFunctionData(
    "initialize",
    initArgs
  );

  const proxy = await deploy("RibbonEarnVaultWBTC", {
    contract: "AdminUpgradeabilityProxy",
    from: deployer,
    args: [logicDeployment.address, admin, initData],
  });

  console.log(`RibbonEarnVaultWBTC Proxy @ ${proxy.address}`);

  try {
    await run("verify:verify", {
      address: proxy.address,
      constructorArguments: [logicDeployment.address, admin, initData],
    });
  } catch (error) {
    console.log(error);
  }
};
main.tags = ["RibbonEarnVaultWBTC"];
main.dependencies = ["RibbonEarnVaultFixedRateKeeperPermissionedLogic"];

export default main;
