#!/bin/bash
# 雙擊我：把最新墨刃章節＋設定重新加密打包，推上 GitHub。
# 手機開 App 即可看到更新（密碼不變、密碼檔不會上傳）。
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")" || exit 1

echo "───────────────────────────────"
echo "  墨刃 App · 更新推送"
echo "───────────────────────────────"
node build.mjs --push
code=$?
echo ""
if [ $code -eq 0 ]; then
  echo "✅ 完成。手機開 App 就會更新。"
else
  echo "⚠️  出了點狀況（見上方訊息）。"
fi
echo ""
echo "（按任意鍵關閉視窗）"
read -n 1 -s
