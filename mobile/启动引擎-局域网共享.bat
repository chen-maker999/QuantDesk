@echo off
chcp 65001 >nul
title QuantDesk Engine (Mobile Sharing Mode)

REM ============================================================
REM  QuantDesk Engine - LAN sharing mode for the mobile app
REM  - Listens on 0.0.0.0 so phones in the same LAN can connect
REM  - Uses a fixed secondary token (QUANTDESK_MOBILE_TOKEN)
REM  - Put the SAME token into the mobile app: Settings > Engine
REM  - Note: while this script runs, the desktop app cannot spawn
REM    its own engine (port 8765 is occupied). If you need desktop
REM    + mobile at the same time, instead set the SYSTEM environment
REM    variables QUANTDESK_ENGINE_HOST=0.0.0.0 and
REM    QUANTDESK_MOBILE_TOKEN=<your-token>, then just use the desktop
REM    app as usual - the engine it spawns accepts both tokens.
REM ============================================================

cd /d "%~dp0.."

set "QUANTDESK_ENGINE_HOST=0.0.0.0"
if "%QUANTDESK_MOBILE_TOKEN%"=="" set "QUANTDESK_MOBILE_TOKEN=quantdesk-mobile"

REM CORS 来源策略（可选）：默认只放行本机/局域网来源(手机 H5 的 LAN 地址自动放行)；
REM 需要显式追加来源时(逗号分隔)：set "QUANTDESK_CORS_EXTRA_ORIGINS=http://192.168.1.50:5173"
REM 需要完全放开(旧行为, 不推荐)：set "QUANTDESK_CORS_OPEN=1"

REM 无 Key 模式检测：手工启动的引擎不会从凭据管理器注入模型密钥，
REM 若这些环境变量全部为空，模型/行情功能将不可用（仅提示，不阻止启动）。
set "ANY_KEY="
if not "%OPENAI_API_KEY%"=="" set "ANY_KEY=1"
if not "%DASHSCOPE_API_KEY%"=="" set "ANY_KEY=1"
if not "%DEEPSEEK_API_KEY%"=="" set "ANY_KEY=1"
if not "%TUSHARE_TOKEN%"=="" set "ANY_KEY=1"
if not "%ALPHAVANTAGE_API_KEY%"=="" set "ANY_KEY=1"

echo.
echo   Engine host : 0.0.0.0:8765
echo   Mobile token: %QUANTDESK_MOBILE_TOKEN%
echo   Your LAN IP :
ipconfig | findstr /i "IPv4"
echo.
echo   Mobile app Settings:
echo     Engine URL  = http://^<LAN-IP^>:8765
echo     Token       = %QUANTDESK_MOBILE_TOKEN%
echo.
if "%ANY_KEY%"=="" (
  echo   [WARN] No model/market API key found in environment.
  echo          This engine runs in NO-KEY mode: agent and market data
  echo          will report "not configured". For full keys, start the
  echo          desktop app instead, or set the key env vars first.
  echo.
)

python engine\main.py
pause
