import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import type { Contracts } from "../App";
import { IS_FORK } from "../App";
import { AAVE_POOL_ABI } from "../config/abi";
import addresses from "../config/deployed-addresses.json";

interface Props {
  contracts: Contracts;
  account: string;
}

const MAINNET_AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";

export default function Oracle({ contracts, account }: Props) {
  const [currentPrice, setCurrentPrice] = useState("");
  const [currentTick, setCurrentTick] = useState("");
  const [latestPrice, setLatestPrice] = useState("");
  const [internalPrice, setInternalPrice] = useState("");
  const [delta, setDelta] = useState("");
  const [auctionActive, setAuctionActive] = useState(false);
  const [newPrice, setNewPrice] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ msg: string; type: string } | null>(null);
  const [owner, setOwner] = useState("");
  const [contractError, setContractError] = useState("");
  const [useChainlink, setUseChainlink] = useState(false);
  const [manualOverrideActive, setManualOverrideActive] = useState(false);

  // Aave connection status
  const [aaveConnected, setAaveConnected] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [priceRes, latestRes, ownerRes, intPriceRes, auctionRes, chainlinkRes, overrideRes] =
        await Promise.allSettled([
          contracts.oracle.getPrice(),
          contracts.oracle.getLatestPrice(),
          contracts.oracle.owner(),
          contracts.pool.lastRebalancePrice(),
          contracts.pool.getAuctionState(),
          contracts.oracle.useChainlink(),
          contracts.oracle.manualOverrideExpiry(),
        ]);

      if (priceRes.status === "fulfilled") {
        const price = priceRes.value;
        setCurrentPrice(Number(ethers.formatUnits(price, 8)).toFixed(2));
        try {
          const tick = await contracts.engine.priceToTick(price);
          setCurrentTick(tick.toString());
        } catch { /* engine call failed */ }
      }
      if (latestRes.status === "fulfilled") {
        setLatestPrice(Number(ethers.formatUnits(latestRes.value, 8)).toFixed(2));
      }
      if (ownerRes.status === "fulfilled") {
        setOwner(ownerRes.value);
      }
      if (intPriceRes.status === "fulfilled") {
        setInternalPrice(Number(ethers.formatUnits(intPriceRes.value, 8)).toFixed(2));
      }
      if (auctionRes.status === "fulfilled") {
        const auctionState = auctionRes.value;
        setDelta((Number(auctionState.delta) / 100).toFixed(2));
        setAuctionActive(auctionState.active);
      }
      if (chainlinkRes.status === "fulfilled") {
        setUseChainlink(chainlinkRes.value);
      }
      if (overrideRes.status === "fulfilled") {
        const expiry = Number(overrideRes.value);
        const now = Math.floor(Date.now() / 1000);
        setManualOverrideActive(expiry > now);
      }

      const results = [priceRes, latestRes, ownerRes, intPriceRes, auctionRes];
      const failed = results.filter(r => r.status === "rejected");
      if (failed.length === results.length) {
        setContractError("Contracts not found. Run: npx hardhat node && npx hardhat run scripts/deploy.ts");
      } else {
        setContractError("");
      }

      // Aave connection check (fork mode only)
      if (IS_FORK) {
        try {
          const provider = contracts.pool.runner?.provider;
          if (provider) {
            const aavePool = new ethers.Contract(MAINNET_AAVE_POOL, AAVE_POOL_ABI, provider);
            await aavePool.getUserAccountData(addresses.adapter);
            setAaveConnected(true);
          }
        } catch {
          setAaveConnected(false);
        }
      }
    } catch (e) {
      console.error("Oracle refresh failed:", e);
    }
  }, [contracts]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const isOwner = owner.toLowerCase() === account.toLowerCase();

  async function setPrice() {
    if (!newPrice) return;
    setLoading(true);
    setStatus(null);
    try {
      const priceWei = ethers.parseUnits(newPrice, 8);
      const tx = await contracts.oracle.setPrice(priceWei);
      await tx.wait();

      setStatus({
        msg: `Price set to $${newPrice} (manual override active for 1 hour)`,
        type: "success",
      });
      setNewPrice("");
      refresh();
    } catch (e: any) {
      const reason = e.reason || e.shortMessage || e.message;
      setStatus({ msg: `Error: ${reason}`, type: "error" });
    }
    setLoading(false);
  }

  async function resetToChainlink() {
    setLoading(true);
    setStatus(null);
    try {
      const tx = await contracts.oracle.clearManualOverride();
      await tx.wait();
      setStatus({ msg: "Switched back to Chainlink oracle", type: "success" });
      refresh();
    } catch (e: any) {
      const reason = e.reason || e.shortMessage || e.message;
      setStatus({ msg: `Error: ${reason}`, type: "error" });
    }
    setLoading(false);
  }

  const priceSource = manualOverrideActive ? "Manual Override" : useChainlink ? "Chainlink" : "TWAP";

  return (
    <>
      {status && (
        <div className={`status-bar status-${status.type}`}>{status.msg}</div>
      )}

      {contractError && (
        <div className="status-bar status-error">{contractError}</div>
      )}

      <div className="card">
        <h3>Oracle Price</h3>
        <div className="price-display">
          <span className="dollar">$</span>
          {currentPrice || "..."}
        </div>

        <div style={{ padding: "0 8px" }}>
          <div className="info-row">
            <span className="label">Source</span>
            <span style={{ color: manualOverrideActive ? "var(--orange)" : "var(--green)" }}>
              {priceSource}
            </span>
          </div>
          <div className="info-row">
            <span className="label">Latest Price</span>
            <span>${latestPrice}</span>
          </div>
          <div className="info-row">
            <span className="label">Current Tick</span>
            <span>{currentTick}</span>
          </div>
          <div className="info-row">
            <span className="label">Internal Price (P_int)</span>
            <span>${internalPrice}</span>
          </div>
          <div className="info-row">
            <span className="label">Delta</span>
            <span style={{ color: auctionActive ? "var(--red)" : "inherit" }}>
              {delta}% {auctionActive ? "(auction active)" : ""}
            </span>
          </div>
        </div>
      </div>

      {/* Aave connection indicator (fork mode) */}
      {IS_FORK && aaveConnected !== null && (
        <div className="card">
          <h3>Aave V3</h3>
          <div style={{ padding: "0 8px" }}>
            <div className="info-row">
              <span className="label">Status</span>
              <span style={{ color: aaveConnected ? "var(--green)" : "var(--red)" }}>
                {aaveConnected ? "Connected (mainnet fork)" : "Not connected"}
              </span>
            </div>
            <div className="info-row">
              <span className="label">Pool</span>
              <span style={{ fontSize: 12 }}>{MAINNET_AAVE_POOL}</span>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h3>Set Price</h3>

        {!isOwner && (
          <div className="status-bar status-info" style={{ marginBottom: 12 }}>
            Only the Deployer account can change the oracle price. Switch to Deployer in the header.
          </div>
        )}

        <p style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 12 }}>
          Change the oracle price to simulate market movements. Lower the price to make ticks liquidatable.
          {manualOverrideActive && " Manual override is active — price comes from the last setPrice() call."}
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="number"
            step="50"
            value={newPrice}
            onChange={(e) => setNewPrice(e.target.value)}
            placeholder="e.g. 3000"
            style={{ flex: 1 }}
          />
          <button
            className="btn btn-primary"
            onClick={setPrice}
            disabled={loading || !newPrice || !isOwner}
          >
            {loading ? "..." : "Set Price"}
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          {(IS_FORK
            ? [2100, 2000, 1800, 1500, 1000]
            : [3500, 3200, 3000, 2800, 2500]
          ).map((p) => (
            <button
              key={p}
              className="btn btn-sm btn-outline"
              onClick={() => setNewPrice(String(p))}
              disabled={!isOwner}
            >
              ${p}
            </button>
          ))}
        </div>

        {/* Reset to Chainlink button */}
        {useChainlink && manualOverrideActive && (
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
            <button
              className="btn btn-primary"
              onClick={resetToChainlink}
              disabled={loading || !isOwner}
              style={{ width: "100%" }}
            >
              {loading ? "..." : "Reset to Chainlink Price"}
            </button>
            <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>
              Clears manual override and returns to the real Chainlink ETH/USD feed.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
