#!/usr/bin/env bash
# Threads Post 〜Threads 投稿の下書きを Codex で〜 — ワンライン導入＆起動（macOS）
#
# 導入コマンドはアシュラのサイト（https://service.if-juku.net/Ashura/arts）で配布しています。
#
# 何度貼っても OK。毎回サイトから最新のZIPを取得して上書き更新してから起動します。
# 文章も画像も codex CLI（サブスク）で作る。有料 API は使わない。

set -e

# --- ASHURA_UNZIP_FIX: zip の展開 ---------------------------------------------
# macOS の unzip は日本語のファイル名を落として異常終了するので、まず ditto を使う。
ashura_unzip() { # $1=zip $2=展開先
  mkdir -p "$2"
  if [ "$(uname)" = "Darwin" ] && command -v ditto >/dev/null 2>&1; then
    ditto -x -k "$1" "$2" 2>/dev/null && return 0
  fi
  unzip -qq -O UTF-8 "$1" -d "$2" >/dev/null 2>&1 && return 0
  unzip -qq "$1" -d "$2" >/dev/null 2>&1 && return 0
  [ -n "$(ls -A "$2" 2>/dev/null)" ]
}
# --- ASHURA_UNZIP_FIX ここまで -------------------------------------------------


# 更新時は会員のカスタマイズを残す 3方向マージで配置する（ヘルパーはサイトから取得。取得できなければ従来どおり上書きコピー）
ashura_merge_update() {
  local helper; helper="$(mktemp)"
  if curl -fsSL --max-time 30 "https://service.if-juku.net/Ashura/installers/lib/merge-update.sh" -o "$helper" 2>/dev/null; then
    if bash "$helper" "$1" "$2" "$3"; then rm -f "$helper"; return 0; fi
    echo "更新ヘルパーが失敗したため、従来どおり上書きコピーします" >&2
  fi
  rm -f "$helper"; mkdir -p "$2"; cp -R "$1/." "$2/"
}

ZIP_URL="${THREADSPOST_ZIP_URL:-https://service.if-juku.net/api/ashura/download/threads-post}"
INSTALL_DIR="${THREADSPOST_HOME:-$HOME/Desktop/ThreadsPost}"

cyan()  { printf "\033[36m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*" >&2; }

__ash_on_error() {
  red ""
  red "──────────────────────────────────────────"
  red "  途中で止まりました。上の赤い文字（エラー）をそのままコピーして、"
  red "  Codex か Claude Code に貼り付け『このエラーを直して』と頼んでください。"
  red "──────────────────────────────────────────"
}
trap __ash_on_error ERR

cyan "▶ Threads Post 〜Threads 投稿の下書きを Codex で〜 セットアップを開始します"

if [[ "$(uname)" != "Darwin" ]]; then
  red "✗ install.sh は macOS 向けです。"
  red "Windows の方はアシュラのサイト（https://service.if-juku.net/Ashura/arts）で"
  red "配布している PowerShell 用の 1 行コマンドを実行してください。"
  exit 1
fi

[[ -x /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)"
[[ -x /usr/local/bin/brew ]] && eval "$(/usr/local/bin/brew shellenv)"

# 道具（Node / curl / unzip）の確認。
__missing=""
command -v node  >/dev/null 2>&1 || __missing="$__missing Node.js"
command -v curl  >/dev/null 2>&1 || __missing="$__missing curl"
command -v unzip >/dev/null 2>&1 || __missing="$__missing unzip"
if [[ -n "$__missing" ]]; then
  red "✗ 道具が足りません：$__missing"
  red ""
  red "先に『第一の儀（環境構築）』を一度だけ実行してください:"
  red "  /bin/bash -c \"\$(curl -fsSL https://service.if-juku.net/Ashura/setup.sh)\""
  exit 1
fi

# サイトから最新ZIPを取得して上書き更新（既存フォルダは削除せず、生成物・データは保持）
cyan "▶ 最新版をダウンロードします → $INSTALL_DIR"
ASH_TMP="$(mktemp -d)"
TMPZIP="$ASH_TMP/app.zip"
curl -fsSL -o "$TMPZIP" "$ZIP_URL"
ashura_unzip "$TMPZIP" "$ASH_TMP/extract"
SRC_DIR="$(find "$ASH_TMP/extract" -mindepth 1 -maxdepth 1 -type d -name '*-main' | head -n 1)"
[[ -z "$SRC_DIR" ]] && SRC_DIR="$ASH_TMP/extract"
mkdir -p "$INSTALL_DIR"
ashura_merge_update "$SRC_DIR" "$INSTALL_DIR" "$TMPZIP"
rm -rf "$ASH_TMP"

cd "$INSTALL_DIR"

# 部品の導入とビルドは ashura-start.sh が行う（初回は数分）

green ""
green "✓ 起動します。ブラウザが自動で開きます。終了は Ctrl+C。"
green ""
# スラッシュコマンドを設置（/threadspost で起動できるように）
curl -fsSL https://service.if-juku.net/Ashura/install-command.sh | bash -s -- threadspost "Threads Post 〜Threads 投稿の下書きを Codex で〜" "$INSTALL_DIR" "bash ashura-start.sh" 2>/dev/null || true
trap - ERR

# ダブルクリック起動ファイルを設置（次回からはこのファイルを開くだけで起動できる）
LAUNCHER="$INSTALL_DIR/Threads Postを起動.command"
cat > "$LAUNCHER" <<'ASHEOS'
#!/bin/bash
# ダブルクリックで Threads Post を起動します（終了はこのウインドウで Ctrl+C）
cd "$(dirname "$0")"
[[ -x /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)"
[[ -x /usr/local/bin/brew ]] && eval "$(/usr/local/bin/brew shellenv)"
exec bash ashura-start.sh
ASHEOS
chmod +x "$LAUNCHER"
green "✓ 次回からはインストール先フォルダの「Threads Postを起動.command」をダブルクリックするだけで起動できます" 2>/dev/null || echo "✓ 次回からは「Threads Postを起動.command」をダブルクリックするだけで起動できます"

# --- ASHURA_VERSION_BLOCK: 入れた版を記録する ------------------------------------------
# 起動時に「お使いの版 / 最新の版」を出すための控え。失敗しても導入は成功しているので止めない。
if [ -n "${INSTALL_DIR:-}" ]; then
  mkdir -p "$INSTALL_DIR/.ashura" 2>/dev/null || true
  curl -fsS --max-time 8 "https://service.if-juku.net/api/ashura/versions?id=threads-post&format=sha" > "$INSTALL_DIR/.ashura/version.txt" 2>/dev/null || true
fi
# --- ASHURA_VERSION_BLOCK ここまで ------------------------------------------------------

exec bash ashura-start.sh
