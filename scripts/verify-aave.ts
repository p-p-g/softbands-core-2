/**
 * Verify that the protocol is connected to real Aave V3.
 * Run: npx hardhat run scripts/verify-aave.ts
 * (with forked node running on localhost)
 */
import { network } from "hardhat";

const { ethers } = await network.connect("localhost");

const MAINNET = {
  AAVE_POOL: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  // Aave V3 aTokens / debt tokens
  aWETH: "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8",
  variableDebtUSDC: "0x72E95b8931767C79bA4EeE721354d6E99a61D004",
};

// Read addresses from deploy
const fs = await import("fs");
const path = await import("path");
const { fileURLToPath } = await import("url");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const deployed = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../frontend/src/config/deployed-addresses.json"), "utf-8")
);

console.log("=== Aave V3 Connection Verification ===\n");

// 1. Check that AaveAdapter points to real Aave pool
const adapter = await ethers.getContractAt(
  ["function aavePool() view returns (address)", "function pool() view returns (address)"],
  deployed.adapter
);
const aavePoolAddr = await adapter.aavePool();
console.log(`AaveAdapter.aavePool() = ${aavePoolAddr}`);
console.log(`Expected Aave V3 Pool   = ${MAINNET.AAVE_POOL}`);
console.log(`Match: ${aavePoolAddr.toLowerCase() === MAINNET.AAVE_POOL.toLowerCase() ? "YES" : "NO"}\n`);

// 2. Check Aave pool code exists (not empty contract)
const poolCode = await ethers.provider.getCode(MAINNET.AAVE_POOL);
console.log(`Aave Pool code size: ${(poolCode.length - 2) / 2} bytes (${poolCode.length > 100 ? "real contract" : "EMPTY!"})\n`);

// 3. Check aWETH balance of adapter (shows WETH actually supplied to Aave)
const aWeth = await ethers.getContractAt(
  ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"],
  MAINNET.aWETH
);
const aWethBal = await aWeth.balanceOf(deployed.adapter);
const aWethSymbol = await aWeth.symbol();
console.log(`Adapter's ${aWethSymbol} balance: ${ethers.formatEther(aWethBal)} (= WETH supplied to Aave)`);

// 4. Check variable debt USDC balance of adapter
const vDebtUsdc = await ethers.getContractAt(
  ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"],
  MAINNET.variableDebtUSDC
);
const debtBal = await vDebtUsdc.balanceOf(deployed.adapter);
const debtSymbol = await vDebtUsdc.symbol();
console.log(`Adapter's ${debtSymbol} balance: ${ethers.formatUnits(debtBal, 6)} USDC (= USDC borrowed from Aave)`);

// 5. Get Aave account data for the adapter
const aavePool = await ethers.getContractAt(
  ["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"],
  MAINNET.AAVE_POOL
);
const [totalCol, totalDebt, availBorrow, liqThreshold, ltv, hf] =
  await aavePool.getUserAccountData(deployed.adapter);

console.log(`\n=== Aave getUserAccountData(adapter) ===`);
console.log(`Total Collateral (USD): $${ethers.formatUnits(totalCol, 8)}`);
console.log(`Total Debt (USD):       $${ethers.formatUnits(totalDebt, 8)}`);
console.log(`Available Borrows:      $${ethers.formatUnits(availBorrow, 8)}`);
console.log(`Liquidation Threshold:  ${Number(liqThreshold) / 100}%`);
console.log(`LTV:                    ${Number(ltv) / 100}%`);
console.log(`Health Factor:          ${Number(hf) > 1e30 ? "N/A (no debt)" : ethers.formatEther(hf)}`);

console.log(`\n=== Conclusion ===`);
if (aavePoolAddr.toLowerCase() === MAINNET.AAVE_POOL.toLowerCase() && poolCode.length > 100) {
  console.log("Protocol is connected to REAL Aave V3 on mainnet fork.");
  if (aWethBal > 0n) {
    console.log(`WETH is really deposited into Aave (aWETH balance > 0).`);
  } else {
    console.log("No WETH deposited yet open a position first to see Aave interaction.");
  }
} else {
  console.log("WARNING: Not connected to real Aave!");
}
