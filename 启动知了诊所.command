#!/bin/bash
# 知了诊所 · 启动器
# 双击这个文件即可打开。第一次打开 macOS 可能会提示"无法验证开发者"，
# 解决方法见旁边的说明，或者直接双击 index.html。

DIR="$(cd "$(dirname "$0")" && pwd)"
FILE="$DIR/index.html"

if [ ! -f "$FILE" ]; then
  echo "找不到 index.html，请确认这个文件和解压出来的文件夹放在一起。"
  read -n 1 -s -r -p "按任意键退出…"
  exit 1
fi

URL="file://$FILE"

if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="$URL" --window-size=1180,820
elif [ -d "/Applications/Microsoft Edge.app" ]; then
  open -na "Microsoft Edge" --args --app="$URL" --window-size=1180,820
else
  open "$URL"
fi
