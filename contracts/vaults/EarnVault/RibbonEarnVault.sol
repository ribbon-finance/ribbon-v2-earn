// SPDX-License-Identifier: MIT
pragma solidity =0.8.4;

import {SafeMath} from "@openzeppelin/contracts/utils/math/SafeMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Detailed} from "../../interfaces/IERC20Detailed.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/draft-IERC20Permit.sol";
import {
    SafeERC20
} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {RibbonEarnVaultStorage} from "../../storage/RibbonEarnVaultStorage.sol";
import {Vault} from "../../libraries/Vault.sol";
import {VaultLifecycleEarn} from "../../libraries/VaultLifecycleEarn.sol";
import {ShareMath} from "../../libraries/ShareMath.sol";
import {ILiquidityGauge} from "../../interfaces/ILiquidityGauge.sol";
import {IVaultPauser} from "../../interfaces/IVaultPauser.sol";
import {RibbonVault} from "./base/RibbonVault.sol";

/**
 * UPGRADEABILITY: Since we use the upgradeable proxy pattern, we must observe
 * the inheritance chain closely.
 * Any changes/appends in storage variable needs to happen in RibbonEarnVaultStorage.
 * RibbonEarnVault should not inherit from any other contract aside from RibbonVault, RibbonEarnVaultStorage
 */
contract RibbonEarnVault is RibbonVault, RibbonEarnVaultStorage {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;
    using ShareMath for Vault.DepositReceipt;

    /************************************************
     *  IMMUTABLES & CONSTANTS
     ***********************************************/

    /************************************************
     *  EVENTS
     ***********************************************/

    event OpenLoan(uint256 amount, address indexed receiver);

    event CloseLoan(
        uint256 amount,
        uint256 yield,
        uint256 yearlyInterest,
        address indexed receiver
    );

    event PurchaseOption(uint256 premium, address indexed receiver);

    event PayOptionYield(
        uint256 yield,
        uint256 netYield,
        uint256 pctPayoff,
        address indexed receiver
    );

    event InstantWithdraw(
        address indexed account,
        uint256 amount,
        uint256 round
    );

    /************************************************
     *  STRUCTS
     ***********************************************/

    /**
     * @notice Initialization parameters for the vault.
     * @param _owner is the owner of the vault with critical permissions
     * @param _feeRecipient is the address to recieve vault performance and management fees
     * @param _borrower is the address of the borrowing entity (EX: Wintermute, GSR, Alameda, Genesis)
     * @param _optionSeller is the address of the entity that we will be buying options from (EX: Orbit)
     * @param _managementFee is the management fee pct.
     * @param _performanceFee is the perfomance fee pct.
     * @param _tokenName is the name of the token
     * @param _tokenSymbol is the symbol of the token
     */
    struct InitParams {
        address _owner;
        address _keeper;
        address _borrower;
        address _optionSeller;
        address _feeRecipient;
        uint256 _managementFee;
        uint256 _performanceFee;
        string _tokenName;
        string _tokenSymbol;
    }

    /************************************************
     *  CONSTRUCTOR & INITIALIZATION
     ***********************************************/

    /**
     * @notice Initializes the contract with immutable variables
     * @param _weth is the Wrapped Ether contract
     * @param _usdc is the USDC contract
     */
    constructor(address _weth, address _usdc) RibbonVault(_weth, _usdc) {}

    /**
     * @notice Initializes the OptionVault contract with storage variables.
     * @param _initParams is the struct with vault initialization parameters
     * @param _vaultParams is the struct with vault general data
     */
    function initialize(
        InitParams calldata _initParams,
        Vault.VaultParams calldata _vaultParams,
        Vault.AllocationState calldata _allocationState
    ) external initializer {
        baseInitialize(
            _initParams._owner,
            _initParams._keeper,
            _initParams._feeRecipient,
            _initParams._borrower,
            _initParams._optionSeller,
            _initParams._managementFee,
            _initParams._performanceFee,
            _initParams._tokenName,
            _initParams._tokenSymbol,
            _vaultParams,
            _allocationState
        );
    }

    /************************************************
     *  SETTERS
     ***********************************************/

    /**
     * @notice Sets the new liquidityGauge contract for this vault
     * @param newLiquidityGauge is the address of the new liquidityGauge contract
     */
    function setLiquidityGauge(address newLiquidityGauge) external onlyOwner {
        liquidityGauge = newLiquidityGauge;
    }

    /**
     * @notice Sets the new Vault Pauser contract for this vault
     * @param newVaultPauser is the address of the new vaultPauser contract
     */
    function setVaultPauser(address newVaultPauser) external onlyOwner {
        vaultPauser = newVaultPauser;
    }

    /************************************************
     *  VAULT OPERATIONS
     ***********************************************/

    /**
     * @notice Withdraws the assets on the vault using the outstanding `DepositReceipt.amount`
     * @param amount is the amount to withdraw
     */
    function withdrawInstantly(uint256 amount) external nonReentrant {
        Vault.DepositReceipt storage depositReceipt =
            depositReceipts[msg.sender];

        uint256 currentRound = vaultState.round;
        require(amount > 0, "!amount");
        require(depositReceipt.round == currentRound, "Invalid round");

        uint256 receiptAmount = depositReceipt.amount;
        require(receiptAmount >= amount, "Exceed amount");

        // Subtraction underflow checks already ensure it is smaller than uint104
        depositReceipt.amount = uint104(receiptAmount.sub(amount));
        vaultState.totalPending = uint128(
            uint256(vaultState.totalPending).sub(amount)
        );

        emit InstantWithdraw(msg.sender, amount, currentRound);

        transferAsset(msg.sender, amount);
    }

    /**
     * @notice Initiates a withdrawal that can be processed once the round completes
     * @param numShares is the number of shares to withdraw
     */
    function initiateWithdraw(uint256 numShares) external nonReentrant {
        _initiateWithdraw(numShares);
        currentQueuedWithdrawShares = currentQueuedWithdrawShares.add(
            numShares
        );
    }

    /**
     * @notice Completes a scheduled withdrawal from a past round. Uses finalized pps for the round
     */
    function completeWithdraw() external nonReentrant {
        uint256 withdrawAmount = _completeWithdraw();
        lastQueuedWithdrawAmount = uint128(
            uint256(lastQueuedWithdrawAmount).sub(withdrawAmount)
        );
    }

    /**
     * @notice Stakes a users vault shares
     * @param numShares is the number of shares to stake
     */
    function stake(uint256 numShares) external nonReentrant {
        address _liquidityGauge = liquidityGauge;
        require(_liquidityGauge != address(0)); // Removed revert msgs due to contract size limit
        require(numShares > 0);
        uint256 heldByAccount = balanceOf(msg.sender);
        if (heldByAccount < numShares) {
            _redeem(numShares.sub(heldByAccount), false);
        }
        _transfer(msg.sender, address(this), numShares);
        _approve(address(this), _liquidityGauge, numShares);
        ILiquidityGauge(_liquidityGauge).deposit(numShares, msg.sender, false);
    }

    /**
     * @notice Rolls the vault's funds into a new short position.
     */
    function rollToNextEpoch() external onlyKeeper nonReentrant {
        uint256 currQueuedWithdrawShares = currentQueuedWithdrawShares;

        (uint256 lockedBalance, uint256 queuedWithdrawAmount) =
            _rollToNextEpoch(
                lastQueuedWithdrawAmount,
                currQueuedWithdrawShares
            );

        lastQueuedWithdrawAmount = queuedWithdrawAmount;

        uint256 newQueuedWithdrawShares =
            uint256(vaultState.queuedWithdrawShares).add(
                currQueuedWithdrawShares
            );
        ShareMath.assertUint128(newQueuedWithdrawShares);
        vaultState.queuedWithdrawShares = uint128(newQueuedWithdrawShares);

        currentQueuedWithdrawShares = 0;

        ShareMath.assertUint104(lockedBalance);
        vaultState.lastLockedAmount = vaultState.lockedAmount;
        vaultState.lockedAmount = uint104(lockedBalance);

        uint256 loanAllocation = allocationState.loanAllocation;

        // Lend funds to borrower
        IERC20(vaultParams.asset).safeTransfer(borrower, loanAllocation);

        emit OpenLoan(loanAllocation, borrower);
    }

    /**
     * @notice Buys the option by transferring premiums to option seller
     */
    function buyOption() external onlyKeeper {
        require(
            block.timestamp >=
                uint256(vaultState.lastOptionPurchaseTime).add(
                    allocationState.currentOptionPurchaseFreq
                ),
            "!earlypurchase"
        );

        uint256 optionAllocation = allocationState.optionAllocation;

        IERC20(vaultParams.asset).safeTransfer(optionSeller, optionAllocation);

        emit PurchaseOption(optionAllocation, optionSeller);
    }

    /**
     * @notice Pays option yield if option is ITM
     * `v`, `r` and `s` must be a valid `secp256k1` signature from `owner`
     * over the EIP712-formatted function arguments
     * @param amount is the amount of yield to pay
     * @param deadline must be a timestamp in the future
     * @param v is a valid signature
     * @param r is a valid signature
     * @param s is a valid signature
     */
    function payOptionYield(
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external onlyOptionSeller {
        IERC20 asset = IERC20(vaultParams.asset);

        // Pay option yields to contract
        IERC20Permit(address(asset)).permit(
            msg.sender,
            address(this),
            amount,
            deadline,
            v,
            r,
            s
        );
        asset.safeTransferFrom(msg.sender, address(this), amount);

        uint256 optionAllocation = allocationState.optionAllocation;

        uint256 yieldInUSD =
            amount > optionAllocation ? amount.sub(optionAllocation) : 0;
        uint256 yieldInPCT =
            amount > optionAllocation
                ? amount.mul(10**2).div(optionAllocation).div(
                    10**IERC20Detailed(address(asset)).decimals()
                )
                : 0;

        emit PayOptionYield(amount, yieldInUSD, yieldInPCT, address(this));
    }

    /**
     * @notice Return lend funds
     * `v`, `r` and `s` must be a valid `secp256k1` signature from `owner`
     * over the EIP712-formatted function arguments
     * @param amount is the amount to return (principal + interest)
     * @param deadline must be a timestamp in the future
     * @param v is a valid signature
     * @param r is a valid signature
     * @param s is a valid signature
     */
    function returnLentFunds(
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external onlyBorrower {
        IERC20 asset = IERC20(vaultParams.asset);

        // Pay option yields to contract
        IERC20Permit(address(asset)).permit(
            msg.sender,
            address(this),
            amount,
            deadline,
            v,
            r,
            s
        );
        asset.safeTransferFrom(msg.sender, address(this), amount);

        uint256 loanAllocation = allocationState.loanAllocation;

        uint256 yield =
            amount > loanAllocation ? amount.sub(loanAllocation) : 0;

        emit CloseLoan(
            amount,
            yield,
            (yield * 12).mul(10**2).div(loanAllocation),
            address(this)
        );
    }

    /**
     * @notice Recovery function that returns an ERC20 token to the recipient
     * @param token is the ERC20 token to recover from the vault
     * @param recipient is the recipient of the recovered tokens
     */
    function recoverTokens(address token, address recipient)
        external
        onlyOwner
    {
        require(token != vaultParams.asset, "Vault asset not recoverable");
        require(token != address(this), "Vault share not recoverable");
        require(recipient != address(this), "Recipient cannot be vault");

        IERC20(token).safeTransfer(
            recipient,
            IERC20(token).balanceOf(address(this))
        );
    }

    /**
     * @notice pause a user's vault position
     */
    function pausePosition() external {
        address _vaultPauserAddress = vaultPauser;
        require(_vaultPauserAddress != address(0)); // Removed revert msgs due to contract size limit
        _redeem(0, true);
        uint256 heldByAccount = balanceOf(msg.sender);
        _approve(msg.sender, _vaultPauserAddress, heldByAccount);
        IVaultPauser(_vaultPauserAddress).pausePosition(
            msg.sender,
            heldByAccount
        );
    }
}
