# Soft Liquidation Pool

DeFi-протокол кредитования с механизмом мягкой ликвидации. Заёмщик вносит WETH как залог и получает USDC. Залог распределяется по тик-диапазону при падении цены ликвидатор через голландский аукцион выкупает залог сверху вниз, а не забирает всю позицию целиком. Протокол работает поверх Aave V3 (залог размещается в Aave, займ берётся из Aave).

## Архитектура

| Контракт | Назначение |
|---|---|
| `SoftLiquidationPool` | Основной пул: депозит, закрытие, ребалансировка (ликвидация), учёт тиков и позиций |
| `LiquidationEngine` | Параметры голландского аукциона, конвертация цена/тик, расчёт цены исполнения |
| `AaveAdapter` | Обёртка над Aave V3: supply/borrow/repay/withdraw |
| `PriceOracle` | Оракул цены: Chainlink ETH/USD + ручной override для тестирования |

## Установка

```bash
npm install
cd frontend && npm install && cd ..
```

## Компиляция

```bash
npx hardhat compile
```

## Тесты (локальная сеть)

47 тестов на mock-контрактах:

```bash
npx hardhat test
```

## Тесты (mainnet fork)

Тесты на форке Ethereum mainnet Aave V3 и Chainlink:

```bash
MAINNET_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY npx hardhat test test/SoftLiquidationPool.fork.ts
```

## Запуск ноды (mainnet fork)

```bash
MAINNET_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY npx hardhat node --network hardhatFork
```

## Деплой на форк

```bash
npx hardhat run scripts/deploy-fork.ts
```

## Проверка подключения к Aave

```bash
npx hardhat run scripts/verify-aave.ts
```

## Фронтенд

```bash
cd frontend
npm run dev
```

Открыть http://localhost:5173
