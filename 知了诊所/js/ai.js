/* ===========================================================
   知了诊所 · 可选的真实 AI 接入
   -----------------------------------------------------------
   默认不需要这个文件里的任何东西——演示模式可以直接跑通。
   如果你想让它真的"思考"，在右上角「设置」里选「接入真实 AI」，
   填上任意一家大模型的 API Key 即可。

   为安全起见：Key 只保存在你自己浏览器的本地存储里，不会上传到任何地方。
   =========================================================== */

const ZHILIAO_AI = (() => {

  const CFG_KEY = 'zhiliao_ai_config';

  const PRESETS = {
    deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    zhipu: { name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    moonshot: { name: '月之暗面 Kimi', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    qwen: { name: '阿里通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    openai: { name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    custom: { name: '自定义（OpenAI 兼容）', base: '', model: '' }
  };

  let config = {
    enabled: false,
    preset: 'deepseek',
    base: PRESETS.deepseek.base,
    model: PRESETS.deepseek.model,
    key: '',
    fast: true
  };

  function load() {
    try {
      const raw = localStorage.getItem(CFG_KEY);
      if (raw) config = Object.assign(config, JSON.parse(raw));
    } catch (e) { /* 忽略损坏的配置 */ }
    return config;
  }

  function save() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(config)); } catch (e) {}
  }

  function get() { return config; }

  function set(patch) {
    Object.assign(config, patch);
    if (patch.preset && PRESETS[patch.preset] && patch.preset !== 'custom') {
      config.base = PRESETS[patch.preset].base;
      config.model = PRESETS[patch.preset].model;
    }
    save();
    return config;
  }

  function ready() {
    return config.enabled && config.key && config.base && config.model;
  }

  function stripJson(text) {
    let s = String(text || '').trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    if (i >= 0 && j > i) s = s.slice(i, j + 1);
    return s;
  }

  async function chat(messages, opts) {
    opts = opts || {};
    if (!ready()) throw new Error('未配置 AI');
    const url = config.base.replace(/\/+$/, '') + '/chat/completions';

    /* 超时保护：网络不通或服务商无响应时，必须能自己断开，
       否则申请人会永远卡在「正在会诊…」上。 */
    const ms = opts.timeout || 90000;
    const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + config.key
        },
        signal: ctl ? ctl.signal : undefined,
        body: JSON.stringify({
          model: config.model,
          messages: messages,
          temperature: opts.temperature === undefined ? 0.7 : opts.temperature,
          max_tokens: opts.maxTokens || 1600,
          response_format: opts.json ? { type: 'json_object' } : undefined
        })
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e && e.name === 'AbortError') {
        throw new Error('等待超过 ' + Math.round(ms / 1000) + ' 秒仍未响应，已断开');
      }
      /* 最常见的两种：地址写错（DNS 失败）、跨域被浏览器拦截 */
      throw new Error('连不上接口：' + (e && e.message ? e.message : '网络错误')
        + '（请检查接口地址是否正确、是否允许跨域）');
    }
    if (timer) clearTimeout(timer);

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('接口返回 ' + res.status + '：' + t.slice(0, 180));
    }
    const data = await res.json();
    const content = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('接口没有返回内容');
    return content;
  }

  async function json(messages, opts) {
    const raw = await chat(messages, Object.assign({ json: true }, opts));
    return JSON.parse(stripJson(raw));
  }

  const SYS = '你是知了诊所的主诊医生「狐看山医生」的推理内核。'
    + '知了诊所把一个人的困惑当作一例病例，走完整的会诊流程。'
    + '你的原则：不做泛泛而谈的摘要，要识别「分歧」；不替用户下断言，要给候选假设；'
    + '不给空泛道理，要指向可执行的下一步。全程使用简体中文。';

  /* ---------- 分诊 + 病历首页 ---------- */
  async function chart(question, answers) {
    const qa = (answers || []).map(a => '问：' + a.q + '\n答：' + a.a).join('\n');
    const out = await json([
      { role: 'system', content: SYS },
      {
        role: 'user', content:
          '委托人挂号的主诉：' + question + '\n\n问诊记录：\n' + qa + '\n\n'
          + '请输出 JSON，字段如下：\n'
          + '{\n'
          + '  "dept": "科室名（如 职业发展科/职业转型科/升学规划科/家庭与心理科）",\n'
          + '  "tag": "并发症短语，不超过 10 字",\n'
          + '  "chief": "提炼后的主诉，不超过 30 字",\n'
          + '  "history": "现病史，一句话",\n'
          + '  "variables": ["关键变量1","关键变量2","关键变量3"],\n'
          + '  "hypotheses": [\n'
          + '    {"label":"假设名，不超过 10 字","level":"high|mid|low",'
          + '"levelText":"较可能|可能|较弱","desc":"这个假设的具体解释，40-70 字，要具体、不说套话"}\n'
          + '  ]\n'
          + '}\n'
          + '要求：hypotheses 恰好 3 条，按可能性从高到低。第一条要是「真正卡住他的那个问题」，'
          + '而不是他表面问的那个问题。'
      }
    ], { temperature: 0.6 });
    return out;
  }

  /* ---------- 分歧地图（争议检测）+ 三档判定 ----------
     一次调用同时产出三条分支各自需要的内容。这样做的原因：
     判定结果决定了后面走哪条流程，如果内容和判定分两次拿，
     就可能出现「判定为已确诊，给出的却是分歧清单」这种错位。
     current 之外的三组字段，只填 current 对应的那一组，其余留空。 */
  async function disputes(question, wound, corpus) {
    /* corpus：接入知乎开放平台后，这里是从站内真实检索到的讨论。
       带上它，模型就是在「真实的社区内容」上做判断，而不是凭印象编。 */
    const realText = (corpus && corpus.items && corpus.items.length)
      ? '【真实检索结果】以下是从知乎站内检索到的 ' + corpus.items.length + ' 条讨论，'
        + '请**只基于这些内容**判断结论收敛程度与观点分布，不要引入这之外的印象：\n'
        + corpus.items.map((it, i) =>
            (i + 1) + '. 《' + (it.title || '(无标题)') + '》'
            + '　赞同 ' + (it.vote || 0)
            + (it.comment ? ' · 评论 ' + it.comment : '')
            + (it.author ? '　作者 ' + it.author : '')
            + (it.authority ? '　权威等级 ' + it.authority : '')
            + (it.excerpt ? '\n   摘要：' + String(it.excerpt).slice(0, 120) : '')
          ).join('\n')
      : '【无真实检索】这次没有接入知乎开放平台，请基于你对该话题的普遍了解来模拟。';

    const out = await json([
      { role: 'system', content: SYS },
      {
        role: 'user', content:
          '病例主诉：' + question + '\n已确认的病灶：' + wound + '\n\n'
          + realText + '\n\n'
          + '请对上述讨论做「争议检测」，先判定结论收敛程度，再给出与该判定匹配的内容。\n'
          + '输出 JSON：\n'
          + '{\n'
          + '  "topic": "会诊议题，一句话",\n'
          + '  "corpus": 数字（模拟检索到的讨论篇数，800-3000）,\n'
          + '  "current": "settled|dispute|insufficient",\n'
          + '  "conclusion": "一句判定结论，不带书名号",\n'
          + '  "disputes": [ {"name":"争议点，不超过 20 字","level":"hi|mid|lo",'
          + '"levelText":"分歧程度：高|中|低","bar":0-100 的整数,'
          + '"clusters":[{"title":"观点簇立场","meta":"如 342 赞均 · 128 篇"}]} ],\n'
          + '  "consensus": [ {"name":"已有共识的要点，不超过 22 字","support":"高|中","bar":0-100,'
          + '"meta":"如 486 赞均 · 317 篇"} ],\n'
          + '  "sparse": [ {"name":"仅有零散讨论的角度，不超过 22 字","levelText":"相关性：低","bar":0-40,'
          + '"meta":"如 仅 3 篇 · 无高赞"} ],\n'
          + '  "plan": [ {"when":"第 1 个月","what":"具体动作，可执行、不空泛"} ],\n'
          + '  "planNote": "回访提示，一句话",\n'
          + '  "draft": {"title":"重新组织后的问题标题，一句话",'
          + '"lead":"为什么原问题问不到点子上，一句话",'
          + '"body":"一份可直接发布的提问正文，3 段，要交代背景、已尝试过什么、具体想得到什么帮助",'
          + '"why":["这样问更容易得到回答的理由，3 条，每条不超过 25 字"],'
          + '"button":"复制草稿去知乎提问"}\n'
          + '}\n'
          + '填写规则（必须遵守）：\n'
          + '· current = "dispute"：disputes 恰好 3 条，第一条约对立最严重，每条 1-2 个观点簇；'
          + 'consensus / sparse 留空数组，draft 留空对象。\n'
          + '· current = "settled"：consensus 恰好 3 条（社区已有定论的内容）；'
          + 'plan 恰好 4 条（when 依次为「第 1 个月」「第 2 个月」「第 3 个月」「第 6 个月」），'
          + 'planNote 写一句回访提示；disputes / sparse 留空数组，draft 留空对象。\n'
          + '· current = "insufficient"：sparse 恰好 3 条（这是存量内容稀疏的证据）；'
          + 'draft 必须完整填写；disputes / consensus 留空数组。\n'
          + '诚实原则：如果这个问题在知乎确实早有定论，就判 settled；'
          + '不要为了显得有价值而把有定论的问题说成有分歧。\n'
          + '如果给了你【真实检索结果】，那么 corpus 要等于真实条数，'
          + '观点簇的 meta 要用真实条目里的赞同数与作者名，不许编造数字。'
      }
    ], { temperature: 0.6, maxTokens: 2800 });
    return out;
  }

  /* ---------- 结论书 + 行动清单 ---------- */
  async function conclusion(payload) {
    const out = await json([
      { role: 'system', content: SYS },
      {
        role: 'user', content:
          '下面是知了诊所一场会诊的全部材料：\n'
          + JSON.stringify(payload, null, 2) + '\n\n'
          + '请整理成会诊结论书，输出 JSON：\n'
          + '{\n'
          + '  "title": "结论书标题，不含书名号",\n'
          + '  "consensus": [{"text":"共识，一句话，具体可验证","src":"如 3/4 位参与者一致"}],\n'
          + '  "dispute": "存留的分歧，一句话",\n'
          + '  "dissent": {"author":"保留意见者姓名","role":"身份","text":"他的反对理由，100-160 字"},\n'
          + '  "plan": [{"when":"第 1 个月","what":"具体动作，要可执行、不空泛"}],\n'
          + '  "planNote": "回访提示，一句话"\n'
          + '}\n'
          + '要求：consensus 恰好 3 条；plan 恰好 4 条（第 1/2/3/6 个月）；'
          + 'dissent 必须来自材料里真实表达过异议的参与者，不能虚构。'
      }
    ], { temperature: 0.5, maxTokens: 2000 });
    return out;
  }

  /* ---------- 连通性测试 ---------- */
  async function ping() {
    const r = await chat([
      { role: 'system', content: '你是知了诊所的狐看山医生。' },
      { role: 'user', content: '用一句话向一位刚挂号的大学生打招呼，不超过 25 字。' }
    ], { maxTokens: 60 });
    return String(r).trim();
  }

  return { PRESETS, load, get, set, ready, chat, json, chart, disputes, conclusion, ping };
})();

/* -----------------------------------------------------------
   ⚠️ 必须显式挂到 window 上，否则真实 AI 会被静默跳过。

   顶层 `const` 声明只进「全局词法环境」，**不会成为 window 的属性**。
   而 app.js 里四处真实 AI 调用的守卫写的是 `window.ZHILIAO_AI && ...`，
   于是条件永远为假：用户填了 Key、点了「接入真实 AI」、连「测试连接」
   都是成功的（那里用的是裸标识符），一走到流程却继续用内置剧本，
   界面上还看不出任何异常。

   这个坑的可怕之处在于：默认路径（演示模式）本来就是对的，
   所以不主动去验证真实 AI 这条路，永远发现不了。
   ----------------------------------------------------------- */
if (typeof window !== 'undefined') window.ZHILIAO_AI = ZHILIAO_AI;
