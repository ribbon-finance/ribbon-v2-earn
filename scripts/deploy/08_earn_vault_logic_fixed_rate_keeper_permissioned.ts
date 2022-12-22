import { run } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const main = async ({
  network,
  deployments,
  getNamedAccounts,
}: HardhatRuntimeEnvironment) => {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  console.log(
    `08 - Deploying Earn Vault Fixed Rate Keeper Permissioned logic on ${network.name}`
  );

  const lifecycle = await deploy("VaultLifecycleEarn", {
    contract: "VaultLifecycleEarn",
    from: deployer,
  });
  console.log(`VaultLifecycleEarn @ ${lifecycle.address}`);

  const vault = await deploy(
    "RibbonEarnVaultFixedRateKeeperPermissionedLogic",
    {
      contract: "RibbonEarnVaultFixedRateKeeperPermissioned",
      from: deployer,
      args: [],
      libraries: {
        VaultLifecycleEarn: lifecycle.address,
      },
    }
  );
  console.log(
    `RibbonEarnVaultFixedRateKeeperPermissionedLogic @ ${vault.address}`
  );

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
main.tags = ["RibbonEarnVaultFixedRateLogic"];

export default main;
