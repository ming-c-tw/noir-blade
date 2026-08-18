#!/bin/bash
# 雙擊我：全檔更新——正文＋設定＋小說大腦＋工作規範＋地圖素材，全部重新加密打包推上線。
# 跟「墨刃推送.command」的差別：那支平常用、只推正文（大腦原地不動）；
# 這支連大腦一起推，用在「要換去另一台電腦之前」——那台跑「墨刃更新.command」就有整包最新進度。
# ⚠️ 手機 App 看不出差別（App 不讀大腦），這一步純粹是為了換機。
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")" || exit 1

echo "───────────────────────────────"
echo "  墨刃 · 全檔更新（含小說大腦）"
echo "───────────────────────────────"
node build.mjs --push --full
code=$?
echo ""
if [ $code -eq 0 ]; then
  echo "✅ 完成。另一台電腦跑「墨刃更新.command」就會拿到整包最新進度。"
else
  echo "⚠️  出了點狀況（見上方訊息）。"
fi
echo ""
echo "（按任意鍵關閉視窗）"
read -n 1 -s
