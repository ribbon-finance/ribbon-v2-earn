import { ethers, network } from "hardhat";
import {
  USDC_ADDRESS,
  BIB01_ADDRESS,
  BIB01_OWNER_ADDRESS,
  MM_SPREAD,
  BIB01_PROVIDER_SPREAD,
} from "../constants/constants";
import { expect } from "chai";
import { constants, Contract } from "ethers";
import * as time from "./helpers/time";
import { BigNumber } from "@ethersproject/bignumber";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signers";
import { assert } from "./helpers/assertions";
import { parseUnits } from "ethers/lib/utils";
import { TEST_URI } from "../scripts/helpers/getDefaultEthersProvider";

const { provider, getContractAt, getContractFactory } = ethers;

const TOTAL_PCT = BigNumber.from("1000000");
const RIBBON_EARN_USDC_VAULT = "0x84c2b16FA6877a8fF4F3271db7ea837233DFd6f0";
const MIN_PROVIDER_SWAP = BigNumber.from("5000").mul(
  BigNumber.from("10").pow("6")
);
const ORACLE_DIFF_THRESH_PCT = BigNumber.from("100000");
const BASE_ORACLE_ANSWER = BigNumber.from("100").mul(
  BigNumber.from("10").pow("8")
);

const chainId = network.config.chainId;

describe("MM", () => {
  let mm: Contract;
  let mockOracle: Contract;
  let product: Contract;
  let usdc: Contract;

  let signer: SignerWithAddress;
  let signer2: SignerWithAddress;

  before(async function () {
    [signer, signer2] = await ethers.getSigners();

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

    mm = await MM.deploy();
    mockOracle = await MockAggregator.deploy(
      8,
      BigNumber.from("100").mul(BigNumber.from("10").pow(8))
    );

    product = await getContractAt("ERC20", BIB01_ADDRESS[chainId]);

    usdc = await getContractAt("ERC20", USDC_ADDRESS[chainId]);

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

  describe("convertToUSDCAmount", () => {
    time.revertToSnapshotAfterEach();

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

    it("set the correct value in constructor", async function () {
      assert.equal(
        (await mm.minProviderSwap()).toString(),
        MIN_PROVIDER_SWAP.toString()
      );
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

    it("reverts when min amount not provided", async function () {
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

  describe("settleTPlus0Transfer", () => {
    time.revertToSnapshotAfterEach();

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

      // transfers to ribbon earn vault
      await product.connect(productOwnerSigner).transfer(mm.address, amountOut);

      let ribbonVaultProductBalBefore = await product.balanceOf(
        RIBBON_EARN_USDC_VAULT
      );

      let tx = await mm.settleTPlus0Transfer(BIB01_ADDRESS[chainId]);

      let ribbonVaultProductBalAfter = await product.balanceOf(
        RIBBON_EARN_USDC_VAULT
      );

      assert.equal(
        (await mm.pendingSettledAssetAmount(BIB01_ADDRESS[chainId])).toString(),
        0
      );
      assert.equal(
        ribbonVaultProductBalAfter.sub(ribbonVaultProductBalBefore).toString(),
        amountOut.toString()
      );

      // event emitted
      await expect(tx)
        .to.emit(mm, "Settled")
        .withArgs(BIB01_ADDRESS[chainId], amountOut);

      // Check if product directly transferred
      await product.connect(productOwnerSigner).transfer(mm.address, 1);
      await mm.settleTPlus0Transfer(BIB01_ADDRESS[chainId]);
      assert.equal(
        (await mm.pendingSettledAssetAmount(BIB01_ADDRESS[chainId])).toString(),
        0
      );
    });
  });
});
