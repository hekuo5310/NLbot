/**
 * NodeLoc AI 回复机器人 —— Cloudflare Workers 入口
 *
 * 工作流程（每次 Cron 触发）：
 *   0. 运行锁（Durable Object 强一致互斥，未绑定时退回 KV）：上一轮未结束时本轮直接跳过；
 *   1. 从 KV 恢复 Cookie/CSRF（失效自动重登录）；
 *   2. 拉取 /notifications.json，处理三类通知：@ 提及（mentioned/group_mentioned）、
 *      回复（replied）、私信（private_message）；类型数值从 /site.json 动态获取；
 *   3. 首次运行只记录水位线（不回复历史消息）；
 *   4. 逐条：楼层写前占坑（claim，有标记不回复）→ 拉帖子 → 服务端查重（已回复过该楼层则跳过）→
 *      提取文本/图片/视频 → 图片转 base64 → 调 OpenAI 兼容端点 → 发帖前再查重一次（fresh）→
 *      回帖/回私信（发帖前强制刷新 CSRF）→ 推进水位线。
 *
 * 调试：部署后访问 https://<your-worker>.workers.dev/run?key=<RUN_TOKEN> 手动触发一轮。
 */

import { DiscourseClient } from './discourse.js';
import { extractContent, bufToBase64, clampReply } from './content.js';
import { chatWithAI } from './ai.js';
import { maybeCheckin, runCheckin } from './checkin.js';
import { createStateStore } from './state.js';

// Durable Object 类必须从入口模块导出（wrangler 迁移指向 main）
export { BotState } from './state.js';

/**
 * 要处理的 Discourse 通知类型（按名字，数值运行时从站点 /site.json 动态获取）：
 *   mentioned       —— 帖子/回复中 @ 了机器人
 *   group_mentioned —— 机器人所在群组被 @
 *   replied         —— 有人直接回复了机器人的楼层
 *   private_message —— 收到私信
 * 如需扩展引用（quoted）通知，把 'quoted' 加入本列表即可。
 */
const PROCESS_TYPE_NAMES = ['mentioned', 'group_mentioned', 'replied', 'private_message'];
/** site.json 拉取失败时的兜底映射（与主流 Discourse 版本一致） */
const FALLBACK_TYPES = { mentioned: 4, group_mentioned: 15, replied: 1, private_message: 6 };
/** 帖子级去重：同一楼层可能同时产生多张通知（如私信里的回复同时带 replied+private_message），只回复一次 */
const PROCESSED_POSTS_KEEP = 500;
/** 运行锁 TTL：上一轮异常崩溃时锁最多 5 分钟自动过期，不会永久死锁 */
const RUN_LOCK_TTL = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkEnv(env) {
  const missing = [];
  if (!env.NL_USERNAME) missing.push('NL_USERNAME');
  if (!env.NL_PASSWORD) missing.push('NL_PASSWORD');
  if (!env.AI_API_KEY) missing.push('AI_API_KEY');
  if (!env.AI_BASE_URL) missing.push('AI_BASE_URL');
  if (!env.KV) missing.push('KV（wrangler.toml 里的 kv namespace id 未配置）');
  if (missing.length) throw new Error('缺少配置: ' + missing.join(', '));
}

/**
 * 主流程：跑一轮"拉通知（@提及/回复/私信）→ AI → 回复"
 * @returns {{ processed: number, failed: number, initialized: boolean }}
 */
export async function runBot(env) {
  await checkEnv(env);
  const state = createStateStore(env);

  // ⭐ 运行锁：一轮处理（AI 响应 + 限速间隔）可能超过 1 分钟，Cron 到点会并发拉起新实例。
  // 绑定 Durable Object（STATE）时锁是强一致的（check-then-set 原子，无 KV 延迟窗口）；
  // 未绑定时退回 KV 尽力而为，楼层 claim 标记 + 服务端查重继续兜底。
  let lock;
  try {
    lock = await state.tryLock(RUN_LOCK_TTL);
  } catch (e) {
    console.log('[bot] 运行锁获取失败（降级放行，交后续查重兜底）:', e.message);
    lock = { acquired: true };
  }
  if (!lock.acquired) {
    console.log('[bot] 上一轮仍在运行（运行锁未释放），本轮跳过（跳过不丢消息：水位线未动，下一轮自动补上）');
    return { processed: 0, failed: 0, skipped: true };
  }
  try {
    return await runBotInner(env, state);
  } finally {
    try {
      await state.unlock(); // 无论成败都释放，下一轮 Cron 照常接管
    } catch {
      /* 释放失败只影响下一轮等待 TTL 过期，无死锁风险 */
    }
  }
}

async function runBotInner(env, state) {
  const client = new DiscourseClient(env);
  await client.loadState(); // 1) 恢复会话（Cookie/CSRF）
  await client.ensureSession(); // 2) 校验会话，失效自动重登录
  await client.saveState(); // 3) 把刷新后的 Cookie 存回 KV

  // 4) 动态解析通知类型数值（避免 Discourse 版本差异硬编码出错）
  const typeMap = await client.getNotificationTypes().catch((e) => {
    console.log('[bot] site.json 类型映射拉取失败，使用兜底:', e.message);
    return FALLBACK_TYPES;
  });
  const typeSet = new Set(
    PROCESS_TYPE_NAMES.map((k) => typeMap[k]).filter((v) => v !== undefined && v !== null)
  );
  console.log(
    '[bot] 监听通知类型:',
    PROCESS_TYPE_NAMES.map((k) => `${k}=${typeMap[k] ?? '未知'}`).join(' ')
  );

  const notifications = await client.fetchNotifications();
  let lastId = parseInt((await env.KV.get('last_notification_id')) || '0', 10);
  const initialized = (await env.KV.get('bot_initialized')) === '1';
  const processedPosts = new Set(JSON.parse((await env.KV.get('processed_posts')) || '[]'));

  // 首次运行：只建立基线，不回复历史提及，避免刷屏
  if (!initialized) {
    const maxId = Math.max(0, ...notifications.map((n) => n.id));
    await env.KV.put('last_notification_id', String(maxId));
    await env.KV.put('bot_initialized', '1');
    console.log(`[bot] 首次运行，通知水位线 = ${maxId}，历史提及不回复`);
    return { processed: 0, failed: 0, initialized: true };
  }

  const queue = notifications
    .filter((n) => typeSet.has(n.notification_type) && n.id > lastId)
    // 防自循环：机器人自己发出的内容产生的通知不处理
    .filter((n) => (n.data?.original_username || '').toLowerCase() !== (client.username || '').toLowerCase())
    .sort((a, b) => a.id - b.id); // 按时间正序逐条回复

  const typeNameOf = (n) =>
    PROCESS_TYPE_NAMES.find((k) => typeMap[k] === n.notification_type) || `type:${n.notification_type}`;

  const maxImages = parseInt(env.MAX_IMAGES || '3', 10);
  const maxImageBytes = parseInt(env.MAX_IMAGE_MB || '10', 10) * 1024 * 1024;
  const delay = parseInt(env.REPLY_DELAY_MS || '3000', 10);

  let processed = 0;
  let failed = 0;

  for (const n of queue) {
    const tag = `[notif ${n.id} ${typeNameOf(n)}]`;
    try {
      const postId = n.data?.original_post_id;
      const pidKey = String(postId || `notif-${n.id}`);
      if (processedPosts.has(pidKey)) {
        console.log(`${tag} 楼层 ${pidKey} 已处理过（同楼层多张通知去重），跳过`);
      } else {
        // ⭐ 写前占坑（"打标记，有标记不回复"）：先抢到标记才有权处理该楼层，
        // 另一实例/前一轮见过标记直接跳过，不调 AI 不发帖。DO 绑定时强一致，KV 兜底时
        // 也比旧版"成功后才记"提前到 AI 调用之前。标记失败则降级放行（交服务端查重兜底）。
        let claim;
        try {
          claim = await state.claim(pidKey);
        } catch (e) {
          console.log(`${tag} 占坑标记失败（降级放行）: ${e.message}`);
          claim = { claimed: true };
        }
        if (!claim.claimed) {
          console.log(`${tag} 楼层 ${pidKey} 已有处理标记（另一实例/前一轮已占坑），跳过`);
        } else {
          const post = await client.getPost(postId);
          if (!post) throw new Error('帖子不可用（可能已删除）');
          if ((post.username || '').toLowerCase() === (client.username || '').toLowerCase()) {
            console.log(`${tag} 跳过自己的帖子`);
          } else if (await client.hasRepliedTo(n.topic_id, n.post_number)) {
            // ⭐ 服务端查重（AI 调用前）：不依赖 KV，论坛说回过就是回过——既防重复又省 AI 配额
            console.log(`${tag} 服务端查重：已回复过该楼层，跳过`);
          } else {
            // 解析内容
            const { text, images, videos } = extractContent(post.cooked, client.base);
            const title = n.data?.topic_title || '';

            // 下载图片 → base64 data URL（视觉输入）
            const dataUrls = [];
            for (const u of images.slice(0, maxImages)) {
              try {
                const { buf, contentType } = await client.downloadMedia(u);
                if (!contentType.startsWith('image/')) throw new Error('非图片类型: ' + contentType);
                if (buf.byteLength > maxImageBytes) throw new Error(`图片过大(${(buf.byteLength / 1048576).toFixed(1)}MB)`);
                dataUrls.push(`data:${contentType};base64,${bufToBase64(buf)}`);
              } catch (e) {
                console.log(`${tag} 图片跳过 ${u}: ${e.message}`);
              }
            }

            // 调用 OpenAI 兼容端点
            const aiReply = await chatWithAI(env, {
              botName: client.username,
              username: post.username || n.data?.original_username || '论坛用户',
              title,
              text,
              images: dataUrls,
              videos,
            });

            // ⭐ 发帖前最终查重（fresh 绕过缓存拿最新数据）：收窄并发窗口，双重保险
            if (await client.hasRepliedTo(n.topic_id, n.post_number, { fresh: true })) {
              console.log(`${tag} 发帖前查重：机器人已回复过该楼层，放弃本次回复`);
            } else {
              // 回帖（私信与普通主题同接口；内部会先强制刷新 CSRF）
              await client.createReply(n.topic_id, clampReply(aiReply), n.post_number);
              processed++;
              console.log(`${tag} 已回复《${title}》#${n.post_number}`);
            }
          }
          processedPosts.add(pidKey);
        }
      }
    } catch (e) {
      failed++;
      console.error(`${tag} 处理失败: ${e.message}`);
    }
    // 无论成败都推进水位线并记录已处理楼层，避免反复重试烧 AI 配额
    lastId = n.id;
    await env.KV.put('last_notification_id', String(lastId));
    await env.KV.put('processed_posts', JSON.stringify([...processedPosts].slice(-PROCESSED_POSTS_KEEP)));
    if (queue.indexOf(n) < queue.length - 1) await sleep(delay); // 限速保护
  }

  return { processed, failed, initialized: true };
}

/* ------------------------------------------------------------------ */
/* Worker 入口                                                         */
/* ------------------------------------------------------------------ */
export default {
  /** Cron 触发（wrangler.toml [triggers] crons）：每轮先处理通知，再检查每日签到 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const r = await runBot(env);
          console.log('[bot] 本轮完成:', JSON.stringify(r));
        } catch (e) {
          console.error('[bot] 本轮异常:', e.stack || e.message);
        }
        try {
          const c = await maybeCheckin(env);
          if (c) console.log('[bot] 签到结果:', JSON.stringify(c));
        } catch (e) {
          console.error('[bot] 签到异常:', e.stack || e.message);
        }
      })()
    );
  },

  /** HTTP 入口：健康检查 + 手动触发（调试用） */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/checkin') {
      const token = env.RUN_TOKEN;
      if (token && url.searchParams.get('key') !== token) {
        return new Response(JSON.stringify({ error: 'invalid key' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      try {
        const result = await runCheckin(env); // 强制签到（不判重，便于调试）
        if (result.success) {
          const today = result.day;
          await env.KV.put('last_checkin_day', today); // 手动成功也计入当日去重
        }
        return new Response(JSON.stringify({ ok: result.success, ...result }, null, 2), {
          headers: { 'content-type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }, null, 2), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    if (url.pathname === '/run') {
      const token = env.RUN_TOKEN;
      if (token && url.searchParams.get('key') !== token) {
        return new Response(JSON.stringify({ error: 'invalid key' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      try {
        const result = await runBot(env);
        return new Response(JSON.stringify({ ok: true, ...result }, null, 2), {
          headers: { 'content-type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }, null, 2), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    return new Response(
      'NodeLoc bot is alive. 提示：/run?key=<RUN_TOKEN> 手动触发一轮轮询；/checkin?key=<RUN_TOKEN> 手动签到。\n'
    );
  },
};
