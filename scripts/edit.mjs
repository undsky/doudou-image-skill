#!/usr/bin/env node
// 图像编辑（修图）：直接对接 New API / 原生 OpenAI 图像编辑接口（POST /v1/images/edits）。
// 待编辑图支持本地文件或 http(s) URL（本地直接下载）。
// 产物路径走 stdout，进度和警告走 stderr。用法详见 SKILL.md 或 --help。

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  Fail, KNOWN_GOOD_SIZE, checkMask, checkPrompt, doctor, explain, fetchRemoteImage,
  formatModelsOutput, formatSourcesOutput, humanBytes, info, loadSources, parseArgs, parseCount,
  parseImageData, parseSizeArg, parseTimeout, post, readImageFile, requireKey, resolveConfig,
  resolveModel, run, safeStem, saveImages,
} from './lib.mjs';

const DEFAULT_TIMEOUT_MS = 300000;

const HELP = `图像编辑 / 修图（对接 New API / OpenAI 原生图像编辑接口），将结果落盘为图片文件。

用法：
  node scripts/edit.mjs <图片> <怎么改> [选项]
  node scripts/edit.mjs https://example.com/a.png '把背景换成海边' [选项]
  node scripts/edit.mjs --sources
  node scripts/edit.mjs --models
  node scripts/edit.mjs --doctor

<图片> 可以是本地文件路径，也可以是 http(s) URL（本地下载后处理）。

选项：
  --mask <PNG>        只重画 mask 的透明区域。必须是带 alpha 的 PNG，尺寸和原图完全一致
  -n <1-10>           生成几张（默认 1）
  --size <尺寸>       1K / 2K / 4K 或具体像素。默认不下发，保持原图比例（推荐）
  -o, --output <路径> 保存位置：具体文件名、目录（以 / 结尾），或省略走 <项目根>/resources/images/
  --source <源ID/名>  指定使用的 API 源（若配置了多个源且未指定，未指定模型时将提示选择）
  --sources           列出当前配置的所有可用 API 源
  --model <名字>      指定模型（若配置了多个模型且未传此项，将提示选择；单源支持该模型时可自动路由）
  --models            列出当前配置的所有可用模型（可配合 --source 仅看指定源）
  --prompt-file <文件> 从文件读编辑描述
  --json              输出结构化 JSON（含落盘路径，不含 base64）
  --timeout <秒>      等待上限，默认 ${DEFAULT_TIMEOUT_MS / 1000}
  --url <地址>        覆盖服务地址（覆盖当前选定源的 URL）
  --key <token>       覆盖访问凭证（覆盖当前选定源的 Key）
  --doctor            自检配置和连通性，不编辑任何图片（可配合 --source 仅检测指定源）
  -h, --help          显示本帮助
  --                  之后的内容一律当描述（描述以 - 开头时用它）

说明：
  提示词上限 1000 字。待编辑图和 mask 各自不超过 4MB。
  --size 别乱动：实测只有 ${KNOWN_GOOD_SIZE} 可用，且传了会把非方图拉成方的。不传即保持原图比例。
  多源模式下，通过 --model 指定模型时，若只有一个源包含该模型，脚本将自动切换到对应源。
  mask 的透明区域 = 要重画的部分，不透明的部分保持原样。带 mask 时原图必须是 PNG。`;

const SPEC = {
  value: {
    '--mask': 'mask',
    '-n': 'count',
    '--size': 'size',
    '-o': 'output',
    '--output': 'output',
    '--source': 'source',
    '--model': 'model',
    '--prompt-file': 'promptFile',
    '--timeout': 'timeout',
    '--url': 'url',
    '--key': 'key',
  },
  bool: {
    '--sources': 'listSources',
    '--models': 'listModels',
    '--json': 'json',
    '--doctor': 'doctorMode',
    '-h': 'help',
    '--help': 'help',
  },
};

const isUrl = (value) => /^https?:\/\//i.test(String(value || ''));

async function main() {
  const flags = parseArgs(process.argv.slice(2), SPEC);
  if (flags.help) {
    console.log(HELP);
    return 0;
  }
  if (flags.doctorMode) return await doctor(flags);

  if (flags.listSources) {
    const sourcesInfo = loadSources(flags);
    process.stdout.write(formatSourcesOutput(sourcesInfo, flags.json));
    return 0;
  }

  if (flags.listModels) {
    const sourcesInfo = loadSources(flags);
    process.stdout.write(formatModelsOutput(sourcesInfo, flags, flags.json));
    return 0;
  }

  const config = await resolveConfig(flags, 'edit');

  const [target, ...rest] = flags.positional;
  if (!target) {
    throw new Fail('未提供待编辑的图片', '用法：edit.mjs <图片> <怎么改>。图片可以是本地路径或 http(s) URL');
  }

  let raw = rest.join(' ');
  if (flags.promptFile) {
    if (raw) throw new Fail('描述给重了：位置参数和 --prompt-file 只能用一个');
    try {
      raw = readFileSync(flags.promptFile, 'utf8');
    } catch (error) {
      throw new Fail(`读不到 --prompt-file 指的文件：${flags.promptFile}`, error.message);
    }
  }
  const prompt = checkPrompt(raw, 'edit');
  const n = parseCount(flags.count, 'edit');
  const timeoutMs = parseTimeout(flags.timeout, DEFAULT_TIMEOUT_MS);

  // 不传 --size 就不下发这个字段：以前无条件发 1024x1024，非方图（如 1448x1086）会被拉变形
  const size = parseSizeArg(flags.size, 'edit');

  requireKey(config);
  const model = await resolveModel(flags, config.modelList, config.source?.name);

  const remote = isUrl(target);
  const image = remote ? await fetchRemoteImage(target) : await readImageFile(target, '待编辑图片');
  const mask = flags.mask ? await readImageFile(flags.mask, 'mask') : null;
  if (mask) {
    checkMask(mask, image);
  }

  const where = remote ? target : `${target}（${humanBytes(image.bytes)}, ${image.mime}）`;
  info(`编辑中：${where}${mask ? ` + mask ${basename(mask.path)}` : ''}，${n} 张 ${size || '保持原尺寸'}，源 [${config.source.id}]，模型 ${model}`);

  const form = new FormData();
  form.append('image', new Blob([image.buffer], { type: image.mime }), image.filename || 'image.png');
  if (mask) {
    form.append('mask', new Blob([mask.buffer], { type: 'image/png' }), mask.filename || 'mask.png');
  }
  form.append('prompt', prompt);
  form.append('model', model);
  form.append('n', String(n));
  if (size) form.append('size', size);

  const startedAt = Date.now();
  const { status, json } = await post(config, form, { timeoutMs, isJson: false });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (status !== 200 || !json || !Array.isArray(json.data)) {
    const suggestions = [];
    if (size && size !== KNOWN_GOOD_SIZE) suggestions.push(`尺寸 ${size} 可能不被模型支持，去掉 --size 或改用 ${KNOWN_GOOD_SIZE} 重试`);
    if (mask) suggestions.push('部分模型不支持带 mask 编辑，可尝试去掉 --mask');
    if (image.mime !== 'image/png') suggestions.push(`接口文档要求待编辑图是 PNG，当前是 ${image.mime}，可先转成 PNG 再试`);
    suggestions.push(`确认当前源 [${config.source.id}] 的模型 [${model}] 是否支持图像编辑`);
    throw explain(status, json, config, { model, suggestions });
  }

  const images = await Promise.all(json.data.map(parseImageData));
  if (!images.length) throw new Fail('上游接口返回成功但未包含图片数据', JSON.stringify(json).slice(0, 300));

  const stem = remote ? safeStem(prompt) : `${safeStem(basename(image.path).replace(/\.[a-z0-9]+$/i, ''), 16)}-edit`;
  const saved = await saveImages(images, flags, stem);
  info(`完成：${saved.length} 张，源 [${config.source.id}]，模型 ${model}，耗时 ${seconds} 秒`);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({
      success: true,
      source: config.source.id,
      model,
      prompt,
      size: size || null,
      has_mask: !!mask,
      count: saved.length,
      seconds: Number(seconds),
      sourceImage: remote ? { url: target } : { path: image.path, mime_type: image.mime, bytes: image.bytes },
      images: saved,
    }, null, 2)}\n`);
  } else {
    for (const file of saved) {
      console.log(`${file.path}  (${file.mime_type}, ${humanBytes(file.bytes)})`);
    }
  }
  return 0;
}

run(main);
