import { ethers, network } from "hardhat";
import { expect } from "chai";
import { BigNumber, BigNumberish, constants, Contract, Wallet } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import moment from "moment-timezone";
import * as time from "./helpers/time";
import {
  CHAINID,
  WETH_ADDRESS,
  USDC_ADDRESS,
  STETH_ADDRESS,
  RETH_ADDRESS,
  USDC_OWNER_ADDRESS,
} from "../constants/constants";
import {
  deployProxy,
  mintToken,
  lockedBalanceForRollover,
  generateWallet,
  getPermitSignature,
} from "./helpers/utils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signers";
import { assert } from "./helpers/assertions";
import { TEST_URI } from "../scripts/helpers/getDefaultEthersProvider";
const { provider, getContractAt, getContractFactory } = ethers;
const { parseEther } = ethers.utils;
moment.tz.setDefault("UTC");

const gasPrice = parseUnits("30", "gwei");
const FEE_SCALING = BigNumber.from(10).pow(6);
const YIELD_SCALING = BigNumber.from(10).pow(2);

const WEEKS_PER_YEAR = 52142857;
const SECONDS_PER_DAY = 86400;

const chainId = network.config.chainId;

describe("RibbonEarnVault", () => {
  behavesLikeRibbonOptionsVault({
    name: `Ribbon USDC Earn Vault`,
    tokenName: "Ribbon USDC Earn Vault",
    tokenSymbol: "rUSDC-EARN",
    asset: USDC_ADDRESS[chainId],
    assetContractName:
      chainId === CHAINID.AVAX_MAINNET ? "IBridgeToken" : "IWBTC",
    collateralAsset: USDC_ADDRESS[chainId],
    tokenDecimals: 6,
    loanTermLength: BigNumber.from("28").mul(SECONDS_PER_DAY),
    optionPurchaseFreq: BigNumber.from("7").mul(SECONDS_PER_DAY),
    loanAllocationPCT: BigNumber.from("9900"),
    optionAllocationPCT: BigNumber.from("100"),
    depositAmount: BigNumber.from("100000000000"),
    managementFee: BigNumber.from("2000000"),
    performanceFee: BigNumber.from("20000000"),
    minimumSupply: BigNumber.from("10").pow("3").toString(),
    gasLimits: {
      depositWorstCase: 116295,
      depositBestCase: 99933,
    },
    mintConfig: {
      amount: parseUnits("10000000", 6),
      contractOwnerAddress: USDC_OWNER_ADDRESS[chainId],
    },
    availableChains: [CHAINID.ETH_MAINNET],
    contractType: "RibbonEarnVault",
  });
});

/**
 *
 * @param {Object} params - Parameter of option vault
 * @param {string} params.name - Name of test
 * @param {string} params.tokenName - Name of Option Vault
 * @param {string} params.tokenSymbol - Symbol of Option Vault
 * @param {number} params.tokenDecimals - Decimals of the vault shares
 * @param {BigNumber} params.loanTermLength - Loan term length
 * @param {BigNumber} params.optionPurchaseFreq - How long between option purchases
 * @param {BigNumber} params.loanAllocationPCT - Percent of vault to allocate to loan
 * @param {BigNumber} params.optionAllocationPCT - Percent of vault to allocate to option purchases
 * @param {string} params.asset - Address of assets
 * @param {string} params.assetContractName - Name of collateral asset contract
 * @param {string} params.collateralAsset - Address of asset used for collateral
 * @param {Object=} params.mintConfig - Optional: For minting asset, if asset can be minted
 * @param {string} params.mintConfig.contractOwnerAddress - Impersonate address of mintable asset contract owner
 * @param {BigNumber} params.depositAmount - Deposit amount
 * @param {string} params.minimumSupply - Minimum supply to maintain for share and asset balance
 * @param {BigNumber} params.managementFee - Management fee (6 decimals)
 * @param {BigNumber} params.performanceFee - PerformanceFee fee (6 decimals)
 * @param {number[]} params.availableChains - ChainIds where the tests for the vault will be executed
 * @param {number[]} params.contractType - RibbonEarnVault
 */
function behavesLikeRibbonOptionsVault(params: {
  name: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  loanTermLength: BigNumber;
  optionPurchaseFreq: BigNumber;
  loanAllocationPCT: BigNumber;
  optionAllocationPCT: BigNumber;
  asset: string;
  assetContractName: string;
  collateralAsset: string;
  depositAmount: BigNumber;
  minimumSupply: string;
  managementFee: BigNumber;
  performanceFee: BigNumber;
  gasLimits: {
    depositWorstCase: number;
    depositBestCase: number;
  };
  mintConfig?: {
    amount: BigNumber;
    contractOwnerAddress: string;
  };
  availableChains: number[];
  contractType: string;
}) {
  // Test configs
  let availableChains = params.availableChains;

  // Skip test when vault is not available in the current chain
  if (!availableChains.includes(chainId)) {
    return;
  }

  // Addresses
  let owner: string,
    keeper: string,
    user: string,
    feeRecipient: string,
    borrower: string,
    optionSeller: string;

  // Signers
  let adminSigner: SignerWithAddress,
    userSigner: SignerWithAddress,
    ownerSigner: SignerWithAddress,
    keeperSigner: SignerWithAddress,
    feeRecipientSigner: SignerWithAddress,
    borrowerSigner: SignerWithAddress,
    optionSellerSigner: SignerWithAddress;

  // Parameters
  let tokenName = params.tokenName;
  let tokenSymbol = params.tokenSymbol;
  let tokenDecimals = params.tokenDecimals;
  let minimumSupply = params.minimumSupply;
  let asset = params.asset;
  let collateralAsset = params.collateralAsset;
  let depositAmount = params.depositAmount;
  let managementFee = params.managementFee;
  let performanceFee = params.performanceFee;
  let loanTermLength = params.loanTermLength;
  let optionPurchaseFreq = params.optionPurchaseFreq;
  let loanAllocationPCT = params.loanAllocationPCT;
  let optionAllocationPCT = params.optionAllocationPCT;

  // Contracts
  let vaultLifecycleLib: Contract;
  let vault: Contract;
  let assetContract: Contract;
  let pauser: Contract;

  describe(`${params.name}`, () => {
    let initSnapshotId: string;

    const buyAllOptions = async () => {
      for (
        let i = 0;
        i <
        parseInt(
          BigNumber.from((await vault.allocationState()).currentLoanTermLength)
            .div((await vault.allocationState()).currentOptionPurchaseFreq)
            .toString()
        );
        i++
      ) {
        await vault.connect(keeperSigner).buyOption();
        await time.increaseTo(
          (
            await vault.vaultState()
          ).lastOptionPurchaseTime.add(
            (
              await vault.allocationState()
            ).currentOptionPurchaseFreq
          )
        );
      }
    };

    const repayInterest = async () => {
      // Repay Interest
      let interest = BigNumber.from(
        (await vault.allocationState()).optionAllocation
      );
      let totalToReturn = (await vault.allocationState()).loanAllocation.add(
        interest
      );

      await assetContract
        .connect(borrowerSigner)
        .approve(vault.address, totalToReturn);
      await vault
        .connect(borrowerSigner)
        ["returnLentFunds(uint256)"](totalToReturn);
    };

    const rollToNextRound = async (
      buyOption: boolean = true,
      repay: boolean = true,
      rollFirst: boolean = true
    ) => {
      if (rollFirst) {
        await vault.connect(keeperSigner).rollToNextRound();
      }

      if (buyOption) {
        await buyAllOptions();
      }

      if (repay) {
        await repayInterest();
      }

      let newTime = (await vault.vaultState()).lastEpochTime.add(
        BigNumber.from((await vault.allocationState()).currentLoanTermLength)
      );

      if (
        parseInt((await time.now()).toString()) < parseInt(newTime.toString())
      ) {
        await time.increaseTo(newTime);
      }

      if (!rollFirst) {
        await vault.connect(keeperSigner).rollToNextRound();
      }
    };

    before(async function () {
      // Reset block
      await network.provider.request({
        method: "hardhat_reset",
        params: [
          {
            forking: {
              jsonRpcUrl: TEST_URI[chainId],
              blockNumber: 15086230,
            },
          },
        ],
      });

      initSnapshotId = await time.takeSnapshot();

      [
        adminSigner,
        ownerSigner,
        keeperSigner,
        userSigner,
        feeRecipientSigner,
        borrowerSigner,
        optionSellerSigner,
      ] = await ethers.getSigners();

      owner = ownerSigner.address;
      keeper = keeperSigner.address;
      user = userSigner.address;
      feeRecipient = feeRecipientSigner.address;
      borrower = borrowerSigner.address;
      optionSeller = optionSellerSigner.address;

      const PauserFactory = await ethers.getContractFactory(
        "RibbonVaultPauser"
      );
      pauser = await PauserFactory.connect(ownerSigner).deploy(
        keeperSigner.address,
        WETH_ADDRESS[chainId],
        STETH_ADDRESS,
        "0x986aaa537b8cc170761FDAC6aC4fc7F9d8a20A8C"
      );

      const VaultLifecycle = await ethers.getContractFactory(
        "VaultLifecycleEarn"
      );
      vaultLifecycleLib = await VaultLifecycle.deploy();

      const initializeArgs = [
        [
          owner,
          keeper,
          borrower,
          optionSeller,
          feeRecipient,
          managementFee,
          performanceFee,
          tokenName,
          tokenSymbol,
        ],
        [
          tokenDecimals,
          asset,
          minimumSupply,
          parseUnits("500", tokenDecimals > 18 ? tokenDecimals : 18),
        ],
        [
          0,
          0,
          loanTermLength,
          optionPurchaseFreq,
          loanAllocationPCT,
          optionAllocationPCT,
          0,
          0,
        ],
      ];

      const deployArgs = [WETH_ADDRESS[chainId], USDC_ADDRESS[chainId]];

      vault = (
        await deployProxy(
          params.contractType,
          adminSigner,
          initializeArgs,
          deployArgs,
          {
            libraries: {
              VaultLifecycleEarn: vaultLifecycleLib.address,
            },
          }
        )
      ).connect(userSigner);

      assetContract = await getContractAt(
        params.assetContractName,
        collateralAsset
      );

      // If mintable token, then mine the token
      if (params.mintConfig) {
        const addressToDeposit = [
          userSigner,
          ownerSigner,
          adminSigner,
          borrowerSigner,
          optionSellerSigner,
        ];
        for (let i = 0; i < addressToDeposit.length; i++) {
          await mintToken(
            assetContract,
            params.mintConfig.contractOwnerAddress,
            addressToDeposit[i].address,
            vault.address,
            params.mintConfig.amount
          );
        }
      } else if (params.asset === WETH_ADDRESS[chainId]) {
        await assetContract
          .connect(userSigner)
          .deposit({ value: parseEther("100") });
      }
    });

    after(async () => {
      await time.revertToSnapShot(initSnapshotId);
    });

    describe("#initialize", () => {
      let testVault: Contract;

      time.revertToSnapshotAfterEach(async function () {
        const RibbonEarnVault = await ethers.getContractFactory(
          params.contractType,
          {
            libraries: {
              VaultLifecycleEarn: vaultLifecycleLib.address,
            },
          }
        );
        testVault = await RibbonEarnVault.deploy(
          WETH_ADDRESS[chainId],
          USDC_ADDRESS[chainId]
        );
      });

      it("initializes with correct values", async function () {
        assert.equal(
          (await vault.cap()).toString(),
          parseUnits("500", tokenDecimals > 18 ? tokenDecimals : 18)
        );
        assert.equal(await vault.owner(), owner);
        assert.equal(await vault.keeper(), keeper);
        assert.equal(await vault.feeRecipient(), feeRecipient);
        assert.equal(await vault.borrower(), borrower);
        assert.equal(await vault.optionSeller(), optionSeller);

        assert.equal(
          (await vault.managementFee()).toString(),
          managementFee.mul(FEE_SCALING).div(WEEKS_PER_YEAR).toString()
        );
        assert.equal(
          (await vault.performanceFee()).toString(),
          performanceFee.toString()
        );

        const [decimals, assetFromContract, minimumSupply, cap] =
          await vault.vaultParams();
        assert.equal(await decimals, tokenDecimals);
        assert.equal(decimals, tokenDecimals);
        assert.equal(assetFromContract, collateralAsset);
        assert.equal(await vault.WETH(), WETH_ADDRESS[chainId]);
        assert.equal(await vault.USDC(), USDC_ADDRESS[chainId]);
        assert.bnEqual(await vault.totalPending(), BigNumber.from(0));
        assert.equal(minimumSupply, params.minimumSupply);
        assert.bnEqual(
          cap,
          parseUnits("500", tokenDecimals > 18 ? tokenDecimals : 18)
        );

        const [
          _nextLoanTermLength,
          _nextOptionPurchaseFreq,
          _currentLoanTermLength,
          _currentOptionPurchaseFreq,
          _loanAllocationPCT,
          _optionAllocationPCT,
          _loanAllocation,
          _optionAllocation,
        ] = await vault.allocationState();

        assert.equal(_nextLoanTermLength, 0);
        assert.equal(_nextOptionPurchaseFreq, 0);
        assert.equal(_currentLoanTermLength, loanTermLength);
        assert.equal(_currentOptionPurchaseFreq, optionPurchaseFreq);
        assert.equal(_loanAllocationPCT, loanAllocationPCT);
        assert.equal(_optionAllocationPCT, optionAllocationPCT);
        assert.equal(_loanAllocation, 0);
        assert.equal(_optionAllocation, 0);
      });

      it("cannot be initialized twice", async function () {
        await expect(
          vault.initialize(
            [
              owner,
              keeper,
              borrower,
              optionSeller,
              feeRecipient,
              managementFee,
              performanceFee,
              tokenName,
              tokenSymbol,
            ],
            [
              tokenDecimals,
              asset,
              minimumSupply,
              parseUnits("500", tokenDecimals > 18 ? tokenDecimals : 18),
            ],
            [
              0,
              0,
              loanTermLength,
              optionPurchaseFreq,
              loanAllocationPCT,
              optionAllocationPCT,
              0,
              0,
            ]
          )
        ).to.be.revertedWith("Initializable: contract is already initialized");
      });

      it("reverts when initializing with 0 owner", async function () {
        await expect(
          testVault.initialize(
            [
              constants.AddressZero,
              keeper,
              borrower,
              optionSeller,
              feeRecipient,
              managementFee,
              performanceFee,
              tokenName,
              tokenSymbol,
            ],
            [
              tokenDecimals,
              asset,
              minimumSupply,
              parseUnits("500", tokenDecimals > 18 ? tokenDecimals : 18),
            ],
            [
              0,
              0,
              loanTermLength,
              optionPurchaseFreq,
              loanAllocationPCT,
              optionAllocationPCT,
              0,
              0,
            ]
          )
        ).to.be.revertedWith("!owner");
      });

      it("reverts when initializing with 0 keeper", async function () {
        await expect(
          testVault.initialize(
            [
              owner,
              constants.AddressZero,
              borrower,
              optionSeller,
              feeRecipient,
              managementFee,
              performanceFee,
              tokenName,
              tokenSymbol,
            ],
            [
              tokenDecimals,
              asset,
              minimumSupply,
              parseUnits("500", tokenDecimals > 18 ? tokenDecimals : 18),
            ],
            [
              0,
              0,
              loanTermLength,
              optionPurchaseFreq,
              loanAllocationPCT,
              optionAllocationPCT,
              0,
              0,
            ]
          )
        ).to.be.revertedWith("!keeper");
      });

      it("reverts when initializing with 0 feeRecipient", async function () {
        await expect(
          testVault.initialize(
            [
              owner,
              keeper,
              borrower,
              optionSeller,
              constants.AddressZero,
              managementFee,
              performanceFee,
              tokenName,
              tokenSymbol,
            ],
            [
              tokenDecimals,
              asset,
              minimumSupply,
              parseUnits("500", tokenDecimals > 18 ? tokenDecimals : 18),
            ],
            [
              0,
              0,
              loanTermLength,
              optionPurchaseFreq,
              loanAllocationPCT,
              optionAllocationPCT,
              0,
              0,
            ]
          )
        ).to.be.revertedWith("!feeRecipient");
      });

      it("reverts when initializing with 0 initCap", async function () {
        await expect(
          testVault.initialize(
            [
              owner,
              keeper,
              borrower,
              optionSeller,
              feeRecipient,
              managementFee,
              performanceFee,
              tokenName,
              tokenSymbol,
            ],
            [tokenDecimals, asset, minimumSupply, 0],
            [
              0,
              0,
              loanTermLength,
              optionPurchaseFreq,
              loanAllocationPCT,
              optionAllocationPCT,
              0,
              0,
            ]
          )
        ).to.be.revertedWith("!cap");
      });

      it("reverts when asset is 0x", async function () {
        await expect(
          testVault.initialize(
            [
              owner,
              keeper,
              borrower,
              optionSeller,
              feeRecipient,
              managementFee,
              performanceFee,
              tokenName,
              tokenSymbol,
            ],
            [
              tokenDecimals,
              constants.AddressZero,
              minimumSupply,
              parseUnits("500", tokenDecimals > 18 ? tokenDecimals : 18),
            ],
            [
              0,
              0,
              loanTermLength,
              optionPurchaseFreq,
              loanAllocationPCT,
              optionAllocationPCT,
              0,
              0,
            ]
          )
        ).to.be.revertedWith("!asset");
      });

      it("reverts when currentLoanTermLength is less than a day", async function () {
        await expect(
          testVault.initialize(
            [
              owner,
              keeper,
              borrower,
              optionSeller,
              feeRecipient,
              managementFee,
              performanceFee,
              tokenName,
              tokenSymbol,
            ],
            [
              tokenDecimals,
              asset,
              minimumSupply,
              parseUnits("500", tokenDecimals > 18 ? tokenDecimals : 18),
            ],
            [
              0,
              0,
              0,
              optionPurchaseFreq,
              loanAllocationPCT,
              optionAllocationPCT,
              0,
              0,
            ]
          )
        ).to.be.revertedWith("!currentLoanTermLength");
      });

      it("reverts when currentOptionPurchaseFreq is greater than currentLoanTermLength", async function () {
        await expect(
          testVault.initialize(
            [
              owner,
              keeper,
              borrower,
              optionSeller,
              feeRecipient,
              managementFee,
              performanceFee,
              tokenName,
              tokenSymbol,
            ],
            [
              tokenDecimals,
              asset,
              minimumSupply,
              parseUnits("500", tokenDecimals > 18 ? tokenDecimals : 18),
            ],
            [
              0,
              0,
              loanTermLength,
              loanTermLength.add(1),
              loanAllocationPCT,
              optionAllocationPCT,
              0,
              0,
            ]
          )
        ).to.be.revertedWith("!currentOptionPurchaseFreq");
      });

      it("reverts when total allocation is not equal to 100%", async function () {
        await expect(
          testVault.initialize(
            [
              owner,
              keeper,
              borrower,
              optionSeller,
              feeRecipient,
              managementFee,
              performanceFee,
              tokenName,
              tokenSymbol,
            ],
            [
              tokenDecimals,
              asset,
              minimumSupply,
              parseUnits("500", tokenDecimals > 18 ? tokenDecimals : 18),
            ],
            [
              0,
              0,
              loanTermLength,
              optionPurchaseFreq,
              0,
              optionAllocationPCT,
              0,
              0,
            ]
          )
        ).to.be.revertedWith("!totalPCT");
      });
    });

    describe("#name", () => {
      it("returns the name", async function () {
        assert.equal(await vault.name(), tokenName);
      });
    });

    describe("#symbol", () => {
      it("returns the symbol", async function () {
        assert.equal(await vault.symbol(), tokenSymbol);
      });
    });

    describe("#owner", () => {
      it("returns the owner", async function () {
        assert.equal(await vault.owner(), owner);
      });
    });

    describe("#borrower", () => {
      it("returns the borrower", async function () {
        assert.equal(await vault.borrower(), borrower);
      });
    });

    describe("#optionSeller", () => {
      it("returns the optionSeller", async function () {
        assert.equal(await vault.optionSeller(), optionSeller);
      });
    });

    describe("#managementFee", () => {
      it("returns the management fee", async function () {
        assert.equal(
          (await vault.managementFee()).toString(),
          managementFee.mul(FEE_SCALING).div(WEEKS_PER_YEAR).toString()
        );
      });
    });

    describe("#performanceFee", () => {
      it("returns the performance fee", async function () {
        assert.equal(
          (await vault.performanceFee()).toString(),
          performanceFee.toString()
        );
      });
    });

    describe("#setBorrower", () => {
      time.revertToSnapshotAfterTest();

      it("set pending borrower", async function () {
        assert.equal(await vault.borrower(), borrower);
        let tx = await vault.connect(ownerSigner).setBorrower(owner);
        assert.equal(await vault.borrower(), borrower);
        assert.equal(await vault.pendingBorrower(), owner);

        await expect(tx)
          .to.emit(vault, "BorrowerSet")
          .withArgs(borrower, owner);
      });

      it("reverts when not owner call", async function () {
        await expect(vault.setBorrower(owner)).to.be.revertedWith(
          "caller is not the owner"
        );
      });
    });

    describe("#commitBorrower", () => {
      time.revertToSnapshotAfterTest();
      time.revertToSnapshotAfterEach();

      it("set new borrower", async function () {
        await vault.connect(ownerSigner).setBorrower(owner);
        assert.equal(await vault.borrower(), borrower);
        assert.equal(await vault.pendingBorrower(), owner);
        // 72 hours
        await time.increase(86400 * 3 + 1);
        await vault.connect(ownerSigner).commitBorrower();
        assert.equal(await vault.borrower(), owner);
        assert.equal(await vault.pendingBorrower(), constants.AddressZero);
      });

      it("reverts when not waiting 72 hours for commit borrower", async function () {
        assert.equal(await vault.borrower(), borrower);
        await vault.connect(ownerSigner).setBorrower(owner);

        await expect(
          vault.connect(ownerSigner).commitBorrower()
        ).to.be.revertedWith("!timelock");
      });

      it("reverts when not owner call", async function () {
        await expect(vault.setBorrower(owner)).to.be.revertedWith(
          "caller is not the owner"
        );
      });
    });

    describe("#setOptionSeller", () => {
      time.revertToSnapshotAfterTest();

      it("set pending option seller", async function () {
        assert.equal(await vault.optionSeller(), optionSeller);
        let tx = await vault.connect(ownerSigner).setOptionSeller(owner);
        assert.equal(await vault.optionSeller(), optionSeller);
        assert.equal(await vault.pendingOptionSeller(), owner);

        await expect(tx)
          .to.emit(vault, "OptionSellerSet")
          .withArgs(optionSeller, owner);
      });

      it("reverts when not owner call", async function () {
        await expect(vault.setOptionSeller(owner)).to.be.revertedWith(
          "caller is not the owner"
        );
      });
    });

    describe("#commitOptionSeller", () => {
      time.revertToSnapshotAfterTest();
      time.revertToSnapshotAfterEach();

      it("set new option seller", async function () {
        await vault.connect(ownerSigner).setOptionSeller(owner);
        assert.equal(await vault.optionSeller(), optionSeller);
        assert.equal(await vault.pendingOptionSeller(), owner);
        // 72 hours
        await time.increase(86400 * 3 + 1);
        await vault.connect(ownerSigner).commitOptionSeller();
        assert.equal(await vault.optionSeller(), owner);
        assert.equal(await vault.pendingOptionSeller(), constants.AddressZero);
      });

      it("reverts when not waiting 72 hours for commit borrower", async function () {
        assert.equal(await vault.optionSeller(), optionSeller);
        await vault.connect(ownerSigner).setOptionSeller(owner);

        await expect(
          vault.connect(ownerSigner).commitOptionSeller()
        ).to.be.revertedWith("!timelock");
      });

      it("reverts when not owner call", async function () {
        await expect(vault.setBorrower(owner)).to.be.revertedWith(
          "caller is not the owner"
        );
      });
    });

    describe("#setLoanAllocationPCT", () => {
      time.revertToSnapshotAfterTest();

      it("set new loan allocation PCT", async function () {
        assert.equal(
          (await vault.allocationState()).loanAllocationPCT,
          loanAllocationPCT
        );

        let tx = await vault
          .connect(ownerSigner)
          .setLoanAllocationPCT(loanAllocationPCT.div(2));
        assert.equal(
          (await vault.allocationState()).loanAllocationPCT,
          loanAllocationPCT.div(2)
        );
        assert.equal(
          (await vault.allocationState()).optionAllocationPCT,
          BigNumber.from(await vault.TOTAL_PCT()).sub(loanAllocationPCT.div(2))
        );

        await expect(tx)
          .to.emit(vault, "NewLoanOptionAllocationSet")
          .withArgs(
            loanAllocationPCT,
            optionAllocationPCT,
            loanAllocationPCT.div(2),
            BigNumber.from(await vault.TOTAL_PCT()).sub(
              loanAllocationPCT.div(2)
            )
          );
      });

      it("reverts when loanAllocationPCT > TOTAL_PCT", async function () {
        await expect(
          vault
            .connect(ownerSigner)
            .setLoanAllocationPCT(
              BigNumber.from(await vault.TOTAL_PCT()).add(1)
            )
        ).to.be.revertedWith("!_loanAllocationPCT");
      });

      it("reverts when not owner call", async function () {
        await expect(vault.setLoanAllocationPCT(1)).to.be.revertedWith(
          "caller is not the owner"
        );
      });
    });

    describe("#setLoanTermLength", () => {
      time.revertToSnapshotAfterTest();

      it("set new loan term length", async function () {
        assert.equal((await vault.allocationState()).nextLoanTermLength, 0);
        let tx = await vault.connect(ownerSigner).setLoanTermLength(86400);
        assert.equal((await vault.allocationState()).nextLoanTermLength, 86400);
        assert.equal(
          (await vault.allocationState()).currentLoanTermLength,
          loanTermLength
        );

        await expect(tx)
          .to.emit(vault, "NewLoanTermLength")
          .withArgs(
            (
              await vault.allocationState()
            ).currentLoanTermLength,
            (
              await vault.allocationState()
            ).nextLoanTermLength
          );
      });

      it("reverts when loanTermLength < 1 day", async function () {
        await expect(
          vault.connect(ownerSigner).setLoanTermLength(86399)
        ).to.be.revertedWith("!_loanTermLength");
      });

      it("reverts when not owner call", async function () {
        await expect(vault.setLoanTermLength(86400)).to.be.revertedWith(
          "caller is not the owner"
        );
      });
    });

    describe("#setOptionPurchaseFrequency", () => {
      time.revertToSnapshotAfterTest();

      it("set new option purchase frequency", async function () {
        assert.equal((await vault.allocationState()).nextOptionPurchaseFreq, 0);
        let tx = await vault
          .connect(ownerSigner)
          .setOptionPurchaseFrequency(loanTermLength.div(2));
        assert.equal(
          (await vault.allocationState()).nextOptionPurchaseFreq,
          loanTermLength.div(2)
        );
        assert.equal(
          (await vault.allocationState()).currentOptionPurchaseFreq,
          optionPurchaseFreq
        );

        await expect(tx)
          .to.emit(vault, "NewOptionPurchaseFrequency")
          .withArgs(
            (
              await vault.allocationState()
            ).currentOptionPurchaseFreq,
            (
              await vault.allocationState()
            ).nextOptionPurchaseFreq
          );
      });

      it("reverts when _optionPurchaseFreq = 0", async function () {
        await expect(
          vault.connect(ownerSigner).setOptionPurchaseFrequency(0)
        ).to.be.revertedWith("!_optionPurchaseFreq");
      });

      it("reverts when _optionPurchaseFreq > _currentLoanTermLength", async function () {
        await expect(
          vault
            .connect(ownerSigner)
            .setOptionPurchaseFrequency(
              BigNumber.from(
                (
                  await vault.allocationState()
                ).currentLoanTermLength
              ).add(1)
            )
        ).to.be.revertedWith("! _optionPurchaseFreq < loanTermLength");
      });

      it("reverts when _optionPurchaseFreq > _nextLoanTermLength", async function () {
        await vault.connect(ownerSigner).setLoanTermLength(86400);

        await expect(
          vault.connect(ownerSigner).setOptionPurchaseFrequency(86401)
        ).to.be.revertedWith("! _optionPurchaseFreq < loanTermLength");
      });

      it("reverts when not owner call", async function () {
        await expect(
          vault.setOptionPurchaseFrequency(86400)
        ).to.be.revertedWith("caller is not the owner");
      });
    });

    describe("#setFeeRecipient", () => {
      time.revertToSnapshotAfterTest();

      it("reverts when setting 0x0 as feeRecipient", async function () {
        await expect(
          vault.connect(ownerSigner).setFeeRecipient(constants.AddressZero)
        ).to.be.revertedWith("!newFeeRecipient");
      });

      it("reverts when not owner call", async function () {
        await expect(vault.setFeeRecipient(owner)).to.be.revertedWith(
          "caller is not the owner"
        );
      });

      it("changes the fee recipient", async function () {
        await vault.connect(ownerSigner).setFeeRecipient(owner);
        assert.equal(await vault.feeRecipient(), owner);
      });
    });

    describe("#setManagementFee", () => {
      time.revertToSnapshotAfterTest();

      it("setManagementFee to 0", async function () {
        await vault.connect(ownerSigner).setManagementFee(0);
        assert.bnEqual(await vault.managementFee(), BigNumber.from(0));
      });

      it("reverts when not owner call", async function () {
        await expect(
          vault.setManagementFee(BigNumber.from("1000000").toString())
        ).to.be.revertedWith("caller is not the owner");
      });

      it("changes the management fee", async function () {
        await vault
          .connect(ownerSigner)
          .setManagementFee(BigNumber.from("1000000").toString());
        assert.equal(
          (await vault.managementFee()).toString(),
          BigNumber.from(1000000)
            .mul(FEE_SCALING)
            .div(WEEKS_PER_YEAR)
            .toString()
        );
      });
    });

    describe("#setPerformanceFee", () => {
      time.revertToSnapshotAfterTest();

      it("setPerformanceFee to 0", async function () {
        await vault.connect(ownerSigner).setPerformanceFee(0);
        assert.bnEqual(await vault.performanceFee(), BigNumber.from(0));
      });

      it("reverts when not owner call", async function () {
        await expect(
          vault.setPerformanceFee(BigNumber.from("1000000").toString())
        ).to.be.revertedWith("caller is not the owner");
      });

      it("changes the performance fee", async function () {
        await vault
          .connect(ownerSigner)
          .setPerformanceFee(BigNumber.from("1000000").toString());
        assert.equal(
          (await vault.performanceFee()).toString(),
          BigNumber.from("1000000").toString()
        );
      });
    });

    // Only apply to when assets is WETH
    if (
      [WETH_ADDRESS[chainId], RETH_ADDRESS[chainId]].includes(
        params.collateralAsset
      )
    ) {
      describe("#depositETH", () => {
        time.revertToSnapshotAfterEach();

        it("creates pending deposit successfully", async function () {
          const startBalance = await provider.getBalance(user);

          let depositAmount = parseEther("1");
          const tx = await vault.depositETH({ value: depositAmount, gasPrice });
          const receipt = await tx.wait();
          const gasFee = receipt.gasUsed.mul(gasPrice);

          assert.bnEqual(
            await provider.getBalance(user),
            startBalance.sub(depositAmount).sub(gasFee)
          );

          if (params.collateralAsset === RETH_ADDRESS[chainId]) {
            let rETHAmount = await (
              await getContractAt("IRETH", params.collateralAsset)
            ).getRethValue(depositAmount);
            depositAmount = rETHAmount;
          }

          // Unchanged for share balance and totalSupply
          assert.bnEqual(await vault.totalSupply(), BigNumber.from(0));
          assert.bnEqual(await vault.balanceOf(user), BigNumber.from(0));
          await expect(tx)
            .to.emit(vault, "Deposit")
            .withArgs(user, depositAmount, 1);
          await expect(tx)
            .to.emit(vault, "Deposit")
            .withArgs(user, depositAmount, 1);

          assert.bnEqual(await vault.totalPending(), depositAmount);
          const { round, amount } = await vault.depositReceipts(user);
          assert.equal(round, 1);
          assert.bnEqual(amount, depositAmount);
        });

        it("fits gas budget [ @skip-on-coverage ]", async function () {
          const tx1 = await vault
            .connect(ownerSigner)
            .depositETH({ value: parseEther("0.1") });
          const receipt1 = await tx1.wait();
          assert.isAtMost(
            receipt1.gasUsed.toNumber(),
            params.collateralAsset === WETH_ADDRESS[chainId] ? 130000 : 300000
          );

          const tx2 = await vault.depositETH({ value: parseEther("0.1") });
          const receipt2 = await tx2.wait();
          assert.isAtMost(
            receipt2.gasUsed.toNumber(),
            params.collateralAsset === WETH_ADDRESS[chainId] ? 91500 : 261500
          );

          // Uncomment to measure precise gas numbers
          // console.log("Worst case depositETH", receipt1.gasUsed.toNumber());
          // console.log("Best case depositETH", receipt2.gasUsed.toNumber());
        });

        it("reverts when no value passed", async function () {
          await expect(
            vault.connect(userSigner).depositETH({ value: 0 })
          ).to.be.revertedWith("!value");
        });

        it("does not inflate the share tokens on initialization", async function () {
          if (params.collateralAsset === WETH_ADDRESS[chainId]) {
            await assetContract
              .connect(adminSigner)
              .deposit({ value: parseEther("10") });
          }

          await assetContract
            .connect(adminSigner)
            .transfer(vault.address, parseEther("10"));

          await vault
            .connect(userSigner)
            .depositETH({ value: parseEther("1") });

          assert.isTrue((await vault.balanceOf(user)).isZero());
        });

        it("reverts when minimum shares are not minted", async function () {
          await expect(
            vault.connect(userSigner).depositETH({
              value: BigNumber.from("10").pow("10").sub(BigNumber.from("1")),
            })
          ).to.be.revertedWith("Insufficient balance");
        });

        it("ETH deposit works at predefined schedule", async function () {
          if (params.collateralAsset === RETH_ADDRESS[chainId]) {
            await vault.depositETH({
              value: parseEther("1"),
              gasPrice,
            });

            await vault.connect(keeperSigner).updaterETHMintCutoff();

            // 2 hour increase
            await time.increase(7200);

            await expect(
              vault.depositETH({
                value: parseEther("1"),
                gasPrice,
              })
            ).to.be.revertedWith("!cutoff");

            await vault.connect(keeperSigner).commitAndClose();
            await expect(vault.connect(keeperSigner).rollToNextRound()).to.be
              .reverted;

            // 22 hour increase
            await time.increase(79200);

            await vault.depositETH({
              value: parseEther("1"),
              gasPrice,
            });
          }
        });
      });
    } else {
      describe("#depositETH", () => {
        it("reverts when asset is not WETH", async function () {
          const depositAmount = parseEther("1");
          await expect(
            vault.depositETH({ value: depositAmount })
          ).to.be.revertedWith("!WETH");
        });
      });
    }

    // Only apply to when assets is USDC
    if (params.collateralAsset === USDC_ADDRESS[chainId]) {
      describe("#depositWithPermit", () => {
        time.revertToSnapshotAfterEach();

        it("creates a pending deposit", async function () {
          const startBalance = await assetContract.balanceOf(user);

          let rdmWallet: Wallet = await generateWallet(
            assetContract,
            depositAmount,
            userSigner
          );

          const { v, r, s } = await getPermitSignature(
            rdmWallet,
            assetContract,
            vault.address,
            depositAmount,
            constants.MaxUint256
          );

          const res = await vault
            .connect(await ethers.provider.getSigner(rdmWallet.address))
            .depositWithPermit(depositAmount, constants.MaxUint256, v, r, s);

          assert.bnEqual(
            await assetContract.balanceOf(user),
            startBalance.sub(depositAmount)
          );
          assert.isTrue((await vault.totalSupply()).isZero());
          assert.isTrue((await vault.balanceOf(user)).isZero());
          await expect(res)
            .to.emit(vault, "Deposit")
            .withArgs(rdmWallet.address, depositAmount, 1);

          assert.bnEqual(await vault.totalPending(), depositAmount);
          const { round, amount } = await vault.depositReceipts(
            rdmWallet.address
          );
          assert.equal(round, 1);
          assert.bnEqual(amount, depositAmount);
        });

        it("fits gas budget for deposits [ @skip-on-coverage ]", async function () {
          await vault.connect(ownerSigner).deposit(depositAmount);

          let rdmWallet: Wallet = await generateWallet(
            assetContract,
            depositAmount,
            userSigner
          );

          const { v, r, s } = await getPermitSignature(
            rdmWallet,
            assetContract,
            vault.address,
            depositAmount,
            constants.MaxUint256
          );

          const tx1 = await vault
            .connect(await ethers.provider.getSigner(rdmWallet.address))
            .depositWithPermit(depositAmount, constants.MaxUint256, v, r, s);

          const receipt1 = await tx1.wait();
          assert.isAtMost(receipt1.gasUsed.toNumber(), 143819);
        });
      });
    } else {
      describe("#depositWithPermit", () => {
        it("reverts when asset is not USDC", async function () {
          const depositAmount = parseEther("1");
          await expect(
            vault.depositWithPermit(depositAmount)
          ).to.be.revertedWith("!USDC");
        });
      });
    }

    describe("#deposit", () => {
      time.revertToSnapshotAfterEach();

      beforeEach(async function () {
        // Deposit only if asset is WETH
        if (params.collateralAsset === WETH_ADDRESS[chainId]) {
          const addressToDeposit = [userSigner, ownerSigner, adminSigner];

          for (let i = 0; i < addressToDeposit.length; i++) {
            const weth = assetContract.connect(addressToDeposit[i]);
            await weth.deposit({ value: parseEther("10") });
            await weth.approve(vault.address, parseEther("10"));
          }
        }
      });

      it("creates a pending deposit", async function () {
        const startBalance = await assetContract.balanceOf(user);

        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);

        const res = await vault.deposit(depositAmount);

        assert.bnEqual(
          await assetContract.balanceOf(user),
          startBalance.sub(depositAmount)
        );
        assert.isTrue((await vault.totalSupply()).isZero());
        assert.isTrue((await vault.balanceOf(user)).isZero());
        await expect(res)
          .to.emit(vault, "Deposit")
          .withArgs(user, depositAmount, 1);

        assert.bnEqual(await vault.totalPending(), depositAmount);
        const { round, amount } = await vault.depositReceipts(user);
        assert.equal(round, 1);
        assert.bnEqual(amount, depositAmount);
      });

      it("tops up existing deposit", async function () {
        const startBalance = await assetContract.balanceOf(user);
        const totalDepositAmount = depositAmount.mul(BigNumber.from(2));

        await assetContract
          .connect(userSigner)
          .approve(vault.address, totalDepositAmount);

        await vault.deposit(depositAmount);

        const tx = await vault.deposit(depositAmount);

        assert.bnEqual(
          await assetContract.balanceOf(user),
          startBalance.sub(totalDepositAmount)
        );
        assert.isTrue((await vault.totalSupply()).isZero());
        assert.isTrue((await vault.balanceOf(user)).isZero());
        await expect(tx)
          .to.emit(vault, "Deposit")
          .withArgs(user, depositAmount, 1);

        assert.bnEqual(await vault.totalPending(), totalDepositAmount);
        const { round, amount } = await vault.depositReceipts(user);
        assert.equal(round, 1);
        assert.bnEqual(amount, totalDepositAmount);
      });

      it("fits gas budget for deposits [ @skip-on-coverage ]", async function () {
        await vault.connect(ownerSigner).deposit(depositAmount);

        const tx1 = await vault.deposit(depositAmount);
        const receipt1 = await tx1.wait();
        assert.isAtMost(
          receipt1.gasUsed.toNumber(),
          params.gasLimits.depositWorstCase
        );

        const tx2 = await vault.deposit(depositAmount);
        const receipt2 = await tx2.wait();
        assert.isAtMost(
          receipt2.gasUsed.toNumber(),
          params.gasLimits.depositBestCase
        );

        // Uncomment to log gas used
        // console.log("Worst case deposit", receipt1.gasUsed.toNumber());
        // console.log("Best case deposit", receipt2.gasUsed.toNumber());
      });

      it("does not inflate the share tokens on initialization", async function () {
        const depositAmount = BigNumber.from("100000000000");

        await assetContract
          .connect(adminSigner)
          .transfer(vault.address, depositAmount);

        await vault.connect(userSigner).deposit(BigNumber.from("10000000000"));

        // user needs to get back exactly 1 ether
        // even though the total has been incremented
        assert.isTrue((await vault.balanceOf(user)).isZero());
      });

      it("reverts when minimum shares are not minted", async function () {
        await expect(
          vault
            .connect(userSigner)
            .deposit(BigNumber.from(minimumSupply).sub(BigNumber.from("1")))
        ).to.be.revertedWith("Insufficient balance");
      });

      it("updates the previous deposit receipt", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, params.depositAmount.mul(2));

        await vault.deposit(params.depositAmount);

        const {
          round: round1,
          amount: amount1,
          unredeemedShares: unredeemedShares1,
        } = await vault.depositReceipts(user);

        assert.equal(round1, 1);
        assert.bnEqual(amount1, params.depositAmount);
        assert.bnEqual(unredeemedShares1, BigNumber.from(0));

        await vault.connect(keeperSigner).rollToNextRound();
        await buyAllOptions();

        const {
          round: round2,
          amount: amount2,
          unredeemedShares: unredeemedShares2,
        } = await vault.depositReceipts(user);

        assert.equal(round2, 1);
        assert.bnEqual(amount2, params.depositAmount);
        assert.bnEqual(unredeemedShares2, BigNumber.from(0));

        await vault.deposit(params.depositAmount);

        assert.bnEqual(
          await assetContract.balanceOf(vault.address),
          params.depositAmount
        );
        // vault will still hold the vault shares
        assert.bnEqual(
          await vault.balanceOf(vault.address),
          params.depositAmount
        );

        const {
          round: round3,
          amount: amount3,
          unredeemedShares: unredeemedShares3,
        } = await vault.depositReceipts(user);

        assert.equal(round3, 2);
        assert.bnEqual(amount3, params.depositAmount);
        assert.bnEqual(unredeemedShares3, params.depositAmount);
      });
    });

    describe("#depositFor", () => {
      time.revertToSnapshotAfterEach();
      let creditor: String;

      beforeEach(async function () {
        // Deposit only if asset is WETH
        if (params.collateralAsset === WETH_ADDRESS[chainId]) {
          const addressToDeposit = [userSigner, ownerSigner, adminSigner];

          for (let i = 0; i < addressToDeposit.length; i++) {
            const weth = assetContract.connect(addressToDeposit[i]);
            await weth.deposit({ value: parseEther("10") });
            await weth.approve(vault.address, parseEther("10"));
          }
        }

        creditor = ownerSigner.address.toString();
      });

      it("creates a pending deposit", async function () {
        const startBalance = await assetContract.balanceOf(user);

        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);

        const res = await vault.depositFor(depositAmount, creditor);

        assert.bnEqual(
          await assetContract.balanceOf(user),
          startBalance.sub(depositAmount)
        );
        assert.isTrue((await vault.totalSupply()).isZero());
        assert.isTrue((await vault.balanceOf(user)).isZero());
        await expect(res)
          .to.emit(vault, "Deposit")
          .withArgs(creditor, depositAmount, 1);

        assert.bnEqual(await vault.totalPending(), depositAmount);
        const { round, amount } = await vault.depositReceipts(creditor);
        assert.equal(round, 1);
        assert.bnEqual(amount, depositAmount);
        const { round2, amount2 } = await vault.depositReceipts(user);
        await expect(round2).to.be.undefined;
        await expect(amount2).to.be.undefined;
      });

      it("tops up existing deposit", async function () {
        const startBalance = await assetContract.balanceOf(user);
        const totalDepositAmount = depositAmount.mul(BigNumber.from(2));

        await assetContract
          .connect(userSigner)
          .approve(vault.address, totalDepositAmount);

        await vault.depositFor(depositAmount, creditor);

        const tx = await vault.depositFor(depositAmount, creditor);

        assert.bnEqual(
          await assetContract.balanceOf(user),
          startBalance.sub(totalDepositAmount)
        );
        assert.isTrue((await vault.totalSupply()).isZero());
        assert.isTrue((await vault.balanceOf(creditor)).isZero());
        await expect(tx)
          .to.emit(vault, "Deposit")
          .withArgs(creditor, depositAmount, 1);

        assert.bnEqual(await vault.totalPending(), totalDepositAmount);
        const { round, amount } = await vault.depositReceipts(creditor);
        assert.equal(round, 1);
        assert.bnEqual(amount, totalDepositAmount);
      });

      it("fits gas budget for deposits [ @skip-on-coverage ]", async function () {
        await vault.connect(ownerSigner).depositFor(depositAmount, creditor);

        const tx1 = await vault.depositFor(depositAmount, creditor);
        const receipt1 = await tx1.wait();
        assert.isAtMost(
          receipt1.gasUsed.toNumber(),
          params.gasLimits.depositWorstCase
        );

        const tx2 = await vault.depositFor(depositAmount, creditor);
        const receipt2 = await tx2.wait();
        assert.isAtMost(
          receipt2.gasUsed.toNumber(),
          params.gasLimits.depositBestCase
        );

        // Uncomment to log gas used
        // console.log("Worst case deposit", receipt1.gasUsed.toNumber());
        // console.log("Best case deposit", receipt2.gasUsed.toNumber());
      });

      it("does not inflate the share tokens on initialization", async function () {
        const depositAmount = BigNumber.from("100000000000");

        await assetContract
          .connect(adminSigner)
          .transfer(vault.address, depositAmount);

        await vault
          .connect(userSigner)
          .depositFor(BigNumber.from("10000000000"), creditor);

        // user needs to get back exactly 1 ether
        // even though the total has been incremented
        assert.isTrue((await vault.balanceOf(creditor)).isZero());
      });

      it("reverts when minimum shares are not minted", async function () {
        await expect(
          vault
            .connect(userSigner)
            .depositFor(
              BigNumber.from(minimumSupply).sub(BigNumber.from("1")),
              creditor
            )
        ).to.be.revertedWith("Insufficient balance");
      });

      it("updates the previous deposit receipt", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, params.depositAmount.mul(2));

        await vault.depositFor(params.depositAmount, creditor);

        const {
          round: round1,
          amount: amount1,
          unredeemedShares: unredeemedShares1,
        } = await vault.depositReceipts(creditor);

        assert.equal(round1, 1);
        assert.bnEqual(amount1, params.depositAmount);
        assert.bnEqual(unredeemedShares1, BigNumber.from(0));

        await vault.connect(keeperSigner).rollToNextRound();
        await buyAllOptions();

        const {
          round: round2,
          amount: amount2,
          unredeemedShares: unredeemedShares2,
        } = await vault.depositReceipts(creditor);

        assert.equal(round2, 1);
        assert.bnEqual(amount2, params.depositAmount);
        assert.bnEqual(unredeemedShares2, BigNumber.from(0));

        await vault.depositFor(params.depositAmount, creditor);

        assert.bnEqual(
          await assetContract.balanceOf(vault.address),
          params.depositAmount
        );
        // vault will still hold the vault shares
        assert.bnEqual(
          await vault.balanceOf(vault.address),
          params.depositAmount
        );

        const {
          round: round3,
          amount: amount3,
          unredeemedShares: unredeemedShares3,
        } = await vault.depositReceipts(creditor);

        assert.equal(round3, 2);
        assert.bnEqual(amount3, params.depositAmount);
        assert.bnEqual(unredeemedShares3, params.depositAmount);
      });
    });

    describe("#buyOption", () => {
      const depositAmount = params.depositAmount;

      time.revertToSnapshotAfterEach(async function () {
        await depositIntoVault(params.collateralAsset, vault, depositAmount);
      });

      it("reverts when not called with keeper", async function () {
        await expect(vault.connect(ownerSigner).buyOption()).to.be.revertedWith(
          "!keeper"
        );
      });

      it("reverts when not called in correct schedule", async function () {
        await vault.connect(keeperSigner).rollToNextRound();
        await vault.connect(keeperSigner).buyOption();
        await expect(
          vault.connect(keeperSigner).buyOption()
        ).to.be.revertedWith("Purchase does not fulfill frequency");
      });

      it("it transfers correct amount to option seller", async function () {
        await vault.connect(keeperSigner).rollToNextRound();

        let optionsBoughtInRoundBefore = (await vault.vaultState())
          .optionsBoughtInRound;

        let balBefore = await assetContract.balanceOf(optionSeller);

        let t = await time.now();

        // Buy option
        let tx = await vault.connect(keeperSigner).buyOption();

        let optionsBoughtInRoundAfter = (await vault.vaultState())
          .optionsBoughtInRound;

        let balAfter = await assetContract.balanceOf(optionSeller);

        let optionPurchasesPerLoanTerm = BigNumber.from(
          (await vault.allocationState()).currentLoanTermLength
        ).div((await vault.allocationState()).currentOptionPurchaseFreq);

        let optionAllocation = (
          await vault.allocationState()
        ).optionAllocation.div(optionPurchasesPerLoanTerm);

        // Updates amount of options bought
        assert.bnEqual(
          optionsBoughtInRoundAfter.sub(optionsBoughtInRoundBefore),
          optionAllocation
        );

        // Sends assets to option seller
        assert.bnEqual(balAfter.sub(balBefore), optionAllocation);

        // Updates last purchase time
        assert.bnEqual(
          (await vault.vaultState()).lastOptionPurchaseTime,
          t.add(1)
        );

        await expect(tx)
          .to.emit(vault, "PurchaseOption")
          .withArgs(optionAllocation, optionSeller);
      });
    });

    describe("#payOptionYield", () => {
      const depositAmount = params.depositAmount;

      time.revertToSnapshotAfterEach(async function () {
        await depositIntoVault(params.collateralAsset, vault, depositAmount);
        await vault.connect(keeperSigner).rollToNextRound();
      });

      it("reverts when not called with option seller", async function () {
        await expect(
          vault.connect(ownerSigner)["payOptionYield(uint256)"](100)
        ).to.be.revertedWith("!optionSeller");
      });

      it("sign and pay yield", async function () {
        let optionSellerWallet: Wallet = await generateWallet(
          assetContract,
          depositAmount,
          userSigner
        );

        await vault
          .connect(ownerSigner)
          .setOptionSeller(optionSellerWallet.address);

        await time.increase(86400 * 3 + 1);
        await vault.connect(ownerSigner).commitOptionSeller();

        let balBefore = await assetContract.balanceOf(vault.address);

        const { v, r, s } = await getPermitSignature(
          optionSellerWallet,
          assetContract,
          vault.address,
          depositAmount,
          constants.MaxUint256
        );

        await vault
          .connect(await ethers.provider.getSigner(optionSellerWallet.address))
          ["payOptionYield(uint256,uint256,uint8,bytes32,bytes32)"](
            depositAmount,
            constants.MaxUint256,
            v,
            r,
            s
          );

        let balAfter = await assetContract.balanceOf(vault.address);

        // Received USDC
        assert.bnEqual(balAfter.sub(balBefore), depositAmount);
      });

      it("approve and pay yield", async function () {
        await assetContract
          .connect(optionSellerSigner)
          .approve(vault.address, depositAmount);

        let balBefore = await assetContract.balanceOf(vault.address);

        await vault
          .connect(optionSellerSigner)
          ["payOptionYield(uint256)"](depositAmount);

        let balAfter = await assetContract.balanceOf(vault.address);

        // Received USDC
        assert.bnEqual(balAfter.sub(balBefore), depositAmount);
      });

      it("adds option yield to vault", async function () {
        await assetContract
          .connect(optionSellerSigner)
          .approve(vault.address, depositAmount.mul(2));

        let tx = await vault
          .connect(optionSellerSigner)
          ["payOptionYield(uint256)"](depositAmount);

        let yieldInUSD = depositAmount.sub(
          (await vault.allocationState()).optionAllocation
        );
        let yieldInPCT = depositAmount
          .mul(YIELD_SCALING)
          .div((await vault.allocationState()).optionAllocation);

        await expect(tx)
          .to.emit(vault, "PayOptionYield")
          .withArgs(depositAmount, yieldInUSD, yieldInPCT, optionSeller);

        let tx2 = await vault
          .connect(optionSellerSigner)
          ["payOptionYield(uint256)"](1);

        await expect(tx2)
          .to.emit(vault, "PayOptionYield")
          .withArgs(1, 0, 0, optionSeller);
      });
    });

    describe("#returnLentFunds", () => {
      const depositAmount = params.depositAmount;

      time.revertToSnapshotAfterEach(async function () {
        await depositIntoVault(params.collateralAsset, vault, depositAmount);
        await vault.connect(keeperSigner).rollToNextRound();
      });

      it("reverts when not called with borrower", async function () {
        await expect(
          vault.connect(ownerSigner)["returnLentFunds(uint256)"](100)
        ).to.be.revertedWith("!borrower");
      });

      it("sign and pay principal + interest", async function () {
        let borrowerWallet: Wallet = await generateWallet(
          assetContract,
          depositAmount,
          userSigner
        );

        await vault.connect(ownerSigner).setBorrower(borrowerWallet.address);

        await time.increase(86400 * 3 + 1);
        await vault.connect(ownerSigner).commitBorrower();

        let balBefore = await assetContract.balanceOf(vault.address);

        const { v, r, s } = await getPermitSignature(
          borrowerWallet,
          assetContract,
          vault.address,
          depositAmount,
          constants.MaxUint256
        );

        await vault
          .connect(await ethers.provider.getSigner(borrowerWallet.address))
          ["returnLentFunds(uint256,uint256,uint8,bytes32,bytes32)"](
            depositAmount,
            constants.MaxUint256,
            v,
            r,
            s
          );

        let balAfter = await assetContract.balanceOf(vault.address);

        // Received USDC
        assert.bnEqual(balAfter.sub(balBefore), depositAmount);
      });

      it("approve and pay principal + interest", async function () {
        await assetContract
          .connect(borrowerSigner)
          .approve(vault.address, depositAmount);

        let balBefore = await assetContract.balanceOf(vault.address);

        await vault
          .connect(borrowerSigner)
          ["returnLentFunds(uint256)"](depositAmount);

        let balAfter = await assetContract.balanceOf(vault.address);

        // Received USDC
        assert.bnEqual(balAfter.sub(balBefore), depositAmount);
      });

      it("adds option yield to vault", async function () {
        let newDepositAmount = depositAmount.div(2);

        await assetContract
          .connect(borrowerSigner)
          .approve(vault.address, depositAmount);

        let amtFundsReturnedBefore = (await vault.vaultState())
          .amtFundsReturned;
        let totalBalanceBefore = await vault.totalBalance();

        let tx = await vault
          .connect(borrowerSigner)
          ["returnLentFunds(uint256)"](newDepositAmount);

        let amtFundsReturnedAfter = (await vault.vaultState()).amtFundsReturned;
        let totalBalanceAfter = await vault.totalBalance();

        // Test amount funds increased
        assert.bnEqual(
          amtFundsReturnedAfter.sub(amtFundsReturnedBefore),
          newDepositAmount
        );

        // Test total balance stayed the same
        assert.bnEqual(totalBalanceAfter, totalBalanceBefore);

        let totalToReturn = newDepositAmount.sub(
          (await vault.allocationState()).loanAllocation
        );

        if (parseInt(totalToReturn.toString()) < 0) {
          totalToReturn = BigNumber.from(0);
        }

        await expect(tx)
          .to.emit(vault, "CloseLoan")
          .withArgs(
            newDepositAmount,
            totalToReturn,
            totalToReturn
              .mul(12)
              .mul(100)
              .div((await vault.allocationState()).loanAllocation),
            borrower
          );

        let tx2 = await vault
          .connect(borrowerSigner)
          ["returnLentFunds(uint256)"](1);

        await expect(tx2)
          .to.emit(vault, "CloseLoan")
          .withArgs(1, 0, 0, borrower);
      });

      it("adds option yield to vault pt 2", async function () {
        await assetContract
          .connect(borrowerSigner)
          .approve(vault.address, depositAmount);

        let totalBalanceBefore = await vault.totalBalance();

        await vault
          .connect(borrowerSigner)
          ["returnLentFunds(uint256)"](depositAmount);

        let totalBalanceAfter = await vault.totalBalance();

        // Diff from capping amtFundsReturned in total balance
        let diff = depositAmount.sub(
          (await vault.allocationState()).loanAllocation
        );

        // Test total balance stayed the same
        assert.bnEqual(totalBalanceAfter, totalBalanceBefore.add(diff));
      });
    });

    describe("#rollToNextRound", () => {
      const depositAmount = params.depositAmount;

      time.revertToSnapshotAfterEach(async function () {
        await depositIntoVault(params.collateralAsset, vault, depositAmount);
      });

      it("reverts when not called with keeper", async function () {
        await expect(
          vault.connect(ownerSigner).rollToNextRound()
        ).to.be.revertedWith("!keeper");
      });

      it("reverts when calling before round over", async function () {
        const firstTx = await vault.connect(keeperSigner).rollToNextRound();

        await expect(firstTx)
          .to.emit(vault, "OpenLoan")
          .withArgs(
            (
              await vault.allocationState()
            ).loanAllocation,
            await vault.borrower()
          );

        // Loan allocation PCT of the vault's balance is allocated to loan
        assert.bnEqual(
          await assetContract.balanceOf(vault.address),
          depositAmount.mul(optionAllocationPCT).div(await vault.TOTAL_PCT())
        );

        await expect(
          vault.connect(keeperSigner).rollToNextRound()
        ).to.be.revertedWith("!ready");
      });

      it("transfers funds to borrower", async function () {
        let balBefore = await assetContract.balanceOf(borrower);

        await vault.connect(keeperSigner).rollToNextRound();

        let balAfter = await assetContract.balanceOf(borrower);

        // Loan allocation PCT of the vault's balance is allocated to loan
        assert.bnEqual(
          balAfter.sub(balBefore),
          (await vault.allocationState()).loanAllocation
        );
      });

      it("updates allocation state", async function () {
        let newLoanTermLength = 86400;
        let newOptionPurchaseFrequency = 43200;

        await vault.connect(ownerSigner).setLoanTermLength(newLoanTermLength);
        await vault
          .connect(ownerSigner)
          .setOptionPurchaseFrequency(newOptionPurchaseFrequency);

        await rollToNextRound(true, true, false);

        // Sets new loan term length / option purchase frequency

        assert.equal((await vault.allocationState()).nextLoanTermLength, 0);
        assert.equal(
          (await vault.allocationState()).currentLoanTermLength,
          newLoanTermLength
        );

        assert.equal((await vault.allocationState()).nextOptionPurchaseFreq, 0);
        assert.equal(
          (await vault.allocationState()).currentOptionPurchaseFreq,
          newOptionPurchaseFrequency
        );

        // Sets correct allocation for loan / option purchases
        assert.equal(
          (await vault.allocationState()).loanAllocation.toString(),
          BigNumber.from((await vault.allocationState()).loanAllocationPCT)
            .mul((await vault.vaultState()).lockedAmount)
            .div(await vault.TOTAL_PCT())
            .toString()
        );
        assert.equal(
          (await vault.allocationState()).optionAllocation.toString(),
          (await vault.vaultState()).lockedAmount
            .sub((await vault.allocationState()).loanAllocation)
            .toString()
        );

        let now = await time.now();

        // Sets correct lastEpochTime
        assert.equal(
          (await vault.vaultState()).lastEpochTime.toString(),
          now
            .sub(BigNumber.from(parseInt(now.toString()) % 86400))
            .add(28800)
            .toString()
        );
      });

      it("withdraws and roll funds into next round, after breaking even", async function () {
        const firstTx = await vault.connect(keeperSigner).rollToNextRound();

        await expect(firstTx)
          .to.emit(vault, "OpenLoan")
          .withArgs(
            (
              await vault.allocationState()
            ).loanAllocation,
            await vault.borrower()
          );

        await buyAllOptions();

        const beforeBalance = await assetContract.balanceOf(vault.address);

        // For breaking even

        // Repay Interest
        let interest = BigNumber.from(
          (await vault.allocationState()).optionAllocation
        );
        let totalToReturn = (await vault.allocationState()).loanAllocation.add(
          interest
        );

        await assetContract
          .connect(borrowerSigner)
          .approve(vault.address, totalToReturn);
        let firstCloseTx = await vault
          .connect(borrowerSigner)
          ["returnLentFunds(uint256)"](totalToReturn);

        const afterBalance = await assetContract.balanceOf(vault.address);

        // test that the vault's balance stayed same
        assert.equal(
          parseInt(depositAmount.toString()),
          parseInt(BigNumber.from(afterBalance).sub(beforeBalance).toString())
        );

        await expect(firstCloseTx)
          .to.emit(vault, "CloseLoan")
          .withArgs(
            totalToReturn,
            interest,
            interest
              .mul(12)
              .mul(100)
              .div((await vault.allocationState()).loanAllocation),
            borrower
          );

        // Time increase to next round
        await time.increaseTo(
          (
            await vault.vaultState()
          ).lastEpochTime.add(
            (
              await vault.allocationState()
            ).currentLoanTermLength
          )
        );

        await assetContract.balanceOf(vault.address);

        const secondTx = await vault.connect(keeperSigner).rollToNextRound();

        await expect(secondTx)
          .to.emit(vault, "OpenLoan")
          .withArgs(
            (
              await vault.allocationState()
            ).loanAllocation,
            await vault.borrower()
          );

        assert.equal(
          (await assetContract.balanceOf(vault.address)).toString(),
          depositAmount.mul(optionAllocationPCT).div(await vault.TOTAL_PCT())
        );
      });

      it("withdraws and roll funds into next option, after bought options expiry ITM", async function () {
        const firstTx = await vault.connect(keeperSigner).rollToNextRound();

        await expect(firstTx)
          .to.emit(vault, "OpenLoan")
          .withArgs(
            (
              await vault.allocationState()
            ).loanAllocation,
            await vault.borrower()
          );

        await buyAllOptions();

        const beforeBalance = await assetContract.balanceOf(vault.address);

        // For earning yield
        let yieldAmount = BigNumber.from(
          (await vault.allocationState()).optionAllocation
        ).mul(2);
        await assetContract
          .connect(optionSellerSigner)
          .approve(vault.address, yieldAmount);
        await vault
          .connect(optionSellerSigner)
          ["payOptionYield(uint256)"](yieldAmount);

        // Repay Interest
        let interest = BigNumber.from(
          (await vault.allocationState()).optionAllocation
        );
        let totalToReturn = (await vault.allocationState()).loanAllocation.add(
          interest
        );
        await assetContract
          .connect(borrowerSigner)
          .approve(vault.address, totalToReturn);
        let firstCloseTx = await vault
          .connect(borrowerSigner)
          ["returnLentFunds(uint256)"](totalToReturn);

        const afterBalance = await assetContract.balanceOf(vault.address);

        // test that the vault's balance increased when earning yield
        assert.equal(
          parseInt(depositAmount.add(yieldAmount).toString()),
          parseInt(BigNumber.from(afterBalance).sub(beforeBalance).toString())
        );

        await expect(firstCloseTx)
          .to.emit(vault, "CloseLoan")
          .withArgs(
            totalToReturn,
            interest,
            interest
              .mul(12)
              .mul(100)
              .div((await vault.allocationState()).loanAllocation),
            borrower
          );

        // Time increase to next round
        await time.increaseTo(
          (
            await vault.vaultState()
          ).lastEpochTime.add(
            (
              await vault.allocationState()
            ).currentLoanTermLength
          )
        );

        let pendingAmount = (await vault.vaultState()).totalPending;
        let [secondInitialLockedBalance, queuedWithdrawAmount] =
          await lockedBalanceForRollover(vault);

        const secondInitialTotalBalance = await vault.totalBalance();

        const secondTx = await vault.connect(keeperSigner).rollToNextRound();

        let vaultFees = secondInitialLockedBalance
          .add(queuedWithdrawAmount)
          .sub(pendingAmount)
          .mul(await vault.managementFee())
          .div(BigNumber.from(100).mul(BigNumber.from(10).pow(6)));

        vaultFees = vaultFees.add(
          secondInitialLockedBalance
            .add(queuedWithdrawAmount)
            .sub((await vault.vaultState()).lastLockedAmount)
            .sub(pendingAmount)
            .mul(await vault.performanceFee())
            .div(BigNumber.from(100).mul(BigNumber.from(10).pow(6)))
        );

        const totalBalanceAfterFee = await vault.totalBalance();

        assert.equal(
          secondInitialTotalBalance.sub(totalBalanceAfterFee).toString(),
          vaultFees.toString()
        );

        await expect(secondTx)
          .to.emit(vault, "OpenLoan")
          .withArgs(
            (
              await vault.allocationState()
            ).loanAllocation,
            await vault.borrower()
          );

        assert.equal(
          (await assetContract.balanceOf(vault.address)).toString(),
          (await vault.allocationState()).optionAllocation
        );
      });

      it("withdraws and roll funds into next option, after bought options expiry ITM (initiateWithdraw)", async function () {
        await depositIntoVault(
          params.collateralAsset,
          vault,
          depositAmount,
          ownerSigner
        );

        await vault.connect(keeperSigner).rollToNextRound();

        await vault
          .connect(ownerSigner)
          .initiateWithdraw(params.depositAmount.div(2));

        // Repay Interest
        let interest = BigNumber.from(
          (await vault.allocationState()).optionAllocation
        );
        let totalToReturn = BigNumber.from(
          (await vault.allocationState()).loanAllocation
        ).add(interest);
        await assetContract
          .connect(borrowerSigner)
          .approve(vault.address, totalToReturn);
        await vault
          .connect(borrowerSigner)
          ["returnLentFunds(uint256)"](totalToReturn);

        // Time increase to next round
        await time.increaseTo(
          (
            await vault.vaultState()
          ).lastEpochTime.add(
            (
              await vault.allocationState()
            ).currentLoanTermLength
          )
        );

        await vault.connect(keeperSigner).rollToNextRound();

        let [, queuedWithdrawAmountInitial] = await lockedBalanceForRollover(
          vault
        );

        await vault.initiateWithdraw(params.depositAmount.div(2));

        for (
          let i = 0;
          i <
          parseInt(
            BigNumber.from(
              (await vault.allocationState()).currentLoanTermLength
            )
              .div((await vault.allocationState()).currentOptionPurchaseFreq)
              .toString()
          );
          i++
        ) {
          await vault.connect(keeperSigner).buyOption();
          await time.increaseTo(
            (
              await vault.vaultState()
            ).lastOptionPurchaseTime.add(
              (
                await vault.allocationState()
              ).currentOptionPurchaseFreq
            )
          );
        }

        // For earning yield
        let yieldAmount = (await vault.allocationState()).optionAllocation.mul(
          2
        );
        await assetContract
          .connect(optionSellerSigner)
          .approve(vault.address, yieldAmount);
        await vault
          .connect(optionSellerSigner)
          ["payOptionYield(uint256)"](yieldAmount);

        // Repay Interest
        let interest2 = BigNumber.from(
          (await vault.allocationState()).optionAllocation
        );
        let totalToReturn2 = (await vault.allocationState()).loanAllocation.add(
          interest2
        );
        await assetContract
          .connect(borrowerSigner)
          .approve(vault.address, totalToReturn2);
        await vault
          .connect(borrowerSigner)
          ["returnLentFunds(uint256)"](totalToReturn2);

        let pendingAmount = (await vault.vaultState()).totalPending;
        let [secondInitialLockedBalance, queuedWithdrawAmount] =
          await lockedBalanceForRollover(vault);

        const secondInitialBalance = await vault.totalBalance();

        await vault.connect(keeperSigner).rollToNextRound();

        let vaultFees = secondInitialLockedBalance
          .add(queuedWithdrawAmount.sub(queuedWithdrawAmountInitial))
          .sub(pendingAmount)
          .mul(await vault.managementFee())
          .div(BigNumber.from(100).mul(BigNumber.from(10).pow(6)));

        vaultFees = vaultFees.add(
          secondInitialLockedBalance
            .add(queuedWithdrawAmount.sub(queuedWithdrawAmountInitial))
            .sub((await vault.vaultState()).lastLockedAmount)
            .sub(pendingAmount)
            .mul(await vault.performanceFee())
            .div(BigNumber.from(100).mul(BigNumber.from(10).pow(6)))
        );

        assert.equal(
          secondInitialBalance.sub(await vault.totalBalance()).toString(),
          vaultFees.toString()
        );
      });

      it("does not debit the user on first deposit", async () => {
        // totalBalance should remain the same before and after roll
        const startBalance = await vault.totalBalance();

        await vault.connect(keeperSigner).rollToNextRound();

        assert.bnEqual(await vault.totalBalance(), startBalance);
        assert.bnEqual(await vault.accountVaultBalance(user), depositAmount);

        // simulate a profit by transferring some tokens
        await assetContract
          .connect(userSigner)
          .transfer(vault.address, BigNumber.from(1));

        // totalBalance should remain the same before and after roll
        const secondStartBalance = await vault.totalBalance();

        await buyAllOptions();
        await repayInterest();

        // Time increase to next round
        await time.increaseTo(
          (
            await vault.vaultState()
          ).lastEpochTime.add(
            (
              await vault.allocationState()
            ).currentLoanTermLength
          )
        );

        await vault.connect(keeperSigner).rollToNextRound();

        // After the first round, the user is charged the fee
        assert.bnLt(await vault.totalBalance(), secondStartBalance);
        assert.bnLt(await vault.accountVaultBalance(user), depositAmount);
      });

      it("fits gas budget [ @skip-on-coverage ]", async function () {
        const tx = await vault.connect(keeperSigner).rollToNextRound();
        const receipt = await tx.wait();

        assert.isAtMost(receipt.gasUsed.toNumber(), 1018000);
      });
    });

    describe("#assetBalance", () => {
      time.revertToSnapshotAfterEach(async function () {
        await depositIntoVault(
          params.collateralAsset,
          vault,
          params.depositAmount
        );

        await vault.connect(keeperSigner).rollToNextRound();
      });

      it("returns the free balance - locked, if free > locked", async function () {
        const newDepositAmount = BigNumber.from("1000000000000");
        await depositIntoVault(params.collateralAsset, vault, newDepositAmount);

        assert.bnEqual(
          await assetContract.balanceOf(vault.address),
          newDepositAmount.add((await vault.allocationState()).optionAllocation)
        );
      });
    });

    describe("#maxRedeem", () => {
      time.revertToSnapshotAfterEach(async function () {});

      it("is able to redeem deposit at new price per share", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, params.depositAmount);

        await vault.deposit(params.depositAmount);

        await vault.connect(keeperSigner).rollToNextRound();

        const tx = await vault.maxRedeem();

        assert.bnEqual(
          (await assetContract.balanceOf(vault.address)).sub(
            (await vault.allocationState()).optionAllocation
          ),
          BigNumber.from(0)
        );
        assert.bnEqual(await vault.balanceOf(user), params.depositAmount);
        assert.bnEqual(await vault.balanceOf(vault.address), BigNumber.from(0));

        await expect(tx)
          .to.emit(vault, "Redeem")
          .withArgs(user, params.depositAmount, 1);

        const { round, amount, unredeemedShares } = await vault.depositReceipts(
          user
        );

        assert.equal(round, 1);
        assert.bnEqual(amount, BigNumber.from(0));
        assert.bnEqual(unredeemedShares, BigNumber.from(0));
      });

      it("changes balance only once when redeeming twice", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, params.depositAmount);

        await vault.deposit(params.depositAmount);

        await vault.connect(keeperSigner).rollToNextRound();

        await vault.maxRedeem();

        assert.bnEqual(
          (await assetContract.balanceOf(vault.address)).sub(
            (await vault.allocationState()).optionAllocation
          ),
          BigNumber.from(0)
        );
        assert.bnEqual(await vault.balanceOf(user), params.depositAmount);
        assert.bnEqual(await vault.balanceOf(vault.address), BigNumber.from(0));

        const { round, amount, unredeemedShares } = await vault.depositReceipts(
          user
        );

        assert.equal(round, 1);
        assert.bnEqual(amount, BigNumber.from(0));
        assert.bnEqual(unredeemedShares, BigNumber.from(0));

        let res = await vault.maxRedeem();

        await expect(res).to.not.emit(vault, "Transfer");

        assert.bnEqual(
          (await assetContract.balanceOf(vault.address)).sub(
            (await vault.allocationState()).optionAllocation
          ),
          BigNumber.from(0)
        );

        assert.bnEqual(await vault.balanceOf(user), params.depositAmount);
        assert.bnEqual(await vault.balanceOf(vault.address), BigNumber.from(0));
      });

      it("redeems after a deposit what was unredeemed from previous rounds", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, params.depositAmount.mul(2));
        await vault.deposit(params.depositAmount);

        await rollToNextRound(false, false, false);

        await vault.deposit(params.depositAmount);

        const tx = await vault.maxRedeem();

        await expect(tx)
          .to.emit(vault, "Redeem")
          .withArgs(user, params.depositAmount, 2);
      });

      it("is able to redeem deposit at correct pricePerShare after closing with options bought expiry OTM", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, params.depositAmount);

        await assetContract
          .connect(ownerSigner)
          .approve(vault.address, params.depositAmount);

        await vault.connect(keeperSigner).rollToNextRound();

        // Mid-week deposit in round 1
        await assetContract
          .connect(userSigner)
          .transfer(owner, params.depositAmount);
        await vault.connect(ownerSigner).deposit(params.depositAmount);

        await rollToNextRound(true, true, false);

        // Mid-week deposit in round 2
        await vault.connect(userSigner).deposit(params.depositAmount);

        const beforeBalance = await vault.totalBalance();

        const beforePps = await vault.pricePerShare();

        await rollToNextRound(false, false, false);

        const afterBalance = await vault.totalBalance();
        const afterPps = await vault.pricePerShare();
        const expectedMintAmountAfterLoss = params.depositAmount
          .mul(BigNumber.from(10).pow(params.tokenDecimals))
          .div(afterPps);

        assert.bnGt(beforeBalance, afterBalance);
        assert.bnGt(beforePps, afterPps);

        // owner should lose money
        // User should not lose money
        // owner redeems the deposit from round 1 so there is a loss from OTM bought options
        const tx1 = await vault.connect(ownerSigner).maxRedeem();
        await expect(tx1)
          .to.emit(vault, "Redeem")
          .withArgs(owner, params.depositAmount, 2);

        const {
          round: round1,
          amount: amount1,
          unredeemedShares: unredeemedShares1,
        } = await vault.depositReceipts(owner);
        assert.equal(round1, 2);
        assert.bnEqual(amount1, BigNumber.from(0));
        assert.bnEqual(unredeemedShares1, BigNumber.from(0));
        assert.bnEqual(await vault.balanceOf(owner), params.depositAmount);

        // User deposit in round 2 so no loss
        // we should use the pps after the loss which is the lower pps
        const tx2 = await vault.connect(userSigner).maxRedeem();

        await expect(tx2)
          .to.emit(vault, "Redeem")
          .withArgs(user, expectedMintAmountAfterLoss, 3);

        const {
          round: round2,
          amount: amount2,
          unredeemedShares: unredeemedShares2,
        } = await vault.depositReceipts(user);
        assert.equal(round2, 3);
        assert.bnEqual(amount2, BigNumber.from(0));
        assert.bnEqual(unredeemedShares2, BigNumber.from(0));
        assert.bnEqual(
          await vault.balanceOf(user),
          expectedMintAmountAfterLoss
        );
      });
    });

    describe("#redeem", () => {
      time.revertToSnapshotAfterEach();

      it("reverts when 0 passed", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);
        await rollToNextRound();
        await expect(vault.redeem(0)).to.be.revertedWith("!numShares");
      });

      it("reverts when redeeming more than available", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);

        await rollToNextRound();

        await expect(vault.redeem(depositAmount.add(1))).to.be.revertedWith(
          "Exceeds available"
        );
      });

      it("decreases unredeemed shares", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);

        await rollToNextRound();

        const redeemAmount = BigNumber.from(1);
        const tx1 = await vault.redeem(redeemAmount);

        await expect(tx1)
          .to.emit(vault, "Redeem")
          .withArgs(user, redeemAmount, 1);

        const {
          round: round1,
          amount: amount1,
          unredeemedShares: unredeemedShares1,
        } = await vault.depositReceipts(user);

        assert.equal(round1, 1);
        assert.bnEqual(amount1, BigNumber.from(0));
        assert.bnEqual(unredeemedShares1, depositAmount.sub(redeemAmount));

        const tx2 = await vault.redeem(depositAmount.sub(redeemAmount));

        await expect(tx2)
          .to.emit(vault, "Redeem")
          .withArgs(user, depositAmount.sub(redeemAmount), 1);

        const {
          round: round2,
          amount: amount2,
          unredeemedShares: unredeemedShares2,
        } = await vault.depositReceipts(user);

        assert.equal(round2, 1);
        assert.bnEqual(amount2, BigNumber.from(0));
        assert.bnEqual(unredeemedShares2, BigNumber.from(0));
      });
    });

    describe("#withdrawInstantly", () => {
      time.revertToSnapshotAfterEach();

      it("reverts with 0 amount", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);

        await expect(vault.withdrawInstantly(0)).to.be.revertedWith("!amount");
      });

      it("reverts when withdrawing more than available", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);

        await expect(
          vault.withdrawInstantly(depositAmount.add(1))
        ).to.be.revertedWith("Exceed amount");
      });

      it("reverts when deposit receipt is processed", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);

        await rollToNextRound();

        await vault.maxRedeem();

        await expect(
          vault.withdrawInstantly(depositAmount.add(1))
        ).to.be.revertedWith("Invalid round");
      });

      it("reverts when withdrawing next round", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);

        await rollToNextRound();

        await expect(
          vault.withdrawInstantly(depositAmount.add(1))
        ).to.be.revertedWith("Invalid round");
      });

      it("withdraws the amount in deposit receipt", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);

        let startBalance: BigNumber;
        let withdrawAmount: BigNumber;
        if (collateralAsset === WETH_ADDRESS[chainId]) {
          startBalance = await provider.getBalance(user);
        } else {
          startBalance = await assetContract.balanceOf(user);
        }

        const tx = await vault.withdrawInstantly(depositAmount, { gasPrice });
        const receipt = await tx.wait();

        if (collateralAsset === WETH_ADDRESS[chainId]) {
          const endBalance = await provider.getBalance(user);
          withdrawAmount = endBalance
            .sub(startBalance)
            .add(receipt.gasUsed.mul(gasPrice));
        } else {
          const endBalance = await assetContract.balanceOf(user);
          withdrawAmount = endBalance.sub(startBalance);
        }
        assert.bnEqual(withdrawAmount, depositAmount);

        await expect(tx)
          .to.emit(vault, "InstantWithdraw")
          .withArgs(user, depositAmount, 1);

        const { round, amount } = await vault.depositReceipts(user);
        assert.equal(round, 1);
        assert.bnEqual(amount, BigNumber.from(0));

        // Should decrement the pending amounts
        assert.bnEqual(await vault.totalPending(), BigNumber.from(0));
      });
    });

    describe("#initiateWithdraw", () => {
      time.revertToSnapshotAfterEach(async () => {});

      it("reverts when user initiates withdraws without any deposit", async function () {
        await expect(vault.initiateWithdraw(depositAmount)).to.be.revertedWith(
          "ERC20: transfer amount exceeds balance"
        );
      });

      it("reverts when passed 0 shares", async function () {
        await expect(vault.initiateWithdraw(0)).to.be.revertedWith(
          "!numShares"
        );
      });

      it("reverts when withdrawing more than unredeemed balance", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);

        await rollToNextRound();

        await expect(
          vault.initiateWithdraw(depositAmount.add(1))
        ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
      });

      it("reverts when withdrawing more than vault + account balance", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);

        await rollToNextRound();

        // Move 1 share into account
        await vault.redeem(1);

        await expect(
          vault.initiateWithdraw(depositAmount.add(1))
        ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
      });

      it("reverts when initiating with past existing withdrawal", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);

        await rollToNextRound();

        await vault.initiateWithdraw(depositAmount.div(2));

        await rollToNextRound();

        await expect(
          vault.initiateWithdraw(depositAmount.div(2))
        ).to.be.revertedWith("Existing withdraw");
      });

      it("creates withdrawal from unredeemed shares", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);

        await rollToNextRound();

        const tx = await vault.initiateWithdraw(depositAmount);

        await expect(tx)
          .to.emit(vault, "InitiateWithdraw")
          .withArgs(user, depositAmount, 2);

        await expect(tx)
          .to.emit(vault, "Transfer")
          .withArgs(vault.address, user, depositAmount);

        const { round, shares } = await vault.withdrawals(user);
        assert.equal(round, 2);
        assert.bnEqual(shares, depositAmount);
      });

      it("creates withdrawal by debiting user shares", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);

        await rollToNextRound();

        await vault.redeem(depositAmount.div(2));

        const tx = await vault.initiateWithdraw(depositAmount);

        await expect(tx)
          .to.emit(vault, "InitiateWithdraw")
          .withArgs(user, depositAmount, 2);

        // First we redeem the leftover amount
        await expect(tx)
          .to.emit(vault, "Transfer")
          .withArgs(vault.address, user, depositAmount.div(2));

        // Then we debit the shares from the user
        await expect(tx)
          .to.emit(vault, "Transfer")
          .withArgs(user, vault.address, depositAmount);

        assert.bnEqual(await vault.balanceOf(user), BigNumber.from(0));
        assert.bnEqual(await vault.balanceOf(vault.address), depositAmount);

        const { round, shares } = await vault.withdrawals(user);
        assert.equal(round, 2);
        assert.bnEqual(shares, depositAmount);
      });

      it("tops up existing withdrawal", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);

        await rollToNextRound();

        const tx1 = await vault.initiateWithdraw(depositAmount.div(2));
        // We redeem the full amount on the first initiateWithdraw
        await expect(tx1)
          .to.emit(vault, "Transfer")
          .withArgs(vault.address, user, depositAmount);
        await expect(tx1)
          .to.emit(vault, "Transfer")
          .withArgs(user, vault.address, depositAmount.div(2));

        const tx2 = await vault.initiateWithdraw(depositAmount.div(2));
        await expect(tx2)
          .to.emit(vault, "Transfer")
          .withArgs(user, vault.address, depositAmount.div(2));

        const { round, shares } = await vault.withdrawals(user);
        assert.equal(round, 2);
        assert.bnEqual(shares, depositAmount);
      });
      it("reverts when there is insufficient balance over multiple calls", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);

        await rollToNextRound();

        await vault.initiateWithdraw(depositAmount.div(2));

        await expect(
          vault.initiateWithdraw(depositAmount.div(2).add(1))
        ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
      });

      it("fits gas budget [ @skip-on-coverage ]", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);

        await rollToNextRound();

        const tx = await vault.initiateWithdraw(depositAmount);
        const receipt = await tx.wait();
        assert.isAtMost(receipt.gasUsed.toNumber(), 126000);
      });
    });

    describe("#completeWithdraw", () => {
      time.revertToSnapshotAfterEach(async () => {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);

        await assetContract.connect(userSigner).transfer(owner, depositAmount);
        await assetContract
          .connect(ownerSigner)
          .approve(vault.address, depositAmount);
        await vault.connect(ownerSigner).deposit(depositAmount);

        await vault.connect(keeperSigner).rollToNextRound();
        await vault.initiateWithdraw(depositAmount);
      });

      it("reverts when not initiated", async function () {
        await expect(
          vault.connect(ownerSigner).completeWithdraw()
        ).to.be.revertedWith("Not initiated");
      });

      it("reverts when round not closed", async function () {
        await expect(vault.completeWithdraw()).to.be.revertedWith(
          "Round not closed"
        );
      });

      it("reverts when calling completeWithdraw twice", async function () {
        await repayInterest();
        await time.increaseTo(
          (
            await vault.vaultState()
          ).lastEpochTime.add(
            (
              await vault.allocationState()
            ).currentLoanTermLength
          )
        );
        await vault.connect(keeperSigner).rollToNextRound();

        await vault.completeWithdraw();

        await expect(vault.completeWithdraw()).to.be.revertedWith(
          "Not initiated"
        );
      });

      it("completes the withdrawal", async function () {
        // await repayInterest();
        await buyAllOptions();
        await assetContract
          .connect(userSigner)
          .transfer(vault.address, depositAmount);

        await time.increaseTo(
          (
            await vault.vaultState()
          ).lastEpochTime.add(
            (
              await vault.allocationState()
            ).currentLoanTermLength
          )
        );
        await vault.connect(keeperSigner).rollToNextRound();

        const pricePerShare = await vault.roundPricePerShare(2);
        const withdrawAmount = depositAmount
          .mul(pricePerShare)
          .div(BigNumber.from(10).pow(await vault.decimals()));
        const lastQueuedWithdrawAmount = await vault.lastQueuedWithdrawAmount();

        let beforeBalance: BigNumber;
        if (collateralAsset === WETH_ADDRESS[chainId]) {
          beforeBalance = await provider.getBalance(user);
        } else {
          beforeBalance = await assetContract.balanceOf(user);
        }

        const { queuedWithdrawShares: startQueuedShares } =
          await vault.vaultState();

        const tx = await vault.completeWithdraw({ gasPrice });
        const receipt = await tx.wait();
        const gasFee = receipt.gasUsed.mul(gasPrice);

        await expect(tx)
          .to.emit(vault, "Withdraw")
          .withArgs(user, withdrawAmount.toString(), depositAmount);

        if (collateralAsset !== WETH_ADDRESS[chainId]) {
          const collateralERC20 = await getContractAt(
            "IERC20",
            collateralAsset
          );

          await expect(tx)
            .to.emit(collateralERC20, "Transfer")
            .withArgs(vault.address, user, withdrawAmount);
        }

        const { shares, round } = await vault.withdrawals(user);
        assert.equal(shares, 0);
        assert.equal(round, 2);

        const { queuedWithdrawShares: endQueuedShares } =
          await vault.vaultState();

        assert.bnEqual(endQueuedShares, BigNumber.from(0));
        assert.bnEqual(
          await vault.lastQueuedWithdrawAmount(),
          lastQueuedWithdrawAmount.sub(withdrawAmount)
        );
        assert.bnEqual(startQueuedShares.sub(endQueuedShares), depositAmount);

        let actualWithdrawAmount: BigNumber;
        if (collateralAsset === WETH_ADDRESS[chainId]) {
          const afterBalance = await provider.getBalance(user);
          actualWithdrawAmount = afterBalance.sub(beforeBalance).add(gasFee);
        } else {
          const afterBalance = await assetContract.balanceOf(user);
          actualWithdrawAmount = afterBalance.sub(beforeBalance);
        }
        // Should be less because the pps is down
        assert.bnLt(actualWithdrawAmount, depositAmount);
        assert.bnEqual(actualWithdrawAmount, withdrawAmount);
      });

      it("fits gas budget [ @skip-on-coverage ]", async function () {
        await repayInterest();

        await time.increaseTo(
          (
            await vault.vaultState()
          ).lastEpochTime.add(
            (
              await vault.allocationState()
            ).currentLoanTermLength
          )
        );
        await vault.connect(keeperSigner).rollToNextRound();

        const tx = await vault.completeWithdraw({ gasPrice });
        const receipt = await tx.wait();

        assert.isAtMost(receipt.gasUsed.toNumber(), 100342);
      });
    });

    describe("#stake", () => {
      let liquidityGauge: Contract;

      time.revertToSnapshotAfterEach(async () => {
        const MockLiquidityGauge = await getContractFactory(
          "MockLiquidityGauge",
          ownerSigner
        );
        liquidityGauge = await MockLiquidityGauge.deploy(vault.address);
      });

      it("reverts when liquidityGauge is not set", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);
        await rollToNextRound();
        await expect(vault.stake(depositAmount)).to.be.reverted;
      });

      it("reverts when 0 passed", async function () {
        await vault
          .connect(ownerSigner)
          .setLiquidityGauge(liquidityGauge.address);
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);
        await rollToNextRound();
        await expect(vault.stake(0)).to.be.reverted;
      });

      it("reverts when staking more than available", async function () {
        await vault
          .connect(ownerSigner)
          .setLiquidityGauge(liquidityGauge.address);

        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.connect(userSigner).deposit(depositAmount);

        await rollToNextRound();

        await expect(
          vault.connect(userSigner).stake(depositAmount.add(1))
        ).to.be.revertedWith("Exceeds available");
      });

      it("reverts when staking more than available after redeeming", async function () {
        await vault
          .connect(ownerSigner)
          .setLiquidityGauge(liquidityGauge.address);

        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.connect(userSigner).deposit(depositAmount);

        await rollToNextRound();

        await vault.connect(userSigner).maxRedeem();

        await expect(
          vault.connect(userSigner).stake(depositAmount.add(1))
        ).to.be.revertedWith("Exceeds available");
      });

      it("stakes shares", async function () {
        await vault
          .connect(ownerSigner)
          .setLiquidityGauge(liquidityGauge.address);

        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.connect(userSigner).deposit(depositAmount);

        const userOldBalance = await vault.balanceOf(user);

        await rollToNextRound();

        const stakeAmount = BigNumber.from(1);
        const tx1 = await vault.connect(userSigner).stake(stakeAmount);

        await expect(tx1)
          .to.emit(vault, "Redeem")
          .withArgs(user, stakeAmount, 1);

        assert.bnEqual(await liquidityGauge.balanceOf(user), stakeAmount);
        assert.bnEqual(
          await vault.balanceOf(liquidityGauge.address),
          stakeAmount
        );
        assert.bnEqual(await vault.balanceOf(user), userOldBalance);

        const {
          round: round1,
          amount: amount1,
          unredeemedShares: unredeemedShares1,
        } = await vault.depositReceipts(user);

        assert.equal(round1, 1);
        assert.bnEqual(amount1, BigNumber.from(0));
        assert.bnEqual(unredeemedShares1, depositAmount.sub(stakeAmount));

        const tx2 = await vault
          .connect(userSigner)
          .stake(depositAmount.sub(stakeAmount));

        await expect(tx2)
          .to.emit(vault, "Redeem")
          .withArgs(user, depositAmount.sub(stakeAmount), 1);

        assert.bnEqual(await liquidityGauge.balanceOf(user), depositAmount);
        assert.bnEqual(
          await vault.balanceOf(liquidityGauge.address),
          depositAmount
        );
        assert.bnEqual(await vault.balanceOf(user), userOldBalance);

        const {
          round: round2,
          amount: amount2,
          unredeemedShares: unredeemedShares2,
        } = await vault.depositReceipts(user);

        assert.equal(round2, 1);
        assert.bnEqual(amount2, BigNumber.from(0));
        assert.bnEqual(unredeemedShares2, BigNumber.from(0));
      });

      it("stakes shares after redeeming", async function () {
        await vault
          .connect(ownerSigner)
          .setLiquidityGauge(liquidityGauge.address);

        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.connect(userSigner).deposit(depositAmount);

        const userOldBalance = await vault.balanceOf(user);

        await rollToNextRound();

        const stakeAmount = depositAmount.div(2);
        const redeemAmount = depositAmount.div(3);

        await vault.connect(userSigner).redeem(redeemAmount);
        const tx1 = await vault.connect(userSigner).stake(stakeAmount);

        await expect(tx1)
          .to.emit(vault, "Redeem")
          .withArgs(user, stakeAmount.sub(redeemAmount), 1);

        assert.bnEqual(await liquidityGauge.balanceOf(user), stakeAmount);
        assert.bnEqual(
          await vault.balanceOf(liquidityGauge.address),
          stakeAmount
        );
        assert.bnEqual(await vault.balanceOf(user), userOldBalance);

        const {
          round: round1,
          amount: amount1,
          unredeemedShares: unredeemedShares1,
        } = await vault.depositReceipts(user);

        assert.equal(round1, 1);
        assert.bnEqual(amount1, BigNumber.from(0));
        assert.bnEqual(unredeemedShares1, depositAmount.sub(stakeAmount));

        await vault.connect(userSigner).maxRedeem();
        await vault.connect(userSigner).stake(depositAmount.sub(stakeAmount));

        assert.bnEqual(await liquidityGauge.balanceOf(user), depositAmount);
        assert.bnEqual(
          await vault.balanceOf(liquidityGauge.address),
          depositAmount
        );
        assert.bnEqual(await vault.balanceOf(user), userOldBalance);

        const {
          round: round2,
          amount: amount2,
          unredeemedShares: unredeemedShares2,
        } = await vault.depositReceipts(user);

        assert.equal(round2, 1);
        assert.bnEqual(amount2, BigNumber.from(0));
        assert.bnEqual(unredeemedShares2, BigNumber.from(0));
      });
    });

    describe("#setCap", () => {
      time.revertToSnapshotAfterEach();

      it("should revert if not owner", async function () {
        await expect(
          vault.connect(userSigner).setCap(parseEther("10"))
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });

      it("should set the new cap", async function () {
        const tx = await vault.connect(ownerSigner).setCap(parseEther("10"));
        assert.equal((await vault.cap()).toString(), parseEther("10"));
        await expect(tx)
          .to.emit(vault, "CapSet")
          .withArgs(
            parseUnits("500", tokenDecimals > 18 ? tokenDecimals : 18),
            parseEther("10")
          );
      });

      it("should revert when depositing over the cap", async function () {
        const capAmount = BigNumber.from("100000000");
        const depositAmount = BigNumber.from("10000000000");
        await vault.connect(ownerSigner).setCap(capAmount);

        // Provide some WETH to the account
        if (params.collateralAsset === WETH_ADDRESS[chainId]) {
          const weth = assetContract.connect(userSigner);
          await weth.deposit({ value: depositAmount });
          await weth.approve(vault.address, depositAmount);
        }

        await expect(vault.deposit(depositAmount)).to.be.revertedWith(
          "Exceed cap"
        );
      });
    });

    describe("#setLiquidityGauge", () => {
      time.revertToSnapshotAfterEach();

      it("should revert if not owner", async function () {
        await expect(
          vault.connect(userSigner).setLiquidityGauge(constants.AddressZero)
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });

      it("should set the new liquidityGauge", async function () {
        const MockLiquidityGauge = await getContractFactory(
          "MockLiquidityGauge",
          ownerSigner
        );
        const liquidityGauge = await MockLiquidityGauge.deploy(vault.address);
        await vault
          .connect(ownerSigner)
          .setLiquidityGauge(liquidityGauge.address);
        assert.equal(await vault.liquidityGauge(), liquidityGauge.address);
      });

      it("should remove liquidityGauge", async function () {
        await vault
          .connect(ownerSigner)
          .setLiquidityGauge(constants.AddressZero);
        assert.equal(await vault.liquidityGauge(), constants.AddressZero);
      });
    });

    if (chainId === 1) {
      describe("#recoverTokens", () => {
        let wrongToken: Contract;
        let wrongSendAmount = ethers.utils.parseEther("100");

        time.revertToSnapshotAfterEach(async () => {
          await assetContract
            .connect(userSigner)
            .approve(vault.address, depositAmount);
          await vault.deposit(depositAmount);

          const RBN_HOLDER = "0xDAEada3d210D2f45874724BeEa03C7d4BBD41674";
          await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [RBN_HOLDER],
          });

          await userSigner.sendTransaction({
            to: RBN_HOLDER,
            value: ethers.utils.parseEther("100"),
          });

          const rbnHolder = ethers.provider.getSigner(RBN_HOLDER);

          wrongToken = await ethers.getContractAt(
            "IERC20",
            "0x6123B0049F904d730dB3C36a31167D9d4121fA6B"
          );
          await wrongToken
            .connect(rbnHolder)
            .transfer(vault.address, wrongSendAmount);
        });

        it("reverts when non-owner calls the function", async () => {
          await expect(
            vault.connect(userSigner).recoverTokens(wrongToken.address, owner)
          ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("reverts when recovering the vault asset", async () => {
          await expect(
            vault.connect(ownerSigner).recoverTokens(collateralAsset, owner)
          ).to.be.revertedWith("Vault asset not recoverable");
        });

        it("reverts when recovering the vault share", async () => {
          await expect(
            vault.connect(ownerSigner).recoverTokens(vault.address, owner)
          ).to.be.revertedWith("Vault share not recoverable");
        });

        it("reverts when recovering to the vault itself", async () => {
          await expect(
            vault
              .connect(ownerSigner)
              .recoverTokens(wrongToken.address, vault.address)
          ).to.be.revertedWith("Recipient cannot be vault");
        });

        it("recovers the tokens", async () => {
          assert.bnEqual(await wrongToken.balanceOf(owner), BigNumber.from(0));
          await vault
            .connect(ownerSigner)
            .recoverTokens(wrongToken.address, owner);
          assert.bnEqual(await wrongToken.balanceOf(owner), wrongSendAmount);
        });
      });
    }

    describe("#shares", () => {
      time.revertToSnapshotAfterEach();

      it("shows correct share balance after redemptions", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);

        await rollToNextRound();

        assert.bnEqual(await vault.shares(user), depositAmount);

        const redeemAmount = BigNumber.from(1);
        await vault.redeem(redeemAmount);

        // Share balance should remain the same because the 1 share
        // is transferred to the user
        assert.bnEqual(await vault.shares(user), depositAmount);

        await vault.transfer(owner, redeemAmount);

        assert.bnEqual(
          await vault.shares(user),
          depositAmount.sub(redeemAmount)
        );
        assert.bnEqual(await vault.shares(owner), redeemAmount);
      });
    });

    describe("#shareBalances", () => {
      time.revertToSnapshotAfterEach();

      it("returns the share balances split", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);

        await rollToNextRound();

        const [heldByAccount1, heldByVault1] = await vault.shareBalances(user);
        assert.bnEqual(heldByAccount1, BigNumber.from(0));
        assert.bnEqual(heldByVault1, depositAmount);

        await vault.redeem(1);
        const [heldByAccount2, heldByVault2] = await vault.shareBalances(user);
        assert.bnEqual(heldByAccount2, BigNumber.from(1));
        assert.bnEqual(heldByVault2, depositAmount.sub(1));
      });
    });

    describe("#shares", () => {
      time.revertToSnapshotAfterEach();

      it("returns the total number of shares", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);

        await rollToNextRound();

        assert.bnEqual(await vault.shares(user), depositAmount);

        // Should remain the same after redemption because it's held on balanceOf
        await vault.redeem(1);
        assert.bnEqual(await vault.shares(user), depositAmount);
      });
    });

    describe("#accountVaultBalance", () => {
      time.revertToSnapshotAfterEach();

      it("returns a lesser underlying amount for user", async function () {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);
        await vault.deposit(depositAmount);
        await rollToNextRound();

        assert.bnEqual(
          await vault.accountVaultBalance(user),
          BigNumber.from(depositAmount)
        );

        await assetContract.connect(userSigner).transfer(owner, depositAmount);
        await assetContract
          .connect(ownerSigner)
          .approve(vault.address, depositAmount);
        await vault.connect(ownerSigner).deposit(depositAmount);

        // remain the same after deposit
        assert.bnEqual(
          await vault.accountVaultBalance(user),
          BigNumber.from(depositAmount)
        );

        await rollToNextRound(true, false);

        // Minus 1 due to rounding errors from share price != 1
        assert.bnLt(
          await vault.accountVaultBalance(user),
          BigNumber.from(depositAmount)
        );
      });
    });

    describe("#decimals", () => {
      it("should return 18 for decimals", async function () {
        assert.equal(
          (await vault.decimals()).toString(),
          tokenDecimals.toString()
        );
      });
    });

    if (chainId === CHAINID.ETH_MAINNET && params.mintConfig) {
      describe("pricePerShare checks", () => {
        // Deposit 10000 tokens in the vault (5000 from user 0, 5000 from user 1)
        const totalDepositAmount = parseUnits("10000", params.tokenDecimals);
        const depositAmount = totalDepositAmount.div(2); // 5000

        time.revertToSnapshotAfterEach(async () => {
          // Increase vault cap if it's <10000
          if ((await vault.cap()).lt(totalDepositAmount)) {
            await vault.connect(ownerSigner).setCap(totalDepositAmount);
          }

          await mintToken(
            assetContract,
            params.mintConfig.contractOwnerAddress,
            ownerSigner.address, // User 0
            vault.address,
            totalDepositAmount
          ); // Mint 10000 tokens to user 0

          await assetContract.connect(ownerSigner).transfer(
            userSigner.address, // User 1
            depositAmount
          ); // Transfer 5000 tokens to user 1

          await assetContract
            .connect(ownerSigner)
            .approve(vault.address, depositAmount);
          await vault.connect(ownerSigner).deposit(depositAmount); // User 0 deposits 5000 tokens

          await assetContract
            .connect(userSigner)
            .approve(vault.address, depositAmount);
          await vault.connect(userSigner).deposit(depositAmount); // User 1 deposits 5000 tokens

          assert.bnEqual(await vault.totalBalance(), totalDepositAmount); // 10000 tokens
          await rollToNextRound(); // Process deposits
          assert.bnEqual(await vault.totalSupply(), totalDepositAmount); // 10000 shares
        });

        it("initiated withdraw is completed in a later round", async function () {
          /* ===== ROUND 2 ===== */

          await vault.connect(userSigner).initiateWithdraw(depositAmount); // User 1 initiates 5000 shares withdraw

          assert.bnEqual(await vault.totalBalance(), totalDepositAmount); // 10000 tokens
          await rollToNextRound(); // Process withdraws
          assert.bnEqual(await vault.totalSupply(), totalDepositAmount); // 10000 shares

          /* ===== ROUND 3 ===== */

          assert.bnEqual(
            await vault.pricePerShare(),
            parseUnits("1", params.tokenDecimals)
          ); // pricePerShare == 1

          // Transfer 50 tokens in premiums to vault
          const premiumAmount = parseUnits("50", params.tokenDecimals);
          await mintToken(
            assetContract,
            params.mintConfig.contractOwnerAddress,
            adminSigner.address,
            vault.address,
            premiumAmount
          ); // Mint 50 tokens
          await assetContract
            .connect(adminSigner)
            .transfer(vault.address, premiumAmount); // Transfer 50 tokens to vault

          await vault.connect(ownerSigner).initiateWithdraw(depositAmount); // User 0 initiates 5000 share withdraw

          assert.bnEqual(
            await vault.totalBalance(),
            totalDepositAmount.add(premiumAmount)
          ); // 10050 tokens
          await rollToNextRound(); // Process premiums/withdraws
          assert.bnEqual(await vault.totalSupply(), totalDepositAmount); // 10000 shares

          /* ===== ROUND 4 ===== */

          // pricePerShare is ~1.0038063
          // console.log((await vault.pricePerShare()).toString());
          assert.bnGt(
            await vault.pricePerShare(),
            parseUnits("1", params.tokenDecimals)
          ); // pricePerShare > 1

          const oneToken = parseUnits("1", params.tokenDecimals); // 1 token
          const tenTokens = parseUnits("10", params.tokenDecimals); // 10 tokens

          let withdrawnTokens0 = await assetContract.balanceOf(
            ownerSigner.address
          );
          await vault.connect(ownerSigner).completeWithdraw();
          withdrawnTokens0 = (
            await assetContract.balanceOf(ownerSigner.address)
          ).sub(withdrawnTokens0); // User 0 completes withdraw of 5000 shares
          // User 0 receives ~5038.063 tokens (5000 tokens + 38.063 premiums)
          // console.log(withdrawnTokens0.toString());
          assert.bnGt(withdrawnTokens0, depositAmount.add(tenTokens.mul(3))); // withdrawnTokens0 > 5030 tokens

          let withdrawnTokens1 = await assetContract.balanceOf(
            userSigner.address
          );
          await vault.connect(userSigner).completeWithdraw();
          withdrawnTokens1 = (
            await assetContract.balanceOf(userSigner.address)
          ).sub(withdrawnTokens1); // User 1 completes withdraw of 5000 shares
          assert.bnEqual(withdrawnTokens1, depositAmount); // User 1 receives 5000 tokens

          // Vault has ~0.000022 in tokens leftover
          // console.log((await vault.totalBalance()).toString());
          assert.bnLt(await vault.totalBalance(), oneToken); // totalBalance < 1 tokens
          assert.bnEqual(await vault.totalSupply(), BigNumber.from(0)); // 0 shares
        });

        it("vault losses locking up withdraws", async function () {
          /* ===== ROUND 2 ===== */

          await vault.connect(userSigner).initiateWithdraw(depositAmount); // User 1 initiates 5000 shares withdraw

          await rollToNextRound(false, false); // Process bought OTM expiry

          /* ===== ROUND 3 ===== */

          assert.bnEqual(
            await vault.pricePerShare(),
            parseUnits("1", params.tokenDecimals)
          ); // pricePerShare == 1

          await vault.connect(ownerSigner).initiateWithdraw(depositAmount); // User 0 initiates 5000 share withdraw

          assert.bnEqual(await vault.totalBalance(), totalDepositAmount); // 10000 tokens

          await rollToNextRound();

          assert.bnLt(await vault.totalBalance(), totalDepositAmount); // totalBalance < 10000 tokens
          assert.bnEqual(await vault.totalSupply(), totalDepositAmount); // 10000 shares

          /* ===== ROUND 4 ===== */

          // pricePerShare is ~0.90909090
          // console.log((await vault.pricePerShare()).toString());
          assert.bnLt(
            await vault.pricePerShare(),
            parseUnits("1", params.tokenDecimals)
          ); // pricePerShare < 1

          const oneToken = parseUnits("1", params.tokenDecimals); // 1 token

          let withdrawnTokens0 = await assetContract.balanceOf(
            ownerSigner.address
          );
          await vault.connect(ownerSigner).completeWithdraw();
          withdrawnTokens0 = (
            await assetContract.balanceOf(ownerSigner.address)
          ).sub(withdrawnTokens0); // User 0 completes withdraw of 5000 shares
          // User 0 receives ~4545.4545 tokens
          // console.log(withdrawnTokens0.toString());
          assert.bnLt(withdrawnTokens0, depositAmount); // withdrawnTokens0 < 5000 tokens

          const { round, shares } = await vault.withdrawals(userSigner.address);
          const roundPricePerShare = await vault.roundPricePerShare(round);
          const withdrawAmount = shares
            .mul(roundPricePerShare)
            .div(parseUnits("1", params.tokenDecimals));
          // User 1 is expected to receive 5000 tokens when they complete withdraw 5000 shares
          assert.bnEqual(withdrawAmount, depositAmount); // 5000 tokens

          let withdrawnTokens1 = await assetContract.balanceOf(
            userSigner.address
          );
          await vault.connect(userSigner).completeWithdraw();
          withdrawnTokens1 = (
            await assetContract.balanceOf(userSigner.address)
          ).sub(withdrawnTokens1); // User 1 completes withdraw of 5000 shares
          assert.bnEqual(withdrawnTokens1, depositAmount); // User 1 receives 5000 tokens

          // Vault has ~0.00004545 in tokens leftover
          // console.log((await vault.totalBalance()).toString());
          assert.bnLt(await vault.totalBalance(), oneToken); // totalBalance < 1 tokens
          assert.bnEqual(await vault.totalSupply(), BigNumber.from(0)); // 0 shares
        });
      });
    }

    describe("#pausePosition", () => {
      describe("pauser owner And keeper", () => {
        time.revertToSnapshotAfterTest();

        it("returns the owner", async function () {
          assert.equal(await pauser.owner(), owner);
        });
        it("returns the keeper", async function () {
          await pauser.connect(ownerSigner).setNewKeeper(keeper);
          assert.equal(await pauser.keeper(), keeper);
        });
      });

      describe("pauser set new keeper", () => {
        time.revertToSnapshotAfterTest();

        it("set new keeper to owner", async function () {
          assert.equal(await pauser.keeper(), keeper);
          await pauser.connect(ownerSigner).setNewKeeper(owner);
          assert.equal(await pauser.keeper(), owner);
        });

        it("reverts when not owner call", async function () {
          await expect(
            pauser.connect(keeperSigner).setNewKeeper(owner)
          ).to.be.revertedWith("caller is not the owner");
        });
      });

      describe("pauser add vaults", () => {
        time.revertToSnapshotAfterTest();

        it("revert if not owner call", async function () {
          await expect(
            pauser.connect(keeperSigner).addVault(vault.address)
          ).to.be.revertedWith("caller is not the owner");
        });
      });

      time.revertToSnapshotAfterEach(async function () {
        await vault.connect(ownerSigner).setVaultPauser(pauser.address);
        await pauser.connect(ownerSigner).addVault(vault.address);

        await assetContract
          .connect(userSigner)
          .approve(vault.address, params.depositAmount);

        await vault.deposit(params.depositAmount);

        await assetContract
          .connect(userSigner)
          .approve(pauser.address, params.depositAmount);

        await rollToNextRound();
      });

      it("is able to pause position", async function () {
        const tx = await vault.pausePosition();

        // check paused position is saved under user
        let positions = await pauser.getPausePosition(vault.address, user);
        await expect(tx)
          .to.emit(pauser, "Pause")
          .withArgs(user, vault.address, depositAmount, 2);

        assert.equal(positions.round, 2);
        assert.bnEqual(positions.shares, params.depositAmount);

        // check withdrawal receipt
        const results = await vault.withdrawals(pauser.address);
        assert.equal(await results.round, 2);
        assert.bnEqual(await results.shares, params.depositAmount);
      });
    });

    describe("#processWithdrawal", () => {
      time.revertToSnapshotAfterEach(async () => {
        await vault.connect(ownerSigner).setVaultPauser(pauser.address);
        await pauser.connect(ownerSigner).addVault(vault.address);

        // User Deposit
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount);

        await assetContract
          .connect(userSigner)
          .approve(pauser.address, depositAmount);

        await assetContract
          .connect(keeperSigner)
          .approve(pauser.address, depositAmount);

        await vault.deposit(depositAmount);

        // Owner Deposit
        await assetContract.connect(userSigner).transfer(owner, depositAmount);
        await assetContract
          .connect(ownerSigner)
          .approve(vault.address, depositAmount);
        await vault.connect(ownerSigner).deposit(depositAmount);

        // Roll and Pause
        await rollToNextRound();
        await vault.pausePosition();
      });

      it("revert if not keeper called process withdrawal", async function () {
        await expect(
          pauser.connect(ownerSigner).processWithdrawal(vault.address, {
            gasPrice,
          })
        ).to.be.revertedWith("!keeper");
      });

      it("process withdrawal", async function () {
        // Roll again to process
        await rollToNextRound();

        const pricePerShare = await vault.roundPricePerShare(2);
        const withdrawAmount = depositAmount
          .mul(pricePerShare)
          .div(BigNumber.from(10).pow(await vault.decimals()));

        const tx = await pauser
          .connect(keeperSigner)
          .processWithdrawal(vault.address, {
            gasPrice,
          });

        await expect(tx)
          .to.emit(pauser, "ProcessWithdrawal")
          .withArgs(vault.address, 2);

        // withdrawal receipt should be empty
        const { shares, round } = await vault.withdrawals(pauser.address);
        assert.equal(shares, 0);
        assert.equal(round, 2);

        if (collateralAsset === WETH_ADDRESS[chainId]) {
          assert.bnEqual(
            await provider.getBalance(pauser.address),
            withdrawAmount
          );
        } else {
          assert.bnEqual(
            await assetContract.balanceOf(pauser.address),
            withdrawAmount
          );
        }
      });

      describe("process and pause again", () => {
        it("process withdrawal and pause again", async function () {
          // Roll and Process
          await rollToNextRound();
          await pauser.connect(keeperSigner).processWithdrawal(vault.address);
          // Deposit and Pause again
          await assetContract
            .connect(userSigner)
            .approve(vault.address, depositAmount);
          await vault.connect(userSigner).deposit(depositAmount);
          await rollToNextRound();
          await expect(vault.pausePosition()).to.be.revertedWith(
            "Position is paused"
          );

          // check paused position remains
          let position = await pauser.getPausePosition(vault.address, user);
          assert.equal(await position.round, 2);
          assert.bnEqual(await position.shares, params.depositAmount);
        });
      });
    });

    describe("#resumePosition", () => {
      time.revertToSnapshotAfterEach(async () => {
        await vault.connect(ownerSigner).setVaultPauser(pauser.address);
        await pauser.connect(ownerSigner).addVault(vault.address);

        //approving
        await assetContract
          .connect(userSigner)
          .approve(vault.address, depositAmount.mul(2));

        await assetContract
          .connect(userSigner)
          .approve(pauser.address, depositAmount.mul(2));

        await assetContract
          .connect(ownerSigner)
          .approve(vault.address, depositAmount);

        // transfer some to owner to deposit
        await assetContract.connect(userSigner).transfer(owner, depositAmount);

        //deposit
        if (collateralAsset === WETH_ADDRESS[chainId]) {
          await vault.depositETH({ value: depositAmount, gasPrice });
          await vault
            .connect(ownerSigner)
            .depositETH({ value: depositAmount, gasPrice });
        } else {
          await vault.deposit(depositAmount);
          await vault.connect(ownerSigner).deposit(depositAmount);
        }

        await rollToNextRound();
      });

      it("unable to resume position without pause", async function () {
        await expect(
          pauser.connect(userSigner).resumePosition(vault.address)
        ).to.be.revertedWith("Invalid assetPerShare");
      });

      it("revert if resume before complete", async function () {
        // Roll and Process
        await vault.pausePosition();

        await expect(
          pauser.connect(userSigner).resumePosition(vault.address)
        ).to.be.revertedWith("Round not closed yet");
      });

      it("resume position", async function () {
        await vault.pausePosition();

        await rollToNextRound();

        await pauser.connect(keeperSigner).processWithdrawal(vault.address, {
          gasPrice,
        });
        const pricePerShare = await vault.roundPricePerShare(2);
        const withdrawAmount = depositAmount
          .mul(pricePerShare)
          .div(BigNumber.from(10).pow(await vault.decimals()));
        const res = await pauser
          .connect(userSigner)
          .resumePosition(vault.address);

        await expect(res)
          .to.emit(pauser, "Resume")
          .withArgs(user, vault.address, withdrawAmount);

        await expect(res).to.emit(vault, "Deposit");

        assert.bnEqual(await vault.totalPending(), withdrawAmount);
        const receipt = await vault.depositReceipts(user);
        assert.equal(receipt.round, 3);
        assert.bnEqual(receipt.amount, withdrawAmount);

        // check if position is removed
        let position = await pauser.getPausePosition(vault.address, user);
        assert.equal(await position.round, 0);
        assert.bnEqual(await position.shares, BigNumber.from(0));
      });
    });
  });
}

async function depositIntoVault(
  asset: string,
  vault: Contract,
  amount: BigNumberish,
  signer?: SignerWithAddress
) {
  if (typeof signer !== "undefined") {
    vault = vault.connect(signer);
  }
  if (asset === WETH_ADDRESS[chainId]) {
    await vault.depositETH({ value: amount });
  } else {
    await vault.deposit(amount);
  }
}
