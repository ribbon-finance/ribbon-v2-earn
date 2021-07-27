// SPDX-License-Identifier: MIT
pragma solidity ^0.7.3;
pragma experimental ABIEncoderV2;

import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "../../../vendor/CustomSafeERC20.sol";
import {IYearnRegistry, IYearnVault} from "../../../interfaces/IYearn.sol";
import {GnosisAuction} from "../../../libraries/GnosisAuction.sol";
import {
    OptionsVaultYearnStorage
} from "../../../storage/OptionsVaultYearnStorage.sol";
import {Vault} from "../../../libraries/Vault.sol";
import {VaultLifecycleYearn} from "../../../libraries/VaultLifecycleYearn.sol";
import {ShareMath} from "../../../libraries/ShareMath.sol";
import {IOtoken} from "../../../interfaces/GammaInterface.sol";
import {IWETH} from "../../../interfaces/IWETH.sol";
import {IGnosisAuction} from "../../../interfaces/IGnosisAuction.sol";
import {
    IStrikeSelection,
    IOptionsPremiumPricer
} from "../../../interfaces/IRibbon.sol";

contract RibbonVault is OptionsVaultYearnStorage {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;
    using ShareMath for Vault.DepositReceipt;

    /************************************************
     *  IMMUTABLES & CONSTANTS
     ***********************************************/

    address public immutable WETH;
    address public immutable USDC;

    uint256 public constant delay = 1 hours;

    uint256 public constant period = 7 days;

    uint256 public constant YEARN_WITHDRAWAL_BUFFER = 5; // 0.05%

    uint256 public constant YEARN_WITHDRAWAL_SLIPPAGE = 5; // 0.05%

    uint128 internal constant PLACEHOLDER_UINT = 1;

    // GAMMA_CONTROLLER is the top-level contract in Gamma protocol
    // which allows users to perform multiple actions on their vaults
    // and positions https://github.com/opynfinance/GammaProtocol/blob/master/contracts/Controller.sol
    address public immutable GAMMA_CONTROLLER;

    // MARGIN_POOL is Gamma protocol's collateral pool.
    // Needed to approve collateral.safeTransferFrom for minting otokens.
    // https://github.com/opynfinance/GammaProtocol/blob/master/contracts/MarginPool.sol
    address public immutable MARGIN_POOL;

    // GNOSIS_EASY_AUCTION is Gnosis protocol's contract for initiating auctions and placing bids
    // https://github.com/gnosis/ido-contracts/blob/main/contracts/EasyAuction.sol
    address public immutable GNOSIS_EASY_AUCTION;

    // Yearn registry contract
    address public immutable YEARN_REGISTRY;

    /************************************************
     *  EVENTS
     ***********************************************/

    event Deposit(address indexed account, uint256 amount, uint16 round);

    event Redeem(address indexed account, uint256 share, uint16 round);

    event WithdrawalFeeSet(uint256 oldFee, uint256 newFee);

    event ManagementFeeSet(uint256 managementFee, uint256 newManagementFee);

    event PerformanceFeeSet(uint256 performanceFee, uint256 newPerformanceFee);

    event CapSet(uint256 oldCap, uint256 newCap, address manager);

    event Withdraw(
        address account,
        bool keepWrapped,
        uint256 amount,
        uint256 shares
    );

    event InitiateWithdraw(address account, uint256 shares, uint16 round);

    event CollectVaultFees(
        uint256 performanceFee,
        uint256 managementFee,
        uint256 vaultFee,
        uint256 round
    );

    /************************************************
     *  CONSTRUCTOR & INITIALIZATION
     ***********************************************/

    /**
     * @notice Initializes the contract with immutable variables
     * @param _weth is the Wrapped Ether contract
     * @param _usdc is the USDC contract
     * @param _gammaController is the contract address for opyn actions
     * @param _marginPool is the contract address for providing collateral to opyn
     * @param _gnosisEasyAuction is the contract address that facilitates gnosis auctions
     * @param _yearnRegistry is the address of the yearn registry from token to vault token
     */
    constructor(
        address _weth,
        address _usdc,
        address _gammaController,
        address _marginPool,
        address _gnosisEasyAuction,
        address _yearnRegistry
    ) {
        require(_weth != address(0), "!_weth");
        require(_usdc != address(0), "!_usdc");
        require(_gnosisEasyAuction != address(0), "!_gnosisEasyAuction");
        require(_gammaController != address(0), "!_gammaController");
        require(_marginPool != address(0), "!_marginPool");
        require(_yearnRegistry != address(0), "!_yearnRegistry");

        WETH = _weth;
        USDC = _usdc;
        GAMMA_CONTROLLER = _gammaController;
        MARGIN_POOL = _marginPool;
        GNOSIS_EASY_AUCTION = _gnosisEasyAuction;
        YEARN_REGISTRY = _yearnRegistry;
    }

    /**
     * @notice Initializes the OptionVault contract with storage variables.
     */
    function baseInitialize(
        address _owner,
        address _feeRecipient,
        uint256 _managementFee,
        uint256 _performanceFee,
        string memory tokenName,
        string memory tokenSymbol,
        Vault.VaultParams calldata _vaultParams
    ) internal initializer {
        VaultLifecycleYearn.verifyConstructorParams(
            _owner,
            _feeRecipient,
            _performanceFee,
            tokenName,
            tokenSymbol,
            _vaultParams
        );

        __ReentrancyGuard_init();
        __ERC20_init(tokenName, tokenSymbol);
        __Ownable_init();
        transferOwnership(_owner);

        feeRecipient = _feeRecipient;
        performanceFee = _performanceFee;
        managementFee = _managementFee.div(uint256(365).div(7));
        vaultParams = _vaultParams;

        _upgradeYearnVault();

        vaultState.round = 1;
    }

    /************************************************
     *  SETTERS
     ***********************************************/

    /**
     * @notice Sets the new fee recipient
     * @param newFeeRecipient is the address of the new fee recipient
     */
    function setFeeRecipient(address newFeeRecipient) external onlyOwner {
        require(newFeeRecipient != address(0), "!newFeeRecipient");
        feeRecipient = newFeeRecipient;
    }

    /**
     * @notice Sets the management fee for the vault
     * @param newManagementFee is the management fee (6 decimals). ex: 2 * 10 ** 6 = 2%
     */
    function setManagementFee(uint256 newManagementFee) external onlyOwner {
        require(
            newManagementFee > 0 && newManagementFee < 100 * 10**6,
            "Invalid management fee"
        );

        emit ManagementFeeSet(managementFee, newManagementFee);

        // We are dividing annualized management fee by num weeks in a year
        managementFee = uint16(
            uint256(newManagementFee).div(uint256(365).div(7))
        );
    }

    /**
     * @notice Sets the performance fee for the vault
     * @param newPerformanceFee is the performance fee (6 decimals). ex: 20 * 10 ** 6 = 20%
     */
    function setPerformanceFee(uint256 newPerformanceFee) external onlyOwner {
        require(
            newPerformanceFee > 0 && newPerformanceFee < 100 * 10**6,
            "Invalid performance fee"
        );

        emit PerformanceFeeSet(performanceFee, newPerformanceFee);

        performanceFee = newPerformanceFee;
    }

    /**
     * @notice Sets a new cap for deposits
     * @param newCap is the new cap for deposits
     */
    function setCap(uint104 newCap) external onlyOwner {
        uint256 oldCap = vaultParams.cap;
        vaultParams.cap = newCap;
        emit CapSet(oldCap, newCap, msg.sender);
    }

    /************************************************
     *  DEPOSIT & WITHDRAWALS
     ***********************************************/

    /**
     * @notice Deposits ETH into the contract and mint vault shares. Reverts if the underlying is not WETH.
     */
    function depositETH() external payable nonReentrant {
        require(vaultParams.asset == WETH, "!WETH");
        require(msg.value > 0, "!value");

        _deposit(msg.value);

        IWETH(WETH).deposit{value: msg.value}();
    }

    /**
     * @notice Deposits the `asset` into the contract and mint vault shares.
     * @param amount is the amount of `asset` to deposit
     */
    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "!amount");

        _deposit(amount);

        IERC20(vaultParams.asset).safeTransferFrom(
            msg.sender,
            address(this),
            amount
        );
    }

    /**
     * @notice Mints the vault shares to the msg.sender
     * @param amount is the amount of `asset` deposited
     */
    function _deposit(uint256 amount) private {
        uint16 currentRound = vaultState.round;
        uint256 totalWithDepositedAmount = totalBalance().add(amount);

        require(totalWithDepositedAmount < vaultParams.cap, "Exceed cap");
        require(
            totalWithDepositedAmount >= vaultParams.minimumSupply,
            "Insufficient balance"
        );

        emit Deposit(msg.sender, amount, currentRound);

        Vault.DepositReceipt memory depositReceipt =
            depositReceipts[msg.sender];

        // If we have an unprocessed pending deposit from the previous rounds, we have to process it.
        uint128 unredeemedShares =
            depositReceipt.getSharesFromReceipt(
                currentRound,
                roundPricePerShare[depositReceipt.round],
                vaultParams.decimals
            );

        uint104 depositAmount = uint104(amount);
        // If we have a pending deposit in the current round, we add on to the pending deposit
        if (currentRound == depositReceipt.round) {
            // No deposits allowed until the next round
            require(!depositReceipt.processed, "Processed");

            uint256 newAmount = uint256(depositReceipt.amount).add(amount);
            ShareMath.assertUint104(newAmount);
            depositAmount = uint104(newAmount);
        } else {
            ShareMath.assertUint104(amount);
        }

        depositReceipts[msg.sender] = Vault.DepositReceipt({
            processed: false,
            round: currentRound,
            amount: depositAmount,
            unredeemedShares: unredeemedShares
        });

        vaultState.totalPending = uint128(
            uint256(vaultState.totalPending).add(amount)
        );
    }

    /**
     * @notice Initiates a withdrawal that can be processed once the round completes
     * @param shares is the number of shares to withdraw
     */
    function initiateWithdraw(uint128 shares) external nonReentrant {
        require(shares > 0, "!shares");

        // We do a max redeem before initiating a withdrawal
        // But we check if they must first have unredeemed shares
        if (
            depositReceipts[msg.sender].amount > 0 ||
            depositReceipts[msg.sender].unredeemedShares > 0
        ) {
            _redeem(0, true);
        }

        // This caches the `round` variable used in shareBalances
        uint16 currentRound = vaultState.round;
        Vault.Withdrawal memory withdrawal = withdrawals[msg.sender];

        bool topup = withdrawal.initiated && withdrawal.round == currentRound;

        emit InitiateWithdraw(msg.sender, shares, currentRound);

        if (topup) {
            uint256 increasedShares = uint256(withdrawal.shares).add(shares);
            require(increasedShares < type(uint128).max, "Overflow");
            withdrawals[msg.sender].shares = uint128(increasedShares);
        } else if (!withdrawal.initiated) {
            withdrawals[msg.sender].initiated = true;
            withdrawals[msg.sender].shares = shares;
            withdrawals[msg.sender].round = currentRound;
        } else {
            // If we have an old withdrawal, we revert
            // The user has to process the withdrawal
            revert("Existing withdraw");
        }

        vaultState.queuedWithdrawShares = uint128(
            uint256(vaultState.queuedWithdrawShares).add(shares)
        );

        _transfer(msg.sender, address(this), shares);
    }

    /**
     * @notice Completes a scheduled withdrawal from a past round. Uses finalized pps for the round
     * @param keepWrapped is whether to withdraw in the yield token
     */
    function completeWithdraw(bool keepWrapped) external nonReentrant {
        Vault.Withdrawal memory withdrawal = withdrawals[msg.sender];

        require(withdrawal.initiated, "Not initiated");
        require(withdrawal.round < vaultState.round, "Round not closed");

        // We leave the round number as non-zero to save on gas for subsequent writes
        withdrawals[msg.sender].initiated = false;
        withdrawals[msg.sender].shares = 0;
        vaultState.queuedWithdrawShares = uint128(
            uint256(vaultState.queuedWithdrawShares).sub(withdrawal.shares)
        );

        uint256 withdrawAmount =
            ShareMath.sharesToUnderlying(
                withdrawal.shares,
                roundPricePerShare[withdrawal.round],
                vaultParams.decimals
            );

        if (!keepWrapped) {
            withdrawAmount = VaultLifecycleYearn.withdrawYieldAndBaseToken(
                WETH,
                vaultParams.asset,
                address(collateralToken),
                msg.sender,
                withdrawAmount
            );
        } else {
            VaultLifecycleYearn.unwrapYieldToken(
                withdrawAmount,
                vaultParams.asset,
                address(collateralToken),
                YEARN_WITHDRAWAL_BUFFER,
                YEARN_WITHDRAWAL_SLIPPAGE
            );
            VaultLifecycleYearn.transferAsset(
                WETH,
                vaultParams.asset,
                msg.sender,
                withdrawAmount
            );
        }

        require(withdrawAmount > 0, "!withdrawAmount");

        emit Withdraw(
            msg.sender,
            keepWrapped,
            withdrawAmount,
            withdrawal.shares
        );

        _burn(address(this), withdrawal.shares);
    }

    /**
     * @notice Redeems shares that are owed to the account
     * @param shares is the number of shares to redeem
     */
    function redeem(uint256 shares) external nonReentrant {
        require(shares > 0, "!shares");
        _redeem(shares, false);
    }

    /**
     * @notice Redeems the entire unredeemedShares balance that is owed to the account
     */
    function maxRedeem() external nonReentrant {
        _redeem(0, true);
    }

    /**
     * @notice Redeems shares that are owed to the account
     * @param shares is the number of shares to redeem, could be 0 when isMax=true
     * @param isMax is flag for when callers do a max redemption
     */
    function _redeem(uint256 shares, bool isMax) internal {
        ShareMath.assertUint104(shares);

        Vault.DepositReceipt memory depositReceipt =
            depositReceipts[msg.sender];

        // This handles the null case when depositReceipt.round = 0
        // Because we start with round = 1 at `initialize`
        uint16 currentRound = vaultState.round;
        require(depositReceipt.round < currentRound, "Round not closed");

        uint128 unredeemedShares =
            depositReceipt.getSharesFromReceipt(
                currentRound,
                roundPricePerShare[depositReceipt.round],
                vaultParams.decimals
            );

        shares = isMax ? unredeemedShares : shares;
        require(shares > 0, "!shares");
        require(shares <= unredeemedShares, "Exceeds available");

        // This zeroes out any pending amount from depositReceipt
        depositReceipts[msg.sender].amount = 0;
        depositReceipts[msg.sender].processed = true;
        depositReceipts[msg.sender].unredeemedShares = uint128(
            uint256(unredeemedShares).sub(shares)
        );

        emit Redeem(msg.sender, shares, depositReceipt.round);

        _transfer(address(this), msg.sender, shares);
    }

    /************************************************
     *  VAULT OPERATIONS
     ***********************************************/

    /*
     * @notice Helper function that helps to save gas for writing values into the roundPricePerShare map.
     *         Writing `1` into the map makes subsequent writes warm, reducing the gas from 20k to 5k.
     *         Having 1 initialized beforehand will not be an issue as long as we round down share calculations to 0.
     * @param numRounds is the number of rounds to initialize in the map
     */
    function initRounds(uint256 numRounds) external nonReentrant {
        require(numRounds < 52, "numRounds >= 52");

        uint16 _round = vaultState.round;
        for (uint16 i = 0; i < numRounds; i++) {
            uint16 index = _round + i;
            require(index >= _round, "Overflow");
            require(roundPricePerShare[index] == 0, "Initialized"); // AVOID OVERWRITING ACTUAL VALUES
            roundPricePerShare[index] = PLACEHOLDER_UINT;
        }
    }

    /*
     * @notice Helper function that performs most administrative tasks
     * such as setting next option, minting new shares, getting vault fees, etc.
     * @return newOption is the new option address
     * @return lockedBalance is the new balance used to calculate next option purchase size or collateral size
     */
    function _rollToNextOption() internal returns (address, uint256) {
        require(block.timestamp >= optionState.nextOptionReadyAt, "Not ready");

        address newOption = optionState.nextOption;
        require(newOption != address(0), "!nextOption");

        (uint256 lockedBalance, uint256 newPricePerShare, uint256 mintShares) =
            VaultLifecycleYearn.rollover(
                totalSupply(),
                totalBalance(),
                vaultParams,
                vaultState
            );

        optionState.currentOption = newOption;
        optionState.nextOption = address(0);

        // Finalize the pricePerShare at the end of the round
        uint16 currentRound = vaultState.round;
        roundPricePerShare[currentRound] = newPricePerShare;

        // Take management / performance fee from previous round and deduct
        lockedBalance = lockedBalance.sub(_collectVaultFees(lockedBalance));

        vaultState.totalPending = 0;
        vaultState.round = currentRound + 1;
        vaultState.lockedAmount = uint104(lockedBalance);

        _mint(address(this), mintShares);

        // Wrap entire `asset` balance to `collateralToken` balance
        VaultLifecycleYearn.wrapToYieldToken(
            vaultParams.asset,
            address(collateralToken)
        );

        return (newOption, lockedBalance);
    }

    /*
     * @notice Helper function that transfers management fees and performance fees from previous round.
     * @param currentLockedBalance is the balance we are about to lock for next round
     * @return vaultFee is the fee deducted
     */
    function _collectVaultFees(uint256 currentLockedBalance)
        internal
        returns (uint256 vaultFee)
    {
        uint256 prevLockedAmount = vaultState.lastLockedAmount;

        // Take performance fee and management fee ONLY if difference between
        // last week and this week's vault deposits, taking into account pending
        // deposits and withdrawals, is positive. If it is negative, last week's
        // option expired ITM past breakeven, and the vault took a loss so we
        // do not collect performance fee for last week
        if (
            currentLockedBalance.sub(vaultState.totalPending) > prevLockedAmount
        ) {
            uint256 performanceFeeInAsset =
                performanceFee > 0
                    ? currentLockedBalance
                        .sub(vaultState.totalPending)
                        .sub(prevLockedAmount)
                        .mul(performanceFee)
                        .div(100 * 10**6)
                    : 0;
            uint256 managementFeeInAsset =
                managementFee > 0
                    ? currentLockedBalance.mul(managementFee).div(100 * 10**6)
                    : 0;

            vaultFee = performanceFeeInAsset.add(managementFeeInAsset);
        }

        if (vaultFee > 0) {
            VaultLifecycleYearn.withdrawYieldAndBaseToken(
                WETH,
                vaultParams.asset,
                address(collateralToken),
                feeRecipient,
                vaultFee
            );
            emit CollectVaultFees(
                performanceFee,
                managementFee,
                vaultFee,
                vaultState.round
            );
        }
    }

    /*
      Upgrades the vault to point to the latest yearn vault for the asset token
    */
    function upgradeYearnVault() external onlyOwner {
        // Unwrap old yvUSDC
        VaultLifecycleYearn.unwrapYieldToken(
            collateralToken.balanceOf(address(this)),
            vaultParams.asset,
            address(collateralToken),
            YEARN_WITHDRAWAL_BUFFER,
            YEARN_WITHDRAWAL_SLIPPAGE
        );
        _upgradeYearnVault();
    }

    function _upgradeYearnVault() internal {
        address collateralAddr =
            IYearnRegistry(YEARN_REGISTRY).latestVault(vaultParams.asset);
        require(collateralAddr != address(0), "!collateralToken");
        collateralToken = IYearnVault(collateralAddr);
    }

    /************************************************
     *  GETTERS
     ***********************************************/

    /**
     * @notice Returns the underlying balance held on the vault for the account
     * @param account is the address to lookup balance for
     */
    function accountVaultBalance(address account)
        external
        view
        returns (uint256)
    {
        uint8 decimals = vaultParams.decimals;
        uint256 numShares = shares(account);
        uint256 pps =
            totalBalance().sub(vaultState.totalPending).mul(10**decimals).div(
                totalSupply()
            );
        return ShareMath.sharesToUnderlying(numShares, pps, decimals);
    }

    /**
     * @notice Getter for returning the account's share balance including unredeemed shares
     * @param account is the account to lookup share balance for
     * @return the share balance
     */
    function shares(address account) public view returns (uint256) {
        (uint256 heldByAccount, uint256 heldByVault) = shareBalances(account);
        return heldByAccount.add(heldByVault);
    }

    /**
     * @notice Getter for returning the account's share balance split between account and vault holdings
     * @param account is the account to lookup share balance for
     * @return heldByAccount is the shares held by account
     * @return heldByVault is the shares held on the vault (unredeemedShares)
     */
    function shareBalances(address account)
        public
        view
        returns (uint256 heldByAccount, uint256 heldByVault)
    {
        Vault.DepositReceipt memory depositReceipt = depositReceipts[account];

        if (depositReceipt.round < PLACEHOLDER_UINT) {
            return (balanceOf(account), 0);
        }

        uint128 unredeemedShares =
            depositReceipt.getSharesFromReceipt(
                vaultState.round,
                roundPricePerShare[depositReceipt.round],
                vaultParams.decimals
            );

        return (balanceOf(account), unredeemedShares);
    }

    /**
     * @notice The price of a unit of share denominated in the `collateral`
     */
    function pricePerShare() external view returns (uint256) {
        uint256 balance = totalBalance().sub(vaultState.totalPending);
        return
            (10**uint256(vaultParams.decimals)).mul(balance).div(totalSupply());
    }

    /**
     * @notice Returns the vault's total balance, including the amounts locked into a short position
     * @return total balance of the vault, including the amounts locked in third party protocols
     */
    function totalBalance() public view returns (uint256) {
        return
            uint256(vaultState.lockedAmount)
                .add(IERC20(vaultParams.asset).balanceOf(address(this)))
                .add(
                VaultLifecycleYearn.dswdiv(
                    collateralToken.balanceOf(address(this)),
                    collateralToken.pricePerShare().mul(
                        VaultLifecycleYearn.decimalShift(
                            address(collateralToken)
                        )
                    )
                )
            );
    }

    /**
     * @notice Returns the token decimals
     */
    function decimals() public view override returns (uint8) {
        return vaultParams.decimals;
    }

    function cap() external view returns (uint256) {
        return vaultParams.cap;
    }

    function nextOptionReadyAt() external view returns (uint256) {
        return optionState.nextOptionReadyAt;
    }

    function currentOption() external view returns (address) {
        return optionState.currentOption;
    }

    function nextOption() external view returns (address) {
        return optionState.nextOption;
    }

    function totalPending() external view returns (uint256) {
        return vaultState.totalPending;
    }

    /************************************************
     *  HELPERS
     ***********************************************/
}
