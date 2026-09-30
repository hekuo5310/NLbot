/**
 * Discourse 客户端 —— 针对 NodeLoc (https://www.nodeloc.com)
 *
 * 核心职责（按需求"时刻更新 csrf 和 cookie"实现）：
 *  1. CookieJar：吸收每一次响应的 Set-Cookie，并在每个请求中回传最新 Cookie；
 *  2. CSRF Token：登录前、以及每次"写操作"（发回复）前，强制 GET /session/csrf 刷新；
 *  3. 会话自愈：任何 API 返回 401/403/419 时，先刷 CSRF、再校验会话、必要时完整重登录；
 *  4. 状态持久化：Cookie + CSRF + 用户名存入 KV，Cron 唤醒时恢复会话，避免每分钟重新登录。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ */
/* CookieJar：最小可用实现（单域场景，只保留 name=value）              */
/* ------------------------------------------------------------------ */
export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  /** 解析单个 Set-Cookie 字符串并入库（处理 expires / max-age 过期删除） */
  parse(setCookie) {
    if (!setCookie) return;
    const parts = setCookie.split(';');
    const [nv, ...attrs] = parts;
    const eq = nv.indexOf('=');
    if (eq < 1) return;
    const name = nv.slice(0, eq).trim();
    let value = nv.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);

    const lower = attrs.map((a) => a.trim().toLowerCase());
    const expires = lower.find((a) => a.startsWith('expires='));
    if (expires) {
      const t = Date.parse(expires.slice(8));
      if (!Number.isNaN(t) && t < Date.now()) {
        this.cookies.delete(name);
        return;
      }
    }
    const maxAge = lower.find((a) => a.startsWith('max-age='));
    if (maxAge) {
      const n = parseInt(maxAge.slice(8), 10);
      if (Number.isFinite(n) && n <= 0) {
        this.cookies.delete(name);
        return;
      }
    }
    if (!value) {
      this.cookies.delete(name);
      return;
    }
    this.cookies.set(name, value);
  }

  /** 批量吸收 response.headers.getSetCookie() */
  absorb(res) {
    const list =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) this.parse(c);
  }

  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  has(name) {
    return this.cookies.has(name);
  }

  toJSON() {
    return [...this.cookies.entries()];
  }

  static fromJSON(arr) {
    const jar = new CookieJar();
    if (Array.isArray(arr)) for (const [k, v] of arr) jar.cookies.set(k, v);
    return jar;
  }
}

/* ------------------------------------------------------------------ */
/* DiscourseClient                                                     */
/* ------------------------------------------------------------------ */
export class DiscourseClient {
  /**
   * @param {object} env  Worker 环境变量（NL_BASE / KV / NL_USERNAME / NL_PASSWORD）
   */
  constructor(env) {
    this.env = env;
    this.base = (env.NL_BASE || 'https://www.nodeloc.com').replace(/\/+$/, '');
    this.kv = env.KV;
    this.jar = new CookieJar();
    this.csrf = null;
    this.username = null;
    /** 服务端查重缓存：topicId -> { posts, at }（同实例内 20s 复用，避免同主题重复拉取） */
    this._dupCache = new Map();
  }

  /* ---------------- KV 持久化 ---------------- */

  async loadState() {
    if (!this.kv) return;
    const raw = await this.kv.get('nl_state');
    if (!raw) return;
    try {
      const s = JSON.parse(raw);
      this.jar = CookieJar.fromJSON(s.cookies);
      this.csrf = s.csrf || null;
      this.username = s.username || null;
    } catch (e) {
      console.error('[nl] 恢复会话状态失败，将重新登录:', e.message);
    }
  }

  async saveState() {
    if (!this.kv) return;
    await this.kv.put(
      'nl_state',
      JSON.stringify({ cookies: this.jar.toJSON(), csrf: this.csrf, username: this.username })
    );
  }

  /* ---------------- 底层请求 ---------------- */

  /**
   * 发起一次请求；每次响应都会吸收 Set-Cookie（时刻更新 Cookie）。
   * @param {string} path   以 / 开头的路径，或 absolute 为 true 时的完整 URL
   * @param {object} opts   { method, form, json, headers, csrf, absolute }
   */
  async request(path, opts = {}) {
    const { method = 'GET', form, json, headers = {}, csrf = false, absolute = false } = opts;
    const url = absolute ? path : this.base + path;

    const h = {
      'User-Agent': UA,
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'Discourse-Present': 'true',
      Referer: this.base + '/',
      ...headers,
    };
    const cookie = this.jar.header();
    if (cookie) h['Cookie'] = cookie;
    if (csrf) {
      if (!this.csrf) await this.refreshCsrf();
      h['X-CSRF-Token'] = this.csrf;
    }

    let body;
    if (form) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    } else if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }

    const res = await fetch(url, { method, headers: h, body, redirect: 'manual' });
    this.jar.absorb(res); // ⭐ 每次响应都更新 Cookie
    return res;
  }

  /* ---------------- CSRF / 登录 / 会话 ---------------- */

  /** 强制刷新 CSRF Token（配合最新 Cookie） */
  async refreshCsrf() {
    const res = await this.request('/session/csrf');
    if (!res.ok) throw new Error(`获取 CSRF 失败: HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    if (!data.csrf) throw new Error('CSRF 响应中没有 token（可能被站点防护拦截）');
    this.csrf = data.csrf;
    return this.csrf;
  }

  /** 完整登录流程：全新会话 → CSRF → POST /session → 再次刷新 CSRF */
  async login() {
    if (!this.env.NL_USERNAME || !this.env.NL_PASSWORD) {
      throw new Error('缺少 NL_USERNAME / NL_PASSWORD（请用 wrangler secret put 设置）');
    }
    console.log('[nl] 开始登录:', this.env.NL_USERNAME);
    this.jar = new CookieJar();
    this.csrf = null;

    await this.refreshCsrf(); // 拿到 _forum_session + CSRF

    const res = await this.request('/session', {
      method: 'POST',
      csrf: true,
      form: {
        login: this.env.NL_USERNAME,
        password: this.env.NL_PASSWORD,
        remember: 'true',
      },
    });

    const data = await res.json().catch(() => ({}));
    const errMsg = data?.error || data?.errors?.join(', ');
    if (!res.ok || errMsg) {
      throw new Error(
        `登录失败: HTTP ${res.status} ${errMsg || JSON.stringify(data).slice(0, 300)}`
      );
    }
    if (!data?.user?.username) {
      throw new Error('登录响应中没有用户信息，请检查账号密码（注意：不支持两步验证）');
    }
    this.username = data.user.username;
    console.log('[nl] 登录成功:', this.username);

    // 登录后 _forum_session 通常轮换，立刻用新 Cookie 再刷一次 CSRF
    await this.refreshCsrf();
    await this.saveState();
    return this.username;
  }

  /** 确保会话可用：优先复用 KV 里的 Cookie，失效则完整重登录 */
  async ensureSession() {
    if (this.jar.header() && this.csrf) {
      try {
        const res = await this.request('/session/current.json');
        if (res.ok) {
          const d = await res.json().catch(() => ({}));
          const u = d?.current_user?.username;
          if (u) {
            if (u !== this.username) {
              this.username = u;
              await this.saveState();
            }
            console.log('[nl] 会话有效:', u);
            return;
          }
        }
        console.log('[nl] 已有会话失效（HTTP', res.status, '），重新登录…');
      } catch (e) {
        console.log('[nl] 会话校验出错:', e.message, '→ 重新登录');
      }
    }
    await this.login();
  }

  /**
   * 带自愈能力的 API 调用：
   * 遇到 401/403/419 → 刷 CSRF → 校验会话（失败则重登录）→ 重试一次
   */
  async api(path, opts = {}, depth = 0) {
    let res = await this.request(path, opts);
    if ([401, 403, 419].includes(res.status) && depth === 0) {
      console.log('[nl] HTTP', res.status, '→ 刷新凭据后重试:', path);
      try {
        await this.refreshCsrf();
        const chk = await this.request('/session/current.json');
        if (!chk.ok) await this.login();
      } catch {
        await this.login();
      }
      res = await this.request(path, opts);
    }
    return res;
  }

  /* ---------------- 业务 API ---------------- */

  /**
   * 动态获取站点通知类型映射（name → 数值）。
   * Discourse 各版本类型数值可能不同，从 /site.json 按名字取值最可靠；
   * 实例内缓存 + KV 缓存 24 小时。
   * @returns {Promise<Object<string, number>>} 如 { mentioned: 4, replied: 1, private_message: 6, ... }
   */
  async getNotificationTypes() {
    if (this.ntypes) return this.ntypes;
    if (this.kv) {
      const raw = await this.kv.get('nl_ntypes');
      if (raw) {
        try {
          this.ntypes = JSON.parse(raw);
          return this.ntypes;
        } catch {
          /* 缓存损坏则重新拉取 */
        }
      }
    }
    const res = await this.api('/site.json');
    if (!res.ok) throw new Error(`拉取 site.json 失败: HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    const map = data?.notification_types;
    if (!map || typeof map !== 'object') {
      throw new Error('site.json 中没有 notification_types 字段');
    }
    this.ntypes = map;
    if (this.kv) {
      await this.kv.put('nl_ntypes', JSON.stringify(map), { expirationTtl: 86400 });
    }
    return map;
  }

  /** 拉取第一页通知（30 条） */
  async fetchNotifications() {
    const res = await this.api('/notifications.json');
    if (!res.ok) throw new Error(`拉取通知失败: HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    return data?.notifications || [];
  }

  /** 获取单条帖子（含 cooked HTML） */
  async getPost(postId) {
    if (!postId) return null;
    const res = await this.api(`/posts/${postId}.json`);
    if (!res.ok) {
      console.error('[nl] 获取帖子失败', postId, 'HTTP', res.status);
      return null;
    }
    return res.json();
  }

  /**
   * 回复主题 —— 写操作。
   * ⭐ 每次发帖前强制刷新 CSRF（需求核心："时刻更新 csrf"），失败自动重登录后重试一次。
   */
  async createReply(topicId, raw, replyToPostNumber) {
    const doReply = async () => {
      await this.refreshCsrf(); // ⭐ 写前强制刷新 CSRF + 携带最新 Cookie
      const form = { topic_id: String(topicId), raw };
      if (replyToPostNumber) form.reply_to_post_number = String(replyToPostNumber);
      const res = await this.request('/posts.json', { method: 'POST', csrf: true, form });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    };

    let { res, data } = await doReply();
    if (!res.ok && [401, 403, 419].includes(res.status)) {
      console.log('[nl] 回复被拒（HTTP', res.status, '），重登录后重试…');
      await this.login();
      ({ res, data } = await doReply());
    }
    if (!res.ok) {
      const errs = data?.errors?.join(', ');
      throw new Error(`回复失败: HTTP ${res.status} ${errs || JSON.stringify(data).slice(0, 300)}`);
    }
    return data;
  }

  /** 下载媒体文件（带 Cookie + Referer，防防盗链）；返回 { buf, contentType } */
  async downloadMedia(url) {
    const res = await this.request(url, { absolute: true });
    if (!res.ok) throw new Error(`媒体下载失败: HTTP ${res.status}`);
    const contentType = (res.headers.get('content-type') || 'application/octet-stream')
      .split(';')[0]
      .trim();
    const buf = await res.arrayBuffer();
    return { buf, contentType };
  }

  /* ---------------- 服务端查重（防重复回复） ---------------- */

  /**
   * 拉取主题帖子流的末尾一段（含 username / reply_to_post_number）。
   * 机器人对某楼层的回复必然晚于该楼层，而重复回复的尝试又紧随其后，
   * 因此机器人的历史回复必然位于主题末尾——只查末尾即可权威判定。
   * 实现：/t/{id}.json 拿完整 stream（第一页自带前 20 楼详情），
   *       末尾不在第一页的 post_ids 再用 /t/{id}/posts.json?post_ids[]= 批量补拉。
   * @returns {Promise<Array<{username: string, replyTo: number|null}>>}
   */
  async fetchTopicPostsTail(topicId, tailCount = 40) {
    const tRes = await this.api(`/t/${topicId}.json`);
    if (!tRes.ok) throw new Error(`拉取主题失败: HTTP ${tRes.status}`);
    const t = await tRes.json().catch(() => ({}));
    const stream = Array.isArray(t?.post_stream?.stream) ? t.post_stream.stream : [];
    let posts = Array.isArray(t?.post_stream?.posts) ? t.post_stream.posts : [];
    const have = new Set(posts.map((p) => p.id));
    const tail = stream.slice(-tailCount).filter((id) => !have.has(id));
    if (tail.length) {
      const qs = tail.map((id) => `post_ids[]=${encodeURIComponent(id)}`).join('&');
      const dRes = await this.api(`/t/${topicId}/posts.json?${qs}`);
      if (dRes.ok) {
        const d = await dRes.json().catch(() => ({}));
        if (Array.isArray(d?.post_stream?.posts) && d.post_stream.posts.length) {
          posts = posts.concat(d.post_stream.posts);
        }
      }
    }
    return posts.map((p) => ({
      username: p.username || '',
      replyTo: p.reply_to_post_number || null,
    }));
  }

  /** 查重缓存读取（fresh=true 强制未命中，发帖前最终校验必须用最新数据） */
  _dupCacheGet(topicId, fresh) {
    if (fresh) return null;
    const c = this._dupCache.get(String(topicId));
    return c && Date.now() - c.at < 20000 ? c.posts : null;
  }

  /**
   * ⭐ 服务端查重：机器人是否已回复过目标楼层。
   * 判定标准：主题中存在 username = 机器人 且 reply_to_post_number = 目标楼层的帖子。
   * 不依赖 KV（KV 有最长约 60s 最终一致延迟），直接问论坛，是防重复回复的权威兜底：
   * 覆盖 Cron 并发重叠、KV 读到旧水位线/旧去重集合、进程中断后重放等一切本地去重失效场景。
   *
   * @param {number|string} topicId    主题/私信 id（私信本质也是主题）
   * @param {number|string} postNumber 目标楼层号
   * @param {object} opts  { fresh } fresh=true 绕过实例内缓存拉最新
   * @returns {Promise<boolean>} true = 已回复过应跳过；false = 未回复或查重失败（放行，交本地去重兜底）
   */
  async hasRepliedTo(topicId, postNumber, opts = {}) {
    const pn = parseInt(postNumber, 10);
    if (!pn || pn < 1) return false; // 楼层号不可靠时无法判定 → 放行
    try {
      let posts = this._dupCacheGet(topicId, opts.fresh);
      if (!posts) {
        posts = await this.fetchTopicPostsTail(topicId);
        this._dupCache.set(String(topicId), { posts, at: Date.now() });
      }
      const me = (this.username || '').toLowerCase();
      return posts.some(
        (p) => (p.username || '').toLowerCase() === me && parseInt(p.replyTo, 10) === pn
      );
    } catch (e) {
      console.log('[nl] 服务端查重失败（放行，交本地去重兜底）:', e.message);
      return false;
    }
  }
}
