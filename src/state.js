/**
 * 强一致状态层 —— Cloudflare Durable Object（BotState）
 *
 * 为什么需要：KV 是最终一致的（写入后跨节点传播最长约 60 秒，读取可能命中边缘缓存），
 * 基于 KV 的"运行锁 / 已处理标记"只能尽力而为——两个并发实例可能同时读到旧值，
 * 导致同一批通知被重复处理（重复回复）。Durable Object 对同一实例串行处理请求，
 * 配合 blockConcurrencyWhile，check-then-set 是原子的，锁与标记因此强一致。
 *
 * 提供（HTTP 风格，fetch 内路由）：
 *   /tryLock?ttl=300  轮次互斥锁：拿不到 = 上一轮还在跑（超 ttl 自动可重入，崩溃自愈）
 *   /unlock           释放轮次锁
 *   /claim?k=楼层键   楼层"占坑"标记：写前标记，抢到才有权处理该楼层（有标记不回复）
 *   /has?k=           查询占坑标记
 *
 * 占坑标记 24 小时惰性过期：处理失败/崩溃的楼层次日仍可人工重放，不会永久卡死。
 *
 * 未绑定 DO（env.STATE 缺失）时，createStateStore() 自动退回 KV 尽力而为模式，
 * 与旧版本行为兼容；此时服务端查重（discourse.js hasRepliedTo）仍是权威兜底。
 */

const CLAIM_TTL_MS = 24 * 3600 * 1000; // 占坑标记保留时长

export class BotState {
  constructor(state, env) {
    this.state = state;
  }

  async fetch(request) {
    // blockConcurrencyWhile：处理期间阻塞该 DO 的其他事件 → 读-改-写原子，防并发竞态
    const data = await this.state.blockConcurrencyWhile(() => this._route(new URL(request.url)));
    return new Response(JSON.stringify(data), {
      headers: { 'content-type': 'application/json' },
    });
  }

  async _route(url) {
    const storage = this.state.storage;
    const now = Date.now();
    switch (url.pathname) {
      case '/tryLock': {
        const ttlMs = Math.max(60, parseInt(url.searchParams.get('ttl') || '300', 10) || 300) * 1000;
        const heldAt = await storage.get('lock_ts');
        if (Number.isFinite(heldAt) && now - heldAt < ttlMs) return { acquired: false };
        await storage.put('lock_ts', now); // Worker 崩溃也不怕：超 ttl 后自动可重入
        return { acquired: true };
      }
      case '/unlock': {
        await storage.delete('lock_ts');
        return { ok: true };
      }
      case '/claim': {
        const k = url.searchParams.get('k');
        if (!k) return { claimed: false };
        const claims = (await storage.get('claims')) || {};
        for (const [key, ts] of Object.entries(claims)) {
          if (!Number.isFinite(ts) || now - ts > CLAIM_TTL_MS) delete claims[key]; // 惰性清理
        }
        if (claims[k]) return { claimed: false };
        claims[k] = now;
        await storage.put('claims', claims);
        return { claimed: true };
      }
      case '/has': {
        const claims = (await storage.get('claims')) || {};
        return { has: !!claims[url.searchParams.get('k')] };
      }
      default:
        return { error: 'unknown path' };
    }
  }
}

/**
 * 状态存储适配器：优先 Durable Object（强一致），未绑定退回 KV（尽力而为）。
 * 两者接口一致：tryLock / unlock / claim / has。
 * @param {object} env Worker 环境（STATE 为 DO 命名空间绑定，KV 为 KV 命名空间绑定）
 * @returns {{ strong: boolean, tryLock: Function, unlock: Function, claim: Function, has: Function }}
 */
export function createStateStore(env) {
  if (env.STATE && typeof env.STATE.idFromName === 'function' && typeof env.STATE.get === 'function') {
    // 单例 DO：所有 Cron 实例访问同一个对象 → 全局唯一互斥锁与标记表
    const stub = env.STATE.get(env.STATE.idFromName('singleton'));
    const call = async (path, params) => {
      const u = new URL('https://state.internal' + path);
      for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, String(v));
      const res = await stub.fetch(new Request(u.toString()));
      if (!res.ok) throw new Error(`BotState ${path} HTTP ${res.status}`);
      return res.json();
    };
    return {
      strong: true,
      tryLock: (ttl) => call('/tryLock', { ttl }),
      unlock: () => call('/unlock'),
      claim: (k) => call('/claim', { k }),
      has: (k) => call('/has', { k }),
    };
  }

  // KV 兜底（尽力而为）。占坑标记直接复用 processed_posts（写前标记，
  // 比旧版"成功后才记"提前到 AI 调用之前，已可覆盖绝大多数重复窗口）。
  const kv = env.KV;
  return {
    strong: false,
    async tryLock(ttl = 300) {
      if (await kv.get('run_lock')) return { acquired: false };
      await kv.put('run_lock', String(Date.now()), { expirationTtl: ttl });
      return { acquired: true };
    },
    async unlock() {
      await kv.delete('run_lock').catch(() => {});
    },
    async claim(k) {
      if (!k) return { claimed: false };
      const list = JSON.parse((await kv.get('processed_posts')) || '[]');
      if (list.includes(k)) return { claimed: false };
      list.push(k);
      await kv.put('processed_posts', JSON.stringify(list.slice(-800)));
      return { claimed: true };
    },
    async has(k) {
      return { has: JSON.parse((await kv.get('processed_posts')) || '[]').includes(k) };
    },
  };
}
