<div align="center">

# QuantDesk

**A Local-First AI Quant Research Workstation**

[中文](README.md) · English · [日本語](README_JA.md)

![Platform](https://img.shields.io/badge/platform-Windows-blue) ![Engine](https://img.shields.io/badge/engine-Python%20FastAPI-green) ![Frontend](https://img.shields.io/badge/frontend-React%2019%20%2B%20TypeScript-cyan) ![Shell](https://img.shields.io/badge/shell-Rust%20%2B%20Tauri%202-orange)

</div>

---

## What is it?

QuantDesk is an AI quant research desktop app that **runs entirely on your own machine**. It compresses a full research workflow — watching the market, reading the news, running backtests, reviewing risk, monitoring positions — into a single window: you describe a goal in plain language, and the built-in investment Agent orchestrates a set of tools to produce traceable conclusions.

**All data, API keys and conversations stay on your device**: market data comes from the providers you configure, keys live in the Windows Credential Manager, and the database is a local SQLite file. No cloud account, no data upload.

## Features

### 🤖 Investment Agent — a full research run through conversation

Type a research goal directly into the input box, e.g. "Analyze CATL's current money flow and candlestick patterns". The Agent will:

1. **Plan the work** and visualize every step (which tool is being called, what data came back);
2. Automatically invoke internal tools such as **market snapshots, daily money-flow series, candlestick pattern scanning and movers rankings**;
3. Produce **structured conclusions** with time ranges, highs/lows and current position — always labeled "for research assistance, not investment advice";
4. With one click, turn follow-up tracking into a **scheduled task** (e.g. "monitor every 5 minutes"); results are written back to a dedicated chat thread.

![Investment Agent: conversational research](docs/screenshots/agent.png)

### 📈 Market Center — indices, K-lines and news

- **Overview**: live cards for major global indices (SSE, SZSE, ChiNext, CSI 300, HSI, Nasdaq, S&P 500, Dow Jones, Nikkei 225, and more)
- **Stock/index detail**: multi-timeframe K-lines (intraday to monthly), unadjusted/forward/backward adjustment, MACD and other indicators, volume profile
- **Movers**: rankings by change %, turnover and volume ratio
- **Financial news**: real-time feed with source labels — send any item to the Agent for further analysis

![Market K-line and indicators](docs/screenshots/market-kline.png)

### 🪟 Multi-View Workspace — research while watching the market

Split any page into **up to 3 side-by-side panels plus vertical splits**: run the Agent on the left, pin the news feed top-right, and lay a market K-line chart across the bottom. Panels resize freely — the layout is your workflow.

![Multi-view: Agent + news + market](docs/screenshots/multi-view.png)

### 🧮 Quant Toolbox

| Tool | Description |
|---|---|
| Algorithm tools | Built-in technical indicators and signal functions, extensible |
| Timed-signal backtest | Backtest historical signals on any symbol with return, win-rate and drawdown stats |
| Walk-Forward validation | Rolling train/validation windows to test robustness and prevent overfitting |
| Factor research | Write factor expressions online; IC / quantile backtests verify instantly |
| Portfolio rebalancing | Target weights and rebalance periods with commission and slippage models |

### 💼 Portfolio Management

- **Portfolio**: import your real holdings and let the Agent run risk attribution
- **Paper trading**: a full matching engine — limit/market orders, open orders & fills, position P&L, daily rollover and risk circuit breakers
- **Live OMS**: broker connectivity (desktop-only; mobile and plain sessions are rejected)
- **Risk center**: circuit breakers, intraday anchors, frequency limits — fully persisted and auditable

### ⏰ Scheduled Tasks

Run research jobs hourly, daily or on a custom interval, with a "trading days only" option (weekends & holidays skipped automatically) and automatic recycling of stuck tasks. Every run's results are written to a **dedicated chat thread** for later review.

### ⚡ Productivity

- **Command palette** (Ctrl+K): jump straight to pages, stock symbols, futures contracts or holdings
- **Built-in browser**: docked side panel — no window switching while researching
- **Agent usage dashboard**: Codex-style stats (total/peak tokens, longest chat, active-day streaks) with a GitHub-style daily/weekly/cumulative heatmap

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Desktop shell — Rust + Tauri 2                  │
│  · Window management / key injection (Win CredMan)│
│  · Engine child-process guard (random token handshake)│
├──────────────────────────────────────────────────┤
│  Frontend — React 19 + TypeScript + Vite         │
│  · Multi-view workspace / Agent chat / palette   │
├──────────────────────────────────────────────────┤
│  Local engine — Python FastAPI (127.0.0.1:8765)  │
│  · Agent orchestration & streaming (OpenAI protocol)│
│  · Market aggregation / backtests / matching / scheduler│
│  · Token + session dual auth / risk state machine│
├──────────────────────────────────────────────────┤
│  SQLite (WAL mode + schema migrations)           │
└──────────────────────────────────────────────────┘
```

- **Models**: OpenAI / DeepSeek / Qwen / OpenRouter, with an "Auto" mode that picks the first available free model by priority; reasoning effort is delivered per provider+model whitelist
- **Context management**: history budget is allocated dynamically from the model's context window (60%), with automatic summarization persisted across model switches
- **Mobile**: the engine can listen on the LAN (TLS encrypted); after pairing, a phone browser can view markets and paper trading

## Project Structure

```
QuantDesk/
├── src/                  # React frontend (pages, Agent chat, command palette)
├── src-tauri/            # Rust shell (engine guard, key injection, window management)
├── engine/               # Python FastAPI local engine
│   ├── main.py           #   routes, Agent orchestration, scheduler, auth middleware
│   ├── database.py       #   SQLite data layer (WAL + migrations)
│   ├── scheduler.py      #   scheduled task model
│   ├── marketdata.py     #   multi-source market aggregation
│   ├── papertrade.py     #   paper matching engine
│   └── tests/            #   118 unit tests
├── docs/screenshots/     # README screenshots
└── scripts/              # dev helper scripts
```

## Getting Started

**Requirements**: Windows 10+, Node.js 18+, Python 3.11+, Rust toolchain (for development only)

```bash
# 1. Install frontend dependencies
npm install

# 2. Start the desktop app (auto-spawns the local engine)
npm run tauri dev

# 3. Run engine tests (118 cases)
python -m pytest engine/tests
```

On first launch you'll be guided to create a local admin account, then add your model API keys in Settings (stored in the Windows Credential Manager and hot-loaded by the engine).

## Security Design

- **Local accounts**: PBKDF2-SHA256 password hashing, optional TOTP two-factor auth
- **Engine token**: the desktop process and engine handshake with a random UUID token — other processes on the machine cannot silently call order or import APIs
- **Keys never touch disk**: API keys live only in the Windows Credential Manager and are injected as environment variables at runtime; no secrets in the repo
- **Live-trading isolation**: real orders require the desktop process token; login sessions and mobile pairings are always rejected
- **Persistent risk control**: circuit breakers, daily anchors, frequency limits and unlock states are all persisted — auditable and recoverable

## Disclaimer

This project is for learning and research only and does not constitute investment advice. Past backtest and paper-trading results do not guarantee future performance — trade at your own risk.
