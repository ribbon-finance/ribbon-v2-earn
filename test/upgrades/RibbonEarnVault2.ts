import { ethers, network } from "hardhat";
import { objectEquals, parseLog, serializeMap } from "../helpers/utils";
import deployments from "../../constants/deployments.json";
import { BigNumberish, Contract, constants } from "ethers";
import * as time from "../helpers/time";
import { assert } from "../helpers/assertions";
import { BigNumber } from "ethereum-waffle/node_modules/ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signers";
import { expect } from "chai";
import { parseUnits } from "ethers/lib/utils";
import {
  BIB01_ADDRESS,
  BORROWER_WEIGHTS,
  USDC_ADDRESS,
} from "../../constants/constants";
const { parseEther } = ethers.utils;

const UPGRADE_ADMIN = "0x223d59FA315D7693dF4238d1a5748c964E615923";
const OWNER = "0x43a43D3404eaC5fA1ec4F4BB0879495D500e390b";
const MM = "0x349351261a5266e688807E949701e75F23d97f61";
const KEEPER = "0x55e4b3e3226444Cd4de09778844453bA9fe9cd7c";
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const USER_ACCOUNT_1 = "0x2979eC1e53E1eE9238f52C83164E8F9DF03AD077";
const USER_ACCOUNT_2 = "0xbE0AffE00De6BbdB717d2C7Af7f9fEB45311320d";

const chainId = network.config.chainId;

// UPDATE THESE VALUES BEFORE WE ATTEMPT AN UPGRADE
const FORK_BLOCK = 17961700;

describe("RibbonEarnVault upgrade - fix pps issue", () => {
  let vaults: string[] = [];

  before(async function () {
    // We need to checkpoint the contract on mainnet to a past block before the upgrade happens
    // This means the `implementation` is pointing to an old contract
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.TEST_URI,
            blockNumber: FORK_BLOCK,
          },
        },
      ],
    });

    // Fund & impersonate the admin account
    const [userSigner] = await ethers.getSigners();

    await userSigner.sendTransaction({
      to: UPGRADE_ADMIN,
      value: parseEther("10"),
    });

    await userSigner.sendTransaction({
      to: OWNER,
      value: parseEther("10"),
    });

    await userSigner.sendTransaction({
      to: MM,
      value: parseEther("10"),
    });

    await userSigner.sendTransaction({
      to: USER_ACCOUNT_1,
      value: parseEther("10"),
    });

    await userSigner.sendTransaction({
      to: USER_ACCOUNT_2,
      value: parseEther("10"),
    });

    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [UPGRADE_ADMIN],
    });

    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [OWNER],
    });

    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [MM],
    });

    const deploymentNames = ["RibbonEarnVaultUSDC"];
    deploymentNames.forEach((name) => vaults.push(deployments.mainnet[name]));
  });

  checkTotalBalanceAndRebalance(deployments.mainnet.RibbonEarnVaultUSDC);
});

function checkTotalBalanceAndRebalance(vaultAddress: string) {
  describe(`Vault ${vaultAddress}`, () => {
    let newImplementation: string;
    let vaultProxy: Contract;
    let vault: Contract;
    //let mm: Contract;
    let usdc: Contract;
    /*     let totalBalanceBefore;
    const PENDING_USDC_AMOUNT = 96677244047; */

    time.revertToSnapshotAfterEach();

    before(async () => {
      const adminSigner = await ethers.provider.getSigner(UPGRADE_ADMIN);

      vaultProxy = await ethers.getContractAt(
        "AdminUpgradeabilityProxy",
        vaultAddress,
        adminSigner
      );
      vault = await ethers.getContractAt("RibbonEarnVault", vaultAddress);

      const VaultLifecycle = await ethers.getContractFactory(
        "VaultLifecycleEarn"
      );
      const vaultLifecycleLib = await VaultLifecycle.deploy();

      const RibbonEarnVault = await ethers.getContractFactory(
        "RibbonEarnVault",
        {
          libraries: {
            VaultLifecycleEarn: vaultLifecycleLib.address,
          },
        }
      );

      const newImplementationContract = await RibbonEarnVault.deploy();
      newImplementation = newImplementationContract.address;

      mm = await ethers.getContractAt("MM", deployments.mainnet.MM);

      usdc = await ethers.getContractAt("IWETH", USDC_ADDRESS[chainId]);
    });

    /*     describe("#totalBalance", () => {
      time.revertToSnapshotAfterEach();

      beforeEach(async function () {
        assert.equal(
          (
            await mm.pendingSettledAssetAmount(USDC_ADDRESS[chainId])
          ).toString(),
          PENDING_USDC_AMOUNT
        );

        totalBalanceBefore = await vault.totalBalance();

        await vaultProxy.upgradeTo(newImplementation);
      });

      it("it shows the correct total balance", async () => {
        assert.equal(
          (await vault.totalBalance()).toString(),
          totalBalanceBefore.add(PENDING_USDC_AMOUNT)
        );
      });
    }); */

    describe("#rebalance", () => {
      time.revertToSnapshotAfterEach();

      beforeEach(async function () {
        await vaultProxy.upgradeTo(newImplementation);
      });

      it("correctly rebalances", async () => {
        let ownerSigner = await ethers.provider.getSigner(OWNER);

        const { amount: sharesBeforeUser1 } = await vault.depositReceipts("0x7C6Accd51cbbdd53354De581841803b4f79d48e7");
        const { amount: sharesBeforeUser2 } = await vault.depositReceipts("0xd2aF9D11007147bE1083b1593025fe328fe83D22");
        const { amount: sharesBeforeUser3 } = await vault.depositReceipts("0xB4eC6C18CD9DC4f3D1c378307D4bdDa18DdAe899");
        const { amount: sharesBeforeUser4 } = await vault.depositReceipts("0xcCb8E090Fe070945cC0131a075B6e1EA8F208812");

        const balBeforeUSDCUser1 = await usdc.balanceOf("0x87b675e9219a3b870df51449268b8c8c2241bf0c");
        const balBeforeUSDCUser2 = await usdc.balanceOf("0x87bF44125049a0F6e35f59C4aAc3F650cE70dF36");
        const balBeforeUSDCUser3 = await usdc.balanceOf("0x20A25b6B48691E2B5d0a9B32Ae372cc1BD6E0A04");
        const balBeforeUSDCUser4 = await usdc.balanceOf("0x8c80BeEF1e9ba06098Ff147ee1382B7518E84f17");
        const balBeforeUSDCUser5 = await usdc.balanceOf("0x3006ef6777ccC79C3aF305101Fe0B3D14bd47b59");
        const balBeforeUSDCUser6 = await usdc.balanceOf("0x8d605e606b3AEe143ff0d039F63100a52F17d85F");
        const balBeforeUSDCUser7 = await usdc.balanceOf("0x6F98670A3375B2950Ada1A60842abd1469c284B7");
        const balBeforeUSDCUser8 = await usdc.balanceOf("0x8457F5428dBeEdBBB962c9e56B3a098D90A2d68C");
        const balBeforeUSDCUser9 = await usdc.balanceOf("0x319a6fC1Bd3086E7cbceB3cd4057a4521363ADb8");
        const balBeforeUSDCUser10 = await usdc.balanceOf("0x1Cb7F3EaB52BbE5F6635378b09d4856FB43FF7bE");

        await vault.connect(ownerSigner).rebalance();

        const { amount: sharesAfterUser1 } = await vault.depositReceipts("0x7C6Accd51cbbdd53354De581841803b4f79d48e7");
        const { amount: sharesAfterUser2 } = await vault.depositReceipts("0xd2aF9D11007147bE1083b1593025fe328fe83D22");
        const { amount: sharesAfterUser3 } = await vault.depositReceipts("0xB4eC6C18CD9DC4f3D1c378307D4bdDa18DdAe899");
        const { amount: sharesAfterUser4 } = await vault.depositReceipts("0xcCb8E090Fe070945cC0131a075B6e1EA8F208812");

        const balAfterUSDCUser1 = await usdc.balanceOf("0x87b675e9219a3b870df51449268b8c8c2241bf0c");
        const balAfterUSDCUser2 = await usdc.balanceOf("0x87bF44125049a0F6e35f59C4aAc3F650cE70dF36");
        const balAfterUSDCUser3 = await usdc.balanceOf("0x20A25b6B48691E2B5d0a9B32Ae372cc1BD6E0A04");
        const balAfterUSDCUser4 = await usdc.balanceOf("0x8c80BeEF1e9ba06098Ff147ee1382B7518E84f17");
        const balAfterUSDCUser5 = await usdc.balanceOf("0x3006ef6777ccC79C3aF305101Fe0B3D14bd47b59");
        const balAfterUSDCUser6 = await usdc.balanceOf("0x8d605e606b3AEe143ff0d039F63100a52F17d85F");
        const balAfterUSDCUser7 = await usdc.balanceOf("0x6F98670A3375B2950Ada1A60842abd1469c284B7");
        const balAfterUSDCUser8 = await usdc.balanceOf("0x8457F5428dBeEdBBB962c9e56B3a098D90A2d68C");
        const balAfterUSDCUser9 = await usdc.balanceOf("0x319a6fC1Bd3086E7cbceB3cd4057a4521363ADb8");
        const balAfterUSDCUser10 = await usdc.balanceOf("0x1Cb7F3EaB52BbE5F6635378b09d4856FB43FF7bE");

        assert.equal(sharesBeforeUser1.sub(sharesAfterUser1).toString(), "205009183");
        assert.equal(sharesBeforeUser2.sub(sharesAfterUser2).toString(), "4100184");
        assert.equal(sharesBeforeUser3.sub(sharesAfterUser3).toString(), "227659983");
        assert.equal(sharesBeforeUser4.sub(sharesAfterUser4).toString(), "4100183657");

        assert.equal(balAfterUSDCUser1.sub(balBeforeUSDCUser1).toString(), "1049899");
        assert.equal(balAfterUSDCUser2.sub(balBeforeUSDCUser2).toString(), "1093377");
        assert.equal(balAfterUSDCUser3.sub(balBeforeUSDCUser3).toString(), "506248333");
        assert.equal(balAfterUSDCUser4.sub(balBeforeUSDCUser4).toString(), "28636927");
        assert.equal(balAfterUSDCUser5.sub(balBeforeUSDCUser5).toString(), "4227558");
        assert.equal(balAfterUSDCUser6.sub(balBeforeUSDCUser6).toString(), "141292819");
        assert.equal(balAfterUSDCUser7.sub(balBeforeUSDCUser7).toString(), "139728988");
        assert.equal(balAfterUSDCUser8.sub(balBeforeUSDCUser8).toString(), "805636032");
        assert.equal(balAfterUSDCUser9.sub(balBeforeUSDCUser9).toString(), "1243386554");
        assert.equal(balAfterUSDCUser10.sub(balBeforeUSDCUser10).toString(), "183765396");
      });
    });
  });
}
