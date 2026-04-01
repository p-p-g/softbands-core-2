import { network } from "hardhat";
import { ethers as eth } from "ethers";
const { ethers } = await network.connect("localhost");
const [deployer] = await ethers.getSigners();
const addresses = (await import("../frontend/src/config/deployed-addresses.json", { with: { type: "json" } })).default;
const pool = await ethers.getContractAt("SoftLiquidationPool", addresses.pool);
const weth = await ethers.getContractAt("MockERC20", addresses.weth);
const engine = await ethers.getContractAt("LiquidationEngine", addresses.engine);

const bal = await weth.balanceOf(deployer.address);
console.log("WETH balance:", eth.formatEther(bal));

const upperTick = await engine.priceToTick(eth.parseUnits("3400", 8));
const lowerTick = await engine.priceToTick(eth.parseUnits("3350", 8));
console.log("Ticks:", upperTick.toString(), lowerTick.toString());

await weth.approve(addresses.pool, eth.parseEther("1"));
try {
  const tx = await pool.deposit(eth.parseEther("1"), eth.parseUnits("2000", 6), upperTick, lowerTick);
  await tx.wait();
  console.log("Deposit OK");
} catch (e: any) {
  console.log("Deposit failed:", e.message?.slice(0, 200));
}
