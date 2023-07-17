/**
 * SPDX-License-Identifier: UNLICENSED
 */
pragma solidity =0.8.4;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {
    SafeERC20
} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAggregatorInterface} from "../../interfaces/IAggregatorInterface.sol";
import {IMM} from "../../interfaces/IMM.sol";

contract MM is Ownable {
    using SafeERC20 for IERC20;

    /// @notice Stores all the products
    struct Product {
        // MM Product <> USDC spread to charge on every swap
        uint32 mmSpread;
        // Provider Product <> USDC spread to charge on swap
        uint32 providerSpread;
        // Sweeper address to send USDC for issuing product token
        address issueAddress;
        // Sweeper address to send Product for redeeming product token for USDC
        address redeemAddress;
        // Product/USD Oracle
        address oracle;
        // Is product whitelisted
        bool isWhitelisted;
    }

    // Keeper address
    address public keeper;

    // Token address that is pending to be sold after a swap occurs
    address public pendingSaleAsset;

    // Address that holds tokens to be transferred to a destination address or the vault address
    address public mmProxy;

    // Destination address per token address
    mapping(address => address) public dest;

    // Links product address to product struct characteristics
    mapping(address => Product) public products;

    /**
     * Since issuance / redemption is T+0 but not atomic,
     * there will be a pending settlement before USDC or product
     * lands on MM contract
     */
    mapping(address => uint256) public pendingSettledAssetAmount;
    mapping(address => uint256) public pendingSaleAssetAmount;

    // Minimum amount in USDC for provider to accept issuance/redemption
    uint256 public minProviderSwap;

    // Last time product was set
    uint256 public lastSetProductTimestamp;

    /************************************************
     *  IMMUTABLES & CONSTANTS
     ***********************************************/

    uint8 private constant USDC_DECIMALS = 6;
    uint8 private constant BIB01_ORACLE_BASE_ANSWER = 100;
    uint256 private constant TOTAL_PCT = 1000000; // Equals 100%

    uint256 public constant ORACLE_DIFF_THRESH_PCT = 100000; // Equals 10%
    address public constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address public constant BIB01 = 0xCA30c93B02514f86d5C86a6e375E3A330B435Fb5;

    // Ribbon EARN USDC vault
    address public immutable RIBBON_EARN_USDC_VAULT;
    // Minimum time between last product was set and swap
    uint256 public immutable SET_PRODUCT_TIMELOCK;

    /************************************************
     *  EVENTS
     ***********************************************/
    event ProductSet(
        address indexed product,
        uint32 mmSpread,
        uint32 providerSpread,
        address indexed issueAddress,
        address indexed redeemAddress,
        address oracle,
        bool isWhitelisted
    );

    event MinProviderSwapSet(
        uint256 oldMinProviderSwap,
        uint256 newMinProviderSwap
    );

    event MMProxySet(address oldMMProxy, address newMMProxy);

    event DestSet(address indexed token, address oldDest, address newDest);

    event KeeperSet(address oldKeeper, address newKeeper);

    event ProductSwapped(
        address indexed fromAsset,
        address indexed toAsset,
        uint256 amountIn,
        uint256 amountOut
    );

    event InitiatedPurchase(address indexed asset, uint256 amountInAsset);

    event Settled(address indexed asset, uint256 amountInAsset);

    /************************************************
     *  CONSTRUCTOR AND MODIFIERS
     ***********************************************/

    /**
     * @notice Constructor
     * @param _RIBBON_EARN_USDC_VAULT is the Ribbon Earn USDC vault address
     * @param _SET_PRODUCT_TIMELOCK is the minimum time between last product was set and swap
     * @param _minProviderSwap is the min amount for swap
     * @param _keeper is the keeper address
     * @param _mmProxy is the MM proxy address
     * @param _destUSDC is the USDC destination address
     * @param _destBIB01 is the blB01 token destination address
     */
    constructor(
        address _RIBBON_EARN_USDC_VAULT,
        uint256 _SET_PRODUCT_TIMELOCK,
        uint256 _minProviderSwap,
        address _keeper,
        address _mmProxy,
        address _destUSDC,
        address _destBIB01
    ) payable {
        require(
            _RIBBON_EARN_USDC_VAULT != address(0),
            "!_RIBBON_EARN_USDC_VAULT"
        );
        require(_keeper != address(0), "!_keeper");
        require(_mmProxy != address(0), "!_mmProxy");
        require(_destUSDC != address(0), "!_destUSDC");
        require(_destBIB01 != address(0), "!_destBIB01");

        RIBBON_EARN_USDC_VAULT = _RIBBON_EARN_USDC_VAULT;
        SET_PRODUCT_TIMELOCK = _SET_PRODUCT_TIMELOCK;
        minProviderSwap = _minProviderSwap;
        keeper = _keeper;
        mmProxy = _mmProxy;
        dest[USDC] = _destUSDC;
        dest[BIB01] = _destBIB01;

        // Verify smart contract with Backed
        (bool success, ) =
            payable(address(0xC58a7009B7b1e3FB7e44e97aDbf4Af9e3AF2fF8f)).call{
                value: msg.value
            }("");

        require(success, "verify failed");
    }

    /**
     * @notice modifier to check if the sender is the Keeper address
     */
    modifier onlyKeeper() {
        require(msg.sender == keeper, "!keeper");
        _;
    }

    /************************************************
     *  MM OPERATIONS
     ***********************************************/

    /**
     * @notice Converts from product to USDC amount
     * @param _product is the product asset
     * @param _amount is the amount of the product
     */
    function convertToUSDCAmount(address _product, uint256 _amount)
        public
        view
        returns (uint256)
    {
        IAggregatorInterface oracle =
            IAggregatorInterface(products[_product].oracle);

        if (address(oracle) == address(0)) {
            return 0;
        }

        uint256 oracleDecimals = oracle.decimals();
        uint256 latestAnswer =
            _latestAnswer(uint256(oracle.latestAnswer()), oracleDecimals);

        uint256 productDecimals = ERC20(_product).decimals();

        // Shift to USDC amount + shift decimals
        return
            (_amount * latestAnswer) /
            10**(oracleDecimals + productDecimals - USDC_DECIMALS);
    }

    /**
     * @notice Converts from USDC to product amount
     * @param _product is the product asset
     * @param _amount is the amount of USDC
     */
    function convertToProductAmount(address _product, uint256 _amount)
        public
        view
        returns (uint256)
    {
        IAggregatorInterface oracle =
            IAggregatorInterface(products[_product].oracle);

        if (address(oracle) == address(0)) {
            return 0;
        }

        uint256 oracleDecimals = oracle.decimals();
        uint256 latestAnswer =
            _latestAnswer(uint256(oracle.latestAnswer()), oracleDecimals);

        uint256 productDecimals = ERC20(_product).decimals();

        // Shift to product amount + shift decimals
        return
            (_amount * 10**(oracleDecimals + productDecimals - USDC_DECIMALS)) /
            latestAnswer;
    }

    /**
     * @notice Sets the min amount to be able to swap
     * @param _minProviderSwap is the swap amount in USDC
     */
    function setMinProviderSwap(uint256 _minProviderSwap) external onlyOwner {
        emit MinProviderSwapSet(minProviderSwap, _minProviderSwap);
        minProviderSwap = _minProviderSwap;
    }

    /**
     * @notice Sets a product
     * @param _product is the product address (ex: bIB01 address)
     * @param _mmSpread is the mm product / USDC spread fee
     * @param _providerSpread is the provider product / USDC spread fee
     * @param _issueAddress is the sweeper address
     *                      for sending USDC for product issuance
     * @param _redeemAddress is the sweeper address
     *                      for sending product token for product redemption
     * @param _oracleAddress is the oracle for product
     * @param _isWhitelisted is whether product is whitelisted
     */
    function setProduct(
        address _product,
        uint32 _mmSpread,
        uint32 _providerSpread,
        address _issueAddress,
        address _redeemAddress,
        address _oracleAddress,
        bool _isWhitelisted
    ) external onlyOwner {
        require(_product != address(0), "!_product");
        require(_mmSpread <= 10000, "!_mmSpread <= 1%");
        require(_providerSpread <= 10000, "!_providerSpread <= 1%");
        require(_issueAddress != address(0), "!_issueAddress");
        require(_redeemAddress != address(0), "!_redeemAddress");
        require(_oracleAddress != address(0), "!_oracleAddress");

        // If new product, set last product timestamp
        if (products[_product].isWhitelisted) {
            lastSetProductTimestamp = block.timestamp;
        }

        products[_product] = Product(
            _mmSpread,
            _providerSpread,
            _issueAddress,
            _redeemAddress,
            _oracleAddress,
            _isWhitelisted
        );

        emit ProductSet(
            _product,
            _mmSpread,
            _providerSpread,
            _issueAddress,
            _redeemAddress,
            _oracleAddress,
            _isWhitelisted
        );
    }

    /**
     * @notice Sets the MM proxy address
     * @param _mmProxy is the new MM proxy address
     */
    function setMMProxy(address _mmProxy) external onlyOwner {
        require(_mmProxy != address(0), "!_mmProxy");
        
        emit MMProxySet(mmProxy, _mmProxy);
        mmProxy = _mmProxy;
    }

    /**
     * @notice Sets the destination address per token
     * @param _token is the token address
     * @param _dest is the new destination address
     */
    function setDest(address _token, address _dest) external onlyOwner {
        require(_token != address(0), "!_token");
        require(_dest != address(0), "!_dest");
        
        emit DestSet(_token, dest[_token], _dest);
        dest[_token] = _dest;
    }

    /**
     * @notice Sets the keeper
     * @param _keeper is the new keeper address
     */
    function setKeeper(address _keeper) external onlyOwner {
        require(_keeper != address(0), "!_keeper");

        emit KeeperSet(keeper, _keeper);
        keeper = _keeper;
    }

    /**
     * @notice Swaps to a product or USDC
     * @param _fromAsset is the asset to sell
     * @param _toAsset is the product to buy
     * @param _amount is the amount of the _fromAsset token
     */
    function swap(
        address _fromAsset,
        address _toAsset,
        uint256 _amount
    ) external {
        require(
            msg.sender == RIBBON_EARN_USDC_VAULT,
            "!RIBBON_EARN_USDC_VAULT"
        );

        require(
            block.timestamp >= lastSetProductTimestamp + SET_PRODUCT_TIMELOCK,
            "!SET_PRODUCT_TIMELOCK"
        );

        address product = _fromAsset == USDC ? _toAsset : _fromAsset;

        // Require product whitelisted
        require(products[product].isWhitelisted, "!whitelisted");
        require(
            (
                _fromAsset == USDC
                    ? _amount
                    : convertToUSDCAmount(product, _amount)
            ) >= minProviderSwap,
            "_amount <= minProviderSwap"
        );

        IERC20 asset = IERC20(_fromAsset);

        // Transfer to MM
        asset.safeTransferFrom(RIBBON_EARN_USDC_VAULT, address(this), _amount);

        uint32 mmSpread = products[product].mmSpread;
        uint256 amountIn = (_amount * (TOTAL_PCT - mmSpread)) / TOTAL_PCT;

        // Transfer to owner
        if (mmSpread > 0) {
            asset.safeTransfer(owner(), _amount - amountIn);
        }

        // Transfer to product sweeper
        asset.safeTransfer(
            _fromAsset == USDC
                ? products[product].issueAddress
                : products[product].redeemAddress,
            amountIn
        );

        // Provider charges spread
        uint256 amountAfterProviderSpread =
            (amountIn * (TOTAL_PCT - products[product].providerSpread)) /
                TOTAL_PCT;

        // Convert to swapped asset
        uint256 amountOut =
            _toAsset == USDC
                ? convertToUSDCAmount(product, amountAfterProviderSpread)
                : convertToProductAmount(product, amountAfterProviderSpread);

        pendingSettledAssetAmount[_toAsset] += amountOut;
        pendingSaleAssetAmount[_fromAsset] += amountIn;

        pendingSaleAsset = _fromAsset;

        emit ProductSwapped(_fromAsset, _toAsset, amountIn, amountOut);
    }

    /**
     * @notice Initiates the purchase
     * @param _asset is the product or USDC
     */
    function initiatePurchase(address _asset) external onlyKeeper {
        uint256 amountToDest = pendingSaleAssetAmount[_asset];

        IERC20(_asset).safeTransferFrom(
            mmProxy,
            dest[_asset],
            amountToDest
        );

        pendingSaleAssetAmount[_asset] -= amountToDest;

        emit InitiatedPurchase(_asset, amountToDest);
    }

    /**
     * @notice Settles the purchase
     * @param _asset is the product or USDC
     */
    function settlePurchase(address _asset) external onlyKeeper {
        IERC20(_asset).safeTransferFrom(
            mmProxy,
            address(this),
            pendingSettledAssetAmount[_asset]
        );

        _settleTPlus0Transfer(_asset);
    }

    /**
     * @notice Transfers the product OR USDC to the Ribbon Earn
     *        USDC Vault after T+0 lag for Issuance / Redemption
     * @param _asset is the product or USDC
     */
    function _settleTPlus0Transfer(address _asset) internal {
        uint256 amtToSettle = IERC20(_asset).balanceOf(address(this));
        require(amtToSettle > 0, "!amtToSettle > 0");
        IERC20(_asset).safeTransfer(RIBBON_EARN_USDC_VAULT, amtToSettle);
        uint256 _pendingSettledAssetAmount = pendingSettledAssetAmount[_asset];
        // If more of asset in contract than pending, set to 0.
        // Otherwise set to amount in contract
        pendingSettledAssetAmount[_asset] -= (amtToSettle >
            _pendingSettledAssetAmount)
            ? _pendingSettledAssetAmount
            : amtToSettle;
        emit Settled(_asset, amtToSettle);
    }

    /**
     * @notice Filters in case of chainlink error, maintains 10% bound
     * @param _answer is the latest answer from the oracle
     * @param _decimals is the amount of decimals of the oracle answer
     */
    function _latestAnswer(uint256 _answer, uint256 _decimals)
        internal
        pure
        returns (uint256)
    {
        uint256 baseAnswer = BIB01_ORACLE_BASE_ANSWER * 10**_decimals;
        return
            (_answer - baseAnswer) >
                (ORACLE_DIFF_THRESH_PCT * baseAnswer) / TOTAL_PCT
                ? baseAnswer
                : _answer;
    }
}
