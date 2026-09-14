/* ===========================================================
   知了诊所 · 流程驱动脚本（测试专用，不属于交付物）
   -----------------------------------------------------------
   verify.sh 会把它注入到「应用副本」的 index.html 里，
   然后用 URL hash 控制自动跑到第几步停下，便于逐阶段截图。

   用法：index.html#6   → 自动跑到会诊室并停下
        index.html#9   → 跑到完成态
        index.html#10  → 完成后再打开「我的病例」
        index.html#11  → 完成后再打开「设置」

   ⚠️ 两个必须知道的坑：
   1. 应用里的 window.scrollTo 带 behavior:'smooth'，在无头虚拟时间下
      会把视口滚到文档外，截出来是纯背景色。所以开头就把它覆盖成空函数。
   2. --screenshot 只截视口，不截整页。后面的卡片要看就得把 window-size 调高。
   =========================================================== */
(function () {
  window.scrollTo = function () {};
  window.scroll = function () {};

  const T = parseInt((location.hash || '').replace('#', ''), 10) || 0;
  if (!T) return;

  const W = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, t) => {
    const s = Date.now();
    while (Date.now() - s < (t || 30000)) {
      if (fn()) return true;
      await W(50);
    }
    return false;
  };
  const last = sel => {
    const a = [...document.querySelectorAll(sel)];
    return a[a.length - 1];
  };
  const pin = () => { document.scrollingElement.scrollTop = 0; };

  (async () => {
    try {
      /* ── v1.7 验证：知乎开放平台接入 ──
         用伪造的 fetch 冒充知乎接口与 AI 接口，验证两件事：
         T=60 只接知乎（没有 AI）→ 应如实展示原始检索结果，不假装做过聚类
         T=61 知乎 + AI 都有 → 真实检索结果应当被送进模型，判定基于真实条数 */
      if (T === 60 || T === 61) {
        const ZHIHU_ITEMS = [
          { Title: '测试用真实讨论一·学历到底卡在哪一步', ContentType: 'answer', VoteUpCount: 3421,
            CommentCount: 188, Author: { Name: '测试作者甲' }, AuthorityLevel: 'L4', Excerpt: '摘要一' },
          { Title: '测试用真实讨论二·非科班也能进', ContentType: 'answer', VoteUpCount: 1876,
            CommentCount: 92, Author: { Name: '测试作者乙' }, AuthorityLevel: 'L3', Excerpt: '摘要二' },
          { Title: '测试用真实讨论三·我更看重项目经历', ContentType: 'article', VoteUpCount: 964,
            CommentCount: 51, Author: { Name: '测试作者丙' }, AuthorityLevel: 'L4', Excerpt: '摘要三' },
          { Title: '测试用真实讨论四·还是老老实实考研吧', ContentType: 'answer', VoteUpCount: 612,
            CommentCount: 77, Author: { Name: '测试作者丁' }, AuthorityLevel: 'L2', Excerpt: '摘要四' },
          { Title: '测试用真实讨论五·三条路我都走过', ContentType: 'answer', VoteUpCount: 233,
            CommentCount: 28, Author: { Name: '测试作者戊' }, AuthorityLevel: 'L3', Excerpt: '摘要五' }
        ];

        window.fetch = function (url, opts) {
          const u = String(url);

          if (u.indexOf('zhihu_search') >= 0) {
            return Promise.resolve({
              ok: true,
              json: function () {
                return Promise.resolve({ Code: 0, Message: 'success', Data: { Items: ZHIHU_ITEMS } });
              }
            });
          }

          if (u.indexOf('chat/completions') >= 0) {
            const body = JSON.parse((opts && opts.body) || '{}');
            const text = JSON.stringify(body.messages || []);
            let payload;
            if (text.indexOf('争议检测') >= 0) {
              /* 争议检测：把真实条数如实回填，用来证明真实数据确实被送进来了 */
              payload = { topic: 'AI 基于真实讨论生成的议题', corpus: 5, current: 'dispute',
                conclusion: 'AI 判定：存在真实分歧（基于检索到的真实讨论）',
                disputes: [
                  { name: 'AI 聚类出的争议甲', level: 'hi', levelText: '分歧程度：高', bar: 82,
                    clusters: [{ title: '观点簇一', meta: '测试作者甲 3421 赞' }] },
                  { name: 'AI 聚类出的争议乙', level: 'mid', levelText: '分歧程度：中', bar: 55,
                    clusters: [{ title: '观点簇二', meta: '测试作者乙 1876 赞' }] },
                  { name: 'AI 聚类出的争议丙', level: 'low', levelText: '分歧程度：低', bar: 30,
                    clusters: [{ title: '观点簇三', meta: '测试作者丙 964 赞' }] }
                ],
                consensus: [], sparse: [], draft: {}, plan: [], planNote: '' };
            } else {
              payload = { dept: '职业发展科', tag: '测试', chief: '测试主诉', history: '测试病史',
                variables: ['甲', '乙', '丙'],
                hypotheses: [
                  { label: '假设一', level: 'high', levelText: '较可能', desc: '说明一。' },
                  { label: '假设二', level: 'mid', levelText: '可能', desc: '说明二。' },
                  { label: '假设三', level: 'low', levelText: '较弱', desc: '说明三。' }
                ] };
            }
            return Promise.resolve({
              ok: true,
              json: function () {
                return Promise.resolve({ choices: [{ message: { content: JSON.stringify(payload) } }] });
              }
            });
          }

          return Promise.reject(new Error('unexpected fetch: ' + u));
        };

        ZHILIAO_ZHIHU.set({ secret: 'test_secret_for_verify' });
        if (T === 61) {
          ZHILIAO_AI.set({ enabled: true, preset: 'custom',
            base: 'https://fake.local/v1', model: 'fake-model', key: 'sk-test' });
        } else {
          ZHILIAO_AI.set({ enabled: false });
        }

        await until(() => document.querySelector('.chip.ex'));
        await W(300);
        document.querySelector('.chip.ex').click();
        await W(200);
        document.querySelector('#btnReg').click();
        await W(3000);
        for (let i = 0; i < 2; i++) {
          await until(() => {
            const b = last('.bubble');
            return b && b.querySelector('.chip.ans');
          });
          await W(600);
          last('.bubble').querySelectorAll('.chip.ans')[0].click();
          await W(1400);
        }
        await until(() => document.querySelector('.hypo'));
        await W(600);
        document.querySelector('.hypo').click();
        await W(250);
        await until(() => {
          const b = document.querySelector('#btnConfirm');
          return b && !b.disabled;
        });
        document.querySelector('#btnConfirm').click();
        await until(() => document.querySelector('.triage'), 60000);
        await W(2000);
        const cards = document.querySelectorAll('#stream .doc-card');
        const target = cards[cards.length - 1];
        if (target && target.parentElement) {
          let el = target.parentElement.firstElementChild;
          while (el && el !== target) {
            const nx = el.nextElementSibling;
            el.style.display = 'none';
            el = nx;
          }
        }
        await W(500);
        return;
      }

      /* ── v1.5 验证：真实 AI 接不通 / 接通了但判定不同 ──
         T=50：把接口地址指向一个不可达的地方。要求是：
               必须出现「可见的」降级提示，并且流程不能卡死。
               （只写 console.warn 不算 —— 用户看不见就等于没说）
         T=51：伪造一个「能连上的真实 AI」，让它在争议检测这一步判定
               「已确诊」。而首页第一个示例靠关键词匹配本来会走会诊。
               要求是：流程必须改走已确诊分支，且内容来自这个假 AI。 */
      if (T === 50 || T === 51) {
        if (T === 51) {
          let n = 0;
          window.fetch = function () {
            n += 1;
            const payload = n === 1
              ? { dept: '职业发展科', tag: '测试用', chief: '测试用主诉', history: '测试用病史',
                  variables: ['变量甲', '变量乙', '变量丙'],
                  hypotheses: [
                    { label: '假设一', level: 'high', levelText: '较可能', desc: '第一候选病灶的说明文字。' },
                    { label: '假设二', level: 'mid', levelText: '可能', desc: '第二候选病灶的说明文字。' },
                    { label: '假设三', level: 'low', levelText: '较弱', desc: '第三候选病灶的说明文字。' }
                  ] }
              : { topic: '测试用议题', corpus: 1680, current: 'settled',
                  conclusion: '测试：这个话题社区早有共识。',
                  consensus: [
                    { name: '模型给出的共识甲', support: '高', bar: 92, meta: '500 赞均 · 300 篇' },
                    { name: '模型给出的共识乙', support: '高', bar: 88, meta: '420 赞均 · 260 篇' },
                    { name: '模型给出的共识丙', support: '中', bar: 80, meta: '310 赞均 · 180 篇' }
                  ],
                  disputes: [], sparse: [], draft: {},
                  plan: [
                    { when: '第 1 个月', what: '模型给出的第一个动作' },
                    { when: '第 2 个月', what: '模型给出的第二个动作' },
                    { when: '第 3 个月', what: '模型给出的第三个动作' },
                    { when: '第 6 个月', what: '模型给出的第四个动作' }
                  ],
                  planNote: '模型给出的回访提示' };
            return Promise.resolve({
              ok: true,
              json: function () {
                return Promise.resolve({ choices: [{ message: { content: JSON.stringify(payload) } }] });
              }
            });
          };
        }
        ZHILIAO_AI.set({
          enabled: true,
          preset: 'custom',
          base: T === 51 ? 'https://fake.local/v1' : 'https://127.0.0.1:1/v1',
          model: T === 51 ? 'fake-model' : 'unreachable-model',
          key: 'sk-test'
        });

        /* 用第一个示例：它本来是「会诊」分支，正好当对照组 */
        await until(() => document.querySelector('.chip.ex'));
        await W(300);
        document.querySelector('.chip.ex').click();
        await W(200);
        document.querySelector('#btnReg').click();
        await W(3000);
        for (let i = 0; i < 2; i++) {
          await until(() => {
            const b = last('.bubble');
            return b && b.querySelector('.chip.ans');
          });
          await W(600);
          last('.bubble').querySelectorAll('.chip.ans')[0].click();
          await W(1400);
        }
        await until(() => document.querySelector('.hypo'));
        await W(600);
        document.querySelector('.hypo').click();
        await W(250);
        await until(() => {
          const b = document.querySelector('#btnConfirm');
          return b && !b.disabled;
        });
        document.querySelector('#btnConfirm').click();

        if (T === 51) {
          /* 已确诊分支应当一路走到完成态 */
          await until(() => document.querySelector('.done-card'), 90000);
          await W(1500);
          const cards = document.querySelectorAll('#stream .doc-card');
          const target = cards[cards.length - 3];   /* 倒数第二张是行动清单，再往前是结论 */
          if (target) {
            let el = target.parentElement.firstElementChild;
            while (el && el !== target) {
              const nx = el.nextElementSibling;
              el.style.display = 'none';
              el = nx;
            }
          }
          await W(500);
          return;
        }

        /* T=50：等降级发生并渲染出分歧地图 */
        await until(() => document.querySelector('.triage'), 60000);
        await W(1500);
        const c50 = document.querySelectorAll('#stream .doc-card');
        const t50 = c50[c50.length - 1];
        if (t50) {
          let el = t50.parentElement.firstElementChild;
          while (el && el !== t50) {
            const nx = el.nextElementSibling;
            el.style.display = 'none';
            el = nx;
          }
        }
        await W(500);
        return;
      }

      /* ── T=31 自动演示：按 P 让应用自己走完全流程 ── */
      if (T === 31) {
        await until(() => document.querySelector('#qInput'));
        await W(400);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
        await until(() => document.querySelector('.done-card'), 180000);
        await W(1200);
        return;
      }

      /* ── T=30 一键重置：先走到分歧地图，再按 R，检查有没有残留 ── */
      if (T === 30) {
        await until(() => document.querySelector('.chip.ex'));
        await W(300);
        document.querySelector('.chip.ex').click();
        await W(250);
        document.querySelector('#btnReg').click();
        await W(3000);
        for (let i = 0; i < 2; i++) {
          await until(() => {
            const b = last('.bubble');
            return b && b.querySelector('.chip.ans');
          });
          await W(600);
          last('.bubble').querySelectorAll('.chip.ans')[0].click();
          await W(1400);
        }
        await until(() => document.querySelector('.hypo'));
        await W(600);
        document.querySelector('.hypo').click();
        await W(250);
        document.querySelector('#btnConfirm').click();
        await W(5000);
        /* 走到这里应该已经能看到分歧地图了，现在按 R 重置 */
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
        await W(2500);
        return;
      }

      /* ── 分支验证：T=20 走「已确诊」示例，T=21 走「信息不足」示例 ── */
      if (T === 20 || T === 21) {
        const idx = T - 19;   /* 20 → 第 2 个示例；21 → 第 3 个示例 */
        await until(() => document.querySelectorAll('.chip.ex').length >= 3);
        await W(300);
        document.querySelectorAll('.chip.ex')[idx].click();
        await W(250);
        document.querySelector('#btnReg').click();
        await W(3000);
        for (let i = 0; i < 2; i++) {
          await until(() => {
            const b = last('.bubble');
            return b && b.querySelector('.chip.ans');
          });
          await W(600);
          last('.bubble').querySelectorAll('.chip.ans')[0].click();
          await W(1400);
        }
        await until(() => document.querySelector('.hypo'));
        await W(600);
        document.querySelector('.hypo').click();
        await W(250);
        document.querySelector('#btnConfirm').click();
        await W(7000);
        /* 截图只认最初视口，把目标卡片之前的节点隐藏，让它落到页顶 */
        /* 倒数第一张是行动清单，倒数第二张才是这条分支的产出卡 */
        const cards = document.querySelectorAll('#stream .doc-card');
        const target = cards[cards.length - 2];
        let el = target.parentElement.firstElementChild;
        while (el && el !== target) {
          const nx = el.nextElementSibling;
          el.style.display = 'none';
          el = nx;
        }
        await W(500);
        return;
      }

      /* ── v1.12 验证：专家门诊（商业化 · 方案 §11） ──
         T=70 打开列表   T=71 挂号面板   T=72 演示支付后的号单
         这条路径不走会诊流程，直接从顶栏进入。 */
      if (T >= 70 && T <= 72) {
        await until(() => document.querySelector('.nav-item[data-view="expert"]'), 20000);
        document.querySelector('.nav-item[data-view="expert"]').click();
        await W(500);
        const boot = document.getElementById('boot');
        if (boot) boot.style.display = 'none';
        if (T >= 71) {
          const b = document.querySelector('[data-book]');
          if (b) b.click();
          await W(500);
          if (T === 72) {
            const slots = document.querySelectorAll('.ec-slot');
            if (slots[1]) slots[1].click();
            const pay = document.getElementById('btnPay');
            if (pay) pay.click();
            await W(500);
          }
        }
        pin();
        return;
      }

      /* ── 1. 首页：点示例困惑 → 挂号 ───────────────────── */
      await until(() => document.querySelector('.chip.ex'));
      await W(300);
      document.querySelector('.chip.ex').click();
      await W(200);
      document.querySelector('#btnReg').click();
      await W(3000);
      pin(); await W(400);
      if (T <= 2) return;

      /* ── 2. 问诊：两个追问各点第一个快捷回答 ───────────── */
      for (let i = 0; i < 2; i++) {
        await until(() => {
          const b = last('.bubble');
          return b && b.querySelector('.chip.ans');
        });
        await W(600);
        last('.bubble').querySelectorAll('.chip.ans')[0].click();
        await W(1400);
      }
      await until(() => document.querySelector('.hypo'));
      await W(800);
      pin(); await W(400);
      if (T <= 3) return;

      /* ── 3. 病灶确认 ─────────────────────────────────── */
      document.querySelector('.hypo').click();
      await W(250);
      document.querySelector('#btnConfirm').click();
      await W(4000);
      pin(); await W(400);
      if (T <= 4) return;

      /* ── 4. 分歧地图 + 会诊邀请 ───────────────────────── */
      await until(() => document.querySelector('#btnStartRoom'), 45000);
      await W(800);
      pin(); await W(400);
      if (T <= 5) return;

      /* ── 5. 会诊室：开始 → 跳过等待 ───────────────────── */
      document.querySelector('#btnStartRoom').click();
      await W(1200);
      document.querySelector('#btnSkip').click();
      await W(4000);
      pin(); await W(400);
      if (T <= 6) return;

      /* ── 6. 等合议结束 → 查看结论书 ───────────────────── */
      await until(() => {
        const b = document.querySelector('#btnRoomNext');
        return b && !b.disabled;
      }, 90000);
      await W(800);
      pin(); await W(400);
      if (T <= 7) return;

      document.querySelector('#btnRoomNext').click();
      await until(() => document.querySelector('.concl-title'), 60000);
      await W(1800);
      pin(); await W(400);
      if (T <= 8) return;

      /* ── 7. 发布结论 → 行动清单 → 完成态 ─────────────── */
      document.querySelector('#btnPublish').click();
      await until(() => document.querySelector('.done-card'), 40000);
      await W(1500);
      pin(); await W(400);
      if (T <= 9) return;

      if (T === 12) {
        const head = document.querySelectorAll('#stream .fold-head')[0];
        head.click();
        await W(600);
        /* 无头截图只认最初的视口，程序化滚动不会生效。
           所以改用「把前面的卡片临时隐藏」的方式，让目标卡片落到页面顶部。 */
        const card = head.closest('.doc-card');
        if (card && card.parentElement) {
          let el = card.parentElement.firstElementChild;
          while (el && el !== card) {
            const next = el.nextElementSibling;
            el.style.display = 'none';
            el = next;
          }
        }
        await W(500);
        return;
      }
      /* ── T=40 勾选行动清单进度 → 切到「我的病例」看有没有写回 ── */
      if (T === 40) {
        const items = document.querySelectorAll('#stream .rx-item');
        if (items.length >= 2) {
          items[0].click();
          await W(300);
          items[1].click();
          await W(500);
        }
        document.querySelector('.nav-item[data-view="records"]').click();
        await W(1500);
        return;
      }

      if (T === 10) {
        document.querySelector('.nav-item[data-view="records"]').click();
        await W(800);
        return;
      }
      if (T === 11) {
        document.querySelector('.topbar-right .icon-btn:last-child').click();
        await W(800);
        return;
      }
    } catch (e) {
      /* 出错时写进 title，verify.sh 会用 --dump-dom 检出来 */
      document.title = 'ERR: ' + e.message;
    }
  })();
})();
