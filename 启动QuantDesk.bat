@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ===================================================
echo             QuantDesk 开发启动
echo ===================================================
echo.
echo [0/3] 清理上次残留的引擎进程(释放 8765 端口, 确保运行的是新代码)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8765 ^| findstr LISTENING') do (
  taskkill /F /PID %%a >nul 2>&1
)

rem ---- 引擎是 PyInstaller 打包产物, 改了 engine/*.py 必须重打包才会生效 ----
echo [1/3] 检查 Python 引擎代码是否有更新...
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\update-engine.ps1
if errorlevel 1 (
  echo     引擎更新失败！请检查上方错误信息。
  pause
  exit /b 1
)

echo [2/3] 校验前端依赖(node_modules)...
if not exist node_modules (
  echo     首次运行，安装依赖中...
  call npm.cmd install
)

echo [3/3] 启动 QuantDesk（算法引擎随应用自动拉起）...
call npm.cmd run tauri dev
pause
