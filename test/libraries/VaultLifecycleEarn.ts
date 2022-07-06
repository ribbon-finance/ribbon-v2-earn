import { ethers } from "hardhat";
import { Contract, BigNumber } from "ethers";
import moment from "moment-timezone";
import { assert } from "../helpers/assertions";
import * as time from "../helpers/time";
moment.tz.setDefault("UTC");

const provider = ethers.provider;

describe("VaultLifecycle", () => {
  let lifecycle: Contract;

  before(async () => {
    const VaultLifecycle = await ethers.getContractFactory(
      "VaultLifecycleEarn"
    );
    const lifecycleLib = await VaultLifecycle.deploy();

    const TestVaultLifecycle = await ethers.getContractFactory(
      "TestVaultLifecycle",
      { libraries: { VaultLifecycle: lifecycleLib.address } }
    );
    lifecycle = await TestVaultLifecycle.deploy();
  });

  describe("getNextFriday", () => {
    time.revertToSnapshotAfterEach(async () => {});
  });
});
