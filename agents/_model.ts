/**
 * Model & Gateway configuration
 *
 * Makers Models 内置模型（国内站 2026-11 现行清单）：
 *   @makers/hy3, @makers/hy3-preview,
 *   @makers/deepseek-v4-pro, @makers/deepseek-v4-flash, @makers/deepseek-v4.1-flash,
 *   @makers/minimax-m3, @makers/minimax-m2.7,
 *   @makers/kimi-k2.6, @makers/zhuque-text
 *
 * 早期文档里的 @makers/deepseek-v3 已下线，传它网关直接返回
 * "Unsupported managed model"，整条问答链路会变成只回错误文本。
 * 这里做一次兜底：控制台里若还留着旧的 / 拼错的 @makers/ 模型名，
 * 自动回退到可用的内置模型，避免必须改一次环境变量才能恢复服务。
 * 自带厂商 Key（BYOK）的模型名不带 @makers/ 前缀，原样放行。
 */
const DEFAULT_MODEL = '@makers/deepseek-v4-flash';

const BUILTIN_MODELS = new Set([
  '@makers/hy3',
  '@makers/hy3-preview',
  '@makers/deepseek-v4-pro',
  '@makers/deepseek-v4-flash',
  '@makers/deepseek-v4.1-flash',
  '@makers/minimax-m3',
  '@makers/minimax-m2.7',
  '@makers/kimi-k2.6',
  '@makers/zhuque-text',
]);

export function resolveModelName(env?: Record<string, string | undefined>): string {
  const configured = (env?.AI_GATEWAY_MODEL || '').trim();
  if (!configured) return DEFAULT_MODEL;
  if (!configured.startsWith('@makers/')) return configured; // BYOK / 第三方网关
  if (BUILTIN_MODELS.has(configured)) return configured;
  if (typeof console !== 'undefined') {
    console.warn(`[model] 不支持的内置模型 "${configured}"，回退到 ${DEFAULT_MODEL}`);
  }
  return DEFAULT_MODEL;
}
