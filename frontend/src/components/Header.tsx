import { useState } from "react";
import { ethers } from "ethers";
import type { Contracts } from "../App";

interface Props {
  account: string;
  accounts: string[];
  accountIndex: number;
  wethBalance: bigint;
  usdcBalance: bigint;
  onSwitchAccount: (idx: number) => void;
  contracts: Contracts;
  onRefresh: () => void;
  isFork: boolean;
}

const LABELS = ["Deployer", "User 1", "User 2", "Liquidator"];

export default function Header({
  account,
  accounts,
  accountIndex,
  wethBalance,
  usdcBalance,
  onSwitchAccount,
  contracts,
  onRefresh,
  isFork,
}: Props) {
  const [minting, setMinting] = useState(false);

  const fmtWeth = (v: bigint) => Number(ethers.formatEther(v)).toFixed(4);
  const fmtUsdc = (v: bigint) => Number(ethers.formatUnits(v, 6)).toFixed(2);
  const shortAddr = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

  async function mint() {
    setMinting(true);
    try {
      const tx1 = await contracts.weth.mint(account, ethers.parseEther("10"));
      const tx2 = await contracts.usdc.mint(account, ethers.parseUnits("50000", 6));
      await Promise.all([tx1.wait(), tx2.wait()]);
      onRefresh();
    } catch (e) {
      console.error("Mint failed:", e);
    }
    setMinting(false);
  }

  return (
    <div className="header">
      <h1>Soft Liquidation Protocol</h1>
      <div className="header-right">
        <div className="balances">
          WETH: <span>{fmtWeth(wethBalance)}</span>
          &nbsp;&nbsp;
          USDC: <span>{fmtUsdc(usdcBalance)}</span>
        </div>
        {!isFork && (
          <button className="btn btn-sm btn-outline" onClick={mint} disabled={minting}>
            {minting ? "..." : "Faucet"}
          </button>
        )}
        <select
          className="account-select"
          value={accountIndex}
          onChange={(e) => onSwitchAccount(Number(e.target.value))}
        >
          {accounts.slice(0, 4).map((a, i) => (
            <option key={a} value={i}>
              {LABELS[i] || `Account ${i}`} ({shortAddr(a)})
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
