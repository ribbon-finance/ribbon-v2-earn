// SPDX-License-Identifier: MIT
pragma solidity =0.8.4;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMM {
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

    function pendingSettledAssetAmount(address _product)
        external
        view
        returns (uint256);

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
