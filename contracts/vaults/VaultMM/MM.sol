/**
 * SPDX-License-Identifier: UNLICENSED
 */
pragma solidity =0.8.4;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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
        // MM spread to charge on swap
        uint32 mmSpread;
        // Provider spread to charge on swap
        uint32 providerSpread;
        // Minimum amount for issuance/redemption
        uint256 minProviderSwap;
        // Sweeper address for issuing product token
        address issueAddress;
        // Sweeper address for redeeming product token
        address redeemAddress;
        // Oracle for product
        address oracle;
        // Is product whitelisted
        bool isWhitelisted;
    }

    mapping(address => Product) public products;

    /**
     * Since issuance / redemption is T+0 but not atomic,
     * there will be a pending settlement before USDC or product
     * lands on MM contract
     */
    mapping(address => uint256) public pendingSettledAssetAmount;

    /************************************************
     *  IMMUTABLES & CONSTANTS
     ***********************************************/

    uint256 public constant TOTAL_PCT = 1000000; // Equals 100%
    address public constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    // Ribbon EARN USDC vault
    address public constant RIBBON_EARN_USDC_VAULT =
        0x84c2b16FA6877a8fF4F3271db7ea837233DFd6f0;

    /************************************************
     *  EVENTS
     ***********************************************/
    event ProductSet(
        address indexed product,
        uint32 mmSpread,
        uint32 providerSpread,
        uint256 minProviderSwap,
        address indexed issueAddress,
        address indexed redeemAddress,
        address oracle,
        bool isWhitelisted
    );
    event ProductSwapped(
        address indexed fromAsset,
        address indexed toAsset,
        uint256 amountIn,
        uint256 amountOut
    );
    event Settled(address indexed asset, uint256 amountInAsset);

    /**
     * @notice Converts from product to USDC
     * @param _product is the product asset
     * @param _amount is the amount of the product
     */
    function convertToUSDCPrice(address _product, uint256 _amount)
        public
        view
        returns (uint256)
    {
        IAggregatorInterface oracle =
            IAggregatorInterface(products[_product].oracle);
        uint256 latestAnswer = uint256(oracle.latestAnswer());
        uint256 decimals = oracle.decimals();

        return (_amount * latestAnswer) / 10**decimals;
    }

    /**
     * @notice Converts from USDC to product
     * @param _product is the product asset
     * @param _amount is the amount of USDC
     */
    function convertToProductPrice(address _product, uint256 _amount)
        public
        view
        returns (uint256)
    {
        IAggregatorInterface oracle =
            IAggregatorInterface(products[_product].oracle);
        uint256 latestAnswer = uint256(oracle.latestAnswer());
        uint256 decimals = oracle.decimals();

        return (_amount * 10**decimals) / latestAnswer;
    }

    /**
     * @notice Sets a product
     * @param _product is the product address (ex: bIB01 address)
     * @param _mmSpread is the mm product / USDC spread fee
     * @param _providerSpread is the provider product / USDC spread fee
     * @param _minProviderSwap is the minimum provider amount to faciliate issuance/redemption
     * @param _issueAddress is the sweeper address
     *                      for sending USDC for product issuance
     * @param _redeemAddress is the sweeper address
     *                      for sending product token for product redemption
     * @param _oracle is the oracle for product
     * @param _isWhitelisted is whether product is whitelisted
     */
    function setProduct(
        address _product,
        uint32 _mmSpread,
        uint32 _providerSpread,
        uint256 _minProviderSwap,
        address _issueAddress,
        address _redeemAddress,
        address _oracle,
        bool _isWhitelisted
    ) external onlyOwner {
        require(_product != address(0), "!_product");
        require(_mmSpread <= 10000, "! _mmSpread <= 1%");
        require(_providerSpread <= 10000, "! _providerSpread <= 1%");
        require(_issueAddress != address(0), "!_issueAddress");
        require(_redeemAddress != address(0), "!_redeemAddress");
        require(_oracle != address(0), "!_oracle");

        products[_product] = Product(
            _mmSpread,
            _providerSpread,
            _minProviderSwap,
            _issueAddress,
            _redeemAddress,
            _oracle,
            _isWhitelisted
        );

        emit ProductSet(
            _product,
            _mmSpread,
            _providerSpread,
            _minProviderSwap,
            _issueAddress,
            _redeemAddress,
            _oracle,
            _isWhitelisted
        );
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

        address product = _fromAsset == USDC ? _toAsset : _fromAsset;

        // Either selling product or is whitelisted
        require(
            _toAsset == USDC || products[product].isWhitelisted,
            "!whitelisted"
        );

        uint32 mmSpread = products[product].mmSpread;
        uint256 amountIn = (_amount * (TOTAL_PCT - mmSpread)) / TOTAL_PCT;

        IERC20 asset = IERC20(_fromAsset);

        // Transfer to MM
        asset.transferFrom(RIBBON_EARN_USDC_VAULT, address(this), _amount);
        // Transfer to product sweeper
        asset.transfer(
            _fromAsset == USDC
                ? products[product].issueAddress
                : products[product].redeemAddress,
            amountIn
        );
        // Transfer fees
        if (mmSpread > 0) {
            asset.transfer(owner(), (_amount * mmSpread) / TOTAL_PCT);
        }

        // Provider charges spread
        uint256 amountAfterProviderSpread =
            (amountIn * (TOTAL_PCT - products[product].providerSpread)) /
                TOTAL_PCT;

        // Convert to swapped asset
        uint256 amountOut =
            _toAsset == USDC
                ? convertToUSDCPrice(product, amountAfterProviderSpread)
                : convertToProductPrice(product, amountAfterProviderSpread);

        pendingSettledAssetAmount[_toAsset] += amountOut;

        emit ProductSwapped(_fromAsset, _toAsset, amountIn, amountOut);
    }

    /**
     * @notice Transfers the product OR USDC to the Ribbon Earn
     *        USDC Vault after T+0 lag for Issuance / Redemption
     * @param _asset is the product or USDC
     */
    function settleTPlus0Transfer(address _asset) external {
        uint256 amtToClaim = IERC20(_asset).balanceOf(address(this));
        IERC20(_asset).transfer(RIBBON_EARN_USDC_VAULT, amtToClaim);
        uint256 _pendingSettledAssetAmount = pendingSettledAssetAmount[_asset];
        // If more of asset in contract than pending, set to 0.
        // Otherwise set to amount in contract
        pendingSettledAssetAmount[_asset] -= (amtToClaim >
            _pendingSettledAssetAmount)
            ? _pendingSettledAssetAmount
            : amtToClaim;
        emit Settled(_asset, amtToClaim);
    }
}
