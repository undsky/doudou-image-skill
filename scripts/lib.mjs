// doudou-image-skill 共用工具：配置、HTTP、错误翻译、产物落盘、PNG 头解析。
// generate.mjs 和 edit.mjs 均从这里引用，直接对接 New API / 原生 OpenAI 图像接口。
//
// 为什么是 Node 脚本而不是直接 curl：Windows PowerShell 5.1 里 `curl` 是
// Invoke-WebRequest 的别名，不认 -F，编辑接口的 multipart 上传直接失败；
// 脚本内置支持 base64 与 URL 下载，自动落盘成文件，不进终端或上下文。
// Node 18+ 自带 fetch / FormData / Blob，无任何第三方依赖。

import { stat, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_BASE_URL = 'https://qkmss.com';
export const DEFAULT_MODEL = 'gpt-image-2';
export const ENDPOINTS = { generate: '/v1/images/generations', edit: '/v1/images/edits' };
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// size 的实情（据 docs.newapi.pro 的 images 接口文档 + 实测）：
//   生成接口只列 1024x1024 / 1536x1024 / 1024x1536 / auto（gpt-image-1 系）；
//   编辑接口只列 256x256 / 512x512 / 1024x1024；
//   而 256x256 / 512x512 传给本服务的模型一律回一个不带信息的裸 400。
// 所以：1024x1024 是唯一实测可用值，两个死值本地拦掉，其余放行但警告（换模型可能就支持了）。
export const SIZE_ALIASES = { '1k': '1024x1024', '2k': '2048x2048', '4k': '4096x4096' };
export const KNOWN_GOOD_SIZE = '1024x1024';
export const DEAD_SIZES = ['256x256', '512x512'];

/** 归一化 size：1K/2K/4K（大小写随意）→ 像素串；像素串里的 X / × 统一成小写 x。没给则返回 undefined。 */
export function normalizeSize(rawSize) {
  if (rawSize === undefined || rawSize === null) return undefined;
  const s = String(rawSize).trim();
  if (!s) return undefined;
  const alias = SIZE_ALIASES[s.toLowerCase()];
  if (alias) return alias;
  return s.replace(/^(\d+)\s*[xX×]\s*(\d+)$/, (_, w, h) => `${w}x${h}`);
}

/** 校验 --size：形状必须是 <宽>x<高>，死值直接拦，未经实测的值放行但警告。返回 undefined 表示别下发。 */
export function parseSizeArg(raw, endpoint) {
  const size = normalizeSize(raw);
  if (!size) return undefined;
  if (!/^\d+x\d+$/.test(size)) {
    throw new Fail(
      `--size 认不出：${raw}`,
      `写法是 1K / 2K / 4K，或具体像素如 ${KNOWN_GOOD_SIZE}`,
    );
  }
  if (DEAD_SIZES.includes(size)) {
    throw new Fail(
      `--size ${size} 传上去必定失败`,
      `${DEAD_SIZES.join(' / ')} 是 dall-e-2 时代的遗留值，本服务的模型只吃 ${KNOWN_GOOD_SIZE}，上游只会回一个不带信息的裸 400`,
    );
  }
  if (size !== KNOWN_GOOD_SIZE) {
    info(`注意：${size} 未经实测，部分模型只支持 ${KNOWN_GOOD_SIZE}；上游若回 400 就改用 ${KNOWN_GOOD_SIZE}${endpoint === 'edit' ? '，或干脆不传 --size' : ''}`);
  }
  return size;
}

// 上限按接口文档来（生成 prompt 32000/n 10、编辑 prompt 1000/n 10），不再沿用旧 n8n 端点的服务端校验值
export const PROMPT_MAX = { generate: 32000, edit: 1000 };
export const N_MAX = { generate: 10, edit: 10 };
const ROOT_MARKERS = ['.agents', '.claude', '.git'];
const EXT_OF = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

export class Fail extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

/** 查找 .env 配置文件：默认查找技能目录（scripts/ 的上一级），如果没有，依次向上查找（最多向上找 3 级）。 */
export function findEnvFile() {
  const primary = join(SKILL_DIR, '.env');
  if (existsSync(primary)) return primary;
  let curr = SKILL_DIR;
  for (let i = 0; i < 3; i++) {
    curr = resolve(curr, '..');
    const candidate = join(curr, '.env');
    if (existsSync(candidate)) return candidate;
  }
  return primary;
}

// ---- 配置：命令行 > 环境变量 > .env ----
function readDotEnv() {
  const path = findEnvFile();
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
}

/**
 * 把用户给的地址收敛成服务根（不含 /v1 和端点路径）。
 * 兼容裸域名、带尾斜杠、带 /v1、以及已经是某个完整端点的写法 —— 后者必须剥掉，
 * 否则拿生成端点去拼编辑端点会串成 /v1/images/generations/v1/images/edits。
 */
export function apiRoot(rawUrl) {
  let base = (rawUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  for (const path of Object.values(ENDPOINTS)) {
    if (base.toLowerCase().endsWith(path.toLowerCase())) {
      return base.slice(0, -path.length);
    }
  }
  return base.replace(/\/v1$/i, '');
}

/** 拼完整端点 URL。任何输入先过 apiRoot 收敛，保证 generate / edit / doctor 三处口径一致。 */
export function buildEndpointUrl(rawUrl, endpoint) {
  return `${apiRoot(rawUrl)}${ENDPOINTS[endpoint]}`;
}

// 通用（非本 skill 专属）的键名：可能是给 openai.com 官方端点准备的，不能想当然拿来配中转站。
const GENERIC_URL_KEYS = new Set(['OPENAI_BASE_URL']);
const GENERIC_KEY_KEYS = new Set(['OPENAI_API_KEY']);

export function resolveConfig(flags, endpoint) {
  const dotEnv = readDotEnv();
  const pick = (flagValue, ...envKeys) => {
    if (flagValue) return { value: flagValue, source: '命令行', envKey: '' };
    for (const envKey of envKeys) {
      if (process.env[envKey]) return { value: process.env[envKey], source: `环境变量 $${envKey}`, envKey };
      if (dotEnv[envKey]) return { value: dotEnv[envKey], source: `.env (${envKey})`, envKey };
    }
    return { value: '', source: '', envKey: '' };
  };

  const rawUrl = pick(flags.url, 'IMAGE_API_URL', 'DOUDOU_IMAGE_API_URL', 'DOUDOU_API_URL', 'OPENAI_BASE_URL');
  const rawKey = pick(flags.key, 'IMAGE_API_KEY', 'DOUDOU_IMAGE_API_KEY', 'DOUDOU_API_KEY', 'OPENAI_API_KEY');
  const models = pick(flags.models, 'IMAGE_API_MODELS', 'IMAGE_API_MODEL', 'DOUDOU_IMAGE_MODELS', 'DOUDOU_IMAGE_MODEL', 'IMAGE_MODEL');

  const baseUrl = apiRoot(rawUrl.value);
  const url = buildEndpointUrl(baseUrl, endpoint);

  // 防凭证外泄：$OPENAI_API_KEY 这类通用键很可能是 openai.com 的真凭证。
  // 只有在服务地址也是显式配过的（命令行 / IMAGE_API_URL / OPENAI_BASE_URL）时才认，
  // 否则它会被原样发往 DEFAULT_BASE_URL 这个第三方中转站。
  const urlIsExplicit = Boolean(rawUrl.value);
  const keyIsGeneric = GENERIC_KEY_KEYS.has(rawKey.envKey);
  const keyBlocked = keyIsGeneric && !urlIsExplicit
    ? { source: rawKey.source, envKey: rawKey.envKey }
    : null;

  const modelList = (models.value || DEFAULT_MODEL)
    .split(/[,，\s]+/)
    .map((m) => m.trim())
    .filter(Boolean);

  return {
    baseUrl,
    url,
    urlSource: urlIsExplicit ? rawUrl.source : '默认值',
    urlIsExplicit,
    urlIsGeneric: GENERIC_URL_KEYS.has(rawUrl.envKey),
    key: keyBlocked ? '' : rawKey.value.trim(),
    keySource: keyBlocked ? '' : rawKey.source,
    keyBlocked,
    envFile: findEnvFile(),
    modelList: modelList.length ? modelList : [DEFAULT_MODEL],
    modelsSource: models.value ? models.source : '默认值',
    defaultModel: modelList[0] || DEFAULT_MODEL,
  };
}

/**
 * 确定本次请求实际使用的模型：
 * 1. 若命令行显式传了 --model，直接使用；
 * 2. 若仅配置了 1 个模型，直接使用（无需询问用户）；
 * 3. 若配置了多个模型且未指定：
 *    - 交互式终端 (TTY)：提供编号交互选择；
 *    - 非交互终端（如 AI/脚本）：抛出 Fail 错误，列出所有可选模型，要求指定 --model。
 */
export async function resolveModel(flags, modelList) {
  if (flags.model) {
    return String(flags.model).trim();
  }
  if (!modelList || modelList.length === 0) {
    return DEFAULT_MODEL;
  }
  if (modelList.length === 1) {
    return modelList[0];
  }

  // 交互式终端 (TTY) 提示选择
  if (process.stdin.isTTY) {
    info(`当前配置了 ${modelList.length} 个可用模型，请选择（直接回车默认第 1 项）：`);
    for (let i = 0; i < modelList.length; i++) {
      info(`  ${i + 1}) ${modelList[i]}`);
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = (await rl.question(`请输入模型序号 (1-${modelList.length}) [1]: `)).trim();
      const idx = answer ? parseInt(answer, 10) - 1 : 0;
      if (Number.isInteger(idx) && idx >= 0 && idx < modelList.length) {
        return modelList[idx];
      }
      info(`输入不合法，已使用默认模型：${modelList[0]}`);
      return modelList[0];
    } finally {
      rl.close();
    }
  }

  // 非交互终端：列出选项报错
  throw new Fail(
    `未指定使用哪个模型。当前配置了 ${modelList.length} 个可用模型：${modelList.join('、')}`,
    `请向用户确认后，使用 --model <名字> 显式指定。\n可选模型：\n${modelList.map((m, i) => `  ${i + 1}. ${m}`).join('\n')}`,
  );
}

// ---- 展示辅助 ----
export const humanBytes = (n) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '未知大小';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
};

// 进度、警告、摘要一律走 stderr：stdout 只留产物路径，调用方可以直接管道接走
export const info = (text) => console.error(text);

export const timestamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// 从 prompt 开头取一段当文件名主干。中文保留，路径分隔符和控制字符去掉。
export function safeStem(text, limit = 24) {
  const bad = new Set('/\\:*?"<>|');
  let out = '';
  for (const ch of String(text || '').trim()) {
    const code = ch.codePointAt(0);
    if (code < 32 || code === 127) continue;
    out += bad.has(ch) ? '_' : ch;
  }
  const trim = ' ._,;:!?，。、；：！？「」『』（）"\'“”‘’…—-';
  const strip = (s) => {
    let a = 0;
    let b = s.length;
    while (a < b && trim.includes(s[a])) a += 1;
    while (b > a && trim.includes(s[b - 1])) b -= 1;
    return s.slice(a, b);
  };
  return strip(strip(out).slice(0, limit)) || 'image';
}

/** 从当前工作目录向上找 .agents / .claude / .git，找不到就用当前目录。 */
export function findProjectRoot() {
  let dir = process.cwd();
  for (;;) {
    if (ROOT_MARKERS.some((m) => existsSync(join(dir, m)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

// ---- HTTP ----
function causeChain(error) {
  const codes = [];
  const visit = (node, depth) => {
    if (!node || depth > 4) return;
    if (node.code) codes.push(String(node.code));
    if (node.name) codes.push(String(node.name));
    if (node.cause) visit(node.cause, depth + 1);
    if (Array.isArray(node.errors)) for (const child of node.errors) visit(child, depth + 1);
  };
  visit(error, 0);
  if (error?.message) codes.push(error.message);
  return codes.join(' ');
}

/** POST 到上游 API，返回 { status, json }。网络层失败翻译成可指导修复的提示。 */
export async function post(config, body, { timeoutMs, isJson }) {
  const headers = {
    Accept: '*/*',
  };
  if (config.key) {
    headers['Authorization'] = config.key.startsWith('Bearer ') ? config.key : `Bearer ${config.key}`;
  }
  if (isJson) headers['Content-Type'] = 'application/json';

  let response;
  let text;
  try {
    response = await fetch(config.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    const chain = causeChain(error);
    if (/TimeoutError|AbortError|HeadersTimeoutError|BodyTimeoutError/i.test(chain)) {
      throw new Fail(
        `等了 ${Math.round(timeoutMs / 1000)} 秒没等到响应`,
        '实测生图约 15-40 秒、修图 20-70 秒。可用 --timeout 加长等待时间',
      );
    }
    if (/ECONNREFUSED/i.test(chain)) {
      throw new Fail(`连不上接口地址：${config.url}`, '检查服务地址是否拼写正确，或网络是否通畅');
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(chain)) {
      throw new Fail(`域名解析不了：${config.url}`, '检查 IMAGE_API_URL 拼写');
    }
    if (/ECONNRESET|EPIPE|UND_ERR_SOCKET/i.test(chain)) {
      throw new Fail(
        `连接被断开：${config.url}`,
        '可能请求体过大或上游网关切断连接。请控制图片在 4MB 以内',
      );
    }
    throw new Fail(`请求失败：${chain}`);
  }

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应（网关 502/504 错误页之类）留给下面按状态码处理 */
  }
  if (!json) {
    if (response.status === 404) {
      throw new Fail(
        `端点不存在（404）：${config.url}`,
        '请检查服务地址 IMAGE_API_URL 是否配置正确（填服务根地址即可，端点路径由脚本拼接）',
      );
    }
    // 网关超时/故障时回的是 HTML 错误页（Cloudflare 的 502/504/524 等）。
    // 直接把 300 字符 HTML 糊给用户没有信息量，按状态码说人话。
    const isHtml = /^\s*(<!doctype html|<html)/i.test(text);
    if (isHtml && [502, 503, 504, 520, 521, 522, 523, 524].includes(response.status)) {
      const who = response.status === 524 || response.status === 504
        ? '上游出图太慢，网关先断开了'
        : '网关连不上上游服务';
      throw new Fail(
        `网关错误（HTTP ${response.status}）：${who}`,
        `这是服务端/网关的问题，本地改 --timeout 通常没用（卡在网关那一侧，实测它约 70-130 秒就放弃）。\n`
        + `稍后重试；若持续如此，用 --doctor 看服务是否整体不可用，或换 --model 试另一条上游渠道。`,
      );
    }
    throw new Fail(
      `响应不是 JSON（HTTP ${response.status}）`,
      `${isHtml ? '返回的是 HTML 页面，通常意味着地址指向了网页而不是 API 端点。' : ''}响应开头：${text.slice(0, 200).replace(/\s+/g, ' ')}`,
    );
  }
  return { status: response.status, json };
}

// 错误翻译：按 New API / OpenAI 接口规范与 HTTP 状态码解释错误
export function explain(status, json, config, notes = {}) {
  const errorObj = json?.error;
  let message = '未知错误';
  let code = '';
  let type = '';

  if (typeof errorObj === 'string') {
    message = errorObj;
  } else if (errorObj && typeof errorObj === 'object') {
    message = errorObj.message || json?.message || json?.detail || '未知错误';
    code = errorObj.code || '';
    type = errorObj.type || '';
  } else if (json?.message) {
    message = json.message;
  }

  const parts = [`接口返回失败（HTTP ${status}${code ? `，code=${code}` : ''}${type ? `，type=${type}` : ''}）：${message}`];

  // 注意：New API 用 503 报 model_not_found（"当前分组下无可用渠道"），这是配置问题、不是抖动。
  // 先按 code / message 判，再退回按状态码判 —— 否则它会被 5xx 分支说成"稍后重试"，
  // 让人白等一轮又一轮。
  const looksLikeModelMissing = /model_not_found|无可用渠道|no available channel/i.test(`${code} ${message}`);

  const hints = [];
  if (looksLikeModelMissing) {
    hints.push(
      `模型不可用（不是上游抖动，重试不会好）：当前分组下 [${notes.model || '所选模型'}] 没有可用渠道。`
      + `\n换一个模型（--model <名字>），或在服务商后台为该模型开渠道。`
      + `\n用 --models 看本地配了哪些，用 --doctor 看服务端实际有哪些。`,
    );
  } else if (status === 401 || status === 403) {
    hints.push(config.key
      ? `API Key 认证未通过（来自${config.keySource}）。请检查凭证是否正确有效、额度是否充足。`
      : '未配置 API Key。请在 <技能目录>/.env 中配置 IMAGE_API_KEY，或在命令行使用 --key <token>。');
  } else if (status === 404) {
    hints.push(`端点不存在（404）：${config.url}。请检查服务地址 IMAGE_API_URL 是否正确（填服务根地址即可，端点路径由脚本拼接）。`);
  } else if (status === 429) {
    hints.push('请求受限（429）：API 速率超限或账户额度已耗尽，请稍后再试或检查账户余额。');
  } else if (status >= 500) {
    hints.push('上游服务暂时不可用（5xx），可能是上游服务器抖动，请稍后重试。');
  }

  // 调用方给的排查线索对所有状态码都有用（尺寸、mask、模型能力等），不再只在 400 时保留
  if (Array.isArray(notes.suggestions) && notes.suggestions.length) {
    hints.push(`建议排查：\n${notes.suggestions.map((s) => `  · ${s}`).join('\n')}`);
  }

  return new Fail(parts.join('\n'), hints.join('\n'));
}

/** 解析上游返回的单条图片数据（兼容 b64_json 与 url 两种形态） */
export async function parseImageData(item) {
  if (!item || typeof item !== 'object') {
    throw new Fail('上游返回的图片项格式非法', JSON.stringify(item).slice(0, 200));
  }
  if (item.b64_json) {
    const buffer = Buffer.from(item.b64_json, 'base64');
    const mime = sniffMime(buffer) || 'image/png';
    return {
      buffer,
      mime_type: mime,
      b64_json: item.b64_json,
      bytes: buffer.length,
    };
  }
  if (item.url) {
    let resp;
    try {
      resp = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
    } catch (e) {
      throw new Fail(`下载上游生成的图片失败：${item.url}`, e.message);
    }
    if (!resp.ok) {
      throw new Fail(`下载上游图片返回 HTTP ${resp.status}：${item.url}`);
    }
    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mime = sniffMime(buffer) || 'image/png';
    // 不再顺手转一份 base64：落盘只用 buffer，多张大图时这份字符串纯属白占内存
    return {
      buffer,
      mime_type: mime,
      bytes: buffer.length,
      sourceUrl: item.url,
    };
  }
  throw new Fail('上游数据项中既没有 b64_json 也没有 url', JSON.stringify(item).slice(0, 200));
}

// ---- 产物落盘 ----
function targetPaths(images, flags, stem) {
  const ext = (i) => EXT_OF[images[i].mime_type] || '.png';
  const out = String(flags.output || '');

  if (!out) {
    const dir = join(findProjectRoot(), 'resources', 'images');
    const stamp = timestamp();
    return images.map((_, i) => join(dir, `${stem}-${stamp}${images.length > 1 ? `-${i + 1}` : ''}${ext(i)}`));
  }
  // 以分隔符结尾、或已经是个目录：当目录用，里面自动命名
  const asDir = /[\\/]$/.test(out) || (() => {
    try { return statSync(out).isDirectory(); } catch { return false; }
  })();
  if (asDir) {
    const stamp = timestamp();
    return images.map((_, i) => join(out, `${stem}-${stamp}${images.length > 1 ? `-${i + 1}` : ''}${ext(i)}`));
  }
  // 单文件：原样用用户给的路径（扩展名不改，只在对不上时警告）
  if (images.length === 1) return [resolve(out)];
  // 多张但给了具体文件名：在扩展名前插序号，避免互相覆盖
  const base = resolve(out);
  const suffix = extname(base);
  const head = suffix ? base.slice(0, -suffix.length) : base;
  return images.map((_, i) => `${head}-${i + 1}${suffix || ext(i)}`);
}

/** 把图片写成文件，返回落盘后的绝对路径数组。 */
export async function saveImages(images, flags, stem) {
  const paths = targetPaths(images, flags, stem);
  const saved = [];
  for (const [i, image] of images.entries()) {
    const path = paths[i];
    await mkdir(dirname(path), { recursive: true });
    const buffer = image.buffer || Buffer.from(image.b64_json, 'base64');
    await writeFile(path, buffer);
    const want = EXT_OF[image.mime_type] || '.png';
    if (extname(path).toLowerCase() !== want) {
      info(`注意：${path} 的扩展名和实际格式对不上 —— 文件内容是 ${image.mime_type}（正常应为 ${want}），已按你给的路径原样写入，未做转换`);
    }
    saved.push({ path, mime_type: image.mime_type, bytes: buffer.length });
  }
  return saved;
}

// ---- 图片与 mask 本地预检 ----
export function sniffMime(buffer) {
  const head = buffer;
  if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.slice(0, 6).toString('latin1'))) return 'image/gif';
  if (head.length >= 12 && head.slice(0, 4).toString('latin1') === 'RIFF' && head.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** 读 PNG 的尺寸 + 颜色类型，并看有没有 tRNS（调色板图的透明信息在这个 chunk 里）。 */
export function readPngInfo(buffer) {
  if (!buffer || buffer.length < 26) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buffer.slice(12, 16).toString('latin1') !== 'IHDR') return null;
  const info = {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colorType: buffer[25],
    hasTrns: false,
  };
  let off = 8;
  while (off + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(off);
    const type = buffer.slice(off + 4, off + 8).toString('latin1');
    if (type === 'tRNS') { info.hasTrns = true; break; }
    if (type === 'IDAT' || type === 'IEND') break;
    off += 12 + len;
    if (len < 0 || off <= 0) break;
  }
  return info;
}

const hasAlpha = (info) => info.colorType === 4 || info.colorType === 6 || (info.colorType === 3 && info.hasTrns);

/** 读本地图片文件并做体积/格式检查。label 用于报错文案。 */
export async function readImageFile(path, label) {
  let stats;
  try {
    stats = await stat(path);
  } catch {
    throw new Fail(`${label}不存在：${path}`);
  }
  if (stats.isDirectory()) throw new Fail(`${label}是目录：${path}`, '这个接口一次只收一个图片文件');
  if (stats.size === 0) throw new Fail(`${label}是空文件：${path}`);
  if (stats.size > MAX_IMAGE_BYTES) {
    throw new Fail(
      `${label} ${humanBytes(stats.size)}，超过 ${humanBytes(MAX_IMAGE_BYTES)} 上限`,
      '先缩小再传，例如 magick 原图 -resize 1024x1024 小图.png',
    );
  }
  const buffer = readFileSync(path);
  const mime = sniffMime(buffer);
  if (!mime) {
    throw new Fail(`${label}不像是图片：${path}`, '按魔数认不出 PNG / JPEG / WebP / GIF，确认文件未损坏');
  }
  return { path, buffer, mime, bytes: buffer.length, filename: basename(path) };
}

/** 从远程 URL 下载待编辑图片并校验 */
export async function fetchRemoteImage(url) {
  let resp;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  } catch (e) {
    throw new Fail(`下载待编辑的图片失败：${url}`, e.message);
  }
  if (!resp.ok) {
    throw new Fail(`下载待编辑的图片返回 HTTP ${resp.status}：${url}`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length === 0) {
    throw new Fail(`下载的文件是空内容：${url}`);
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Fail(
      `待编辑图片 ${humanBytes(buffer.length)}，超过 ${humanBytes(MAX_IMAGE_BYTES)} 上限`,
      '请先缩小再传，或使用本地小尺寸图片',
    );
  }
  const mime = sniffMime(buffer);
  if (!mime) {
    throw new Fail(`下载的文件不像是图片：${url}`, '按魔数认不出 PNG / JPEG / WebP / GIF');
  }
  let filename = 'remote-image.png';
  try {
    const u = new URL(url);
    filename = basename(u.pathname) || 'remote-image.png';
  } catch { /* ignore */ }
  return { path: url, buffer, mime, bytes: buffer.length, filename };
}

/**
 * mask 的三条规则本地先查：必须是带 alpha 的 PNG、尺寸和原图一致、原图也得是 PNG。
 */
export function checkMask(mask, image) {
  const maskInfo = readPngInfo(mask.buffer);
  if (!maskInfo) {
    throw new Fail('mask 必须是 PNG', `${mask.path} 按魔数是 ${mask.mime}，重新导出成 PNG`);
  }
  if (!hasAlpha(maskInfo)) {
    throw new Fail(
      'mask 必须带 alpha 透明通道',
      `透明区域 = 要重画的部分。当前 PNG colorType=${maskInfo.colorType}（需要 4/6，或带 tRNS 的 3），导出时选 RGBA`,
    );
  }
  if (image) {
    if (image.mime !== 'image/png') {
      throw new Fail('带 mask 时待编辑图必须是 PNG', `当前待编辑图是 ${image.mime}，先转成 PNG`);
    }
    const imgInfo = readPngInfo(image.buffer);
    if (!imgInfo) throw new Fail('待编辑图的 PNG 头读不出来', `确认 ${image.path} 是完整的 PNG`);
    if (imgInfo.width !== maskInfo.width || imgInfo.height !== maskInfo.height) {
      throw new Fail(
        `mask 尺寸必须和原图一致：原图 ${imgInfo.width}x${imgInfo.height}，mask ${maskInfo.width}x${maskInfo.height}`,
        '按原图尺寸重做 mask，例如 magick mask.png -resize ' + `${imgInfo.width}x${imgInfo.height}! mask-fixed.png`,
      );
    }
    return { checkedSize: true, width: imgInfo.width, height: imgInfo.height };
  }
  return { checkedSize: false, width: maskInfo.width, height: maskInfo.height };
}

// ---- 参数解析 ----
// 长得像选项的：只由 ASCII 字母/数字/点/下划线/连字符组成，如 --sizee、-x。
// 提示词里带中文、空格、标点的（-一只橘猫、'-5 度的天空'）不算，按位置参数收，
// 否则"画个 -号"这类描述根本没法传。真打错的选项名仍然会报错。
const LOOKS_LIKE_FLAG = /^-{1,2}[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseArgs(argv, spec) {
  const flags = { positional: [] };
  let onlyPositional = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (onlyPositional) { flags.positional.push(arg); continue; }
    if (arg === '--') { onlyPositional = true; continue; }
    if (spec.value[arg]) {
      const value = argv[i + 1];
      if (value === undefined) throw new Fail(`${arg} 后面要跟一个值`);
      flags[spec.value[arg]] = value;
      i += 1;
    } else if (spec.bool[arg]) {
      flags[spec.bool[arg]] = true;
    } else if (arg.startsWith('-') && arg !== '-' && LOOKS_LIKE_FLAG.test(arg)) {
      const known = [...Object.keys(spec.value), ...Object.keys(spec.bool)].join(' ');
      throw new Fail(
        `不认识的选项：${arg}`,
        `可用选项：${known}\n如果这是提示词的一部分（描述以 - 开头），在它前面加 -- ：例如 generate.mjs -- '${arg} …'`,
      );
    } else {
      flags.positional.push(arg);
    }
  }
  return flags;
}

export function parseCount(raw, endpoint) {
  if (raw === undefined) return 1;
  const max = N_MAX[endpoint];
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Fail(`-n 必须是 1 到 ${max} 的整数，收到：${raw}`, `${endpoint === 'edit' ? '编辑' : '生成'}接口的上限是 ${max}`);
  }
  return n;
}

export function parseTimeout(raw, fallbackMs) {
  if (raw === undefined) return fallbackMs;
  const seconds = Number(String(raw).trim());
  if (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600) {
    throw new Fail(`--timeout 必须是 5 到 3600 之间的秒数，收到：${raw}`);
  }
  return Math.round(seconds * 1000);
}

export function checkPrompt(prompt, endpoint) {
  const text = String(prompt || '').trim();
  if (!text) {
    throw new Fail(
      '没给提示词',
      endpoint === 'edit' ? '用法：edit.mjs <图片> <怎么改>。详见 --help' : '用法：generate.mjs <描述>。详见 --help',
    );
  }
  const max = PROMPT_MAX[endpoint];
  if (text.length > max) {
    throw new Fail(
      `提示词 ${text.length} 字，超过 ${max} 字上限`,
      endpoint === 'edit' ? '编辑接口的上限是 1000（生成接口是 8000），把描述压缩一下' : '把描述压缩一下',
    );
  }
  return text;
}

export function requireKey(config) {
  if (config.key) return;
  if (config.keyBlocked) {
    throw new Fail(
      `检测到 ${config.keyBlocked.source}，但服务地址没有显式配过，已拒绝使用它`,
      `$${config.keyBlocked.envKey} 通常是 openai.com 的凭证，而当前地址会走默认的 ${DEFAULT_BASE_URL}（第三方中转）——`
      + `把它发过去等于泄露凭证，所以这里不自动套用。\n`
      + `想用中转站：把凭证写成 IMAGE_API_KEY（<技能目录>/.env 或环境变量），或本次命令行加 --key <token>。\n`
      + `想用官方端点：显式设置 IMAGE_API_URL=https://api.openai.com（或 --url），此时 $${config.keyBlocked.envKey} 会被采用。`,
    );
  }
  throw new Fail(
    '未配置 API 访问凭证（Key）',
    '设置环境变量 IMAGE_API_KEY，或写进 <技能目录>/.env，也可以在本次命令行使用 --key <token> 传递。',
  );
}

// ---- doctor：配置和连通性自检 ----
// 通过 GET /v1/models 探测服务连通性与 Key 有效性，不消耗生图额度
export async function doctor(flags) {
  const lines = [];
  const major = Number(process.versions.node.split('.')[0]);
  lines.push(`Node ${process.versions.node} ${major >= 18 ? '✓' : '✗ 需要 18+（fetch / FormData / Blob）'}`);

  const config = resolveConfig(flags, 'generate');
  lines.push(`服务 Base URL: ${config.baseUrl}（来自${config.urlSource}）`);
  lines.push(`生图端点: ${config.url}`);
  lines.push(`.env 位置: ${config.envFile}${existsSync(config.envFile) ? '' : '（不存在，仅用环境变量 / 命令行）'}`);
  if (config.keyBlocked) {
    lines.push(
      `API Key: 未配置 ✗ — 检测到 ${config.keyBlocked.source}，但已拒绝使用：`
      + `服务地址没显式配过（走默认 ${DEFAULT_BASE_URL}），把 openai.com 的凭证发去第三方中转等于泄露。`,
    );
    lines.push('  → 用中转站：配 IMAGE_API_KEY；用官方端点：显式设 IMAGE_API_URL=https://api.openai.com');
  } else {
    lines.push(
      config.key
        ? `API Key: 已配置（来自${config.keySource}，前 7 位: ${config.key.slice(0, 7)}...）`
        : 'API Key: 未配置 ✗ — 必填。设置 IMAGE_API_KEY 或写进 <技能目录>/.env',
    );
  }
  lines.push(`配置模型: ${config.modelList.join('、')} (${config.modelList.length} 个，来自${config.modelsSource})`);
  if (config.modelList.length === 1) {
    lines.push(`模型策略: 单模型模式（未指定时直接使用 ${config.modelList[0]}，无需询问用户）`);
  } else {
    lines.push(`模型策略: 多模型模式（未指定时将列出供用户选择；或通过 --model 显式指定）`);
  }

  if (config.key && major >= 18) {
    // 实测这台服务 /v1/models 要 6-10 秒、偶发失败，15 秒会把好服务误报成"无法连接"
    const probeMs = 30000;
    const modelsUrl = `${apiRoot(config.baseUrl)}/v1/models`;
    lines.push(`探测端点: ${modelsUrl}（超时 ${probeMs / 1000} 秒，不消耗生图额度）`);

    try {
      const startedAt = Date.now();
      const resp = await fetch(modelsUrl, {
        headers: {
          Authorization: config.key.startsWith('Bearer ') ? config.key : `Bearer ${config.key}`,
        },
        signal: AbortSignal.timeout(probeMs),
      });
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

      if (resp.status === 200) {
        const data = await resp.json().catch(() => null);
        const modelList = Array.isArray(data?.data) ? data.data.map((m) => m.id) : [];
        lines.push(`API 连通性: ✓ 成功连通（/v1/models HTTP 200，${seconds} 秒，共 ${modelList.length} 个模型）`);
        const imageModels = modelList.filter((id) => /image|dall|flux|paint|banana|seedream|kolors|midjourney|imagen|sdxl|sd3|qwen-?vl|grok-?image/i.test(id));
        if (imageModels.length) {
          lines.push(`疑似图像模型 (${imageModels.length} 个): ${imageModels.slice(0, 8).join(', ')}${imageModels.length > 8 ? ' …' : ''}`);
        } else if (modelList.length) {
          // 名字里不带 image/dall 这类字样的图像模型（seedream、nano-banana 之类）会漏，所以不下"没有"的结论
          lines.push(`未按名字识别出图像模型，服务端前几个模型: ${modelList.slice(0, 8).join(', ')}${modelList.length > 8 ? ' …' : ''}`);
        }
        for (const m of config.modelList) {
          if (modelList.includes(m)) {
            lines.push(`配置模型 [${m}]: ✓ 已在服务可用模型列表中`);
          } else if (modelList.length > 0) {
            lines.push(`配置模型 [${m}]: ? 未在服务模型列表中精确匹配（仍可能支持）`);
          }
        }
      } else if (resp.status === 401 || resp.status === 403) {
        lines.push(`API 连通性: ✗ 认证失败（HTTP ${resp.status}，${seconds} 秒），请检查凭证是否正确有效`);
      } else {
        lines.push(`API 连通性: ? 端点返回 HTTP ${resp.status}（${seconds} 秒）`);
      }
    } catch (e) {
      const chain = causeChain(e);
      if (/TimeoutError|AbortError/i.test(chain)) {
        // 超时不等于配置错：这台服务本来就慢且偶发失败，别给出 ✗ 让自检退非零
        lines.push(`API 连通性: ? ${probeMs / 1000} 秒内没响应 —— 这台服务实测 6-10 秒且偶发失败，可再跑一次；持续如此才是服务侧问题`);
      } else if (/ENOTFOUND|EAI_AGAIN/i.test(chain)) {
        lines.push(`API 连通性: ✗ 域名解析不了 —— 检查 IMAGE_API_URL 拼写 (${e.message})`);
      } else if (/ECONNREFUSED/i.test(chain)) {
        lines.push(`API 连通性: ✗ 连接被拒 —— 地址或端口不对 (${e.message})`);
      } else {
        lines.push(`API 连通性: ✗ 无法连接 (${e.message})`);
      }
    }
  }

  console.log(lines.join('\n'));
  return lines.some((line) => line.includes('✗')) ? 1 : 0;
}

/** 统一的入口收尾：Fail 打印人话，其余打印堆栈。 */
export function run(main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      if (error instanceof Fail) {
        console.error(`错误：${error.message}`);
        if (error.hint) console.error(`提示：${error.hint}`);
      } else {
        console.error(`意外错误：${error?.stack || error}`);
      }
      process.exit(1);
    });
}
