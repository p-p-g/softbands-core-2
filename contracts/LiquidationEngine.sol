// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./libraries/TickMath.sol";

/// @title LiquidationEngine liquidation logic with Dutch auction pricing
/// @notice Provides helpers for tick math, auction deviation schedule, and liquidation amounts.
///         Called by SoftLiquidationPool.
contract LiquidationEngine {
    uint256 public constant PRICE_DECIMALS = 1e8;
    uint256 public constant WETH_DECIMALS = 1e18;
    uint256 public constant USDC_DECIMALS = 1e6;
    uint256 public constant BPS = 10000;

    address public owner;

    // Dutch Auction Parameters (all in BPS, 1 BPS = 0.01%)
    /// @notice Minimum |delta| to activate an auction (e.g. 100 = 1%)
    uint256 public deltaMin = 100;
    /// @notice Initial Dutch deviation (e.g. 50 = 0.5%)
    uint256 public d0 = 50;
    /// @notice Deviation ramp rate per second (e.g. 5 = 0.05%/sec)
    uint256 public rho = 5;
    /// @notice Maximum deviation cap (e.g. 500 = 5%)
    uint256 public dMax = 500;
    /// @notice Proportional fee on filled notional (e.g. 10 = 0.1%)
    uint256 public phi = 10;

    error OnlyOwner();

    event AuctionParamsUpdated(uint256 deltaMin, uint256 d0, uint256 rho, uint256 dMax, uint256 phi);

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(address _owner) {
        owner = _owner;
    }

    /// @notice Set all auction parameters at once
    function setAuctionParams(
        uint256 _deltaMin,
        uint256 _d0,
        uint256 _rho,
        uint256 _dMax,
        uint256 _phi
    ) external onlyOwner {
        deltaMin = _deltaMin;
        d0 = _d0;
        rho = _rho;
        dMax = _dMax;
        phi = _phi;
        emit AuctionParamsUpdated(_deltaMin, _d0, _rho, _dMax, _phi);
    }

    /// @notice Compute the relative discrepancy between oracle and internal price
    /// @dev delta = (oraclePrice - internalPrice) * BPS / oraclePrice
    ///      Negative delta means price dropped (internal > oracle) → sell-side rebalance
    /// @return delta Signed value in BPS
    function computeDelta(uint256 oraclePrice, uint256 internalPrice) public pure returns (int256) {
        if (oraclePrice == 0) return 0;
        return (int256(oraclePrice) - int256(internalPrice)) * int256(BPS) / int256(oraclePrice);
    }

    /// @notice Compute the current Dutch deviation based on elapsed time
    /// @dev d(t) = min(dMax, d0 + rho * elapsed)
    /// @param elapsed Seconds since auction activation
    /// @return deviation Current deviation in BPS
    function computeDeviation(uint256 elapsed) public view returns (uint256) {
        uint256 d = d0 + rho * elapsed;
        return d < dMax ? d : dMax;
    }

    /// @notice Compute the execution price for the solver/liquidator
    /// @dev For sell-side (delta < 0, price dropped):
    ///        P_exec = oraclePrice * (BPS - deviation) / BPS  (discount)
    ///      For buy-side (delta > 0):
    ///        P_exec = oraclePrice * (BPS + deviation) / BPS  (premium)
    /// @param oraclePrice Current oracle price (8 decimals)
    /// @param delta Signed discrepancy in BPS (from computeDelta)
    /// @param deviation Current Dutch deviation in BPS (from computeDeviation)
    /// @return execPrice Execution price (8 decimals)
    function computeExecutionPrice(
        uint256 oraclePrice,
        int256 delta,
        uint256 deviation
    ) public pure returns (uint256) {
        if (delta < 0) {
            // Sell-side: price dropped, offer discount to liquidator
            return oraclePrice * (BPS - deviation) / BPS;
        } else {
            // Buy-side: price rose, offer premium
            return oraclePrice * (BPS + deviation) / BPS;
        }
    }

    /// @notice Compute fee on filled notional value
    /// @param notionalUsdc USDC notional amount (6 decimals)
    /// @return fee Fee amount in USDC (6 decimals)
    function computeFee(uint256 notionalUsdc) public view returns (uint256) {
        return notionalUsdc * phi / BPS;
    }

    /// @notice Calculate how much debt the liquidator pays for a given WETH amount at execution price
    /// @param wethAmount WETH the liquidator wants to take (18 decimals)
    /// @param execPrice Execution price WETH price in USDC (8 decimals)
    /// @return debtRepaid USDC the liquidator must pay (6 decimals)
    function wethToUsdc(uint256 wethAmount, uint256 execPrice) public pure returns (uint256) {
        // debtRepaid = wethAmount * execPrice / 1e20
        // 1e20 = WETH_DECIMALS(1e18) * PRICE_DECIMALS(1e8) / USDC_DECIMALS(1e6)
        return (wethAmount * execPrice) / 1e20;
    }

    /// @notice Calculate how much WETH corresponds to a given USDC amount at execution price
    /// @param usdcAmount USDC amount (6 decimals)
    /// @param execPrice Execution price (8 decimals)
    /// @return wethAmount WETH amount (18 decimals)
    function usdcToWeth(uint256 usdcAmount, uint256 execPrice) public pure returns (uint256) {
        if (execPrice == 0) return 0;
        return (usdcAmount * 1e20) / execPrice;
    }

    /// @notice Convert oracle price (8 decimals) to Uniswap sqrtPriceX96
    function priceToSqrtPriceX96(uint256 priceOracle) public pure returns (uint160) {
        uint256 sqrtPrice = _sqrt(priceOracle);
        uint256 result = (sqrtPrice << 96) / 1e10;
        return uint160(result);
    }

    /// @notice Convert oracle price to tick (rounded down to TICK_SPACING)
    function priceToTick(uint256 priceOracle) public pure returns (int24) {
        uint160 sqrtPriceX96 = priceToSqrtPriceX96(priceOracle);
        int24 tick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);
        return TickMath.roundTickDown(tick);
    }

    /// @notice Convert tick to oracle price (8 decimals)
    function tickToPrice(int24 tick) public pure returns (uint256) {
        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(tick);
        uint256 sqrtPrice256 = uint256(sqrtPriceX96);
        uint256 priceX192 = sqrtPrice256 * sqrtPrice256;
        uint256 price = ((priceX192 >> 64) * 1e20) >> 128;
        return price;
    }

    /// @notice Check if a tick is liquidatable at the given oracle price
    function isTickLiquidatable(int24 tick, uint256 currentPrice) public pure returns (bool) {
        uint256 tickPrice = tickToPrice(tick);
        return currentPrice <= tickPrice;
    }

    /// @notice Babylonian square root
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }
}
