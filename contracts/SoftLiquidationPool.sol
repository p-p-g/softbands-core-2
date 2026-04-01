// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./interfaces/IERC20.sol";
import "./libraries/TickMath.sol";
import "./AaveAdapter.sol";
import "./PriceOracle.sol";
import "./LiquidationEngine.sol";

/// @title SoftLiquidationPool lending protocol with tick-based soft liquidation over Aave
/// @notice Users deposit WETH collateral (forwarded to Aave), receive USDC loan.
///         Collateral is distributed equally across a user-chosen tick range.
///         When price drops, a Dutch auction activates and anyone can call rebalance()
///         specifying how much WETH they want. Ticks are processed top-down (highest first).
///         Partial tick liquidation is supported remaining users keep proportional shares.
contract SoftLiquidationPool {
    AaveAdapter public immutable aaveAdapter;
    PriceOracle public immutable oracle;
    LiquidationEngine public immutable liquidationEngine;
    IERC20 public immutable weth;
    IERC20 public immutable usdc;

    int24 public constant TICK_SPACING = TickMath.TICK_SPACING; // 10
    /// @dev Minimum word position for bitmap scanning (covers tick ~ -887270)
    int16 internal constant MIN_WORD = -3466;
    /// @dev Maximum word position for bitmap scanning (covers tick ~ +887270)
    int16 internal constant MAX_WORD = 346;

    address public owner;

    /// @notice P_int internal price anchored at last successful rebalance
    uint256 public lastRebalancePrice;
    /// @notice Timestamp of last successful rebalance
    uint256 public lastRebalanceTime;
    /// @notice Address that receives the proportional auction fee
    address public feeRecipient;

    struct Position {
        address owner;
        int24 upperTick;       // first tick to be liquidated (highest price threshold)
        int24 lowerTick;       // last tick full close when reached
        uint256 collateral;    // total WETH deposited (18 decimals)
        uint256 debt;          // total USDC borrowed (6 decimals)
        bool active;
    }

    uint256 public nextPositionId = 1;
    mapping(uint256 => Position) public positions;
    mapping(address => uint256[]) public userPositionIds;

    struct TickInfo {
        uint256 totalCollateral; // total WETH in this tick (18 decimals)
        uint256 totalDebt;       // total USDC debt in this tick (6 decimals)
        uint256 totalShares;     // shares for proportional accounting
        bool liquidated;         // true if tick was fully liquidated
        uint256 generation;      // incremented on full liquidation reset
    }

    mapping(int24 => TickInfo) public tickData;

    /// @notice Shares per position per tick (positionId => tick => shares)
    mapping(uint256 => mapping(int24 => uint256)) public positionShares;
    /// @notice Generation when shares were assigned (positionId => tick => generation)
    mapping(uint256 => mapping(int24 => uint256)) public positionShareGen;

    /// @notice Snapshot of tick state at the moment of overcollateralized liquidation,
    ///         so old positions can still claim their proportional share of excess collateral.
    struct TickSurplus {
        uint256 totalCollateral;
        uint256 totalShares;
    }
    /// @notice tick → generation → surplus snapshot
    mapping(int24 => mapping(uint256 => TickSurplus)) public tickSurplus;

    /// @notice Bitmap tracking which ticks have active collateral
    mapping(int16 => uint256) public tickBitmap;
    /// @notice Cached highest word with active ticks (optimization for top-down scan)
    int16 public highestActiveWord = type(int16).min;

    event PositionOpened(
        uint256 indexed positionId,
        address indexed owner,
        uint256 collateral,
        uint256 debt,
        int24 upperTick,
        int24 lowerTick
    );
    event PositionClosed(uint256 indexed positionId, address indexed owner);
    event TickLiquidated(int24 indexed tick, address indexed liquidator, uint256 debtRepaid, uint256 collateralSent);
    event Rebalanced(
        address indexed liquidator,
        uint256 totalDebtRepaid,
        uint256 totalCollateralSent,
        uint256 fee,
        uint256 execPrice,
        uint256 ticksProcessed
    );
    event DebtRepaid(uint256 indexed positionId, uint256 amount);

    error InvalidTickRange();
    error TickNotAligned();
    error ZeroAmount();
    error NotPositionOwner();
    error PositionNotActive();
    error TickNotLiquidatable();
    error TickAlreadyLiquidated();
    error InsufficientCollateral();
    error PositionUndercollateralized();
    error AuctionNotActive();
    error ZeroWethRequested();
    error NoLiquidatableTicks();
    error SlippageExceeded();
    error OnlyOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(
        address _aaveAdapter,
        address _oracle,
        address _liquidationEngine,
        address _weth,
        address _usdc
    ) {
        aaveAdapter = AaveAdapter(_aaveAdapter);
        oracle = PriceOracle(_oracle);
        liquidationEngine = LiquidationEngine(_liquidationEngine);
        weth = IERC20(_weth);
        usdc = IERC20(_usdc);

        owner = msg.sender;
        feeRecipient = msg.sender;
        lastRebalancePrice = oracle.getPrice();
        lastRebalanceTime = block.timestamp;
    }

    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        feeRecipient = _feeRecipient;
    }

    function setLastRebalancePrice(uint256 _price) external onlyOwner {
        lastRebalancePrice = _price;
    }

    /// @notice Open a new borrowing position
    function deposit(
        uint256 wethAmount,
        uint256 usdcBorrow,
        int24 upperTick,
        int24 lowerTick
    ) external returns (uint256 positionId) {
        if (wethAmount == 0 || usdcBorrow == 0) revert ZeroAmount();
        if (upperTick <= lowerTick) revert InvalidTickRange();
        if (upperTick % TICK_SPACING != 0 || lowerTick % TICK_SPACING != 0) revert TickNotAligned();

        // Validate: upper tick must be below current price (not immediately liquidatable)
        uint256 currentPrice = oracle.getPrice();
        int24 currentTick = liquidationEngine.priceToTick(currentPrice);
        if (upperTick >= currentTick) revert PositionUndercollateralized();

        // Transfer WETH from user
        weth.transferFrom(msg.sender, address(aaveAdapter), wethAmount);

        // Supply WETH to Aave
        aaveAdapter.supply(wethAmount);

        // Borrow USDC from Aave and send to user
        aaveAdapter.borrow(usdcBorrow, msg.sender);

        // Create position
        positionId = nextPositionId++;
        positions[positionId] = Position({
            owner: msg.sender,
            upperTick: upperTick,
            lowerTick: lowerTick,
            collateral: wethAmount,
            debt: usdcBorrow,
            active: true
        });
        userPositionIds[msg.sender].push(positionId);

        // Distribute collateral equally across ticks
        _distributeCollateral(positionId, wethAmount, usdcBorrow, upperTick, lowerTick);

        emit PositionOpened(positionId, msg.sender, wethAmount, usdcBorrow, upperTick, lowerTick);
    }

    /// @notice Close position user repays full remaining debt, receives remaining collateral
    function closePosition(uint256 positionId) external {
        Position storage pos = positions[positionId];
        if (pos.owner != msg.sender) revert NotPositionOwner();
        if (!pos.active) revert PositionNotActive();

        (uint256 remainingDebt, uint256 remainingCollateral) = getPositionState(positionId);

        if (remainingDebt > 0) {
            usdc.transferFrom(msg.sender, address(aaveAdapter), remainingDebt);
            aaveAdapter.repay(remainingDebt);
        }

        if (remainingCollateral > 0) {
            aaveAdapter.withdraw(remainingCollateral, msg.sender);
        }

        _removeFromTicks(positionId);

        pos.active = false;
        emit PositionClosed(positionId, msg.sender);
    }

    /// @notice Partial debt repayment
    function repay(uint256 positionId, uint256 usdcAmount) external {
        Position storage pos = positions[positionId];
        if (pos.owner != msg.sender) revert NotPositionOwner();
        if (!pos.active) revert PositionNotActive();
        if (usdcAmount == 0) revert ZeroAmount();

        (uint256 remainingDebt, ) = getPositionState(positionId);
        if (usdcAmount > remainingDebt) {
            usdcAmount = remainingDebt;
        }

        usdc.transferFrom(msg.sender, address(aaveAdapter), usdcAmount);
        aaveAdapter.repay(usdcAmount);

        _reduceDebt(positionId, usdcAmount);

        pos.debt -= usdcAmount;
        emit DebtRepaid(positionId, usdcAmount);
    }


    /// @notice Execute a rebalance liquidator specifies how much WETH they want.
    ///         Ticks are processed from highest (most expensive) downward.
    ///         Partial tick liquidation is supported.
    /// @param wethWanted Amount of WETH the liquidator wants to buy (18 decimals)
    /// @param maxUsdcCost Slippage protection max USDC the liquidator is willing to pay (0 = no limit)
    /// @return totalDebtPaid Total USDC paid by liquidator for the collateral
    /// @return totalCollateralSent Total WETH sent to liquidator
    /// @return totalFee Total fee in USDC
    function rebalance(uint256 wethWanted, uint256 maxUsdcCost)
        external
        returns (uint256 totalDebtPaid, uint256 totalCollateralSent, uint256 totalFee)
    {
        if (wethWanted == 0) revert ZeroWethRequested();

        // 1. Get oracle price and validate auction is active
        uint256 oraclePrice = oracle.getPrice();
        {
            int256 delta = liquidationEngine.computeDelta(oraclePrice, lastRebalancePrice);
            int256 absDelta = delta < 0 ? -delta : delta;
            if (uint256(absDelta) < liquidationEngine.deltaMin()) revert AuctionNotActive();
        }

        // 2. Compute execution price
        uint256 execPrice;
        {
            uint256 elapsed = block.timestamp > lastRebalanceTime
                ? block.timestamp - lastRebalanceTime
                : 0;
            int256 delta = liquidationEngine.computeDelta(oraclePrice, lastRebalancePrice);
            uint256 deviation = liquidationEngine.computeDeviation(elapsed);
            execPrice = liquidationEngine.computeExecutionPrice(oraclePrice, delta, deviation);
        }

        // 3. Process ticks top-down
        uint256 ticksProcessed;
        (totalDebtPaid, totalCollateralSent, ticksProcessed) = _processTicksTopDown(
            wethWanted, oraclePrice, execPrice
        );

        if (totalCollateralSent == 0) revert NoLiquidatableTicks();

        // 4. Compute fee
        totalFee = liquidationEngine.computeFee(totalDebtPaid);

        // 4a. Slippage protection
        if (maxUsdcCost > 0 && totalDebtPaid + totalFee > maxUsdcCost) {
            revert SlippageExceeded();
        }

        // 5. Transfer: liquidator pays USDC (debt + fee)
        if (totalDebtPaid > 0) {
            usdc.transferFrom(msg.sender, address(aaveAdapter), totalDebtPaid);
            aaveAdapter.repay(totalDebtPaid);
        }
        if (totalFee > 0) {
            usdc.transferFrom(msg.sender, feeRecipient, totalFee);
        }

        // 6. Withdraw WETH from Aave to liquidator
        if (totalCollateralSent > 0) {
            aaveAdapter.withdraw(totalCollateralSent, msg.sender);
        }

        // 7. Update auction state
        lastRebalancePrice = oraclePrice;
        lastRebalanceTime = block.timestamp;

        emit Rebalanced(msg.sender, totalDebtPaid, totalCollateralSent, totalFee, execPrice, ticksProcessed);
    }

    /// @dev Internal: iterate ticks from highest to lowest, consuming up to wethWanted.
    ///      For each tick the liquidator takes at most the collateral equivalent to the tick's
    ///      debt at execution price.  Any excess collateral stays for the borrowers.
    function _processTicksTopDown(
        uint256 wethWanted,
        uint256 oraclePrice,
        uint256 execPrice
    ) internal returns (uint256 totalDebt, uint256 totalCol, uint256 ticksProcessed) {
        // Start from the highest initialized tick and work downward
        (int24 currentTick, bool found) = _highestInitializedTick();

        uint256 remaining = wethWanted;

        while (remaining > 0 && found) {
            TickInfo storage ti = tickData[currentTick];

            // Skip empty or already-liquidated ticks
            if (ti.totalCollateral == 0 || ti.liquidated) {
                (currentTick, found) = _nextInitializedTickBelow(currentTick);
                continue;
            }

            // Stop when we reach a tick that's not liquidatable
            // (all lower ticks will also not be liquidatable since they have lower prices)
            if (!liquidationEngine.isTickLiquidatable(currentTick, oraclePrice)) {
                break;
            }

            uint256 colTaken;
            uint256 debtForTick;

            // Max collateral needed to cover this tick's full debt at execution price
            uint256 colForDebt = liquidationEngine.usdcToWeth(ti.totalDebt, execPrice);

            // Available collateral is capped by what the debt warrants
            uint256 colAvailable = colForDebt < ti.totalCollateral ? colForDebt : ti.totalCollateral;

            if (remaining >= colAvailable) {
                // Full tick liquidation repay the tick's entire debt
                colTaken = colAvailable;

                if (colForDebt >= ti.totalCollateral) {
                    // Undercollateralized at exec price take all collateral
                    debtForTick = liquidationEngine.wethToUsdc(colTaken, execPrice);
                    if (debtForTick > ti.totalDebt) debtForTick = ti.totalDebt;
                    ti.totalCollateral = 0;
                    ti.totalDebt -= debtForTick;
                    // No collateral left zero shares and bump generation
                    ti.totalShares = 0;
                    ti.generation++;
                } else {
                    // Overcollateralized full debt repaid, excess collateral stays for users
                    debtForTick = ti.totalDebt;
                    uint256 excessCollateral = ti.totalCollateral - colTaken;

                    // Save surplus so old positions can still claim their share of excess
                    tickSurplus[currentTick][ti.generation] = TickSurplus({
                        totalCollateral: excessCollateral,
                        totalShares: ti.totalShares
                    });

                    // Reset tick fully prevents state corruption when new positions deposit
                    ti.totalCollateral = 0;
                    ti.totalDebt = 0;
                    ti.totalShares = 0;
                    ti.generation++;
                }

                ti.liquidated = true;
                _clearTickBit(currentTick);
                remaining -= colTaken;
            } else {
                // Partial tick liquidation take only what the liquidator requested
                colTaken = remaining;
                debtForTick = liquidationEngine.wethToUsdc(colTaken, execPrice);
                if (debtForTick > ti.totalDebt) debtForTick = ti.totalDebt;

                ti.totalCollateral -= colTaken;
                ti.totalDebt -= debtForTick;
                remaining = 0;
            }

            totalDebt += debtForTick;
            totalCol += colTaken;
            ticksProcessed++;

            emit TickLiquidated(currentTick, msg.sender, debtForTick, colTaken);

            (currentTick, found) = _nextInitializedTickBelow(currentTick);
        }
    }


    /// @notice Get remaining debt and collateral for a position
    function getPositionState(uint256 positionId)
        public
        view
        returns (uint256 remainingDebt, uint256 remainingCollateral)
    {
        Position storage pos = positions[positionId];

        for (int24 tick = pos.lowerTick; tick <= pos.upperTick; tick += TICK_SPACING) {
            uint256 shares = positionShares[positionId][tick];
            if (shares == 0) continue;

            uint256 gen = positionShareGen[positionId][tick];
            TickInfo storage ti = tickData[tick];

            if (gen == ti.generation) {
                // Current generation standard proportional calculation
                if (ti.totalShares == 0) continue;
                remainingCollateral += (ti.totalCollateral * shares) / ti.totalShares;
                remainingDebt += (ti.totalDebt * shares) / ti.totalShares;
            } else {
                // Old generation check surplus from overcollateralized liquidation
                TickSurplus storage surplus = tickSurplus[tick][gen];
                if (surplus.totalShares > 0) {
                    remainingCollateral += (surplus.totalCollateral * shares) / surplus.totalShares;
                    // No debt in surplus (debt was fully repaid during liquidation)
                }
            }
        }
    }

    /// @notice Get all position IDs for a user
    function getUserPositions(address user) external view returns (uint256[] memory) {
        return userPositionIds[user];
    }

    /// @notice Get the number of active ticks in a position's range
    function getActiveTickCount(uint256 positionId) external view returns (uint256 count) {
        Position storage pos = positions[positionId];
        for (int24 tick = pos.lowerTick; tick <= pos.upperTick; tick += TICK_SPACING) {
            if (!tickData[tick].liquidated
                && positionShares[positionId][tick] > 0
                && positionShareGen[positionId][tick] == tickData[tick].generation) {
                count++;
            }
        }
    }

    /// @notice Check if a specific tick is currently liquidatable
    function isTickLiquidatable(int24 tick) external view returns (bool) {
        uint256 currentPrice = oracle.getPrice();
        return liquidationEngine.isTickLiquidatable(tick, currentPrice)
            && !tickData[tick].liquidated
            && tickData[tick].totalCollateral > 0;
    }

    /// @notice Get current auction state for frontend display
    /// @return delta Signed discrepancy in BPS
    /// @return deviation Current Dutch deviation in BPS
    /// @return execPrice Current execution price (8 decimals)
    /// @return active Whether auction is currently active
    function getAuctionState()
        external
        view
        returns (int256 delta, uint256 deviation, uint256 execPrice, bool active)
    {
        uint256 oraclePrice = oracle.getPrice();
        delta = liquidationEngine.computeDelta(oraclePrice, lastRebalancePrice);

        int256 absDelta = delta < 0 ? -delta : delta;
        active = uint256(absDelta) >= liquidationEngine.deltaMin();

        uint256 elapsed = block.timestamp > lastRebalanceTime
            ? block.timestamp - lastRebalanceTime
            : 0;
        deviation = liquidationEngine.computeDeviation(elapsed);
        execPrice = liquidationEngine.computeExecutionPrice(oraclePrice, delta, deviation);
    }

    /// @dev Distribute collateral and debt equally across ticks in the range
    function _distributeCollateral(
        uint256 positionId,
        uint256 wethAmount,
        uint256 usdcDebt,
        int24 upperTick,
        int24 lowerTick
    ) internal {
        uint256 numTicks = uint256(int256((upperTick - lowerTick) / TICK_SPACING)) + 1;
        uint256 colPerTick = wethAmount / numTicks;
        uint256 debtPerTick = usdcDebt / numTicks;

        for (int24 tick = lowerTick; tick <= upperTick; tick += TICK_SPACING) {
            _addToTick(
                positionId,
                tick,
                tick == upperTick ? colPerTick + wethAmount - colPerTick * numTicks : colPerTick,
                tick == upperTick ? debtPerTick + usdcDebt - debtPerTick * numTicks : debtPerTick
            );
        }
    }

    /// @dev Add collateral and debt to a single tick for a position
    function _addToTick(uint256 positionId, int24 tick, uint256 col, uint256 debt) internal {
        TickInfo storage ti = tickData[tick];

        // If the tick was liquidated, reset it for fresh deposits.
        // Surplus for old positions was already saved in tickSurplus during rebalance.
        if (ti.liquidated) {
            ti.liquidated = false;
            // Tick should already be clean (totalShares=0, totalDebt=0) after rebalance.
            // For safety, ensure totalCollateral from surplus is zeroed if not already.
            ti.totalCollateral = 0;
            ti.totalDebt = 0;
            ti.totalShares = 0;
        }

        uint256 shares = (ti.totalShares == 0 || ti.totalCollateral == 0)
            ? col
            : (col * ti.totalShares) / ti.totalCollateral;

        ti.totalCollateral += col;
        ti.totalDebt += debt;
        ti.totalShares += shares;

        positionShares[positionId][tick] = shares;
        positionShareGen[positionId][tick] = ti.generation;
        _setTickBit(tick);
    }

    /// @dev Remove a position's shares from all its ticks
    function _removeFromTicks(uint256 positionId) internal {
        Position storage pos = positions[positionId];

        for (int24 tick = pos.lowerTick; tick <= pos.upperTick; tick += TICK_SPACING) {
            uint256 shares = positionShares[positionId][tick];
            if (shares == 0) continue;

            uint256 gen = positionShareGen[positionId][tick];
            TickInfo storage ti = tickData[tick];

            if (gen != ti.generation) {
                // Old generation check surplus from overcollateralized liquidation
                TickSurplus storage surplus = tickSurplus[tick][gen];
                if (surplus.totalShares > 0 && surplus.totalCollateral > 0) {
                    uint256 userCol = (surplus.totalCollateral * shares) / surplus.totalShares;
                    surplus.totalCollateral -= userCol;
                    surplus.totalShares -= shares;
                    // userCol will be withdrawn via getPositionState in closePosition
                }
                positionShares[positionId][tick] = 0;
                continue;
            }

            if (ti.totalShares == 0) {
                positionShares[positionId][tick] = 0;
                continue;
            }

            uint256 userCollateral = (ti.totalCollateral * shares) / ti.totalShares;
            uint256 userDebt = (ti.totalDebt * shares) / ti.totalShares;

            ti.totalCollateral -= userCollateral;
            ti.totalDebt -= userDebt;
            ti.totalShares -= shares;

            positionShares[positionId][tick] = 0;

            if (ti.totalCollateral == 0) {
                _clearTickBit(tick);
            }
        }
    }

    /// @dev Reduce debt across non-liquidated ticks proportionally
    function _reduceDebt(uint256 positionId, uint256 totalReduction) internal {
        Position storage pos = positions[positionId];
        (uint256 currentDebt, ) = getPositionState(positionId);
        if (currentDebt == 0) return;

        for (int24 tick = pos.lowerTick; tick <= pos.upperTick; tick += TICK_SPACING) {
            TickInfo storage ti = tickData[tick];
            uint256 shares = positionShares[positionId][tick];
            if (shares == 0 || ti.totalShares == 0 || ti.liquidated) continue;
            if (positionShareGen[positionId][tick] != ti.generation) continue;

            uint256 userDebtInTick = (ti.totalDebt * shares) / ti.totalShares;
            uint256 reduction = (totalReduction * userDebtInTick) / currentDebt;

            if (reduction > 0) {
                ti.totalDebt -= reduction;
            }
        }
    }

    /// @dev Set a bit in the tick bitmap
    function _setTickBit(int24 tick) internal {
        (int16 wordPos, uint8 bitPos) = _tickPosition(tick);
        tickBitmap[wordPos] |= (1 << bitPos);
        if (wordPos > highestActiveWord) highestActiveWord = wordPos;
    }

    /// @dev Clear a bit in the tick bitmap
    function _clearTickBit(int24 tick) internal {
        (int16 wordPos, uint8 bitPos) = _tickPosition(tick);
        tickBitmap[wordPos] &= ~(1 << bitPos);
    }

    /// @dev Get word and bit position for a tick in the bitmap
    function _tickPosition(int24 tick) internal pure returns (int16 wordPos, uint8 bitPos) {
        int24 compressed = tick / TICK_SPACING;
        wordPos = int16(compressed >> 8);
        bitPos = uint8(uint24(int24(compressed) - (int24(wordPos) << 8)));
    }

    /// @dev Find the next initialized tick at or below the given tick (searching downward)
    /// @param tick The tick to start searching from (must be aligned to TICK_SPACING)
    /// @return next The next initialized tick at or below `tick`
    /// @return found Whether an initialized tick was found
    function _nextInitializedTickAtOrBelow(int24 tick) internal view returns (int24 next, bool found) {
        int24 compressed = tick / TICK_SPACING;
        // Handle negative tick rounding
        if (tick < 0 && tick % TICK_SPACING != 0) {
            compressed--;
        }

        int16 wordPos = int16(compressed >> 8);
        uint8 bitPos = uint8(uint24(int24(compressed) - (int24(wordPos) << 8)));

        // Create mask for all bits at or below bitPos: (1 << (bitPos + 1)) - 1
        uint256 mask = (uint256(1) << (uint256(bitPos) + 1)) - 1;
        uint256 masked = tickBitmap[wordPos] & mask;

        if (masked != 0) {
            // Found in current word get the most significant bit
            uint8 msb = _mostSignificantBit(masked);
            int24 tickIndex = (int24(wordPos) << 8) + int24(uint24(msb));
            next = tickIndex * TICK_SPACING;
            found = true;
            return (next, found);
        }

        // Search lower words (max 20 words = 51200 ticks to prevent gas issues)
        int16 minScan = wordPos - 20 < MIN_WORD ? MIN_WORD : wordPos - 20;
        for (int16 w = wordPos - 1; w >= minScan; w--) {
            if (tickBitmap[w] != 0) {
                uint8 msb = _mostSignificantBit(tickBitmap[w]);
                int24 tickIndex = (int24(w) << 8) + int24(uint24(msb));
                next = tickIndex * TICK_SPACING;
                found = true;
                return (next, found);
            }
        }

        return (0, false);
    }

    /// @dev Find the next initialized tick strictly below the given tick
    function _nextInitializedTickBelow(int24 tick) internal view returns (int24 next, bool found) {
        return _nextInitializedTickAtOrBelow(tick - TICK_SPACING);
    }

    /// @dev Find the highest initialized tick in the entire bitmap
    function _highestInitializedTick() internal view returns (int24 tick, bool found) {
        for (int16 w = highestActiveWord; w >= MIN_WORD; w--) {
            if (tickBitmap[w] != 0) {
                uint8 msb = _mostSignificantBit(tickBitmap[w]);
                int24 tickIndex = (int24(w) << 8) + int24(uint24(msb));
                return (tickIndex * TICK_SPACING, true);
            }
        }
        return (0, false);
    }

    /// @dev Find the most significant bit of a non-zero uint256
    function _mostSignificantBit(uint256 x) internal pure returns (uint8 r) {
        require(x > 0);
        if (x >= 0x100000000000000000000000000000000) { x >>= 128; r += 128; }
        if (x >= 0x10000000000000000) { x >>= 64; r += 64; }
        if (x >= 0x100000000) { x >>= 32; r += 32; }
        if (x >= 0x10000) { x >>= 16; r += 16; }
        if (x >= 0x100) { x >>= 8; r += 8; }
        if (x >= 0x10) { x >>= 4; r += 4; }
        if (x >= 0x4) { x >>= 2; r += 2; }
        if (x >= 0x2) r += 1;
    }
}
