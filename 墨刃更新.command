#!/bin/bash
# 雙擊我：把「手機 App 上改過、已推上 GitHub」的最新內容，拉回並解密寫回本地書稿 .md。
# 只覆蓋真的變動的檔，沒改的一律不動。回 Mac 要繼續編輯／推新章前，先跑這個。
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")" || exit 1

echo "───────────────────────────────"
echo "  墨刃 App · 反向同步（線上 → 本地）"
echo "───────────────────────────────"
node pull.mjs
code=$?
echo ""
if [ $code -eq 0 ]; then
  echo "✅ 完成。本地書稿已與線上同步。"
else
  echo "⚠️  出了點狀況（見上方訊息）。"
fi
echo ""
echo "（按任意鍵關閉視窗）"
read -n 1 -s
