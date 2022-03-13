// SPDX-License-Identifier: MIT
pragma solidity =0.8.4;

import {SafeMath} from "@openzeppelin/contracts/utils/math/SafeMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {RibbonGammaVaultStorage} from "../../storage/RibbonGammaVaultStorage.sol";
import {Vault} from "../../libraries/Vault.sol";
import {VaultLifecycle} from "../../libraries/VaultLifecycle.sol";
import {VaultLifecycleGamma} from "../../libraries/VaultLifecycleGamma.sol";
import {ShareMath} from "../../libraries/ShareMath.sol";
import {RibbonVault} from "./base/RibbonVault.sol";
import {IWETH} from "../../interfaces/IWETH.sol";
import {IController} from "../../interfaces/PowerTokenInterface.sol";

/**
 * UPGRADEABILITY: Since we use the upgradeable proxy pattern, we must observe
 * the inheritance chain closely.
 * Any changes/appends in storage variable needs to happen in RibbonGammaVaultStorage.
 * RibbonGammaVault should not inherit from any other contract aside from RibbonVault, RibbonGammaVaultStorage
 */
contract RibbonGammaVault is RibbonVault, RibbonGammaVaultStorage {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;
    using ShareMath for Vault.DepositReceipt;

    /************************************************
     *  EVENTS
     ***********************************************/

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
     * @param _managementFee is the management fee pct.
     * @param _performanceFee is the perfomance fee pct.
     * @param _tokenName is the name of the token
     * @param _tokenSymbol is the symbol of the token
     */
    struct InitParams {
        address _owner;
        address _keeper;
        address _feeRecipient;
        uint256 _managementFee;
        uint256 _performanceFee;
        string _tokenName;
        string _tokenSymbol;
        bytes _sqthSwapPath;
        bytes _usdcSwapPath;
    }

    /************************************************
     *  CONSTRUCTOR & INITIALIZATION
     ***********************************************/

    /**
     * @notice Initializes the contract with immutable variables
     * @param _weth is the Wrapped Ether contract
     * @param _usdc is the USDC contract
     * @param _squeethController is the contract address for squeeth actions
     * @param _squeeth is the contract address for oSQTH
     * @param _uniswapRouter is the contract address for UniswapV3 router which handles swaps
     * @param _uniswapFactory is the contract address for UniswapV3 factory
     * @param _sqthWeth is the path for swapping SQTH to WETH
     * @param _usdcWeth is the path for swapping USDC to WETH
     * @param _oracle is the Oracle contract used by the Squeeth controller
     */
    constructor(
        address _weth,
        address _usdc,
        address _squeethController,
        address _squeeth,
        address _uniswapRouter,
        address _uniswapFactory,
        address _sqthWeth,
        address _usdcWeth,
        address _oracle
    )
        RibbonVault(
            _weth,
            _usdc,
            _squeethController,
            _squeeth,
            _uniswapRouter,
            _uniswapFactory,
            _sqthWeth,
            _usdcWeth,
            _oracle
        )
    {}

    /**
     * @notice Initializes the OptionVault contract with storage variables.
     * @param _initParams is the struct with vault initialization parameters
     * @param _vaultParams is the struct with vault general data
     */
    function initialize(
        InitParams calldata _initParams,
        Vault.VaultParams calldata _vaultParams
    ) external initializer {
        baseInitialize(
            _initParams._owner,
            _initParams._keeper,
            _initParams._feeRecipient,
            _initParams._managementFee,
            _initParams._performanceFee,
            _initParams._tokenName,
            _initParams._tokenSymbol,
            _vaultParams
        );

        require(
            VaultLifecycleGamma.checkPath(
                _initParams._usdcSwapPath,
                USDC,
                WETH,
                UNISWAP_FACTORY
            ),
            "Invalid usdcSwapPath"
        );
        require(
            VaultLifecycleGamma.checkPath(
                _initParams._sqthSwapPath,
                SQUEETH,
                WETH,
                UNISWAP_FACTORY
            ),
            "Invalid sqthSwapPath"
        );

        sqthSwapPath = _initParams._sqthSwapPath;
        usdcSwapPath = _initParams._usdcSwapPath;
    }

    /************************************************
     *  SETTERS
     ***********************************************/

    /**
     * @notice Sets a new path for swaps
     * @param newSwapPath is the new path
     */
    function setSqthSwapPath(bytes calldata newSwapPath) external onlyOwner {
        require(
            VaultLifecycleGamma.checkPath(
                newSwapPath,
                SQUEETH,
                WETH,
                UNISWAP_FACTORY
            ),
            "Invalid swapPath"
        );
        sqthSwapPath = newSwapPath;
    }

    /**
     * @notice Sets a new path for swaps
     * @param newSwapPath is the new path
     */
    function setUsdcSwapPath(bytes calldata newSwapPath) external onlyOwner {
        require(
            VaultLifecycleGamma.checkPath(
                newSwapPath,
                USDC,
                WETH,
                UNISWAP_FACTORY
            ),
            "Invalid swapPath"
        );
        usdcSwapPath = newSwapPath;
    }

    /************************************************
     *  VAULT OPERATIONS
     ***********************************************/

    /**
     * @notice Withdraws the assets on the vault using the outstanding `DepositReceipt.amount`
     * @param amount is the amount to withdraw
     */
    function withdrawInstantly(uint256 amount) external nonReentrant {
        Vault.DepositReceipt storage depositReceipt = depositReceipts[
            msg.sender
        ];

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
     * @notice Completes a scheduled withdrawal from a past round. Uses finalized pps for the round
     */
    function completeWithdraw() external nonReentrant {
        uint256 withdrawAmount = _completeWithdraw();
        lastQueuedWithdrawAmount = uint128(
            uint256(lastQueuedWithdrawAmount).sub(withdrawAmount)
        );
    }

    function openShort(uint256 usdcMinAmountOut, uint256 sqthMinAmountOut)
        external
        nonReentrant
    {
        // TODO: Update vault state post-rollover
        VaultLifecycleGamma.swap(
            USDC,
            0,
            usdcMinAmountOut,
            UNISWAP_ROUTER,
            usdcSwapPath
        );
        IWETH(WETH).withdraw(IERC20(WETH).balanceOf(address(this)));
        uint256 targetSQTHAmount = VaultLifecycleGamma.getTargetSqueethAmount(
            SQUEETH_CONTROLLER,
            VAULT_ID,
            address(this).balance
        );
        IController(SQUEETH_CONTROLLER).mintWPowerPerpAmount{
            value: address(this).balance
        }(VAULT_ID, targetSQTHAmount, 0);
        VaultLifecycleGamma.swap(
            SQUEETH,
            0,
            sqthMinAmountOut,
            UNISWAP_ROUTER,
            sqthSwapPath
        );
        IWETH(WETH).withdraw(IERC20(WETH).balanceOf(address(this)));
        IController(SQUEETH_CONTROLLER).mintWPowerPerpAmount{
            value: address(this).balance
        }(VAULT_ID, 0, 0);
        // TODO: Calculate shares to mint based on deposits

        (
            ,
            uint256 lockedBalance,
            uint256 queuedWithdrawAmount
        ) = _rollToNextOption(uint256(lastQueuedWithdrawAmount));

        lastQueuedWithdrawAmount = queuedWithdrawAmount;

        ShareMath.assertUint104(lockedBalance);
        vaultState.lockedAmount = uint104(lockedBalance);
    }

    function closeShort(uint256 usdcMinAmountOut, uint256 sqthMinAmountOut)
        external
        nonReentrant
    {
        VaultLifecycleGamma.swap(
            USDC,
            0,
            usdcMinAmountOut,
            UNISWAP_ROUTER,
            usdcSwapPath
        );
        IWETH(WETH).withdraw(IERC20(WETH).balanceOf(address(this)));
        uint256 targetSQTHAmount = VaultLifecycleGamma.getTargetSqueethAmount(
            SQUEETH_CONTROLLER,
            VAULT_ID,
            address(this).balance
        );
        IController(SQUEETH_CONTROLLER).mintWPowerPerpAmount{
            value: address(this).balance
        }(VAULT_ID, targetSQTHAmount, 0);
        VaultLifecycleGamma.swap(
            SQUEETH,
            0,
            sqthMinAmountOut,
            UNISWAP_ROUTER,
            sqthSwapPath
        );
        IWETH(WETH).withdraw(IERC20(WETH).balanceOf(address(this)));
        IController(SQUEETH_CONTROLLER).mintWPowerPerpAmount{
            value: address(this).balance
        }(VAULT_ID, 0, 0);
        // TODO: Calculate shares to mint based on deposits

        (
            ,
            uint256 lockedBalance,
            uint256 queuedWithdrawAmount
        ) = _rollToNextOption(uint256(lastQueuedWithdrawAmount));

        lastQueuedWithdrawAmount = queuedWithdrawAmount;

        ShareMath.assertUint104(lockedBalance);
        vaultState.lockedAmount = uint104(lockedBalance);
    }
}
