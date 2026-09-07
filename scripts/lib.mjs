// doudou-image-skill 共用工具：配置、HTTP、错误翻译、产物落盘、PNG 头解析。
// generate.mjs 和 edit.mjs 都从这里取，两个入口的行为才一致。
//
// 为什么是 Node 脚本而不是直接 curl：Windows PowerShell 5.1 里 `curl` 是
// Invoke-WebRequest 的别名，不认 -F，编辑接口的 multipart 上传直接失败；
// 而两个接口都返回裸 base64（单张 1024px 的 PNG 约 2MB），必须落盘成文件，
// 不能让它进终端或上下文。Node 18+ 自带 fetch / FormData / Blob，无第三方依赖。

import { stat, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 默认本机实例：公网 n8n.undsky.com 是另一台，上面没有这两条工作流（打过去 404）
export const DEFAULT_BASE_URL = 'http://localhost:5678';
export const ENDPOINTS = { generate: '/webhook/image-generate', edit: '/webhook/image-edit' };
// 编辑接口对图和 mask 各自的上限，跟工作流「统一图片为 Base64」里一致。
// 本地先拦一遍：超了上游只回一个不带信息的裸 400，等整个文件传完才报错白等一趟。
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const EDIT_SIZES = ['256x256', '512x512', '1024x1024'];
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

/** 查找 .env 配置文件：默认查找技能目录（scripts/ 的上一级），如果没有，那么查找再上一级。 */
export function findEnvFile() {
  const primary = join(SKILL_DIR, '.env');
  if (existsSync(primary)) return primary;
  const parentEnv = join(resolve(SKILL_DIR, '..'), '.env');
  if (existsSync(parentEnv)) return parentEnv;
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

export function resolveConfig(flags, endpoint) {
  const dotEnv = readDotEnv();
  const pick = (flagValue, envKey) => {
    if (flagValue) return { value: flagValue, source: '命令行' };
    if (process.env[envKey]) return { value: process.env[envKey], source: '环境变量' };
    if (dotEnv[envKey]) return { value: dotEnv[envKey], source: '.env' };
    return { value: '', source: '' };
  };

  const rawUrl = pick(flags.url, 'DOUDOU_IMAGE_URL');
  const key = pick(flags.key, 'DOUDOU_IMAGE_KEY');
  const base = (rawUrl.value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  // 允许 --url 直接给完整端点：省得记该给 base 还是给 endpoint。
  // 注意要按「实际匹配到的那个后缀」去掉，不能按本次要用的 path 的长度 ——
  // 两个端点路径不一样长，给了 image-edit 却在跑 generate 时会切歪。
  const path = ENDPOINTS[endpoint];
  const matched = Object.values(ENDPOINTS).find((p) => base.toLowerCase().endsWith(p)) || '';
  const baseUrl = matched ? base.slice(0, base.length - matched.length) : base;
  return {
    baseUrl,
    url: `${baseUrl}${path}`,
    urlSource: rawUrl.value ? rawUrl.source : '默认值',
    key: key.value.trim(),
    keySource: key.source,
  };
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
// fetch 失败时 message 一律是干巴巴的 "fetch failed"，真正的 errno 埋在 cause 里，
// 而且 localhost 会同时试 IPv6 和 IPv4，失败时 cause 是个 AggregateError —— 得连 errors[] 一起翻。
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

/** POST 到 webhook，返回 { status, json }。网络层失败翻译成能照着修的提示。 */
export async function post(config, body, { timeoutMs, isJson }) {
  const headers = {};
  if (config.key) {
    // 两个头都发：工作流按 X-Uuid > uuid > X-Key > key 取第一个非空的
    headers['X-Uuid'] = config.key;
    headers['X-Key'] = config.key;
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
        '实测文生图 15-25 秒、修图 20-70 秒、带 mask 约 180 秒。用 --timeout 加长，或去掉 --mask',
      );
    }
    if (/ECONNREFUSED/i.test(chain)) {
      throw new Fail(`连不上 ${config.url}`, 'n8n 没在跑？确认容器已启动（docker ps），或用 --url 指向正确的实例');
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(chain)) {
      throw new Fail(`域名解析不了：${config.url}`, '检查 DOUDOU_IMAGE_URL 拼写');
    }
    if (/ECONNRESET|EPIPE|UND_ERR_SOCKET/i.test(chain)) {
      throw new Fail(
        `连接被断开：${config.url}`,
        '请求体太大时 n8n 会读到上限后直接断开而不回响应。编辑接口的图请控制在 4MB 内',
      );
    }
    throw new Fail(`请求失败：${chain}`);
  }

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应（网关错误页之类）留给下面按状态码兜底 */
  }
  if (!json) {
    if (response.status === 404) throw notActive(config);
    throw new Fail(`响应不是 JSON（HTTP ${response.status}）`, text.slice(0, 300));
  }
  return { status: response.status, json };
}

function notActive(config) {
  return new Fail(
    `端点不存在（404）：${config.url}`,
    '两种可能：工作流「生图 API（Base64）」没激活；或 --url 指到了另一个 n8n 实例'
      + `（公网 n8n.undsky.com 上没有这两条工作流，本机默认是 ${DEFAULT_BASE_URL}）`,
  );
}

// 接口的报错够具体（message + stage + hint），但 auth / upstream 这两类失败
// 光看响应体猜不到该动哪里 —— 这里按 stage 补上「去改什么」。
export function explain(status, json, config, notesByStage = {}) {
  const stage = String(json.stage || '');
  const error = json.error || {};
  const message = String(error.message || json.error || '未知错误');
  const detail = json.detail ? String(json.detail).slice(0, 300) : '';
  const parts = [`接口返回失败（HTTP ${status}，stage=${stage || '?'}）：${message}`];
  if (detail) parts.push(`详情：${detail}`);

  let hint = json.hint ? String(json.hint) : '';
  if (stage === 'auth') {
    hint = config.key
      ? `用户标识没通过（来自${config.keySource}）。确认 DOUDOU_IMAGE_KEY 是平台上有效的 uuid，`
        + '值填纯 uuid、不带 Bearer 前缀。账号被停用/软删也会走到这里'
      : '这个接口必须带用户标识。设置 DOUDOU_IMAGE_KEY 或写进 <技能目录>/.env，也可以本次用 --key <uuid> 传';
  } else if (stage === 'upstream') {
    // 上游只回一个不带信息的裸 400，接口再包一层就成了「暂时不可用」——
    // 光看这句话没法分辨是该重试还是该改参数，所以把已知的诱因列出来。
    hint = [
      '上游这次没给出有效结果。已知诱因（按可能性）：',
      ...(notesByStage.upstream || []).map((note) => `  · ${note}`),
      '  · 上游偶发抖动 —— 以上都排除了就原样重试一次',
    ].join('\n');
  } else if (stage === 'subworkflow') {
    // 接口把子工作流的原话（含 model=X 和可用模型列表）压成了一句笼统的
    // 「配置不可用」，所以「是不是我 --model 传错了」得由调用方自己补上。
    hint = [
      ...(notesByStage.subworkflow || []).map((note) => `  · ${note}`),
      '  · 服务端配置问题：数据表「生图 API 配置」里没有 enabled = 1 的记录，'
        + '或选中的那条缺 url / authorizationToken —— 这个只能改数据表',
    ].join('\n');
    hint = `配置没匹配上。可能是：\n${hint}`;
  } else if (status === 404) {
    return notActive(config);
  }
  return new Fail(parts.join('\n'), hint);
}

// ---- 产物落盘 ----
// 接口返回的 mime_type 是工作流按魔数嗅出来的（上游声明的常常是错的），
// 所以扩展名跟着它走，而不是跟着 prompt 或用户给的名字猜。
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
  // 多张但给了具体文件名：在扩展名前插序号，别互相覆盖
  const base = resolve(out);
  const suffix = extname(base);
  const head = suffix ? base.slice(0, -suffix.length) : base;
  return images.map((_, i) => `${head}-${i + 1}${suffix || ext(i)}`);
}

/** 把 images[].b64_json 写成文件，返回落盘后的绝对路径数组。 */
export async function saveImages(images, flags, stem) {
  const paths = targetPaths(images, flags, stem);
  const saved = [];
  for (const [i, image] of images.entries()) {
    const path = paths[i];
    await mkdir(dirname(path), { recursive: true });
    const buffer = Buffer.from(image.b64_json, 'base64');
    await writeFile(path, buffer);
    const want = EXT_OF[image.mime_type] || '.png';
    if (extname(path).toLowerCase() !== want) {
      // 不替用户改路径：脚本和后续命令可能就按这个名字接着走
      info(`注意：${path} 的扩展名和实际格式（${image.mime_type}）对不上，内容是按 ${want} 写的`);
    }
    saved.push({ path, mime_type: image.mime_type, bytes: buffer.length });
  }
  return saved;
}

// ---- 图片与 mask 本地预检 ----
// 按魔数认真实格式：文件名后缀经常是错的，而 mask 的规则只对 PNG 成立。
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
  // tRNS 必须出现在 IDAT 之前，所以扫到 IDAT 就可以停
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

// colorType 4=灰度+alpha、6=RGBA；3=调色板（靠 tRNS 带透明）
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
    throw new Fail(`${label}不像是图片：${path}`, '按魔数认不出 PNG / JPEG / WebP / GIF，确认文件没坏');
  }
  return { path, buffer, mime, bytes: buffer.length };
}

/**
 * mask 的三条规则本地先查：必须是带 alpha 的 PNG、尺寸和原图一致、原图也得是 PNG。
 * 上游对这三条都只回一个不带信息的裸 400，不自己查根本没法定位。
 * image 为 null（走 image_url）时跳过尺寸比对 —— 那时原图还没下载下来。
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
  if (!image) return { checkedSize: false, width: maskInfo.width, height: maskInfo.height };
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

// ---- 参数解析 ----
/**
 * spec.value: 需要跟值的选项 -> 目标键名；spec.bool: 布尔开关 -> 目标键名。
 * `--` 之后的一律当位置参数，prompt 以 - 开头时用得上。
 */
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

/** 校验 n：两个接口上限不同（生成 4、编辑 10）。 */
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
    '没有配置用户标识',
    '这两个接口都必须带标识（不带直接 400）。设置环境变量 DOUDOU_IMAGE_KEY，'
      + '或写进 <技能目录>/.env，也可以本次用 --key <uuid> 传。可在平台个人信息获取',
  );
}

// ---- doctor：配置和连通性自检 ----
// 故意发一个不带 prompt 的空请求：接口会回 400 stage=validate，
// 这恰好证明「URL 对、标识有效、工作流活着」，又不会真去生成图片、烧额度。
export async function doctor(flags) {
  const lines = [];
  const major = Number(process.versions.node.split('.')[0]);
  lines.push(`Node ${process.versions.node} ${major >= 18 ? '✓' : '✗ 需要 18+（fetch / FormData / Blob）'}`);

  const generate = resolveConfig(flags, 'generate');
  lines.push(`服务地址 ${generate.baseUrl}（来自${generate.urlSource}）`);
  lines.push(
    generate.key
      ? `用户标识 已配置（来自${generate.keySource}，${generate.key.length} 字符）`
      : '用户标识 未配置 ✗ — 必填。设置 DOUDOU_IMAGE_KEY 或写进 <技能目录>/.env',
  );

  if (generate.key && major >= 18) {
    for (const endpoint of ['generate', 'edit']) {
      const config = resolveConfig(flags, endpoint);
      try {
        const { status, json } = await post(config, '{}', { timeoutMs: 20000, isJson: true });
        if (json.stage === 'validate') {
          lines.push(`${ENDPOINTS[endpoint]} ✓（可达、标识通过、工作流已激活）`);
        } else if (json.stage === 'auth') {
          lines.push(`${ENDPOINTS[endpoint]} ✗ 标识没通过：${json.error?.message || ''}`);
        } else {
          lines.push(`${ENDPOINTS[endpoint]} ? 意外响应（HTTP ${status}）：${JSON.stringify(json).slice(0, 160)}`);
        }
      } catch (error) {
        lines.push(`${ENDPOINTS[endpoint]} ✗ ${error.message}${error.hint ? `\n  → ${error.hint}` : ''}`);
      }
    }
  }

  console.log(lines.join('\n'));
  return lines.some((line) => line.includes('✗')) ? 1 : 0;
}

/** 统一的入口收尾：Fail 打成两行人话，其余打堆栈。 */
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
