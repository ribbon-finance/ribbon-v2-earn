// SPDX-License-Identifier: MIT
pragma solidity =0.8.4;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vault} from "../libraries/Vault.sol";

contract MockRibbonVault {
    Vault.VaultParams public vaultParams;

    function setAsset(address asset) external {
        vaultParams.asset = asset;
    }
}
