// SPDX-License-Identifier: MIT
pragma solidity ^0.7.3;
pragma experimental ABIEncoderV2;

import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import {GnosisAuction} from "../libraries/GnosisAuction.sol";
import {RibbonThetaVaultStorage} from "../storage/RibbonThetaVaultStorage.sol";
import {Vault} from "../libraries/Vault.sol";
import {VaultLifecycle} from "../libraries/VaultLifecycle.sol";
import {ShareMath} from "../libraries/ShareMath.sol";
import {RibbonVault} from "./base/RibbonVault.sol";

/**
 * UPGRADEABILITY: Since we use the upgradeable proxy pattern, we must observe
 * the inheritance chain closely.
 * Any changes/appends in storage variable needs to happen in RibbonThetaVaultStorage.
 * RibbonThetaVault should not inherit from any other contract aside from RibbonVault, RibbonThetaVaultStorage
 */
contract RibbonThetaVault is RibbonVault, RibbonThetaVaultStorage {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;
    using ShareMath for Vault.DepositReceipt;

    /************************************************
     *  IMMUTABLES & CONSTANTS
     ***********************************************/

    /// @notice oTokenFactory is the factory contract used to spawn otokens. Used to lookup otokens.
    address public immutable OTOKEN_FACTORY;

    // The minimum duration for an option auction.
    uint256 private constant MIN_AUCTION_DURATION = 1 hours;

    /************************************************
     *  EVENTS
     ***********************************************/

    event OpenShort(
        address indexed options,
        uint256 depositAmount,
        address indexed manager
    );

    event CloseShort(
        address indexed options,
        uint256 withdrawAmount,
        address indexed manager
    );

    event NewOptionStrikeSelected(uint256 strikePrice, uint256 delta);

    event PremiumDiscountSet(
        uint256 premiumDiscount,
        uint256 newPremiumDiscount
    );

    event AuctionDurationSet(
        uint256 auctionDuration,
        uint256 newAuctionDuration
    );

    event InstantWithdraw(
        address indexed account,
        uint256 amount,
        uint256 round
    );

    event InitiateGnosisAuction(
        address indexed auctioningToken,
        address indexed biddingToken,
        uint256 auctionCounter,
        address indexed manager
    );

    /************************************************
     *  CONSTRUCTOR & INITIALIZATION
     ***********************************************/

    /**
     * @notice Initializes the contract with immutable variables
     * @param _weth is the Wrapped Ether contract
     * @param _usdc is the USDC contract
     * @param _oTokenFactory is the contract address for minting new opyn option types (strikes, asset, expiry)
     * @param _gammaController is the contract address for opyn actions
     * @param _marginPool is the contract address for providing collateral to opyn
     * @param _gnosisEasyAuction is the contract address that facilitates gnosis auctions
     */
    constructor(
        address _weth,
        address _usdc,
        address _oTokenFactory,
        address _gammaController,
        address _marginPool,
        address _gnosisEasyAuction
    )
        RibbonVault(
            _weth,
            _usdc,
            _gammaController,
            _marginPool,
            _gnosisEasyAuction
        )
    {
        require(_oTokenFactory != address(0), "!_oTokenFactory");
        OTOKEN_FACTORY = _oTokenFactory;
    }

    /**
     * @notice Initializes the OptionVault contract with storage variables.
     * @param _owner is the owner of the vault with critical permissions
     * @param _feeRecipient is the address to recieve vault performance and management fees
     * @param _managementFee is the management fee pct.
     * @param _performanceFee is the perfomance fee pct.
     * @param _tokenName is the name of the token
     * @param _tokenSymbol is the symbol of the token
     * @param _optionsPremiumPricer is the address of the contract with the
       black-scholes premium calculation logic
     * @param _strikeSelection is the address of the contract with strike selection logic
     * @param _premiumDiscount is the vault's discount applied to the premium
     * @param _auctionDuration is the duration of the gnosis auction
     * @param _vaultParams is the struct with vault general data
     */
    function initialize(
        address _owner,
        address _feeRecipient,
        uint256 _managementFee,
        uint256 _performanceFee,
        string memory _tokenName,
        string memory _tokenSymbol,
        address _optionsPremiumPricer,
        address _strikeSelection,
        uint32 _premiumDiscount,
        uint256 _auctionDuration,
        Vault.VaultParams calldata _vaultParams
    ) external initializer {
        baseInitialize(
            _owner,
            _feeRecipient,
            _managementFee,
            _performanceFee,
            _tokenName,
            _tokenSymbol,
            _vaultParams
        );
        require(_optionsPremiumPricer != address(0), "!_optionsPremiumPricer");
        require(_strikeSelection != address(0), "!_strikeSelection");
        require(
            _premiumDiscount > 0 &&
                _premiumDiscount < 100 * Vault.PREMIUM_DISCOUNT_DECIMALS,
            "!_premiumDiscount"
        );
        require(_auctionDuration >= MIN_AUCTION_DURATION, "!_auctionDuration");
        optionsPremiumPricer = _optionsPremiumPricer;
        strikeSelection = _strikeSelection;
        premiumDiscount = _premiumDiscount;
        auctionDuration = _auctionDuration;
    }

    /************************************************
     *  SETTERS
     ***********************************************/

    /**
     * @notice Sets the new discount on premiums for options we are selling
     * @param newPremiumDiscount is the premium discount
     */
    function setPremiumDiscount(uint256 newPremiumDiscount) external onlyOwner {
        require(
            newPremiumDiscount > 0 &&
                newPremiumDiscount < 100 * Vault.PREMIUM_DISCOUNT_DECIMALS,
            "Invalid discount"
        );

        emit PremiumDiscountSet(premiumDiscount, newPremiumDiscount);

        premiumDiscount = newPremiumDiscount;
    }

    /**
     * @notice Sets the new auction duration
     * @param newAuctionDuration is the auction duration
     */
    function setAuctionDuration(uint256 newAuctionDuration) external onlyOwner {
        require(
            newAuctionDuration >= MIN_AUCTION_DURATION,
            "Invalid auction duration"
        );

        emit AuctionDurationSet(auctionDuration, newAuctionDuration);

        auctionDuration = newAuctionDuration;
    }

    /**
     * @notice Sets the new strike selection contract
     * @param newStrikeSelection is the address of the new strike selection contract
     */
    function setStrikeSelection(address newStrikeSelection) external onlyOwner {
        require(newStrikeSelection != address(0), "!newStrikeSelection");
        strikeSelection = newStrikeSelection;
    }

    /**
     * @notice Sets the new options premium pricer contract
     * @param newOptionsPremiumPricer is the address of the new strike selection contract
     */
    function setOptionsPremiumPricer(address newOptionsPremiumPricer)
        external
        onlyOwner
    {
        require(
            newOptionsPremiumPricer != address(0),
            "!newOptionsPremiumPricer"
        );
        optionsPremiumPricer = newOptionsPremiumPricer;
    }

    /**
     * @notice Optionality to set strike price manually
     * @param strikePrice is the strike price of the new oTokens (decimals = 8)
     */
    function setStrikePrice(uint128 strikePrice)
        external
        onlyOwner
        nonReentrant
    {
        require(strikePrice > 0, "!strikePrice");
        overriddenStrikePrice = strikePrice;
        lastStrikeOverride = vaultState.round;
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
     * @notice Sets the next option the vault will be shorting, and closes the existing short.
     *         This allows all the users to withdraw if the next option is malicious.
     */
    function commitAndClose() external onlyOwner nonReentrant {
        address oldOption = optionState.currentOption;

        VaultLifecycle.CloseParams memory closeParams =
            VaultLifecycle.CloseParams({
                OTOKEN_FACTORY: OTOKEN_FACTORY,
                USDC: USDC,
                currentOption: oldOption,
                delay: DELAY,
                lastStrikeOverride: lastStrikeOverride,
                overriddenStrikePrice: overriddenStrikePrice
            });

        (
            address otokenAddress,
            uint256 premium,
            uint256 strikePrice,
            uint256 delta
        ) =
            VaultLifecycle.commitAndClose(
                strikeSelection,
                optionsPremiumPricer,
                premiumDiscount,
                closeParams,
                vaultParams,
                vaultState
            );

        emit NewOptionStrikeSelected(strikePrice, delta);

        ShareMath.assertUint104(premium);
        currentOtokenPremium = uint104(premium);
        optionState.nextOption = otokenAddress;

        uint256 nextOptionReady = block.timestamp.add(DELAY);
        require(
            nextOptionReady <= type(uint32).max,
            "Overflow nextOptionReady"
        );
        optionState.nextOptionReadyAt = uint32(nextOptionReady);

        _closeShort(oldOption);
    }

    /**
     * @notice Closes the existing short position for the vault.
     */
    function _closeShort(address oldOption) private {
        optionState.currentOption = address(0);

        uint256 lockedAmount = vaultState.lockedAmount;
        vaultState.lastLockedAmount = lockedAmount > 0
            ? uint104(lockedAmount)
            : vaultState.lastLockedAmount;

        vaultState.lockedAmount = 0;

        if (oldOption != address(0)) {
            uint256 withdrawAmount =
                VaultLifecycle.settleShort(GAMMA_CONTROLLER);
            emit CloseShort(oldOption, withdrawAmount, msg.sender);
        }
    }

    /**
     * @notice Rolls the vault's funds into a new short position.
     */
    function rollToNextOption() external nonReentrant {
        (address newOption, uint256 lockedBalance) = _rollToNextOption();

        ShareMath.assertUint104(lockedBalance);
        vaultState.lockedAmount = uint104(lockedBalance);

        emit OpenShort(newOption, lockedBalance, msg.sender);

        VaultLifecycle.createShort(
            GAMMA_CONTROLLER,
            MARGIN_POOL,
            newOption,
            lockedBalance
        );

        _startAuction();
    }

    /**
     * @notice Initiate the gnosis auction.
     */
    function startAuction() external nonReentrant {
        _startAuction();
    }

    function _startAuction() private {
        GnosisAuction.AuctionDetails memory auctionDetails;

        uint256 currOtokenPremium = currentOtokenPremium;

        require(currOtokenPremium > 0, "!currentOtokenPremium");

        auctionDetails.oTokenAddress = optionState.currentOption;
        auctionDetails.gnosisEasyAuction = GNOSIS_EASY_AUCTION;
        auctionDetails.asset = vaultParams.asset;
        auctionDetails.assetDecimals = vaultParams.decimals;
        auctionDetails.oTokenPremium = currOtokenPremium;
        auctionDetails.duration = auctionDuration;

        optionAuctionID = VaultLifecycle.startAuction(auctionDetails);
    }

    /**
     * @notice Burn the remaining oTokens left over from gnosis auction.
     */
    function burnRemainingOTokens() external onlyOwner nonReentrant {
        uint256 numOTokensToBurn =
            IERC20(optionState.currentOption).balanceOf(address(this));
        require(numOTokensToBurn > 0, "!otokens");
        uint256 unlockedAssedAmount =
            VaultLifecycle.burnOtokens(GAMMA_CONTROLLER, numOTokensToBurn);
        vaultState.lockedAmount = uint104(
            uint256(vaultState.lockedAmount).sub(unlockedAssedAmount)
        );
    }
}
