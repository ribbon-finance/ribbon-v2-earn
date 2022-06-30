// SPDX-License-Identifier: MIT
pragma solidity =0.8.4;

import {VaultLifecycleEarn} from "../libraries/VaultLifecycleEarn.sol";
import {Vault} from "../libraries/Vault.sol";

contract TestVaultLifecycleEarn {
    Vault.VaultState public vaultState;

    function balanceOf(address account) public view returns (uint256) {
        if (account == address(this)) {
            return 1 ether;
        }
        return 0;
    }

    function setVaultState(Vault.VaultState calldata newVaultState) public {
        vaultState.totalPending = newVaultState.totalPending;
        vaultState.queuedWithdrawShares = newVaultState.queuedWithdrawShares;
    }

    function rollover(VaultLifecycleEarn.RolloverParams calldata params)
        external
        view
        returns (
            uint256 newLockedAmount,
            uint256 queuedWithdrawAmount,
            uint256 newPricePerShare,
            uint256 mintShares,
            uint256 performanceFeeInAsset,
            uint256 totalVaultFee
        )
    {
        return VaultLifecycleEarn.rollover(vaultState, params);
    }
}
