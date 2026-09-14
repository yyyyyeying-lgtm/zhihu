#!/bin/bash
#
# 一键把 yeing.online 的解析配好，指向 Vercel 上的知了诊所。
#
# 用法：双击本文件即可。（会自动打开终端窗口）
#
# 前提：阿里云账号已完成「账号实名认证」。
#       若还没做，脚本会明确告诉你去哪做 —— 这是阿里云的合规要求，
#       未实名的账号无法新增解析记录，网页控制台同样会被拒。

cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/bin:$PATH"

DOMAIN="yeing.online"
APEX1="216.198.79.1"
APEX2="64.29.17.1"

echo "════════════════════════════════════════════════════════"
echo "  知了诊所 · 一键配置域名解析"
echo "  域名：$DOMAIN"
echo "════════════════════════════════════════════════════════"
echo

# ---- 前置检查 1：阿里云命令行工具 ----
if ! command -v aliyun >/dev/null 2>&1; then
  echo "❌ 找不到 aliyun 命令（应装在 ~/.local/bin/aliyun）。"
  echo "   请把这句话截图发给你的助手。"
  echo
  read -r -p "按回车键关闭…" _
  exit 1
fi

# ---- 前置检查 2：授权是否还有效 ----
echo "[1/3] 检查阿里云授权…"
PROFILES="$(aliyun configure list 2>&1)"
if printf '%s' "$PROFILES" | grep -q "zhihu.*Valid"; then
  echo "      ✓ 授权有效"
else
  echo "      ✗ 授权已失效或不存在。"
  echo
  echo "   需要重新授权一次。请在终端里执行下面这行，"
  echo "   它会打开浏览器让你登录阿里云："
  echo
  echo "       aliyun configure --profile zhihu --mode OAuth"
  echo
  echo "   授权完成后，再跑一次："
  echo "       aliyun configure set --profile zhihu --region cn-hangzhou"
  echo
  echo "   （或者直接找你的助手，让他帮你做）"
  echo
  read -r -p "按回车键关闭…" _
  exit 1
fi

# ---- 正式配置 ----
echo "[2/3] 写入解析记录（www 走 CNAME，根域名走两条 A）…"
echo
bash tools/aliyun-dns-setup.sh "$DOMAIN" \
  --apex-ip "$APEX1" --apex-ip "$APEX2" --apply
RC=$?
echo

if [ "$RC" -ne 0 ]; then
  echo "════════════════════════════════════════════════════════"
  echo "  没有配置成功，原因见上方提示。"
  echo "  最常见的就是「阿里云账号未完成实名认证」。"
  echo "════════════════════════════════════════════════════════"
  echo
  read -r -p "按回车键关闭…" _
  exit 1
fi

# ---- 复核 ----
echo "[3/3] 等待解析生效并复核…"
echo
for i in 1 2 3 4 5 6; do
  sleep 10
  W="$(dig +short CNAME www.$DOMAIN @223.5.5.5 2>/dev/null | head -1)"
  A1="$(dig +short A $DOMAIN @223.5.5.5 2>/dev/null | head -1)"
  printf "   第 %d 次查询：www → %s ｜ 根域名 → %s\n" "$i" "${W:-（还没生效）}" "${A1:-（还没生效）}"
  if [ -n "$W" ] && [ -n "$A1" ]; then break; fi
done

echo
echo "════════════════════════════════════════════════════════"
echo "  完成。"
echo
echo "  下一步（需要在 Vercel 上点一下）："
echo "    Vercel → 项目 zhihu → Settings → Domains → 点 Refresh"
echo "    等两个域名都变成绿勾，HTTPS 证书会自动签发。"
echo
echo "  生效后地址："
echo "    https://www.$DOMAIN"
echo "    https://$DOMAIN"
echo "════════════════════════════════════════════════════════"
echo
read -r -p "按回车键关闭…" _
