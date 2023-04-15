// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMM {
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

    function products(address _product)
        external
        view
        returns (
            uint32,
            uint32,
            uint256,
            address,
            address,
            address,
            bool
        );

    function convertToUSDCPrice(address _product, uint256 _amount)
        external
        view
        returns (uint256);

    function convertToProductPrice(address _product, uint256 _amount)
        external
        view
        returns (uint256);

    function setProduct(
        address _product,
        uint32 _mmSpread,
        uint32 _providerSpread,
        uint256 _minProviderSwap,
        address _issueAddress,
        address _redeemAddress,
        address _oracle,
        bool _isWhitelisted
    ) external;

    function swap(
        address _fromAsset,
        address _toAsset,
        uint256 _amount
    ) external;

    function settleTPlus0Transfer(address _asset) external;
}
