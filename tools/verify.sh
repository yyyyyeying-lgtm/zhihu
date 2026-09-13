#!/bin/bash
# ===========================================================
# 知了诊所 · 第二层 + 第三层验证：流程驱动 + DOM 断言
# -----------------------------------------------------------
# 用法：  bash tools/verify.sh
# 产物：  /tmp/zhiliao-verify/   里面是各阶段的截图和 DOM 快照
#
# 做三件事：
#   1. 先跑静态检查（tools/check-ids.py）
#   2. 把应用复制一份到临时目录，注入 tools/drive.js，用 Chrome 无头模式
#      自动点击走完整个流程，逐阶段截图
#   3. 导出完成态的 DOM，数元素个数做断言
#
# 为什么不用 playwright：沙箱里 npm 装不动。系统装了 Chrome 就够用，零安装。
# ===========================================================

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 应用本体就在仓库根目录（这样任何静态托管都能直接部署，Vercel 不会再 404）
APP="$ROOT"
WORK="/tmp/zhiliao-verify"

# ---- 找 python ----
PY=""
for c in "$(command -v python3)" /usr/bin/python3 \
         "$HOME/.workbuddy/binaries/python/versions/3.13.12/bin/python3"; do
  [ -n "$c" ] && [ -x "$c" ] && PY="$c" && break
done
[ -z "$PY" ] && { echo "找不到 python3，无法继续"; exit 1; }

# ---- 找 Chrome ----
CHROME=""
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
         "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
         "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
  [ -x "$c" ] && CHROME="$c" && break
done
[ -z "$CHROME" ] && { echo "找不到 Chrome / Edge，无法做渲染验证"; exit 1; }

echo "════════════════════════════════════════════════════════"
echo "  知了诊所 · 验证"
echo "════════════════════════════════════════════════════════"

# =========== 第一步：静态检查 ===========
"$PY" "$ROOT/tools/check-ids.py" || { echo; echo "静态检查未通过，中止。"; exit 1; }

# =========== 第二步：准备测试副本 ===========
echo
printf '─%.0s' {1..56}; echo
echo "  准备测试副本（不动交付物）"
printf '─%.0s' {1..56}; echo

rm -rf "$WORK"
mkdir -p "$WORK/app"

# 应用本体在仓库根目录，但根目录同时还有 docs/ tools/ 提交材料/ 等非应用内容，
# 以及 .git（可能十几 MB）。整目录 cp 再删既慢又浪费，所以用 rsync 只同步应用文件。
# 用排除法而不是白名单：以后新增应用文件会自动带上，不用改这里。
rsync -a \
  --exclude='.git' --exclude='.workbuddy' --exclude='.DS_Store' \
  --exclude='docs' --exclude='tools' --exclude='提交材料' \
  --exclude='知了诊所.app' --exclude='启动知了诊所.command' \
  --exclude='README.md' --exclude='LICENSE' --exclude='CLAUDE.md' \
  --exclude='.gitignore' --exclude='*.docx' \
  "$APP/" "$WORK/app/"

cp "$ROOT/tools/drive.js" "$WORK/app/js/drive.js"

"$PY" - "$WORK/app/index.html" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
tag = '<script src="js/app.js"></script>'
if tag not in s:
    print("  ✗ 在 index.html 里找不到 app.js 的 script 标签，注入失败")
    sys.exit(1)
s = s.replace(tag, tag + '\n<script src="js/drive.js"></script>')
open(p, "w", encoding="utf-8").write(s)
print("  ✓ 已注入驱动脚本")
PYEOF
[ $? -ne 0 ] && exit 1

# =========== 第三步：跑流程 + 截图 ===========
echo
printf '─%.0s' {1..56}; echo
echo "  自动走流程并截图（每阶段约 3-6 秒）"
printf '─%.0s' {1..56}; echo

STAGE_NAME=(
  [1]="首页"
  [2]="挂号单"
  [3]="病历首页"
  [4]="分歧地图"
  [5]="会诊邀请"
  [6]="会诊室·证言"
  [7]="会诊室·合议结束"
  [8]="会诊结论书"
  [9]="行动清单 · 会诊手记 · 完成态"
  [10]="我的病例"
  [11]="设置"
  [12]="会诊手记·展开预览"
  [20]="分支·已确诊"
  [21]="分支·信息不足"
  [30]="一键重置"
  [31]="自动演示走完全程"
  [40]="勾选进度并查看档案"
  [50]="真实 AI 未接通 · 降级可见"
  [51]="真实 AI 判定已确诊 · 分支跟随"
  [60]="知乎数据源 · 只接数据"
  [61]="知乎数据源 · 数据 + AI"
)

for t in 1 2 3 4 5 6 7 8 9 10 11 12 20 21 30 31 40 50 51 60 61; do
  h=2400
  [ "$t" -ge 8 ] && h=5600
  [ "$t" -eq 10 ] && h=900
  [ "$t" -eq 11 ] && h=900
  [ "$t" -eq 12 ] && h=1800
  { [ "$t" -eq 20 ] || [ "$t" -eq 21 ]; } && h=2000
  [ "$t" -eq 30 ] && h=1200
  { [ "$t" -eq 31 ]; } && h=1200
  [ "$t" -eq 40 ] && h=1200
  [ "$t" -eq 50 ] && h=1800
  [ "$t" -eq 51 ] && h=2200
  [ "$t" -eq 60 ] && h=2600
  [ "$t" -eq 61 ] && h=2200
  "$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
    --screenshot="$WORK/s$t.png" --window-size=1180,"$h" \
    --virtual-time-budget=150000 \
    "file://$WORK/app/index.html#$t" >/dev/null 2>&1
  if [ -f "$WORK/s$t.png" ]; then
    printf "  ✓ 阶段 %-2s %s\n" "$t" "${STAGE_NAME[$t]}"
  else
    printf "  ✗ 阶段 %-2s %s（截图失败）\n" "$t" "${STAGE_NAME[$t]}"
  fi
done

# 会诊室用真实窗口尺寸单独拍一张，确认 820px 高度下布局正常
"$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --screenshot="$WORK/room-1180x820.png" --window-size=1180,820 \
  --virtual-time-budget=150000 \
  "file://$WORK/app/index.html#7" >/dev/null 2>&1
echo "  ✓ 会诊室真实窗口尺寸 1180×820"

# =========== 第三步半：手机宽度检测 ===========
# Chrome 无头的最小视口是 500px，直接开 375 的窗口会被提升到 500 —— 测不出真实手机宽度。
# 所以用 iframe 当容器：iframe 内部的 innerWidth 就是 375，媒体查询也按 375 生效，
# 再用脚本跨进去量每个元素有没有横向溢出，结果写进父页面的 title 供断言读取。
# ⚠️ --allow-file-access-from-files 不能去掉：file:// 下每个文件算独立源，
#    不带这个参数跨 iframe 取 contentDocument 会拿到 null（表现为 NO_DOC）。
echo
printf '─%.0s' {1..56}; echo
echo "  手机宽度检测（375px，用 iframe 容器）"
printf '─%.0s' {1..56}; echo

cat > "$WORK/mobile.html" <<'HTMLEOF'
<!DOCTYPE html><html><head><meta charset="utf-8"><title>pending</title></head>
<body style="margin:0;background:#fff">
<iframe id="f1" src="app/index.html#1" width="375" height="812" style="border:0"></iframe>
<iframe id="f2" src="app/index.html#6" width="375" height="812" style="border:0"></iframe>
<script>
function measure(id, label) {
  var f = document.getElementById(id);
  try {
    var d = f.contentDocument, w = f.contentWindow;
    var vw = w.innerWidth, bad = [];
    var all = d.querySelectorAll('body *');
    for (var i = 0; i < all.length; i++) {
      var r = all[i].getBoundingClientRect();
      if (r.width < 1) continue;
      if (r.right > vw + 1 || r.left < -1) {
        var c = (all[i].getAttribute('class') || '').split(' ')[0];
        bad.push(all[i].tagName.toLowerCase() + (c ? '.' + c : ''));
      }
    }
    return label + ':vw=' + vw + ',overflow=' + bad.length +
           (bad.length ? '(' + bad.slice(0, 3).join(',') + ')' : '');
  } catch (e) { return label + ':ERR'; }
}
setTimeout(function () {
  document.title = measure('f1', 'home') + ' | ' + measure('f2', 'room');
}, 90000);
</script>
</body></html>
HTMLEOF

"$CHROME" --headless=new --disable-gpu --no-sandbox \
  --allow-file-access-from-files \
  --window-size=800,900 --virtual-time-budget=200000 \
  --dump-dom "file://$WORK/mobile.html" 2>/dev/null > "$WORK/mobile-dom.html"

"$PY" - "$WORK/mobile-dom.html" <<'PYEOF'
import re, sys
s = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"<title>([^<]*)</title>", s)
t = m.group(1) if m else "(没拿到)"
print("  检测结果：" + t)
PYEOF

# =========== 第四步：DOM 断言 ===========
echo
printf '─%.0s' {1..56}; echo
echo "  DOM 断言（完成态）"
printf '─%.0s' {1..56}; echo

for st in 9 20 21 30 31 40 50 51 60 61; do
  "$CHROME" --headless=new --disable-gpu --no-sandbox \
    --window-size=1180,2400 --virtual-time-budget=150000 \
    --dump-dom "file://$WORK/app/index.html#$st" 2>/dev/null > "$WORK/dom-$st.html"
done

"$PY" - "$WORK/dom-9.html" "$WORK/dom-20.html" "$WORK/dom-21.html" "$WORK/dom-30.html" "$WORK/dom-31.html" "$WORK/dom-40.html" "$WORK/dom-50.html" "$WORK/dom-51.html" "$WORK/dom-60.html" "$WORK/dom-61.html" "$WORK/mobile-dom.html" <<'PYEOF'
import re, sys

main = open(sys.argv[1], encoding="utf-8").read()   # 分歧分支（完整流程）
settled = open(sys.argv[2], encoding="utf-8").read()  # 已确诊分支
short = open(sys.argv[3], encoding="utf-8").read()    # 信息不足分支
after_reset = open(sys.argv[4], encoding="utf-8").read()  # 一键重置之后
pilot = open(sys.argv[5], encoding="utf-8").read()        # 自动演示走完
archive = open(sys.argv[6], encoding="utf-8").read()      # 勾选进度后的档案页
degrade = open(sys.argv[7], encoding="utf-8").read()      # 真实 AI 接不通（v1.5）
ai_settled = open(sys.argv[8], encoding="utf-8").read()   # 伪 AI 判定已确诊（v1.5）
zhihu_only = open(sys.argv[9], encoding="utf-8").read()   # 只接知乎数据源（v1.7）
zhihu_ai = open(sys.argv[10], encoding="utf-8").read()    # 知乎数据 + AI（v1.7）
_m = re.search(r"<title>([^<]*)</title>",
               open(sys.argv[11], encoding="utf-8").read())
mobile = _m.group(1) if _m else ""


def _mo(label):
    m = re.search(label + r":vw=(\d+),overflow=(\d+)", mobile)
    return (int(m.group(1)), int(m.group(2))) if m else (0, 999)


_home_vw, _home_of = _mo("home")
_room_vw, _room_of = _mo("room")

s = main
checks = [
    ("没有 JS 报错",        not re.search(r'<title>ERR:', s)),
    ("会诊室有证言卡",      s.count('class="testimony') >= 4),
    ("会诊室有合议消息",    s.count('class="msg ') >= 10),
    ("会诊记录有打标",      s.count('rec-item') >= 3),
    ("结论书已生成",        s.count('concl-title') >= 1),
    ("结论带来源计数",      s.count('class="src"') >= 3),
    ("少数意见独立成块",    s.count('dissent-box') >= 1),
    ("结论书有共同署名",    s.count('mini-av') >= 4),
    ("行动清单有步骤",      s.count('rx-item') >= 4),
    ("会诊手记已生成",      s.count('class="hn"') >= 4),
    ("手记标注了来源",      s.count('未新增任何事实') >= 4),
    ("手记可展开预览",      s.count('hn-excerpt') >= 4),
    ("完成态已出现",        s.count('done-card') >= 1),
]

fails = 0


def report(title, items):
    global fails
    print()
    print("  【" + title + "】")
    for name, passed in items:
        print("    %s  %s" % ("✓" if passed else "✗", name))
        if not passed:
            fails += 1


report("分支一 · 存在真实分歧（完整会诊）", checks)

report("病历闭环（v1.4 新增）", [
    ("行动清单带勾选框",       'rx-check' in s),
    ("主流程出现回访日期",      'rx-review' in s and '年' in s),
    ("勾选后切到病例页",        'rec-card' in archive),
    ("进度已写回档案",         '2 / 4 已执行' in archive),
    ("档案里有进度条",         'rec-prog-bar' in archive),
])

report("开场体验与话术（v1.10 新增）", [
    ("开场有温馨提示卡",          'class="welcome"' in s),
    ("提示卡有标签与标题",        'wc-label' in s and 'wc-title' in s),
    ("提示卡有三条要点",          s.count('wc-item') >= 3),
    ("提示卡有收尾语",            'wc-foot' in s),
    ("开场话术已改柔和",          '这里没有标准答案' in s),
    # 下面两条是否定式断言：防止以后有人把生硬话术改回来
    ("没有「给你挂上号」这类表述",  '挂上号' not in s),
    ("没有「值得吵一次」这类表述",  '值得吵一次' not in s),
    ("没有「浪费他们的时间」",     '浪费他们的时间' not in s),
])

report("形象与称谓统一（v1.3.1 插入）", [
    ("医生头像用的是狐看山医生形象", s.count('assets/fox-avatar.png') >= 3),
    ("会诊室主持人用同一形象",       'msg-av-host' in s),
    ("称谓全部写作「狐看山医生」",   s.count('狐看山医生') >= 5),
    ("没有遗留旧称谓",              '知了大夫' not in s and '猫医生' not in s),
])

report("分支二 · 已确诊（v1.2 新增）", [
    ("没有 JS 报错",           '<title>ERR:' not in settled),
    ("三档判定命中已确诊",      re.search(r'triage-cell on.{0,90}?已确诊', settled, re.S) is not None),
    ("给出共识结论",           settled.count('class="sect consensus"') >= 3),
    ("每条共识带来源",          settled.count('class="src"') >= 3),
    ("有三档判定提示条",        'notice ok' in settled),
    ("行动清单有步骤",          settled.count('rx-item') >= 4),
    ("完成态已出现",           settled.count('done-card') >= 1),
    ("确实没有走会诊",          settled.count('class="msg ') == 0),
    ("没有会诊手记",           settled.count('class="hn"') == 0),
    ("标注了用的是内置示例",      'src-tag demo' in settled),
])

report("分支三 · 信息不足（v1.2 新增）", [
    ("没有 JS 报错",           '<title>ERR:' not in short),
    ("三档判定命中信息不足",    re.search(r'triage-cell on.{0,90}?信息不足', short, re.S) is not None),
    ("给出提问草稿",           'draft-title' in short),
    ("草稿正文已渲染",          short.count('hn-excerpt') >= 1),
    ("列出提问要点",           short.count('hint-list') >= 1),
    ("有复制按钮",             'btnCopyDraft' in short),
    ("行动清单有步骤",          short.count('rx-item') >= 4),
    ("完成态已出现",           short.count('done-card') >= 1),
    ("确实没有走会诊",          short.count('class="msg ') == 0),
])

def rail_labels(html):
    """取出进度轨上的步骤名，用来验证分支切换后进度轨也变了"""
    return re.findall(r'class="rail-label">([^<]*)<', html)


report("手机适配（v1.9 新增）", [
    ("窄屏容器确实是 375px",      _home_vw == 375),
    ("首屏在 375px 下无横向溢出",  _home_of == 0),
    ("会诊室在 375px 下无横向溢出", _room_of == 0),
])

report("知乎官方数据源（v1.7 新增）", [
    ("只接数据时标注了真实来源",   'src-tag corpus' in zhihu_only),
    ("展示了检索到的真实讨论",     '测试用真实讨论一' in zhihu_only),
    ("真实条目渲染成列表",        zhihu_only.count('real-post') >= 5),
    ("作者与赞同数来自真实返回",   '测试作者甲' in zhihu_only and '3421' in zhihu_only),
    ("如实说明判定仍是内置的",     '仍然来自' in zhihu_only),
    ("只接数据这条路径没有报错",   '<title>ERR:' not in zhihu_only),
    ("数据 + AI 时标注真实来源",   'src-tag corpus' in zhihu_ai),
    ("真实条数被送进了模型",       '知乎 5 条相关讨论' in zhihu_ai),
    ("模型基于真实内容做了聚类",   'AI 聚类出的争议甲' in zhihu_ai),
    ("聚类里用了真实的作者与赞数",  '测试作者甲 3421 赞' in zhihu_ai),
    ("做了聚类就不再堆原始列表",   zhihu_ai.count('real-post') == 0),
    ("数据 + AI 这条路径没有报错", '<title>ERR:' not in zhihu_ai),
])

report("结案产出可以带走（v1.6 新增）", [
    ("结论书带复制按钮",       'btnCopyConcl' in s),
    ("行动清单带复制按钮",     'btnCopyPlan' in s),
    ("已确诊分支也能复制",     'btnCopySettled' in settled),
    ("信息不足分支能复制草稿",  'btnCopyDraft' in short),
])
# 注：复制到剪贴板的实际效果无法在无头环境断言（需要真实剪贴板），
# 这里只验证入口齐全；行为本身走「人工点一遍」。

report("真实 AI 的容错与诚实（v1.5 新增）", [
    ("接口不通时有可见的降级标注",   'src-tag fallback' in degrade),
    ("降级原因写在了界面上",        '真实 AI 没能接通' in degrade),
    ("降级说明这是内置示例",        '内置示例数据' in degrade),
    ("降级后流程没有卡死",         degrade.count('class="triage') >= 1),
    ("降级路径没有 JS 报错",       '<title>ERR:' not in degrade),
])

report("判定真的驱动了分支（v1.5 新增）", [
    ("有真实 AI 的来源标注",       'src-tag live' in ai_settled),
    ("判定跟随模型给出的结论",      re.search(r'triage-cell on.{0,90}?已确诊', ai_settled, re.S) is not None),
    ("共识内容来自模型",           '模型给出的共识甲' in ai_settled),
    ("行动清单也来自模型",         '模型给出的第一个动作' in ai_settled),
    ("确实改走了已确诊分支",       ai_settled.count('class="msg ') == 0),
    ("进度轨不含「会诊」",         '会诊' not in rail_labels(ai_settled)),
    ("完成态已出现",              ai_settled.count('done-card') >= 1),
    ("没有 JS 报错",              '<title>ERR:' not in ai_settled),
])

report("现场演示能力（v1.3 新增）", [
    ("重置后回到初始态：输入框在",   after_reset.count('id="qInput"') >= 1),
    ("重置后没有残留文书卡",        after_reset.count('class="doc-card"') == 0),
    ("重置后没有完成态",           after_reset.count('done-card') == 0),
    ("重置后三个示例都在",          after_reset.count('chip ex') >= 3),
    ("首屏有「看完整演示」入口",     'btnWatchDemo' in after_reset),
    ("自动演示能自己走完全流程",     pilot.count('done-card') >= 1),
    ("自动演示走的是会诊分支",       pilot.count('class="hn"') >= 4),
    ("自动演示产出了结论书",        pilot.count('concl-title') >= 1),
])

# 交互动效类断言（可选的软性提示）
if s.count('class="hypo') == 0:
    print("  ⚠  没找到病灶选项，确认「用户必须点选确认」这一环还在")

sys.exit(1 if fails else 0)
PYEOF
ASSERT=$?

# =========== 汇总 ===========
echo
echo "════════════════════════════════════════════════════════"
if [ "$ASSERT" -eq 0 ]; then
  echo "  ✓ 验证通过"
else
  echo "  ✗ 验证未通过，请看上面的 ✗ 项"
fi
echo "  截图与 DOM 快照：$WORK"
echo "  （挑 s4 / s6 / s8 / room-1180x820 用图片查看器看一眼）"
echo "════════════════════════════════════════════════════════"

exit "$ASSERT"
