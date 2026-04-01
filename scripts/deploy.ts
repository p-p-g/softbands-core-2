import { network } from "hardhat";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Connect to localhost (running `npx hardhat node`)
const { ethers } = await network.connect("localhost");

const [deployer, user1, user2, liquidator] = await ethers.getSigners();
console.log("Deployer:", deployer.address);

// ─── Deploy tokens ───────────────────────────────────────────────────
const MockERC20 = await ethers.getContractFactory("MockERC20");

const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
await weth.waitForDeployment();
console.log("WETH:", await weth.getAddress());

const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
await usdc.waitForDeployment();
console.log("USDC:", await usdc.getAddress());

// ─── Deploy MockAavePool ─────────────────────────────────────────────
const MockAavePool = await ethers.getContractFactory("MockAavePool");
const aavePool = await MockAavePool.deploy();
await aavePool.waitForDeployment();
console.log("MockAavePool:", await aavePool.getAddress());

// Fund Aave with USDC liquidity
await usdc.mint(await aavePool.getAddress(), 10_000_000n * 10n ** 6n);
console.log("Funded Aave with 10M USDC");

// ─── Deploy PriceOracle ──────────────────────────────────────────────
const PriceOracle = await ethers.getContractFactory("PriceOracle");
const oracle = await PriceOracle.deploy(3500_00000000n); // $3500
await oracle.waitForDeployment();
await oracle.setTwapWindow(0); // Instant price for demo
console.log("PriceOracle:", await oracle.getAddress());

// ─── Deploy LiquidationEngine ────────────────────────────────────────
const LiquidationEngine = await ethers.getContractFactory("LiquidationEngine");
const engine = await LiquidationEngine.deploy(deployer.address);
await engine.waitForDeployment();
console.log("LiquidationEngine:", await engine.getAddress());

// Set auction parameters: deltaMin=100(1%), d0=50(0.5%), rho=5(0.05%/s), dMax=500(5%), phi=10(0.1%)
await engine.setAuctionParams(100, 50, 5, 500, 10);
console.log("Auction parameters set");

// ─── Deploy AaveAdapter ──────────────────────────────────────────────
const AaveAdapter = await ethers.getContractFactory("AaveAdapter");
const adapter = await AaveAdapter.deploy(
  await aavePool.getAddress(),
  await weth.getAddress(),
  await usdc.getAddress()
);
await adapter.waitForDeployment();
console.log("AaveAdapter:", await adapter.getAddress());

// ─── Deploy SoftLiquidationPool ──────────────────────────────────────
const SoftLiquidationPool = await ethers.getContractFactory("SoftLiquidationPool");
const pool = await SoftLiquidationPool.deploy(
  await adapter.getAddress(),
  await oracle.getAddress(),
  await engine.getAddress(),
  await weth.getAddress(),
  await usdc.getAddress()
);
await pool.waitForDeployment();
console.log("SoftLiquidationPool:", await pool.getAddress());

// Initialize adapter with pool address
await adapter.initialize(await pool.getAddress());
console.log("Adapter initialized");

// ─── Mint tokens to test accounts ────────────────────────────────────
const accounts = [deployer, user1, user2, liquidator];
const labels = ["Deployer", "User1", "User2", "Liquidator"];
for (let i = 0; i < accounts.length; i++) {
  await weth.mint(accounts[i].address, 100n * 10n ** 18n);
  await usdc.mint(accounts[i].address, 1_000_000n * 10n ** 6n);
  console.log(`Minted 100 WETH + 1M USDC → ${labels[i]} (${accounts[i].address})`);
}

// ─── Write addresses for frontend ────────────────────────────────────
const addresses = {
  weth: await weth.getAddress(),
  usdc: await usdc.getAddress(),
  mockAavePool: await aavePool.getAddress(),
  oracle: await oracle.getAddress(),
  engine: await engine.getAddress(),
  adapter: await adapter.getAddress(),
  pool: await pool.getAddress(),
};

const outPath = path.resolve(__dirname, "../frontend/src/config/deployed-addresses.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2));

console.log("\n✅ Deploy complete!");
console.log("Addresses saved to frontend/src/config/deployed-addresses.json");
console.log(JSON.stringify(addresses, null, 2));
