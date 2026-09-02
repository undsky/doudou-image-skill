#!/usr/bin/env node
// 文生图：走 n8n 的「生图 API（Base64）」/webhook/image-generate，把返回的 base64 落成图片文件。
// 产物路径走 stdout，进度和警告走 stderr。用法见 SKILL.md 或 --help。

import { readFileSync } from 'node:fs';
import {
  Fail, checkPrompt, doctor, explain, humanBytes, info, parseArgs, parseCount, parseTimeout,
  post, requireKey, resolveConfig, run, safeStem, saveImages,
} from './lib.mjs';

// 实测 n=1 约 20 秒；子工作流里 HTTP 超时 45 秒、失败重试一次，所以最坏接近 100 秒。
// 默认给 300 秒，留够余量，不用调。
const DEFAULT_TIMEOUT_MS = 300000;

const HELP = `文生图（经 n8n「生图 API（Base64）」），把结果落成图片文件。

用法：
  node scripts/generate.mjs <描述> [选项]
  node scripts/generate.mjs --prompt-file prompt.txt [选项]
  node scripts/generate.mjs --doctor

选项：
  -n <1-4>            生成几张（默认 1）
  -o, --output <路径> 保存位置：具体文件名、目录（以 / 结尾），或省略走 <项目根>/resources/images/
  --model <名字>      指定模型。默认不传，由服务端从启用的配置里随机选
  --prompt-file <文件> 从文件读描述，长 prompt 用它避免 shell 转义
  --json              输出结构化 JSON（含落盘路径，不含 base64）
  --timeout <秒>      等待上限，默认 ${DEFAULT_TIMEOUT_MS / 1000}
  --url <地址>        覆盖服务地址（默认读 .env 的 DOUDOU_IMAGE_URL）
  --key <uuid>        覆盖用户标识（别名 --uuid；更推荐用 DOUDOU_IMAGE_KEY）
  --doctor            自检配置和连通性，不生成任何图片
  -h, --help          显示本帮助

说明：
  提示词上限 8000 字。n 最多 4 —— 一次多张是一次请求，比连着调几次省时间。
  想要公开链接而不是本地文件，用 doudou-r2 skill 把落盘的图再传一次。`;

const SPEC = {
  value: {
    '-n': 'count',
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

async function main() {
  const flags = parseArgs(process.argv.slice(2), SPEC);
  if (flags.help) {
    console.log(HELP);
    return 0;
  }
  if (flags.doctorMode) return await doctor(flags);

  let raw = flags.positional.join(' ');
  if (flags.promptFile) {
    if (raw) throw new Fail('描述给重了：位置参数和 --prompt-file 只能用一个');
    try {
      raw = readFileSync(flags.promptFile, 'utf8');
    } catch (error) {
      throw new Fail(`读不到 --prompt-file 指的文件：${flags.promptFile}`, error.message);
    }
  }
  const prompt = checkPrompt(raw, 'generate');
  const n = parseCount(flags.count, 'generate');
  const timeoutMs = parseTimeout(flags.timeout, DEFAULT_TIMEOUT_MS);

  const config = resolveConfig(flags, 'generate');
  requireKey(config);

  // model 为空时不发这个字段：接口对「没传」和「空串」的处理一样（都随机选），
  // 但不发更能表达意图，也省得空串哪天被当成非法值
  const body = { prompt, n };
  if (flags.model) body.model = String(flags.model).trim();

  info(`生成中：${n} 张，${prompt.length} 字提示词${body.model ? `，模型 ${body.model}` : '（模型由服务端随机选）'}`);
  const startedAt = Date.now();
  const { status, json } = await post(config, JSON.stringify(body), { timeoutMs, isJson: true });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (status !== 200 || json.success !== true) {
    const model = body.model
      ? `--model ${body.model} 拼错了，或那条配置没启用（enabled != 1）；去掉 --model 让服务端随机选试试`
      : null;
    throw explain(status, json, config, {
      upstream: [
        ...(n > 1 ? [`n=${n} 时上游更容易半途失败，先用 -n 1 验证一次`] : []),
        ...(model ? [] : ['模型是服务端随机选的，可能选到了状态不好的那条；重试会换一条']),
      ],
      subworkflow: model ? [model] : [],
    });
  }
  const images = Array.isArray(json.images) ? json.images : [];
  if (!images.length) throw new Fail('接口回了成功但没有图片', JSON.stringify(json).slice(0, 300));

  const saved = await saveImages(images, flags, safeStem(prompt));
  info(`完成：${saved.length} 张，模型 ${json.model}，耗时 ${seconds} 秒`);

  if (flags.json) {
    // 故意不带 b64_json：一张就有 2MB 上下，塞进上下文纯浪费
    process.stdout.write(`${JSON.stringify({
      success: true,
      model: json.model,
      prompt: json.prompt,
      count: saved.length,
      seconds: Number(seconds),
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
