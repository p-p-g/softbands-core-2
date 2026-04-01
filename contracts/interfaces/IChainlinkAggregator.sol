// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal Chainlink V3 Aggregator interface (ETH/USD feed)
interface IChainlinkAggregator {
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );

    function decimals() external view returns (uint8);
}
