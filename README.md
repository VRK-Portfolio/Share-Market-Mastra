
A static, component-based Next.js stock dashboard inspired by the
[reference dashboard](https://sites.google.com/view/stock-analysis-dashboard/).

## Run

```sh
npm ci
npm run dev
```

Open http://localhost:3000. No Groww account, API subscription, tokens, session
secret, static IP or other dashboard credentials are required.

## Features

- Responsive Tailwind CSS layout with persistent light/dark themes.
- Clearly labeled illustrative RELIANCE prices, indicators and candlestick charts.
- Local 15m/1h/1D sample charts with volume, hover OHLC and overlay toggles.
- MIS/CNC display presets for technical indicator cards.
- `technicalindicators` calculates VWAP, RSI, ATR, EMAs and MACD from sample candles
  during page rendering. SuperTrend uses its ATR implementation.

**No dashboard API calls, authentication, cookies, live prices or order placement.**
Sample data is deterministic and fictional, not actual historical market data or
investment advice. Each interval is an independent illustrative series; the quote
card summarizes the final session of the 15-minute sample.

## Components and data

- `src/components/dashboard/`: header/theme control, stock overview, indicator
  cards, candlestick chart, market context and dashboard composition.
- `src/lib/market/sample-data.ts`: fixed sample candle series and quote.
- `src/lib/market/indicators.ts`: indicator calculations.
- `src/app/page.tsx`: prepares sample analyses and renders the dashboard.

The Groww HTTP client, API routes, login dialog, encrypted sessions, credential
configuration and API-specific tests have been removed. Existing Mastra examples
and unrelated dependencies are unchanged.
