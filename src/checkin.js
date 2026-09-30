/**
 * NodeLoc 每日自动签到
 *
 * 协议（逆向自社区实测脚本，NodeLoc 的 Discourse 签到插件）：
 *   1. GET  /  首页 HTML（带登录 Cookie）→ 解析 <meta name="csrf-token"> 与 <meta name="checkin-nonce">
 *   2. POST /checkin
 *        Headers: X-CSRF-Token / X-Checkin-Nonce / X-Discourse-Checkin / X-Requested-With
 *        Body:    nonce=<nonce>&timestamp=<毫秒>
 *   3. HTTP 200 且 JSON success === true → 签到成功
 *
 * 调度策略（复用每分钟 Cron，无需额外 trigger）：
 *   - maybeCheckin() 在每轮轮询后执行：
 *       北京时间到达 CHECKIN_HOUR 点且当日未签到 → 执行签到；
 *       失败自动重试（当日最多 CHECKIN_MAX_RETRY 次，随每分钟 Cron 进行）；
 *       成功写 last_checkin_day（北京日期）当日不再重复。
 *   - runCheckin() 为纯签到动作，/checkin 手动端点直接调用（强制执行，便于调试）。
 */

import { DiscourseClient } from './discourse.js';

/**
 * 北京时区（UTC+8）的今天，格式 YYYY-MM-DD
 */
export function todayShanghai(now = Date.now()) {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 北京时区（UTC+8）的当前小时数 */
export function currentHourShanghai(now = Date.now()) {
  return new Date(now + 8 * 3600 * 1000).getUTCHours();
}

/**
 * 执行一次签到动作（不判重，由调用方决定）
 * @param {object} env Worker 环境
 * @returns {{ success: boolean, status: number, body: string, day: string }}
 */
export async function runCheckin(env) {
  const client = new DiscourseClient(env);
  await client.loadState();
  await client.ensureSession(); // Cookie/CSRF 失效自动重登录
  await client.saveState();

  // 1) 抓首页，解析 csrf-token 与 checkin-nonce（响应的 Set-Cookie 照常被吸收）
  const res = await client.request('/', {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  if (!res.ok) throw new Error(`首页获取失败: HTTP ${res.status}`);
  const html = await res.text();

  const csrf = /<meta name="csrf-token" content="([^"]+)"/i.exec(html)?.[1];
  let nonce = /<meta name="checkin-nonce" content="([^"]+)"/i.exec(html)?.[1];
  if (!nonce) {
    // 页面未提供 nonce 时生成随机值（与社区脚本行为一致）
    nonce = (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 20);
  }
  if (!csrf) throw new Error('未解析到 csrf-token（可能未登录成功或页面结构变化）');

  // 2) POST /checkin（CSRF 用首页 meta 的值；Cookie 为最新会话 Cookie）
  const post = await client.request('/checkin', {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'X-CSRF-Token': csrf,
      'X-Checkin-Nonce': nonce,
      'X-Discourse-Checkin': 'true',
      Referer: client.base + '/',
    },
    form: { nonce, timestamp: String(Date.now()) }, // 自动 application/x-www-form-urlencoded
  });

  const text = await post.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON 响应（如被防护拦截），按失败处理 */
  }
  const success = post.status === 200 && data?.success === true;

  if (success) {
    console.log('[checkin] 签到成功:', text.slice(0, 200));
  } else {
    console.error('[checkin] 签到失败: HTTP', post.status, text.slice(0, 200));
  }
  return { success, status: post.status, body: text.slice(0, 300), day: todayShanghai() };
}

/**
 * 每轮 Cron 末尾调用：判断今天是否需要/可以签到，需要则执行。
 * @returns {object|null} 签到结果（null 表示本轮无需签到）
 */
export async function maybeCheckin(env) {
  // CHECKIN_HOUR 设为 -1 可禁用自动签到
  const hour = parseInt(env.CHECKIN_HOUR ?? '0', 10);
  if (!Number.isFinite(hour) || hour < 0) return null;

  const today = todayShanghai();
  const curHour = currentHourShanghai();

  if ((await env.KV.get('last_checkin_day')) === today) return null; // 今天已签
  if (curHour < hour) return null; // 未到设定时间

  const retries = parseInt((await env.KV.get(`checkin_retry:${today}`)) || '0', 10);
  const maxRetries = parseInt(env.CHECKIN_MAX_RETRY ?? '5', 10);
  if (retries >= maxRetries) {
    console.log(`[checkin] 今日已失败 ${retries} 次（上限 ${maxRetries}），今日不再重试`);
    return null;
  }

  console.log(`[checkin] 开始签到（第 ${retries + 1} 次尝试，北京时间 ${curHour} 点）`);
  const result = await runCheckin(env);

  if (result.success) {
    await env.KV.put('last_checkin_day', today);
  } else {
    await env.KV.put(`checkin_retry:${today}`, String(retries + 1), { expirationTtl: 172800 });
  }
  return result;
}
