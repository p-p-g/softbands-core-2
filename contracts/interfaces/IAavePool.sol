// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal interface for Aave V3 Pool
interface IAavePool {
    /// @notice Supplies an amount of asset into the pool
    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 referralCode
    ) external;

    /// @notice Withdraws an amount of asset from the pool
    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external returns (uint256);

    /// @notice Borrows an amount of asset with variable rate
    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        uint16 referralCode,
        address onBehalfOf
    ) external;

    /// @notice Repays a borrowed amount on a specific reserve
    function repay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external returns (uint256);
}
