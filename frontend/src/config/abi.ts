export const POOL_ABI = [
  "function deposit(uint256 wethAmount, uint256 usdcBorrow, int24 upperTick, int24 lowerTick) external returns (uint256)",
  "function closePosition(uint256 positionId) external",
  "function repay(uint256 positionId, uint256 usdcAmount) external",
  "function rebalance(uint256 wethWanted, uint256 maxUsdcCost) external returns (uint256 totalDebtPaid, uint256 totalCollateralSent, uint256 totalFee)",
  "function positions(uint256) view returns (address owner, int24 upperTick, int24 lowerTick, uint256 collateral, uint256 debt, bool active)",
  "function getPositionState(uint256 positionId) view returns (uint256 remainingDebt, uint256 remainingCollateral)",
  "function getUserPositions(address user) view returns (uint256[])",
  "function isTickLiquidatable(int24 tick) view returns (bool)",
  "function getActiveTickCount(uint256 positionId) view returns (uint256)",
  "function tickData(int24) view returns (uint256 totalCollateral, uint256 totalDebt, uint256 totalShares, bool liquidated, uint256 generation)",
  "function nextPositionId() view returns (uint256)",
  "function TICK_SPACING() view returns (int24)",
  "function lastRebalancePrice() view returns (uint256)",
  "function lastRebalanceTime() view returns (uint256)",
  "function feeRecipient() view returns (address)",
  "function getAuctionState() view returns (int256 delta, uint256 deviation, uint256 execPrice, bool active)",
  "event PositionOpened(uint256 indexed positionId, address indexed owner, uint256 collateral, uint256 debt, int24 upperTick, int24 lowerTick)",
  "event PositionClosed(uint256 indexed positionId, address indexed owner)",
  "event TickLiquidated(int24 indexed tick, address indexed liquidator, uint256 debtRepaid, uint256 collateralSent)",
  "event Rebalanced(address indexed liquidator, uint256 totalDebtRepaid, uint256 totalCollateralSent, uint256 fee, uint256 execPrice, uint256 ticksProcessed)",
  "event DebtRepaid(uint256 indexed positionId, uint256 amount)",
  "function aaveAdapter() view returns (address)",
];

export const ORACLE_ABI = [
  "function getPrice() view returns (uint256)",
  "function getLatestPrice() view returns (uint256)",
  "function setPrice(uint256 price) external",
  "function setTwapWindow(uint256 window) external",
  "function twapWindow() view returns (uint256)",
  "function owner() view returns (address)",
  "function useChainlink() view returns (bool)",
  "function manualOverrideExpiry() view returns (uint256)",
  "function setChainlinkFeed(address feed) external",
  "function disableChainlink() external",
  "function clearManualOverride() external",
];

export const AAVE_POOL_ABI = [
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
];

export const ENGINE_ABI = [
  "function priceToTick(uint256 priceOracle) view returns (int24)",
  "function tickToPrice(int24 tick) view returns (uint256)",
  "function isTickLiquidatable(int24 tick, uint256 currentPrice) pure returns (bool)",
  "function wethToUsdc(uint256 wethAmount, uint256 execPrice) pure returns (uint256)",
  "function usdcToWeth(uint256 usdcAmount, uint256 execPrice) pure returns (uint256)",
  "function computeDelta(uint256 oraclePrice, uint256 internalPrice) pure returns (int256)",
  "function computeDeviation(uint256 elapsed) view returns (uint256)",
  "function computeExecutionPrice(uint256 oraclePrice, int256 delta, uint256 deviation) pure returns (uint256)",
  "function computeFee(uint256 notionalUsdc) view returns (uint256)",
  "function deltaMin() view returns (uint256)",
  "function d0() view returns (uint256)",
  "function rho() view returns (uint256)",
  "function dMax() view returns (uint256)",
  "function phi() view returns (uint256)",
  "function PRICE_DECIMALS() view returns (uint256)",
];

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function mint(address to, uint256 amount) external",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];
