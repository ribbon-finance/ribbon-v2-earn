import { run } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import {
  NETWORK_NAMES,
  STETH_ADDRESS,
  STETH_ETH_CRV_POOL,
} from "../../constants/constants";

const main = async ({
  network,
  deployments,
  getNamedAccounts,
}: HardhatRuntimeEnvironment) => {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  console.log(`05 - Deploying stETH Deposit Helper on ${network.name}`);

  const chainId = network.config.chainId;

  const stethEarnVault = await deployments.get("RibbonEarnVaultSTETH");

  const constructorArguments = [
    STETH_ETH_CRV_POOL,
    stethEarnVault.address,
    STETH_ADDRESS[chainId],
  ];

  const stETHDepositHelper = await deploy("RibbonEarnVaultFixedRateLogic", {
    contract: "RibbonEarnVaultFixedRate",
    from: deployer,
    args: constructorArguments,
  });

  console.log(`STETH Deposit Helper @ ${stETHDepositHelper.address}`);

  try {
    await run("verify:verify", {
      address: stETHDepositHelper.address,
      constructorArguments: constructorArguments,
    });
  } catch (error) {
    console.log(error);
  }
};
main.tags = ["STETHDepositHelper"];
main.dependencies = ["RibbonEarnVaultSTETH"];

export default main;
