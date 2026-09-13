#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
知了诊所 · 第一层验证：静态检查
=================================
做两件事，都是零成本的：
  1. 用 node --check 检查三个 JS 文件的语法
  2. 交叉核对「app.js 里查询的元素 id」与「HTML 里真实存在的 id」

第 2 项是本项目踩过的坑：HTML 写 btn-skip、JS 查 #btnSkip，
整条流程会静默中断而页面看起来还在跑。所以每次改完都要跑一遍。

用法：  python3 tools/check-ids.py
退出码：0 = 全部通过；1 = 有问题（会打印具体是哪个 id）
"""

import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 应用本体在仓库根目录
APP = ROOT

HTML_FILES = [os.path.join(APP, "index.html")]
JS_FILES = [
    os.path.join(APP, "js", "data.js"),
    os.path.join(APP, "js", "ai.js"),
    os.path.join(APP, "js", "app.js"),
]

ok = True


def find_node():
    """找一个可用的 node，找不到就跳过语法检查（不阻塞流程）"""
    for cand in (
        shutil.which("node"),
        os.path.expanduser(
            "~/.workbuddy/binaries/node/versions/22.22.2/bin/node"
        ),
    ):
        if cand and os.path.exists(cand):
            return cand
    return None


def section(title):
    print()
    print("─" * 56)
    print("  " + title)
    print("─" * 56)


# ---------------------------------------------------------------- 1. 语法
section("1 / 2   JavaScript 语法检查")

node = find_node()
if not node:
    print("  ⚠  找不到 node，跳过语法检查")
else:
    for f in JS_FILES:
        name = os.path.relpath(f, ROOT)
        r = subprocess.run(
            [node, "--check", f], capture_output=True, text=True
        )
        if r.returncode == 0:
            print("  ✓  " + name)
        else:
            ok = False
            print("  ✗  " + name)
            print("     " + (r.stderr or "").strip().splitlines()[0])

# ---------------------------------------------------------- 2. id 交叉核对
section("2 / 2   元素 id 交叉核对")

html = "\n".join(open(f, encoding="utf-8").read() for f in HTML_FILES)
js = "\n".join(open(f, encoding="utf-8").read() for f in JS_FILES)

html_ids = re.findall(r'id="([^"]+)"', html)
js_ids = set(re.findall(r'id="([^"]+)"', js))          # 运行时动态生成的 id
queried = set(re.findall(r'\$\("#([A-Za-z0-9_-]+)"\)', js))

# HTML 里 id 是否重复
dupes = sorted({i for i in html_ids if html_ids.count(i) > 1})
if dupes:
    ok = False
    print("  ✗  重复的 id：" + "、".join(dupes))
else:
    print("  ✓  无重复 id（共 %d 个）" % len(set(html_ids)))

# JS 查询的 id 是否都存在
missing = sorted(i for i in queried if i not in set(html_ids) and i not in js_ids)
if missing:
    ok = False
    print("  ✗  JS 引用了不存在的 id：")
    for m in missing:
        print("       #" + m)
    print("     → 这就是「点了没反应」的头号原因，去修 id 或修查询")
else:
    print("  ✓  JS 引用的 %d 个 id 全部存在" % len(queried))

# 命名风格提醒
hyphen_ids = sorted(i for i in html_ids if "-" in i and not i.startswith(("view-", "modal")))
if hyphen_ids:
    print("  ⚠  这些 id 含连字符，按规范应改为小驼峰：" + "、".join(hyphen_ids))

# ---------------------------------------------------------------- 汇总
print()
print("═" * 56)
print("  结果：" + ("✓ 静态检查全部通过" if ok else "✗ 发现问题，先修再继续"))
print("═" * 56)
sys.exit(0 if ok else 1)
