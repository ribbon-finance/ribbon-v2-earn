/**
 * SPDX-License-Identifier: UNLICENSED
 */
pragma solidity 0.8.10;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    SafeERC20
} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract MM is Ownable {
    using SafeERC20 for IERC20;

    /// @notice Stores all the products
    struct Product {
        // Spread to charge on swap
        uint16 spread;
        // Sweeper address for issuing product token
        address issueAddress;
        // Sweeper address for redeeming product token
        address redeemAddress;
        // Is product whitelisted
        bool isWhitelisted;
    }

    mapping(address => Product) public products;

    /************************************************
     *  IMMUTABLES & CONSTANTS
     ***********************************************/

    uint256 public constant SPREAD_TOTAL_PCT = 1000000; // Equals 100%
    address public constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    // Ribbon EARN USDC vault
    address public constant RIBBON_EARN_USDC_VAULT =
        0x84c2b16FA6877a8fF4F3271db7ea837233DFd6f0;

    /************************************************
     *  EVENTS
     ***********************************************/

    event ProductSet(
        address indexed product,
        uint16 spread,
        address indexed issueAddress,
        address indexed redeemAddress,
        bool isWhitelisted
    );
    event ProductSwapped(
        address indexed fromAsset,
        address indexed toAsset,
        uint256 amountInFromAsset
    );
    event Claimed(address indexed asset, uint256 amountInAsset);

    /**
     * @notice Sets a product
     * @param _product is the product address (ex: bIB01 address)
     * @param _spread is the product / USDC spread fee
     * @param _issueAddress is the sweeper address
     *                      for sending USDC for product issuance
     * @param _redeemAddress is the sweeper address
     *                      for sending product token for product redemption
     * @param _isWhitelisted is the whitelist of product
     */
    function setProduct(
        address _product,
        uint16 _spread,
        address _issueAddress,
        address _redeemAddress,
        bool _isWhitelisted
    ) external onlyOwner {
        require(_product != address(0), "!_product");
        require(_spread <= 10000, "! _spread <= 1%");
        require(_issueAddress != address(0), "!_issueAddress");
        require(_redeemAddress != address(0), "!_redeemAddress");

        products[_product] = Product(
            _spread,
            _issueAddress,
            _redeemAddress,
            _isWhitelisted
        );

        emit ProductSet(
            _product,
            _spread,
            _issueAddress,
            _redeemAddress,
            _isWhitelisted
        );
    }

    /**
     * @notice Buys a product
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

        uint16 spread = products[product].spread;
        uint256 amountAfterSpread =
            (_amount * (SPREAD_TOTAL_PCT - spread)) / SPREAD_TOTAL_PCT;

        IERC20 asset = IERC20(_fromAsset);

        // Transfer to MM
        asset.transferFrom(RIBBON_EARN_USDC_VAULT, address(this), _amount);
        // Transfer to product sweeper
        asset.transfer(
            _fromAsset == USDC
                ? products[product].issueAddress
                : products[product].redeemAddress,
            amountAfterSpread
        );
        // Transfer fees
        if (spread > 0) {
            asset.transfer(owner(), (_amount * spread) / SPREAD_TOTAL_PCT);
        }

        emit ProductSwapped(_fromAsset, _toAsset, amountAfterSpread);
    }

    /**
     * @notice Claims the product OR USDC to the Ribbon Earn
     *        USDC Vault after T+0 lag for Issuance / Redemption
     * @param _assetToken is the product or USDC token
     */
    function claimTPlus0SettlementTransfer(IERC20 _assetToken) external {
        uint256 amtToClaim = _assetToken.balanceOf(address(this));
        _assetToken.transfer(RIBBON_EARN_USDC_VAULT, amtToClaim);
        emit Claimed(address(_assetToken), amtToClaim);
    }
}
