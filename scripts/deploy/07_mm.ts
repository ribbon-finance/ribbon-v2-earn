import { run } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import {
  NETWORK_NAMES,
} from "../../constants/constants";

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

  const constructorArguments = [ribbonEarnUSDCVault.address];

  const mm = await deploy(`MM:${networkName}`, {
    from: deployer,
    contract: "MM",
    args: constructorArguments,
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

export default main;
