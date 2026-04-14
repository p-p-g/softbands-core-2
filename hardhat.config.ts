import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
      blockGasLimit: 60_000_000,
    },
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
      blockGasLimit: 60_000_000,
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    // Mainnet fork: MAINNET_RPC_URL=... npx hardhat node --network hardhatFork
    hardhatFork: {
      type: "edr-simulated",
      chainType: "l1",
      blockGasLimit: 60_000_000,
      forking: {
        url: configVariable("MAINNET_RPC_URL"),
        blockNumber: 24870000,
      },
    },
    localhost: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:8545",
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
  },
});
