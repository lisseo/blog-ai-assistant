/**
 * API Proxy — Dynamic tool executor for user-provided REST APIs.
 *
 * Loads the user's API schema from one of three sources (checked in order):
 *   1. DATA_API_SCHEMA env var — inline JSON string
 *   2. DATA_API_SCHEMA_URL env var — remote URL to fetch JSON from
 *   3. Local file — api-schema.json in the project root
 *
 * Then converts the schema into OpenAI-compatible tool definitions
 * and provides a callTool() function to proxy requests to the user's backend.
 */
import { createLogger } from './_shared';
import { readFile } from 'fs/promises';
import { resolve } from 'path';

const logger = createLogger('api-proxy');

// ─── Types ───────────────────────────────────────────────────────────────────
export interface ApiToolParam {
  type: string;
  description?: string;
  required?: boolean;
  default?: any;
  enum?: string[];
}

export interface ApiToolDef {
  name: string;
  description: string;
  endpoint: string; // e.g. "GET /posts/{id}"
  parameters: Record<string, ApiToolParam>;
}

export interface ApiSchema {
  tools: ApiToolDef[];
}

// ─── Schema loading (cached per process) ─────────────────────────────────────
let _schemaCache: ApiSchema | null = null;
let _schemaLoadAttempted = false;

const SCHEMA_FILE_NAMES = ['api-schema.json', 'public/api-schema.json'];

/**
 * 内置兜底 schema。
 * Makers Agent 运行时的工作目录不一定是项目根，api-schema.json 也不一定
 * 会随构建产物一起上传（实测线上就出现了 "no API schema found"，
 * AI 直接告诉访客「没有挂载 search_posts 工具」）。
 * 因此把本博客的两个检索工具写死在这里：三种外部来源全部失败时仍可用。
 * 想完全禁用工具，把环境变量 DATA_API_SCHEMA 设成合法但 tools 为空的 JSON。
 */
const BUILTIN_SCHEMA: ApiSchema = {
  tools: [
    {
      name: 'search_posts',
      description: '读取 blog.liliee.cn 的全站文章索引，返回每篇文章的 id、标题、日期、分类、标签、摘要和完整链接。当用户问「有没有讲 X 的文章」「帮我找某篇」「这个站都写了什么」「列一下文章」时调用。这是静态 JSON 文件，一次返回全部文章，请自己按关键词筛选，不要反复调用。',
      endpoint: 'GET /ai-index.json',
      parameters: {
        q: {
          type: 'string',
          description: '用户想找的关键词。仅作提示用，服务端返回全量索引，需要自行筛选。',
        },
      },
    },
    {
      name: 'get_post',
      description: '按 id 读取某一篇文章的纯文本全文，用于回答具体步骤、命令、配置值等细节。必须先用 search_posts 拿到 id 再调用，不要猜测 id。',
      endpoint: 'GET /ai/{id}.json',
      parameters: {
        id: {
          type: 'string',
          description: '文章 id，取自 search_posts 返回结果里的 id 字段，例如 fc6b5872',
          required: true,
        },
      },
    },
  ],
};

function useBuiltin(reason: string): ApiSchema {
  logger.log(`[schema] ${reason}，使用内置兜底 schema（${BUILTIN_SCHEMA.tools.length} 个工具）`);
  _schemaCache = BUILTIN_SCHEMA;
  return BUILTIN_SCHEMA;
}

export async function loadApiSchema(env: Record<string, string | undefined>): Promise<ApiSchema | null> {
  if (_schemaLoadAttempted) return _schemaCache;
  _schemaLoadAttempted = true;

  // Priority 1: Inline JSON schema via env var
  if (env.DATA_API_SCHEMA) {
    try {
      _schemaCache = JSON.parse(env.DATA_API_SCHEMA);
      logger.log(`[schema] loaded inline schema with ${_schemaCache!.tools.length} tools`);
      return _schemaCache;
    } catch (e) {
      logger.error('[schema] failed to parse DATA_API_SCHEMA:', (e as Error).message);
      return useBuiltin('配置读取失败');
    }
  }

  // Priority 2: Remote schema URL
  if (env.DATA_API_SCHEMA_URL) {
    try {
      const res = await fetch(env.DATA_API_SCHEMA_URL, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      _schemaCache = await res.json() as ApiSchema;
      logger.log(`[schema] loaded remote schema with ${_schemaCache!.tools.length} tools`);
      return _schemaCache;
    } catch (e) {
      logger.error('[schema] failed to fetch DATA_API_SCHEMA_URL:', (e as Error).message);
      return useBuiltin('配置读取失败');
    }
  }

  // Priority 3: Local file (api-schema.json in project root or public/)
  for (const fileName of SCHEMA_FILE_NAMES) {
    try {
      const filePath = resolve(process.cwd(), fileName);
      const content = await readFile(filePath, 'utf-8');
      _schemaCache = JSON.parse(content);
      logger.log(`[schema] loaded local file "${fileName}" with ${_schemaCache!.tools.length} tools`);
      return _schemaCache;
    } catch {
      // File not found or not accessible — try next
    }
  }

  return useBuiltin('配置读取失败');
}

// ─── Execute a tool call by proxying to user's API ───────────────────────────
export async function callTool(
  schema: ApiSchema,
  baseUrl: string,
  apiKey: string | undefined,
  toolName: string,
  input: Record<string, any>,
): Promise<any> {
  const toolDef = schema.tools.find((t) => t.name === toolName);
  if (!toolDef) {
    return { error: `Unknown tool: ${toolName}` };
  }

  // Validate required parameters
  for (const [name, param] of Object.entries(toolDef.parameters)) {
    if (param.required && (input[name] === undefined || input[name] === null || input[name] === '')) {
      return { error: `Missing required parameter: ${name}`, hint: `The "${name}" parameter is required for tool "${toolName}". ${param.description || ''}` };
    }
  }

  // Parse endpoint: "GET /posts/{id}" → method + path
  const [method, pathTemplate] = toolDef.endpoint.split(' ', 2);
  const httpMethod = (method || 'GET').toUpperCase();

  // Substitute path parameters
  let path = pathTemplate || '/';
  const queryParams: Record<string, string> = {};
  const usedParams = new Set<string>();

  // Replace {param} in path
  path = path.replace(/\{(\w+)\}/g, (_, key) => {
    usedParams.add(key);
    return encodeURIComponent(String(input[key] ?? ''));
  });

  // Remaining params go as query string (for GET) or body (for POST/PUT)
  for (const [key, value] of Object.entries(input)) {
    if (!usedParams.has(key) && value !== undefined && value !== null) {
      queryParams[key] = String(value);
    }
  }

  // Build URL
  let url = baseUrl.replace(/\/$/, '') + path;
  if (httpMethod === 'GET' && Object.keys(queryParams).length > 0) {
    url += '?' + new URLSearchParams(queryParams).toString();
  }

  // Build headers
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  // Build fetch options
  const fetchOpts: RequestInit = { method: httpMethod, headers, signal: AbortSignal.timeout(15000) };
  if (httpMethod !== 'GET' && Object.keys(queryParams).length > 0) {
    headers['Content-Type'] = 'application/json';
    fetchOpts.body = JSON.stringify(queryParams);
  }

  logger.log(`[call] ${httpMethod} ${url}`);

  try {
    const res = await fetch(url, fetchOpts);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: `API returned ${res.status}`, detail: text.slice(0, 500) };
    }
    const data = await res.json();
    return data;
  } catch (e) {
    return { error: `Request failed: ${(e as Error).message}` };
  }
}
