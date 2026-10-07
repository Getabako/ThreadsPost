#!/bin/bash
# ============================================================
#  Threads Post 起動スクリプト（アシュラ奥義の作法）
#  実行: bash ashura-start.sh     停止: bash ashura-start.sh stop
#  依存導入 → （必要なら）ビルド → サーバー起動 → ブラウザ表示 まで全部やる。
#  起動中でも、ソースが変わっていれば止めて作り直す（計画 Task 4）。
#  2026-10-07 アシュラ奥義として配布開始（id: threads-post）。
# ============================================================
set -u
cd "$(dirname "$0")" || exit 1

TOOL_NAME="Threads Post"
PORT_HINT=4593
STATE_DIR=".ashura"; mkdir -p "$STATE_DIR"
LOG="$STATE_DIR/server.log"; PIDF="$STATE_DIR/server.pid"; URLF="$STATE_DIR/server.url"
MANIFEST="$STATE_DIR/build-manifest"

say()  { printf "\033[36m▶ %s\033[0m\n" "$*"; }
ok()   { printf "\033[32m✓ %s\033[0m\n" "$*"; }
fail() { printf "\033[31m✗ %s\033[0m\n" "$*" >&2; }
open_url() { [ -n "${THREADSPOST_NO_OPEN:-}" ] || open "$1" 2>/dev/null || true; }
responds() { curl -s -o /dev/null --max-time 2 "$1"; }
alive() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF" 2>/dev/null)" 2>/dev/null; }
kill_tree() { local p="$1"; for c in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$c"; done; kill "$p" 2>/dev/null || true; }
stop_server() { if alive; then kill_tree "$(cat "$PIDF")"; sleep 1; fi; rm -f "$PIDF" "$URLF"; }

[[ -x /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)"
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

if [ "${1:-}" = "stop" ]; then
  if alive; then stop_server; ok "$TOOL_NAME を停止しました"; else echo "$TOOL_NAME は起動していません"; rm -f "$PIDF" "$URLF"; fi
  exit 0
fi

echo ""
echo "=================================================="
echo "  $TOOL_NAME を起動します"
echo "=================================================="

# 1. Node.js 24 以上・codex 0.160 以上（自動更新はしない）
if ! command -v node >/dev/null 2>&1; then fail "Node.js が見つかりません。Node.js 24 以上を入れてください。"; exit 1; fi
MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$MAJOR" -lt 24 ]; then fail "Node.js 24 以上が必要です（今は $(node -v)）。"; exit 1; fi
if ! command -v codex >/dev/null 2>&1; then fail "codex CLI が見つかりません。入れてから codex login でログインしてください。"; exit 1; fi
CV="$(codex --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1)"
CMAJ="${CV%%.*}"; CMIN="${CV#*.}"
if [ "${CMAJ:-0}" -eq 0 ] && [ "${CMIN:-0}" -lt 160 ]; then fail "codex 0.160 以上が必要です（今は $CV）。更新してください。"; exit 1; fi

# 2. 依存パッケージ（初回のみ）
if [ ! -d node_modules ]; then
  say "初回のみ: 部品（依存パッケージ）を入れています。数分かかります…"
  npm install || { fail "npm install に失敗"; exit 1; }
  ok "部品の導入が終わりました"
fi

# 3. ソースの指紋（ファイル一覧・大きさ・更新時刻）。削除も検知する
fingerprint() {
  find app lib core server public bin instrumentation.ts next.config.ts package.json package-lock.json tsconfig.json postcss.config.mjs \
    -type f -not -name '.DS_Store' 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do
      stat -f '%N %z %m' "$f"
    done | shasum -a 256 | cut -d' ' -f1
}
CURRENT="$(fingerprint)"
BUILT="$(cat "$MANIFEST" 2>/dev/null || true)"
NEED_BUILD=0
[ -f .next/standalone/server.js ] || NEED_BUILD=1
[ "$CURRENT" = "$BUILT" ] || NEED_BUILD=1

# 4. すでに起動中
if alive && [ -s "$URLF" ] && responds "$(cat "$URLF")"; then
  if [ "$NEED_BUILD" = 0 ]; then
    URL="$(cat "$URLF")"
    ok "$TOOL_NAME は起動済みです: $URL"
    open_url "$URL"
    echo "ASHURA_URL=$URL"
    exit 0
  fi
  say "ソースの変更を検知しました。いったん止めて作り直します"
  stop_server
fi
rm -f "$PIDF" "$URLF"

# 5. ビルド（初回と、ソースが変わったときだけ）
if [ "$NEED_BUILD" = 1 ]; then
  say "画面を組み立てています（初回と改造後のみ。数分かかります）…"
  npm run build || { fail "ビルドに失敗しました"; exit 1; }
  echo "$CURRENT" > "$MANIFEST"
  ok "組み立てが終わりました"
fi

# 6. サーバー起動（このスクリプトが終わっても生き残るよう切り離す）
say "サーバーを起動しています…"
: > "$LOG"
PORT="$PORT_HINT" nohup node bin/cli.mjs >> "$LOG" 2>&1 < /dev/null &
echo $! > "$PIDF"
disown 2>/dev/null || true

URL=""
for _ in $(seq 1 120); do
  [ -z "$URL" ] && URL="$(grep -oE 'http://127\.0\.0\.1:[0-9]+' "$LOG" 2>/dev/null | head -1 || true)"
  if [ -n "$URL" ] && responds "$URL"; then break; fi
  if ! alive; then
    fail "サーバーが途中で終了しました。ログ（${LOG}）の末尾:"; tail -n 30 "$LOG"; exit 1
  fi
  sleep 1
done
if [ -z "$URL" ] || ! responds "$URL"; then fail "起動を確認できませんでした。ログ（${LOG}）の末尾:"; tail -n 30 "$LOG"; exit 1; fi
echo "$URL" > "$URLF"

echo ""
echo "=================================================="
ok "$TOOL_NAME 起動完了"
echo "  ブラウザで開く: $URL"
echo "  停止する:       bash ashura-start.sh stop"
echo "=================================================="
echo "ASHURA_URL=$URL"
open_url "$URL"
exit 0
