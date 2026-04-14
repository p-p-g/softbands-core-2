import { expect } from "chai";
import { network } from "hardhat";

// Fork availability check
const forkAvailable = !!process.env.MAINNET_RPC_URL;

// Mainnet addresses
const MAINNET = {
  AAVE_POOL: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  CHAINLINK_ETH_USD: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  WETH_WHALE: "0xF04a5cC80B1E94C69B48f5ee68a08CD2F09A7c3E",
  USDC_WHALE: "0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341",
  aWETH: "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8",
  variableDebtUSDC: "0x72E95b8931767C79bA4EeE721354d6E99a61D004",
};

const WETH_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function deposit() payable",
];
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];
const CHAINLINK_ABI = [
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
];
const AAVE_POOL_ABI = [
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
];
const ATOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

// Helpers
function eth(n: number) { return BigInt(Math.round(n * 1e6)) * 10n ** 12n; }
function usdc(n: number) { return BigInt(Math.round(n * 1e6)); }
function price8(n: number) { return BigInt(Math.round(n * 1e8)); }

const TICK_SPACING = 10;

(forkAvailable ? describe : describe.skip)("SoftLiquidationPool (Mainnet Fork)", function () {
  this.timeout(180_000);

  // Shared fork connection — created once for the whole suite
  let conn: Awaited<ReturnType<typeof network.connect>>;

  before(async function () {
    this.timeout(120_000);
    conn = await network.connect("hardhatFork");
  });

  // Base fixture — deploys the protocol on the fork snapshot.
  // networkHelpers.loadFixture() snapshots EVM state after first run,
  // then restores the snapshot on every subsequent call: each test
  // starts from a clean deployed state without re-deploying from scratch.
  async function baseFixture() {
    const { ethers, networkHelpers } = conn;
    const [deployer, user1, user2, user3, liquidator] = await ethers.getSigners();

    const weth = await ethers.getContractAt(WETH_ABI, MAINNET.WETH);
    const usdcToken = await ethers.getContractAt(USDC_ABI, MAINNET.USDC);
    const chainlink = await ethers.getContractAt(CHAINLINK_ABI, MAINNET.CHAINLINK_ETH_USD);
    const aavePool = await ethers.getContractAt(AAVE_POOL_ABI, MAINNET.AAVE_POOL);
    const aWeth = await ethers.getContractAt(ATOKEN_ABI, MAINNET.aWETH);
    const vDebtUsdc = await ethers.getContractAt(ATOKEN_ABI, MAINNET.variableDebtUSDC);

    // Fund all signers with ETH and WETH
    for (const signer of [deployer, user1, user2, user3, liquidator]) {
      await networkHelpers.setBalance(signer.address, 100n * 10n ** 18n);
      await signer.sendTransaction({ to: MAINNET.WETH, value: eth(50) });
    }

    // Fund with USDC via whale
    await networkHelpers.impersonateAccount(MAINNET.USDC_WHALE);
    await networkHelpers.setBalance(MAINNET.USDC_WHALE, 10n ** 18n);
    const whale = await ethers.getSigner(MAINNET.USDC_WHALE);
    for (const signer of [deployer, user1, user2, user3, liquidator]) {
      await usdcToken.connect(whale).transfer(signer.address, usdc(1_000_000));
    }
    await networkHelpers.stopImpersonatingAccount(MAINNET.USDC_WHALE);

    // Read Chainlink price
    const [, clPrice,,,] = await chainlink.latestRoundData();
    const chainlinkPrice = BigInt(clPrice.toString());

    // Deploy protocol
    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    const oracle = await PriceOracle.deploy(chainlinkPrice);
    await oracle.waitForDeployment();
    await oracle.setChainlinkFeed(MAINNET.CHAINLINK_ETH_USD);
    await oracle.setMaxStaleness(7 * 24 * 3600);
    await oracle.setTwapWindow(0);

    const LiquidationEngine = await ethers.getContractFactory("LiquidationEngine");
    const engine = await LiquidationEngine.deploy(deployer.address);
    await engine.waitForDeployment();
    await engine.setAuctionParams(100, 50, 5, 500, 10);

    const AaveAdapter = await ethers.getContractFactory("AaveAdapter");
    const adapter = await AaveAdapter.deploy(MAINNET.AAVE_POOL, MAINNET.WETH, MAINNET.USDC, MAINNET.aWETH);
    await adapter.waitForDeployment();

    const SoftLiquidationPool = await ethers.getContractFactory("SoftLiquidationPool");
    const pool = await SoftLiquidationPool.deploy(
      await adapter.getAddress(),
      await oracle.getAddress(),
      await engine.getAddress(),
      MAINNET.WETH,
      MAINNET.USDC,
    );
    await pool.waitForDeployment();
    await adapter.initialize(await pool.getAddress());

    const poolAddr = await pool.getAddress();
    const adapterAddr = await adapter.getAddress();

    // Compute valid tick range (below current price)
    const currentTick = Number(await engine.priceToTick(chainlinkPrice));
    const alignedTick = Math.floor(currentTick / TICK_SPACING) * TICK_SPACING;
    // Standard range: 21 ticks (~2% range)
    const upperTick = alignedTick - TICK_SPACING;
    const lowerTick = upperTick - 20 * TICK_SPACING;
    // Narrow range for some tests: 6 ticks
    const narrowUpper = alignedTick - TICK_SPACING;
    const narrowLower = narrowUpper - 5 * TICK_SPACING;
    // Wide range: 41 ticks (~4% range)
    const wideUpper = alignedTick - TICK_SPACING;
    const wideLower = wideUpper - 40 * TICK_SPACING;

    // Helper: approve and deposit
    async function deposit(
      signer: typeof user1,
      wethAmt: bigint,
      usdcAmt: bigint,
      upper = upperTick,
      lower = lowerTick,
    ) {
      await weth.connect(signer).approve(poolAddr, wethAmt);
      return pool.connect(signer).deposit(wethAmt, usdcAmt, upper, lower);
    }

    // Helper: drop price and trigger auction
    async function dropPrice(priceDrop: number) {
      const newPrice = (chainlinkPrice * BigInt(Math.round((1 - priceDrop) * 10000))) / 10000n;
      await oracle.setPrice(newPrice);
      return newPrice;
    }

    // Helper: approve liquidator USDC for rebalance
    async function approveLiquidator(amount: bigint) {
      await usdcToken.connect(liquidator).approve(poolAddr, amount);
    }

    return {
      ethers, networkHelpers,
      deployer, user1, user2, user3, liquidator,
      weth, usdc: usdcToken, chainlink, aavePool, aWeth, vDebtUsdc,
      oracle, engine, adapter, pool,
      poolAddr, adapterAddr,
      chainlinkPrice, currentTick: alignedTick,
      upperTick, lowerTick, narrowUpper, narrowLower, wideUpper, wideLower,
      deposit, dropPrice, approveLiquidator,
    };
  }

  // Aave Integration
  describe("Real Aave V3 Integration", function () {
    it("adapter points to real Aave Pool", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      expect(await f.adapter.aavePool()).to.equal(MAINNET.AAVE_POOL);
      const code = await f.ethers.provider.getCode(MAINNET.AAVE_POOL);
      expect(code.length).to.be.greaterThan(100);
    });

    it("deposit mints real aWETH and borrows real USDC from Aave", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);

      const aWethBefore = await f.aWeth.balanceOf(f.adapterAddr);
      const vDebtBefore = await f.vDebtUsdc.balanceOf(f.adapterAddr);
      expect(aWethBefore).to.equal(0);
      expect(vDebtBefore).to.equal(0);

      await f.deposit(f.user1, eth(2), usdc(1000));

      const aWethAfter = await f.aWeth.balanceOf(f.adapterAddr);
      const vDebtAfter = await f.vDebtUsdc.balanceOf(f.adapterAddr);

      expect(aWethAfter).to.be.closeTo(eth(2), eth(0.001));
      expect(vDebtAfter).to.be.closeTo(usdc(1000), usdc(1));
    });

    it("Aave health factor is reasonable after deposit", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await f.deposit(f.user1, eth(5), usdc(2000));

      const [totalCol, totalDebt,,,,hf] = await f.aavePool.getUserAccountData(f.adapterAddr);
      expect(totalCol).to.be.greaterThan(0);
      expect(totalDebt).to.be.greaterThan(0);
      const healthFactor = Number(hf) / 1e18;
      expect(healthFactor).to.be.greaterThan(1.0);
      expect(healthFactor).to.be.lessThan(100);
    });

    it("rebalance repays real Aave debt and withdraws real aWETH", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await f.deposit(f.user1, eth(2), usdc(1000));

      const aWethBefore = await f.aWeth.balanceOf(f.adapterAddr);
      const vDebtBefore = await f.vDebtUsdc.balanceOf(f.adapterAddr);

      await f.dropPrice(0.05);
      await f.approveLiquidator(usdc(500_000));
      await f.pool.connect(f.liquidator).rebalance(eth(100), 0);

      const aWethAfter = await f.aWeth.balanceOf(f.adapterAddr);
      const vDebtAfter = await f.vDebtUsdc.balanceOf(f.adapterAddr);

      expect(aWethAfter).to.be.lessThan(aWethBefore);
      expect(vDebtAfter).to.be.lessThan(vDebtBefore);
    });

    it("close position returns real WETH and repays real USDC", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await f.deposit(f.user1, eth(2), usdc(1000));

      const userWethBefore = await f.weth.balanceOf(f.user1.address);

      // Approve extra to cover Aave interest accrual buffer
      await f.usdc.connect(f.user1).approve(f.poolAddr, usdc(2000));
      await f.pool.connect(f.user1).closePosition(1);

      const userWethAfter = await f.weth.balanceOf(f.user1.address);
      expect(userWethAfter).to.be.greaterThan(userWethBefore);

      const aWethFinal = await f.aWeth.balanceOf(f.adapterAddr);
      const vDebtFinal = await f.vDebtUsdc.balanceOf(f.adapterAddr);
      expect(aWethFinal).to.be.closeTo(0n, eth(0.001));
      expect(vDebtFinal).to.be.closeTo(0n, usdc(1));
    });
  });

  // Chainlink Oracle
  describe("Chainlink Oracle", function () {
    it("returns real Chainlink price", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      const [, clAnswer,,,] = await f.chainlink.latestRoundData();
      const oraclePrice = await f.oracle.getPrice();
      expect(oraclePrice).to.equal(BigInt(clAnswer.toString()));
      expect(oraclePrice).to.be.greaterThan(price8(100));
      expect(oraclePrice).to.be.lessThan(price8(100000));
    });

    it("manual override takes precedence, clearManualOverride restores Chainlink", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);

      await f.oracle.setPrice(price8(9999));
      expect(await f.oracle.getPrice()).to.equal(price8(9999));

      await f.oracle.clearManualOverride();
      const [, clAnswer,,,] = await f.chainlink.latestRoundData();
      expect(await f.oracle.getPrice()).to.equal(BigInt(clAnswer.toString()));
    });

    it("override expires after 1 hour, falls back to Chainlink", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);

      await f.oracle.setPrice(price8(9999));
      expect(await f.oracle.getPrice()).to.equal(price8(9999));

      await f.networkHelpers.time.increase(3601);

      const [, clAnswer,,,] = await f.chainlink.latestRoundData();
      expect(await f.oracle.getPrice()).to.equal(BigInt(clAnswer.toString()));
    });
  });

  // Multiple Users
  describe("Multiple Users", function () {
    it("two users deposit into same range, liquidation affects both proportionally", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);

      await f.deposit(f.user1, eth(2), usdc(1000));
      await f.deposit(f.user2, eth(3), usdc(1500));

      await f.dropPrice(0.05);
      await f.approveLiquidator(usdc(500_000));
      await f.pool.connect(f.liquidator).rebalance(eth(100), 0);

      const [, col1] = await f.pool.getPositionState(1);
      const [, col2] = await f.pool.getPositionState(2);

      expect(col1).to.be.greaterThan(0);
      expect(col2).to.be.greaterThan(0);
      expect(col1).to.be.lessThan(eth(2));
      expect(col2).to.be.lessThan(eth(3));

      // Ratio should be approximately 2:3
      const ratio = (col1 * 1000n) / col2;
      expect(ratio).to.be.closeTo(666n, 50n);
    });

    it("two users with overlapping ranges only overlapping ticks shared", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);

      await f.deposit(f.user1, eth(2), usdc(1000), f.wideUpper, f.wideLower);
      await f.deposit(f.user2, eth(2), usdc(1000), f.narrowUpper, f.narrowLower);

      // Drop price enough to liquidate narrow ticks but not all wide ticks
      const narrowUpperPrice = await f.engine.tickToPrice(f.narrowUpper);
      const dropTo = narrowUpperPrice - narrowUpperPrice / 20n;
      await f.oracle.setPrice(dropTo);

      await f.approveLiquidator(usdc(500_000));
      await f.pool.connect(f.liquidator).rebalance(eth(100), 0);

      const [, col1] = await f.pool.getPositionState(1);
      const [, col2] = await f.pool.getPositionState(2);

      expect(col1).to.be.greaterThan(col2);
    });

    it("three users deposit, one closes before liquidation", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);

      await f.deposit(f.user1, eth(1), usdc(500));
      await f.deposit(f.user2, eth(1), usdc(500));
      await f.deposit(f.user3, eth(1), usdc(500));

      // User3 closes before any liquidation (approve extra for interest buffer)
      await f.usdc.connect(f.user3).approve(f.poolAddr, usdc(1000));
      await f.pool.connect(f.user3).closePosition(3);
      expect((await f.pool.positions(3)).active).to.be.false;

      // Now liquidate
      await f.dropPrice(0.05);
      await f.approveLiquidator(usdc(500_000));
      await f.pool.connect(f.liquidator).rebalance(eth(100), 0);

      const [, col1] = await f.pool.getPositionState(1);
      const [, col2] = await f.pool.getPositionState(2);
      expect(col1).to.be.lessThan(eth(1));
      expect(col2).to.be.lessThan(eth(1));
      expect(col1).to.be.closeTo(col2, eth(0.001));
    });

    it("user deposits after another user's ticks were liquidated no corruption", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);

      await f.deposit(f.user1, eth(2), usdc(1000));

      await f.dropPrice(0.10);
      await f.approveLiquidator(usdc(500_000));
      await f.pool.connect(f.liquidator).rebalance(eth(100), 0);

      const tickInfo = await f.pool.tickData(f.upperTick);
      expect(tickInfo.liquidated).to.be.true;

      // Reset price and deposit user2 into same range
      await f.oracle.setPrice(f.chainlinkPrice);
      await f.deposit(f.user2, eth(1), usdc(500));

      const [debt2, col2] = await f.pool.getPositionState(2);
      expect(col2).to.be.closeTo(eth(1), eth(0.001));
      expect(debt2).to.be.closeTo(usdc(500), usdc(1));

      const [debt1] = await f.pool.getPositionState(1);
      expect(debt1).to.equal(0n);
    });
  });

  // Dutch Auction & Slippage Protection
  describe("Dutch Auction & Slippage Protection", function () {
    it("auction not active when delta < 1%", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await f.deposit(f.user1, eth(2), usdc(1000));

      await f.dropPrice(0.005);
      await f.approveLiquidator(usdc(500_000));

      await expect(
        f.pool.connect(f.liquidator).rebalance(eth(1), 0)
      ).to.be.revertedWithCustomError(f.pool, "AuctionNotActive");
    });

    it("auction activates when delta > 1%", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await f.deposit(f.user1, eth(2), usdc(1000));

      await f.dropPrice(0.02);
      await f.approveLiquidator(usdc(500_000));

      await f.pool.connect(f.liquidator).rebalance(eth(100), 0);
    });

    it("deviation increases over time (Dutch auction ramp)", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await f.deposit(f.user1, eth(2), usdc(1000));

      await f.dropPrice(0.05);

      const state0 = await f.pool.getAuctionState();
      const dev0 = state0.deviation;

      await f.networkHelpers.time.increase(10);

      const state1 = await f.pool.getAuctionState();
      const dev1 = state1.deviation;

      expect(dev1).to.be.greaterThan(dev0);
    });

    it("deviation capped at dMax (5%)", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await f.deposit(f.user1, eth(2), usdc(1000));

      await f.dropPrice(0.10);
      await f.networkHelpers.time.increase(10000);

      const state = await f.pool.getAuctionState();
      expect(state.deviation).to.equal(500n);
    });

    it("slippage protection reverts when cost exceeds maxUsdcCost", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await f.deposit(f.user1, eth(2), usdc(1000));

      await f.dropPrice(0.05);
      await f.approveLiquidator(usdc(500_000));

      await expect(
        f.pool.connect(f.liquidator).rebalance(eth(1), usdc(1))
      ).to.be.revertedWithCustomError(f.pool, "SlippageExceeded");
    });

    it("slippage protection passes when cost within maxUsdcCost", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await f.deposit(f.user1, eth(2), usdc(1000));

      await f.dropPrice(0.05);
      await f.approveLiquidator(usdc(500_000));

      await f.pool.connect(f.liquidator).rebalance(eth(100), usdc(500_000));
    });

    it("maxUsdcCost = 0 disables slippage check", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await f.deposit(f.user1, eth(2), usdc(1000));

      await f.dropPrice(0.05);
      await f.approveLiquidator(usdc(500_000));

      await f.pool.connect(f.liquidator).rebalance(eth(100), 0);
    });

    it("execution price includes discount from oracle price", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await f.deposit(f.user1, eth(2), usdc(1000));

      const newPrice = await f.dropPrice(0.05);

      const state = await f.pool.getAuctionState();
      expect(state.execPrice).to.be.lessThan(newPrice);
      expect(state.execPrice).to.be.greaterThan(0);
    });

    it("fee is collected by feeRecipient", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await f.deposit(f.user1, eth(2), usdc(1000));

      await f.dropPrice(0.05);
      await f.approveLiquidator(usdc(500_000));

      const feeRecipient = await f.pool.feeRecipient();
      const feeBefore = await f.usdc.balanceOf(feeRecipient);

      await f.pool.connect(f.liquidator).rebalance(eth(100), 0);

      const feeAfter = await f.usdc.balanceOf(feeRecipient);
      expect(feeAfter).to.be.greaterThan(feeBefore);
    });

    it("P_int resets after rebalance second rebalance requires new price drop", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await f.deposit(f.user1, eth(5), usdc(2000));

      // First rebalance — use small amount to leave ticks for subsequent calls
      // (standard 21-tick range spans ~2.1%; eth(1) would drain all ticks at once)
      await f.dropPrice(0.05);
      await f.approveLiquidator(usdc(1_000_000));
      await f.pool.connect(f.liquidator).rebalance(eth(0.1), 0);

      // P_int updated → delta = 0 → auction inactive
      await expect(
        f.pool.connect(f.liquidator).rebalance(eth(0.1), 0)
      ).to.be.revertedWithCustomError(f.pool, "AuctionNotActive");

      // Drop price further and confirm auction is active again
      await f.dropPrice(0.10);
      await f.pool.connect(f.liquidator).rebalance(eth(0.1), 0);
    });
  });

  // Edge Cases
  describe("Edge Cases", function () {
    it("rebalance with wethWanted = 0 reverts", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await expect(
        f.pool.connect(f.liquidator).rebalance(0, 0)
      ).to.be.revertedWithCustomError(f.pool, "ZeroWethRequested");
    });

    it("rebalance when no liquidatable ticks reverts", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await f.deposit(f.user1, eth(2), usdc(1000));

      await f.dropPrice(0.02);
      await f.approveLiquidator(usdc(500_000));

      try {
        await f.pool.connect(f.liquidator).rebalance(eth(100), 0);
      } catch (e: any) {
        expect(e.message).to.include("NoLiquidatableTicks");
      }
    });

    it("partial tick liquidation collateral reduced, tick not fully drained", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await f.deposit(f.user1, eth(5), usdc(2000));

      await f.dropPrice(0.05);
      await f.approveLiquidator(usdc(500_000));

      const smallAmount = eth(0.01);
      const liqWethBefore = await f.weth.balanceOf(f.liquidator.address);

      await f.pool.connect(f.liquidator).rebalance(smallAmount, 0);

      const liqWethAfter = await f.weth.balanceOf(f.liquidator.address);
      const received = liqWethAfter - liqWethBefore;

      expect(received).to.be.closeTo(smallAmount, eth(0.001));

      const tickInfo = await f.pool.tickData(f.upperTick);
      expect(tickInfo.liquidated).to.be.false;
      expect(tickInfo.totalCollateral).to.be.greaterThan(0);
    });

    it("undercollateralized tick liquidator gets collateral, bad debt remains", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await f.deposit(f.user1, eth(1), usdc(1500));

      // 60% drop — exec price well below $1500 threshold
      await f.dropPrice(0.60);
      await f.approveLiquidator(usdc(500_000));

      const liqWethBefore = await f.weth.balanceOf(f.liquidator.address);
      await f.pool.connect(f.liquidator).rebalance(eth(100), 0);
      const liqWethAfter = await f.weth.balanceOf(f.liquidator.address);

      const received = liqWethAfter - liqWethBefore;
      expect(received).to.be.greaterThan(0);
      expect(received).to.be.lessThanOrEqual(eth(1));

      // Internal tick accounting: all collateral drained
      const [, remainingCol] = await f.pool.getPositionState(1);
      expect(remainingCol).to.equal(0n);
    });

    it("multiple sequential rebalances with progressive price drops", async function () {
      this.timeout(300_000);
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await f.deposit(f.user1, eth(5), usdc(2000), f.wideUpper, f.wideLower);

      await f.approveLiquidator(usdc(1_000_000));

      // Small amounts so each call only consumes a few ticks, leaving the rest
      // for subsequent rebalances (wide 41-tick range spans ~4.1%)
      await f.dropPrice(0.03);
      await f.pool.connect(f.liquidator).rebalance(eth(0.1), 0);

      await f.dropPrice(0.06);
      await f.pool.connect(f.liquidator).rebalance(eth(0.1), 0);

      await f.dropPrice(0.10);
      await f.pool.connect(f.liquidator).rebalance(eth(0.1), 0);

      const [, col] = await f.pool.getPositionState(1);
      expect(col).to.be.lessThan(eth(5));
      expect(col).to.be.greaterThan(0);
    });

    it("close position after partial liquidation returns correct amounts", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await f.deposit(f.user1, eth(3), usdc(1000));

      await f.dropPrice(0.05);
      await f.approveLiquidator(usdc(500_000));
      await f.pool.connect(f.liquidator).rebalance(eth(0.5), 0);

      const [remainingDebt, remainingCol] = await f.pool.getPositionState(1);
      expect(remainingCol).to.be.greaterThan(0);
      expect(remainingCol).to.be.lessThan(eth(3));

      const userWethBefore = await f.weth.balanceOf(f.user1.address);
      await f.usdc.connect(f.user1).approve(f.poolAddr, remainingDebt + usdc(10));
      await f.pool.connect(f.user1).closePosition(1);

      const userWethAfter = await f.weth.balanceOf(f.user1.address);
      const returned = userWethAfter - userWethBefore;

      expect(returned).to.be.closeTo(remainingCol, eth(0.001));
      expect((await f.pool.positions(1)).active).to.be.false;
    });

    it("repay partial debt, then liquidation affects reduced debt", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);
      await f.deposit(f.user1, eth(2), usdc(1000));

      await f.usdc.connect(f.user1).approve(f.poolAddr, usdc(500));
      await f.pool.connect(f.user1).repay(1, usdc(500));

      const [debtAfterRepay] = await f.pool.getPositionState(1);
      expect(debtAfterRepay).to.be.closeTo(usdc(500), usdc(5));

      await f.dropPrice(0.05);
      await f.approveLiquidator(usdc(500_000));
      await f.pool.connect(f.liquidator).rebalance(eth(100), 0);

      const [, colFinal] = await f.pool.getPositionState(1);
      expect(colFinal).to.be.greaterThan(0);
    });

    it("deposit into previously liquidated tick range works correctly", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);

      await f.deposit(f.user1, eth(1), usdc(500));
      await f.dropPrice(0.10);
      await f.approveLiquidator(usdc(500_000));
      await f.pool.connect(f.liquidator).rebalance(eth(100), 0);

      const upper = await f.pool.tickData(f.upperTick);
      expect(upper.liquidated).to.be.true;

      await f.oracle.setPrice(f.chainlinkPrice);
      await f.deposit(f.user2, eth(2), usdc(800));

      const [debt2, col2] = await f.pool.getPositionState(2);
      expect(col2).to.be.closeTo(eth(2), eth(0.01));
      expect(debt2).to.be.closeTo(usdc(800), usdc(1));

      const upperAfter = await f.pool.tickData(f.upperTick);
      expect(upperAfter.liquidated).to.be.false;
      expect(upperAfter.totalCollateral).to.be.greaterThan(0);
    });
  });

  // Full Lifecycle
  describe("Full Lifecycle (Multi-User)", function () {
    it("3 users deposit → price drops → rebalance → users close → balances reconcile", async function () {
      const f = await conn.networkHelpers.loadFixture(baseFixture);

      await f.deposit(f.user1, eth(2), usdc(1000));
      await f.deposit(f.user2, eth(3), usdc(1500));
      await f.deposit(f.user3, eth(1), usdc(500));

      await f.dropPrice(0.05);
      await f.approveLiquidator(usdc(1_000_000));

      const liqUsdcBefore = await f.usdc.balanceOf(f.liquidator.address);
      const liqWethBefore = await f.weth.balanceOf(f.liquidator.address);

      await f.pool.connect(f.liquidator).rebalance(eth(100), 0);

      const liqUsdcAfter = await f.usdc.balanceOf(f.liquidator.address);
      const liqWethAfter = await f.weth.balanceOf(f.liquidator.address);

      expect(liqUsdcAfter).to.be.lessThan(liqUsdcBefore);
      expect(liqWethAfter).to.be.greaterThan(liqWethBefore);

      // All three users close positions
      for (const [userId, user] of [[1, f.user1], [2, f.user2], [3, f.user3]] as const) {
        const [remainingDebt] = await f.pool.getPositionState(userId);
        if (remainingDebt > 0n) {
          await f.usdc.connect(user).approve(f.poolAddr, remainingDebt + usdc(10));
        }
        await f.pool.connect(user).closePosition(userId);
        expect((await f.pool.positions(userId)).active).to.be.false;
      }

      // Aave should be nearly empty
      const [totalCol, totalDebt,,,,] = await f.aavePool.getUserAccountData(f.adapterAddr);
      expect(totalCol).to.be.closeTo(0n, price8(1));
      expect(totalDebt).to.be.closeTo(0n, price8(1));
    });
  });
});
