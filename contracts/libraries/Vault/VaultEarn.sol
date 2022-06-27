// SPDX-License-Identifier: MIT
pragma solidity =0.8.4;

library VaultEarn {
    struct VaultParams {
        // Token decimals for vault shares
        uint8 decimals;
        // Asset used in vault
        address asset;
        // Minimum supply of the vault shares issued, for ETH it's 10**10
        uint56 minimumSupply;
        // Vault cap
        uint104 cap;
    }
}
