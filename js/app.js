/* ===========================================================
   知了诊所 · 主逻辑
   =========================================================== */

const D = ZHILIAO_DATA;
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));

const DEFAULT_RAIL = ['挂号', '问诊', '分歧地图', '会诊', '结论书', '行动清单'];
const RAIL_NO_ROOM = ['挂号', '问诊', '分歧地图', '结论', '行动清单'];
const REC_KEY = 'zhiliao_records';

let S = null;
let speed = 0.7;   // 会诊室播放倍率，越小越快
let skipping = false;

function freshState() {
  return {
    step: 0,
    case: null,
    rail: null,
    verdict: null,
    question: '',
    answers: [],
    chart: null,
    wound: null,
    map: null,
    experts: [],
    testimonies: [],
    panel: [],
    conclusion: null,
    plan: [],
    planNote: '',
    handnotes: [],
    planDone: [],        /* 行动清单的执行进度，与 plan 等长 */
    recordId: null,      /* 归档后回填，用于把勾选写回档案 */
    reviewAt: '',
    usedAI: false,
    degrades: [],       /* 真实 AI 降级的记录，用来在界面上明说 */
    zhihuPosts: [],     /* 知乎开放平台检索到的真实讨论（v1.7） */
    zhihuTried: false   /* 是否尝试过检索，用于区分「没接」和「接了但没结果」 */
  };
}

/* ---------------- 工具 ---------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/* ---------------- 代次与中止 ----------------
   一键重置时必须能掐断「还在路上」的流程，否则旧流程会继续往新页面里塞卡片，
   界面上就会出现不该有的内容。做法：start() 递增 GEN；sleep() 每次醒来都
   检查自己出发时的代次是否还有效，失效就抛 ABORT。 */
const ABORT = { abort: true };
let GEN = 0;
let paused = false;

async function sleep(ms) {
  const g = GEN;
  let virtual = 0;
  while (virtual < ms) {
    if (g !== GEN) throw ABORT;
    await new Promise(r => setTimeout(r, 60));
    if (!paused) virtual += 60 / (skipping ? 0.05 : speed);
  }
  if (g !== GEN) throw ABORT;
}

/* 所有流程阶段都用 run() 启动：ABORT 静默吞掉，其它错误打日志。
   这样重置不会在控制台刷出一堆未处理的 Promise 拒绝。 */
function run(p) {
  if (p && typeof p.catch === 'function') {
    p.catch(e => { if (e !== ABORT) console.warn('[知了诊所]', e); });
  }
}
function node(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function attach(el, animate) {
  $("#stream").appendChild(el);
  if (animate !== false) el.classList.add('rise');
  scrollBottom();
}
function scrollBottom() {
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
}
function scrollFeed() {
  const f = $("#roomFeed");
  if (f) f.scrollTop = f.scrollHeight;
}

/* ---------------- 案例选择 ---------------- */
/* 按困惑里的关键词挑案例；命中不足时用 defaultCase 兜底。
   打分用「命中关键词的总字符数」而不是命中个数 —— 长词更具体，区分度更高。
   例：'海洋' + '制药'（4 字）应当胜过 '本科'（2 字）。 */
function pickCase(q) {
  const low = String(q || '').toLowerCase();
  let best = null, bestScore = 0;
  Object.keys(D.cases).forEach(id => {
    const c = D.cases[id];
    const score = (c.match || []).reduce((sum, k) => {
      const key = k.toLowerCase();
      return low.indexOf(key) >= 0 ? sum + key.length : sum;
    }, 0);
    if (score > bestScore) { bestScore = score; best = c; }
  });
  return best || D.cases[D.defaultCase];
}
function railFor(verdict) {
  return verdict === 'dispute' ? DEFAULT_RAIL : RAIL_NO_ROOM;
}

/* ---------------- 真实 AI 的可见性（v1.5） ----------------
   真实 AI 一定会遇到：Key 过期、网络不通、服务商限流、返回格式不对。
   这些情况绝不能「悄悄换成内置数据继续演」——那等于骗用户，
   路演时被评委发现一次，整个产品的可信度就没了。
   所以每一处降级都记录下来，并贴在对应的卡片上明说。 */
function noteDegrade(step, err) {
  const msg = (err && err.message) ? err.message : String(err || '未知错误');
  S.degrades.push({ step: step, msg: msg });
  console.warn('[知了诊所] ' + step + ' 降级：', err);
}

function degradeNotice() {
  if (!S.degrades || !S.degrades.length) return '';
  const last = S.degrades[S.degrades.length - 1];
  /* 措辞要在任意一张卡上都读得通：先讲"真实 AI 没通"，再说"所以这张卡是内置的"。
     同一段提示可能贴在多张卡上（后续步骤不会再重复记录降级）。 */
  return '<div class="notice warn" style="margin-bottom:14px">' +
    '<span class="ic">!</span><span><b>真实 AI 没能接通</b>（卡在「' + esc(last.step) +
    '」这一步：' + esc(last.msg) + '）。所以这张卡用的是<b>内置示例数据</b>，' +
    '不是针对你这个问题的推理结果。检查接口地址与 Key 之后重新挂一次号，就能走真实推理。</span></div>';
}

/* 每张推理卡都标出数据来源 —— 哪些是真跑的、哪些是内置的，一眼可辨 */
function sourceTag() {
  const failed = (S.degrades || []).length > 0;
  if (S.usedAI && !failed) {
    const cfg = (window.ZHILIAO_AI && ZHILIAO_AI.get()) || {};
    return '<div class="src-bar"><span class="src-tag live">真实 AI 推理</span>' +
      '<span class="src-note">由 ' + esc(cfg.model || '大模型') + ' 现场生成</span></div>';
  }
  if (failed) {
    return '<div class="src-bar"><span class="src-tag fallback">内置示例数据</span>' +
      '<span class="src-note">真实 AI 未接通，已降级</span></div>';
  }
  return '<div class="src-bar"><span class="src-tag demo">内置示例数据</span>' +
    '<span class="src-note">演示模式不联网；接入真实 AI 后这里会标出模型名</span></div>';
}

/* 数据来源标注。注意它与 sourceTag() 是**两件事**：
   sourceTag 说的是「判定和内容是推理出来的还是内置的」，
   corpusTag 说的是「这些讨论是从哪来的」。两者都要标，才能一句话说清整张卡的可信度。 */
function corpusTag() {
  if (S.zhihuPosts && S.zhihuPosts.length) {
    return '<div class="src-bar"><span class="src-tag corpus">知乎站内真实数据</span>' +
      '<span class="src-note">检索到 ' + S.zhihuPosts.length + ' 条真实讨论</span></div>';
  }
  if (S.zhihuTried) {
    return '<div class="src-bar"><span class="src-tag demo">内置示例语料</span>' +
      '<span class="src-note">知乎站内未检索到相关讨论，已回退</span></div>';
  }
  return '';
}

/* 把用户的问题压成检索词。搜索接口的 Query 越聚焦，返回越准。 */
function searchQuery() {
  const q = String(S.question || '')
    .replace(/[？?！!。，,、；;：:"'（）()《》【】\s]/g, ' ')
    .replace(/(还有机会吗|有希望吗|怎么办|怎么样|如何|怎么|能不能|可以吗|吗|呢|吧|啊|呀|请问|想问|请教|求教)/g, ' ')
    .trim()
    .split(/\s+/).filter(Boolean).join(' ');
  return q.slice(0, 24) || String(S.question || '').slice(0, 20) || '职业发展';
}

/* 只接了知乎、还没接 AI 模型时：如实展示检索到的原始讨论，不假装做过聚类 */
function realPostsHTML(real) {
  const rows = (real.items || []).slice(0, 10).map((it, i) =>
    '<div class="real-post">' +
      '<span class="rp-idx">' + (i + 1) + '</span>' +
      '<div class="rp-body">' +
        '<div class="rp-title">' + esc(it.title || '(无标题)') + '</div>' +
        '<div class="rp-meta">' + esc(it.author || '匿名') +
          (it.authority ? '　权威等级 ' + esc(String(it.authority)) : '') +
          '　赞同 ' + Number(it.vote || 0) +
          (it.comment ? '　评论 ' + Number(it.comment) : '') +
        '</div>' +
      '</div>' +
    '</div>').join('');
  return '<div class="doc-sub" style="margin:20px 0 8px">' +
      '这是从知乎站内检索到的真实讨论（原始结果）</div>' +
    '<div class="real-list">' + rows + '</div>' +
    '<div class="notice info" style="margin-top:14px"><span class="ic">▸</span><span>' +
      '上面那张三档判定仍然来自<b>内置示例</b>。要把这些真实讨论聚成观点簇、给出真实判定，' +
      '还需要在设置里配置一个 AI 模型（任选一家，或用知乎直答）。</span></div>';
}

/* ---------------- 非会诊分支的内容来源 ----------------
   优先用本次真实检测的结果，没有才用内置案例。
   不做这一步的话，真实 AI 判定了「已确诊」，给出的却是内置案例里
   另一道题的共识结论 —— 判定是真的、内容是假的，比全假更糟。 */
function settledContent() {
  const m = S.map || {};
  if (S.usedAI && (m.consensus || []).length) {
    return {
      title: (m.topic || S.question) + '：社区已有定论',
      byline: '知了诊所 · 检索了 ' + Number(m.corpus || 0).toLocaleString() + ' 条相关讨论',
      points: m.consensus.map(c => ({
        text: c.name,
        src: c.meta || ('支持度 ' + (c.support || '高'))
      })),
      note: m.conclusion || '这个话题在知乎早已收敛，不需要再吵一遍。',
      plan: (m.plan || []).map(p => ({ when: p.when, what: p.what })),
      planNote: m.planNote || ''
    };
  }
  return S.case.settled || {};
}

function draftContent() {
  const d = (S.map || {}).draft;
  if (S.usedAI && d && (d.title || d.body)) {
    return {
      title: d.title || '',
      lead: d.lead || '这是根据你的情况重新组织的提问草稿。',
      body: d.body || '',
      whyTitle: '为什么这样问，更容易得到回答',
      hints: d.why || [],
      button: d.button || '复制草稿去知乎提问'
    };
  }
  return S.case.draft || {};
}

/* ---------------- 进度轨 ---------------- */
function renderRail() {
  const box = $("#railInner");
  const rail = S && S.rail ? S.rail : DEFAULT_RAIL;
  box.innerHTML = rail.map((label, i) => {
    const cls = i < S.step ? 'done' : (i === S.step ? 'current' : '');
    const line = i < rail.length - 1 ? '<span class="rail-line"></span>' : '';
    return '<div class="rail-step ' + cls + '">' + line +
      '<span class="rail-dot"></span><span class="rail-label">' + label + '</span></div>';
  }).join('');
}
function setRail(i) { S.step = i; renderRail(); }

/* ---------------- 对话元素 ---------------- */
function docBubble(html) {
  return node(
    '<div class="doc-row">' +
      '<div class="doc-avatar"><img class="avatar-img" src="assets/fox-avatar.png" alt="狐看山医生"></div>' +
      '<div><div class="doc-name">狐看山医生</div>' +
      '<div class="bubble">' + html + '</div></div>' +
    '</div>');
}
function userBubble(text) {
  return node('<div class="user-row"><div class="user-bubble">' + esc(text) + '</div></div>');
}
function typingBubble() {
  return node(
    '<div class="doc-row" id="typingRow">' +
      '<div class="doc-avatar"><img class="avatar-img" src="assets/fox-avatar.png" alt="狐看山医生"></div>' +
      '<div><div class="doc-name">狐看山医生</div>' +
      '<div class="bubble"><div class="typing"><i></i><i></i><i></i></div></div></div>' +
    '</div>');
}

async function say(html, wait) {
  const n = docBubble(html);
  attach(n);
  if (wait) await sleep(wait);
  return n;
}
/* ---------------- 开场温馨提示卡 ----------------
   刻意与 notice 类提示条区分开：notice 是「警告 / 说明」，语气偏冷；
   这张卡是用户看到的第一样东西，要柔和、要有呼吸感。
   v1.11：从「编号清单」改成「三步旅程」。
   清单让人以为自己在走流程，旅程让人知道这只是路上要经过的三站。
   文案在 data.js 的 welcome 字段，样式见 css 的 .welcome / .wc-journey 区块。 */
function welcomeCard() {
  const w = D.welcome || {};
  const steps = (w.steps || []).map((st, i) =>
    '<div class="wc-item">' +
      '<div class="wc-ic">' + esc(st.ic || '') + '</div>' +
      '<div class="wc-word">' + esc(st.word || '') + '</div>' +
      '<div class="wc-desc">' + esc(st.desc || '') + '</div>' +
    '</div>').join('<div class="wc-link" aria-hidden="true">→</div>');
  return node(
    '<div class="welcome">' +
      '<div class="wc-label">' + esc(w.label || '温馨提示') + '</div>' +
      '<div class="wc-title">' + esc(w.title || '') + '</div>' +
      '<div class="wc-journey">' + steps + '</div>' +
      '<div class="wc-foot">' + esc(w.foot || '') + '</div>' +
    '</div>');
}

async function think(ms) {
  const t = typingBubble();
  attach(t, false);
  await sleep(ms);
  t.remove();
}

function docCard(tag, title, sub, inner, extraClass) {
  return node(
    '<div class="doc-card ' + (extraClass || '') + '">' +
      '<div class="doc-head"><span class="tag">' + tag + '</span>' +
      '<span class="doc-title">' + esc(title) + '</span>' +
      (sub ? '<span class="doc-sub">' + esc(sub) + '</span>' : '') +
      '</div>' +
      '<div class="doc-body">' + inner + '</div>' +
    '</div>');
}

/* ===========================================================
   开场
   =========================================================== */
function start() {
  GEN++;                       /* 让上一次的所有在途流程立刻作废 */
  paused = false;
  skipping = false;
  S = freshState();
  avMap = {};
  $("#stream").innerHTML = '';
  setRail(0);
  run((async () => {
    await say('<p>' + esc(D.greeting[0]) + '</p>', 420);
    await say('<p>' + esc(D.greeting[1]) + '</p>', 420);
    await say('<p>' + esc(D.greeting[2]) + '</p>', 300);
    /* 开场先给一张温馨提示卡，把流程交代清楚。作用有两个：
       一是安顿情绪（用户此刻往往是焦虑的），
       二是提前说明会花多久、会得到什么，避免中途失去耐心。 */
    attach(welcomeCard(), false);
    await sleep(260);
    renderComposer();
  })());
}

/* 回访日期：默认 3 个月后。写死文案换成真实日期，才算得上"管随访" */
function reviewDate(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + (months || 3));
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
}

/* ---------------- 一键重置 ----------------
   从任意状态回到初始态。它会：关掉浮层与弹窗 → 停止自动演示 → 结束所有在途流程
   → 重建初始界面。「我的病例」是数据不是状态，不受影响。 */
function resetDemo() {
  stopPilot();
  paused = false;
  skipping = false;
  $("#roomOverlay").classList.add("hidden");
  $$(".modal").forEach(m => m.classList.add("hidden"));
  start();
  window.scrollTo({ top: 0, behavior: "auto" });
}

/* ---------------- 自动演示 ----------------
   它不重写流程，只是替用户点按钮 —— 所以永远不会和真实流程脱节。
   讲解到一半可以按空格暂停，讲完再继续。 */
let pilotTimer = null;
let pilotOn = false;

function visible(el) { return el && el.offsetParent !== null; }

function pilotTick() {
  if (paused) return;

  /* 已经走到完成态 → 自动收工，不点「再挂一个号」，避免无限循环 */
  if (document.querySelector('.done-card')) { stopPilot(); return; }

  /* 必须同时检查「可见」：跳过等待按钮隐藏时是用 CSS class 做的，
     不是 disabled 属性 —— 只判断 disabled 会让自动演示一直去点一个
     已经看不见的按钮，永远走不到下一步。 */
  const click = sel => {
    const el = document.querySelector(sel);
    if (el && !el.disabled && visible(el)) { el.click(); return true; }
    return false;
  };

  /* 会诊室优先：先跳过等待，再等播放完点下一步 */
  const room = document.querySelector('#roomOverlay');
  if (room && !room.classList.contains('hidden')) {
    if (click('#btnSkip')) return;
    const b = document.querySelector('#btnRoomNext');
    if (b && !b.disabled) { b.click(); return; }
    return;
  }

  /* 弹窗一律关掉，避免挡住流程 */
  $$('.modal').forEach(m => m.classList.add('hidden'));

  /* 首页还没填困惑 → 先点第一个示例 */
  const ta = document.querySelector('#qInput');
  if (ta && ta.value.trim().length < 4) {
    if (click('#stream .chip.ex')) return;
    return;
  }
  if (ta && ta.value.trim().length >= 4 && click('#btnReg')) return;

  /* 问诊快捷回答（只点可见的，已答过的那一行已被隐藏） */
  const chips = Array.prototype.filter.call(
    document.querySelectorAll('#stream .bubble .chip.ans'), visible);
  if (chips.length) { chips[0].click(); return; }

  /* 病灶确认 */
  const hypo = document.querySelector('#stream .hypo');
  if (hypo && !hypo.classList.contains('on')) { hypo.click(); return; }
  if (click('#btnConfirm')) return;
  if (click('#btnStartRoom')) return;
  if (click('#btnPublish')) return;
}

function startPilot() {
  if (pilotOn) return;
  pilotOn = true;
  paused = false;
  updatePilotHint();
  pilotTimer = setInterval(pilotTick, 380);
}

function stopPilot() {
  pilotOn = false;
  clearInterval(pilotTimer);
  pilotTimer = null;
  updatePilotHint();
}

function togglePilot() { pilotOn ? stopPilot() : startPilot(); }

function updatePilotHint() {
  const bar = document.querySelector('#demoHint');
  if (!bar) return;
  const st = document.querySelector('#pilotState');
  if (st) st.textContent = pilotOn ? (paused ? '已暂停' : '演示中') : '待命';
  bar.classList.toggle('pilot-on', pilotOn);
}

/* ---------------- 演示模式 ----------------
   开启后隐藏「设置」「帮助」这类探索性入口，界面更适合录屏。
   注意：它只隐藏入口，不改变任何界面结构 —— 演示模式和正式版是同一套界面。 */
let demoMode = false;

function setDemoMode(on) {
  demoMode = !!on;
  const st = document.querySelector('#btnSettings');
  const hp = document.querySelector('#btnHelp');
  if (st) st.classList.toggle('hidden', demoMode);
  if (hp) hp.classList.toggle('hidden', demoMode);
  const bar = document.querySelector('#demoHint');
  if (bar) bar.classList.toggle('hidden', !demoMode);
  updatePilotHint();
  ZHILIAO_AI.set({ demo: demoMode });
}

/* ---------------- 启动兜底 ----------------
   JS 没能正常启动时，页面不能是一片空白让人干瞪眼。 */
function showFatal(msg) {
  let el = document.querySelector('#boot');
  if (!el) {
    el = node('<div class="boot" id="boot"><div class="boot-inner">' +
      '<div class="boot-mark">知</div><p class="boot-title"></p>' +
      '<p class="boot-sub"></p></div></div>');
    document.body.appendChild(el);
  }
  el.querySelector('.boot-title').textContent = msg;
  el.querySelector('.boot-sub').innerHTML =
    '试试<b>关掉这个窗口，重新双击</b>「知了诊所.app」。<br>' +
    '如果还是不行，确认文件夹里的 <b>js/</b> 和 <b>css/</b> 目录没有被移动。';
  el.classList.remove('hidden');
}

function renderComposer() {
  const chips = D.examples.map(t => '<button class="chip ex">' + esc(t) + '</button>').join('');
  const el = node(
    '<div>' +
      '<div class="composer">' +
        '<textarea id="qInput" rows="2" placeholder="想到什么说什么，不用组织语言…比如：普通本科生想进 AI 行业，还有机会吗？"></textarea>' +
        '<div class="composer-bar">' +
          '<span class="composer-hint">写得越具体，我越好办</span>' +
          '<button class="btn" id="btnReg" disabled>挂号</button>' +
        '</div>' +
      '</div>' +
      '<div class="chips-head">不知道从哪说起？点一个试试 ↓</div>' +
      '<div class="chips">' + chips + '</div>' +
      /* 评委打开链接时不会知道有 P 键这个快捷键。
         把「自动演示」这件事从隐藏快捷键变成看得见的入口 —— 这是第一眼就要看到的东西。 */
      '<div class="wd-row">' +
        '<button class="wd-btn" id="btnWatchDemo">' +
          '<span class="wd-ic">▶</span>不想自己跑？看我演示一遍' +
          '<span class="wd-note">它会自己走完全程，约 90 秒</span>' +
        '</button>' +
      '</div>' +
    '</div>');
  attach(el);

  const ta = $("#qInput", el);
  const btn = $("#btnReg", el);
  ta.addEventListener('input', () => {
    btn.disabled = ta.value.trim().length < 4;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  });
  /* 注意：这里刻意不聚焦输入框。焦点留在输入框里会让 P / R 这些
     单键快捷键被拦掉，而演示时最需要它们随叫随到。 */
  $$('.chip.ex', el).forEach(c => {
    c.onclick = () => {
      ta.value = c.textContent;
      ta.dispatchEvent(new Event('input'));
    };
  });
  btn.onclick = () => {
    const v = ta.value.trim();
    if (v.length < 4) return;
    run(onRegister(v));
  };
  const wd = $("#btnWatchDemo", el);
  if (wd) {
    wd.onclick = () => {
      wd.classList.add("hidden");
      startPilot();
    };
  }
  ta.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !btn.disabled) run(onRegister(ta.value.trim()));
  });
}

/* ===========================================================
   ① 挂号
   =========================================================== */
async function onRegister(question) {
  S.question = question;
  S.case = pickCase(question);
  S.rail = railFor(S.case.verdict);
  S.verdict = S.case.verdict;
  const box = $("#qInput") && $("#qInput").closest('.composer').parentElement;
  if (box) {
    const chipsHead = $(".chips-head", box);
    if (chipsHead) chipsHead.remove();
    const chips = $(".chips", box);
    if (chips) chips.remove();
    const c = $(".composer", box);
    if (c) c.remove();
  }
  attach(userBubble(question));
  setRail(1);

  const t = {
    dept: S.case.receipt.dept || '职业发展科',
    tag: S.case.receipt.tag || '待进一步分诊'
  };
  S.triage = t;

  await think(700);
  await say('<p>好，我记下了。咱们接着来。</p>');

  const r = S.case.receipt;
  const inner =
    '<div class="receipt"><div class="stamp">已挂号</div>' +
      '<div><span class="k">委托人　</span><span class="v">' + esc(r.client) + '</span></div>' +
      '<div><span class="k">主诉　　</span><span class="v">' + esc(question) + '</span></div>' +
      '<div><span class="k">初步分诊</span><span class="v">' + esc(t.dept) + ' · ' + esc(t.tag) + '</span></div>' +
      '<div><span class="k">建议流程</span><span class="v">' + esc(r.advice) + '</span></div>' +
      '<div style="margin-top:10px;border-top:1px dashed #d4d8e0;padding-top:8px;font-size:11.5px;color:#9aa3af">' +
        '知了诊所 · 狐看山医生　·　' + nowStr() +
      '</div>' +
    '</div>';
  attach(docCard('① 挂号单', '挂号单', '编号 ' + caseNo(), inner));

  await sleep(500);
  run(runAsk(0));
}

function nowStr() {
  const d = new Date();
  const p = n => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
let _no = 2;
function caseNo() { _no += 1; return 'ZL-' + String(_no).padStart(4, '0'); }

/* ===========================================================
   ② 问诊
   =========================================================== */
async function runAsk(i) {
  const qs = S.case.asks;
  if (i >= qs.length) { run(runChart()); return; }
  const q = qs[i];
  await think(600);

  const chips = q.chips.map(c => '<button class="chip ans">' + esc(c) + '</button>').join('') +
    '<button class="chip ans self">我自己说 →</button>';

  const bubble = docBubble(
    '<p>' + esc(q.q) + '</p>' +
    '<div class="chips" data-role="chips">' + chips + '</div>' +
    '<div class="chips hidden" data-role="input">' +
      '<input type="text" placeholder="用自己的话说…" style="flex:1;padding:9px 13px;border:1px solid var(--border-strong);border-radius:18px;font-size:13.5px;outline:none">' +
      '<button class="btn sm">发送</button>' +
    '</div>');
  attach(bubble);

  const row = $('div[data-role="chips"]', bubble);
  const inRow = $('div[data-role="input"]', bubble);

  const done = text => {
    S.answers.push({ q: q.q, a: text });
    attach(userBubble(text));
    run(runAsk(i + 1));
  };

  $$('.chip.ans', row).forEach(c => {
    c.onclick = () => {
      if (c.classList.contains('self')) {
        row.classList.add('hidden');
        inRow.classList.remove('hidden');
        const inp = $('input', inRow);
        inp.focus();
        const send = () => {
          const v = inp.value.trim();
          if (v.length < 1) return;
          done(v);
        };
        $('button', inRow).onclick = send;
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
        return;
      }
      row.classList.add('hidden');
      done(c.textContent);
    };
  });
}

/* ===========================================================
   ③ 病历首页
   =========================================================== */
async function runChart() {
  await think(1000);
  await say('<p>问得差不多了。我把你刚才说的整理成一份病历——你帮我看看，哪里写错了、哪里漏了。</p>');

  let chart = null;
  if (window.ZHILIAO_AI && ZHILIAO_AI.ready()) {
    try {
      const out = await ZHILIAO_AI.chart(S.question, S.answers);
      if (out && out.hypotheses && out.hypotheses.length) {
        chart = {
          chief: out.chief || S.question,
          history: out.history || '',
          variables: out.variables || [],
          hypotheses: out.hypotheses.slice(0, 3).map((h, idx) => ({
            id: String.fromCharCode(65 + idx),
            label: h.label,
            level: h.level || 'mid',
            levelText: h.levelText || '可能',
            desc: h.desc
          }))
        };
        if (out.dept) S.triage = { dept: out.dept, tag: out.tag || S.triage.tag };
        S.usedAI = true;
      }
    } catch (e) {
      noteDegrade('生成病历', e);
    }
  }
  if (!chart) chart = JSON.parse(JSON.stringify(S.case.chart));
  S.chart = chart;

  const hypos = chart.hypotheses.map(h =>
    '<div class="hypo" data-id="' + h.id + '">' +
      '<div class="hypo-radio"></div>' +
      '<div class="hypo-body">' +
        '<div class="hypo-top"><span class="hypo-label">假设 ' + h.id + ' · ' + esc(h.label) + '</span>' +
        '<span class="hypo-p ' + h.level + '">' + esc(h.levelText) + '</span></div>' +
        '<div class="hypo-desc">' + esc(h.desc) + '</div>' +
      '</div>' +
    '</div>').join('');

  const inner =
    sourceTag() +
    degradeNotice() +
    '<div class="kv"><span class="k">主诉</span><span class="v">' + esc(chart.chief) + '</span></div>' +
    (chart.history ? '<div class="kv"><span class="k">现病史</span><span class="v">' + esc(chart.history) + '</span></div>' : '') +
    (chart.variables.length ? '<div class="kv"><span class="k">关键变量</span><span class="v">' + esc(chart.variables.join(' · ')) + '</span></div>' : '') +
    '<div style="height:16px"></div>' +
    '<div class="notice info"><span class="ic">▸</span><span>' +
      '这只是我的猜测，不算数。<b>请你自己确认哪一条最像你</b>——你确认的，才会进入下一步。' +
    '</span></div>' +
    '<div style="height:14px"></div>' +
    hypos +
    '<button class="btn wide" id="btnConfirm" disabled style="margin-top:6px">确认这个病灶</button>';

  const card = docCard('② 病历首页', '病历首页', '', inner);
  attach(card);

  let picked = null;
  $$('.hypo', card).forEach(h => {
    h.onclick = () => {
      $$('.hypo', card).forEach(x => x.classList.remove('on'));
      h.classList.add('on');
      picked = h.getAttribute('data-id');
      $('#btnConfirm', card).disabled = false;
    };
  });
  $('#btnConfirm', card).onclick = () => {
    if (!picked) return;
    const h = chart.hypotheses.find(x => x.id === picked);
    S.wound = '假设 ' + h.id + ' · ' + h.label;
    $('#btnConfirm', card).disabled = true;
    $('#btnConfirm', card).textContent = '已确认';
    attach(userBubble('假设 ' + h.id + ' · ' + h.label + '，更像我'));
    setRail(2);
    run(runMap());
  };
}

/* ===========================================================
   ④ 分歧地图
   =========================================================== */
async function runMap() {
  await think(1200);
  await say('<p>病历有了。接下来我去翻一遍知乎——我不做摘要，' +
            '要专门找的是<b>大家到现在还没吵拢的地方</b>。</p>');

  /* ---------- v1.7：先从知乎开放平台取真实讨论 ----------
     取到什么，直接决定了这张图是不是「真的」。
     没接、或取不到，都往下走内置语料，但界面上会如实标注。 */
  let real = null;
  if (window.ZHILIAO_ZHIHU && ZHILIAO_ZHIHU.ready()) {
    S.zhihuTried = true;
    await say('<p>这次我不凭印象。我把知乎站内搜索拉过来，先把真实讨论取回来。</p>');
    try {
      const r = await ZHILIAO_ZHIHU.search(searchQuery(), 10);
      if (r.items && r.items.length) {
        real = r;
        S.zhihuPosts = r.items;
      } else {
        noteDegrade('检索知乎站内内容', new Error('站内没有检索到相关讨论'));
      }
    } catch (e) {
      noteDegrade('检索知乎站内内容', e);
    }
  }

  let map = null;
  let aiAnalyzed = false;
  if (window.ZHILIAO_AI && ZHILIAO_AI.ready() && S.usedAI) {
    try {
      const out = await ZHILIAO_AI.disputes(S.question, S.wound, real);
      /* 判定要看 out.current，不能看 disputes 有没有内容 ——
         「已确诊」「信息不足」这两种判定本来就没有分歧清单，
         用 disputes.length 当条件会把它们全部误判成调用失败。 */
      if (out && out.current) {
        map = {
          topic: out.topic || S.question,
          corpus: out.corpus || 1200,
          current: out.current,
          conclusion: out.conclusion || '存在真实分歧，建议会诊。',
          disputes: (out.disputes || []).slice(0, 3).map((d, i) => ({
            idx: String.fromCharCode(65 + i),
            name: d.name,
            level: d.level || 'mid',
            levelText: d.levelText || '分歧程度：中',
            bar: typeof d.bar === 'number' ? d.bar : 55,
            clusters: d.clusters || []
          })),
          consensus: (out.consensus || []).slice(0, 3),
          sparse: (out.sparse || []).slice(0, 3),
          draft: out.draft || null,
          /* 已确诊分支的行动清单也在这份产出里，别漏传 */
          plan: (out.plan || []).filter(p => p && p.what),
          planNote: out.planNote || ''
        };
        aiAnalyzed = true;
      }
    } catch (e) { noteDegrade('争议检测', e); }
  }
  if (!map) {
    map = JSON.parse(JSON.stringify(S.case.map));
    if (S.usedAI) map.corpus = map.corpus;
  }
  S.map = map;

  /* 走哪条分支，以本次检测结果为准。
     挂号时用关键词猜的 verdict 只是「预判」，真实 AI 模式下它和检测结果
     可能不一致 —— 如果界面高亮「已确诊」、流程却去开了会诊，
     那这个产品最重要的那句承诺（会说「不用会诊」）就成了假话。 */
  if (map.current && map.current !== S.verdict) {
    S.verdict = map.current;
    S.rail = railFor(map.current);
    renderRail();
  }

  const triageCells = D.verdicts.map(v =>
    '<div class="triage-cell ' + (v.id === map.current ? 'on' : '') + '">' +
      '<span class="tl">' + esc(v.label) + '</span>' +
      '<span class="ts">' + esc(v.sub) + '</span>' +
    '</div>').join('');

  /* 三档判定 → 三种不同的呈现：共识条目 / 零散讨论 / 对立观点簇 */
  const findings = findingRows(map);
  const noticeKind = map.current === 'settled' ? 'ok'
    : (map.current === 'insufficient' ? 'warn' : 'warn');

  const inner =
    sourceTag() +
    degradeNotice() +
    corpusTag() +
    '<div class="triage">' + triageCells + '</div>' +
    '<div class="doc-sub" style="margin-bottom:14px">已检索：知乎 ' + map.corpus.toLocaleString() + ' 条相关讨论</div>' +
    findings +
    ((real && !aiAnalyzed) ? realPostsHTML(real) : '') +
    '<div class="notice ' + noticeKind + '" style="margin-top:16px">' +
      '<span class="ic">▸</span><span><b>判定：</b>' + esc(map.conclusion) + '</span>' +
    '</div>';

  attach(docCard('③ 分歧地图', map.topic, '', inner));

  await sleep(400);

  if (S.verdict === 'settled') { run(runSettled()); return; }
  if (S.verdict === 'insufficient') { run(runInsufficient()); return; }
  run(runInvite());
}

/* 把三种判定结果统一成同一套渲染用的结构 */
function findingRows(map) {
  let list = [];
  if (map.current === 'settled') {
    list = (map.consensus || []).map(c => ({
      idx: '✓', name: c.name, level: 'ok',
      levelText: '支持度 ' + (c.support || '高'),
      bar: c.bar || 90,
      clusters: [{ title: c.meta || '' }]
    }));
  } else if (map.current === 'insufficient') {
    list = (map.sparse || []).map((c, i) => ({
      idx: String(i + 1), name: c.name, level: 'none',
      levelText: c.levelText || '相关性：低',
      bar: c.bar || 20,
      clusters: [{ title: c.meta || '' }]
    }));
  } else {
    list = map.disputes || [];
  }
  return list.map(d =>
    '<div class="dispute">' +
      '<div class="dispute-top">' +
        '<span class="dispute-idx">' + d.idx + '</span>' +
        '<span class="dispute-name">' + esc(d.name) + '</span>' +
        '<span class="level ' + d.level + '">' +
          '<span>' + esc(d.levelText) + '</span>' +
          '<span class="level-bar"><i style="width:' + d.bar + '%"></i></span>' +
        '</span>' +
      '</div>' +
      '<div class="clusters">' +
        (d.clusters || []).map(c =>
          '<span class="cluster"><b>' + esc(c.title) + '</b>' + (c.meta ? '　' + esc(c.meta) : '') + '</span>'
        ).join('') +
      '</div>' +
    '</div>').join('');
}

/* ===========================================================
   ⑤ 会诊邀请
   =========================================================== */
async function runInvite() {
  await think(900);
  const nClusters = S.map && S.map.disputes ? S.map.disputes.length : 2;
  await say('<p>看了一圈，有 ' + nClusters + ' 处大家到现在还没吵拢。' +
            '这种问题，再多刷十篇回答也不会有结果——我去请几位走过这条路的人。</p>');
  await think(1400);
  await say('<p>我要找的不是粉丝最多的，是<b>在这件事上真的有话可说的人</b>。' +
            '而且最好他们观点还不一样——要是大家想法都一致，这一场就没什么意思了。</p>');

  let experts = null;
  if (window.ZHILIAO_AI && ZHILIAO_AI.ready() && S.usedAI) {
    try {
      const out = await ZHILIAO_AI.json([
        { role: 'system', content: '你是知了诊所的会诊编排内核。你要为一个具体困惑，挑选 4 位「在这个问题上彼此有话可说、且观点有张力」的参与者，并依据知乎真实讨论塑造他们的证言与合议。' },
        { role: 'user', content:
          '病例主诉：' + S.question + '\n已确认病灶：' + S.wound + '\n'
          + '检出分歧：' + JSON.stringify((S.map ? S.map.disputes : []).map(d => d.name)) + '\n\n'
          + '输出 JSON：\n{\n'
          + ' "experts":[{"id":"e0","name":"姓名","role":"身份，如 算法工程师·转行第3年","stance":"立场短语,不超过6字",'
          + '"source":"他的一篇内容标题，如《转行进AI这一年》回答第3段","favorite":47,"cite":"他那篇内容里的一句原话，25字内",'
          + '"why":"为什么请他，30-50字，要点明他与本困惑的具体关联","relevance":85,"tension":75}],\n'
          + ' "testimonies":[{"authorId":"e0","dur":"1分48秒","text":"他的证言，讲真实经历不讲道理，80-130字"}],\n'
          + ' "panel":[{"who":"host","text":"狐看山医生的主持发言"},{who":"e0","text":"参与者发言",'
          + '"rec":{"kind":"consensus|dispute|evidence|dissent","key":"标签如 已形成共识","text":"记录内容，20字内"}}],\n'
          + ' "handnotes":[{"authorId":"e0","title":"他这篇手记的标题，16-26字，必须含具体数字或细节",'
          + '"sources":["证言 1分48秒","合议发言 2 处"],"words":1180,'
          + '"excerpt":"由他本人的证言与合议发言重新组织的全文预览，140-200字，第一人称，'
          + '必须保留原话中的具体数字，不得新增任何事实"}]\n}\n'
          + '要求：experts 恰好 4 位，id 依次 e0/e1/e2/e3；观点必须分成两派形成张力；'
          + 'testimonies 每条对应一位专家，authorId 与 experts 对齐；'
          + 'panel 12-16 条，第一条必须是 host 摆分歧，host 的发言要包含点名追问（用 @姓名），'
          + '过程中至少 2 条 rec 为 evidence、1 条 dispute，最后一条 host 收尾；'
          + '必须有且仅有一位专家在最后提出反对意见，对应 rec.kind 为 dissent；'
          + 'handnotes 恰好 4 条，authorId 与 experts 一一对应；'
          + 'excerpt 只能使用该专家自己说过的话里的事实与数字，一个字都不许编。'
      }], { maxTokens: 3200, temperature: 0.85 });
      if (out && out.experts && out.experts.length >= 3) {
        const PAL = ['#0084ff', '#f1403c', '#ff9607', '#0f6e56', '#7f77dd', '#d4537e'];
        experts = out.experts.slice(0, 4).map((e, i) => ({
          id: e.id || ('e' + i),
          name: e.name || ('专家' + (i + 1)),
          role: e.role || '',
          init: String(e.name || '专').slice(0, 1),
          color: PAL[i % PAL.length],
          stance: e.stance || '',
          source: e.source || '',
          favorite: e.favorite || 0,
          why: e.why || '',
          relevance: e.relevance || 80,
          tension: e.tension || 70,
          cite: e.cite || ''
        }));
        S.testimonies = (out.testimonies || []).map(t => ({
          author: t.authorId || t.id || (experts[0] && experts[0].id),
          dur: t.dur || '1 分 30 秒',
          text: t.text || ''
        }));
        S.panel = (out.panel || []).map(m => ({
          who: (m.who === 'host' || m.who === '狐看山医生') ? 'host' : m.who,
          text: m.text || '',
          rec: (m.rec && m.rec.kind) ? { kind: m.rec.kind, key: m.rec.key || '', text: m.rec.text || '' } : null
        }));
        S.handnotes = (out.handnotes || []).map(h => ({
          author: h.authorId || h.id || (experts[0] && experts[0].id),
          title: h.title || '',
          sources: h.sources || [],
          words: h.words || 0,
          column: '会诊手记',
          excerpt: h.excerpt || ''
        })).filter(h => h.title && h.excerpt);
      }
    } catch (e) { noteDegrade('编排会诊', e); }
  }
  if (!experts || !experts.length) {
    experts = JSON.parse(JSON.stringify(S.case.experts));
    S.testimonies = JSON.parse(JSON.stringify(S.case.testimonies));
    S.panel = JSON.parse(JSON.stringify(S.case.panel));
  }
  if (!S.handnotes || !S.handnotes.length) {
    S.handnotes = JSON.parse(JSON.stringify(S.case.handnotes));
  }
  S.experts = experts;
  S.experts.forEach(e => { avMap[e.id] = e; });

  const rows = experts.map(e =>
    '<div class="expert">' +
      '<div class="exp-av" style="background:' + e.color + '">' + esc(e.init) + '</div>' +
      '<div class="exp-body">' +
        '<div class="exp-top">' +
          '<span class="exp-name">' + esc(e.name) + '</span>' +
          '<span class="exp-role">' + esc(e.role) + '</span>' +
          '<span class="exp-stance">' + esc(e.stance) + '</span>' +
        '</div>' +
        '<div class="exp-why">' + esc(e.why) + ' 引用自' + esc(e.source) +
          '，被 ' + e.favorite + ' 人收藏。<em>「' + esc(e.cite) + '」</em></div>' +
        '<div class="exp-match">' +
          '<span>相关性 <b>' + e.relevance + '</b></span>' +
          '<span>观点张力 <b>' + e.tension + '</b></span>' +
        '</div>' +
      '</div>' +
    '</div>').join('');

  const inner =
    sourceTag() +
    degradeNotice() +
    '<div class="notice info" style="margin-bottom:16px"><span class="ic">▸</span><span>' +
      '邀请函上写的不是「帮个忙」，而是「你哪一篇回答的哪一段被检出相关」。这是内容价值的召回，不是社交请求。' +
    '</span></div>' +
    rows +
    '<div style="height:6px"></div>' +
    '<div class="notice" style="margin-bottom:16px"><span class="ic">▸</span><span>' +
      '接受会诊需要登录知乎——一个人挂号，至少唤醒一位沉默的创作者。' +
    '</span></div>' +
    '<button class="btn wide" id="btnStartRoom">开始会诊（4 人 · 约 15 分钟）</button>';

  const card = docCard('④ 会诊邀请函', '这场会诊，请来了这几位', '共 4 位', inner);
  attach(card);
  setRail(3);

  $('#btnStartRoom', card).onclick = () => {
    $('#btnStartRoom', card).disabled = true;
    $('#btnStartRoom', card).textContent = '已发出邀请…';
    run(openRoom());
  };
}

/* ===========================================================
   ⑥ 会诊室
   =========================================================== */
let avMap = {};
function avFor(id) {
  if (avMap[id]) return avMap[id];
  const e = (S.experts || []).find(x => x.id === id) ||
    { name: '会诊专家', init: '专', color: '#8590a6', role: '' };
  avMap[id] = e;
  return e;
}
function wave() {
  let h = '';
  for (let i = 0; i < 14; i++) h += '<i style="height:' + (4 + Math.round(Math.random() * 8)) + 'px"></i>';
  return '<span class="wave">' + h + '</span>';
}

async function openRoom() {
  skipping = false;
  $("#roomFeed").innerHTML = '';
  $("#roomRec").innerHTML = '<div style="font-size:12.5px;color:var(--t3);line-height:1.7">' +
    '狐看山医生会在合议过程中，把共识、分歧、实证与保留意见实时打标到这里。</div>';
  $("#roomTopic").textContent = '议题：' + (S.map ? S.map.topic : S.question);
  setPhase(1);
  $("#roomOverlay").classList.remove("hidden");
  $("#btnRoomNext").disabled = true;
  $("#btnRoomNext").textContent = "进行中…";
  $("#roomStatus").textContent = "阶段一 · 异步证言收集（48 小时内各自提交）";
  $("#btnSkip").classList.remove("hidden");

  await playTestimonies();
  await playPanel();

  setPhase(3);
  $("#roomStatus").textContent = "阶段三 · 参与者确认结论草稿";
  await sleep(600);
  const conf = node('<div class="notice info fade" style="margin-top:6px"><span class="ic">▸</span><span>' +
    '<b>4 位参与者已确认。</b>结论草稿将在 24 小时内定稿，其中 @苏晚 选择保留异议——' +
    '他的意见会原样写进结论书，不会因为只有一个人就删掉。</span></div>');
  $("#roomFeed").appendChild(conf);
  scrollFeed();

  $("#roomStatus").textContent = "会诊结束";
  $("#btnSkip").classList.add("hidden");
  const b = $("#btnRoomNext");
  b.disabled = false;
  b.textContent = "查看会诊结论书";
  b.onclick = () => {
    $("#roomOverlay").classList.add("hidden");
    run(runConclusion());
  };
}

function setPhase(n) {
  $$("#roomPhase .phase-pill").forEach(p => {
    const i = +p.getAttribute("data-phase");
    p.className = "phase-pill" + (i === n ? " on" : (i < n ? " done" : ""));
  });
}

async function playTestimonies() {
  for (const t of (S.testimonies || [])) {
    const e = avFor(t.author);
    const card = node(
      '<div class="testimony">' +
        '<div class="tm-head">' +
          '<div class="tm-av" style="background:' + e.color + '">' + esc(e.init) + '</div>' +
          '<div><div class="tm-name">' + esc(e.name) + '</div>' +
          '<div style="font-size:11.5px;color:var(--t3)">' + esc(e.role) + '</div></div>' +
          '<div class="tm-audio">' + wave() + '<span>证言 ' + esc(t.dur) + '</span></div>' +
        '</div>' +
        '<div class="tm-text"><span class="quote-mark">「</span>' + esc(t.text) + '<span class="quote-mark">」</span></div>' +
      '</div>');
    card.classList.add("fade");
    $("#roomFeed").appendChild(card);
    scrollFeed();
    await sleep(900);
  }
  await sleep(400);
}

async function playPanel() {
  setPhase(2);
  $("#roomStatus").textContent = "阶段二 · 同步合议（狐看山医生主持）";
  await sleep(500);

  const host = { name: "狐看山医生", init: "狐", color: "#0f6e56" };

  for (const m of (S.panel || [])) {
    const isHost = m.who === "host";
    const e = isHost ? host : avFor(m.who);
    const avHTML = isHost
      ? '<div class="msg-av msg-av-host"><img class="avatar-img" src="assets/fox-avatar.png" alt="狐看山医生"></div>'
      : '<div class="msg-av" style="background:' + e.color + '">' + esc(e.init) + '</div>';
    const msg = node(
      '<div class="msg ' + (isHost ? "host" : "answer") + '">' +
        avHTML +
        '<div class="msg-body">' +
          '<div class="msg-name"><b>' + esc(e.name) + '</b>' +
            (isHost ? ' · 主持' : ' · 会诊专家') + '</div>' +
          '<div class="msg-text">' + esc(m.text) + '</div>' +
        '</div>' +
      '</div>');
    msg.classList.add("fade");
    $("#roomFeed").appendChild(msg);
    scrollFeed();
    if (m.rec) {
      await sleep(260);
      const r = node(
        '<div class="rec-item ' + m.rec.kind + ' fade">' +
          '<span class="rk">' + esc(m.rec.key) + '</span>' + esc(m.rec.text) +
        '</div>');
      $("#roomRec").appendChild(r);
    }
    await sleep(820);
  }
  await sleep(300);
}

/* ===========================================================
   ⑦ 结论书 + 行动清单
   =========================================================== */
async function runConclusion() {
  await think(1100);
  await say('<p>聊完了。我把大家说的整理成一份结论书——' +
            '每条结论都标上<b>是几位参与者都同意</b>的，来源不含糊。</p>');

  let c = null;
  if (window.ZHILIAO_AI && ZHILIAO_AI.ready() && S.usedAI) {
    try {
      const out = await ZHILIAO_AI.conclusion({
        question: S.question, wound: S.wound,
        disputes: S.map ? S.map.disputes : [],
        experts: S.experts.map(x => ({ name: x.name, role: x.role, stance: x.stance })),
        testimonies: (S.testimonies || []).map(t => ({ who: avFor(t.author).name, text: t.text })),
        panel: (S.panel || []).map(m => ({ who: m.who === "host" ? "狐看山医生" : avFor(m.who).name, text: m.text }))
      });
      if (out && out.consensus && out.consensus.length) {
        c = {
          title: out.title || S.case.conclusion.title,
          meta: "由一场 " + S.experts.length + " 人会诊产生 · " + nowStr(),
          consensus: out.consensus,
          dispute: out.dispute || '',
          dissent: out.dissent || S.case.conclusion.dissent
        };
        S.plan = out.plan || S.case.plan;
        S.planNote = out.planNote || S.case.planNote;
      }
    } catch (e) { noteDegrade('整理结论书', e); }
  }
  if (!c) {
    c = JSON.parse(JSON.stringify(S.case.conclusion));
    c.meta = "由一场 " + S.experts.length + " 人会诊产生 · " + nowStr();
    S.plan = JSON.parse(JSON.stringify(S.case.plan));
    S.planNote = S.case.planNote;
  }
  S.conclusion = c;

  const cons = c.consensus.map(x =>
    '<div class="sect consensus">' +
      '<span class="sect-label"><span class="dot"></span>共识</span>' +
      '<div class="sect-text">' + esc(x.text) +
        '<span class="src">' + esc(x.src) + '</span></div>' +
    '</div>').join('');

  const dis = c.dissent
    ? '<div class="sect"><span class="sect-label" style="color:var(--red)">' +
        '<span class="dot" style="background:var(--red)"></span>少数意见（完整保留）</span>' +
        '<div class="dissent-box">' +
          '<div style="font-size:13px;color:var(--t2);margin-bottom:7px">' +
            '<b style="color:var(--t1)">' + esc(c.dissent.author) + '</b>　' + esc(c.dissent.role || '') + '</div>' +
          '<div class="sect-text">' + esc(c.dissent.text) + '</div>' +
          '<div class="note">' + esc(c.dissent.note || '该观点未被采纳为共识，在此完整保留。') + '</div>' +
        '</div>' +
      '</div>'
    : '';

  const byline =
    '<div class="byline"><span class="lb">共同署名：</span>' +
      S.experts.map(e => '<span class="mini-av" style="background:' + e.color + '" title="' + esc(e.name) + '">' +
        esc(e.init) + '</span>').join('') +
      '<span class="lb" style="margin-left:6px">' + S.experts.map(e => e.name).join(' · ') + '</span>' +
    '</div>';

  const inner =
    sourceTag() +
    degradeNotice() +
    '<div class="concl-title">《' + esc(c.title) + '》</div>' +
    '<div class="concl-meta">' + esc(c.meta) + '</div>' +
    cons +
    (c.dispute ? '<div class="sect dispute"><span class="sect-label"><span class="dot"></span>存留分歧</span>' +
      '<div class="sect-text">' + esc(c.dispute) + '</div></div>' : '') +
    dis + byline +
    '<div style="height:16px"></div>' +
    '<button class="btn wide" id="btnPublish">发布到知乎（成为新的内容）</button>' +
    copyRow('btnCopyConcl', '复制结论书全文');

  const conclCard = docCard('⑤ 会诊结论书', '会诊结论书', '公开 · 共同署名', inner);
  attach(conclCard);
  bindCopy('#btnCopyConcl', conclCard, conclusionMarkdown);
  setRail(4);

  $("#btnPublish").onclick = e => {
    e.target.disabled = true;
    e.target.textContent = '已发布 · 知乎问题下新增 1 条回答';
    run(runPlan());
  };
}

async function runPlan() {
  await think(800);
  await say('<p>结论书是公开的，留给以后搜到这个问题的人。接下来这份，只写给你。</p>');

  S.reviewAt = reviewDate(3);
  attachPlanCard(S.plan, S.planNote, '⑥ 行动清单');
  setRail(5);

  await runHandnotes();

  await sleep(400);
  await attachDoneCard('这一例，结清了。',
    '《会诊结论书》回到了知乎，成为新的内容；<br>' +
    '四位参与者各带走一篇《会诊手记》，一个字都没用他们写；<br>' +
    '而这份《行动清单》留在你这里。3 个月后，我来问你执行到哪一步了。');
}

/* ---------------- 两条非会诊分支共用的零件 ---------------- */
/* 行动清单。done 是与 plan 等长的布尔数组；带勾选框，进度会写回档案。
   reviewAt 传入时额外显示回访提醒 —— 光有"回访"两个字不算管随访，得有日期。 */
function planCardHTML(plan, note, done, reviewAt) {
  const d = done || [];
  const items = (plan || []).map((p, i) =>
    '<div class="rx-item' + (d[i] ? ' done' : '') + '" data-idx="' + i + '">' +
      '<span class="rx-check" role="checkbox" aria-checked="' + (d[i] ? 'true' : 'false') + '">' +
        '<svg viewBox="0 0 12 12" width="9" height="9"><path d="M2 6.2L4.8 9 10 3.4" ' +
        'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
        'stroke-linejoin="round"/></svg>' +
      '</span>' +
      '<div class="rx-body">' +
        '<div class="rx-when">' + esc(p.when) + '</div>' +
        '<div class="rx-what">' + esc(p.what) + '</div>' +
      '</div>' +
    '</div>').join('');

  const total = (plan || []).length;
  const got = d.filter(Boolean).length;

  return '<div class="doc-sub" style="margin-bottom:14px">这份清单只有你自己能看见，不会发布。' +
      (total ? '<span class="rx-progress" id="rxProgress">已执行 ' + got + ' / ' + total + '</span>' : '') +
    '</div>' +
    '<div class="rx" id="rxList">' + items + '</div>' +
    (reviewAt
      ? '<div class="rx-review"><span class="rx-review-k">回访</span>' +
        '<span class="rx-review-v">' + esc(reviewAt) + '</span>' +
        '<span class="rx-review-s">到那天我会来问你执行到哪一步</span></div>'
      : '') +
    '<div class="rx-note">' + esc(note || '') + '</div>' +
    copyRow('btnCopyPlan', '复制这份清单');
}

function attachPlanCard(plan, note, tag) {
  const n = (plan || []).length;
  /* 进度数组必须与清单等长，否则勾选会错位 */
  if (!Array.isArray(S.planDone) || S.planDone.length !== n) {
    S.planDone = new Array(n).fill(false);
  }
  const card = docCard(tag || '⑥ 行动清单', '行动清单', '私密 · 只属于你',
    planCardHTML(plan, note, S.planDone, S.reviewAt));
  attach(card);
  bindPlanChecks(card, (i, on) => {
    S.planDone[i] = on;
    updateRecordProgress();
  });
  bindCopy('#btnCopyPlan', card, planMarkdown);
  return card;
}

/* 勾选交互：任何一处清单（流程里 / 档案详情里）都用这一套 */
function bindPlanChecks(root, onChange) {
  $$('.rx-item', root).forEach(item => {
    item.onclick = () => {
      const i = Number(item.getAttribute('data-idx'));
      item.classList.toggle('done');
      const on = item.classList.contains('done');
      const box = $('.rx-check', item);
      if (box) box.setAttribute('aria-checked', on ? 'true' : 'false');
      if (onChange) onChange(i, on);
      const bar = $('#rxProgress', root);
      if (bar) {
        const total = $$('.rx-item', root).length;
        const got = $$('.rx-item.done', root).length;
        bar.textContent = '已执行 ' + got + ' / ' + total;
      }
    };
  });
}
async function attachDoneCard(title, subHTML) {
  const done = node(
    '<div class="done-card rise">' +
      '<div class="done-emoji">✓</div>' +
      '<div class="done-title">' + esc(title) + '</div>' +
      '<div class="done-sub">' + subHTML + '</div>' +
      '<div class="done-actions">' +
        '<button class="btn" id="btnAgain">再挂一个号</button>' +
        '<button class="btn ghost" id="btnGoRecords">去看看我的病例</button>' +
      '</div>' +
    '</div>');
  attach(done);
  saveRecord();
  renderRecords();
  $("#btnAgain", done).onclick = () => { start(); window.scrollTo({ top: 0, behavior: "smooth" }); };
  $("#btnGoRecords", done).onclick = () => switchView("records");
}

/* ===========================================================
   分支一：已确诊（知乎早有共识，不必会诊）
   =========================================================== */
async function runSettled() {
  await think(900);
  await say('<p>先说个可能让你意外的结论：<b>这个问题，不用会诊。</b></p>');
  await say('<p>知乎上关于这件事的讨论有两千多条，其实早就说拢了。' +
            '再请人来吵一遍，对他们不太公平，对你也没什么帮助。</p>', 300);
  await think(700);

  const st = settledContent();
  const points = (st.points || []).map(pt =>
    '<div class="sect consensus">' +
      '<span class="sect-label"><span class="dot"></span>共识</span>' +
      '<div class="sect-text">' + esc(pt.text) +
        '<span class="src">' + esc(pt.src) + '</span></div>' +
    '</div>').join('');

  const inner =
    sourceTag() +
    degradeNotice() +
    '<div class="concl-title">《' + esc(st.title) + '》</div>' +
    '<div class="concl-meta">' + esc(st.byline) + ' · ' + nowStr() + '</div>' +
    points +
    '<div class="notice ok"><span class="ic">▸</span><span>' + esc(st.note) + '</span></div>' +
    copyRow('btnCopySettled', '复制这份结论');

  const stCard = docCard('④ 已确诊结论', '已确诊结论', '公开 · 来自社区共识', inner);
  attach(stCard);
  /* bindCopy 里的 build 是点击时才求值的，所以这里的调用顺序不影响取数 */
  bindCopy('#btnCopySettled', stCard, conclusionMarkdown);

  S.conclusion = {
    title: st.title,
    meta: st.byline + ' · ' + nowStr(),
    consensus: (st.points || []).map(pt => ({ text: pt.text, src: pt.src })),
    dispute: '',
    dissent: null
  };
  /* 行动清单也要用本次 AI 的产出：判定了「已确诊」却给出一份
     另一道题的行动清单，和内容错配是同一个毛病。 */
  S.plan = (st.plan && st.plan.length) ? st.plan : S.case.plan;
  S.planNote = st.planNote || S.case.planNote;
  S.experts = [];
  setRail(4);

  await sleep(500);
  await say('<p>结论给你了。下面这份，只写给你。</p>');
  await attachPlanCard(S.plan, S.planNote, '⑤ 行动清单');
  setRail(5);

  await sleep(400);
  await attachDoneCard('这一例，直接了结。',
    '这个问题知乎早有共识，所以没有会诊、没有结论书、也没有会诊手记。<br>' +
    '这恰恰是它该有的样子——<b>一个只在你需要它的时候才出现的 AI，才值得信任。</b>');
}

/* ===========================================================
   分支二：信息不足（存量内容稀疏，把问题还给社区）
   =========================================================== */
async function runInsufficient() {
  await think(1000);
  await say('<p>这次我得跟你说实话：<b>这个结论，我给不了你。</b></p>');
  await say('<p>不是没有先例，是材料太少——关于你这个方向，全站的讨论只有几十条，' +
            '而且几乎都是行业综述，没有一条讲「一个本科生具体该怎么转过去」。</p>', 300);
  await think(700);
  await say('<p>硬凑一条路给你，不如老实跟你说清楚。</p>');
  await think(600);
  await say('<p>不过，我也不想就这么让你走。<b>我陪你把这个问题的问法改一改。</b></p>', 400);

  const dr = draftContent();
  const body = String(dr.body || '').split('\n')
    .filter(t => t.trim()).map(t => '<p>' + esc(t.trim()) + '</p>').join('');
  const hints = (dr.hints || []).map(h => '<li>' + esc(h) + '</li>').join('');

  const inner =
    sourceTag() +
    degradeNotice() +
    '<div class="doc-sub" style="margin-bottom:14px">' + esc(dr.lead) + '</div>' +
    '<div class="hn-excerpt">' +
      '<div class="draft-title">' + esc(dr.title) + '</div>' + body +
    '</div>' +
    '<div style="height:16px"></div>' +
    '<div class="doc-sub" style="margin-bottom:8px">' + esc(dr.whyTitle) + '</div>' +
    '<ul class="hint-list">' + hints + '</ul>' +
    '<div style="height:16px"></div>' +
    '<button class="btn wide" id="btnCopyDraft">' + esc(dr.button) + '</button>';

  const card = docCard('④ 提问草稿', '这个结论我给不了，但社区可以', '公开 · 待回答', inner);
  attach(card);

  const btn = $('#btnCopyDraft', card);
  btn.onclick = () => {
    const text = dr.title + '\n\n' + dr.body;
    const okCopy = copyText(text);
    btn.disabled = true;
    btn.textContent = okCopy ? '已复制 · 去知乎粘贴发布' : '草稿已展开，请手动复制上方正文';
  };

  S.conclusion = {
    title: dr.title,
    meta: '信息不足，未形成结论 · ' + nowStr(),
    consensus: [{ text: '已帮你把问题重新组织成一份草稿，待社区回答。', src: '待回答' }],
    dispute: '',
    dissent: null
  };
  S.plan = S.case.plan;
  S.planNote = S.case.planNote;
  S.experts = [];
  setRail(4);

  await sleep(500);
  await say('<p>你现在要做的第一件事，不是照着方案走，而是<b>先把缺的信息拿回来</b>。</p>');
  await attachPlanCard(S.plan, S.planNote, '⑤ 行动清单');
  setRail(5);

  await sleep(400);
  await attachDoneCard('这一例，没有结清。',
    '我没能给你结论——因为材料不够。<br>' +
    '但你现在有了一个更好的问题，和一个更值得去问的人。<br>' +
    '等社区给了回答，带着它回来再挂一次号。');
}

/* ===========================================================
   结案产出可以带走（v1.6）
   -----------------------------------------------------------
   产品承诺是「结论书回到知乎，行动清单留在你这里」。
   但如果用户拿不走，这个承诺就停在界面上。
   最小可行的做法：给一份可以直接粘贴的 Markdown —— 没有后端，
   所以不做真实发布，但至少要让人能把它带走。
   =========================================================== */
function conclusionMarkdown() {
  const c = S.conclusion || {};
  const L = [];
  L.push('# ' + (c.title || '会诊结论书'));
  L.push('');
  if (c.meta) { L.push('> ' + c.meta + '　·　由知了诊所组织会诊产生'); L.push(''); }
  if ((c.consensus || []).length) {
    L.push('## 共识');
    L.push('');
    c.consensus.forEach(x => L.push('- ' + x.text + (x.src ? '（' + x.src + '）' : '')));
    L.push('');
  }
  if (c.dispute) { L.push('## 存留的分歧'); L.push(''); L.push(c.dispute); L.push(''); }
  if (c.dissent) {
    L.push('## 少数意见（完整保留）');
    L.push('');
    L.push('**' + (c.dissent.author || '') + '**　' + (c.dissent.role || ''));
    L.push('');
    L.push(c.dissent.text || '');
    L.push('');
  }
  return L.join('\n').trim();
}

function planMarkdown() {
  const L = ['## 行动清单（只属于你）', ''];
  (S.plan || []).forEach((p, i) => {
    L.push('- [' + (S.planDone && S.planDone[i] ? 'x' : ' ') + '] **' + p.when + '**　' + p.what);
  });
  if (S.reviewAt) { L.push(''); L.push('回访：' + S.reviewAt); }
  if (S.planNote) L.push(S.planNote);
  return L.join('\n');
}

/* 复制按钮的统一样式与反馈：点完必须让用户知道成功了没有，
   否则他会反复点。复制失败时不留一个"看起来成功了"的假象。 */
function copyRow(btnId, label) {
  return '<div class="copy-row"><button class="btn ghost sm" id="' + btnId + '">' + label + '</button></div>';
}

function bindCopy(sel, root, build) {
  const b = $(sel, root);
  if (!b) return;
  const label = b.textContent;
  b.onclick = () => {
    const text = build();
    const ok = copyText(text);
    b.disabled = true;
    b.textContent = ok ? '已复制 · 去知乎粘贴即可' : '复制失败，请手动选中上方内容';
    setTimeout(() => { b.textContent = label; b.disabled = false; }, 2400);
  };
}

/* 复制到剪贴板（file:// 下 navigator.clipboard 常常不可用，用 execCommand 兜底） */
function copyText(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

/* ===========================================================
   ⑧ 会诊手记（供给端闭环）
   -----------------------------------------------------------
   这是「创作者为什么会来」这个问题的可视答案：
   一次参与 = 一篇内容，而且他一个字都不用写。
   手记内容只由该专家自己的证言与合议发言重组而成，不新增事实。
   =========================================================== */
async function runHandnotes() {
  await think(900);
  await say('<p>还有一件事想跟你说——这场会诊里，四位专家各自讲了一段自己的真实经历。</p>');
  await say('<p>这些话不该说完就散了。<b>它们会变成他们自己的内容。</b></p>', 400);
  await think(700);

  const notes = S.handnotes || [];
  if (!notes.length) return;

  const rows = notes.map(h => {
    const e = avFor(h.author);
    const paras = String(h.excerpt || '').split('\n')
      .filter(t => t.trim())
      .map(t => '<p>' + esc(t.trim()) + '</p>').join('');
    return '<div class="hn">' +
      '<div class="hn-head">' +
        '<div class="hn-av" style="background:' + e.color + '">' + esc(e.init) + '</div>' +
        '<div class="hn-who">' +
          '<div class="hn-name">' + esc(e.name) + '</div>' +
          '<div class="hn-role">' + esc(e.role) + '</div>' +
        '</div>' +
        '<span class="hn-badge">自动整理</span>' +
      '</div>' +
      '<div class="hn-title">《' + esc(h.title) + '》</div>' +
      '<div class="hn-src">整理自 ' + esc((h.sources || []).join(' · ')) + '，未新增任何事实</div>' +
      '<div class="hn-meta">' +
        '<span>约 ' + Number(h.words || 0).toLocaleString() + ' 字</span>' +
        '<span>发布至 @' + esc(e.name) + ' 的主页 · ' + esc(h.column || '会诊手记') + '</span>' +
        '<span>他一个字都不用写</span>' +
      '</div>' +
      '<div class="fold-head"><span class="arw">▶</span>预览全文</div>' +
      '<div class="fold-body hidden"><div class="hn-excerpt">' + paras + '</div></div>' +
    '</div>';
  }).join('');

  const inner =
    '<div class="notice info" style="margin-bottom:16px"><span class="ic">▸</span><span>' +
      '<b>一次参与 = 一篇内容。</b>会诊结束时，狐看山医生把每位参与者在会诊里说过的话，' +
      '整理成一篇以他为主的内容。这是他们愿意来的原因。' +
    '</span></div>' +
    rows;

  attach(docCard('⑦ 会诊手记', '会诊结束了，四位参与者各自带走了一篇内容', '', inner));

  $$('#stream .fold-head').forEach(head => {
    head.onclick = () => {
      head.classList.toggle('open');
      head.nextElementSibling.classList.toggle('hidden');
    };
  });
}

/* ===========================================================
   我的病例
   =========================================================== */
function loadRecords() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(REC_KEY) || "[]"); } catch (e) { list = []; }
  return list;
}
function updateRecordProgress() {
  if (!S.recordId) return;
  const list = loadRecords();
  const r = list.find(x => x.id === S.recordId);
  if (!r) return;
  r.planDone = S.planDone.slice();
  try { localStorage.setItem(REC_KEY, JSON.stringify(list)); } catch (e) {}
}

function saveRecord() {
  const list = loadRecords();
  S.recordId = "r-" + Date.now();
  list.unshift({
    id: S.recordId,
    createdAt: nowStr(),
    question: S.question,
    dept: S.triage ? S.triage.dept : "职业发展科",
    wound: S.wound,
    title: S.conclusion ? S.conclusion.title : "",
    consensus: S.conclusion && S.conclusion.consensus[0] ? S.conclusion.consensus[0].text : "",
    dissent: S.conclusion && S.conclusion.dissent ? S.conclusion.dissent.text : "",
    plan: S.plan,
    planDone: S.planDone.slice(),
    reviewAt: S.reviewAt,
    status: "随访中",
    by: S.experts.map(e => e.name).join(" · ")
  });
  try { localStorage.setItem(REC_KEY, JSON.stringify(list.slice(0, 30))); } catch (e) {}
}

function renderRecords() {
  const mine = loadRecords();
  const seed = D.seedRecords.map(r => ({
    id: r.id, createdAt: r.createdAt, question: r.question, dept: r.dept,
    consensus: r.summary, status: r.status, title: "", dissent: "", plan: [], by: ""
  }));
  const list = mine.concat(seed);
  const box = $("#recordList");

  if (!list.length) {
    box.innerHTML = '<div class="empty"><div class="big">◍</div>' +
      '<div class="t">还没有病例</div>' +
      '<div class="s">去「诊疗」挂一个号，会诊结束后这里会留下档案。</div></div>';
    return;
  }
  box.innerHTML = '<div class="rec-list">' + list.map(r =>
    '<div class="rec-card" data-id="' + esc(r.id) + '">' +
      '<div class="rec-card-top">' +
        '<div class="rec-q">' + esc(r.question) + '</div>' +
        '<span class="rec-status">' + esc(r.status || "已完成") + '</span>' +
      '</div>' +
      '<div class="rec-meta">' +
        '<span>' + esc(r.dept) + '</span>' +
        '<span>' + esc(r.createdAt) + '</span>' +
        (r.by ? '<span>会诊：' + esc(r.by) + '</span>' : '') +
        (r.reviewAt ? '<span>回访：' + esc(r.reviewAt) + '</span>' : '') +
      '</div>' +
      (r.plan && r.plan.length ? recProgressHTML(r) : '') +
    '</div>').join('') + '</div>';

  $$(".rec-card", box).forEach(card => {
    card.onclick = () => openRecordDetail(card.getAttribute("data-id"), list);
  });
}

/* 档案卡上的执行进度条 */
function recProgressHTML(r) {
  const total = r.plan.length;
  const done = (r.planDone || []).filter(Boolean).length;
  const pct = total ? Math.round(done / total * 100) : 0;
  return '<div class="rec-prog">' +
    '<div class="rec-prog-top"><span>行动清单</span>' +
    '<span class="rec-prog-n">' + done + ' / ' + total + ' 已执行</span></div>' +
    '<div class="rec-prog-bar"><i style="width:' + pct + '%"></i></div>' +
  '</div>';
}

function openRecordDetail(id, list) {
  const r = list.find(x => x.id === id);
  if (!r) return;
  const plan = (r.plan || []).map((p, i) =>
    '<div class="rx-item' + ((r.planDone || [])[i] ? ' done' : '') + '" data-idx="' + i + '">' +
      '<span class="rx-check" role="checkbox" aria-checked="' +
        ((r.planDone || [])[i] ? 'true' : 'false') + '">' +
        '<svg viewBox="0 0 12 12" width="9" height="9"><path d="M2 6.2L4.8 9 10 3.4" ' +
        'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
        'stroke-linejoin="round"/></svg></span>' +
      '<div class="rx-body">' +
        '<div class="rx-when">' + esc(p.when) + '</div>' +
        '<div class="rx-what">' + esc(p.what) + '</div>' +
      '</div>' +
    '</div>').join("");

  const inner =
    '<div class="kv"><span class="k">主诉</span><span class="v">' + esc(r.question) + '</span></div>' +
    (r.wound ? '<div class="kv"><span class="k">确认病灶</span><span class="v">' + esc(r.wound) + '</span></div>' : '') +
    '<div class="kv"><span class="k">科室</span><span class="v">' + esc(r.dept) + '</span></div>' +
    '<div class="kv"><span class="k">时间</span><span class="v">' + esc(r.createdAt) + '</span></div>' +
    (r.consensus ? '<div style="height:14px"></div><div class="sect consensus">' +
      '<span class="sect-label"><span class="dot"></span>核心结论</span>' +
      '<div class="sect-text">' + esc(r.consensus) + '</div></div>' : '') +
    (r.dissent ? '<div class="sect"><span class="sect-label" style="color:var(--red)">' +
      '<span class="dot" style="background:var(--red)"></span>少数意见</span>' +
      '<div class="sect-text" style="color:var(--t2)">' + esc(r.dissent) + '</div></div>' : '') +
    (plan ? '<div style="height:6px"></div><div class="doc-sub" style="margin-bottom:10px">行动清单</div>' +
      '<div class="rx">' + plan + '</div>' : '');

  const box = node('<div class="modal"><div class="modal-box">' +
    '<div class="modal-head"><div class="modal-title">病例档案</div>' +
    '<button class="icon-btn btn-x">✕</button></div>' + inner + '</div></div>');
  document.body.appendChild(box);
  $(".btn-x", box).onclick = () => box.remove();
  box.onclick = e => { if (e.target === box) box.remove(); };

  /* 在档案里勾选，直接写回这条记录 */
  bindPlanChecks(box, (i, on) => {
    const rec = loadRecords().find(x => x.id === id);
    if (!rec) return;
    rec.planDone = rec.planDone || [];
    rec.planDone[i] = on;
    rec.planDone = rec.planDone.slice(0, rec.plan.length);
    try { localStorage.setItem(REC_KEY, JSON.stringify(loadRecords().map(x => x.id === id ? rec : x))); } catch (e) {}
    renderRecords();
  });
}

/* ===========================================================
   视图 / 弹窗
   =========================================================== */
function switchView(v) {
  $$(".view").forEach(x => x.classList.add("hidden"));
  $("#view-" + v).classList.remove("hidden");
  $$(".nav-item").forEach(b => b.classList.toggle("active", b.getAttribute("data-view") === v));
  $("#rail").classList.toggle("hidden", v !== "clinic");
  if (v === "records") renderRecords();
  if (v === "expert") renderExpertClinic();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function openModal(id) { $("#" + id).classList.remove("hidden"); }
function closeModal(id) { $("#" + id).classList.add("hidden"); }

/* ===========================================================
   专家门诊（商业化主路径 · 方案 §11）
   -----------------------------------------------------------
   专家门诊 = 创作者声誉达标后开设的付费咨询，平台与创作者分成。
   本轮是**功能原型**：接单、选时段、计价、分成、出号单的链路全部真跑，
   但专家是演示画像、支付是演示支付 —— 界面上必须把这句话放在看得见的地方，
   不能让任何人误以为产生了真实扣款或真实服务承诺。
   =========================================================== */
const EC = () => D.expertClinic;
const EC_ORDERS_KEY = "zhiliao_expert_orders";

function loadOrders() {
  try { return JSON.parse(localStorage.getItem(EC_ORDERS_KEY) || "[]"); }
  catch (e) { return []; }
}
function saveOrders(list) {
  try { localStorage.setItem(EC_ORDERS_KEY, JSON.stringify(list.slice(0, 20))); } catch (e) {}
}
function money(n) { return "¥" + Number(n).toFixed(0); }

function renderExpertClinic() {
  const ec = EC();
  if (!ec) return;

  /* 免费 / 付费边界 */
  $("#ecFree").innerHTML = ec.freeLine.map(x =>
    '<div class="ec-free-item">' +
      '<span class="ec-free-k">' + esc(x.k) + '</span>' +
      '<span class="ec-free-t">' + esc(x.t) + '</span>' +
      '<span class="ec-free-tag ' + (x.tag === "免费" ? "is-free" : "is-paid") + '">' +
        esc(x.tag) + '</span>' +
    '</div>').join("");

  /* 演示声明 */
  $("#ecNotice").innerHTML = '<b>演示环境</b><span>' +
    esc(ec.notice.replace(/^演示环境\s*·\s*/, "")) + '</span>';

  /* 号别 */
  $("#ecTiers").innerHTML =
    '<div class="ec-block-title">号别与定价</div>' +
    ec.tiers.map(t =>
      '<div class="ec-tier">' +
        '<div class="ec-tier-top"><span class="ec-tier-name">' + esc(t.name) + '</span>' +
        '<span class="ec-tier-price">' + money(t.price) + '</span></div>' +
        '<div class="ec-tier-desc">' + esc(t.desc) + '</div>' +
      '</div>').join("");

  /* 分成 —— 供给端为什么愿意来 */
  const s = ec.split;
  $("#ecSplit").innerHTML =
    '<div class="ec-block-title">平台与创作者分成</div>' +
    '<div class="ec-split-bar">' +
      '<div class="ec-split-seg creator" style="width:' + s.creator + '%">创作者 ' + s.creator + '%</div>' +
      '<div class="ec-split-seg platform" style="width:' + s.platform + '%">平台 ' + s.platform + '%</div>' +
    '</div>' +
    '<div class="ec-split-note">' + esc(s.note) + '</div>' +
    '<div class="ec-split-eg">以主任专家号 ' + money(ec.tiers[1].price) + ' 为例：' +
      '创作者得 <b>' + money(ec.tiers[1].price * s.creator / 100) + '</b>，' +
      '平台得 <b>' + money(ec.tiers[1].price * s.platform / 100) + '</b></div>';

  /* 号源 */
  $("#ecCount").textContent = ec.doctors.length + " 位可约";
  $("#ecList").innerHTML = ec.doctors.map(d => {
    const tier = ec.tiers.find(t => t.id === d.tier) || ec.tiers[0];
    return '<div class="ec-doc">' +
      '<div class="ec-doc-av">' + esc(d.initial) + '</div>' +
      '<div class="ec-doc-main">' +
        '<div class="ec-doc-top">' +
          '<span class="ec-doc-name">' + esc(d.name) + '</span>' +
          '<span class="ec-rep">' + esc(d.rep) + '</span>' +
          '<span class="ec-doc-tier">' + esc(tier.name) + '</span>' +
        '</div>' +
        '<div class="ec-doc-title">' + esc(d.title) + '</div>' +
        '<div class="ec-doc-good">擅长：' + esc(d.good) + '</div>' +
        '<div class="ec-doc-line">「' + esc(d.line) + '」</div>' +
        '<div class="ec-doc-meta">已服务 ' + d.served + ' 人次 · 好评率 ' + d.rate + '% · 可约 ' +
          d.slots.length + ' 个时段</div>' +
      '</div>' +
      '<div class="ec-doc-buy">' +
        '<div class="ec-doc-price">' + money(d.price) + '</div>' +
        '<button class="btn sm" data-book="' + esc(d.id) + '">挂这个号</button>' +
      '</div>' +
    '</div>';
  }).join("");

  $$("[data-book]").forEach(b => {
    b.onclick = () => openBooking(b.getAttribute("data-book"));
  });

  renderMyOrders();
}

function renderMyOrders() {
  const list = loadOrders();
  const wrap = $("#ecMineWrap");
  if (!list.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  $("#ecMine").innerHTML = list.map(o =>
    '<div class="ec-order">' +
      '<div class="ec-order-no">' + esc(o.no) + '</div>' +
      '<div class="ec-order-main">' +
        '<div class="ec-order-top">' + esc(o.doctor) + ' · ' + esc(o.tier) + '</div>' +
        '<div class="ec-order-sub">' + esc(o.slot) + ' · ' + esc(o.question || "未填困惑") + '</div>' +
      '</div>' +
      '<div class="ec-order-price">' + money(o.price) + '</div>' +
    '</div>').join("");
}

/* ---------- 挂号流程 ---------- */
let BKG = null;

function openBooking(id) {
  const ec = EC();
  const d = ec.doctors.find(x => x.id === id);
  if (!d) return;
  const tier = ec.tiers.find(t => t.id === d.tier) || ec.tiers[0];
  BKG = { doctor: d, tier: tier, slot: d.slots[0], paid: false, no: "" };
  $("#bkTitle").textContent = "挂 " + d.name + " 的号";
  $("#bkFoot").textContent = ec.notice;
  renderBooking();
  openModal("modalBooking");
}

function renderBooking() {
  const ec = EC();
  const d = BKG.doctor, tier = BKG.tier, s = ec.split;
  const creatorCut = tier.price * s.creator / 100;
  const platformCut = tier.price * s.platform / 100;

  if (BKG.paid) {
    /* 已支付：出号单 */
    $("#bkBody").innerHTML =
      '<div class="ec-ticket">' +
        '<div class="ec-ticket-head">' +
          '<span class="ec-ticket-no">' + esc(BKG.no) + '</span>' +
          '<span class="ec-ticket-badge">演示号单</span>' +
        '</div>' +
        '<div class="ec-ticket-row"><span>专家</span><b>' + esc(d.name) + ' · ' + esc(d.title) + '</b></div>' +
        '<div class="ec-ticket-row"><span>号别</span><b>' + esc(tier.name) + '　' + money(tier.price) + '</b></div>' +
        '<div class="ec-ticket-row"><span>时段</span><b>' + esc(BKG.slot) + '</b></div>' +
        '<div class="ec-ticket-row"><span>困惑</span><b>' + esc(BKG.question || "（未填）") + '</b></div>' +
        '<div class="ec-ticket-split">本次分成：创作者 <b>' + money(creatorCut) + '</b> ／ 平台 <b>' + money(platformCut) + '</b></div>' +
      '</div>' +
      '<div class="ec-ticket-warn">这是<b>演示号单</b>：没有发生真实扣款，也没有真实专家接单。' +
        '它的作用是让你看到「挂号 → 计价 → 分成 → 出号单」这条链路是怎么跑的。</div>';
    $("#btnPay").textContent = "完成";
    $("#btnPay").onclick = () => closeModal("modalBooking");
    $("#btnBkCancel").classList.add("hidden");
    return;
  }

  $("#btnBkCancel").classList.remove("hidden");
  $("#bkBody").innerHTML =
    '<div class="ec-bk-doc">' +
      '<div class="ec-doc-av">' + esc(d.initial) + '</div>' +
      '<div>' +
        '<div class="ec-doc-top"><span class="ec-doc-name">' + esc(d.name) + '</span>' +
        '<span class="ec-rep">' + esc(d.rep) + '</span></div>' +
        '<div class="ec-doc-title">' + esc(d.title) + '</div>' +
      '</div>' +
    '</div>' +

    '<div class="ec-bk-label">选择时段</div>' +
    '<div class="ec-slots">' + d.slots.map((sl, i) =>
      '<button class="ec-slot' + (i === 0 ? ' on' : '') + '" data-slot="' + esc(sl) + '">' +
        esc(sl) + '</button>').join("") + '</div>' +

    '<div class="ec-bk-label">这次想请专家看什么（可选）</div>' +
    '<input class="ec-input" id="bkQuestion" placeholder="一句话说清你的困惑，专家会带着它先看一遍你的会诊结论书">' +

    '<div class="ec-bk-label">费用明细</div>' +
    '<div class="ec-bill">' +
      '<div class="ec-bill-row"><span>' + esc(tier.name) + '</span><b>' + money(tier.price) + '</b></div>' +
      '<div class="ec-bill-row sub"><span>其中：创作者所得（' + s.creator + '%）</span><b>' + money(creatorCut) + '</b></div>' +
      '<div class="ec-bill-row sub"><span>其中：平台服务费（' + s.platform + '%）</span><b>' + money(platformCut) + '</b></div>' +
      '<div class="ec-bill-row total"><span>应付</span><b>' + money(tier.price) + '</b></div>' +
    '</div>' +
    '<div class="ec-bk-note">' + esc(tier.desc) + '</div>';

  $$("[data-slot]").forEach(b => {
    b.onclick = () => {
      BKG.slot = b.getAttribute("data-slot");
      $$("[data-slot]").forEach(x => x.classList.toggle("on", x === b));
    };
  });
  $("#btnPay").textContent = "确认挂号（演示支付 " + money(tier.price) + "）";
  $("#btnPay").onclick = payBooking;
}

function payBooking() {
  if (BKG.paid) return;
  const q = $("#bkQuestion");
  BKG.question = q ? q.value.trim() : "";
  BKG.paid = true;
  BKG.no = "ZL-" + String(Date.now()).slice(-6);
  const list = loadOrders();
  list.unshift({
    no: BKG.no, doctor: BKG.doctor.name, tier: BKG.tier.name,
    slot: BKG.slot, price: BKG.tier.price, question: BKG.question,
    at: new Date().toISOString()
  });
  saveOrders(list);
  renderBooking();
  renderMyOrders();
}

/* ===========================================================
   设置
   =========================================================== */
function initSettings() {
  const cfg = ZHILIAO_AI.load();
  const sel = $("#aiPreset");
  sel.innerHTML = Object.keys(ZHILIAO_AI.PRESETS)
    .map(k => '<option value="' + k + '">' + ZHILIAO_AI.PRESETS[k].name + '</option>').join("");
  sel.value = cfg.preset || "deepseek";
  $("#aiBase").value = cfg.base || "";
  $("#aiModel").value = cfg.model || "";
  $("#aiKey").value = cfg.key || "";

  setMode(cfg.enabled ? "ai" : "demo", false);
  setSpeedUI(cfg.fast === false ? "slow" : "fast", false);

  $$("#modeSeg button").forEach(b => {
    b.onclick = () => setMode(b.getAttribute("data-mode"), true);
  });
  sel.onchange = () => {
    const p = ZHILIAO_AI.PRESETS[sel.value];
    if (sel.value !== "custom") {
      $("#aiBase").value = p.base;
      $("#aiModel").value = p.model;
    }
  };
  $("#btnPing").onclick = async () => {
    collectAI();
    const out = $("#pingResult");
    if (!ZHILIAO_AI.ready()) { out.textContent = "请先填写接口地址、模型名和 API Key"; out.style.color = "var(--amber)"; return; }
    out.textContent = "测试中…"; out.style.color = "var(--t3)";
    try {
      const r = await ZHILIAO_AI.ping();
      out.textContent = "连接成功：" + r.slice(0, 30);
      out.style.color = "var(--green)";
    } catch (e) {
      out.textContent = "失败：" + e.message.slice(0, 80);
      out.style.color = "var(--red)";
    }
  };
  $$("#speedSeg button").forEach(b => {
    b.onclick = () => setSpeedUI(b.getAttribute("data-speed"), true);
  });
  /* 演示模式开关 */
  const dm = $("#demoToggle");
  if (dm) {
    dm.checked = ZHILIAO_AI.get().demo === true;
    dm.onchange = () => setDemoMode(dm.checked);
  }
  const pb = $("#btnPilot");
  if (pb) pb.onclick = () => { togglePilot(); };
  const de = $("#btnDemoExit");
  if (de) de.onclick = () => {
    stopPilot();
    setDemoMode(false);
    const dm2 = $("#demoToggle");
    if (dm2) dm2.checked = false;
  };

  /* ---------- 知乎官方数据源（v1.7） ---------- */
  const zcfg = ZHILIAO_ZHIHU.load();
  const zt = $("#zhihuToggle");
  const zf = $("#zhihuFields");
  const zs = $("#zhihuSecret");
  if (zt && zf && zs) {
    zt.checked = !!(zcfg.secret && String(zcfg.secret).trim());
    zs.value = zcfg.secret || "";
    zf.classList.toggle("hidden", !zt.checked);
    zt.onchange = () => {
      zf.classList.toggle("hidden", !zt.checked);
      /* 关掉时清空 Secret：界面上写着「已接入」但实际不生效，比没接更糟 */
      ZHILIAO_ZHIHU.set({ secret: zt.checked ? zs.value.trim() : "" });
    };
    zs.onchange = () => ZHILIAO_ZHIHU.set({ secret: zs.value.trim() });
    zs.oninput = () => ZHILIAO_ZHIHU.set({ secret: zs.value.trim() });
  }
  const zp = $("#btnZhihuPing");
  if (zp) {
    zp.onclick = async () => {
      const out = $("#zhihuPingResult");
      ZHILIAO_ZHIHU.set({ secret: (zs ? zs.value : "").trim() });
      if (!ZHILIAO_ZHIHU.ready()) {
        out.textContent = "请先填写 AccessSecret";
        out.style.color = "var(--amber)";
        return;
      }
      out.textContent = "正在检索知乎站内…";
      out.style.color = "var(--t3)";
      try {
        const n = await ZHILIAO_ZHIHU.ping();
        out.textContent = "连接成功：检索返回 " + n + " 条真实讨论";
        out.style.color = "var(--green)";
      } catch (e) {
        out.textContent = "失败：" + String(e && e.message ? e.message : e).slice(0, 90);
        out.style.color = "var(--red)";
      }
    };
  }

  $("#btnClear").onclick = () => {
    if (!confirm("确定清空「我的病例」里的所有记录吗？此操作不可恢复。")) return;
    localStorage.removeItem(REC_KEY);
    renderRecords();
  };
}

function setMode(mode, persist) {
  $$("#modeSeg button").forEach(b => b.classList.toggle("on", b.getAttribute("data-mode") === mode));
  $("#aiFields").classList.toggle("hidden", mode !== "ai");
  $("#modeHint").textContent = mode === "ai"
    ? "会用你配置的大模型实时生成病历、分歧地图、结论书与行动清单。会诊室的参与者证言由模型依据知乎真实讨论编排（Demo 阶段不含真实邀请通道）。"
    : "使用内置的完整演示案例，不需要联网，也不需要任何配置。";
  if (persist) collectAI(true);
  else ZHILIAO_AI.set({ enabled: mode === "ai" });
}

function collectAI(save) {
  const enabled = $("#modeSeg button.on").getAttribute("data-mode") === "ai";
  ZHILIAO_AI.set({
    enabled: enabled,
    preset: $("#aiPreset").value,
    base: $("#aiBase").value.trim(),
    model: $("#aiModel").value.trim(),
    key: $("#aiKey").value.trim()
  });
}

function setSpeedUI(v, persist) {
  $$("#speedSeg button").forEach(b => b.classList.toggle("on", b.getAttribute("data-speed") === v));
  speed = v === "slow" ? 1.5 : 0.7;
  if (persist) ZHILIAO_AI.set({ fast: v !== "slow" });
}

/* ===========================================================
   启动
   =========================================================== */
document.addEventListener("DOMContentLoaded", () => {
  const boot = document.querySelector('#boot');
  if (boot) boot.remove();

  /* 启动兜底：任何脚本错误都让人看得见，而不是白屏 */
  window.addEventListener('error', ev => {
    showFatal('启动出错：' + (ev.message || '未知错误'));
  });

  initSettings();
  setDemoMode(ZHILIAO_AI.get().demo === true);
  start();
  renderRecords();

  /* ---------- ?demo=1：打开就自动播放 ----------
     给评委的链接可以带上这个参数，省掉「先找到按钮、再点一下」这一步。
     只认 demo=1 这一个写法，避免误触发。 */
  if (/(^|[?&])demo=1(&|$)/.test(String(location.search || ''))) {
    setTimeout(() => {
      const wd = document.querySelector('#btnWatchDemo');
      if (wd) wd.classList.add('hidden');
      startPilot();
    }, 1800);
  }

  $$(".nav-item").forEach(b => {
    b.onclick = () => switchView(b.getAttribute("data-view"));
  });
  $("#btnPay").onclick = payBooking;
  renderExpertClinic();
  $("#btnSettings").onclick = () => openModal("modalSettings");
  $("#btnHelp").onclick = () => openModal("modalHelp");
  $("#btnNewCase").onclick = () => { switchView("clinic"); start(); };
  $("#btnSkip").onclick = () => {
    skipping = true;
    $("#btnSkip").classList.add("hidden");
  };

  $$("[data-close]").forEach(b => {
    b.onclick = () => closeModal(b.getAttribute("data-close"));
  });
  $$(".modal").forEach(m => {
    m.onclick = e => { if (e.target === m) m.classList.add("hidden"); };
  });
  /* ---------------- 现场演示快捷键 ----------------
     全部用单键，且不依赖任何浏览器插件；输入框里打字时不触发。
     P 自动演示 / 空格 暂停或跳过等待 / R 重置 / Esc 关浮层
     （Cmd+Shift+K 保留为跳过等待的备用键） */
  document.addEventListener("keydown", e => {
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    const inField = tag === "INPUT" || tag === "TEXTAREA";

    if (e.key === "Escape") {
      $$(".modal").forEach(m => m.classList.add("hidden"));
      stopPilot();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
      skipping = true;
      $("#btnSkip").classList.add("hidden");
      return;
    }
    if (inField || e.metaKey || e.ctrlKey || e.altKey) return;

    const k = e.key.toLowerCase();
    if (k === "p") { e.preventDefault(); togglePilot(); return; }
    if (k === "r") { e.preventDefault(); resetDemo(); return; }
    if (e.key === " ") {
      e.preventDefault();
      if (pilotOn) { paused = !paused; updatePilotHint(); }
      else { skipping = true; $("#btnSkip").classList.add("hidden"); }
    }
  });
});
