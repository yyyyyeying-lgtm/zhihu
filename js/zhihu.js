/* ===========================================================
   知了诊所 · 知乎数据开放平台接入（可选）
   -----------------------------------------------------------
   填上 AccessSecret 之后，分歧地图会用**真实的知乎站内讨论**，
   而不是内置示例语料。这是本项目「与知乎生态契合度」最实的一块。

   为什么纯静态应用可以直接调、不需要后端：
   实测 developer.zhihu.com 的预检返回
     access-control-allow-origin: *     （允许跨域）
     access-control-allow-headers: Authorization, X-Request-Timestamp, Content-Type
   所以浏览器可以直连。前提是请求不要带 credentials（我们用的是 Bearer，不带 cookie）。

   ⚠️ 两个容易踩的坑：
   1. X-Request-Timestamp 是**必传**的秒级时间戳，漏了直接 401
   2. 业务错误藏在 body 里（HTTP 200 但 Code=20001 表示鉴权失败），
      只看 res.ok 会误判成功

   申请入口：https://developer.zhihu.com/profile
   （需实名认证后才给 1000 次/天免费额度，未实名只有 10 次/天）
   =========================================================== */

const ZHILIAO_ZHIHU = (() => {

  const CFG_KEY = 'zhiliao_zhihu_config';
  const BASE = 'https://developer.zhihu.com';
  const MAX_COUNT = 10;   /* 站内搜索单次最多返回 10 条 */

  let config = { secret: '' };

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
    save();
    return config;
  }

  function ready() {
    return !!(config.secret && String(config.secret).trim());
  }

  function headers() {
    return {
      'Authorization': 'Bearer ' + String(config.secret).trim(),
      'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
      'Content-Type': 'application/json'
    };
  }

  /* ---------- 容错解析 ----------
     官方返回结构可能调整，字段名也可能有大小写差异。
     这里做多写法兼容，避免一改结构就整条链路失效。 */
  function pick(obj, keys) {
    for (let i = 0; i < keys.length; i++) {
      const v = obj ? obj[keys[i]] : undefined;
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  function itemsOf(data) {
    if (!data) return [];
    const d = (data.Data !== undefined) ? data.Data
      : (data.data !== undefined) ? data.data : data;
    if (Array.isArray(d)) return d;
    const arr = pick(d, ['Items', 'items', 'List', 'list', 'Results', 'results', 'Data', 'data']);
    return Array.isArray(arr) ? arr : [];
  }

  function codeOf(data) {
    return pick(data, ['Code', 'code', 'ErrCode', 'errcode']);
  }

  /* 把官方条目转成应用内部统一结构 */
  function normalize(it) {
    const a = pick(it, ['Author', 'author', 'AuthorName', 'author_name', 'AuthorInfo']);
    const authorName = (a && typeof a === 'object')
      ? pick(a, ['Name', 'name', 'DisplayName', 'display_name', 'Nickname', 'nickname'])
      : a;
    return {
      title: String(pick(it, ['Title', 'title', 'QuestionTitle', 'question_title']) || '').trim(),
      url: pick(it, ['Url', 'url', 'Link', 'link', 'TargetUrl', 'target_url']) || '',
      type: String(pick(it, ['ContentType', 'content_type', 'Type', 'type']) || '').trim(),
      vote: Number(pick(it, ['VoteUpCount', 'voteup_count', 'VoteCount', 'vote_count',
                             'Upvote', 'upvote', 'LikeCount']) || 0),
      comment: Number(pick(it, ['CommentCount', 'comment_count', 'CommentsCount']) || 0),
      author: String(authorName || '').trim(),
      authority: pick(it, ['AuthorityLevel', 'authority_level', 'Authority', 'authority']) || '',
      excerpt: String(pick(it, ['Excerpt', 'excerpt', 'Summary', 'summary',
                                'Description', 'description']) || '').trim(),
      score: Number(pick(it, ['RankScore', 'rank_score', 'Score', 'score']) || 0)
    };
  }

  /* HTTP 200 不代表成功 —— 业务错误码在 body 里 */
  function assertOk(data, res) {
    const code = codeOf(data);
    if (code !== undefined && Number(code) !== 0 && Number(code) !== 200) {
      const msg = pick(data, ['Message', 'message', 'ErrMsg', 'errmsg']) || '';
      let human = '知乎接口返回错误码 ' + code + (msg ? '：' + msg : '');
      if (Number(code) === 20001) {
        human = 'AccessSecret 无效或已过期（请到 developer.zhihu.com 个人中心重新获取）';
      } else if (Number(code) === 30001) {
        human = '调用过于频繁，已被限流（免费额度 1000 次/天）';
      }
      throw new Error(human);
    }
    if (res && !res.ok) throw new Error('知乎接口返回 HTTP ' + res.status);
  }

  /* ---------- 站内搜索 ---------- */
  async function search(query, count) {
    if (!ready()) throw new Error('未配置知乎 AccessSecret');
    const n = Math.min(Math.max(parseInt(count, 10) || MAX_COUNT, 1), MAX_COUNT);
    const url = BASE + '/api/v1/content/zhihu_search'
      + '?Query=' + encodeURIComponent(String(query || '').trim())
      + '&Count=' + n;

    let res;
    try {
      res = await fetch(url, { headers: headers() });
    } catch (e) {
      throw new Error('连不上知乎接口：' + (e && e.message ? e.message : '网络错误'));
    }
    const data = await res.json().catch(() => null);
    assertOk(data, res);
    return { raw: data, items: itemsOf(data).map(normalize) };
  }

  /* ---------- 热榜（备用，暂未在主流程使用） ---------- */
  async function hotList(limit) {
    if (!ready()) throw new Error('未配置知乎 AccessSecret');
    const n = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 30);
    const res = await fetch(BASE + '/api/v1/content/hot_list?Limit=' + n,
      { headers: headers() });
    const data = await res.json().catch(() => null);
    assertOk(data, res);
    return { raw: data, items: itemsOf(data).map(normalize) };
  }

  /* ---------- 连通性测试 ---------- */
  async function ping() {
    const r = await search('知乎', 1);
    return r.items.length;
  }

  return { load, save, get, set, ready, search, hotList, ping, BASE };
})();

/* 顶层 const 不会成为 window 的属性，而 app.js 的守卫用的是 window.ZHILIAO_ZHIHU。
   不显式挂一次，整条链路会被静默跳过（这个坑在真实 AI 上已经吃过一次）。 */
if (typeof window !== 'undefined') window.ZHILIAO_ZHIHU = ZHILIAO_ZHIHU;
