// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./interfaces/IAavePool.sol";
import "./interfaces/IERC20.sol";

/// @title AaveAdapter wrapper for Aave V3 supply/withdraw/borrow/repay
/// @notice All collateral (WETH) is supplied to Aave from this contract.
///         All debt (USDC) is borrowed from Aave by this contract.
///         Only the authorized pool contract can call these functions.
contract AaveAdapter {
    IAavePool public immutable aavePool;
    IERC20 public immutable weth;
    IERC20 public immutable usdc;
    address public pool; // SoftLiquidationPool address

    /// @notice Aave V3 variable rate mode
    uint256 private constant VARIABLE_RATE = 2;

    error OnlyPool();
    error NotInitialized();

    modifier onlyPool() {
        if (msg.sender != pool) revert OnlyPool();
        _;
    }

    constructor(address _aavePool, address _weth, address _usdc) {
        aavePool = IAavePool(_aavePool);
        weth = IERC20(_weth);
        usdc = IERC20(_usdc);
    }

    /// @notice Set the authorized pool contract (can only be set once)
    function initialize(address _pool) external {
        if (pool != address(0)) revert NotInitialized();
        pool = _pool;

        // Approve Aave pool to spend our tokens
        weth.approve(address(aavePool), type(uint256).max);
        usdc.approve(address(aavePool), type(uint256).max);
    }

    /// @notice Supply WETH to Aave as collateral
    /// @dev WETH must be transferred to this contract before calling
    function supply(uint256 amount) external onlyPool {
        aavePool.supply(address(weth), amount, address(this), 0);
    }

    /// @notice Withdraw WETH from Aave
    /// @param amount Amount of WETH to withdraw
    /// @param to Recipient of the withdrawn WETH
    function withdraw(uint256 amount, address to) external onlyPool returns (uint256) {
        return aavePool.withdraw(address(weth), amount, to);
    }

    /// @notice Borrow USDC from Aave against the supplied WETH collateral
    /// @param amount Amount of USDC to borrow
    /// @param to Recipient of the borrowed USDC
    function borrow(uint256 amount, address to) external onlyPool {
        aavePool.borrow(address(usdc), amount, VARIABLE_RATE, 0, address(this));
        usdc.transfer(to, amount);
    }

    /// @notice Repay USDC debt to Aave
    /// @dev USDC must be transferred to this contract before calling
    function repay(uint256 amount) external onlyPool returns (uint256) {
        return aavePool.repay(address(usdc), amount, VARIABLE_RATE, address(this));
    }
}
