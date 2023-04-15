// SPDX-License-Identifier: MIT
pragma solidity =0.8.4;

contract MockAggregator {
    int256 public price;
    uint8 public decimals;

    constructor(uint8 _decimals, int256 _price) {
        decimals = _decimals;
        price = _price;
    }

    function latestAnswer() external view returns (int256){
      return price;
    }
}
