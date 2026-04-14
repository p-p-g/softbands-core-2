// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IERC20.sol";

/// @title MockAavePool simplified Aave V3 pool mock for testing
/// @notice Holds WETH collateral and lends USDC. No interest accrual.
contract MockAavePool {
    mapping(address => mapping(address => uint256)) public supplied; // asset => user => amount
    mapping(address => mapping(address => uint256)) public borrowed; // asset => user => amount

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        IERC20(asset).transferFrom(msg.sender, address(this), amount);
        supplied[asset][onBehalfOf] += amount;
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        supplied[asset][msg.sender] -= amount;
        IERC20(asset).transfer(to, amount);
        return amount;
    }

    function borrow(address asset, uint256 amount, uint256, uint16, address onBehalfOf) external {
        borrowed[asset][onBehalfOf] += amount;
        IERC20(asset).transfer(msg.sender, amount);
    }

    function repay(address asset, uint256 amount, uint256, address onBehalfOf) external returns (uint256) {
        uint256 debt = borrowed[asset][onBehalfOf];
        uint256 actualRepay = amount > debt ? debt : amount;
        IERC20(asset).transferFrom(msg.sender, address(this), actualRepay);
        borrowed[asset][onBehalfOf] -= actualRepay;
        return actualRepay;
    }

    /// @notice Stub for getUserAccountData — returns debtBase=0 so
    ///         _capToSafeAaveWithdraw always returns the full requested amount.
    function getUserAccountData(address) external pure returns (
        uint256, uint256, uint256, uint256, uint256, uint256
    ) {
        return (0, 0, 0, 0, 0, 0);
    }
}
