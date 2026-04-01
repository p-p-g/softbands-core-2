import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import addresses from "./config/deployed-addresses.json";
import { POOL_ABI, ORACLE_ABI, ENGINE_ABI, ERC20_ABI } from "./config/abi";
import Header from "./components/Header";
import Positions from "./components/Positions";
import Rebalance from "./components/Rebalance";
import Oracle from "./components/Oracle";
import "./App.css";

export interface Contracts {
  pool: ethers.Contract;
  oracle: ethers.Contract;
  engine: ethers.Contract;
  weth: ethers.Contract;
  usdc: ethers.Contract;
}

const RPC_URL = import.meta.env.VITE_RPC_URL || "http://127.0.0.1:8545";
const MAINNET_WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

/** true when deployed-addresses.json points to real mainnet WETH */
export const IS_FORK = addresses.weth.toLowerCase() === MAINNET_WETH;

type Tab = "positions" | "rebalance" | "oracle";

export default function App() {
  const [provider, setProvider] = useState<ethers.JsonRpcProvider | null>(null);
  const [signer, setSigner] = useState<ethers.Signer | null>(null);
  const [account, setAccount] = useState("");
  const [accountIndex, setAccountIndex] = useState(0);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [contracts, setContracts] = useState<Contracts | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("positions");
  const [wethBalance, setWethBalance] = useState(0n);
  const [usdcBalance, setUsdcBalance] = useState(0n);
  const [error, setError] = useState("");

  const connect = useCallback(async (idx: number) => {
    try {
      const p = new ethers.JsonRpcProvider(RPC_URL);
      const allAccounts = await p.listAccounts();
      const accs = await Promise.all(allAccounts.map((a) => a.getAddress()));
      const s = allAccounts[idx];
      const addr = accs[idx];

      const c: Contracts = {
        pool: new ethers.Contract(addresses.pool, POOL_ABI, s),
        oracle: new ethers.Contract(addresses.oracle, ORACLE_ABI, s),
        engine: new ethers.Contract(addresses.engine, ENGINE_ABI, s),
        weth: new ethers.Contract(addresses.weth, ERC20_ABI, s),
        usdc: new ethers.Contract(addresses.usdc, ERC20_ABI, s),
      };

      setProvider(p);
      setSigner(s);
      setAccount(addr);
      setAccounts(accs);
      setContracts(c);
      setError("");
    } catch (e: any) {
      setError(`Connection failed: ${e.message}. Is Hardhat node running?`);
    }
  }, []);

  useEffect(() => {
    connect(0);
  }, [connect]);

  const refreshBalances = useCallback(async () => {
    if (!contracts || !account) return;
    try {
      const [w, u] = await Promise.all([
        contracts.weth.balanceOf(account),
        contracts.usdc.balanceOf(account),
      ]);
      setWethBalance(w);
      setUsdcBalance(u);
    } catch (e) {
      console.error("Balance refresh failed:", e);
    }
  }, [contracts, account]);

  useEffect(() => {
    refreshBalances();
  }, [refreshBalances]);

  const switchAccount = (idx: number) => {
    setAccountIndex(idx);
    connect(idx);
  };

  if (error) {
    return (
      <div className="app">
        <h1>Soft Liquidation Protocol</h1>
        <div className="card" style={{ marginTop: 24 }}>
          <div className="status-bar status-error">{error}</div>
          <p style={{ color: "var(--text-dim)", fontSize: 14, marginTop: 12 }}>
            <strong>Local (mock):</strong><br />
            1. <code>npx hardhat node</code><br />
            2. <code>npx hardhat run scripts/deploy.ts</code><br /><br />
            <strong>Mainnet fork:</strong><br />
            1. <code>MAINNET_RPC_URL=... npx hardhat node --network hardhatFork</code><br />
            2. <code>npx hardhat run scripts/deploy-fork.ts</code><br /><br />
            3. Refresh this page
          </p>
        </div>
      </div>
    );
  }

  if (!contracts || !signer) {
    return <div className="app loading">Connecting...</div>;
  }

  return (
    <div className="app">
      <Header
        account={account}
        accounts={accounts}
        accountIndex={accountIndex}
        wethBalance={wethBalance}
        usdcBalance={usdcBalance}
        onSwitchAccount={switchAccount}
        contracts={contracts}
        onRefresh={refreshBalances}
        isFork={IS_FORK}
      />

      <div className="tabs">
        <button
          className={`tab ${activeTab === "positions" ? "active" : ""}`}
          onClick={() => setActiveTab("positions")}
        >
          Positions
        </button>
        <button
          className={`tab ${activeTab === "rebalance" ? "active" : ""}`}
          onClick={() => setActiveTab("rebalance")}
        >
          Rebalance
        </button>
        <button
          className={`tab ${activeTab === "oracle" ? "active" : ""}`}
          onClick={() => setActiveTab("oracle")}
        >
          Oracle
        </button>
      </div>

      {activeTab === "positions" && (
        <Positions
          contracts={contracts}
          account={account}
          onTx={refreshBalances}
        />
      )}
      {activeTab === "rebalance" && (
        <Rebalance
          contracts={contracts}
          account={account}
          onTx={refreshBalances}
        />
      )}
      {activeTab === "oracle" && (
        <Oracle contracts={contracts} account={account} />
      )}
    </div>
  );
}
