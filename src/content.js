/**
 * Discourse cooked HTML 内容解析 —— 提取纯文本 / 图片链接 / 视频链接
 * Workers 环境没有 DOM，这里用正则处理（cooked 是服务端生成的规范 HTML，足够可靠）。
 */

/** 相对路径转绝对路径 */
function abs(base, u) {
  if (!u) return null;
  u = u.trim();
  if (/^\/\//.test(u)) return 'https:' + u;
  try {
    return new URL(u, base).href;
  } catch {
    return null;
  }
}

/** 排除表情包小图标 */
function isEmojiImg(url, tag) {
  if (tag && /class="[^"]*emoji/i.test(tag)) return true;
  if (/\/images\/emoji\//i.test(url)) return true;
  return false;
}

/**
 * 解析 cooked HTML
 * @param {string} cooked  Discourse 帖子 cooked HTML
 * @param {string} base    论坛根 URL（补全相对路径）
 * @returns {{ text: string, images: string[], videos: string[] }}
 */
export function extractContent(cooked, base) {
  const html = cooked || '';
  const images = [];
  const videos = [];
  const seenImg = new Set();
  const pushImg = (u) => {
    const full = abs(base, u);
    if (!full || seenImg.has(full)) return;
    seenImg.add(full);
    images.push(full);
  };

  // 1) lightbox 外链大图优先（Discourse 上传图片通常是 <a class="lightbox" href="原图"><img src="缩略图">）
  for (const m of html.matchAll(/<a\b[^>]*class="[^"]*lightbox[^"]*"[^>]*>/gi)) {
    const href = /\bhref="([^"]+)"/i.exec(m[0])?.[1];
    if (href) pushImg(href);
  }

  // 2) <img> 标签（排除 emoji 与头像）
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    if (/\bclass="[^"]*(?:emoji|avatar)/i.test(tag)) continue;
    const src = /\bsrc="([^"]+)"/i.exec(tag)?.[1];
    if (src && !isEmojiImg(src, tag)) pushImg(src);
  }

  // 3) 视频：<video><source src="..."></video> 或 <video src="...">
  for (const m of html.matchAll(/<video\b[^>]*>([\s\S]*?)<\/video>/gi)) {
    const inner = m[0];
    const startTag = /^<video\b[^>]*>/i.exec(inner)?.[0] || '';
    let src =
      /<source\b[^>]*\bsrc="([^"]+)"/i.exec(inner)?.[1] ||
      /\bsrc="([^"]+)"/i.exec(startTag)?.[1]; // <video src="..."> 直写形式
    if (src) {
      const full = abs(base, src);
      if (full) videos.push(full);
    }
  }
  // OneBox 嵌入的裸视频/音频链接（<a class="attachment" href="*.mp4">）
  for (const m of html.matchAll(
    /<a\b[^>]*class="[^"]*attachment[^"]*"[^>]*href="([^"]+\.(?:mp4|webm|mov|m4v|mkv))"/gi
  )) {
    const full = abs(base, m[1]);
    if (full) videos.push(full);
  }

  // 4) 纯文本：剔除媒体与脚本标签 → 块级标签转换行 → strip 其余标签 → 实体解码
  let text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|blockquote|pre|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&hellip;/gi, '…')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, images, videos };
}

/** ArrayBuffer → base64（分块避免栈溢出） */
export function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** 截断 AI 回复，防止超出论坛发帖长度限制 */
export function clampReply(text, max = 7000) {
  const t = (text || '').trim();
  return t.length > max ? t.slice(0, max) + '\n\n（内容过长已截断）' : t;
}
