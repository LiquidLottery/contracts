# LiquidLottery Contracts

Smart contracts and tests for [LiquidLottery](https://liquidlottery.app) — a provably fair, on-chain lottery on Hyperliquid L1 powered by Chainlink VRF and CCIP.

## Contracts

| Contract | Chain | Description |
|---|---|---|
| `LiquidLotteryV1.sol` | Hyperliquid L1 | Main lottery logic (UUPS upgradeable) |
| `LotteryMath.sol` | Hyperliquid L1 | Core game math and settlement |
| `LotteryViews.sol` | Hyperliquid L1 | Views, admin config, claims |
| `GoldenTicket.sol` | Hyperliquid L1 | Founder NFT (10 max supply) |
| `LotteryVRFRequester.sol` | Base | Chainlink VRF v2.5 + CCIP bridge |

## Build & Test

```bash
npm install
npx hardhat test
```

## Documentation

Full documentation available at **[docs.liquidlottery.app](https://docs.liquidlottery.app)**

## License

MIT