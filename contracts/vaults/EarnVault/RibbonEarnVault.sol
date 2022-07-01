// SPDX-License-Identifier: MIT
pragma solidity =0.8.4;

import {SafeMath} from "@openzeppelin/contracts/utils/math/SafeMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Detailed} from "../../interfaces/IERC20Detailed.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/draft-IERC20Permit.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {
    ReentrancyGuardUpgradeable
} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import {
    OwnableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {
    ERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

import {
    SafeERC20
} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IWETH} from "../../interfaces/IWETH.sol";

import {RibbonEarnVaultStorage} from "../../storage/RibbonEarnVaultStorage.sol";
import {Vault} from "../../libraries/Vault.sol";
import {VaultLifecycleEarn} from "../../libraries/VaultLifecycleEarn.sol";
import {ShareMath} from "../../libraries/ShareMath.sol";
import {ILiquidityGauge} from "../../interfaces/ILiquidityGauge.sol";
import {IVaultPauser} from "../../interfaces/IVaultPauser.sol";

/**
 * UPGRADEABILITY: Since we use the upgradeable proxy pattern, we must observe
 * the inheritance chain closely.
 * Any changes/appends in storage variable needs to happen in RibbonEarnVaultStorage.
 * RibbonEarnVault should not inherit from any other contract aside from RibbonVault, RibbonEarnVaultStorage
 */
contract RibbonEarnVault is
    ReentrancyGuardUpgradeable,
    OwnableUpgradeable,
    ERC20Upgradeable,
    RibbonEarnVaultStorage
{
    using SafeERC20 for IERC20;
    using SafeMath for uint256;
    using ShareMath for Vault.DepositReceipt;

    // *IMPORTANT* NO NEW STORAGE VARIABLES SHOULD BE ADDED HERE
    // This is to prevent storage collisions. All storage variables should be appended to RibbonEarnVaultStorage.
    // Read this documentation to learn more:
    // https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable#modifying-your-contracts

    /************************************************
     *  IMMUTABLES & CONSTANTS
     ***********************************************/

    /// @notice WETH9 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
    address public immutable WETH;

    /// @notice USDC 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
    address public immutable USDC;

    uint16 public constant TOTAL_PCT = 10000; // Equals 100%

    // Number of weeks per year = 52.142857 weeks * FEE_MULTIPLIER = 52142857
    // Dividing by weeks per year requires doing num.mul(FEE_MULTIPLIER).div(WEEKS_PER_YEAR)
    uint256 private constant WEEKS_PER_YEAR = 52142857;

    /************************************************
     *  EVENTS
     ***********************************************/

    event Deposit(address indexed account, uint256 amount, uint256 round);

    event InitiateWithdraw(
        address indexed account,
        uint256 shares,
        uint256 round
    );

    event Redeem(address indexed account, uint256 share, uint256 round);

    event ManagementFeeSet(uint256 managementFee, uint256 newManagementFee);

    event PerformanceFeeSet(uint256 performanceFee, uint256 newPerformanceFee);

    event CapSet(uint256 oldCap, uint256 newCap);

    event BorrowerSet(address oldBorrower, address newBorrower);

    event OptionSellerSet(address oldOptionSeller, address newOptionSeller);

    event NewLoanOptionAllocationSet(
        uint256 oldLoanAllocation,
        uint256 oldOptionAllocation,
        uint256 newLoanAllocation,
        uint256 newOptionAllocation
    );

    event NewLoanTermLength(
        uint256 oldLoanTermLength,
        uint256 newLoanTermLength
    );

    event NewOptionPurchaseFrequency(
        uint256 oldOptionPurchaseFrequency,
        uint256 newOptionPurchaseFrequency
    );

    event Withdraw(address indexed account, uint256 amount, uint256 shares);

    event CollectVaultFees(
        uint256 performanceFee,
        uint256 vaultFee,
        uint256 round,
        address indexed feeRecipient
    );

    event OpenLoan(uint256 amount, address indexed borrower);

    event CloseLoan(
        uint256 amount,
        uint256 yield,
        uint256 yearlyInterest,
        address indexed borrower
    );

    event PurchaseOption(uint256 premium, address indexed seller);

    event PayOptionYield(
        uint256 yield,
        uint256 netYield,
        uint256 pctPayoff,
        address indexed seller
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
    constructor(address _weth, address _usdc) {
        require(_weth != address(0), "!_weth");
        require(_usdc != address(0), "!_usdc");

        WETH = _weth;
        USDC = _usdc;
    }

    /**
     * @notice Initializes the OptionVault contract with storage variables.
     * @param _initParams is the struct with vault initialization parameters
     * @param _vaultParams is the struct with vault general data
     * @param _allocationState is the struct with vault loan/option allocation data
     */
    function initialize(
        InitParams calldata _initParams,
        Vault.VaultParams calldata _vaultParams,
        Vault.AllocationState calldata _allocationState
    ) external initializer {
        require(_initParams._owner != address(0), "!owner");

        VaultLifecycleEarn.verifyInitializerParams(
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

        __ReentrancyGuard_init();
        __ERC20_init(_initParams._tokenName, _initParams._tokenSymbol);
        __Ownable_init();
        transferOwnership(_initParams._owner);

        keeper = _initParams._keeper;

        feeRecipient = _initParams._feeRecipient;
        borrower = _initParams._borrower;
        optionSeller = _initParams._optionSeller;
        performanceFee = _initParams._performanceFee;
        managementFee = _initParams
            ._managementFee
            .mul(Vault.FEE_MULTIPLIER)
            .div(WEEKS_PER_YEAR);
        vaultParams = _vaultParams;
        allocationState = _allocationState;

        uint256 assetBalance =
            IERC20(vaultParams.asset).balanceOf(address(this));
        ShareMath.assertUint104(assetBalance);
        vaultState.lastLockedAmount = uint104(assetBalance);

        vaultState.round = 1;
    }

    /**
     * @dev Throws if called by any account other than the keeper.
     */
    modifier onlyKeeper() {
        require(msg.sender == keeper, "!keeper");
        _;
    }

    /**
     * @dev Throws if called by any account other than the borrower.
     */
    modifier onlyBorrower() {
        require(msg.sender == borrower, "!borrower");
        _;
    }

    /**
     * @dev Throws if called by any account other than the option seller.
     */
    modifier onlyOptionSeller() {
        require(msg.sender == optionSeller, "!optionSeller");
        _;
    }

    /************************************************
     *  SETTERS
     ***********************************************/

    /**
     * @notice Sets the new keeper
     * @param newKeeper is the address of the new keeper
     */
    function setNewKeeper(address newKeeper) external onlyOwner {
        require(newKeeper != address(0), "!newKeeper");
        keeper = newKeeper;
    }

    /**
     * @notice Sets the new fee recipient
     * @param newFeeRecipient is the address of the new fee recipient
     */
    function setFeeRecipient(address newFeeRecipient) external onlyOwner {
        require(newFeeRecipient != address(0), "!newFeeRecipient");
        require(newFeeRecipient != feeRecipient, "Must be new feeRecipient");
        feeRecipient = newFeeRecipient;
    }

    /**
     * @notice Sets the new borrower
     * @param newBorrower is the address of the new borrower
     */
    function setBorrower(address newBorrower) external onlyOwner {
        require(newBorrower != address(0), "!newBorrower");
        require(newBorrower != borrower, "Must be new borrower");
        emit BorrowerSet(borrower, newBorrower);
        pendingBorrower = newBorrower;
        lastBorrowerChange = block.timestamp;
    }

    /**
     * @notice Sets the new option seller
     * @param newOptionSeller is the address of the new option seller
     */
    function setOptionSeller(address newOptionSeller) external onlyOwner {
        require(newOptionSeller != address(0), "!newOptionSeller");
        require(newOptionSeller != optionSeller, "Must be new option seller");
        emit OptionSellerSet(optionSeller, newOptionSeller);
        optionSeller = newOptionSeller;
    }

    /**
     * @notice Commits the pending borrower
     */
    function commitBorrower() external onlyOwner {
        require(block.timestamp >= lastBorrowerChange + 3 days, "!timelock");
        borrower = pendingBorrower;
    }

    /**
     * @notice Sets the management fee for the vault
     * @param newManagementFee is the management fee (6 decimals). ex: 2 * 10 ** 6 = 2%
     */
    function setManagementFee(uint256 newManagementFee) external onlyOwner {
        require(
            newManagementFee < 100 * Vault.FEE_MULTIPLIER,
            "Invalid management fee"
        );

        // We are dividing annualized management fee by num weeks in a year
        uint256 tmpManagementFee =
            newManagementFee.mul(Vault.FEE_MULTIPLIER).div(WEEKS_PER_YEAR);

        emit ManagementFeeSet(managementFee, newManagementFee);

        managementFee = tmpManagementFee;
    }

    /**
     * @notice Sets the performance fee for the vault
     * @param newPerformanceFee is the performance fee (6 decimals). ex: 20 * 10 ** 6 = 20%
     */
    function setPerformanceFee(uint256 newPerformanceFee) external onlyOwner {
        require(
            newPerformanceFee < 100 * Vault.FEE_MULTIPLIER,
            "Invalid performance fee"
        );

        emit PerformanceFeeSet(performanceFee, newPerformanceFee);

        performanceFee = newPerformanceFee;
    }

    /**
     * @notice Sets a new cap for deposits
     * @param newCap is the new cap for deposits
     */
    function setCap(uint256 newCap) external onlyOwner {
        require(newCap > 0, "!newCap");
        ShareMath.assertUint104(newCap);
        emit CapSet(vaultParams.cap, newCap);
        vaultParams.cap = uint104(newCap);
    }

    /**
     * @notice Sets new loan allocation percentage
     * @dev Can be called by admin
     * @param _loanAllocationPCT new allocation for loan
     */
    function setLoanAllocationPCT(uint16 _loanAllocationPCT)
        external
        onlyOwner
    {
        require(_loanAllocationPCT <= TOTAL_PCT, "!_loanAllocationPCT");
        uint16 nextOptionAllocationPCT =
            uint16(uint256(TOTAL_PCT).sub(_loanAllocationPCT));

        emit NewLoanOptionAllocationSet(
            uint256(allocationState.loanAllocationPCT),
            uint256(allocationState.optionAllocationPCT),
            uint256(_loanAllocationPCT),
            uint256(nextOptionAllocationPCT)
        );

        allocationState.loanAllocationPCT = _loanAllocationPCT;
        allocationState.optionAllocationPCT = nextOptionAllocationPCT;
    }

    /**
     * @notice Sets loan term length
     * @dev Can be called by admin
     * @param _loanTermLength new loan term length
     */
    function setLoanTermLength(uint32 _loanTermLength) external onlyOwner {
        require(_loanTermLength >= 1 days, "!_loanTermLength");

        allocationState.nextLoanTermLength = _loanTermLength;
        emit NewLoanTermLength(
            allocationState.currentLoanTermLength,
            _loanTermLength
        );
    }

    /**
     * @notice Sets option purchase frequency
     * @dev Can be called by admin
     * @param _optionPurchaseFreq new option purchase frequency
     */
    function setOptionPurchaseFrequency(uint32 _optionPurchaseFreq)
        external
        onlyOwner
    {
        require(
            _optionPurchaseFreq > 0 &&
                ((!allocationState.nextLoanTermLength ||
                    _optionPurchaseFreq <=
                    allocationState.nextLoanTermLength) ||
                    (_optionPurchaseFreq <=
                        allocationState.currentLoanTermLength)),
            "!_optionPurchaseFreq"
        );
        allocationState.nextOptionPurchaseFreq = _optionPurchaseFreq;
        emit NewOptionPurchaseFrequency(
            allocationState.currentOptionPurchaseFreq,
            _optionPurchaseFreq
        );
    }

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
     *  DEPOSIT & WITHDRAWALS
     ***********************************************/

    /**
     * @notice Deposits ETH into the contract and mint vault shares. Reverts if the asset is not WETH.
     */
    function depositETH() external payable nonReentrant {
        require(vaultParams.asset == WETH, "!WETH");
        require(msg.value > 0, "!value");

        _depositFor(msg.value, msg.sender);

        IWETH(WETH).deposit{value: msg.value}();
    }

    /**
     * @notice Deposits the `asset` from msg.sender.
     * @param amount is the amount of `asset` to deposit
     */
    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "!amount");

        _depositFor(amount, msg.sender);

        // An approve() by the msg.sender is required beforehand
        IERC20(vaultParams.asset).safeTransferFrom(
            msg.sender,
            address(this),
            amount
        );
    }

    /**
     * @notice Deposits the `asset` from msg.sender added to `creditor`'s deposit.
     * @notice Used for vault -> vault deposits on the user's behalf
     * @param amount is the amount of `asset` to deposit
     * @param creditor is the address that can claim/withdraw deposited amount
     */
    function depositFor(uint256 amount, address creditor)
        external
        nonReentrant
    {
        require(amount > 0, "!amount");
        require(creditor != address(0));

        _depositFor(amount, creditor);

        // An approve() by the msg.sender is required beforehand
        IERC20(vaultParams.asset).safeTransferFrom(
            msg.sender,
            address(this),
            amount
        );
    }

    /**
     * @notice Mints the vault shares to the creditor
     * @param amount is the amount of `asset` deposited
     * @param creditor is the address to receieve the deposit
     */
    function _depositFor(uint256 amount, address creditor) private {
        uint256 currentRound = vaultState.round;
        uint256 totalWithDepositedAmount = totalBalance().add(amount);

        require(totalWithDepositedAmount <= vaultParams.cap, "Exceed cap");
        require(
            totalWithDepositedAmount >= vaultParams.minimumSupply,
            "Insufficient balance"
        );

        emit Deposit(creditor, amount, currentRound);

        Vault.DepositReceipt memory depositReceipt = depositReceipts[creditor];

        // If we have an unprocessed pending deposit from the previous rounds, we have to process it.
        uint256 unredeemedShares =
            depositReceipt.getSharesFromReceipt(
                currentRound,
                roundPricePerShare[depositReceipt.round],
                vaultParams.decimals
            );

        uint256 depositAmount = amount;

        // If we have a pending deposit in the current round, we add on to the pending deposit
        if (currentRound == depositReceipt.round) {
            uint256 newAmount = uint256(depositReceipt.amount).add(amount);
            depositAmount = newAmount;
        }

        ShareMath.assertUint104(depositAmount);

        depositReceipts[creditor] = Vault.DepositReceipt({
            round: uint16(currentRound),
            amount: uint104(depositAmount),
            unredeemedShares: uint128(unredeemedShares)
        });

        uint256 newTotalPending = uint256(vaultState.totalPending).add(amount);
        ShareMath.assertUint128(newTotalPending);

        vaultState.totalPending = uint128(newTotalPending);
    }

    /**
     * @notice Initiates a withdrawal that can be processed once the round completes
     * @param numShares is the number of shares to withdraw
     */
    function _initiateWithdraw(uint256 numShares) internal {
        require(numShares > 0, "!numShares");

        // We do a max redeem before initiating a withdrawal
        // But we check if they must first have unredeemed shares
        if (
            depositReceipts[msg.sender].amount > 0 ||
            depositReceipts[msg.sender].unredeemedShares > 0
        ) {
            _redeem(0, true);
        }

        // This caches the `round` variable used in shareBalances
        uint256 currentRound = vaultState.round;
        Vault.Withdrawal storage withdrawal = withdrawals[msg.sender];

        bool withdrawalIsSameRound = withdrawal.round == currentRound;

        emit InitiateWithdraw(msg.sender, numShares, currentRound);

        uint256 existingShares = uint256(withdrawal.shares);

        uint256 withdrawalShares;
        if (withdrawalIsSameRound) {
            withdrawalShares = existingShares.add(numShares);
        } else {
            require(existingShares == 0, "Existing withdraw");
            withdrawalShares = numShares;
            withdrawals[msg.sender].round = uint16(currentRound);
        }

        ShareMath.assertUint128(withdrawalShares);
        withdrawals[msg.sender].shares = uint128(withdrawalShares);

        _transfer(msg.sender, address(this), numShares);
    }

    /**
     * @notice Completes a scheduled withdrawal from a past round. Uses finalized pps for the round
     * @return withdrawAmount the current withdrawal amount
     */
    function _completeWithdraw() internal returns (uint256) {
        Vault.Withdrawal storage withdrawal = withdrawals[msg.sender];

        uint256 withdrawalShares = withdrawal.shares;
        uint256 withdrawalRound = withdrawal.round;

        // This checks if there is a withdrawal
        require(withdrawalShares > 0, "Not initiated");

        require(withdrawalRound < vaultState.round, "Round not closed");

        // We leave the round number as non-zero to save on gas for subsequent writes
        withdrawals[msg.sender].shares = 0;
        vaultState.queuedWithdrawShares = uint128(
            uint256(vaultState.queuedWithdrawShares).sub(withdrawalShares)
        );

        uint256 withdrawAmount =
            ShareMath.sharesToAsset(
                withdrawalShares,
                roundPricePerShare[withdrawalRound],
                vaultParams.decimals
            );

        emit Withdraw(msg.sender, withdrawAmount, withdrawalShares);

        _burn(address(this), withdrawalShares);

        require(withdrawAmount > 0, "!withdrawAmount");
        transferAsset(msg.sender, withdrawAmount);

        return withdrawAmount;
    }

    /**
     * @notice Redeems shares that are owed to the account
     * @param numShares is the number of shares to redeem
     */
    function redeem(uint256 numShares) external nonReentrant {
        require(numShares > 0, "!numShares");
        _redeem(numShares, false);
    }

    /**
     * @notice Redeems the entire unredeemedShares balance that is owed to the account
     */
    function maxRedeem() external nonReentrant {
        _redeem(0, true);
    }

    /**
     * @notice Redeems shares that are owed to the account
     * @param numShares is the number of shares to redeem, could be 0 when isMax=true
     * @param isMax is flag for when callers do a max redemption
     */
    function _redeem(uint256 numShares, bool isMax) internal {
        Vault.DepositReceipt memory depositReceipt =
            depositReceipts[msg.sender];

        // This handles the null case when depositReceipt.round = 0
        // Because we start with round = 1 at `initialize`
        uint256 currentRound = vaultState.round;

        uint256 unredeemedShares =
            depositReceipt.getSharesFromReceipt(
                currentRound,
                roundPricePerShare[depositReceipt.round],
                vaultParams.decimals
            );

        numShares = isMax ? unredeemedShares : numShares;
        if (numShares == 0) {
            return;
        }
        require(numShares <= unredeemedShares, "Exceeds available");

        // If we have a depositReceipt on the same round, BUT we have some unredeemed shares
        // we debit from the unredeemedShares, but leave the amount field intact
        // If the round has past, with no new deposits, we just zero it out for new deposits.
        if (depositReceipt.round < currentRound) {
            depositReceipts[msg.sender].amount = 0;
        }

        ShareMath.assertUint128(numShares);
        depositReceipts[msg.sender].unredeemedShares = uint128(
            unredeemedShares.sub(numShares)
        );

        emit Redeem(msg.sender, numShares, depositReceipt.round);

        _transfer(address(this), msg.sender, numShares);
    }

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

    /************************************************
     *  VAULT OPERATIONS
     ***********************************************/

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
    function rollToNextRound() external onlyKeeper nonReentrant {
        uint256 currQueuedWithdrawShares = currentQueuedWithdrawShares;

        (uint256 lockedBalance, uint256 queuedWithdrawAmount) =
            _rollToNextRound(
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
        // Sign for transfer approval
        IERC20Permit(vaultParams.asset).permit(
            msg.sender,
            address(this),
            amount,
            deadline,
            v,
            r,
            s
        );

        // Pay option yields to contract
        _payOptionYield(amount);
    }

    /**
     * @notice Pays option yield if option is ITM
     * @param amount is the amount of yield to pay
     */
    function payOptionYield(uint256 amount) external onlyOptionSeller {
        // Pay option yields to contract
        _payOptionYield(amount);
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
        // Sign for transfer approval
        IERC20Permit(vaultParams.asset).permit(
            msg.sender,
            address(this),
            amount,
            deadline,
            v,
            r,
            s
        );

        // Return lent funds
        _returnLentFunds(amount);
    }

    /**
     * @notice Return lend funds
     * @param amount is the amount to return (principal + interest)
     */
    function returnLentFunds(uint256 amount) external onlyBorrower {
        // Return lent funds
        _returnLentFunds(amount);
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

    /**
     * @notice Helper function to make either an ETH transfer or ERC20 transfer
     * @param recipient is the receiving address
     * @param amount is the transfer amount
     */
    function transferAsset(address recipient, uint256 amount) internal {
        address asset = vaultParams.asset;
        if (asset == WETH) {
            IWETH(WETH).withdraw(amount);
            (bool success, ) = recipient.call{value: amount}("");
            require(success, "Transfer failed");
            return;
        }
        IERC20(asset).safeTransfer(recipient, amount);
    }

    /**
     * @notice Helper function that transfers funds from option
     * seller
     * @param amount is the amount of yield to pay
     */
    function _payOptionYield(uint256 amount) internal {
        address asset = vaultParams.asset;

        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);

        uint256 optionAllocation = allocationState.optionAllocation;

        uint256 yieldInUSD =
            amount > optionAllocation ? amount.sub(optionAllocation) : 0;
        uint256 yieldInPCT =
            amount > optionAllocation
                ? amount.mul(Vault.YIELD_MULTIPLIER).div(optionAllocation)
                : 0;

        emit PayOptionYield(amount, yieldInUSD, yieldInPCT, msg.sender);
    }

    /**
     * @notice Helper function that performs most administrative tasks
     * such as minting new shares, getting vault fees, etc.
     * @param lastQueuedWithdrawAmount is old queued withdraw amount
     * @param currentQueuedWithdrawShares is the queued withdraw shares for the current round
     * @return lockedBalance is the new balance used to calculate next option purchase size or collateral size
     * @return queuedWithdrawAmount is the new queued withdraw amount for this round
     */
    function _rollToNextRound(
        uint256 lastQueuedWithdrawAmount,
        uint256 currentQueuedWithdrawShares
    ) internal returns (uint256 lockedBalance, uint256 queuedWithdrawAmount) {
        require(
            block.timestamp >=
                uint256(vaultState.lastEpochTime).add(
                    allocationState.currentLoanTermLength
                ),
            "!ready"
        );

        address recipient = feeRecipient;
        uint256 mintShares;
        uint256 performanceFeeInAsset;
        uint256 totalVaultFee;
        {
            uint256 newPricePerShare;
            (
                lockedBalance,
                queuedWithdrawAmount,
                newPricePerShare,
                mintShares,
                performanceFeeInAsset,
                totalVaultFee
            ) = VaultLifecycleEarn.rollover(
                vaultState,
                VaultLifecycleEarn.RolloverParams(
                    vaultParams.decimals,
                    IERC20(vaultParams.asset).balanceOf(address(this)),
                    totalSupply(),
                    lastQueuedWithdrawAmount,
                    performanceFee,
                    managementFee,
                    currentQueuedWithdrawShares
                )
            );

            // Finalize the pricePerShare at the end of the round
            uint256 currentRound = vaultState.round;
            roundPricePerShare[currentRound] = newPricePerShare;

            emit CollectVaultFees(
                performanceFeeInAsset,
                totalVaultFee,
                currentRound,
                recipient
            );

            vaultState.totalPending = 0;
            vaultState.round = uint16(currentRound + 1);
            vaultState.lastEpochTime = uint64(
                block.timestamp - (block.timestamp % (24 hours)) + (8 hours)
            );
        }

        _mint(address(this), mintShares);

        if (totalVaultFee > 0) {
            transferAsset(payable(recipient), totalVaultFee);
        }

        _updateAllocationState(lockedBalance);

        return (lockedBalance, queuedWithdrawAmount);
    }

    function _returnLentFunds(uint256 amount) internal {
        IERC20(vaultParams.asset).safeTransferFrom(
            msg.sender,
            address(this),
            amount
        );

        uint256 loanAllocation = allocationState.loanAllocation;

        uint256 yield =
            amount > loanAllocation ? amount.sub(loanAllocation) : 0;

        emit CloseLoan(
            amount,
            yield,
            (yield * 12).mul(10**2).div(loanAllocation),
            msg.sender
        );
    }

    /**
     * @notice Helper function that updates allocation state
     * such as loan term length, option purchase frequency, loan / option
     * allocation split, etc.
     * @param lockedBalance is the locked balance for newest epoch
     */
    function _updateAllocationState(uint256 lockedBalance) internal {
        Vault.AllocationState memory _allocationState = allocationState;

        // Set next loan term length
        if (_allocationState.nextLoanTermLength != 0) {
            allocationState.currentLoanTermLength = _allocationState
                .nextLoanTermLength;
            allocationState.nextLoanTermLength = 0;
        }

        // Set next option purchase frequency
        if (_allocationState.nextOptionPurchaseFreq != 0) {
            allocationState.currentOptionPurchaseFreq = _allocationState
                .nextOptionPurchaseFreq;
            allocationState.nextOptionPurchaseFreq = 0;
        }

        // Set next loan allocation from vault in USD
        allocationState.loanAllocation = uint256(
            _allocationState
                .loanAllocationPCT
        )
            .mul(lockedBalance)
            .div(TOTAL_PCT);
        uint8 optionPurchasesPerLoanTerm =
            SafeCast.toUint8(
                uint256(_allocationState.currentLoanTermLength).div(
                    _allocationState.nextOptionPurchaseFreq
                )
            );
        // Set next option allocation from vault per purchase in USD
        allocationState.optionAllocation = lockedBalance
            .sub(_allocationState.loanAllocation)
            .div(optionPurchasesPerLoanTerm);
    }

    /************************************************
     *  GETTERS
     ***********************************************/

    /**
     * @notice Returns the asset balance held on the vault for the account
     * @param account is the address to lookup balance for
     * @return the amount of `asset` custodied by the vault for the user
     */
    function accountVaultBalance(address account)
        external
        view
        returns (uint256)
    {
        uint256 _decimals = vaultParams.decimals;
        uint256 assetPerShare =
            ShareMath.pricePerShare(
                totalSupply(),
                totalBalance(),
                vaultState.totalPending,
                _decimals
            );
        return
            ShareMath.sharesToAsset(shares(account), assetPerShare, _decimals);
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

        if (depositReceipt.round < ShareMath.PLACEHOLDER_UINT) {
            return (balanceOf(account), 0);
        }

        uint256 unredeemedShares =
            depositReceipt.getSharesFromReceipt(
                vaultState.round,
                roundPricePerShare[depositReceipt.round],
                vaultParams.decimals
            );

        return (balanceOf(account), unredeemedShares);
    }

    /**
     * @notice The price of a unit of share denominated in the `asset`
     */
    function pricePerShare() external view returns (uint256) {
        return
            ShareMath.pricePerShare(
                totalSupply(),
                totalBalance(),
                vaultState.totalPending,
                vaultParams.decimals
            );
    }

    /**
     * @notice Returns the vault's total balance, including the amounts locked into a short position
     * @return total balance of the vault, including the amounts locked in third party protocols
     */
    function totalBalance() public view returns (uint256) {
        return
            uint256(vaultState.lockedAmount).add(
                IERC20(vaultParams.asset).balanceOf(address(this))
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

    function totalPending() external view returns (uint256) {
        return vaultState.totalPending;
    }
}
