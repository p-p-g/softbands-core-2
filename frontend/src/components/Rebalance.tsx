import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import type { Contracts } from "../App";

interface Props {
  contracts: Contracts;
  account: string;
  onTx: () => void;
}

interface TickRow {
  tick: number;
  price: string;
  totalCollateral: bigint;
  totalDebt: bigint;
  liquidated: boolean;
  liquidatable: boolean;
}

interface AuctionState {
  delta: bigint;
  deviation: bigint;
  execPrice: bigint;
  active: boolean;
  oraclePrice: bigint;
  internalPrice: bigint;
}

const TICK_SPACING = 10;

export default function Rebalance({ contracts, account, onTx }: Props) {
  const [ticks, setTicks] = useState<TickRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState<{ msg: string; type: string } | null>(null);
  const [wethWanted, setWethWanted] = useState("");
  const [auction, setAuction] = useState<AuctionState | null>(null);

  const [contractError, setContractError] = useState("");

  const refreshAuction = useCallback(async () => {
    try {
      const [auctionState, oraclePrice, internalPrice] = await Promise.all([
        contracts.pool.getAuctionState(),
        contracts.oracle.getPrice(),
        contracts.pool.lastRebalancePrice(),
      ]);
      setAuction({
        delta: auctionState.delta,
        deviation: auctionState.deviation,
        execPrice: auctionState.execPrice,
        active: auctionState.active,
        oraclePrice,
        internalPrice,
      });
      setContractError("");
    } catch (e: any) {
      console.error("Auction state refresh failed:", e);
      setContractError("Contracts not found. Run: npx hardhat node && npx hardhat run scripts/deploy.ts");
    }
  }, [contracts]);

  const scanTicks = useCallback(async () => {
    setScanning(true);
    try {
      const nextId = Number(await contracts.pool.nextPositionId());
      const tickSet = new Set<number>();

      for (let id = 1; id < nextId; id++) {
        const pos = await contracts.pool.positions(id);
        if (!pos.active) continue;
        const lower = Number(pos.lowerTick);
        const upper = Number(pos.upperTick);
        for (let t = lower; t <= upper; t += TICK_SPACING) {
          tickSet.add(t);
        }
      }

      const rows: TickRow[] = [];
      for (const tick of Array.from(tickSet).sort((a, b) => b - a)) {
        const data = await contracts.pool.tickData(tick);
        if (data.totalCollateral === 0n && !data.liquidated) continue;

        let liquidatable = false;
        if (data.totalCollateral > 0n && !data.liquidated) {
          liquidatable = await contracts.pool.isTickLiquidatable(tick);
        }

        const priceRaw = await contracts.engine.tickToPrice(tick);
        const price = Number(ethers.formatUnits(priceRaw, 8)).toFixed(2);

        rows.push({
          tick,
          price,
          totalCollateral: data.totalCollateral,
          totalDebt: data.totalDebt,
          liquidated: data.liquidated,
          liquidatable,
        });
      }

      setTicks(rows);
    } catch (e) {
      console.error("Scan failed:", e);
    }
    setScanning(false);
  }, [contracts]);

  useEffect(() => {
    scanTicks();
    refreshAuction();
    const interval = setInterval(refreshAuction, 3000);
    return () => clearInterval(interval);
  }, [scanTicks, refreshAuction]);

  // Compute estimated USDC cost
  const estimatedUsdc = (() => {
    if (!wethWanted || !auction?.execPrice) return null;
    try {
      const wethWei = ethers.parseEther(wethWanted);
      const usdcWei = (wethWei * auction.execPrice) / BigInt(1e20);
      return Number(ethers.formatUnits(usdcWei, 6)).toFixed(2);
    } catch {
      return null;
    }
  })();

  // Total liquidatable WETH — capped by debt at execution price
  // The liquidator can only take WETH worth the debt, not the full collateral
  const totalLiquidatableWeth = (() => {
    if (!auction?.execPrice || auction.execPrice === 0n) return 0n;
    const liquidatable = ticks.filter((t) => t.liquidatable);
    let total = 0n;
    for (const t of liquidatable) {
      // WETH equivalent of this tick's debt at execution price
      const colForDebt = (t.totalDebt * BigInt(1e20)) / auction.execPrice;
      // Capped by actual collateral
      total += colForDebt < t.totalCollateral ? colForDebt : t.totalCollateral;
    }
    return total;
  })();

  async function executeRebalance() {
    if (!wethWanted) return;
    setLoading(true);
    setStatus(null);
    try {
      const wethAmount = ethers.parseEther(wethWanted);
      const poolAddr = await contracts.pool.getAddress();

      // Approve generous USDC amount (estimated * 2 for safety)
      const estimatedUsdcWei = auction?.execPrice
        ? (wethAmount * auction.execPrice * 3n) / BigInt(1e20)
        : ethers.parseUnits("100000", 6);
      const tx0 = await contracts.usdc.approve(poolAddr, estimatedUsdcWei);
      await tx0.wait();

      // maxUsdcCost = estimated * 1.5 for slippage protection
      const maxUsdcCost = auction?.execPrice
        ? (wethAmount * auction.execPrice * 15n) / (BigInt(1e20) * 10n)
        : 0n;

      const tx = await contracts.pool.rebalance(wethAmount, maxUsdcCost);
      const receipt = await tx.wait();

      // Parse Rebalanced event
      const iface = contracts.pool.interface;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: log.topics, data: log.data });
          if (parsed?.name === "Rebalanced") {
            const debtPaid = Number(ethers.formatUnits(parsed.args.totalDebtRepaid, 6)).toFixed(2);
            const colSent = Number(ethers.formatEther(parsed.args.totalCollateralSent)).toFixed(6);
            const fee = Number(ethers.formatUnits(parsed.args.fee, 6)).toFixed(2);
            const ticksProcessed = parsed.args.ticksProcessed.toString();
            const gasUsed = Number(receipt.gasUsed).toLocaleString();
            setStatus({
              msg: `Rebalanced: ${ticksProcessed} ticks, paid ${debtPaid} USDC + ${fee} fee, received ${colSent} WETH. Gas: ${gasUsed}`,
              type: "success",
            });
          }
        } catch {}
      }

      setWethWanted("");
      scanTicks();
      refreshAuction();
      onTx();
    } catch (e: any) {
      const reason = e.reason || e.shortMessage || e.message;
      setStatus({ msg: `Error: ${reason}`, type: "error" });
    }
    setLoading(false);
  }

  const fmtWeth = (v: bigint) => Number(ethers.formatEther(v)).toFixed(6);
  const fmtUsdc = (v: bigint) => Number(ethers.formatUnits(v, 6)).toFixed(2);
  const fmtPrice = (v: bigint) => Number(ethers.formatUnits(v, 8)).toFixed(2);
  const fmtBps = (v: bigint) => (Number(v) / 100).toFixed(2);

  return (
    <>
      {status && (
        <div className={`status-bar status-${status.type}`}>{status.msg}</div>
      )}

      {contractError && (
        <div className="status-bar status-error">{contractError}</div>
      )}

      {/* Auction Status */}
      <div className="card">
        <h3>Dutch Auction Status</h3>
        {auction ? (
          <div style={{ padding: "0 8px" }}>
            <div className="info-row">
              <span className="label">Oracle Price</span>
              <span>${fmtPrice(auction.oraclePrice)}</span>
            </div>
            <div className="info-row">
              <span className="label">Internal Price (P_int)</span>
              <span>${fmtPrice(auction.internalPrice)}</span>
            </div>
            <div className="info-row">
              <span className="label">Delta</span>
              <span style={{ color: auction.active ? "var(--red)" : "var(--green)" }}>
                {fmtBps(auction.delta)}% {auction.active ? "(auction active)" : "(below threshold)"}
              </span>
            </div>
            <div className="info-row">
              <span className="label">Deviation (discount)</span>
              <span>{fmtBps(auction.deviation)}%</span>
            </div>
            <div className="info-row">
              <span className="label">Execution Price</span>
              <span>${fmtPrice(auction.execPrice)}</span>
            </div>
          </div>
        ) : (
          <div className="empty">Loading auction state...</div>
        )}
      </div>

      {/* Rebalance Form */}
      <div className="card">
        <h3>Execute Rebalance</h3>

        {auction && !auction.active && (
          <div className="status-bar status-info" style={{ marginBottom: 12 }}>
            Auction is not active. Drop the oracle price (via Oracle tab) to create &gt;1% deviation from the internal price.
          </div>
        )}

        <p style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 12 }}>
          Specify how much WETH you want to buy. Ticks are processed top-down (highest price first).
          {totalLiquidatableWeth > 0n && (
            <> Available: <strong>{fmtWeth(totalLiquidatableWeth)} WETH</strong> across {ticks.filter(t => t.liquidatable).length} liquidatable ticks.</>
          )}
        </p>

        <div style={{ display: "flex", gap: 8, alignItems: "end" }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12, color: "var(--text-dim)" }}>WETH Amount</label>
            <input
              type="number"
              step="0.01"
              value={wethWanted}
              onChange={(e) => setWethWanted(e.target.value)}
              placeholder="e.g. 0.5"
            />
          </div>
          <button
            className="btn btn-primary"
            onClick={executeRebalance}
            disabled={loading || !wethWanted || !auction?.active}
            style={{ height: 38 }}
          >
            {loading ? "Processing..." : "Rebalance"}
          </button>
        </div>

        {estimatedUsdc && (
          <div style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 8 }}>
            Estimated cost: ~{estimatedUsdc} USDC
          </div>
        )}

        {totalLiquidatableWeth > 0n && (
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              className="btn btn-sm btn-outline"
              onClick={() => setWethWanted(ethers.formatEther(totalLiquidatableWeth))}
            >
              Max ({fmtWeth(totalLiquidatableWeth)})
            </button>
            <button
              className="btn btn-sm btn-outline"
              onClick={() => setWethWanted(ethers.formatEther(totalLiquidatableWeth / 2n))}
            >
              Half
            </button>
          </div>
        )}
      </div>

      {/* Tick Overview Table */}
      <div className="card">
        <h3>
          Active Ticks
          <button
            className="btn btn-sm btn-outline"
            style={{ marginLeft: 12 }}
            onClick={() => { scanTicks(); refreshAuction(); }}
            disabled={scanning}
          >
            {scanning ? "Scanning..." : "Refresh"}
          </button>
        </h3>

        {ticks.length === 0 ? (
          <div className="empty">
            {scanning ? "Scanning ticks..." : "No active ticks found. Open a position first."}
          </div>
        ) : (
          <table className="tick-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Tick</th>
                <th>Price</th>
                <th>Collateral</th>
                <th>Debt</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                let order = 0;
                return ticks.map((row) => {
                  if (row.liquidatable) order++;
                  return (
                    <tr
                      key={row.tick}
                      className={row.liquidatable ? "liquidatable" : ""}
                    >
                      <td style={{ color: row.liquidatable ? "var(--orange)" : "var(--text-dim)" }}>
                        {row.liquidatable ? order : ""}
                      </td>
                      <td>{row.tick}</td>
                      <td>${row.price}</td>
                      <td>{fmtWeth(row.totalCollateral)} WETH</td>
                      <td>{fmtUsdc(row.totalDebt)} USDC</td>
                      <td>
                        {row.liquidated ? (
                          <span className="badge badge-closed">Liquidated</span>
                        ) : row.liquidatable ? (
                          <span className="badge badge-liquidatable">Liquidatable</span>
                        ) : (
                          <span className="badge badge-active">Safe</span>
                        )}
                      </td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
