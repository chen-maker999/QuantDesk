<div align="center">

# QuantDesk

**An AI researcher on your desktop — a local-first quant research workstation**

[中文](README.md) · English · [日本語](README_JA.md)

![Platform](https://img.shields.io/badge/platform-Windows-blue) ![Engine](https://img.shields.io/badge/engine-Python%20FastAPI-green) ![Frontend](https://img.shields.io/badge/frontend-React%2019%20%2B%20TypeScript-cyan) ![Shell](https://img.shields.io/badge/shell-Rust%20%2B%20Tauri%202-orange)

</div>

---

## In one sentence

> **You say what you want in plain language; the Agent pulls the data, runs the backtests and writes up the conclusions. Market data, trading, scheduled jobs and risk control all live in a single window — and all data stays on your own computer.**

For you if you've ever thought:

| Scenario | What QuantDesk does |
|---|---|
| "What's the story with CATL right now?" | Ask the Agent. It pulls quotes, money flow and candlestick patterns on its own, then delivers sourced conclusions |
| "Would this strategy actually have made money?" | Feed the signal to the backtest engine: timed-signal backtests, Walk-Forward rolling validation, factor IC analysis — anti-overfitting built in |
| "Keep an eye on my portfolio risk daily" | Create a scheduled task; the Agent runs on schedule and writes results into a chat thread you can revisit |
| "Let me practice on paper first" | A complete paper-trading engine: limit/market orders, position P&L, risk circuit breakers — go live only when ready |

**It is not**: a cloud SaaS (no account, nothing uploaded), a stock-picking service (every output is labeled "for research assistance, not investment advice"), or a black-box auto-trader (real orders are desktop-only and manual).

## 5-minute quick start

```bash
# Requirements: Windows 10+, Node.js 18+, Python 3.11+ (Rust toolchain for development)
npm install          # Install frontend dependencies
npm run tauri dev    # Start the desktop app; the engine spawns automatically
```

1. **Create a local account** — first launch walks you through an admin username & password (PBKDF2-hashed, optional TOTP 2FA). It's the key to the app and nothing else — no cloud involved.
2. **Add one model API key** — in Settings pick a provider (DeepSeek / Qwen / OpenRouter all have free or low-cost models) and paste your key. It's stored in the Windows Credential Manager and hot-loaded by the engine — never written to disk. No paid key? A free OpenRouter key unlocks the full Agent experience.
3. **First conversation** — on the home page type "Analyze Kweichow Moutai's recent trend" and watch the Agent plan → call tools → stream the conclusion.
4. **Explore market data** — "Market" in the sidebar: global index cards, stock K-lines with MACD, movers rankings, financial news.
5. **Run a backtest** — the "Backtest" page: pick a symbol, set parameters, get a return/win-rate/drawdown report in minutes.
6. **(Optional) Schedule a task** — tell the Agent "monitor CATL every 5 minutes"; confirm once and it runs on schedule, writing results back into the chat.

## Features in detail

### 🤖 Investment Agent — research through conversation

Describe the goal in plain language; the Agent handles the rest:

```
You: Analyze CATL's current money flow and candlestick patterns

Agent:
  ① Plans the task (fully visualized — every step inspectable)
  ② Calls tools: market snapshot → daily money-flow series → pattern scan → movers
  ③ Delivers conclusions: time range, highs/lows, current position, what to watch
  ④ Labels it: "research assistance, not investment advice"
```

- **Nothing is hidden**: every tool call and returned dataset is shown inline
- **Want continuous tracking?** One click turns the research into a scheduled task whose results land in a dedicated chat thread
- **Swap models freely**: OpenAI / DeepSeek / Qwen / OpenRouter. "Auto" mode picks the first available free model by priority; conversation context survives model switches

![Investment Agent: conversational research](docs/screenshots/agent.png)

### 📈 Market Center — the data dashboard

| Page | Content |
|---|---|
| Overview | Live cards for major global indices: SSE, SZSE, ChiNext, CSI 300, HSI, Nasdaq, S&P 500, Dow Jones, Nikkei 225 |
| Stock / index detail | Multi-timeframe K-lines (intraday to monthly), forward/backward adjustment, MACD and other indicators, volume profile |
| Movers | Multi-dimension rankings by change, turnover and volume ratio — hand any list to the Agent for deeper digging |
| Financial news | Real-time feed with source labels; send any item to the Agent for interpretation |

Data providers include Tushare and Alpha Vantage, switchable in Settings.

![Market K-line and indicators](docs/screenshots/market-kline.png)

### 🪟 Multi-View Workspace — the whole flow in one window

Split any page into **up to 3 side-by-side panels plus vertical splits**: Agent running research on the left, news pinned top-right, a market K-line across the bottom. Panels resize freely — watch, read and wait for conclusions without switching windows.

![Multi-view workspace](docs/screenshots/multi-view.png)

### 🧮 Quant Toolbox — the four backtests

| Tool | The question it answers |
|---|---|
| Timed-signal backtest | "Would this signal have made money?" — returns, win rate, max drawdown |
| Walk-Forward validation | "Are these parameters overfitted?" — rolling train/validation windows test out-of-sample performance |
| Factor research | "Does this factor predict anything?" — write factor expressions online; IC / quantile backtests verify instantly |
| Portfolio rebalancing | "How would this allocation hold up long term?" — target weights, rebalance periods, commission & slippage models |

### 💼 Portfolio management — from paper to live

- **Portfolio**: import real holdings; the Agent can run risk attribution
- **Paper trading**: realistic matching — limit/market orders, open orders & fills, position P&L, daily rollover, plus risk circuit breakers (per-order/daily loss caps, frequency limits)
- **Live OMS**: broker connectivity (**real orders accepted from the desktop process only**; mobile and plain sessions are always rejected)
- **Risk center**: circuit breakers, intraday anchors and unlock states are persisted — every action auditable

### ⏰ Scheduled tasks — your automated research assistant

Runs hourly, daily or on custom intervals; "trading days only" skips weekends and holidays automatically; tasks stuck for 15 minutes are recycled on their own. Every run's results land in a dedicated chat thread for later review.

### ⚡ Three productivity tools

- **Command palette (Ctrl+K)**: search pages, stock symbols, futures contracts, holdings — jump in one step
- **Built-in browser**: docked side panel, no window switching while researching
- **Usage dashboard**: total/peak tokens, longest chat, active-day streaks + a GitHub-style heatmap (daily/weekly/cumulative)

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Desktop shell — Rust + Tauri 2                  │
│   Window management · key injection (Win CredMan)│
│   Engine child-process guard (random UUID token) │
├──────────────────────────────────────────────────┤
│  Frontend — React 19 + TypeScript + Vite         │
│   Multi-view workspace · streaming Agent chat ·  │
│   command palette                                │
├──────────────────────────────────────────────────┤
│  Local engine — Python FastAPI (127.0.0.1:8765)  │
│   Agent orchestration · market aggregation ·     │
│   backtests · paper matching · scheduler ·       │
│   dual auth · risk state machine                 │
├──────────────────────────────────────────────────┤
│  Storage — SQLite (WAL mode + schema migrations) │
└──────────────────────────────────────────────────┘
```

**Why a separate local engine?** The engine is an independent Python process, which means a phone can connect too (LAN + TLS + pairing token). The desktop shell handles key injection and process guarding — the engine never holds your keys in plain text.

## Project structure

```
QuantDesk/
├── src/                  # React frontend (pages, Agent chat, command palette)
├── src-tauri/            # Rust shell (engine guard, key injection, window management)
├── engine/               # Python FastAPI local engine
│   ├── main.py           #   routes, Agent orchestration, scheduler, auth middleware
│   ├── database.py       #   SQLite data layer (WAL + migrations)
│   ├── authx.py          #   account auth (PBKDF2 + TOTP)
│   ├── scheduler.py      #   scheduled task model
│   ├── marketdata.py     #   multi-source market aggregation
│   ├── papertrade.py     #   paper matching engine
│   └── tests/            #   118 unit tests
├── docs/screenshots/     # README screenshots
└── scripts/              # dev helper scripts
```

## Development & testing

```bash
npm run tauri dev                  # Start the desktop app (dev mode)
npm run test:engine                # Engine unit tests (unittest)
python -m pytest engine/tests -q   # Engine tests (pytest, 118 cases passing)
npm run build                      # Frontend build check (tsc + vite build)
```

## FAQ

<details>
<summary><b>Does any data leave my machine?</b></summary>

No. Market data comes from the providers you configure, conversations and the database are local SQLite, keys live in the Windows Credential Manager. The only outbound traffic: market data providers, model APIs, and broker endpoints (if configured).
</details>

<details>
<summary><b>Can I use it without a paid API key?</b></summary>

Yes. Add a free OpenRouter key and the Agent's "Auto" mode automatically picks an available model from the free tier.
</details>

<details>
<summary><b>Does it work on a phone?</b></summary>

Yes. Enable LAN access in Settings (TLS + pairing token), then open the engine address in a mobile browser to view markets and paper trading. Real orders are desktop-only.
</details>

<details>
<summary><b>The engine port is taken — what now?</b></summary>

The engine listens on 8765. Restarting the desktop app cleans up stale processes; `scripts/restart-engine-debug.ps1` handles it manually.
</details>

## Disclaimer

This project is for learning and research only and does not constitute investment advice. Past backtest and paper-trading results do not guarantee future performance — trade at your own risk.
