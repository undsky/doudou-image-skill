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
export const DEFAULT_BASE_URL = 'https://api.openai.com';
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
  // 只验形状会让 0x0 这种没有意义的值通过（正则里 \d+ 匹配得上），发上去只会换回一个裸 400
  const [width, height] = size.split('x').map(Number);
  if (width === 0 || height === 0) {
    throw new Fail(`--size ${size} 不是有效尺寸`, `宽和高都必须大于 0，如 ${KNOWN_GOOD_SIZE}`);
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

export const CONFIG_FILE_NAME = 'config.json';

/**
 * 查找配置文件 config.json。
 * 优先检查 customPath，其次检查技能目录，再向上查找项目根。
 */
export function findConfigFile(customPath) {
  if (customPath) {
    const resolved = resolve(process.cwd(), customPath);
    if (existsSync(resolved)) return resolved;
    const fromSkill = resolve(SKILL_DIR, customPath);
    if (existsSync(fromSkill)) return fromSkill;
    throw new Fail(`指定的配置文件不存在：${customPath}`, '请检查文件路径是否正确');
  }

  // 1. 优先在技能目录下找
  const inSkill = join(SKILL_DIR, CONFIG_FILE_NAME);
  if (existsSync(inSkill)) return inSkill;

  // 2. 向上找项目根（最多 3 级）
  let curr = SKILL_DIR;
  for (let i = 0; i < 3; i += 1) {
    const isRoot = ROOT_MARKERS.some((m) => existsSync(join(curr, m)));
    if (isRoot) break;
    const parent = resolve(curr, '..');
    if (parent === curr) break;
    curr = parent;
    const inParent = join(curr, CONFIG_FILE_NAME);
    if (existsSync(inParent)) return inParent;
  }
  return null;
}

/** 脱敏打印 Key */
export function maskKey(key) {
  if (!key) return '（未配置）';
  const str = String(key).trim();
  if (str.length <= 10) return `${str.slice(0, 3)}...`;
  return `${str.slice(0, 7)}...${str.slice(-4)}`;
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

/** 表示一个 API 图像源 */
export class ApiSource {
  constructor({ id, name, url, key, models, isDefault = false, configSource = '', keySource = '', urlSource = '' }) {
    this.id = String(id || '').trim() || 'default';
    this.name = String(name || this.id).trim();
    this.url = String(url || '').trim();
    this.baseUrl = apiRoot(this.url || DEFAULT_BASE_URL);
    this.key = String(key || '').trim();
    this.models = Array.isArray(models)
      ? models.map((m) => String(m).trim()).filter(Boolean)
      : (typeof models === 'string'
          ? models.split(/[,，\s]+/).map((m) => m.trim()).filter(Boolean)
          : []);
    if (this.models.length === 0) {
      this.models = [DEFAULT_MODEL];
    }
    this.isDefault = Boolean(isDefault);
    this.configSource = configSource;
    this.keySource = keySource || configSource;
    this.urlSource = urlSource || configSource;
  }
}

/**
 * 加载所有配置的源：从 config.json 加载。
 * 找不到配置文件时抛出 Fail 错误，提示用户创建。
 */
export function loadSources(flags = {}) {
  const customConfigPath = flags.configFile || process.env.DOUDOU_IMAGE_CONFIG_FILE;
  const configFilePath = findConfigFile(customConfigPath);

  if (!configFilePath) {
    throw new Fail(
      '未找到图像配置文件 config.json',
      `请复制技能目录下的 config.json.example 为 config.json，并配置 API 地址、访问凭证（Key）与模型列表。\n`
      + `参考命令：cp ${join(SKILL_DIR, 'config.json.example')} ${join(SKILL_DIR, 'config.json')}`,
    );
  }

  let sources = [];
  let defaultSourceId = '';
  const configDesc = `${basename(configFilePath)} (${configFilePath})`;

  try {
    const content = readFileSync(configFilePath, 'utf8');
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      sources = parsed.map((item, idx) => new ApiSource({
        ...item,
        isDefault: Boolean(item.default || item.isDefault || idx === 0),
        configSource: `${basename(configFilePath)} [#${idx + 1}]`,
        keySource: `${basename(configFilePath)}`,
      }));
    } else if (parsed && typeof parsed === 'object') {
      defaultSourceId = String(parsed.default_source || parsed.defaultSource || '').trim();
      const rawList = Array.isArray(parsed.sources)
        ? parsed.sources
        : (parsed.sources && typeof parsed.sources === 'object'
            ? Object.entries(parsed.sources).map(([k, v]) => ({ id: k, ...v }))
            : []);
      sources = rawList.map((item, idx) => new ApiSource({
        ...item,
        isDefault: defaultSourceId ? item.id === defaultSourceId : Boolean(item.default || item.isDefault || idx === 0),
        configSource: `${basename(configFilePath)} [${item.id || idx + 1}]`,
        keySource: `${basename(configFilePath)}`,
      }));
    }
  } catch (e) {
    if (e instanceof Fail) throw e;
    throw new Fail(`解析配置文件失败：${configFilePath}`, `JSON 语法错误：${e.message}`);
  }

  if (sources.length === 0) {
    throw new Fail(
      `配置文件 ${basename(configFilePath)} 中未定义任何有效源`,
      '请参考 config.json.example 在 sources 数组中添加至少一个配置项',
    );
  }

  // 确保至少有且仅有一个 isDefault
  const defaultIdx = sources.findIndex((s) => s.isDefault);
  if (defaultIdx === -1 && sources.length > 0) {
    sources[0].isDefault = true;
  }

  const defaultSource = sources.find((s) => s.isDefault) || sources[0];

  return {
    sources,
    defaultSource,
    configDesc,
    configFile: configFilePath,
  };
}

/**
 * 根据命令行选项与模型智能匹配当前所用的源
 */
export async function resolveSource(flags, sourcesInfo) {
  const { sources, defaultSource } = sourcesInfo;

  // 1. 命令行显式指定了 --source
  if (flags.source) {
    const query = String(flags.source).trim().toLowerCase();
    const matched = sources.find((s) => s.id.toLowerCase() === query || s.name.toLowerCase() === query);
    if (!matched) {
      throw new Fail(
        `找不到指定的源：${flags.source}`,
        `当前配置的可用源：\n${sources.map((s, i) => `  ${i + 1}. [${s.id}] ${s.name}${s.isDefault ? ' (默认)' : ''}`).join('\n')}\n使用 --sources 查看完整列表。`,
      );
    }
    return matched;
  }

  // 2. 命令行未传 --source，但传了 --model：智能模型路由
  if (flags.model) {
    const targetModel = String(flags.model).trim();
    const candidates = sources.filter((s) => s.models.includes(targetModel));
    if (candidates.length === 1) {
      // 唯一源支持该模型：自动选定该源
      return candidates[0];
    }
    if (candidates.length > 1) {
      // 多个源均支持：优先选默认源（如果默认源支持）
      if (candidates.some((s) => s.id === defaultSource.id)) {
        return defaultSource;
      }
      // 默认源不在其中且是交互式终端：提示用户选择源
      if (process.stdin.isTTY) {
        info(`检测到模型 [${targetModel}] 存在于多个源中，请选择使用的源（直接回车默认第 1 项）：`);
        for (let i = 0; i < candidates.length; i++) {
          info(`  ${i + 1}) [${candidates[i].id}] ${candidates[i].name}`);
        }
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
          const answer = (await rl.question(`请输入源序号 (1-${candidates.length}) [1]: `)).trim();
          const idx = answer ? parseInt(answer, 10) - 1 : 0;
          if (Number.isInteger(idx) && idx >= 0 && idx < candidates.length) {
            return candidates[idx];
          }
          return candidates[0];
        } finally {
          rl.close();
        }
      }
      // 非交互式：默认回退到候选的第 1 项，并输出说明
      info(`注意：模型 [${targetModel}] 存在于多个源中，已默认选用 [${candidates[0].id}]（可用 --source <id> 显式指定）`);
      return candidates[0];
    }
    // 未在任何源的模型列表中匹配（可能是用户直接指定的外部模型）：回退到默认源
    return defaultSource;
  }

  // 3. 既未传 --source 也未传 --model
  // 若只有一个源：直接使用
  if (sources.length === 1) {
    return sources[0];
  }

  // 多个源：在交互式终端且没有明确单选时，询问用户选择源；若未交互则使用默认源
  if (process.stdin.isTTY && !flags.source) {
    info(`当前配置了 ${sources.length} 个可用源，请选择（直接回车默认使用 [${defaultSource.id}] ${defaultSource.name}）：`);
    for (let i = 0; i < sources.length; i++) {
      info(`  ${i + 1}) [${sources[i].id}] ${sources[i].name}${sources[i].isDefault ? ' (默认)' : ''}`);
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const defaultIdx = sources.findIndex((s) => s.id === defaultSource.id);
      const answer = (await rl.question(`请输入源序号 (1-${sources.length}) [${defaultIdx + 1}]: `)).trim();
      const idx = answer ? parseInt(answer, 10) - 1 : defaultIdx;
      if (Number.isInteger(idx) && idx >= 0 && idx < sources.length) {
        return sources[idx];
      }
      return defaultSource;
    } finally {
      rl.close();
    }
  }

  return defaultSource;
}

/**
 * 解析并确定最终运行配置（URL、Key、选定源与模型列表）
 */
export async function resolveConfig(flags, endpoint) {
  const sourcesInfo = loadSources(flags);
  const selectedSource = await resolveSource(flags, sourcesInfo);

  // 命令行显式传参优先级最高
  const baseUrl = flags.url ? apiRoot(flags.url) : selectedSource.baseUrl;
  const url = buildEndpointUrl(baseUrl, endpoint);
  const key = flags.key !== undefined ? String(flags.key).trim() : selectedSource.key;
  const keySource = flags.key !== undefined ? '命令行' : selectedSource.keySource;
  const urlSource = flags.url ? '命令行' : selectedSource.urlSource;

  return {
    source: selectedSource,
    sources: sourcesInfo.sources,
    sourcesInfo,
    baseUrl,
    url,
    urlSource,
    urlIsExplicit: Boolean(flags.url || selectedSource.url),
    key,
    keySource,
    configFile: sourcesInfo.configFile,
    modelList: selectedSource.models,
    modelsSource: selectedSource.configSource,
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
export async function resolveModel(flags, modelList, sourceName = '') {
  if (flags.model) {
    return String(flags.model).trim();
  }
  if (!modelList || modelList.length === 0) {
    return DEFAULT_MODEL;
  }
  if (modelList.length === 1) {
    return modelList[0];
  }

  const prefix = sourceName ? `【${sourceName}】` : '';

  // 交互式终端 (TTY) 提示选择
  if (process.stdin.isTTY) {
    info(`${prefix}当前配置了 ${modelList.length} 个可用模型，请选择（直接回车默认第 1 项）：`);
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
    `${prefix}未指定使用哪个模型。当前可用模型：${modelList.join('、')}`,
    `请向用户确认后，使用 --model <名字> 显式指定。\n可选模型：\n${modelList.map((m, i) => `  ${i + 1}. ${m}`).join('\n')}`,
  );
}

/** 格式化输出所有配置的源（供 --sources 使用） */
export function formatSourcesOutput(sourcesInfo, asJson = false) {
  const { sources, configDesc } = sourcesInfo;
  if (asJson) {
    const list = sources.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url || s.baseUrl,
      is_default: s.isDefault,
      has_key: Boolean(s.key),
      masked_key: maskKey(s.key),
      models: s.models,
      source: s.configSource,
    }));
    return `${JSON.stringify(list, null, 2)}\n`;
  }

  const lines = [];
  lines.push(`配置文件: ${configDesc}`);
  lines.push(`可用源数量: ${sources.length} 个`);
  lines.push('------------------------------------------------------------');
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const flag = s.isDefault ? '* ' : '  ';
    lines.push(`${flag}${i + 1}. [${s.id}] ${s.name}${s.isDefault ? ' (默认源)' : ''}`);
    lines.push(`     服务地址: ${s.baseUrl}`);
    lines.push(`     访问凭证: ${s.key ? `已配置 (${maskKey(s.key)})` : '未配置 ✗'}`);
    lines.push(`     可用模型: ${s.models.join(', ')} (${s.models.length} 个)`);
    if (i < sources.length - 1) lines.push('');
  }
  lines.push('------------------------------------------------------------');
  lines.push('提示: 带 * 的为默认源。可用 --source <id> 指定源，或通过 --model <name> 自动匹配对应源。');
  return `${lines.join('\n')}\n`;
}

/** 格式化输出模型列表（供 --models 使用） */
export function formatModelsOutput(sourcesInfo, flags, asJson = false) {
  const { sources } = sourcesInfo;
  let targetSources = sources;
  if (flags.source) {
    const query = String(flags.source).trim().toLowerCase();
    targetSources = sources.filter((s) => s.id.toLowerCase() === query || s.name.toLowerCase() === query);
    if (targetSources.length === 0) {
      throw new Fail(`找不到指定的源：${flags.source}`);
    }
  }

  if (asJson) {
    if (targetSources.length === 1) {
      return `${JSON.stringify(targetSources[0].models, null, 2)}\n`;
    }
    const map = {};
    for (const s of targetSources) {
      map[s.id] = { name: s.name, models: s.models };
    }
    return `${JSON.stringify(map, null, 2)}\n`;
  }

  // 纯文本输出：若只有一个源，直接按行输出模型名字（与原有逻辑 100% 保持一致）
  if (targetSources.length === 1) {
    return `${targetSources[0].models.join('\n')}\n`;
  }

  // 多个源：按源分组输出
  const lines = [];
  for (const s of targetSources) {
    lines.push(`[${s.id}] ${s.name}${s.isDefault ? ' (默认)' : ''}:`);
    for (const m of s.models) {
      lines.push(`  - ${m}`);
    }
  }
  return `${lines.join('\n')}\n`;
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
  // 按码点截断，不用 .slice()：后者按 UTF-16 码元切，emoji（代理对）会被劈成两半，
  // 留下孤立代理项，落盘后文件名里是一个替换字符（如 "a🐱…🐱�-时间戳.png"）。
  const clip = (s) => [...s].slice(0, limit).join('');
  return strip(clip(strip(out))) || 'image';
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
      throw new Fail(`域名解析不了：${config.url}`, '检查配置文件中该源的服务地址 url 拼写');
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
        '请检查配置文件中该源的服务地址 url 是否配置正确（填服务根地址即可，端点路径由脚本拼接）',
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
      : `未配置 API Key。请在配置文件中为当前源 [${config.source?.id || 'default'}] 配置 key，或在命令行使用 --key <token>。`);
  } else if (status === 404) {
    hints.push(`端点不存在（404）：${config.url}。请检查配置文件中该源的服务地址 url 是否正确（填服务根地址即可，端点路径由脚本拼接）。`);
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
    // 分两种情况说，否则"必须是 PNG"配上"按魔数是 image/png"会自相矛盾
    throw new Fail(
      mask.mime === 'image/png' ? 'mask 的 PNG 头读不出来（文件可能已损坏）' : 'mask 必须是 PNG',
      mask.mime === 'image/png'
        ? `${mask.path} 魔数是 PNG，但 IHDR 头不完整或不合法，重新导出一份`
        : `${mask.path} 按魔数是 ${mask.mime}，重新导出成 PNG`,
    );
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
    // 用 Object.hasOwn 而不是真值判断：spec 是普通对象字面量，`spec.value['constructor']`
    // 会命中原型链上的 Object 构造器（真值），把提示词 "constructor" 当成选项、
    // 顺手吞掉后一个词；"hasOwnProperty" 则会报"后面要跟一个值"。
    if (Object.hasOwn(spec.value, arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw new Fail(`${arg} 后面要跟一个值`);
      flags[spec.value[arg]] = value;
      i += 1;
    } else if (Object.hasOwn(spec.bool, arg)) {
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
      endpoint === 'edit'
        ? `编辑接口的上限是 ${PROMPT_MAX.edit}（生成接口是 ${PROMPT_MAX.generate}），把描述压缩一下`
        : '把描述压缩一下',
    );
  }
  return text;
}

export function requireKey(config) {
  if (config.key) return;
  throw new Fail(
    `当前源 [${config.source?.id || 'default'}] 未配置 API 访问凭证（Key）`,
    `请在配置文件 ${basename(config.configFile || 'config.json')} 中为 [${config.source?.id || 'default'}] 填入 key，或在命令行使用 --key <token> 传递。`,
  );
}

// ---- doctor：配置和连通性自检 ----
// 通过 GET /v1/models 探测服务连通性与 Key 有效性，不消耗生图额度
export async function doctor(flags) {
  const lines = [];
  const major = Number(process.versions.node.split('.')[0]);
  lines.push(`Node ${process.versions.node} ${major >= 18 ? '✓' : '✗ 需要 18+（fetch / FormData / Blob）'}`);

  const sourcesInfo = loadSources(flags);
  const { sources, configDesc } = sourcesInfo;

  let targetSources = sources;
  if (flags.source) {
    const query = String(flags.source).trim().toLowerCase();
    targetSources = sources.filter((s) => s.id.toLowerCase() === query || s.name.toLowerCase() === query);
    if (targetSources.length === 0) {
      throw new Fail(`找不到指定的源：${flags.source}`, `当前可用源：${sources.map((s) => s.id).join(', ')}`);
    }
  }

  lines.push(`配置文件: ${configDesc}`);
  lines.push(`检测源数: ${targetSources.length} 个（总配置 ${sources.length} 个）`);

  const probeMs = 30000;
  let hasFailure = false;

  for (let idx = 0; idx < targetSources.length; idx++) {
    const s = targetSources[idx];
    const isMulti = targetSources.length > 1;
    if (isMulti) {
      lines.push('');
      lines.push(`==================== [${idx + 1}/${targetSources.length}] 源: [${s.id}] ${s.name}${s.isDefault ? ' (默认源)' : ''} ====================`);
    } else {
      lines.push(`源标识: [${s.id}] ${s.name}${s.isDefault ? ' (默认源)' : ''}`);
    }

    const baseUrl = flags.url ? apiRoot(flags.url) : s.baseUrl;
    const key = flags.key !== undefined ? String(flags.key).trim() : s.key;
    const keySource = flags.key !== undefined ? '命令行' : s.keySource;
    const urlSource = flags.url ? '命令行' : s.urlSource;

    lines.push(`服务 Base URL: ${baseUrl}（来自${urlSource}）`);
    lines.push(`生图端点: ${buildEndpointUrl(baseUrl, 'generate')}`);
    lines.push(`修图端点: ${buildEndpointUrl(baseUrl, 'edit')}`);

    lines.push(
      key
        ? `API Key: 已配置（来自${keySource}，${maskKey(key)}）`
        : 'API Key: 未配置 ✗ — 必填。请在配置文件中填入 key',
    );
    if (!key) hasFailure = true;

    lines.push(`配置模型: ${s.models.join('、')} (${s.models.length} 个)`);

    if (key && major >= 18) {
      const modelsUrl = `${apiRoot(baseUrl)}/v1/models`;
      lines.push(`探测端点: ${modelsUrl}（超时 ${probeMs / 1000} 秒，不消耗生图额度）`);

      try {
        const startedAt = Date.now();
        const resp = await fetch(modelsUrl, {
          headers: {
            Authorization: key.startsWith('Bearer ') ? key : `Bearer ${key}`,
          },
          signal: AbortSignal.timeout(probeMs),
        });
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

        if (resp.status === 200) {
          const data = await resp.json().catch(() => null);
          const serverModels = Array.isArray(data?.data) ? data.data.map((m) => m.id) : [];
          lines.push(`API 连通性: ✓ 成功连通（/v1/models HTTP 200，${seconds} 秒，共 ${serverModels.length} 个模型）`);
          const imageModels = serverModels.filter((id) => /image|dall|flux|paint|banana|seedream|kolors|midjourney|imagen|sdxl|sd3|qwen-?vl|grok-?image/i.test(id));
          if (imageModels.length) {
            lines.push(`疑似图像模型 (${imageModels.length} 个): ${imageModels.slice(0, 8).join(', ')}${imageModels.length > 8 ? ' …' : ''}`);
          } else if (serverModels.length) {
            lines.push(`未按名字识别出图像模型，服务端前几个模型: ${serverModels.slice(0, 8).join(', ')}${serverModels.length > 8 ? ' …' : ''}`);
          }
          for (const m of s.models) {
            if (serverModels.includes(m)) {
              lines.push(`配置模型 [${m}]: ✓ 已在服务可用模型列表中`);
            } else if (serverModels.length > 0) {
              lines.push(`配置模型 [${m}]: ? 未在服务模型列表中精确匹配（仍可能支持）`);
            }
          }
        } else if (resp.status === 401 || resp.status === 403) {
          lines.push(`API 连通性: ✗ 认证失败（HTTP ${resp.status}，${seconds} 秒），请检查凭证是否正确有效`);
          hasFailure = true;
        } else {
          lines.push(`API 连通性: ? 端点返回 HTTP ${resp.status}（${seconds} 秒）`);
        }
      } catch (e) {
        const chain = causeChain(e);
        if (/TimeoutError|AbortError/i.test(chain)) {
          lines.push(`API 连通性: ? ${probeMs / 1000} 秒内没响应 —— 服务较慢或偶发超时，可再跑一次`);
        } else if (/ENOTFOUND|EAI_AGAIN/i.test(chain)) {
          lines.push(`API 连通性: ✗ 域名解析不了 —— 检查接口地址拼写 (${e.message})`);
          hasFailure = true;
        } else if (/ECONNREFUSED/i.test(chain)) {
          lines.push(`API 连通性: ✗ 连接被拒 —— 地址或端口不对 (${e.message})`);
          hasFailure = true;
        } else {
          lines.push(`API 连通性: ✗ 无法连接 (${e.message})`);
          hasFailure = true;
        }
      }
    }
  }

  console.log(lines.join('\n'));
  return hasFailure ? 1 : 0;
}

/**
 * 统一的入口收尾：Fail 打印人话，其余打印堆栈。
 *
 * 只设 process.exitCode、不调 process.exit()：stdout 是管道时写入是异步的，
 * process.exit() 会把还没 flush 的部分直接丢掉（实测超过 64KB 的管道缓冲区就截断）。
 * --json 会回显 prompt，32000 字中文约 96KB，下游 JSON.parse 会拿到半截数据。
 * 设 exitCode 后让事件循环自然退出，Node 会把 stdout 排空。
 */
export function run(main) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      if (error instanceof Fail) {
        console.error(`错误：${error.message}`);
        if (error.hint) console.error(`提示：${error.hint}`);
      } else {
        console.error(`意外错误：${error?.stack || error}`);
      }
      process.exitCode = 1;
    });
}
