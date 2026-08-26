# 引擎打包产物更新检查：engine/*.py 有比 quant-engine.exe 更新的改动时自动重打包。
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

$exe = "src-tauri\target\debug\engine-bin\quant-engine.exe"
$newestPy = Get-ChildItem engine -Recurse -Filter *.py |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $newestPy) { Write-Host "    未找到 engine 源码"; exit 0 }

$needsBuild = $true
if (Test-Path $exe) {
    $needsBuild = $newestPy.LastWriteTime -gt (Get-Item $exe).LastWriteTime
}

if (-not $needsBuild) {
    Write-Host "    引擎产物已是最新（源码最新修改 $($newestPy.LastWriteTime.ToString('MM-dd HH:mm'))），跳过打包"
    exit 0
}

Write-Host "    检测到引擎代码更新（$($newestPy.Name)，$($newestPy.LastWriteTime.ToString('MM-dd HH:mm'))），重新打包中（约 1-2 分钟）..."
npm.cmd run engine:bundle
if ($LASTEXITCODE -ne 0) { Write-Host "    打包失败！"; exit 1 }

New-Item -ItemType Directory -Force -Path "src-tauri\target\debug\engine-bin" | Out-Null
Copy-Item "engine-dist\quant-engine.exe" $exe -Force
Write-Host "    已更新 $exe"
exit 0
