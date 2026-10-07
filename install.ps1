# Threads Post 〜Threads 投稿の下書きを Codex で〜 — ワンライン導入＆起動（Windows / PowerShell）
#
# 導入コマンドはアシュラのサイト（https://service.if-juku.net/Ashura/arts）で配布しています。
#
# Next.js 製。初回は部品の導入とビルドで数分かかる。AI生成は codex CLI（サブスク）のみ。
# 毎回サイトから最新のZIPを取得して上書き更新してから起動します。

$ErrorActionPreference = "Stop"

# 更新時は会員のカスタマイズを残す 3方向マージで配置する（ヘルパーはサイトから取得。取得できなければ従来どおり上書きコピー）
# .ps1 ファイルの直接実行は実行ポリシーで止まる環境があるため、内容をスクリプトブロックとして実行する
function Ashura-MergeUpdate([string]$Src, [string]$Dest, [string]$Zip) {
    try {
        $code = (Invoke-WebRequest -UseBasicParsing -Uri "https://service.if-juku.net/Ashura/installers/lib/merge-update.ps1" -TimeoutSec 30).Content
        & ([scriptblock]::Create($code)) -Src $Src -Dest $Dest -Zip $Zip
        return
    } catch {
        Write-Host "更新ヘルパーを実行できなかったため、従来どおり上書きコピーします: $($_.Exception.Message)" -ForegroundColor Yellow
    }
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    Copy-Item -Path (Join-Path $Src "*") -Destination $Dest -Recurse -Force
}

$ZipUrl     = if ($env:THREADSPOST_ZIP_URL) { $env:THREADSPOST_ZIP_URL } else { "https://service.if-juku.net/api/ashura/download/threads-post" }
$InstallDir = if ($env:THREADSPOST_HOME) { $env:THREADSPOST_HOME } else { Join-Path $HOME "Desktop\ThreadsPost" }

function Cyan($m)  { Write-Host $m -ForegroundColor Cyan }
function Green($m) { Write-Host $m -ForegroundColor Green }
function Red($m)   { Write-Host $m -ForegroundColor Red }

Cyan "▶ Threads Post 〜Threads 投稿の下書きを Codex で〜 セットアップを開始します"

# 道具の確認（Node）
$missing = @()
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $missing += "Node.js" }
if ($missing.Count -gt 0) {
  Red ("✗ 道具が足りません：" + ($missing -join " "))
  Red "先に『第一の儀（環境構築）』を実行してください:"
  Red "  iwr -useb https://service.if-juku.net/Ashura/setup.ps1 | iex"
  exit 1
}

# サイトから最新ZIPを取得して上書き更新（既存フォルダは削除せず、生成物・データは保持）
Cyan "▶ 最新版をダウンロードします → $InstallDir"
$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ashura_" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
$TmpZip = Join-Path $TmpDir "app.zip"
Invoke-WebRequest -UseBasicParsing -Uri $ZipUrl -OutFile $TmpZip
$ExtractDir = Join-Path $TmpDir "extract"
Expand-Archive -Path $TmpZip -DestinationPath $ExtractDir -Force
$TopDir = Get-ChildItem -Path $ExtractDir -Directory | Where-Object { $_.Name -like "*-main" } | Select-Object -First 1
$SrcPath = if ($TopDir) { $TopDir.FullName } else { $ExtractDir }
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Ashura-MergeUpdate -Src $SrcPath -Dest $InstallDir -Zip $TmpZip
Remove-Item -Recurse -Force $TmpDir

Set-Location $InstallDir

# スラッシュコマンドを設置（/threadspost）
try {
  $cmdDir = Join-Path $HOME ".claude\commands"
  New-Item -ItemType Directory -Force -Path $cmdDir | Out-Null
  $body = @"
---
description: Threads Post 〜Threads 投稿の下書きを Codex で〜 を起動してブラウザで開く
allowed-tools: Bash
---

Threads Post 〜Threads 投稿の下書きを Codex で〜（ローカルの Web ツール）を起動する。

手順:
1. ツールのルートは ``$InstallDir``。
2. ``powershell -NoProfile -ExecutionPolicy Bypass -File ashura-start.ps1`` を run_in_background で起動する（初回は部品の導入とビルドで数分）。
3. 起動ログの http://localhost:<port> を読み取り、ブラウザで開く。URL をユーザーに伝える。
4. 終了は Ctrl+C と案内する。
"@
  Set-Content -Path (Join-Path $cmdDir "threadspost.md") -Value $body -Encoding UTF8
} catch {}

Green ""
Green "✓ 起動します。ブラウザが自動で開きます。終了は Ctrl+C。"
Green ""

# ダブルクリック起動ファイルを設置（次回からはこのファイルを開くだけで起動できる）
$LauncherPath = Join-Path $InstallDir "Threads Postを起動.bat"
$LauncherBody = "@echo off`r`ncd /d `"%~dp0`"`r`npowershell -NoProfile -ExecutionPolicy Bypass -File ashura-start.ps1`r`npause"
Set-Content -Path $LauncherPath -Value $LauncherBody
Write-Host "✓ 次回からはインストール先フォルダの「Threads Postを起動.bat」をダブルクリックするだけで起動できます" -ForegroundColor Green

# --- ASHURA_VERSION_BLOCK: 入れた版を記録する ------------------------------------------
try {
  $vd = Join-Path $InstallDir ".ashura"
  New-Item -ItemType Directory -Force -Path $vd | Out-Null
  $sha = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 -Uri "https://service.if-juku.net/api/ashura/versions?id=threads-post&format=sha").Content.Trim()
  if ($sha) { Set-Content -NoNewline -Path (Join-Path $vd "version.txt") -Value $sha }
} catch { }
# --- ASHURA_VERSION_BLOCK ここまで ------------------------------------------------------

powershell -NoProfile -ExecutionPolicy Bypass -File ashura-start.ps1
