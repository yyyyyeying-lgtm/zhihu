#!/usr/bin/env bash
#
# 给「知了诊所」配 DNS：www 走 CNAME，根域名走 A，都指向 Vercel。
#
# 默认只读（dry-run）：只打印"我打算做什么"，加 --apply 才真的写。
# DNS 改动会直接影响线上访问，误删一条 MX 就可能收不到邮件，所以默认不写。
#
# 用法：
#   bash tools/aliyun-dns-setup.sh yeing.online                     # 只看现状
#   bash tools/aliyun-dns-setup.sh yeing.online --apex-ip <IP>      # 看计划
#   bash tools/aliyun-dns-setup.sh yeing.online --apex-ip <IP> --apply
#
# 记录值不要凭记忆写。先跑这条拿到 Vercel 的权威值：
#   vercel domains verify yeing.online      # 看 A 记录的 IP
#   vercel domains verify www.yeing.online  # 看 CNAME 的目标
#
# 前置：aliyun CLI 已装好并已授权
#   aliyun configure --profile zhihu --mode OAuth
#   aliyun configure set --profile zhihu --region cn-hangzhou   # OAuth 后 region 是空的，必须补

set -euo pipefail

PROFILE="${ALIYUN_PROFILE:-zhihu}"
CNAME_VALUE="${CNAME_VALUE:-1ef7e654b609fb83.vercel-dns-017.com}"
APPLY=0
DOMAIN=""
APEX_IPS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --apex-ip) APEX_IPS+=("${2:-}"); shift 2 ;;
    --cname)   CNAME_VALUE="${2:-}"; shift 2 ;;
    --apply)   APPLY=1; shift ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) echo "未知参数：$1" >&2; exit 2 ;;
    *)  DOMAIN="$1"; shift ;;
  esac
done

if [ -z "$DOMAIN" ]; then
  echo "用法：bash tools/aliyun-dns-setup.sh <域名> [--apex-ip <IP>]... [--apply]" >&2
  exit 2
fi

# 容忍抄域名时顺手带上协议 / www. / 结尾斜杠
DOMAIN="$(printf '%s' "$DOMAIN" | sed -E 's#^https?://##; s#/.*$##; s#^www\.##')"

command -v aliyun  >/dev/null 2>&1 || { echo "找不到 aliyun 命令（应装在 ~/.local/bin/aliyun）" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "找不到 python3，脚本靠它做判定" >&2; exit 1; }

ali() { aliyun --profile "$PROFILE" "$@"; }
hr()  { printf '%s\n' "------------------------------------------------------------"; }

echo "域名    ：$DOMAIN"
echo "profile ：$PROFILE"
echo "模式    ：$([ "$APPLY" = 1 ] && echo '写入' || echo '只看不写（dry-run）')"
echo "CNAME   ：www → $CNAME_VALUE"
if [ "${#APEX_IPS[@]}" -gt 0 ]; then
  echo "A 记录  ：@ → ${APEX_IPS[*]}"
else
  echo "A 记录  ：未提供（本次不动根域名）"
fi
hr

# ---------- 0. 确认这个域名在当前账号下 ----------
echo "[0/4] 确认域名归属…"
DOMAINS=""
ok_call=0
for attempt in 1 2 3; do
  if DOMAINS="$(ali alidns DescribeDomains --PageSize 100 \
                   --cli-query 'Domains.Domain[].DomainName' 2>&1)"; then
    ok_call=1; break
  fi
  # 网络抖动很常见（EOF / timeout），重试比直接报错友好
  case "$DOMAINS" in
    *EOF*|*timeout*|*"connection reset"*|*i/o\ timeout*)
      [ "$attempt" -lt 3 ] && { echo "  …第 ${attempt} 次调用遇到网络抖动，重试"; sleep 2; continue; } ;;
  esac
  break
done

if [ "$ok_call" != 1 ]; then
  case "$DOMAINS" in
    *EOF*|*timeout*|*"connection reset"*)
      echo "  ✗ 连不上阿里云接口（网络问题，不是权限问题）：$DOMAINS" >&2
      echo "    稍后重跑一次即可。若持续失败，检查网络/代理。" >&2
      ;;
    *)
      echo "  ✗ 调用失败：$DOMAINS" >&2
      echo "    先授权：aliyun configure --profile $PROFILE --mode OAuth" >&2
      echo "    再补区域：aliyun configure set --profile $PROFILE --region cn-hangzhou" >&2
      ;;
  esac
  exit 1
fi

if ! printf '%s' "$DOMAINS" | python3 -c "
import sys, json
d = sys.argv[1]
try:
    names = json.loads(sys.stdin.read())
except Exception:
    sys.exit(3)
sys.exit(0 if d in names else 1)
" "$DOMAIN"; then
  rc=$?
  if [ "$rc" = 3 ]; then
    echo "  ✗ 返回内容不是预期的 JSON：$DOMAINS" >&2
  else
    echo "  ✗ 这个账号下没有域名 ${DOMAIN}。账号下的域名：" >&2
    printf '%s' "$DOMAINS" | sed 's/^/      /' >&2
  fi
  exit 1
fi
echo "  ✓ 域名在本账号下"

# ---------- 1. 读取现有记录 ----------
echo "[1/4] 读取 www / @ 上的现有记录…"
RECORDS="$(ali alidns DescribeDomainRecords --DomainName "$DOMAIN" --PageSize 200 \
             --cli-query "DomainRecords.Record[?RR=='www' || RR=='@']")"

EXIST="$(printf '%s' "$RECORDS" | python3 -c '
import sys, json
for r in json.load(sys.stdin):
    print("\t".join([r.get("RecordId",""), r.get("RR",""), r.get("Type",""),
                     r.get("Value",""), str(r.get("TTL",""))]))
')"

if [ -z "$EXIST" ]; then
  echo "  （www / @ 上没有任何记录）"
else
  printf '  %-21s %-6s %-9s %s\n' "RecordId" "RR" "Type" "Value"
  printf '%s\n' "$EXIST" | while IFS=$'\t' read -r id rr ty val ttl; do
    printf '  %-21s %-6s %-9s %s\n' "$id" "$rr" "$ty" "$val"
  done
fi

# ---------- 2. 判定增删 ----------
echo "[2/4] 判定增删…"
PLAN="$(printf '%s' "$EXIST" | python3 -c '
import sys

cname = sys.argv[1]
apex  = [a for a in sys.argv[2:] if a]

# 期望状态：rr -> (type, [values])
want = {"www": ("CNAME", [cname])}
if apex:
    want["@"] = ("A", apex)

rows = []
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line.strip():
        continue
    p = (line.split("\t") + ["", "", "", "", ""])[:5]
    rows.append({"id": p[0], "rr": p[1], "type": p[2].upper(), "val": p[3]})

# 只按 (rr, type) 分组，且只碰 A / CNAME。
# 这条是脚本最要紧的约束：@ 上常有邮箱 MX 记录，误删的症状是
# "网站好好的，但收不到邮件"，极难排查。所以 MX / TXT / NS 一律跳过。
by_key = {}
for r in rows:
    if r["type"] in ("A", "CNAME"):
        by_key.setdefault((r["rr"], r["type"]), []).append(r)

dels, adds = [], []

# 注意：必须遍历「期望 ∪ 现有」两个集合的并集。
# 只遍历现有记录的话，空白域名（一条记录都没有）会导致一条都不加 —— 静默失效。
# 另外两个集合的键必须同构：want 按 rr 索引，by_key 按 (rr, type) 索引，
# 所以要先把 want 转成 (rr, type) 再取并集，否则会混进字符串键。
want_keys = set((rr, ty) for rr, (ty, _) in want.items())
for (rr, ty) in want_keys | set(by_key.keys()):
    if rr not in want:
        continue                        # 这次不配这个 rr，就别动它的记录
    group = by_key.get((rr, ty), [])
    if want[rr][0] != ty:
        dels.extend(group)              # 类型不对（如 www 上残留的 A）→ 全部清掉
        continue
    desired = list(want[rr][1])
    kept = set()
    for v in desired:
        hit = [r for r in group if r["val"] == v and r["id"] not in kept]
        if hit:
            kept.add(hit[0]["id"])      # 已存在且值正确 → 保留，不重复添加
        else:
            adds.append((rr, ty, v))    # 缺 → 补
    for r in group:
        if r["id"] not in kept:
            dels.append(r)              # 多余 / 值不对 → 清掉

for r in dels:
    print("DEL\t%s\t%s\t%s\t%s" % (r["id"], r["rr"], r["type"], r["val"]))
for a in adds:
    print("ADD\t%s\t%s\t%s" % a)
' "$CNAME_VALUE" "${APEX_IPS[@]:-}")"

if [ -z "$PLAN" ]; then
  echo "  ✓ 已经是目标状态，不需要改动"
fi

printf '%s\n' "$PLAN" | while IFS=$'\t' read -r act a b c d; do
  case "$act" in
    DEL) printf '  删：%s  %s %s → %s\n' "$a" "$b" "$c" "$d" ;;
    ADD) printf '  加：%-6s %-6s → %s\n'  "$a" "$b" "$c" ;;
  esac
done

if [ "$APPLY" = 0 ]; then
  hr
  echo "以上是计划，尚未写入。确认无误后加 --apply 再跑一次。"
  exit 0
fi

# ---------- 3. 执行 ----------
echo "[3/4] 写入…"
PLAN_FILE="$(mktemp)"
printf '%s\n' "$PLAN" > "$PLAN_FILE"

add_ok=0; add_fail=0; del_ok=0; del_fail=0
LAST_ERR=""

while IFS=$'\t' read -r act a b c d; do
  case "$act" in
    DEL)
      if out="$(ali alidns DeleteDomainRecord --RecordId "$a" 2>&1)"; then
        del_ok=$((del_ok + 1)); printf '  ✓ 已删 %s %s %s\n' "$b" "$c" "$d"
      else
        del_fail=$((del_fail + 1)); LAST_ERR="$out"
        printf '  ✗ 删 %s %s %s 失败\n' "$b" "$c" "$d"
        printf '%s\n' "$out" | grep -E 'ErrorCode|Message' | sed 's/^ */     /'
      fi
      ;;
    ADD)
      if out="$(ali alidns AddDomainRecord --DomainName "$DOMAIN" --RR "$a" \
                  --Type "$b" --Value "$c" --TTL 600 2>&1)"; then
        add_ok=$((add_ok + 1)); printf '  ✓ 已加 %s %s → %s\n' "$a" "$b" "$c"
      else
        add_fail=$((add_fail + 1)); LAST_ERR="$out"
        printf '  ✗ 加 %s %s → %s 失败\n' "$a" "$b" "$c"
        # 把服务端真正的原因打出来，不吞掉 —— 否则用户只看到"失败"，无从下手
        printf '%s\n' "$out" | grep -E 'ErrorCode|Message' | sed 's/^ */     /'
      fi
      ;;
  esac
done < "$PLAN_FILE"
rm -f "$PLAN_FILE"

FAILED=$((add_fail + del_fail))

# ---------- 4. 复核：重新读服务端，不按自己的意图报成功 ----------
echo "[4/4] 复核（重新读服务端）…"
sleep 2
ali alidns DescribeDomainRecords --DomainName "$DOMAIN" --PageSize 200 \
  --cli-query "DomainRecords.Record[?RR=='www' || RR=='@'].{RR:RR,Type:Type,Value:Value,TTL:TTL}" \
  | python3 -c '
import sys, json
rs = json.load(sys.stdin)
if not rs:
    print("  ✗ 一条都没读到")
for r in rs:
    print("  %-6s %-9s %-42s TTL=%s" % (r["RR"], r["Type"], r["Value"], r["TTL"]))
'

hr

if [ "$FAILED" -gt 0 ]; then
  echo "❌ 有 ${FAILED} 项没写成功（成功：加 ${add_ok} / 删 ${del_ok}）。"
  echo
  # 把已知失败原因翻译成人话。其余情况原样透传。
  case "$LAST_ERR" in
    *Identity.Uncertified*)
      echo "原因：阿里云账号未完成「账号实名认证」。"
      echo
      echo "这是阿里云的合规要求（依据《反电信网络诈骗法》），2024-01-23 起生效："
      echo "未完成账号实名认证的账号，无法新增域名解析记录 —— 通过网页控制台操作同样会被拒，"
      echo "换 AccessKey、换授权方式都绕不过去。"
      echo
      echo "注意：『域名实名认证』和『账号实名认证』是两件事，域名认证过了也没用。"
      echo
      echo "下一步：登录阿里云控制台 → 账号中心 → 实名认证（个人认证走支付宝通常可秒过）"
      echo "        完成后再跑一次本脚本即可。"
      ;;
    *Forbidden*|*NoPermission*)
      echo "原因：当前身份没有操作该域名解析的权限（RAM 子账号需授权 AliyunDNSFullAccess）。"
      ;;
    *"DomainRecordDuplicate"*)
      echo "原因：同名同类型记录已存在。先跑一次不带 --apply 的 dry-run 看清现状。"
      ;;
    *)
      echo "服务端返回："
      printf '%s\n' "$LAST_ERR" | sed 's/^/  /'
      ;;
  esac
  exit 1
fi

echo "✅ 写入完成。等生效（TTL 600 秒，最多 10 分钟），然后验证："
echo "  dig +short www.$DOMAIN"
echo "  dig +short $DOMAIN"
echo "  curl -I https://www.$DOMAIN"
echo
echo "再回 Vercel 复核一次："
echo "  vercel domains verify $DOMAIN"
echo "  vercel domains verify www.$DOMAIN"
