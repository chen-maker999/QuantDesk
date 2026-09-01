$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredMan {
    [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool CredRead(string target, int type, int flags, out IntPtr credPtr);
    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr cred);
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags; public int Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
        public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    public static string Read(string target) {
        IntPtr ptr;
        if (!CredRead(target, 1, 0, out ptr)) return null;
        try {
            CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            byte[] blob = new byte[c.CredentialBlobSize];
            Marshal.Copy(c.CredentialBlob, blob, 0, c.CredentialBlobSize);
            return System.Text.Encoding.UTF8.GetString(blob);
        } finally { CredFree(ptr); }
    }
}
"@

$map = @{
    "OpenAI.QuantDesk"       = "OPENAI_API_KEY"
    "DeepSeek.QuantDesk"     = "DEEPSEEK_API_KEY"
    "Qwen.QuantDesk"         = "DASHSCOPE_API_KEY"
    "OpenRouter.QuantDesk"   = "OPENROUTER_API_KEY"
    "Tushare.QuantDesk"      = "TUSHARE_TOKEN"
    "AlphaVantage.QuantDesk" = "ALPHAVANTAGE_API_KEY"
}

$env:QUANTDESK_ALLOW_INSECURE_LAN = "1"
foreach ($target in $map.Keys) {
    $secret = [CredMan]::Read($target)
    if ($secret) {
        Set-Item -Path ("Env:" + $map[$target]) -Value $secret
        Write-Host ("injected " + $map[$target] + " from " + $target)
    }
}

# 释放 8765 端口
Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host ("killing pid " + $_.OwningProcess)
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { $py = "python" }
Write-Host "starting engine with $py ..."
Set-Location (Split-Path $PSScriptRoot -Parent)
& $py engine\main.py
