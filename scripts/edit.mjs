#!/usr/bin/env node
// 图像编辑（修图）：走 n8n 的「生图 API（Base64）」/webhook/image-edit。
// 待编辑图可以是本地文件（走 multipart 上传）或 http(s) URL（服务端负责下载）。
// 产物路径走 stdout，进度和警告走 stderr。用法见 SKILL.md 或 --help。

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  EDIT_SIZES, Fail, checkMask, checkPrompt, doctor, explain, humanBytes, info, parseArgs,
  parseCount, parseTimeout, post, readImageFile, requireKey, resolveConfig, run, safeStem, saveImages,
} from './lib.mjs';

// 编辑子工作流里 HTTP 超时 120 秒，失败重试一次，带 mask 被拒还会换一家再打一次 ——
// 最坏能到 250 秒上下。默认 300 秒够用。
const DEFAULT_TIMEOUT_MS = 300000;

const HELP = `图像编辑 / 修图（经 n8n「生图 API（Base64）」），把结果落成图片文件。

用法：
  node scripts/edit.mjs <图片> <怎么改> [选项]
  node scripts/edit.mjs https://example.com/a.png '把背景换成海边' [选项]
  node scripts/edit.mjs --doctor

<图片> 可以是本地文件路径，也可以是 http(s) URL（服务端下载）。

选项：
  --mask <PNG>        只重画 mask 的透明区域。必须是带 alpha 的 PNG，尺寸和原图一致
  -n <1-10>           生成几张（默认 1）
  --size <尺寸>       ${EDIT_SIZES.join(' / ')}（默认 1024x1024）
  -o, --output <路径> 保存位置：具体文件名、目录（以 / 结尾），或省略走 <项目根>/resources/images/
  --model <名字>      指定模型。默认不传，由服务端从启用的配置里随机选
  --prompt-file <文件> 从文件读编辑描述
  --json              输出结构化 JSON（含落盘路径，不含 base64）
  --timeout <秒>      等待上限，默认 ${DEFAULT_TIMEOUT_MS / 1000}
  --url <地址>        覆盖服务地址（默认读 .env 的 DOUDOU_IMAGE_URL）
  --key <uuid>        覆盖用户标识（别名 --uuid；更推荐用 DOUDOU_IMAGE_KEY）
  --doctor            自检配置和连通性，不编辑任何图片
  -h, --help          显示本帮助

说明：
  提示词上限 1000 字（生成接口是 8000）。图和 mask 各自不超过 4MB，脚本发出前就会拦。
  mask 的透明区域 = 要重画的部分，不透明的部分保持原样。带 mask 时原图必须是 PNG。
  不是所有模型都支持带 mask 的编辑；被上游拒了服务端会自动换一条配置重试一次。`;

const SPEC = {
  value: {
    '--mask': 'mask',
    '-n': 'count',
    '--size': 'size',
    '-o': 'output',
    '--output': 'output',
    '--model': 'model',
    '--prompt-file': 'promptFile',
    '--timeout': 'timeout',
    '--url': 'url',
    '--key': 'key',
    '--uuid': 'key',
  },
  bool: {
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

  const [target, ...rest] = flags.positional;
  if (!target) {
    throw new Fail('没给待编辑的图片', '用法：edit.mjs <图片> <怎么改>。图片可以是本地路径或 http(s) URL');
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

  const size = flags.size ? String(flags.size).trim() : '1024x1024';
  if (!EDIT_SIZES.includes(size)) {
    throw new Fail(`--size 只认 ${EDIT_SIZES.join(' / ')}，收到：${size}`);
  }
  // 不硬拦：256/512 在接口白名单里，哪天换了支持的模型就能用。
  // 但实测当前启用的 gpt-image-2 一律回 400，白等 40 秒才报错，所以先说一声。
  if (size !== '1024x1024') {
    info(`注意：size=${size} 实测不被当前模型（gpt-image-2）支持，上游会回 400。稳妥起见用 1024x1024`);
  }
  const model = flags.model ? String(flags.model).trim() : '';

  // 图和 mask 都在本地先读出来查一遍：体积、真实格式、mask 的 alpha 和尺寸。
  // 上游对这些只回一个不带信息的裸 400，等它报错就没法定位了。
  const remote = isUrl(target);
  const image = remote ? null : await readImageFile(target, '待编辑图片');
  const mask = flags.mask ? await readImageFile(flags.mask, 'mask') : null;
  let maskInfo = null;
  if (mask) {
    maskInfo = checkMask(mask, image);
    if (!maskInfo.checkedSize) {
      // image_url 那条路原图还没下载，尺寸只能等服务端查
      info('注意：待编辑图是 URL，没法在本地比对 mask 尺寸。尺寸不一致会被服务端拒（400）');
    }
  }

  const config = resolveConfig(flags, 'edit');
  requireKey(config);

  const where = remote ? target : `${target}（${humanBytes(image.bytes)}, ${image.mime}）`;
  info(`编辑中：${where}${mask ? ` + mask ${basename(mask.path)}` : ''}，${n} 张 ${size}`
    + `${model ? `，模型 ${model}` : '（模型由服务端随机选）'}`);

  const startedAt = Date.now();
  const { status, json } = remote
    ? await post(config, JSON.stringify({
      // mask 不支持 url 形态，但 image_url + mask_b64 的组合服务端是收的
      image_url: target, prompt, n, size, ...(model ? { model } : {}), ...(mask ? { mask_b64: mask.buffer.toString('base64') } : {}),
    }), { timeoutMs, isJson: true })
    : await post(config, buildForm({ image, mask, prompt, n, size, model }), { timeoutMs, isJson: false });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (status !== 200 || json.success !== true) {
    const upstream = [];
    // 实测：gpt-image-2（目前唯一启用的模型）只吃 1024x1024，
    // 256/512 是接口白名单里的历史遗留，传了必挂
    if (size !== '1024x1024') upstream.push(`size=${size} 实测不被 gpt-image-2 支持，改回默认的 1024x1024 再试`);
    if (mask) upstream.push('不是所有模型都支持带 mask 的编辑，服务端换配置重试也可能全被拒；去掉 --mask 或显式 --model 试试');
    if (!model) upstream.push('模型是服务端随机选的，可能选到了只支持文生图的那条；显式传 --model 更稳');
    throw explain(status, json, config, {
      upstream,
      subworkflow: model
        ? [`--model ${model} 拼错了，或那条配置没启用（enabled != 1）；去掉 --model 让服务端随机选试试`]
        : [],
    });
  }
  const images = Array.isArray(json.images) ? json.images : [];
  if (!images.length) throw new Fail('接口回了成功但没有图片', JSON.stringify(json).slice(0, 300));

  const stem = remote ? safeStem(prompt) : `${safeStem(basename(target).replace(/\.[a-z0-9]+$/i, ''), 16)}-edit`;
  const saved = await saveImages(images, flags, stem);
  info(`完成：${saved.length} 张，模型 ${json.model}，耗时 ${seconds} 秒`);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({
      success: true,
      model: json.model,
      prompt: json.prompt,
      size: json.size,
      has_mask: json.has_mask === true,
      count: saved.length,
      seconds: Number(seconds),
      source: remote ? { image_url: target } : { image: image.path, mime_type: image.mime, bytes: image.bytes },
      images: saved,
    }, null, 2)}\n`);
  } else {
    for (const file of saved) {
      console.log(`${file.path}  (${file.mime_type}, ${humanBytes(file.bytes)})`);
    }
  }
  return 0;
}

// 字段名必须正好是 image 和 mask：工作流认不出的上传字段会直接报 400
// （而不是静默丢掉），所以这里不能图省事用 file0 之类的名字。
function buildForm({ image, mask, prompt, n, size, model }) {
  const form = new FormData();
  form.append('image', new Blob([image.buffer], { type: image.mime }), basename(image.path));
  if (mask) form.append('mask', new Blob([mask.buffer], { type: 'image/png' }), basename(mask.path));
  form.append('prompt', prompt);
  form.append('n', String(n));
  form.append('size', size);
  if (model) form.append('model', model);
  return form;
}

run(main);
