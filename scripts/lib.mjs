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
export const EDIT_SIZES = ['256x256', '512x512', '1024x1024', '2048x2048', '4096x4096'];
export const RESOLUTION_MAP = {
  '1k': '1024x1024',
  '1K': '1024x1024',
  '2k': '2048x2048',
  '2K': '2048x2048',
  '4k': '4096x4096',
  '4K': '4096x4096',
};

export function normalizeSize(rawSize) {
  if (!rawSize) return undefined;
  const s = String(rawSize).trim();
  return RESOLUTION_MAP[s] || s;
}

export const PROMPT_MAX = { generate: 8000, edit: 1000 };
export const N_MAX = { generate: 4, edit: 10 };
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

/** 智能拼接完整的端点 URL，兼容携带 /v1、已是完整端点或包含尾斜杠的情况 */
export function buildEndpointUrl(rawUrl, endpoint) {
  let base = (rawUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const path = ENDPOINTS[endpoint];
  if (base.toLowerCase().endsWith(path.toLowerCase())) {
    return base;
  }
  if (base.toLowerCase().endsWith('/v1')) {
    return `${base}${path.slice(3)}`;
  }
  return `${base}${path}`;
}

export function resolveConfig(flags, endpoint) {
  const dotEnv = readDotEnv();
  const pick = (flagValue, ...envKeys) => {
    if (flagValue) return { value: flagValue, source: '命令行' };
    for (const envKey of envKeys) {
      if (process.env[envKey]) return { value: process.env[envKey], source: `环境变量 $${envKey}` };
      if (dotEnv[envKey]) return { value: dotEnv[envKey], source: `.env (${envKey})` };
    }
    return { value: '', source: '' };
  };

  const rawUrl = pick(flags.url, 'IMAGE_API_URL', 'DOUDOU_IMAGE_API_URL', 'DOUDOU_API_URL', 'OPENAI_BASE_URL');
  const key = pick(flags.key, 'IMAGE_API_KEY', 'DOUDOU_IMAGE_API_KEY', 'DOUDOU_API_KEY', 'OPENAI_API_KEY');
  const models = pick(flags.models, 'IMAGE_API_MODELS', 'IMAGE_API_MODEL', 'DOUDOU_IMAGE_MODELS', 'DOUDOU_IMAGE_MODEL', 'IMAGE_MODEL');

  const baseUrl = (rawUrl.value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const url = buildEndpointUrl(baseUrl, endpoint);
  const modelList = (models.value || DEFAULT_MODEL)
    .split(/[,，\s]+/)
    .map((m) => m.trim())
    .filter(Boolean);

  return {
    baseUrl,
    url,
    urlSource: rawUrl.value ? rawUrl.source : '默认值',
    key: key.value.trim(),
    keySource: key.source,
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
        '请检查服务地址 IMAGE_API_URL 是否配置正确（是否包含正确的 Base URL）',
      );
    }
    throw new Fail(`响应不是 JSON（HTTP ${response.status}）`, text.slice(0, 300));
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

  let hint = '';
  if (status === 401 || status === 403) {
    hint = config.key
      ? `API Key 认证未通过（来自${config.keySource}）。请检查 IMAGE_API_KEY 是否正确有效、额度是否充足。`
      : '未配置 API Key。请在 <技能目录>/.env 中配置 IMAGE_API_KEY，或在命令行使用 --key <token>。';
  } else if (status === 404) {
    hint = `端点不存在（404）：${config.url}。请检查服务地址 IMAGE_API_URL 是否正确。`;
  } else if (status === 429) {
    hint = '请求受限（429）：API 速率超限或账户额度已耗尽，请稍后再试或检查账户余额。';
  } else if (status >= 500) {
    hint = '上游服务暂时不可用（5xx），可能是上游服务器抖动，请稍后重试。';
  } else {
    // 400 Bad Request 等
    const suggestions = [];
    if (notes.suggestions && Array.isArray(notes.suggestions)) {
      suggestions.push(...notes.suggestions);
    }
    if (suggestions.length) {
      hint = `建议排查：\n${suggestions.map((s) => `  · ${s}`).join('\n')}`;
    }
  }

  return new Fail(parts.join('\n'), hint);
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
    return {
      buffer,
      mime_type: mime,
      b64_json: buffer.toString('base64'),
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
      info(`注意：${path} 的扩展名和实际格式（${image.mime_type}）对不上，内容已按 ${want} 写入`);
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
    } else if (arg.startsWith('-') && arg !== '-') {
      throw new Fail(`不认识的选项：${arg}`, '看 --help');
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
  lines.push(
    config.key
      ? `API Key: 已配置（来自${config.keySource}，前 7 位: ${config.key.slice(0, 7)}...）`
      : 'API Key: 未配置 ✗ — 必填。设置 IMAGE_API_KEY 或写进 <技能目录>/.env',
  );
  lines.push(`配置模型: ${config.modelList.join('、')} (${config.modelList.length} 个，来自${config.modelsSource})`);
  if (config.modelList.length === 1) {
    lines.push(`模型策略: 单模型模式（未指定时直接使用 ${config.modelList[0]}，无需询问用户）`);
  } else {
    lines.push(`模型策略: 多模型模式（未指定时将列出供用户选择；或通过 --model 显式指定）`);
  }

  if (config.key && major >= 18) {
    let modelsUrl = config.baseUrl;
    if (modelsUrl.endsWith('/v1')) {
      modelsUrl = `${modelsUrl}/models`;
    } else {
      modelsUrl = `${modelsUrl}/v1/models`;
    }

    try {
      const resp = await fetch(modelsUrl, {
        headers: {
          Authorization: config.key.startsWith('Bearer ') ? config.key : `Bearer ${config.key}`,
        },
        signal: AbortSignal.timeout(15000),
      });

      if (resp.status === 200) {
        const data = await resp.json();
        const modelList = Array.isArray(data.data) ? data.data.map((m) => m.id) : [];
        lines.push(`API 连通性: ✓ 成功连通（/v1/models HTTP 200）`);
        const imageModels = modelList.filter((id) => /image|dall|flux|paint/i.test(id));
        if (imageModels.length) {
          lines.push(`检测到可用图像模型 (${imageModels.length} 个): ${imageModels.slice(0, 6).join(', ')}${imageModels.length > 6 ? '...' : ''}`);
        }
        for (const m of config.modelList) {
          if (modelList.includes(m)) {
            lines.push(`配置模型 [${m}]: ✓ 已在服务可用模型列表中`);
          } else if (modelList.length > 0) {
            lines.push(`配置模型 [${m}]: ? 未在服务模型列表中精确匹配（仍可能支持）`);
          }
        }
      } else if (resp.status === 401 || resp.status === 403) {
        lines.push(`API 连通性: ✗ 认证失败（HTTP ${resp.status}），请检查 IMAGE_API_KEY 是否正确`);
      } else {
        lines.push(`API 连通性: ? 端点返回 HTTP ${resp.status}`);
      }
    } catch (e) {
      lines.push(`API 连通性: ✗ 无法连接 (${e.message})`);
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
