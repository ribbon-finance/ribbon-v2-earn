import { run } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const main = async ({
  network,
  deployments,
  getNamedAccounts,
}: HardhatRuntimeEnvironment) => {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  console.log(`01 - Deploying Earn Vault logic on ${network.name}`);

  const chainId = network.config.chainId;

  const lifecycle = await deploy("VaultLifecycleEarn", {
    contract: "VaultLifecycleEarn",
    from: deployer,
  });
  console.log(`VaultLifecycleEarn @ ${lifecycle.address}`);

  const vault = await deploy("RibbonEarnVaultLogic", {
    contract: "RibbonEarnVault",
    from: deployer,
    args: [],
    libraries: {
      VaultLifecycleEarn: lifecycle.address,
    },
  });
  console.log(`RibbonEarnVaultLogic @ ${vault.address}`);

  try {
    await run("verify:verify", {
      address: lifecycle.address,
      constructorArguments: [],
    });
  } catch (error) {
    console.log(error);
  }

  try {
    await run("verify:verify", {
      address: vault.address,
      constructorArguments: [],
    });
  } catch (error) {
    console.log(error);
  }
};
main.tags = ["RibbonEarnVaultLogic"];

export default main;
