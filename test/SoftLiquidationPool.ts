import { expect } from "chai";
import { network } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Helpers
const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;
const PRICE_DECIMALS = 8;
const TICK_SPACING = 10;

function eth(n: number) { return BigInt(n) * 10n ** BigInt(WETH_DECIMALS); }
function usdc(n: number) { return BigInt(n) * 10n ** BigInt(USDC_DECIMALS); }
function price8(n: number) { return BigInt(n) * 10n ** BigInt(PRICE_DECIMALS); }

// Fixture
async function deployFixture() {
  const { ethers, networkHelpers } = await network.connect();
  const [deployer, user1, user2, liquidator] = await ethers.getSigners();

  // Deploy mock tokens
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const weth = await MockERC20.deploy("Wrapped Ether", "WETH", WETH_DECIMALS);
  const usdcToken = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);

  // Deploy mock Aave pool
  const MockAavePool = await ethers.getContractFactory("MockAavePool");
  const mockAave = await MockAavePool.deploy();

  // Fund Aave pool with USDC (so it can lend)
  await usdcToken.mint(await mockAave.getAddress(), usdc(10_000_000));

  // Deploy protocol contracts
  const PriceOracle = await ethers.getContractFactory("PriceOracle");
  const oracle = await PriceOracle.deploy(price8(3500));

  const LiquidationEngine = await ethers.getContractFactory("LiquidationEngine");
  const engine = await LiquidationEngine.deploy(deployer.address);

  // Set auction params: deltaMin=100(1%), d0=50(0.5%), rho=5(0.05%/s), dMax=500(5%), phi=10(0.1%)
  await engine.setAuctionParams(100, 50, 5, 500, 10);

  const AaveAdapter = await ethers.getContractFactory("AaveAdapter");
  const adapter = await AaveAdapter.deploy(
    await mockAave.getAddress(),
    await weth.getAddress(),
    await usdcToken.getAddress()
  );

  const SoftLiquidationPool = await ethers.getContractFactory("SoftLiquidationPool");
  const pool = await SoftLiquidationPool.deploy(
    await adapter.getAddress(),
    await oracle.getAddress(),
    await engine.getAddress(),
    await weth.getAddress(),
    await usdcToken.getAddress()
  );

  // Initialize adapter with pool address
  await adapter.initialize(await pool.getAddress());

  // Disable TWAP for deterministic liquidation tests (oracle returns latest price)
  await oracle.setTwapWindow(0);

  // Compute valid tick range
  const currentTick = await engine.priceToTick(price8(3500));
  const upperTick = currentTick - BigInt(TICK_SPACING * 10); // 100 ticks below
  const lowerTick = currentTick - BigInt(TICK_SPACING * 30); // 300 ticks below
  const numTicks = Number((upperTick - lowerTick) / BigInt(TICK_SPACING)) + 1;

  return {
    ethers, networkHelpers,
    deployer, user1, user2, liquidator,
    weth, usdc: usdcToken, mockAave, oracle, engine, adapter, pool,
    currentTick, upperTick, lowerTick, numTicks,
  };
}

async function setupUser(
  fixture: Awaited<ReturnType<typeof deployFixture>>,
  user: HardhatEthersSigner,
  wethAmount: bigint
) {
  await fixture.weth.mint(await user.getAddress(), wethAmount);
  await fixture.weth.connect(user).approve(await fixture.pool.getAddress(), wethAmount);
}

async function setupLiquidator(
  fixture: Awaited<ReturnType<typeof deployFixture>>,
  usdcAmount: bigint
) {
  const liq = fixture.liquidator;
  await fixture.usdc.mint(await liq.getAddress(), usdcAmount);
  await fixture.usdc.connect(liq).approve(await fixture.pool.getAddress(), usdcAmount);
}

describe("SoftLiquidationPool", function () {
  // Deployment
  describe("Deployment", function () {
    it("should deploy all contracts with correct links", async function () {
      const f = await deployFixture();
      expect(await f.pool.aaveAdapter()).to.equal(await f.adapter.getAddress());
      expect(await f.pool.oracle()).to.equal(await f.oracle.getAddress());
      expect(await f.pool.liquidationEngine()).to.equal(await f.engine.getAddress());
      expect(await f.adapter.pool()).to.equal(await f.pool.getAddress());
    });

    it("oracle should return initial price", async function () {
      const f = await deployFixture();
      expect(await f.oracle.getPrice()).to.equal(price8(3500));
    });

    it("priceToTick and tickToPrice should round-trip", async function () {
      const f = await deployFixture();
      const tick = await f.engine.priceToTick(price8(3500));
      const recoveredPrice = await f.engine.tickToPrice(tick);
      const diff = recoveredPrice > price8(3500)
        ? recoveredPrice - price8(3500)
        : price8(3500) - recoveredPrice;
      expect(diff).to.be.lessThan(price8(3500) / 100n);
    });

    it("should set auction parameters correctly", async function () {
      const f = await deployFixture();
      expect(await f.engine.deltaMin()).to.equal(100);
      expect(await f.engine.d0()).to.equal(50);
      expect(await f.engine.rho()).to.equal(5);
      expect(await f.engine.dMax()).to.equal(500);
      expect(await f.engine.phi()).to.equal(10);
    });

    it("should initialize auction state in pool", async function () {
      const f = await deployFixture();
      expect(await f.pool.lastRebalancePrice()).to.equal(price8(3500));
      expect(await f.pool.feeRecipient()).to.equal(await f.deployer.getAddress());
    });
  });

  // Deposit
  describe("Deposit", function () {
    it("should create a position and transfer tokens", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));

      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      const pos = await f.pool.positions(1);
      expect(pos.owner).to.equal(await f.user1.getAddress());
      expect(pos.collateral).to.equal(eth(1));
      expect(pos.debt).to.equal(usdc(2000));
      expect(pos.active).to.be.true;
      expect(pos.upperTick).to.equal(f.upperTick);
      expect(pos.lowerTick).to.equal(f.lowerTick);

      expect(await f.usdc.balanceOf(await f.user1.getAddress())).to.equal(usdc(2000));
      expect(await f.weth.balanceOf(await f.user1.getAddress())).to.equal(0);
      expect(await f.pool.nextPositionId()).to.equal(2);
    });

    it("should distribute collateral equally across ticks", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2100), f.upperTick, f.lowerTick);

      const colPerTick = eth(1) / BigInt(f.numTicks);
      const debtPerTick = usdc(2100) / BigInt(f.numTicks);

      const middleTick = f.lowerTick + BigInt(TICK_SPACING * 10);
      const tickInfo = await f.pool.tickData(middleTick);
      expect(tickInfo.totalCollateral).to.equal(colPerTick);
      expect(tickInfo.totalDebt).to.equal(debtPerTick);
      expect(tickInfo.totalShares).to.equal(colPerTick);
    });

    it("tick should not be liquidatable at current high price", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      const midTick = f.lowerTick + BigInt(TICK_SPACING * 5);
      expect(await f.pool.isTickLiquidatable(midTick)).to.be.false;
    });

    it("should revert with zero amounts", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));

      await expect(
        f.pool.connect(f.user1).deposit(0, usdc(2000), f.upperTick, f.lowerTick)
      ).to.be.revertedWithCustomError(f.pool, "ZeroAmount");

      await expect(
        f.pool.connect(f.user1).deposit(eth(1), 0, f.upperTick, f.lowerTick)
      ).to.be.revertedWithCustomError(f.pool, "ZeroAmount");
    });

    it("should revert with invalid tick range", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));

      await expect(
        f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.lowerTick, f.upperTick)
      ).to.be.revertedWithCustomError(f.pool, "InvalidTickRange");

      await expect(
        f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.upperTick)
      ).to.be.revertedWithCustomError(f.pool, "InvalidTickRange");
    });

    it("should revert with unaligned ticks", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));

      await expect(
        f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick + 3n, f.lowerTick)
      ).to.be.revertedWithCustomError(f.pool, "TickNotAligned");
    });

    it("should revert if upper tick >= current price tick", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));

      await expect(
        f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.currentTick, f.lowerTick)
      ).to.be.revertedWithCustomError(f.pool, "PositionUndercollateralized");
    });

    it("should track user position IDs", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(2));

      await f.pool.connect(f.user1).deposit(eth(1), usdc(1000), f.upperTick, f.lowerTick);
      await f.pool.connect(f.user1).deposit(eth(1), usdc(1000), f.upperTick, f.lowerTick);

      const ids = await f.pool.getUserPositions(await f.user1.getAddress());
      expect(ids.length).to.equal(2);
      expect(ids[0]).to.equal(1);
      expect(ids[1]).to.equal(2);
    });
  });

  // Close Position
  describe("Close Position", function () {
    it("should return collateral and clear position", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      await f.usdc.connect(f.user1).approve(await f.pool.getAddress(), usdc(2000));
      await f.pool.connect(f.user1).closePosition(1);

      const pos = await f.pool.positions(1);
      expect(pos.active).to.be.false;

      const wethBal = await f.weth.balanceOf(await f.user1.getAddress());
      expect(wethBal).to.be.closeTo(eth(1), eth(1) / 1000n);

      const midTick = f.lowerTick + BigInt(TICK_SPACING * 5);
      const tickInfo = await f.pool.tickData(midTick);
      expect(tickInfo.totalCollateral).to.equal(0);
      expect(tickInfo.totalDebt).to.equal(0);
    });

    it("should revert if not position owner", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      await expect(
        f.pool.connect(f.user2).closePosition(1)
      ).to.be.revertedWithCustomError(f.pool, "NotPositionOwner");
    });

    it("should revert if position already closed", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      await f.usdc.connect(f.user1).approve(await f.pool.getAddress(), usdc(2000));
      await f.pool.connect(f.user1).closePosition(1);

      await expect(
        f.pool.connect(f.user1).closePosition(1)
      ).to.be.revertedWithCustomError(f.pool, "PositionNotActive");
    });
  });

  // Partial Repay
  describe("Partial Repay", function () {
    it("should reduce debt proportionally across ticks", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2100), f.upperTick, f.lowerTick);

      await f.usdc.connect(f.user1).approve(await f.pool.getAddress(), usdc(1050));
      await f.pool.connect(f.user1).repay(1, usdc(1050));

      const [remainingDebt, remainingCollateral] = await f.pool.getPositionState(1);
      expect(remainingDebt).to.be.closeTo(usdc(1050), usdc(10));
      expect(remainingCollateral).to.be.closeTo(eth(1), eth(1) / 1000n);
    });

    it("should cap repayment at remaining debt", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      await f.usdc.mint(await f.user1.getAddress(), usdc(5000));
      await f.usdc.connect(f.user1).approve(await f.pool.getAddress(), usdc(5000));
      await f.pool.connect(f.user1).repay(1, usdc(5000));

      const [remainingDebt] = await f.pool.getPositionState(1);
      expect(remainingDebt).to.equal(0);
    });

    it("should revert with zero amount", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      await expect(
        f.pool.connect(f.user1).repay(1, 0)
      ).to.be.revertedWithCustomError(f.pool, "ZeroAmount");
    });
  });

  // Rebalance (Top-Down Liquidation)
  describe("Rebalance (Top-Down Liquidation)", function () {
    it("should liquidate ticks when price drops (single tick)", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      // Drop price below upper tick also activates auction (delta > 1%)
      const upperTickPrice = await f.engine.tickToPrice(f.upperTick);
      const dropPrice = upperTickPrice - upperTickPrice / 100n;
      await f.oracle.setPrice(dropPrice);

      // Fund liquidator request just the collateral in the upper tick
      const tickInfo = await f.pool.tickData(f.upperTick);
      await setupLiquidator(f, tickInfo.totalDebt * 3n);

      const liqWethBefore = await f.weth.balanceOf(await f.liquidator.getAddress());
      await f.pool.connect(f.liquidator).rebalance(tickInfo.totalCollateral, 0);
      const liqWethAfter = await f.weth.balanceOf(await f.liquidator.getAddress());

      expect(liqWethAfter).to.be.greaterThan(liqWethBefore);

      const tickAfter = await f.pool.tickData(f.upperTick);
      expect(tickAfter.liquidated).to.be.true;

      const [remainingDebt, remainingCollateral] = await f.pool.getPositionState(1);
      expect(remainingDebt).to.be.lessThan(usdc(2000));
      expect(remainingCollateral).to.be.lessThan(eth(1));
    });

    it("should process multiple ticks top-down in single call", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      // Drop price between the 3rd and 4th tick so exactly 3 ticks are liquidatable
      const thirdTick = f.upperTick - BigInt(TICK_SPACING * 2);
      const safeTick = thirdTick - BigInt(TICK_SPACING);
      const thirdTickPrice = await f.engine.tickToPrice(thirdTick);
      const safeTickPrice = await f.engine.tickToPrice(safeTick);
      const dropPrice = (thirdTickPrice + safeTickPrice) / 2n;
      await f.oracle.setPrice(dropPrice);

      // Request a large amount should only process 3 liquidatable ticks
      await setupLiquidator(f, usdc(500_000));
      await f.pool.connect(f.liquidator).rebalance(eth(100), 0);

      // All 3 ticks should be liquidated
      expect((await f.pool.tickData(f.upperTick)).liquidated).to.be.true;
      expect((await f.pool.tickData(f.upperTick - BigInt(TICK_SPACING))).liquidated).to.be.true;
      expect((await f.pool.tickData(thirdTick)).liquidated).to.be.true;

      // Lower ticks should not be liquidated (price is above safeTick)
      expect((await f.pool.tickData(safeTick)).liquidated).to.be.false;
    });

    it("should support partial tick liquidation", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      const upperTickPrice = await f.engine.tickToPrice(f.upperTick);
      const dropPrice = upperTickPrice - upperTickPrice / 100n;
      await f.oracle.setPrice(dropPrice);

      const tickInfo = await f.pool.tickData(f.upperTick);
      const halfCol = tickInfo.totalCollateral / 2n;

      await setupLiquidator(f, usdc(500_000));
      await f.pool.connect(f.liquidator).rebalance(halfCol, 0);

      // Tick should NOT be marked as liquidated (partial)
      const tickAfter = await f.pool.tickData(f.upperTick);
      expect(tickAfter.liquidated).to.be.false;
      expect(tickAfter.totalCollateral).to.be.closeTo(
        tickInfo.totalCollateral - halfCol,
        tickInfo.totalCollateral / 1000n
      );
      // Shares unchanged
      expect(tickAfter.totalShares).to.equal(tickInfo.totalShares);
    });

    it("partial tick affects all users proportionally", async function () {
      const f = await deployFixture();

      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      await setupUser(f, f.user2, eth(2));
      await f.pool.connect(f.user2).deposit(eth(2), usdc(4000), f.upperTick, f.lowerTick);

      const [, col1Before] = await f.pool.getPositionState(1);
      const [, col2Before] = await f.pool.getPositionState(2);

      // Drop price and partially liquidate upper tick
      const upperTickPrice = await f.engine.tickToPrice(f.upperTick);
      await f.oracle.setPrice(upperTickPrice - upperTickPrice / 100n);

      const tickInfo = await f.pool.tickData(f.upperTick);
      const halfCol = tickInfo.totalCollateral / 2n;

      await setupLiquidator(f, usdc(500_000));
      await f.pool.connect(f.liquidator).rebalance(halfCol, 0);

      const [, col1After] = await f.pool.getPositionState(1);
      const [, col2After] = await f.pool.getPositionState(2);

      // Both lost collateral
      expect(col1After).to.be.lessThan(col1Before);
      expect(col2After).to.be.lessThan(col2Before);

      // User2 lost ~2x what user1 lost (proportional to their shares)
      const col1Loss = col1Before - col1After;
      const col2Loss = col2Before - col2After;
      expect(col2Loss).to.be.closeTo(col1Loss * 2n, col1Loss / 3n);
    });

    it("should stop at non-liquidatable ticks", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      // Drop price to only liquidate the upper tick
      const upperTickPrice = await f.engine.tickToPrice(f.upperTick);
      const nextTick = f.upperTick - BigInt(TICK_SPACING);
      const nextTickPrice = await f.engine.tickToPrice(nextTick);
      // Set price between upper and next tick (only upper is liquidatable)
      const midPrice = (upperTickPrice + nextTickPrice) / 2n;
      await f.oracle.setPrice(midPrice);

      // Request a huge amount but should only get the upper tick's collateral
      await setupLiquidator(f, usdc(500_000));
      const tickInfo = await f.pool.tickData(f.upperTick);

      await f.pool.connect(f.liquidator).rebalance(eth(100), 0);

      expect((await f.pool.tickData(f.upperTick)).liquidated).to.be.true;
      expect((await f.pool.tickData(nextTick)).liquidated).to.be.false;

      // Liquidator received less than total collateral (only debt-equivalent at exec price)
      const liqWeth = await f.weth.balanceOf(await f.liquidator.getAddress());
      expect(liqWeth).to.be.greaterThan(0);
      expect(liqWeth).to.be.lessThan(tickInfo.totalCollateral);
    });

    it("should revert when auction not active (no price change)", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);
      await setupLiquidator(f, usdc(10000));

      // Price unchanged → delta = 0 → auction not active
      await expect(
        f.pool.connect(f.liquidator).rebalance(eth(1), 0)
      ).to.be.revertedWithCustomError(f.pool, "AuctionNotActive");
    });

    it("should revert with zero weth requested", async function () {
      const f = await deployFixture();

      await expect(
        f.pool.connect(f.liquidator).rebalance(0, 0)
      ).to.be.revertedWithCustomError(f.pool, "ZeroWethRequested");
    });

    it("should collect fee and send to feeRecipient", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      const upperTickPrice = await f.engine.tickToPrice(f.upperTick);
      await f.oracle.setPrice(upperTickPrice - upperTickPrice / 100n);

      const tickInfo = await f.pool.tickData(f.upperTick);
      await setupLiquidator(f, usdc(500_000));

      const deployerUsdcBefore = await f.usdc.balanceOf(await f.deployer.getAddress());
      await f.pool.connect(f.liquidator).rebalance(tickInfo.totalCollateral, 0);
      const deployerUsdcAfter = await f.usdc.balanceOf(await f.deployer.getAddress());

      // Fee recipient (deployer) received fee
      const feeReceived = deployerUsdcAfter - deployerUsdcBefore;
      expect(feeReceived).to.be.greaterThan(0);
    });

    it("should update auction state after rebalance", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      const upperTickPrice = await f.engine.tickToPrice(f.upperTick);
      const dropPrice = upperTickPrice - upperTickPrice / 100n;
      await f.oracle.setPrice(dropPrice);

      const tickInfo = await f.pool.tickData(f.upperTick);
      await setupLiquidator(f, usdc(500_000));
      await f.pool.connect(f.liquidator).rebalance(tickInfo.totalCollateral, 0);

      // lastRebalancePrice should be updated to the drop price
      expect(await f.pool.lastRebalancePrice()).to.equal(dropPrice);
    });

    it("user can close position after partial liquidation", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      const upperTickPrice = await f.engine.tickToPrice(f.upperTick);
      await f.oracle.setPrice(upperTickPrice - upperTickPrice / 100n);
      await setupLiquidator(f, usdc(100000));

      const tickInfo = await f.pool.tickData(f.upperTick);
      await f.pool.connect(f.liquidator).rebalance(tickInfo.totalCollateral, 0);

      // Restore price
      await f.oracle.setPrice(price8(3500));

      const [remainingDebt] = await f.pool.getPositionState(1);
      await f.usdc.mint(await f.user1.getAddress(), remainingDebt);
      await f.usdc.connect(f.user1).approve(await f.pool.getAddress(), remainingDebt);
      await f.pool.connect(f.user1).closePosition(1);

      expect((await f.pool.positions(1)).active).to.be.false;

      const wethBal = await f.weth.balanceOf(await f.user1.getAddress());
      expect(wethBal).to.be.greaterThan(0);
      expect(wethBal).to.be.lessThan(eth(1));
    });

    it("full tick liquidation leaves excess collateral for users via surplus", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      // Set price between upper and next tick so only 1 tick is liquidatable
      const upperTickPrice = await f.engine.tickToPrice(f.upperTick);
      const nextTick = f.upperTick - BigInt(TICK_SPACING);
      const nextTickPrice = await f.engine.tickToPrice(nextTick);
      const dropPrice = (upperTickPrice + nextTickPrice) / 2n;
      await f.oracle.setPrice(dropPrice);

      const tickBefore = await f.pool.tickData(f.upperTick);
      await setupLiquidator(f, usdc(500_000));

      // Request a large amount only the upper tick will be processed
      await f.pool.connect(f.liquidator).rebalance(eth(100), 0);

      // Tick is marked as liquidated with clean state (surplus stored separately)
      const tickAfter = await f.pool.tickData(f.upperTick);
      expect(tickAfter.liquidated).to.be.true;
      expect(tickAfter.totalDebt).to.equal(0);
      expect(tickAfter.totalCollateral).to.equal(0);
      expect(tickAfter.totalShares).to.equal(0);
      // Generation was bumped
      expect(tickAfter.generation).to.equal(tickBefore.generation + 1n);

      // Surplus is stored separately for old generation
      const surplus = await f.pool.tickSurplus(f.upperTick, tickBefore.generation);
      expect(surplus.totalCollateral).to.be.greaterThan(0);
      expect(surplus.totalShares).to.equal(tickBefore.totalShares);

      // Next tick was NOT liquidated
      expect((await f.pool.tickData(nextTick)).liquidated).to.be.false;

      // User can close and recover excess collateral from the surplus
      await f.oracle.setPrice(price8(3500));
      const [remainingDebt, remainingCollateral] = await f.pool.getPositionState(1);
      expect(remainingDebt).to.be.lessThan(usdc(2000));
      // Remaining collateral includes excess from the liquidated tick via surplus
      expect(remainingCollateral).to.be.greaterThan(eth(1) - tickBefore.totalCollateral);

      await f.usdc.mint(await f.user1.getAddress(), remainingDebt);
      await f.usdc.connect(f.user1).approve(await f.pool.getAddress(), remainingDebt);
      await f.pool.connect(f.user1).closePosition(1);

      const wethBal = await f.weth.balanceOf(await f.user1.getAddress());
      expect(wethBal).to.be.greaterThan(eth(1) - tickBefore.totalCollateral);
    });

    it("sequential rebalances with incremental price drops", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      await setupLiquidator(f, usdc(500_000));

      // First drop: liquidate upper tick
      const upperTickPrice = await f.engine.tickToPrice(f.upperTick);
      const dropPrice1 = upperTickPrice - upperTickPrice / 100n;
      await f.oracle.setPrice(dropPrice1);

      const tick1Info = await f.pool.tickData(f.upperTick);
      await f.pool.connect(f.liquidator).rebalance(tick1Info.totalCollateral, 0);
      expect((await f.pool.tickData(f.upperTick)).liquidated).to.be.true;

      // Second drop: need >1% drop from lastRebalancePrice (which is now dropPrice1)
      // Drop to a price that's well below the next tick and >1% below dropPrice1
      const nextTick = f.upperTick - BigInt(TICK_SPACING);
      const nextTickPrice = await f.engine.tickToPrice(nextTick);
      // Ensure at least 2% below dropPrice1 (which is the new lastRebalancePrice)
      const dropPrice2 = dropPrice1 * 97n / 100n;
      // Make sure it's also below nextTickPrice
      const finalPrice2 = dropPrice2 < nextTickPrice ? dropPrice2 : nextTickPrice - nextTickPrice / 50n;
      await f.oracle.setPrice(finalPrice2);

      const tick2Info = await f.pool.tickData(nextTick);
      await f.pool.connect(f.liquidator).rebalance(tick2Info.totalCollateral, 0);
      expect((await f.pool.tickData(nextTick)).liquidated).to.be.true;

      const activeCount = await f.pool.getActiveTickCount(1);
      expect(activeCount).to.equal(f.numTicks - 2);
    });
  });

  // Dutch Auction
  describe("Dutch Auction", function () {
    it("deviation increases over time", async function () {
      const f = await deployFixture();

      const dev0 = await f.engine.computeDeviation(0);
      const dev10 = await f.engine.computeDeviation(10);
      const dev100 = await f.engine.computeDeviation(100);

      expect(dev0).to.equal(50); // d0
      expect(dev10).to.equal(100); // d0 + rho * 10 = 50 + 5*10
      expect(dev100).to.equal(500); // capped at dMax
    });

    it("deviation is capped at dMax", async function () {
      const f = await deployFixture();

      const devHuge = await f.engine.computeDeviation(10000);
      expect(devHuge).to.equal(500); // dMax
    });

    it("execution price discounts for sell-side (price drop)", async function () {
      const f = await deployFixture();

      const oraclePrice = price8(3000);
      const internalPrice = price8(3500);
      const delta = await f.engine.computeDelta(oraclePrice, internalPrice);
      expect(delta).to.be.lessThan(0); // sell-side

      const deviation = 200n; // 2%
      const execPrice = await f.engine.computeExecutionPrice(oraclePrice, delta, deviation);
      // execPrice = 3000 * (10000 - 200) / 10000 = 3000 * 0.98 = 2940
      expect(execPrice).to.equal(price8(3000) * 9800n / 10000n);
    });

    it("fee computation is correct", async function () {
      const f = await deployFixture();
      const fee = await f.engine.computeFee(usdc(10000));
      // phi = 10 BPS = 0.1%, fee = 10000 * 10 / 10000 = 10 USDC
      expect(fee).to.equal(usdc(10));
    });

    it("getAuctionState returns correct values", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      // No price change → auction inactive
      const [delta1, , , active1] = await f.pool.getAuctionState();
      expect(delta1).to.equal(0);
      expect(active1).to.be.false;

      // Drop price → auction activates
      await f.oracle.setPrice(price8(3000));
      const [delta2, , , active2] = await f.pool.getAuctionState();
      expect(delta2).to.be.lessThan(0);
      expect(active2).to.be.true;
    });
  });

  // Multiple Users
  describe("Multiple Users", function () {
    it("two users in same tick range get proportional shares", async function () {
      const f = await deployFixture();

      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      await setupUser(f, f.user2, eth(2));
      await f.pool.connect(f.user2).deposit(eth(2), usdc(4000), f.upperTick, f.lowerTick);

      const midTick = f.lowerTick + BigInt(TICK_SPACING * 10);
      const shares1 = await f.pool.positionShares(1, midTick);
      const shares2 = await f.pool.positionShares(2, midTick);
      expect(shares2).to.be.closeTo(shares1 * 2n, shares1 / 100n);

      const tickInfo = await f.pool.tickData(midTick);
      const expectedCol = eth(3) / BigInt(f.numTicks);
      expect(tickInfo.totalCollateral).to.be.closeTo(expectedCol, expectedCol / 100n);
    });

    it("liquidation of shared tick affects both users proportionally", async function () {
      const f = await deployFixture();

      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      await setupUser(f, f.user2, eth(2));
      await f.pool.connect(f.user2).deposit(eth(2), usdc(4000), f.upperTick, f.lowerTick);

      const [debt1Before, col1Before] = await f.pool.getPositionState(1);
      const [debt2Before, col2Before] = await f.pool.getPositionState(2);

      // Drop price and liquidate upper tick
      const upperTickPrice = await f.engine.tickToPrice(f.upperTick);
      await f.oracle.setPrice(upperTickPrice - upperTickPrice / 100n);

      const tickInfo = await f.pool.tickData(f.upperTick);
      await setupLiquidator(f, usdc(500000));
      await f.pool.connect(f.liquidator).rebalance(tickInfo.totalCollateral, 0);

      const [debt1After, col1After] = await f.pool.getPositionState(1);
      const [debt2After, col2After] = await f.pool.getPositionState(2);

      expect(col1After).to.be.lessThan(col1Before);
      expect(col2After).to.be.lessThan(col2Before);
      expect(debt1After).to.be.lessThan(debt1Before);
      expect(debt2After).to.be.lessThan(debt2Before);

      const col1Loss = col1Before - col1After;
      const col2Loss = col2Before - col2After;
      expect(col2Loss).to.be.closeTo(col1Loss * 2n, col1Loss / 5n);
    });

    it("users depositing at different times get fair shares", async function () {
      const f = await deployFixture();

      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      await f.networkHelpers.mine();

      await setupUser(f, f.user2, eth(1));
      await f.pool.connect(f.user2).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      const midTick = f.lowerTick + BigInt(TICK_SPACING * 10);
      const shares1 = await f.pool.positionShares(1, midTick);
      const shares2 = await f.pool.positionShares(2, midTick);
      expect(shares1).to.equal(shares2);

      const [debt1, col1] = await f.pool.getPositionState(1);
      const [debt2, col2] = await f.pool.getPositionState(2);
      expect(col1).to.be.closeTo(col2, col1 / 1000n);
      expect(debt1).to.be.closeTo(debt2, debt1 / 1000n);
    });

    it("user can close after other user's ticks get liquidated", async function () {
      const f = await deployFixture();

      await setupUser(f, f.user1, eth(1));
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      await setupUser(f, f.user2, eth(1));
      await f.pool.connect(f.user2).deposit(eth(1), usdc(2000), f.upperTick, f.lowerTick);

      // Liquidate upper tick
      const upperTickPrice = await f.engine.tickToPrice(f.upperTick);
      await f.oracle.setPrice(upperTickPrice - upperTickPrice / 100n);

      const tickInfo = await f.pool.tickData(f.upperTick);
      await setupLiquidator(f, usdc(500000));
      await f.pool.connect(f.liquidator).rebalance(tickInfo.totalCollateral, 0);

      // Restore price
      await f.oracle.setPrice(price8(3500));

      // User 1 closes
      const [remainingDebt1] = await f.pool.getPositionState(1);
      await f.usdc.mint(await f.user1.getAddress(), remainingDebt1);
      await f.usdc.connect(f.user1).approve(await f.pool.getAddress(), remainingDebt1);
      await f.pool.connect(f.user1).closePosition(1);

      // User 2 still has position
      const [debt2, col2] = await f.pool.getPositionState(2);
      expect(debt2).to.be.greaterThan(0);
      expect(col2).to.be.greaterThan(0);
    });
  });

  // Edge Cases
  describe("Edge Cases", function () {
    it("position with minimum tick range (2 ticks)", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));

      const upper = f.upperTick;
      const lower = upper - BigInt(TICK_SPACING);
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), upper, lower);

      const [debt, col] = await f.pool.getPositionState(1);
      expect(col).to.be.closeTo(eth(1), eth(1) / 1000n);
      expect(debt).to.be.closeTo(usdc(2000), usdc(1));
    });

    it("close position when all ticks have been liquidated", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(1));

      const upper = f.upperTick;
      const lower = upper - BigInt(TICK_SPACING);
      await f.pool.connect(f.user1).deposit(eth(1), usdc(2000), upper, lower);

      await setupLiquidator(f, usdc(500000));

      // Liquidate both ticks by dropping price below both and requesting all
      const price2 = await f.engine.tickToPrice(lower);
      await f.oracle.setPrice(price2 - price2 / 100n);

      // Request enough to cover both ticks
      await f.pool.connect(f.liquidator).rebalance(eth(2), 0);

      expect((await f.pool.tickData(upper)).liquidated).to.be.true;
      expect((await f.pool.tickData(lower)).liquidated).to.be.true;

      await f.pool.connect(f.user1).closePosition(1);
      expect((await f.pool.positions(1)).active).to.be.false;
    });

    it("getPositionState returns zero for non-existent position", async function () {
      const f = await deployFixture();
      const [debt, col] = await f.pool.getPositionState(999);
      expect(debt).to.equal(0);
      expect(col).to.equal(0);
    });

    it("multiple positions from same user with different ranges", async function () {
      const f = await deployFixture();
      await setupUser(f, f.user1, eth(3));

      await f.pool.connect(f.user1).deposit(eth(1), usdc(1000), f.upperTick, f.lowerTick);

      const narrowUpper = f.upperTick - BigInt(TICK_SPACING * 5);
      const narrowLower = f.lowerTick + BigInt(TICK_SPACING * 5);
      await f.pool.connect(f.user1).deposit(eth(1), usdc(1000), narrowUpper, narrowLower);

      const [debt1, col1] = await f.pool.getPositionState(1);
      const [debt2, col2] = await f.pool.getPositionState(2);
      expect(col1).to.be.closeTo(eth(1), eth(1) / 100n);
      expect(col2).to.be.closeTo(eth(1), eth(1) / 100n);
      expect(debt1).to.be.closeTo(usdc(1000), usdc(5));
      expect(debt2).to.be.closeTo(usdc(1000), usdc(5));
    });
  });

  // Oracle
  describe("Oracle", function () {
    it("should return manual price when only one observation", async function () {
      const f = await deployFixture();
      expect(await f.oracle.getPrice()).to.equal(price8(3500));
    });

    it("should compute TWAP over multiple observations", async function () {
      const f = await deployFixture();
      await f.oracle.setTwapWindow(10000);

      await f.networkHelpers.time.increase(60);
      await f.oracle.setPrice(price8(3400));

      const twap = await f.oracle.getPrice();
      expect(twap).to.be.greaterThanOrEqual(price8(3400));
      expect(twap).to.be.lessThanOrEqual(price8(3500));
    });

    it("latest price should return most recent", async function () {
      const f = await deployFixture();
      await f.oracle.setPrice(price8(3200));
      expect(await f.oracle.getLatestPrice()).to.equal(price8(3200));
    });
  });
});
