import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import type { Contracts } from "../App";
import { IS_FORK } from "../App";

interface Props {
  contracts: Contracts;
  account: string;
  onTx: () => void;
}

interface PositionData {
  id: number;
  owner: string;
  upperTick: number;
  lowerTick: number;
  collateral: bigint;
  debt: bigint;
  active: boolean;
  remainingDebt: bigint;
  remainingCollateral: bigint;
  activeTicks: number;
}

const TICK_SPACING = 10;

export default function Positions({ contracts, account, onTx }: Props) {
  const [positions, setPositions] = useState<PositionData[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ msg: string; type: string } | null>(null);

  // Form state
  const [wethAmount, setWethAmount] = useState("1");
  const [usdcBorrow, setUsdcBorrow] = useState(IS_FORK ? "1500" : "2000");
  const [upperPrice, setUpperPrice] = useState(IS_FORK ? "2100" : "3400");
  const [lowerPrice, setLowerPrice] = useState(IS_FORK ? "2050" : "3350");
  const [repayAmounts, setRepayAmounts] = useState<Record<number, string>>({});
  const [tickCount, setTickCount] = useState<number | null>(null);

  // Estimate tick count when prices change
  useEffect(() => {
    (async () => {
      try {
        if (!upperPrice || !lowerPrice) { setTickCount(null); return; }
        const uTick = Number(await contracts.engine.priceToTick(ethers.parseUnits(upperPrice, 8)));
        const lTick = Number(await contracts.engine.priceToTick(ethers.parseUnits(lowerPrice, 8)));
        const aligned = (t: number) => Math.floor(t / TICK_SPACING) * TICK_SPACING;
        const count = (aligned(uTick) - aligned(lTick)) / TICK_SPACING + 1;
        setTickCount(count > 0 ? count : null);
      } catch { setTickCount(null); }
    })();
  }, [upperPrice, lowerPrice, contracts]);

  const loadPositions = useCallback(async () => {
    try {
      const ids: bigint[] = await contracts.pool.getUserPositions(account);
      const results: PositionData[] = [];

      for (const id of ids) {
        const pos = await contracts.pool.positions(id);
        const [remainingDebt, remainingCollateral] = await contracts.pool.getPositionState(id);
        const activeTicks = await contracts.pool.getActiveTickCount(id);

        results.push({
          id: Number(id),
          owner: pos.owner,
          upperTick: Number(pos.upperTick),
          lowerTick: Number(pos.lowerTick),
          collateral: pos.collateral,
          debt: pos.debt,
          active: pos.active,
          remainingDebt,
          remainingCollateral,
          activeTicks: Number(activeTicks),
        });
      }

      setPositions(results);
    } catch (e) {
      console.error("Load positions failed:", e);
    }
  }, [contracts, account]);

  useEffect(() => {
    loadPositions();
  }, [loadPositions]);

  async function openPosition() {
    setLoading(true);
    setStatus(null);
    try {
      const weth = ethers.parseEther(wethAmount);
      const usdc = ethers.parseUnits(usdcBorrow, 6);

      // Convert prices to ticks
      const upperTick = Number(await contracts.engine.priceToTick(
        ethers.parseUnits(upperPrice, 8)
      ));
      const lowerTick = Number(await contracts.engine.priceToTick(
        ethers.parseUnits(lowerPrice, 8)
      ));

      // Align ticks
      const alignedUpper = Math.floor(upperTick / TICK_SPACING) * TICK_SPACING;
      const alignedLower = Math.floor(lowerTick / TICK_SPACING) * TICK_SPACING;

      // Approve WETH
      const poolAddr = await contracts.pool.getAddress();
      const tx0 = await contracts.weth.approve(poolAddr, weth);
      await tx0.wait();

      // Deposit
      const tx = await contracts.pool.deposit(weth, usdc, alignedUpper, alignedLower);
      const receipt = await tx.wait();

      const gasUsed = Number(receipt.gasUsed).toLocaleString();
      setStatus({ msg: `Position opened! Gas used: ${gasUsed}`, type: "success" });
      loadPositions();
      onTx();
    } catch (e: any) {
      const reason = e.reason || e.shortMessage || e.message;
      setStatus({ msg: `Error: ${reason}`, type: "error" });
    }
    setLoading(false);
  }

  async function closePosition(id: number) {
    setLoading(true);
    setStatus(null);
    try {
      // Get remaining debt and approve USDC
      const [remainingDebt] = await contracts.pool.getPositionState(id);
      if (remainingDebt > 0n) {
        const poolAddr = await contracts.pool.getAddress();
        const tx0 = await contracts.usdc.approve(poolAddr, remainingDebt);
        await tx0.wait();
      }

      const tx = await contracts.pool.closePosition(id);
      const receipt = await tx.wait();

      const gasUsed = Number(receipt.gasUsed).toLocaleString();
      setStatus({ msg: `Position #${id} closed. Gas used: ${gasUsed}`, type: "success" });
      loadPositions();
      onTx();
    } catch (e: any) {
      const reason = e.reason || e.shortMessage || e.message;
      setStatus({ msg: `Error: ${reason}`, type: "error" });
    }
    setLoading(false);
  }

  async function repay(id: number) {
    const amt = repayAmounts[id];
    if (!amt) return;
    setLoading(true);
    setStatus(null);
    try {
      const usdc = ethers.parseUnits(amt, 6);
      const poolAddr = await contracts.pool.getAddress();
      const tx0 = await contracts.usdc.approve(poolAddr, usdc);
      await tx0.wait();

      const tx = await contracts.pool.repay(id, usdc);
      await tx.wait();

      setStatus({ msg: `Repaid ${amt} USDC on position #${id}`, type: "success" });
      setRepayAmounts((prev) => ({ ...prev, [id]: "" }));
      loadPositions();
      onTx();
    } catch (e: any) {
      const reason = e.reason || e.shortMessage || e.message;
      setStatus({ msg: `Error: ${reason}`, type: "error" });
    }
    setLoading(false);
  }

  const fmtWeth = (v: bigint) => Number(ethers.formatEther(v)).toFixed(6);
  const fmtUsdc = (v: bigint) => Number(ethers.formatUnits(v, 6)).toFixed(2);

  return (
    <>
      {status && (
        <div className={`status-bar status-${status.type}`}>{status.msg}</div>
      )}

      {/* Open Position Form */}
      <div className="card">
        <h3>Open Position</h3>
        <div className="form-grid">
          <div className="form-group">
            <label>WETH Collateral</label>
            <input
              type="number"
              step="0.1"
              value={wethAmount}
              onChange={(e) => setWethAmount(e.target.value)}
              placeholder="1.0"
            />
          </div>
          <div className="form-group">
            <label>USDC Borrow</label>
            <input
              type="number"
              step="100"
              value={usdcBorrow}
              onChange={(e) => setUsdcBorrow(e.target.value)}
              placeholder="2000"
            />
          </div>
          <div className="form-group">
            <label>Upper Price (first liquidation)</label>
            <input
              type="number"
              step="10"
              value={upperPrice}
              onChange={(e) => setUpperPrice(e.target.value)}
              placeholder="3400"
            />
          </div>
          <div className="form-group">
            <label>Lower Price (full close)</label>
            <input
              type="number"
              step="10"
              value={lowerPrice}
              onChange={(e) => setLowerPrice(e.target.value)}
              placeholder="3350"
            />
          </div>
          {tickCount !== null && (
            <div className="form-group full" style={{ fontSize: 13, color: tickCount > 200 ? "var(--red)" : tickCount > 50 ? "var(--orange)" : "var(--text-dim)" }}>
              Ticks: {tickCount}{tickCount > 200 ? " (too many — may exceed gas limit)" : tickCount > 50 ? " (large range — higher gas cost)" : ""}
            </div>
          )}
          <div className="form-group full">
            <button
              className="btn btn-primary"
              onClick={openPosition}
              disabled={loading || (tickCount !== null && tickCount > 400)}
            >
              {loading ? "Processing..." : "Open Position"}
            </button>
          </div>
        </div>
      </div>

      {/* Positions List */}
      <div className="card">
        <h3>
          Your Positions
          <button
            className="btn btn-sm btn-outline"
            style={{ marginLeft: 12 }}
            onClick={loadPositions}
          >
            Refresh
          </button>
        </h3>

        {positions.length === 0 ? (
          <div className="empty">No positions yet</div>
        ) : (
          positions.map((pos) => (
            <div className="position-card" key={pos.id}>
              <div className="position-header">
                <span className="position-id">Position #{pos.id}</span>
                <span className={`badge ${pos.active ? "badge-active" : "badge-closed"}`}>
                  {pos.active ? "Active" : "Closed"}
                </span>
              </div>

              <div className="position-stats">
                <div>
                  <div className="stat-label">Collateral</div>
                  <div className="stat-value">{fmtWeth(pos.remainingCollateral)} WETH</div>
                </div>
                <div>
                  <div className="stat-label">Debt</div>
                  <div className="stat-value">{fmtUsdc(pos.remainingDebt)} USDC</div>
                </div>
                <div>
                  <div className="stat-label">Tick Range</div>
                  <div className="stat-value">{pos.lowerTick} .. {pos.upperTick}</div>
                </div>
                <div>
                  <div className="stat-label">Active Ticks</div>
                  <div className="stat-value">{pos.activeTicks}</div>
                </div>
              </div>

              {pos.active && (
                <div className="position-actions">
                  <button
                    className="btn btn-sm btn-red"
                    onClick={() => closePosition(pos.id)}
                    disabled={loading}
                  >
                    Close
                  </button>
                  <input
                    type="number"
                    placeholder="USDC amount"
                    value={repayAmounts[pos.id] || ""}
                    onChange={(e) =>
                      setRepayAmounts((prev) => ({
                        ...prev,
                        [pos.id]: e.target.value,
                      }))
                    }
                  />
                  <button
                    className="btn btn-sm btn-green"
                    onClick={() => repay(pos.id)}
                    disabled={loading || !repayAmounts[pos.id]}
                  >
                    Repay
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}
