import { run } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { NETWORK_NAMES } from "../../constants/constants";
import { SET_PRODUCT_TIMELOCK, MIN_PROVIDER_SWAP } from "../utils/constants";

import { BigNumber } from "ethers";

const main = async ({
  network,
  deployments,
  getNamedAccounts,
}: HardhatRuntimeEnvironment) => {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  console.log(`07 - Deploying MM on ${network.name}`);

  const chainId = network.config.chainId;
  const networkName = NETWORK_NAMES[chainId];

  const ribbonEarnUSDCVault = await deployments.get("RibbonEarnVaultUSDC");

  const constructorArguments = [
    ribbonEarnUSDCVault.address,
    SET_PRODUCT_TIMELOCK,
    MIN_PROVIDER_SWAP,
  ];

  const mm = await deploy(`MM`, {
    from: deployer,
    contract: "MM",
    args: constructorArguments,
    value: BigNumber.from("1"),
  });

  console.log(`MM${networkName} @ ${mm.address}`);

  try {
    await run("verify:verify", {
      address: mm.address,
      constructorArguments,
    });
  } catch (error) {
    console.log(error);
  }
};
main.tags = ["MM"];
main.dependencies = ["RibbonEarnVaultUSDC"];

export default main;
