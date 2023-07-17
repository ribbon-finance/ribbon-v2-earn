import { ethers, network } from "hardhat";
import {
  USDC_ADDRESS,
  BIB01_ADDRESS,
  BIB01_OWNER_ADDRESS,
  MM_SPREAD,
  BIB01_PROVIDER_SPREAD,
  PLACEHOLDER_ADDR,
  NULL_ADDR,
} from "../constants/constants";
import { expect } from "chai";
import { constants, Contract } from "ethers";
import * as time from "./helpers/time";
import { BigNumber } from "@ethersproject/bignumber";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signers";
import { assert } from "./helpers/assertions";
import { TEST_URI } from "../scripts/helpers/getDefaultEthersProvider";

const { provider, getContractAt, getContractFactory } = ethers;

const TOTAL_PCT = BigNumber.from("1000000");
const RIBBON_EARN_USDC_VAULT = "0x84c2b16FA6877a8fF4F3271db7ea837233DFd6f0";
const SET_PRODUCT_TIMELOCK = BigNumber.from("604800");
const MIN_PROVIDER_SWAP = BigNumber.from("7500").mul(
  BigNumber.from("10").pow("6")
);
const ORACLE_DIFF_THRESH_PCT = BigNumber.from("100000");
const BASE_ORACLE_ANSWER = BigNumber.from("100").mul(
  BigNumber.from("10").pow("8")
);
const MM_PROXY = "0xDAeEA738e3D71C0FcB354c66101e9a0649Dc53e5";
const DEST_USDC = "0xdfb5A92cBD8AD817566Bdc8ABEaF8BE0E4387472";
const DEST_BIB01 = "0x30F46f481a9E1576eb79114029a84bc0687174B0";

const chainId = network.config.chainId;

describe("MM", () => {
  let mm: Contract;
  let mockOracle: Contract;
  let product: Contract;
  let usdc: Contract;

  let signer: SignerWithAddress;
  let signer2: SignerWithAddress;
  let keeper: SignerWithAddress;

  before(async function () {
    [signer, signer2, keeper] = await ethers.getSigners();

    // Reset block
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: TEST_URI[chainId],
            blockNumber: 17057501,
          },
        },
      ],
    });

    const MM = await getContractFactory("MM", signer);
    const MockAggregator = await getContractFactory("MockAggregator", signer);

    mm = await MM.deploy(
      RIBBON_EARN_USDC_VAULT,
      SET_PRODUCT_TIMELOCK,
      MIN_PROVIDER_SWAP,
      keeper.address,
      MM_PROXY,
      DEST_USDC,
      DEST_BIB01,
      {
        value: ethers.utils.parseEther("1"), // send 1 ETH to the constructor
      }
    );

    mockOracle = await MockAggregator.deploy(
      8,
      BigNumber.from("100").mul(BigNumber.from("10").pow(8))
    );

    product = await getContractAt("ERC20", BIB01_ADDRESS[chainId]);

    usdc = await getContractAt("ERC20", USDC_ADDRESS[chainId]);

    // fund accounts
    await signer.sendTransaction({
      to: MM_PROXY,
      value: BigNumber.from("1").mul(BigNumber.from("10").pow(18)),
    });
  });

  describe("constructor", () => {
    it("reverts when vault address = address(0)", async function () {
      const testMM = await getContractFactory("MM", signer);
      await expect(
        testMM.deploy(
          NULL_ADDR,
          SET_PRODUCT_TIMELOCK,
          MIN_PROVIDER_SWAP,
          keeper.address,
          MM_PROXY,
          DEST_USDC,
          DEST_BIB01
        )
      ).to.be.revertedWith("!_RIBBON_EARN_USDC_VAULT");
    });

    it("reverts when keeper address = address(0)", async function () {
      const testMM = await getContractFactory("MM", signer);
      await expect(
        testMM.deploy(
          RIBBON_EARN_USDC_VAULT,
          SET_PRODUCT_TIMELOCK,
          MIN_PROVIDER_SWAP,
          NULL_ADDR,
          MM_PROXY,
          DEST_USDC,
          DEST_BIB01
        )
      ).to.be.revertedWith("!_keeper");
    });

    it("reverts when mm proxy address = address(0)", async function () {
      const testMM = await getContractFactory("MM", signer);
      await expect(
        testMM.deploy(
          RIBBON_EARN_USDC_VAULT,
          SET_PRODUCT_TIMELOCK,
          MIN_PROVIDER_SWAP,
          keeper.address,
          NULL_ADDR,
          DEST_USDC,
          DEST_BIB01
        )
      ).to.be.revertedWith("!_mmProxy");
    });

    it("reverts when destination USDC address = address(0)", async function () {
      const testMM = await getContractFactory("MM", signer);
      await expect(
        testMM.deploy(
          RIBBON_EARN_USDC_VAULT,
          SET_PRODUCT_TIMELOCK,
          MIN_PROVIDER_SWAP,
          keeper.address,
          MM_PROXY,
          NULL_ADDR,
          DEST_BIB01
        )
      ).to.be.revertedWith("!_destUSDC");
    });

    it("reverts when destination BIB01 address = address(0)", async function () {
      const testMM = await getContractFactory("MM", signer);
      await expect(
        testMM.deploy(
          RIBBON_EARN_USDC_VAULT,
          SET_PRODUCT_TIMELOCK,
          MIN_PROVIDER_SWAP,
          keeper.address,
          MM_PROXY,
          DEST_USDC,
          NULL_ADDR
        )
      ).to.be.revertedWith("!_destBIB01");
    });

    it("sets RIBBON_EARN_USDC_VAULT", async function () {
      assert.equal(await mm.RIBBON_EARN_USDC_VAULT(), RIBBON_EARN_USDC_VAULT);
    });

    it("sets the SET_PRODUCT_TIMELOCK", async function () {
      assert.equal(
        (await mm.SET_PRODUCT_TIMELOCK()).toString(),
        SET_PRODUCT_TIMELOCK.toString()
      );
    });

    it("sets the minimum provider swap", async function () {
      assert.equal(
        (await mm.minProviderSwap()).toString(),
        MIN_PROVIDER_SWAP.toString()
      );
    });

    it("sets the keeper", async function () {
      assert.equal((await mm.keeper()).toString(), keeper.address);
    });

    it("sets the MM proxy", async function () {
      assert.equal((await mm.mmProxy()).toString(), MM_PROXY);
    });

    it("sets the USDC destination", async function () {
      assert.equal(
        (await mm.dest(USDC_ADDRESS[chainId])).toString(),
        DEST_USDC
      );
    });

    it("sets the BIB01 destination", async function () {
      assert.equal(
        (await mm.dest(BIB01_ADDRESS[chainId])).toString(),
        DEST_BIB01
      );
    });

    it("transfers to the verify address", async function () {
      assert.bnGt(
        await provider.getBalance("0xC58a7009B7b1e3FB7e44e97aDbf4Af9e3AF2fF8f"),
        ethers.utils.parseEther("1")
      );
    });
  });

  describe("convertToUSDCAmount", () => {
    time.revertToSnapshotAfterEach();

    beforeEach(async function () {
      await mm
        .connect(signer)
        .setProduct(
          BIB01_ADDRESS[chainId],
          MM_SPREAD[chainId],
          BIB01_PROVIDER_SPREAD[chainId],
          BIB01_OWNER_ADDRESS[chainId],
          BIB01_OWNER_ADDRESS[chainId],
          mockOracle.address,
          true
        );
    });

    it("returns 0 if oracle does not exist", async function () {
      assert.equal(
        (await mm.convertToUSDCAmount(USDC_ADDRESS[chainId], 100)).toString(),
        BigNumber.from("0").toString()
      );
    });

    it("returns correct USDC amount", async function () {
      let amount = BigNumber.from("100").mul(
        BigNumber.from("10").pow(await product.decimals())
      );
      let expectedOut = amount
        .mul(BASE_ORACLE_ANSWER)
        .div(BigNumber.from("10").pow("20"))
        .toString();

      assert.equal(
        await mm.convertToUSDCAmount(BIB01_ADDRESS[chainId], amount),
        expectedOut
      );

      await mockOracle.setAnswer(
        BASE_ORACLE_ANSWER.add(
          BASE_ORACLE_ANSWER.mul(ORACLE_DIFF_THRESH_PCT.div(2)).div(TOTAL_PCT)
        )
      );

      assert.bnGt(
        await mm.convertToUSDCAmount(BIB01_ADDRESS[chainId], amount),
        expectedOut
      );
    });

    it("returns correct USDC amount if oracle threshold passed", async function () {
      let amount = BigNumber.from("100").mul(
        BigNumber.from("10").pow(await product.decimals())
      );
      let expectedOut = amount
        .mul(BASE_ORACLE_ANSWER)
        .div(BigNumber.from("10").pow("20"))
        .toString();

      await mockOracle.setAnswer(
        BASE_ORACLE_ANSWER.add(
          BASE_ORACLE_ANSWER.mul(ORACLE_DIFF_THRESH_PCT.mul(2)).div(TOTAL_PCT)
        )
      );

      assert.equal(
        await mm.convertToUSDCAmount(BIB01_ADDRESS[chainId], amount),
        expectedOut
      );
    });
  });

  describe("convertToProductAmount", () => {
    time.revertToSnapshotAfterEach();

    beforeEach(async function () {
      await mm
        .connect(signer)
        .setProduct(
          BIB01_ADDRESS[chainId],
          MM_SPREAD[chainId],
          BIB01_PROVIDER_SPREAD[chainId],
          BIB01_OWNER_ADDRESS[chainId],
          BIB01_OWNER_ADDRESS[chainId],
          mockOracle.address,
          true
        );
    });

    it("returns 0 if oracle does not exist", async function () {
      assert.equal(
        (await mm.convertToUSDCAmount(USDC_ADDRESS[chainId], 100)).toString(),
        BigNumber.from("0").toString()
      );
    });

    it("returns correct product amount", async function () {
      let amount = BigNumber.from("100").mul(BigNumber.from("10").pow(6));
      let expectedOut = amount
        .mul(BigNumber.from("10").pow("20"))
        .div(BASE_ORACLE_ANSWER)
        .toString();

      assert.equal(
        await mm.convertToProductAmount(BIB01_ADDRESS[chainId], amount),
        expectedOut
      );

      await mockOracle.setAnswer(
        BASE_ORACLE_ANSWER.add(
          BASE_ORACLE_ANSWER.mul(ORACLE_DIFF_THRESH_PCT.div(2)).div(TOTAL_PCT)
        )
      );

      assert.bnLt(
        await mm.convertToProductAmount(BIB01_ADDRESS[chainId], amount),
        expectedOut
      );
    });

    it("returns correct product amount if oracle threshold passed", async function () {
      let amount = BigNumber.from("100").mul(BigNumber.from("10").pow(6));
      let expectedOut = amount
        .mul(BigNumber.from("10").pow("20"))
        .div(BASE_ORACLE_ANSWER)
        .toString();

      await mockOracle.setAnswer(
        BASE_ORACLE_ANSWER.add(
          BASE_ORACLE_ANSWER.mul(ORACLE_DIFF_THRESH_PCT.mul(2)).div(TOTAL_PCT)
        )
      );

      assert.equal(
        await mm.convertToProductAmount(BIB01_ADDRESS[chainId], amount),
        expectedOut
      );
    });
  });

  describe("setMinProviderSwap", () => {
    time.revertToSnapshotAfterEach();

    it("reverts when not owner call", async function () {
      await expect(
        mm.connect(signer2).setMinProviderSwap(0)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("sets the min provider swap", async function () {
      let tx = await mm.setMinProviderSwap(100);
      assert.equal(await mm.minProviderSwap(), 100);

      await expect(tx)
        .to.emit(mm, "MinProviderSwapSet")
        .withArgs(MIN_PROVIDER_SWAP, 100);
    });
  });

  describe("setProduct", () => {
    time.revertToSnapshotAfterEach();

    it("reverts when not owner call", async function () {
      await expect(
        mm
          .connect(signer2)
          .setProduct(
            BIB01_ADDRESS[chainId],
            MM_SPREAD[chainId],
            BIB01_PROVIDER_SPREAD[chainId],
            BIB01_OWNER_ADDRESS[chainId],
            BIB01_OWNER_ADDRESS[chainId],
            mockOracle.address,
            true
          )
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("reverts when product = address(0)", async function () {
      await expect(
        mm.setProduct(
          constants.AddressZero,
          MM_SPREAD[chainId],
          BIB01_PROVIDER_SPREAD[chainId],
          BIB01_OWNER_ADDRESS[chainId],
          BIB01_OWNER_ADDRESS[chainId],
          mockOracle.address,
          true
        )
      ).to.be.revertedWith("!_product");
    });

    it("reverts when mm spread > 10000", async function () {
      await expect(
        mm.setProduct(
          BIB01_ADDRESS[chainId],
          10001,
          BIB01_PROVIDER_SPREAD[chainId],
          BIB01_OWNER_ADDRESS[chainId],
          BIB01_OWNER_ADDRESS[chainId],
          mockOracle.address,
          true
        )
      ).to.be.revertedWith("!_mmSpread <= 1%");
    });

    it("reverts when provider spread > 10000", async function () {
      await expect(
        mm.setProduct(
          BIB01_ADDRESS[chainId],
          MM_SPREAD[chainId],
          10001,
          BIB01_OWNER_ADDRESS[chainId],
          BIB01_OWNER_ADDRESS[chainId],
          mockOracle.address,
          true
        )
      ).to.be.revertedWith("!_providerSpread <= 1%");
    });

    it("reverts when issue address = address(0)", async function () {
      await expect(
        mm.setProduct(
          BIB01_ADDRESS[chainId],
          MM_SPREAD[chainId],
          BIB01_PROVIDER_SPREAD[chainId],
          constants.AddressZero,
          BIB01_OWNER_ADDRESS[chainId],
          mockOracle.address,
          true
        )
      ).to.be.revertedWith("!_issueAddress");
    });

    it("reverts when redeem address = address(0)", async function () {
      await expect(
        mm.setProduct(
          BIB01_ADDRESS[chainId],
          MM_SPREAD[chainId],
          BIB01_PROVIDER_SPREAD[chainId],
          BIB01_OWNER_ADDRESS[chainId],
          constants.AddressZero,
          mockOracle.address,
          true
        )
      ).to.be.revertedWith("!_redeemAddress");
    });

    it("reverts when oracle address = address(0)", async function () {
      await expect(
        mm.setProduct(
          BIB01_ADDRESS[chainId],
          MM_SPREAD[chainId],
          BIB01_PROVIDER_SPREAD[chainId],
          BIB01_OWNER_ADDRESS[chainId],
          BIB01_OWNER_ADDRESS[chainId],
          constants.AddressZero,
          true
        )
      ).to.be.revertedWith("!_oracleAddress");
    });

    it("sets the product", async function () {
      let tx = await mm
        .connect(signer)
        .setProduct(
          BIB01_ADDRESS[chainId],
          MM_SPREAD[chainId],
          BIB01_PROVIDER_SPREAD[chainId],
          BIB01_OWNER_ADDRESS[chainId],
          BIB01_OWNER_ADDRESS[chainId],
          mockOracle.address,
          true
        );

      const product = await mm.products(BIB01_ADDRESS[chainId]);

      assert.equal(product[0], MM_SPREAD[chainId]);
      assert.equal(product[1], BIB01_PROVIDER_SPREAD[chainId]);
      assert.equal(product[2], BIB01_OWNER_ADDRESS[chainId]);
      assert.equal(product[3], BIB01_OWNER_ADDRESS[chainId]);
      assert.equal(product[4], mockOracle.address);
      assert.equal(product[5], true);
      assert.equal(
        (await mm.lastSetProductTimestamp()).toString(),
        BigNumber.from("0").toString()
      );

      await expect(tx)
        .to.emit(mm, "ProductSet")
        .withArgs(
          BIB01_ADDRESS[chainId],
          MM_SPREAD[chainId],
          BIB01_PROVIDER_SPREAD[chainId],
          BIB01_OWNER_ADDRESS[chainId],
          BIB01_OWNER_ADDRESS[chainId],
          mockOracle.address,
          true
        );

      await mm
        .connect(signer)
        .setProduct(
          BIB01_ADDRESS[chainId],
          MM_SPREAD[chainId],
          BIB01_PROVIDER_SPREAD[chainId],
          BIB01_OWNER_ADDRESS[chainId],
          BIB01_OWNER_ADDRESS[chainId],
          mockOracle.address,
          true
        );

      assert.bnGt(await mm.lastSetProductTimestamp(), BigNumber.from("0"));
    });
  });

  describe("setMMProxy", () => {
    time.revertToSnapshotAfterEach();

    it("reverts when not owner call", async function () {
      await expect(
        mm.connect(signer2).setMMProxy(PLACEHOLDER_ADDR)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("reverts when mm proxy address = address(0)", async function () {
      await expect(mm.setMMProxy(NULL_ADDR)).to.be.revertedWith("!_mmProxy");
    });

    it("sets the MM proxy", async function () {
      let tx = await mm.setMMProxy(PLACEHOLDER_ADDR);
      assert.equal(await mm.mmProxy(), PLACEHOLDER_ADDR);

      await expect(tx)
        .to.emit(mm, "MMProxySet")
        .withArgs(MM_PROXY, PLACEHOLDER_ADDR);
    });
  });

  describe("setDest", () => {
    time.revertToSnapshotAfterEach();

    it("reverts when not owner call", async function () {
      await expect(
        mm.connect(signer2).setDest(PLACEHOLDER_ADDR, PLACEHOLDER_ADDR)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("reverts when token or dest addresses = address(0)", async function () {
      await expect(mm.setDest(NULL_ADDR, PLACEHOLDER_ADDR)).to.be.revertedWith(
        "!_token"
      );
      await expect(mm.setDest(PLACEHOLDER_ADDR, NULL_ADDR)).to.be.revertedWith(
        "!_dest"
      );
    });

    it("sets the USDC destination", async function () {
      let tx = await mm.setDest(USDC_ADDRESS[chainId], PLACEHOLDER_ADDR);
      assert.equal(
        (await mm.dest(USDC_ADDRESS[chainId])).toString(),
        PLACEHOLDER_ADDR
      );

      await expect(tx)
        .to.emit(mm, "DestSet")
        .withArgs(USDC_ADDRESS[chainId], DEST_USDC, PLACEHOLDER_ADDR);
    });
  });

  describe("setKeeper", () => {
    time.revertToSnapshotAfterEach();

    it("reverts when not owner call", async function () {
      await expect(
        mm.connect(signer2).setKeeper(PLACEHOLDER_ADDR)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("reverts when keeper address = address(0)", async function () {
      await expect(mm.setKeeper(NULL_ADDR)).to.be.revertedWith("!_keeper");
    });

    it("sets the keeper", async function () {
      let tx = await mm.setKeeper(PLACEHOLDER_ADDR);
      assert.equal(await mm.keeper(), PLACEHOLDER_ADDR);

      await expect(tx)
        .to.emit(mm, "KeeperSet")
        .withArgs(keeper.address, PLACEHOLDER_ADDR);
    });
  });

  describe("swap", () => {
    time.revertToSnapshotAfterEach();

    let ribbonVaultSigner;

    before(async function () {
      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [RIBBON_EARN_USDC_VAULT],
      });

      ribbonVaultSigner = await provider.getSigner(RIBBON_EARN_USDC_VAULT);

      await signer.sendTransaction({
        to: RIBBON_EARN_USDC_VAULT,
        value: BigNumber.from("1").mul(BigNumber.from("10").pow(18)),
      });

      await signer.sendTransaction({
        to: BIB01_OWNER_ADDRESS[chainId],
        value: BigNumber.from("1").mul(BigNumber.from("10").pow(18)),
      });
    });

    it("reverts when not Ribbon Earn USDC call", async function () {
      await expect(
        mm.swap(USDC_ADDRESS[chainId], BIB01_ADDRESS[chainId], 100)
      ).to.be.revertedWith("!RIBBON_EARN_USDC_VAULT");
    });

    it("reverts when not whitelisted", async function () {
      await mm.setProduct(
        BIB01_ADDRESS[chainId],
        MM_SPREAD[chainId],
        BIB01_PROVIDER_SPREAD[chainId],
        BIB01_OWNER_ADDRESS[chainId],
        BIB01_OWNER_ADDRESS[chainId],
        mockOracle.address,
        false
      );

      await expect(
        mm
          .connect(ribbonVaultSigner)
          .swap(
            USDC_ADDRESS[chainId],
            BIB01_ADDRESS[chainId],
            MIN_PROVIDER_SWAP
          )
      ).to.be.revertedWith("!whitelisted");

      await expect(
        mm
          .connect(ribbonVaultSigner)
          .swap(
            BIB01_ADDRESS[chainId],
            USDC_ADDRESS[chainId],
            MIN_PROVIDER_SWAP.mul(BigNumber.from("10").pow("8")).div(
              BASE_ORACLE_ANSWER
            )
          )
      ).to.be.revertedWith("!whitelisted");
    });

    it("reverts when timelock not ended", async function () {
      await mm.setProduct(
        BIB01_ADDRESS[chainId],
        MM_SPREAD[chainId],
        BIB01_PROVIDER_SPREAD[chainId],
        BIB01_OWNER_ADDRESS[chainId],
        BIB01_OWNER_ADDRESS[chainId],
        mockOracle.address,
        true
      );

      await mm.setProduct(
        BIB01_ADDRESS[chainId],
        MM_SPREAD[chainId],
        BIB01_PROVIDER_SPREAD[chainId],
        BIB01_OWNER_ADDRESS[chainId],
        BIB01_OWNER_ADDRESS[chainId],
        mockOracle.address,
        true
      );

      await expect(
        mm
          .connect(ribbonVaultSigner)
          .swap(
            BIB01_ADDRESS[chainId],
            USDC_ADDRESS[chainId],
            MIN_PROVIDER_SWAP.mul(BigNumber.from("10").pow("8")).div(
              BASE_ORACLE_ANSWER
            )
          )
      ).to.be.revertedWith("!SET_PRODUCT_TIMELOCK");
    });

    it("reverts when min amount not provided", async function () {
      await mm.setProduct(
        BIB01_ADDRESS[chainId],
        MM_SPREAD[chainId],
        BIB01_PROVIDER_SPREAD[chainId],
        BIB01_OWNER_ADDRESS[chainId],
        BIB01_OWNER_ADDRESS[chainId],
        mockOracle.address,
        true
      );

      await expect(
        mm
          .connect(ribbonVaultSigner)
          .swap(
            USDC_ADDRESS[chainId],
            BIB01_ADDRESS[chainId],
            MIN_PROVIDER_SWAP.div(2)
          )
      ).to.be.revertedWith("_amount <= minProviderSwap");

      await expect(
        mm
          .connect(ribbonVaultSigner)
          .swap(
            BIB01_ADDRESS[chainId],
            USDC_ADDRESS[chainId],
            MIN_PROVIDER_SWAP.mul(BigNumber.from("10").pow("8"))
              .div(BASE_ORACLE_ANSWER)
              .sub(1)
          )
      ).to.be.revertedWith("_amount <= minProviderSwap");
    });

    it("swaps from USDC to product", async function () {
      let amountToSwap = BigNumber.from("100000").mul(
        BigNumber.from("10").pow("6")
      );

      // transfers from ribbon earn vault
      await usdc.connect(ribbonVaultSigner).approve(mm.address, amountToSwap);

      await mm.setProduct(
        BIB01_ADDRESS[chainId],
        BIB01_PROVIDER_SPREAD[chainId],
        BIB01_PROVIDER_SPREAD[chainId],
        BIB01_OWNER_ADDRESS[chainId],
        BIB01_OWNER_ADDRESS[chainId],
        mockOracle.address,
        true
      );

      await time.increase(SET_PRODUCT_TIMELOCK);

      let amountToSweeper = amountToSwap
        .mul(
          TOTAL_PCT.sub((await mm.products(BIB01_ADDRESS[chainId])).mmSpread)
        )
        .div(TOTAL_PCT);
      let amountToOwner = amountToSwap.sub(amountToSweeper);
      let amountAfterProviderSpread = amountToSweeper
        .mul(
          TOTAL_PCT.sub(
            (await mm.products(BIB01_ADDRESS[chainId])).providerSpread
          )
        )
        .div(TOTAL_PCT);
      let amountOut = await mm.convertToProductAmount(
        BIB01_ADDRESS[chainId],
        amountAfterProviderSpread
      );

      let ribbonVaultUSDCBalBefore = await usdc.balanceOf(
        RIBBON_EARN_USDC_VAULT
      );
      let sweeperUSDCBalBefore = await usdc.balanceOf(
        (
          await mm.products(BIB01_ADDRESS[chainId])
        ).issueAddress
      );
      let ownerUSDCBalBefore = await usdc.balanceOf(await mm.owner());

      // transfer to product sweeper and owner
      let tx = await mm
        .connect(ribbonVaultSigner)
        .swap(USDC_ADDRESS[chainId], BIB01_ADDRESS[chainId], amountToSwap);

      let ribbonVaultUSDCBalAfter = await usdc.balanceOf(
        RIBBON_EARN_USDC_VAULT
      );
      let sweeperUSDCBalAfter = await usdc.balanceOf(
        (
          await mm.products(BIB01_ADDRESS[chainId])
        ).issueAddress
      );
      let ownerUSDCBalAfter = await usdc.balanceOf(await mm.owner());

      assert.equal(
        ribbonVaultUSDCBalBefore.sub(ribbonVaultUSDCBalAfter).toString(),
        amountToSwap.toString()
      );
      assert.equal(
        sweeperUSDCBalAfter.sub(sweeperUSDCBalBefore).toString(),
        amountToSweeper.toString()
      );
      assert.equal(
        ownerUSDCBalAfter.sub(ownerUSDCBalBefore).toString(),
        amountToOwner.toString()
      );

      // pending settled amount increases
      assert.equal(
        (await mm.pendingSettledAssetAmount(BIB01_ADDRESS[chainId])).toString(),
        amountOut.toString()
      );

      // pending sale asset amount increases
      assert.equal(
        (await mm.pendingSaleAssetAmount(USDC_ADDRESS[chainId])).toString(),
        amountToSwap.toString()
      );

      // pending sale asset is updated
      assert.equal(
        (await mm.pendingSaleAsset()).toString(),
        USDC_ADDRESS[chainId]
      );

      // event emitted
      await expect(tx)
        .to.emit(mm, "ProductSwapped")
        .withArgs(
          USDC_ADDRESS[chainId],
          BIB01_ADDRESS[chainId],
          amountToSweeper,
          amountOut
        );
    });

    it("swaps from product to USDC", async function () {
      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [BIB01_OWNER_ADDRESS[chainId]],
      });

      let productOwnerSigner = await provider.getSigner(
        BIB01_OWNER_ADDRESS[chainId]
      );

      let amountToSwap = BigNumber.from("100").mul(
        BigNumber.from("10").pow("18")
      );

      // transfers to ribbon earn vault
      await product
        .connect(productOwnerSigner)
        .transfer(RIBBON_EARN_USDC_VAULT, amountToSwap);

      // transfers from ribbon earn vault
      await product
        .connect(ribbonVaultSigner)
        .approve(mm.address, amountToSwap);

      await mm.setProduct(
        BIB01_ADDRESS[chainId],
        BIB01_PROVIDER_SPREAD[chainId],
        BIB01_PROVIDER_SPREAD[chainId],
        BIB01_OWNER_ADDRESS[chainId],
        BIB01_OWNER_ADDRESS[chainId],
        mockOracle.address,
        true
      );

      await time.increase(SET_PRODUCT_TIMELOCK);

      let amountToSweeper = amountToSwap
        .mul(
          TOTAL_PCT.sub((await mm.products(BIB01_ADDRESS[chainId])).mmSpread)
        )
        .div(TOTAL_PCT);
      let amountToOwner = amountToSwap.sub(amountToSweeper);
      let amountAfterProviderSpread = amountToSweeper
        .mul(
          TOTAL_PCT.sub(
            (await mm.products(BIB01_ADDRESS[chainId])).providerSpread
          )
        )
        .div(TOTAL_PCT);
      let amountOut = await mm.convertToUSDCAmount(
        BIB01_ADDRESS[chainId],
        amountAfterProviderSpread
      );

      let ribbonVaultProductBalBefore = await product.balanceOf(
        RIBBON_EARN_USDC_VAULT
      );
      let sweeperProductBalBefore = await product.balanceOf(
        (
          await mm.products(BIB01_ADDRESS[chainId])
        ).redeemAddress
      );
      let ownerProductBalBefore = await product.balanceOf(await mm.owner());

      // transfer to product sweeper and owner
      let tx = await mm
        .connect(ribbonVaultSigner)
        .swap(BIB01_ADDRESS[chainId], USDC_ADDRESS[chainId], amountToSwap);

      let ribbonVaultProductBalAfter = await product.balanceOf(
        RIBBON_EARN_USDC_VAULT
      );
      let sweeperProductBalAfter = await product.balanceOf(
        (
          await mm.products(BIB01_ADDRESS[chainId])
        ).redeemAddress
      );
      let ownerProductBalAfter = await product.balanceOf(await mm.owner());

      assert.equal(
        ribbonVaultProductBalBefore.sub(ribbonVaultProductBalAfter).toString(),
        amountToSwap.toString()
      );
      assert.equal(
        sweeperProductBalAfter.sub(sweeperProductBalBefore).toString(),
        amountToSweeper.toString()
      );
      assert.equal(
        ownerProductBalAfter.sub(ownerProductBalBefore).toString(),
        amountToOwner.toString()
      );

      // pending settled amount increases
      assert.equal(
        (await mm.pendingSettledAssetAmount(USDC_ADDRESS[chainId])).toString(),
        amountOut.toString()
      );

      // pending sale asset amount increases
      assert.equal(
        (await mm.pendingSaleAssetAmount(BIB01_ADDRESS[chainId])).toString(),
        amountToSwap.toString()
      );

      // pending sale asset is updated
      assert.equal(
        (await mm.pendingSaleAsset()).toString(),
        BIB01_ADDRESS[chainId]
      );

      // event emitted
      await expect(tx)
        .to.emit(mm, "ProductSwapped")
        .withArgs(
          BIB01_ADDRESS[chainId],
          USDC_ADDRESS[chainId],
          amountToSweeper,
          amountOut
        );
    });
  });

  describe("initiatePurchase", () => {
    time.revertToSnapshotAfterEach();

    let ribbonVaultSigner;
    let mmProxySigner;

    beforeEach(async function () {
      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [RIBBON_EARN_USDC_VAULT],
      });
      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [MM_PROXY],
      });

      ribbonVaultSigner = await provider.getSigner(RIBBON_EARN_USDC_VAULT);
      mmProxySigner = await provider.getSigner(MM_PROXY);

      await mm
        .connect(signer)
        .setProduct(
          BIB01_ADDRESS[chainId],
          MM_SPREAD[chainId],
          BIB01_PROVIDER_SPREAD[chainId],
          MM_PROXY,
          MM_PROXY,
          mockOracle.address,
          true
        );

      await time.increase(SET_PRODUCT_TIMELOCK);
    });

    it("reverts when not the keeper", async function () {
      await expect(
        mm.initiatePurchase(USDC_ADDRESS[chainId])
      ).to.be.revertedWith("!keeper");
    });

    it("initiates the purchase of USDC", async function () {
      // swap occurs
      let amountToSwap = BigNumber.from("100000").mul(
        BigNumber.from("10").pow("6")
      );

      await usdc.connect(ribbonVaultSigner).approve(mm.address, amountToSwap);

      await mm
        .connect(ribbonVaultSigner)
        .swap(USDC_ADDRESS[chainId], BIB01_ADDRESS[chainId], amountToSwap);

      // mmProxy approves MM contract
      await usdc.connect(mmProxySigner).approve(mm.address, amountToSwap);

      // initiates purchase
      let mmProxyUSDCBalBefore = await usdc.balanceOf(MM_PROXY);
      let destUSDCBalBefore = await usdc.balanceOf(DEST_USDC);
      let pendingSaleAssetAmountBefore = await mm.pendingSaleAssetAmount(
        USDC_ADDRESS[chainId]
      );

      let pendingSaleAsset = await mm.pendingSaleAsset();

      let tx = await mm.connect(keeper).initiatePurchase(pendingSaleAsset);

      let mmProxyUSDCBalAfter = await usdc.balanceOf(MM_PROXY);
      let destUSDCBalAfter = await usdc.balanceOf(DEST_USDC);
      let pendingSaleAssetAmountAfter = await mm.pendingSaleAssetAmount(
        USDC_ADDRESS[chainId]
      );

      assert.equal(
        mmProxyUSDCBalBefore.sub(mmProxyUSDCBalAfter).toString(),
        amountToSwap
      );

      assert.equal(
        destUSDCBalAfter.sub(destUSDCBalBefore).toString(),
        amountToSwap
      );

      assert.equal(
        pendingSaleAssetAmountBefore
          .sub(pendingSaleAssetAmountAfter)
          .toString(),
        amountToSwap
      );

      assert.equal(pendingSaleAssetAmountAfter, 0);

      // event emitted
      await expect(tx)
        .to.emit(mm, "InitiatedPurchase")
        .withArgs(USDC_ADDRESS[chainId], pendingSaleAssetAmountBefore);
    });
    it("initiates the purchase of BIB01", async function () {
      // swap occurs
      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [BIB01_OWNER_ADDRESS[chainId]],
      });

      let productOwnerSigner = await provider.getSigner(
        BIB01_OWNER_ADDRESS[chainId]
      );

      let amountToSwap = BigNumber.from("100").mul(
        BigNumber.from("10").pow("18")
      );

      await product
        .connect(productOwnerSigner)
        .transfer(RIBBON_EARN_USDC_VAULT, amountToSwap);

      await product
        .connect(ribbonVaultSigner)
        .approve(mm.address, amountToSwap);

      await product
        .connect(ribbonVaultSigner)
        .approve(mm.address, amountToSwap);

      await mm
        .connect(ribbonVaultSigner)
        .swap(BIB01_ADDRESS[chainId], USDC_ADDRESS[chainId], amountToSwap);

      // mmProxy approves MM contract
      await product.connect(mmProxySigner).approve(mm.address, amountToSwap);

      // initiates purchase
      let mmProxyProductBalBefore = await product.balanceOf(MM_PROXY);
      let destProductBalBefore = await product.balanceOf(DEST_BIB01);
      let pendingSaleAssetAmountBefore = await mm.pendingSaleAssetAmount(
        BIB01_ADDRESS[chainId]
      );

      let pendingSaleAsset = await mm.pendingSaleAsset();

      let tx = await mm.connect(keeper).initiatePurchase(pendingSaleAsset);

      let mmProxyProductBalAfter = await product.balanceOf(MM_PROXY);
      let destProductBalAfter = await product.balanceOf(DEST_BIB01);
      let pendingSaleAssetAmountAfter = await mm.pendingSaleAssetAmount(
        BIB01_ADDRESS[chainId]
      );

      assert.equal(
        mmProxyProductBalBefore.sub(mmProxyProductBalAfter).toString(),
        amountToSwap
      );

      assert.equal(
        destProductBalAfter.sub(destProductBalBefore).toString(),
        amountToSwap
      );

      assert.equal(
        pendingSaleAssetAmountBefore
          .sub(pendingSaleAssetAmountAfter)
          .toString(),
        amountToSwap
      );

      assert.equal(pendingSaleAssetAmountAfter, 0);

      // event emitted
      await expect(tx)
        .to.emit(mm, "InitiatedPurchase")
        .withArgs(BIB01_ADDRESS[chainId], pendingSaleAssetAmountBefore);
    });
  });

  describe("settlePurchase", () => {
    time.revertToSnapshotAfterEach();

    let mmProxySigner;

    beforeEach(async function () {
      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [MM_PROXY],
      });

      mmProxySigner = await provider.getSigner(MM_PROXY);

      await mm
        .connect(signer)
        .setProduct(
          BIB01_ADDRESS[chainId],
          MM_SPREAD[chainId],
          BIB01_PROVIDER_SPREAD[chainId],
          MM_PROXY,
          MM_PROXY,
          mockOracle.address,
          true
        );

      await time.increase(SET_PRODUCT_TIMELOCK);
    });

    it("reverts when not the keeper", async function () {
      await expect(
        mm.settlePurchase(BIB01_ADDRESS[chainId])
      ).to.be.revertedWith("!keeper");
    });

    it("reverts when amount to claim is 0", async function () {
      await expect(
        mm.connect(keeper).settlePurchase(BIB01_ADDRESS[chainId])
      ).to.be.revertedWith("!amtToSettle > 0");
    });

    it("settles TPlus0 transfer", async function () {
      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [BIB01_OWNER_ADDRESS[chainId]],
      });

      let productOwnerSigner = await provider.getSigner(
        BIB01_OWNER_ADDRESS[chainId]
      );

      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [RIBBON_EARN_USDC_VAULT],
      });

      let ribbonVaultSigner = await provider.getSigner(RIBBON_EARN_USDC_VAULT);

      let amountToSwap = BigNumber.from("100000").mul(
        BigNumber.from("10").pow("6")
      );

      // transfers from ribbon earn vault
      await usdc.connect(ribbonVaultSigner).approve(mm.address, amountToSwap);

      // transfer to product sweeper and owner
      await mm
        .connect(ribbonVaultSigner)
        .swap(USDC_ADDRESS[chainId], BIB01_ADDRESS[chainId], amountToSwap);

      // pending settled amount
      let amountOut = await mm.pendingSettledAssetAmount(
        BIB01_ADDRESS[chainId]
      );

      // keeper calls initiate purchase
      await product
        .connect(mmProxySigner)
        .approve(mm.address, ethers.constants.MaxUint256);
      await usdc
        .connect(mmProxySigner)
        .approve(mm.address, ethers.constants.MaxUint256);

      let pendingSaleAsset = await mm.pendingSaleAsset();

      await mm.connect(keeper).initiatePurchase(pendingSaleAsset);

      // transfers to MM Proxy
      await product.connect(productOwnerSigner).transfer(MM_PROXY, amountOut);

      // keeper calls settle purchase
      let ribbonVaultProductBalBefore = await product.balanceOf(
        RIBBON_EARN_USDC_VAULT
      );
      let mmProxyProductBalBefore = await product.balanceOf(MM_PROXY);

      let tx = await mm.connect(keeper).settlePurchase(BIB01_ADDRESS[chainId]);

      let ribbonVaultProductBalAfter = await product.balanceOf(
        RIBBON_EARN_USDC_VAULT
      );
      let mmProxyProductBalAfter = await product.balanceOf(MM_PROXY);

      assert.equal(
        (await mm.pendingSettledAssetAmount(BIB01_ADDRESS[chainId])).toString(),
        0
      );
      assert.equal(
        ribbonVaultProductBalAfter.sub(ribbonVaultProductBalBefore).toString(),
        amountOut.toString()
      );
      assert.equal(
        mmProxyProductBalBefore.sub(mmProxyProductBalAfter).toString(),
        amountOut.toString()
      );

      // event emitted
      await expect(tx)
        .to.emit(mm, "Settled")
        .withArgs(BIB01_ADDRESS[chainId], amountOut);

      // Check if product directly transferred
      await product.connect(productOwnerSigner).transfer(mm.address, 1);
      await mm.connect(keeper).settlePurchase(BIB01_ADDRESS[chainId]);
      assert.equal(
        (await mm.pendingSettledAssetAmount(BIB01_ADDRESS[chainId])).toString(),
        0
      );
    });
  });
});
