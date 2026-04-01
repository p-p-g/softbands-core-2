// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./interfaces/IChainlinkAggregator.sol";

/// @title PriceOracle Chainlink-based oracle with manual override
/// @notice Returns WETH price in USDC with 8 decimals (e.g. 3500_00000000 = $3500).
///         Primary source: Chainlink ETH/USD feed (already 8 decimals).
///         Owner can override the price manually; the override expires after 1 hour,
///         after which the oracle falls back to Chainlink.
///         If Chainlink is not configured, uses the manual TWAP observations.
contract PriceOracle {
    address public owner;

    struct Observation {
        uint256 price;
        uint32 timestamp;
    }

    /// @notice Array of price observations for TWAP
    Observation[] public observations;

    /// @notice TWAP window in seconds (default 10 minutes)
    uint256 public twapWindow = 600;

    /// @notice Price decimals
    uint8 public constant DECIMALS = 8;

    /// @notice Chainlink ETH/USD aggregator
    IChainlinkAggregator public chainlinkFeed;

    /// @notice Whether to use Chainlink as primary source
    bool public useChainlink;

    /// @notice Timestamp when the manual override expires
    uint256 public manualOverrideExpiry;

    /// @notice Duration of manual override (1 hour)
    uint256 public constant MANUAL_OVERRIDE_DURATION = 1 hours;

    /// @notice Maximum allowed staleness for Chainlink data (default 24 hours)
    uint256 public maxStaleness = 24 hours;

    event PriceUpdated(uint256 price, uint256 timestamp);
    event TwapWindowUpdated(uint256 newWindow);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ChainlinkFeedUpdated(address feed);
    event ChainlinkDisabled();

    error OnlyOwner();
    error PriceZero();
    error NoObservations();
    error StaleChainlinkPrice();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(uint256 initialPrice) {
        if (initialPrice == 0) revert PriceZero();
        owner = msg.sender;
        observations.push(Observation({
            price: initialPrice,
            timestamp: uint32(block.timestamp)
        }));
    }

    /// @notice Set Chainlink aggregator and enable it as primary source
    function setChainlinkFeed(address _feed) external onlyOwner {
        chainlinkFeed = IChainlinkAggregator(_feed);
        useChainlink = true;
        emit ChainlinkFeedUpdated(_feed);
    }

    /// @notice Disable Chainlink, revert to manual observations
    function disableChainlink() external onlyOwner {
        useChainlink = false;
        emit ChainlinkDisabled();
    }

    /// @notice Set the maximum staleness for Chainlink data
    function setMaxStaleness(uint256 _maxStaleness) external onlyOwner {
        maxStaleness = _maxStaleness;
    }

    /// @notice Set price manually (owner only).
    ///         Activates a manual override that lasts MANUAL_OVERRIDE_DURATION.
    ///         During override, getPrice() returns the TWAP of manual observations.
    function setPrice(uint256 price) external onlyOwner {
        if (price == 0) revert PriceZero();
        observations.push(Observation({
            price: price,
            timestamp: uint32(block.timestamp)
        }));
        manualOverrideExpiry = block.timestamp + MANUAL_OVERRIDE_DURATION;
        emit PriceUpdated(price, block.timestamp);
    }

    /// @notice Clear manual override revert to Chainlink immediately
    function clearManualOverride() external onlyOwner {
        manualOverrideExpiry = 0;
    }

    /// @notice Set TWAP window
    function setTwapWindow(uint256 window) external onlyOwner {
        twapWindow = window;
        emit TwapWindowUpdated(window);
    }

    /// @notice Returns the current price (8 decimals).
    ///         Priority: manual override → Chainlink → TWAP observations
    function getPrice() external view returns (uint256) {
        // 1. Manual override active → use TWAP of observations
        if (block.timestamp <= manualOverrideExpiry) {
            return _getTwapPrice();
        }

        // 2. Chainlink enabled → use Chainlink
        if (useChainlink && address(chainlinkFeed) != address(0)) {
            return _getChainlinkPrice();
        }

        // 3. Fallback → TWAP of observations
        return _getTwapPrice();
    }

    /// @notice Returns the latest raw price (no TWAP, no Chainlink)
    function getLatestPrice() external view returns (uint256) {
        if (useChainlink && address(chainlinkFeed) != address(0)
            && block.timestamp > manualOverrideExpiry) {
            return _getChainlinkPrice();
        }
        uint256 len = observations.length;
        if (len == 0) revert NoObservations();
        return observations[len - 1].price;
    }

    /// @notice Number of observations stored
    function observationCount() external view returns (uint256) {
        return observations.length;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @dev Read price from Chainlink ETH/USD feed (8 decimals)
    function _getChainlinkPrice() internal view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = chainlinkFeed.latestRoundData();
        // Stale check: price must be updated within the last 1 hour
        if (block.timestamp - updatedAt > maxStaleness) revert StaleChainlinkPrice();
        if (answer <= 0) revert PriceZero();
        return uint256(answer);
    }

    /// @dev Compute TWAP from manual observations
    function _getTwapPrice() internal view returns (uint256) {
        uint256 len = observations.length;
        if (len == 0) revert NoObservations();
        if (len == 1) return observations[0].price;

        uint256 cutoff = block.timestamp > twapWindow ? block.timestamp - twapWindow : 0;

        uint256 weightedSum = 0;
        uint256 totalWeight = 0;

        for (uint256 i = len; i > 0; i--) {
            Observation memory obs = observations[i - 1];
            if (obs.timestamp < cutoff) break;

            uint256 endTime = (i < len) ? observations[i].timestamp : block.timestamp;
            uint256 startTime = obs.timestamp < cutoff ? cutoff : obs.timestamp;
            uint256 duration = endTime - startTime;

            if (duration > 0) {
                weightedSum += obs.price * duration;
                totalWeight += duration;
            }
        }

        if (totalWeight == 0) {
            return observations[len - 1].price;
        }

        return weightedSum / totalWeight;
    }
}
