// SPDX-License-Identifier: MIT
pragma solidity =0.8.4;

abstract contract RibbonEarnVaultStorageV1 {
  // Amount locked for scheduled withdrawals last week;
  uint256 public lastQueuedWithdrawAmount;
  // Queued withdraw shares for the current round
  uint256 public currentQueuedWithdrawShares;
  // Vault Pauser Contract for the vault
  address public vaultPauser;
  // LiquidityGauge contract for the vault
  address public liquidityGauge;
}

// We are following Compound's method of upgrading new contract implementations
// When we need to add new storage variables, we create a new version of RibbonEarnVaultStorage
// e.g. RibbonEarnVaultStorage<versionNumber>, so finally it would look like
// contract RibbonEarnVaultStorage is RibbonEarnVaultStorageV1, RibbonEarnVaultStorageV2
abstract contract RibbonEarnVaultStorage is
    RibbonEarnVaultStorageV1
{

}
