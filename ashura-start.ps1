# ============================================================
#  Threads Post 起動スクリプト（アシュラ奥義 共通・自動生成・Windows）
#  「起動して」= このファイルを実行するだけ。判断は一切しない。
#  実行: powershell -NoProfile -ExecutionPolicy Bypass -File ashura-start.ps1
#  停止: 同コマンドに stop を付ける
# ============================================================
param([string]$Action = "")
$ErrorActionPreference = "Continue"
Set-Location -Path $PSScriptRoot
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ToolName  = "Threads Post"
$Kind      = "next-cli"
$StartCmd  = 'node bin/cli.mjs'
$PortHint  = 4593
$SelfOpens = 1
# (追加の環境変数なし)

$StateDir = ".ashura"; New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$Log  = Join-Path $StateDir "server.log"
$PidF = Join-Path $StateDir "server.pid"
$UrlF = Join-Path $StateDir "server.url"

function Say($m)  { Write-Host "▶ $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "✓ $m" -ForegroundColor Green }
function Fail($m) { Write-Host "✗ $m" -ForegroundColor Red }
function Responds($u) { try { $null = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 2; return $true } catch { return $false } }
function Alive() { if (Test-Path $PidF) { $p = Get-Content $PidF -ErrorAction SilentlyContinue; if ($p) { return [bool](Get-Process -Id $p -ErrorAction SilentlyContinue) } }; return $false }
function KillTree($ProcId) { Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcId" -ErrorAction SilentlyContinue | ForEach-Object { KillTree $_.ProcessId }; Stop-Process -Id $ProcId -Force -ErrorAction SilentlyContinue }

# PATH（nodejs / npm グローバル）
$env:Path = "$env:ProgramFiles\nodejs;$env:APPDATA\npm;$env:LOCALAPPDATA\pnpm;" + $env:Path

if ($Action -eq "stop") {
  if (Alive) { KillTree (Get-Content $PidF); Ok "$ToolName を停止しました" } else { Write-Host "$ToolName は起動していません" }
  Remove-Item $PidF, $UrlF -ErrorAction SilentlyContinue; exit 0
}

Write-Host ""; Write-Host "=================================================="; Write-Host "  $ToolName を起動します"; Write-Host "=================================================="

# --- ASHURA_VERSION_BLOCK（起動中の更新）: 古い版で動いているサーバーを止める -----------------------
if ((Alive) -and -not $env:ASHURA_NO_UPDATE) {
  $stale = ""
  if ((Test-Path ".next\BUILD_ID") -and ((Get-Item ".next\BUILD_ID").LastWriteTime -gt (Get-Item $PidF).LastWriteTime)) { $stale = "作り直した新しい画面に切り替えます" }
  if (-not $stale) {
    $mine = ""; $vf = Join-Path $StateDir "version.txt"; if (Test-Path $vf) { $mine = (Get-Content $vf -Raw).Trim() }
    try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 -Uri ("https://service.if-juku.net/api/ashura/versions?id=threads-post&format=status&have=" + $mine)).Content.Trim() -eq "update") { $stale = "新しい版が出ているので更新します" } } catch { }
  }
  if ($stale) {
    Write-Host "▶ 動いている $ToolName は古い版です。いったん止めて、$stale" -ForegroundColor Cyan
    KillTree (Get-Content $PidF); Remove-Item $PidF, $UrlF -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1
  }
}
# --- ASHURA_VERSION_BLOCK ここまで ------------------------------------------------------

# 0. 起動済みならブラウザを開くだけ
if ((Alive) -and (Test-Path $UrlF)) { $u = (Get-Content $UrlF).Trim(); if ($u -and (Responds $u)) { Ok "$ToolName は起動済みです: $u"; Start-Process $u; Write-Host "ASHURA_URL=$u"; exit 0 } }
Remove-Item $PidF, $UrlF -ErrorAction SilentlyContinue

# --- ASHURA_VERSION_BLOCK: 版の確認と自動更新 --------------------------------------------
$ArtId = "threads-post"
$AshuraApi = "https://service.if-juku.net/api/ashura/versions"
function Ashura-Api($q) {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 -Uri ("$AshuraApi" + "?id=$ArtId&" + $q)).Content.Trim() } catch { return "" }
}
function Ashura-SelfUpdate {
  Write-Host "▶ 最新版に更新しています（あなたが手を加えた所は残します）…" -ForegroundColor Cyan
  $t = Join-Path ([System.IO.Path]::GetTempPath()) ("ashura-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $t | Out-Null
  try {
    $zip = Join-Path $t "app.zip"
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 600 -Uri "https://service.if-juku.net/api/ashura/download/$ArtId" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath (Join-Path $t "src") -Force
    $src = Get-ChildItem -Directory (Join-Path $t "src") | Select-Object -First 1
    if (-not $src) { throw "更新版の中身が見つかりません" }
    $code = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Uri "https://service.if-juku.net/Ashura/installers/lib/merge-update.ps1").Content
    & ([scriptblock]::Create($code)) -Src $src.FullName -Dest $PSScriptRoot -Zip $zip
    $sha = Ashura-Api "format=sha"
    if ($sha) { Set-Content -NoNewline -Path (Join-Path $StateDir "version.txt") -Value $sha }
    # zip から取り込んだファイルは時刻が古いので、印を消して必ず作り直させる
    Remove-Item -Force (Join-Path $PSScriptRoot ".nextBUILD_ID") -ErrorAction SilentlyContinue
    Write-Host "✓ 最新版に更新しました" -ForegroundColor Green
  } catch {
    Write-Host "✗ 更新に失敗しました。今の版のまま起動します（配布ページのコマンドで更新できます）" -ForegroundColor Yellow
  } finally { Remove-Item -Recurse -Force $t -ErrorAction SilentlyContinue }
}
function Show-AshuraVersion {
  $mine = ""
  $vf = Join-Path $StateDir "version.txt"
  if (Test-Path $vf) { $mine = (Get-Content $vf -Raw).Trim() }
  $txt = Ashura-Api ("have=" + $mine + "&format=text")
  if ($txt) { Write-Host ""; Write-Host $txt }
  $st = Ashura-Api ("have=" + $mine + "&format=status")
  if ($st -eq "update") {
    if ($env:ASHURA_NO_UPDATE) { Write-Host "  （自動更新は切ってあります）" } else { Ashura-SelfUpdate }
  }
}
Show-AshuraVersion
# --- ASHURA_VERSION_BLOCK ここまで ------------------------------------------------------

# 1. Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js が見つかりません。https://nodejs.org から LTS 版を入れて、もう一度実行してください。"; exit 1 }
$major = [int]((node -p "process.versions.node.split('.')[0]") 2>$null)
if ($major -lt 20) { Fail "Node.js 20 以上が必要です（現在 $(node -v)）。"; exit 1 }
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { Write-Host "  注意: codex CLI が見つかりません。画面は開きますが、生成機能には codex が必要です（npm i -g @openai/codex）" }
# codex は古いと新しいモデル（gpt-5.6-sol 以降）を使えないので、0.150 未満なら自動で更新する
if (Get-Command codex -ErrorAction SilentlyContinue) {
  try {
    $cv = (codex --version 2>$null | Select-String -Pattern "[0-9]+\.[0-9]+" | ForEach-Object { $_.Matches[0].Value } | Select-Object -First 1)
    if ($cv) { $parts = $cv.Split("."); if ([int]$parts[0] -eq 0 -and [int]$parts[1] -lt 150) { Say "codex を最新に更新しています（新しいAIモデルに対応するため）…"; npm i -g @openai/codex@latest | Out-Null } }
  } catch {}
}

# 2. 依存（初回のみ）
if ((Test-Path package.json) -and -not (Test-Path node_modules)) {
  Say "初回のみ: 部品（依存パッケージ）を入れています。数分かかります…"
  if (Test-Path pnpm-lock.yaml) {
    if (Get-Command pnpm -ErrorAction SilentlyContinue) { pnpm install } else { npx --yes pnpm@9 install; if ($LASTEXITCODE -ne 0) { npm install } }
  } else { npm install }
  if ($LASTEXITCODE -ne 0) { Fail "依存の導入に失敗しました"; exit 1 }
  Ok "部品の導入が終わりました"
}

# 3. ビルド（Next.js 系のみ）
if ($Kind -eq "next-cli" -or $Kind -eq "next-start") {
  $need = -not (Test-Path ".next\BUILD_ID")
  if ($Kind -eq "next-cli" -and -not (Test-Path ".next\standalone\server.js")) { $need = $true }
  if (-not $need) {
    $stamp = (Get-Item ".next\BUILD_ID").LastWriteTime
    foreach ($d in @("app","lib","components","src","pages")) {
      if (Test-Path $d) { $c = Get-ChildItem $d -Recurse -File | Where-Object { $_.LastWriteTime -gt $stamp } | Select-Object -First 1; if ($c) { $need = $true; Say "ソースの変更を検知しました（$($c.FullName)）。作り直します"; break } }
    }
  }
  if ($need) {
    Say "画面を組み立てています（初回と改造後のみ。数分かかります）…"
    if ((Test-Path pnpm-lock.yaml) -and (Get-Command pnpm -ErrorAction SilentlyContinue)) { pnpm build } else { npm run build }
    if ($LASTEXITCODE -ne 0) { Fail "ビルドに失敗しました"; exit 1 }
    Ok "組み立てが終わりました"
  }
}

# 4. サーバー起動（別プロセスで切り離す）
$knownUrl = ""
if ($StartCmd -like "*__PORT__*") {
  $port = $PortHint
  while (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $port++ }
  $StartCmd = $StartCmd.Replace("__PORT__", "$port"); $knownUrl = "http://localhost:$port"
}
Say "サーバーを起動しています…"
Set-Content -Path $Log -Value ""
$proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c $StartCmd >> `"$Log`" 2>&1" -WindowStyle Hidden -PassThru
Set-Content -Path $PidF -Value $proc.Id

# 5. URL 応答待ち（最大 120 秒）
$url = $knownUrl
for ($i = 0; $i -lt 120; $i++) {
  if (-not $url) { $m = Select-String -Path $Log -Pattern 'https?://(localhost|127\.0\.0\.1):[0-9]+' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($m) { $url = $m.Matches[0].Value } }
  if ($url -and (Responds $url)) { break }
  if (-not (Alive)) { Fail "サーバーが途中で終了しました。ログ（${Log}）の末尾:"; Get-Content $Log -Tail 30; Fail "上の赤い文字をそのまま Codex に貼って「直して」と頼んでください。"; exit 1 }
  Start-Sleep -Seconds 1
}
if (-not $url -or -not (Responds $url)) { Fail "起動を確認できませんでした。ログ（${Log}）の末尾:"; Get-Content $Log -Tail 30; exit 1 }
$url = $url.Replace("127.0.0.1", "localhost")
Set-Content -Path $UrlF -Value $url

Write-Host ""; Write-Host "=================================================="
Ok "$ToolName 起動完了"
Write-Host "  ブラウザで開く: $url"
Write-Host "  停止する:       powershell -ExecutionPolicy Bypass -File ashura-start.ps1 stop"
Write-Host "=================================================="
Write-Host "ASHURA_URL=$url"
if ($SelfOpens -ne 1) { Start-Process $url }
exit 0
