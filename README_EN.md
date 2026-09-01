<div align="center">

# QuantDesk

**A Local-First AI Quant Research Workstation**

[中文](README.md) · English · [日本語](README_JA.md)

</div>

---

QuantDesk is a desktop app that runs entirely on your machine (Tauri + React + a Python engine), bringing an **AI investment Agent, market data, strategy backtesting, paper trading and risk control** into a single workspace. All data, API keys and conversations stay local — nothing passes through third-party servers.

## Highlights

### 🤖 Investment Agent
Describe a research goal in natural language and the Agent automatically calls market, money-flow and candlestick-pattern tools to deliver traceable conclusions. During research you can turn follow-up tracking into a **scheduled task** with one click.

![Investment Agent](docs/screenshots/agent.png)

### 📈 Market Center
Real-time quotes for indices and stocks, candlestick charts with technical indicators (MACD, etc.), gainers/losers rankings and financial news. Data providers (Tushare / Alpha Vantage, etc.) are switchable in Settings.

![Market K-line](docs/screenshots/market-kline.png)

### 🪟 Multi-View Workspace
Agent chat, news and market charts can sit side by side in resizable panels — watch the market while researching. Vertical splits and drag-to-resize are supported.

![Multi-view](docs/screenshots/multi-view.png)

### More Modules
- **Quant Tools**: algorithm tools, timed-signal backtesting, Walk-Forward validation, factor research, portfolio rebalancing backtests
- **Portfolio Management**: portfolios, paper trading (matching & position risk checks), live OMS (desktop-only), risk center
- **Scheduled Tasks**: research jobs run automatically by schedule/trading-day, with results written back to a dedicated chat thread
- **Productivity**: built-in browser, command palette (Ctrl+K), token usage dashboard with activity heatmap

## Architecture

| Layer | Technology |
|---|---|
| Desktop shell | Rust + Tauri 2 |
| Frontend | React 18 + TypeScript + Vite |
| Local engine | Python FastAPI (port 8765) |
| Persistence | SQLite (WAL mode + schema migrations) |
| Models | OpenAI / DeepSeek / Qwen / OpenRouter (free-model auto selection) |

## Security Design

- Local account login (PBKDF2 password hashing + optional TOTP 2FA)
- Random engine token: other processes on the same machine/network cannot silently call order placement or import APIs
- API keys are stored in the **Windows Credential Manager** — never written to disk or committed
- The live OMS only accepts the desktop process token; phones and plain sessions cannot place real orders

## Local Development

```bash
# 1. Install frontend dependencies
npm install

# 2. Start the desktop app (auto-spawns the local engine)
npm run tauri dev

# 3. Run engine tests
python -m pytest engine/tests
```

Engine docs live in [engine/](engine/); the frontend entry is [src/main.tsx](src/main.tsx).

## License

For learning and research only. Not investment advice.
