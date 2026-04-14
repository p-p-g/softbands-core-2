import { network } from "hardhat";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Mainnet addresses ──────────────────────────────────────────────
const MAINNET = {
  AAVE_POOL: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  CHAINLINK_ETH_USD: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  aWETH: "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8",
  WETH_WHALE: "0xF04a5cC80B1E94C69B48f5ee68a08CD2F09A7c3E",
  USDC_WHALE: "0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341",
};

// Connect to localhost (forked hardhat node) or in-memory fork
const networkName = process.env.DEPLOY_NETWORK || "localhost";
const { ethers } = await network.connect(networkName);
console.log("Connected to network:", networkName);

const [deployer] = await ethers.getSigners();
console.log("Deployer:", deployer.address);

// ─── Get real token contracts ────────────────────────────────────────
const weth = await ethers.getContractAt(
  ["function balanceOf(address) view returns (uint256)",
   "function approve(address,uint256) returns (bool)",
   "function transfer(address,uint256) returns (bool)",
   "function deposit() payable"],
  MAINNET.WETH
);

const usdc = await ethers.getContractAt(
  ["function balanceOf(address) view returns (uint256)",
   "function approve(address,uint256) returns (bool)",
   "function transfer(address,uint256) returns (bool)"],
  MAINNET.USDC
);

// ─── Fund deployer with WETH and USDC via whale impersonation ────────
console.log("\nFunding deployer via whale impersonation...");

// Fund deployer with ETH for gas (use hardhat's setBalance)
await ethers.provider.send("hardhat_setBalance", [
  deployer.address,
  "0x56BC75E2D63100000", // 100 ETH
]);

// Impersonate WETH whale
await ethers.provider.send("hardhat_impersonateAccount", [MAINNET.WETH_WHALE]);
await ethers.provider.send("hardhat_setBalance", [MAINNET.WETH_WHALE, "0xDE0B6B3A7640000"]);
const wethWhale = await ethers.getSigner(MAINNET.WETH_WHALE);

const wethWhaleBalance = await weth.balanceOf(MAINNET.WETH_WHALE);
console.log("WETH whale balance:", ethers.formatEther(wethWhaleBalance), "WETH");

const wethToSend = ethers.parseEther("100");
if (wethWhaleBalance >= wethToSend) {
  await weth.connect(wethWhale).transfer(deployer.address, wethToSend);
  console.log("Sent 100 WETH to deployer");
} else {
  // Fallback: wrap ETH
  console.log("WETH whale balance insufficient, wrapping ETH instead...");
  await deployer.sendTransaction({
    to: MAINNET.WETH,
    value: wethToSend,
  });
  console.log("Wrapped 100 ETH -> WETH");
}
await ethers.provider.send("hardhat_stopImpersonatingAccount", [MAINNET.WETH_WHALE]);

// Impersonate USDC whale
await ethers.provider.send("hardhat_impersonateAccount", [MAINNET.USDC_WHALE]);
await ethers.provider.send("hardhat_setBalance", [MAINNET.USDC_WHALE, "0xDE0B6B3A7640000"]);
const usdcWhale = await ethers.getSigner(MAINNET.USDC_WHALE);

const usdcWhaleBalance = await usdc.balanceOf(MAINNET.USDC_WHALE);
console.log("USDC whale balance:", ethers.formatUnits(usdcWhaleBalance, 6), "USDC");

const usdcToSend = ethers.parseUnits("1000000", 6); // 1M USDC
if (usdcWhaleBalance >= usdcToSend) {
  await usdc.connect(usdcWhale).transfer(deployer.address, usdcToSend);
  console.log("Sent 1M USDC to deployer");
} else {
  console.log("WARNING: USDC whale balance insufficient. Got:", ethers.formatUnits(usdcWhaleBalance, 6));
  if (usdcWhaleBalance > 0n) {
    await usdc.connect(usdcWhale).transfer(deployer.address, usdcWhaleBalance);
    console.log("Sent all available USDC:", ethers.formatUnits(usdcWhaleBalance, 6));
  }
}
await ethers.provider.send("hardhat_stopImpersonatingAccount", [MAINNET.USDC_WHALE]);

console.log("Deployer WETH:", ethers.formatEther(await weth.balanceOf(deployer.address)));
console.log("Deployer USDC:", ethers.formatUnits(await usdc.balanceOf(deployer.address), 6));

// ─── Read Chainlink price for initial oracle setup ───────────────────
const chainlink = await ethers.getContractAt(
  ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
   "function decimals() view returns (uint8)"],
  MAINNET.CHAINLINK_ETH_USD
);
const [, chainlinkAnswer,,,] = await chainlink.latestRoundData();
const chainlinkDecimals = await chainlink.decimals();
console.log(`\nChainlink ETH/USD: $${Number(chainlinkAnswer) / 10 ** Number(chainlinkDecimals)}`);

// ─── Deploy PriceOracle ──────────────────────────────────────────────
const PriceOracle = await ethers.getContractFactory("PriceOracle");
const oracle = await PriceOracle.deploy(chainlinkAnswer); // use Chainlink price as initial
await oracle.waitForDeployment();
console.log("PriceOracle:", await oracle.getAddress());

// Configure Chainlink feed
await oracle.setChainlinkFeed(MAINNET.CHAINLINK_ETH_USD);
console.log("Chainlink feed configured");

// Set generous staleness for fork (Chainlink data may be from an old block)
await oracle.setMaxStaleness(7 * 24 * 3600); // 7 days
console.log("Max staleness set to 7 days (fork mode)");

// Disable TWAP window (Chainlink is primary, manual override uses latest price)
await oracle.setTwapWindow(0);

// ─── Deploy LiquidationEngine ────────────────────────────────────────
const LiquidationEngine = await ethers.getContractFactory("LiquidationEngine");
const engine = await LiquidationEngine.deploy(deployer.address);
await engine.waitForDeployment();
console.log("LiquidationEngine:", await engine.getAddress());

await engine.setAuctionParams(100, 50, 5, 500, 10);
console.log("Auction params set: deltaMin=1%, d0=0.5%, rho=0.05%/s, dMax=5%, phi=0.1%");

// ─── Deploy AaveAdapter (real Aave V3) ───────────────────────────────
const AaveAdapter = await ethers.getContractFactory("AaveAdapter");
const adapter = await AaveAdapter.deploy(
  MAINNET.AAVE_POOL,
  MAINNET.WETH,
  MAINNET.USDC,
  MAINNET.aWETH
);
await adapter.waitForDeployment();
console.log("AaveAdapter:", await adapter.getAddress());

// ─── Deploy SoftLiquidationPool ──────────────────────────────────────
const SoftLiquidationPool = await ethers.getContractFactory("SoftLiquidationPool");
const pool = await SoftLiquidationPool.deploy(
  await adapter.getAddress(),
  await oracle.getAddress(),
  await engine.getAddress(),
  MAINNET.WETH,
  MAINNET.USDC
);
await pool.waitForDeployment();
console.log("SoftLiquidationPool:", await pool.getAddress());

// Initialize adapter
await adapter.initialize(await pool.getAddress());
console.log("Adapter initialized");

// ─── Fund all test accounts with WETH and USDC ──────────────────────
const signers = await ethers.getSigners();
const labels = ["Deployer", "User1", "User2", "Liquidator"];
for (let i = 0; i < Math.min(signers.length, 4); i++) {
  const addr = signers[i].address;
  // Give ETH for gas
  await ethers.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  // Wrap ETH -> WETH
  await signers[i].sendTransaction({ to: MAINNET.WETH, value: ethers.parseEther("50") });
  console.log(`Funded ${labels[i] || `Signer${i}`} (${addr}) with 50 WETH + 100 ETH`);
}

// Fund USDC via whale
await ethers.provider.send("hardhat_impersonateAccount", [MAINNET.USDC_WHALE]);
await ethers.provider.send("hardhat_setBalance", [MAINNET.USDC_WHALE, "0xDE0B6B3A7640000"]);
const usdcWhale2 = await ethers.getSigner(MAINNET.USDC_WHALE);
const whaleUsdcBal = await usdc.balanceOf(MAINNET.USDC_WHALE);
console.log("USDC whale balance:", ethers.formatUnits(whaleUsdcBal, 6));

for (let i = 0; i < Math.min(signers.length, 4); i++) {
  const amount = ethers.parseUnits("500000", 6);
  if (whaleUsdcBal >= amount * BigInt(i + 1)) {
    await usdc.connect(usdcWhale2).transfer(signers[i].address, amount);
    console.log(`Sent 500k USDC → ${labels[i] || `Signer${i}`}`);
  }
}
await ethers.provider.send("hardhat_stopImpersonatingAccount", [MAINNET.USDC_WHALE]);

// ─── Write addresses for frontend ────────────────────────────────────
const addresses = {
  weth: MAINNET.WETH,
  usdc: MAINNET.USDC,
  oracle: await oracle.getAddress(),
  engine: await engine.getAddress(),
  adapter: await adapter.getAddress(),
  pool: await pool.getAddress(),
};

const outPath = path.resolve(__dirname, "../frontend/src/config/deployed-addresses.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2));

console.log("\nDeploy complete on mainnet fork!");
console.log("Addresses saved to frontend/src/config/deployed-addresses.json");
console.log(JSON.stringify(addresses, null, 2));
