# addons/smoke-view/tools/convert-nvdb-to-pvdb/convert.ps1 — PowerShell ラッパー
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConvertMjs = Join-Path $ScriptDir "convert.mjs"

if (-not (Test-Path $ConvertMjs)) {
    Write-Error "convert.mjs not found: $ConvertMjs"
    exit 1
}

& node $ConvertMjs @Args
exit $LASTEXITCODE
