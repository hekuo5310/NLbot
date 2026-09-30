# NodeLoc AI 回复机器人（Cloudflare Workers）

监听 [NodeLoc](https://www.nodeloc.com)（Discourse 论坛）上你账号的三类消息——**@ 提及、楼层回复、私信**，把对方发言（文字 + 图片 + 视频链接）发给你的 **OpenAI 兼容端点**，并用 AI 输出的内容直接回复（私信同样自动回复）；外加**每日自动签到**。

纯 Cloudflare Workers 实现：**无服务器、每分钟 Cron 轮询、KV 持久化会话、Durable Object 强一致防重**（SQLite-backed DO 免费套餐可用）。

---

## 一、工作原理

```
Cron (每分钟)
   │
   ▼
运行锁检查（Durable Object 强一致互斥；未绑定时退回 KV：上轮未结束 → 本轮跳过，跳过不丢消息）
   │
   ▼
从 KV 恢复 Cookie / CSRF ──失效──► 账号密码重新登录（GET /session/csrf → POST /session）
   │ 有效
   ▼
GET /notifications.json ──► 处理三类通知：@提及（mentioned/group_mentioned）+ 楼层回复（replied）+ 私信（private_message）
│                            类型数值从 /site.json 动态获取（兼容各 Discourse 版本），
│                            五重防重复：运行锁 + 楼层占坑标记 + 服务端查重×2 + 水位线 + 帖子级去重
   │
   ▼
GET /posts/{id}.json ──► 解析 cooked HTML：纯文本 / 图片URL / 视频URL
   │                        （拉取前先"写前占坑"claim：抢到标记才有权处理，防两实例重复干活）
   │
   ▼
图片下载 → base64 data URL（≤10MB，最多 3 张，带 Cookie/Referer 防防盗链）
   │
   ▼
POST {AI_BASE_URL}/chat/completions（文本 + image_url 视觉输入；视频链接写入提示词）
   │
   ▼
POST /posts.json 回帖  ←←← ⭐ 发帖前：① 服务端查重（已回复过该楼层则放弃）② 强制刷新 CSRF（每次都刷）
   ║
   ╚═► 每轮末尾：每日签到检查（北京时间到达 CHECKIN_HOUR 且当日未签）
         GET / → 解析 csrf-token + checkin-nonce meta
         POST /checkin（X-CSRF-Token + X-Checkin-Nonce + X-Discourse-Checkin）
         成功写 KV last_checkin_day；失败当日自动重试（最多 CHECKIN_MAX_RETRY 次）
```

**CSRF / Cookie 时刻更新策略（核心需求）：**

1. **每次 HTTP 响应**都会把 `Set-Cookie` 吸收进 CookieJar，下一个请求立即携带最新 Cookie；
2. **每次写操作（发回帖）前**强制 `GET /session/csrf` 刷新令牌，绝不复用旧 token；
3. **任何请求遇 401/403/419** 自动执行"刷 CSRF → 校验会话 → 必要时完整重登录 → 重试一次"的自愈链路；
4. Cookie（含长效 `_t` 记住令牌）与 CSRF 存 KV，Worker 无状态重启也能无缝续会话；
5. 登录请求带 `remember=true`，最大化延长会话有效期，减少重登录次数。

**每日签到实现：** NodeLoc 的签到接口为 `POST /checkin`，需要先抓首页 HTML 解析 `<meta name="csrf-token">` 与 `<meta name="checkin-nonce">`，再携带 `X-CSRF-Token` / `X-Checkin-Nonce` / `X-Discourse-Checkin` 头提交 `nonce + timestamp`。机器人复用每分钟 Cron：北京时间到达 `CHECKIN_HOUR` 点且 KV 中当日未签 → 自动签到；失败当日自动重试（默认最多 5 次）；成功记录 `last_checkin_day` 防重复。

**防重复回复（五重防线）：** ① **运行锁**——一轮处理（AI 响应 + 限速间隔）可能超过 1 分钟，Cron 到点会并发拉起新实例；上轮未结束时本轮直接跳过（**跳过不丢消息**：水位线未推进，下一轮自动补上），锁 5 分钟自动过期防崩溃死锁；② **楼层占坑标记（claim，写前标记）**——处理前先抢标记，另一实例/前一轮见过标记直接跳过，不调 AI 不发帖；③/④ **服务端查重×2**——AI 调用前查一次（省配额）、发帖前 fresh 再查一次（收窄竞态窗口），直接查主题里是否存在"机器人所发、reply_to 指向该楼层"的帖子，不依赖 KV，是权威兜底；⑤ **水位线 + 帖子级去重**——私信回复同时产生 replied + private_message 两张通知指向同一楼层时只回一次。其中①②在绑定 Durable Object 后是**强一致**的（DO 串行处理请求、check-then-set 原子，没有 KV 约 60 秒最终一致延迟的竞态窗口）；未绑定 DO 时自动退回 KV 尽力而为模式，此时③④仍权威有效。

**其他安全设计：** 机器人自己产生的不处理（防自循环）；回复间隔默认 3 秒（防论坛限速）；首次运行只记录水位线，不回复历史消息。

---

## 二、部署步骤

> 前置要求：Node.js ≥ 18、一个 Cloudflare 账号、机器人专用的 NodeLoc 账号（**必须关闭两步验证**，Discourse 账号密码登录无法自动过 TOTP）。

```bash
# 1. 进入项目目录并安装 wrangler
cd nodeloc-bot
npm install

# 2. 登录 Cloudflare（浏览器授权）
npx wrangler login

# 3. 创建 KV 命名空间，并把输出的 id 复制下来
npx wrangler kv namespace create KV
#   输出示例: id = "abcd1234xxxx..."
#   打开 wrangler.toml，把 REPLACE_WITH_YOUR_KV_NAMESPACE_ID 换成该 id

# 4. 修改 wrangler.toml 中的 [vars]
#    - AI_BASE_URL   你的 OpenAI 兼容端点，如 https://api.openai.com/v1
#    - AI_MODEL      模型名（要"看懂"图片请选支持视觉的模型，如 gpt-4o-mini / glm-4v 等）
#    - SYSTEM_PROMPT 机器人人设，随时可改
#    - NL_BASE       保持 https://www.nodeloc.com 即可

# 5. 写入敏感配置（secrets，按提示粘贴值）
npx wrangler secret put NL_USERNAME   # 论坛登录用户名
npx wrangler secret put NL_PASSWORD   # 论坛登录密码
npx wrangler secret put AI_API_KEY    # AI 端点的 API Key
npx wrangler secret put RUN_TOKEN     # 可选：手动触发口令（自定一串随机字符）

# 6. 部署！
npx wrangler deploy
```

部署成功后会输出 `https://nodeloc-bot.<你的子域>.workers.dev`。

---

## 三、验证与调试

```bash
# 实时看日志（另开一个终端，部署后保持运行）
npx wrangler tail

# 手动触发一轮轮询（配合上面日志观察登录与回复过程）
curl "https://nodeloc-bot.<你的子域>.workers.dev/run?key=<RUN_TOKEN>"

# 手动触发一次签到（不判重，用于验证签到链路）
curl "https://nodeloc-bot.<你的子域>.workers.dev/checkin?key=<RUN_TOKEN>"
```

1. 首次 `/run`：日志出现 `首次运行，通知水位线 = xxx，历史提及不回复` 属于正常设计；
2. 用小号在论坛任意主题 @ 机器人账号并附上文字/图片/视频；
3. 等 1 分钟（或再 `/run` 一次），机器人应以 AI 内容回帖并楼中楼关联你的楼层；
4. 若登录失败：检查密码、确认账号未开启 2FA；若响应提示被拦截（403 + HTML），见下方常见问题。

---

## 四、配置一览

| 变量 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `NL_USERNAME` / `NL_PASSWORD` | secret | ✅ | 论坛账号密码（请关闭 2FA） |
| `AI_API_KEY` | secret | ✅ | OpenAI 兼容端点密钥 |
| `RUN_TOKEN` | secret | 可选 | 手动触发 `/run` 的口令 |
| `NL_BASE` | vars | 默认已填 | 论坛地址 |
| `AI_BASE_URL` | vars | ✅ | 端点地址。填到 `/v1` 这一层（如 `https://api.openai.com/v1`）；代码会自动拼 `/chat/completions`，兼容 DeepSeek、GLM、OneAPI、new-api 等中转 |
| `AI_MODEL` | vars | ✅ | 模型名；需看图请选视觉模型 |
| `SYSTEM_PROMPT` | vars | 默认已填 | 机器人人设（改这里即可，不用动代码） |
| `MAX_IMAGES` | vars | 默认 3 | 每条消息最多传给 AI 的图片数 |
| `MAX_IMAGE_MB` | vars | 默认 10 | 单图大小上限，超出跳过 |
| `REPLY_DELAY_MS` | vars | 默认 3000 | 多条提及之间的回复间隔 |
| `CHECKIN_HOUR` | vars | 默认 0 | 每日签到时间（北京时间小时）。0 = 零点后第一轮即签；-1 = 禁用自动签到 |
| `CHECKIN_MAX_RETRY` | vars | 默认 5 | 签到失败后当日自动重试上限（随每分钟 Cron 重试） |
| `AI_WEB_SEARCH` | vars | 默认 0 | 启用 mimo 式服务端联网搜索（仅支持 tools.web_search 的端点可用，如 mimo-v2.5-pro） |
| `AI_WEB_SEARCH_FORCE` | vars | 默认 0 | 1 = 每次请求都强制搜索；0 = 模型自主判断是否需要联网 |
| `AI_WEB_SEARCH_MAX_KEYWORD` | vars | 默认 3 | 最多生成几个搜索关键词（建议 1~3） |
| `AI_WEB_SEARCH_LIMIT` | vars | 默认 3 | 返回的搜索结果数量上限 |
| `STATE`（Durable Object） | wrangler.toml 已配好 | 自动 | 强一致运行锁 + 楼层占坑标记（BotState，SQLite-backed 免费套餐可用）；首次 `deploy` 自动创建。删掉绑定会自动退回 KV 尽力而为模式，不影响运行 |
| Cron 表达式 | wrangler.toml | 默认每分钟 | `"* * * * *"`；免费版最小间隔 1 分钟，签到随 Cron 检查无需单独 trigger |

---

## 五、常见问题

**Q：登录一直 403 / 返回 HTML？**
站点前置的 Cloudflare 防护可能拦截了 Workers 数据中心 IP。可尝试：① 重新 deploy 换分配出口；② 若站点支持，改用 Discourse User API Key（需自行扩展 `discourse.js`，用 `User-Api-Key` 请求头替代 Cookie/CSRF）；③ 联系站长为该账号放行。

**Q：为什么有的通知没有回复？**
当前处理四类通知：`mentioned`（4）、`group_mentioned`（15）、`replied`（1）、`private_message`（6）（数值以站点 /site.json 动态返回为准）。引用（`quoted`）与"你关注主题有新帖"（`posted`）默认不处理：需要的话把对应名字加入 `index.js` 顶部的 `PROCESS_TYPE_NAMES` 列表即可。另外：同一楼层的多张重复通知只回复一次；机器人自己楼层产生的通知不处理。

**Q：私信是怎么回复的？需要额外配置吗？**
不需要。Discourse 私信本质也是普通主题（仅参与者可见），机器人收到 `private_message` 通知后用与回帖相同的 `/posts.json` 接口回复同一私信主题。前提是机器人账号是私信参与者（被拉入或收件人），这正是收到通知的含义。私信里的文字、图片、视频同样按普通消息处理。

**Q：AI 能看懂图片吗？**
图片以 base64 `image_url` 传入，**模型本身必须支持视觉**才能理解图片；纯文本模型只会看到文字部分。视频仅以链接形式写入提示词。

**Q：签到失败/收不到签到结果？**
先手动 `curl "/checkin?key=<RUN_TOKEN>"` 看返回：① 返回非 JSON（被防护拦截）→ 见上一条；② `未解析到 csrf-token` → 会话未登录成功，检查密码/2FA；③ 返回 `success: false` → 看具体 message（可能今日已签过、或签到插件变更）。自动签到失败会在当日随每分钟 Cron 自动重试最多 5 次，次日重置；改签到时间改 `CHECKIN_HOUR`（北京时间）。

**Q：联网搜索（web_search 工具）怎么开？**
这是 mimo（小米）类端点的服务端联网搜索能力：设 `AI_WEB_SEARCH = "1"` 并把 `AI_MODEL` 换成 `mimo-v2.5-pro` 这类模型，请求体会自动注入 `tools: [{ type: "web_search", max_keyword, force_search, limit }]` 和 `tool_choice: "auto"`。想要每条回复都联网设 `AI_WEB_SEARCH_FORCE = "1"`，否则由模型自主判断。⚠️ 普通 OpenAI/DeepSeek/GLM 官方端点不支持该格式，开启会报 4xx，报错后关掉即可。搜索结果由服务端注入上下文，机器人侧无需处理 tool_calls。

**Q：被锁跳过的轮次会丢消息吗？别的用户的回复怎么办？**
不会丢。跳过只影响当轮：通知水位线没有推进，下一轮（≤1 分钟）会把积压的所有提及/回复/私信全部处理。运行锁的意义是防止两轮**同时**处理同一批消息造成重复回复，不是丢弃消息。极端情况下一轮卡满 5 分钟（锁 TTL），锁也会自动过期放行，由楼层占坑标记 + 服务端查重继续防重。

**Q：为什么用 Durable Object 而不是 D1 / Containers？**
锁和"占坑标记"需要的是**强一致的 check-then-set**：Durable Object 对同一实例串行处理请求，读改写天然原子，正是这个场景的正确原语，且 SQLite-backed DO 免费套餐可用。D1 是 SQL 数据库，适合关系数据与复杂查询，这里用不上还多一跳网络；Containers 需要付费计划且用于跑真实进程（自定义运行时/长任务），本机器人纯状态管理用不到。若不想用 DO，删除 wrangler.toml 里的 `[[durable_objects]]` 与 `[[migrations]]` 两段即可，机器人自动退回 KV 尽力而为模式，服务端查重仍然兜底。

**Q：为什么之前会出现重复回复？现在怎么防的？**
根源在运行模型：Cron 每分钟触发，而一轮处理（AI 响应 + 多条通知限速间隔）可能超过 1 分钟，新实例会与旧实例并发；同时 KV 是最终一致的（写入后跨节点传播最长约 60 秒，读取可能命中边缘缓存），导致水位线/去重集合读到旧值，本地去重失效。现在共五层防线：运行锁（DO 强一致）→ 楼层占坑标记（写前 claim，有标记不回复）→ AI 调用前服务端查重 → 发帖前 fresh 服务端查重 → 水位线 + 帖子级去重。其中服务端查重直接问论坛"机器人是否已回复过该楼层"（查主题里是否存在机器人所发、reply_to 指向该楼层的帖子），完全绕开 KV 延迟问题；占坑标记则让后到的实例连 AI 都不调。若你在旧版本观察到重复回复，重新部署本版本即可；日志中出现"已有处理标记……跳过"或"服务端查重：已回复过该楼层，跳过"即为拦截生效。

**Q：回复失败提示 rate limit？**
论坛有发帖频率限制。调大 `REPLY_DELAY_MS`，或降低 Cron 频率（改 `wrangler.toml` 的 crons）。

**Q：会话多久过期一次？**
带 `remember=true` 登录后 Cookie 有效期约一年（Discourse 默认），期间 KV 会话无缝续期；即使过期也会自动重新登录，无需人工干预。

**Q：费用？**
免费版 Workers：每分钟 Cron + KV 读写均在免费额度内（每天 1440 次触发，10 万次 KV 读/天），基本零成本。
