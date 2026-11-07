/**
 * 公开域防护：来源校验 + 单实例滑窗限流。
 *
 * 背景：官方文档要求 Agent 绑定自定义域名后「可无鉴权访问」，
 * 也就是 /chat 对公网完全敞开。模板原版没有任何频控，任何人都能
 * 直接 POST 烧模型 Token。这里补三层：
 *   1. Origin 白名单 —— 阻止第三方站点盗嵌 embed.js
 *   2. 每 IP / 每会话 每分钟请求数
 *   3. 单实例每日总请求数（兜底，达到即暂停服务）
 *
 * 注意：Makers Agents 按 conversation_id 粘性路由，进程内 Map 不跨实例共享，
 * 所以这是「单实例级」限流，用于挡住常规滥用；需要严格全局配额时，
 * 把计数换成平台 KV 或外部存储即可。
 */

const WINDOW_MS = 60_000;

const ipHits = new Map<string, number[]>();
const conversationHits = new Map<string, number[]>();
let dayCounter = { day: '', count: 0 };

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function trim(hits: number[], now: number): number[] {
  const cutoff = now - WINDOW_MS;
  while (hits.length && hits[0] < cutoff) hits.shift();
  return hits;
}

function hit(bucket: Map<string, number[]>, key: string, now: number, limit: number): boolean {
  const hits = trim(bucket.get(key) || [], now);
  if (hits.length >= limit) {
    bucket.set(key, hits);
    return false;
  }
  hits.push(now);
  bucket.set(key, hits);
  return true;
}

// Map 只增不减会慢慢占内存，超过阈值时清掉空桶
function sweep(now: number) {
  if (ipHits.size + conversationHits.size < 2000) return;
  for (const [k, v] of ipHits) if (!trim(v, now).length) ipHits.delete(k);
  for (const [k, v] of conversationHits) if (!trim(v, now).length) conversationHits.delete(k);
}

export function clientIp(context: any): string {
  const h = context?.request?.headers;
  if (!h || typeof h.get !== 'function') return '';
  const forwarded = h.get('x-forwarded-for') || h.get('cf-connecting-ip') || '';
  const first = forwarded.split(',')[0].trim();
  return first || h.get('x-real-ip') || '';
}

/**
 * 校验请求来源。同源 iframe 的 Origin 是 Agent 自己的域，
 * 宿主站的 Origin 是博客域，两者都要放行；本地开发端口也放行。
 * 没有 Origin 头的请求（curl / 服务端调用）放行，交给限流兜底。
 */
export function checkOrigin(context: any, env: Env): string | null {
  const h = context?.request?.headers;
  if (!h || typeof h.get !== 'function') return null;

  const origin = (h.get('origin') || '').replace(/\/$/, '');
  if (!origin) return null;

  const defaults = [
    'https://blog.liliee.cn',
    'https://chat.liliee.cn',
    'http://localhost:8088',
    'http://127.0.0.1:8088',
  ];
  const allowed = (env.ALLOWED_ORIGINS || defaults.join(','))
    .split(',')
    .map(s => s.trim().replace(/\/$/, ''))
    .filter(Boolean);

  return allowed.includes(origin) ? null : '请求来源未被允许。';
}

export function checkRateLimit(
  ip: string,
  conversationId: string,
  env: Env,
): string | null {
  const now = Date.now();
  sweep(now);

  const perIp = num(env, 'RATE_PER_MINUTE_IP', 12);
  const perConv = num(env, 'RATE_PER_MINUTE_CONV', 20);
  const perDay = num(env, 'RATE_PER_DAY', 500);

  const ipKey = ip || `conv:${conversationId || 'anonymous'}`;
  if (!hit(ipHits, ipKey, now, perIp)) {
    return '提问太频繁了，请稍等一分钟再试。';
  }
  if (!hit(conversationHits, conversationId || ipKey, now, perConv)) {
    return '本轮对话提问太频繁，请稍等一分钟再试。';
  }

  const day = new Date(now).toISOString().slice(0, 10);
  if (dayCounter.day !== day) dayCounter = { day, count: 0 };
  if (dayCounter.count >= perDay) {
    return '今日问答额度已用完，请明天再来。';
  }
  dayCounter.count++;

  return null;
}

export function checkMessageLength(message: string, env: Env): string | null {
  const max = num(env, 'MAX_MESSAGE_CHARS', 2000);
  return message.length > max ? `单次提问请控制在 ${max} 字以内。` : null;
}
