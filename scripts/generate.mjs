#!/usr/bin/env node
// 文生图：对接 New API / 原生 OpenAI 图像接口（POST /v1/images/generations），将生成图片直接落盘。
// 产物路径走 stdout，进度和警告走 stderr。用法详见 SKILL.md 或 --help。

import { readFileSync } from 'node:fs';
import {
  Fail, KNOWN_GOOD_SIZE, checkPrompt, doctor, explain, humanBytes, info, parseArgs, parseCount,
  parseImageData, parseSizeArg, parseTimeout, post, requireKey, resolveConfig, resolveModel, run,
  safeStem, saveImages,
} from './lib.mjs';

const DEFAULT_TIMEOUT_MS = 300000;

const HELP = `文生图（对接 New API / OpenAI 原生图像生成接口），将结果落盘为图片文件。

用法：
  node scripts/generate.mjs <描述> [选项]
  node scripts/generate.mjs --prompt-file prompt.txt [选项]
  node scripts/generate.mjs --models
  node scripts/generate.mjs --doctor

选项：
  -n <1-10>           生成几张（默认 1）
  -o, --output <路径> 保存位置：具体文件名、目录（以 / 结尾），或省略走 <项目根>/resources/images/
  --model <名字>      指定模型（若配置了多个模型且未传此项，将提示选择）
  --models            列出当前配置的所有可用模型
  --size <尺寸>       1K / 2K / 4K 或具体像素如 ${KNOWN_GOOD_SIZE}。不传则不下发，由上游取默认
  --prompt-file <文件> 从文件读描述，长 prompt 用它避免 shell 转义
  --json              输出结构化 JSON（含落盘路径，不含 base64）
  --timeout <秒>      等待上限，默认 ${DEFAULT_TIMEOUT_MS / 1000}
  --url <地址>        覆盖服务地址（默认读 .env 的 IMAGE_API_URL）
  --key <token>       覆盖访问凭证（默认读 .env 的 IMAGE_API_KEY）
  --doctor            自检配置和连通性，不生成任何图片
  -h, --help          显示本帮助
  --                  之后的内容一律当描述（描述以 - 开头时用它）

说明：
  提示词上限 32000 字（按接口文档；具体模型可能更低）。n 最多 10，部分模型只支持 1。
  --size 实测只有 ${KNOWN_GOOD_SIZE} 稳定可用，其余值会先警告再发出。
  当配置了多个模型时，未指定 --model 将提示用户选择；若只配置了单个模型则直接使用。`;

const SPEC = {
  value: {
    '-n': 'count',
    '-o': 'output',
    '--output': 'output',
    '--model': 'model',
    '--size': 'size',
    '--prompt-file': 'promptFile',
    '--timeout': 'timeout',
    '--url': 'url',
    '--key': 'key',
  },
  bool: {
    '--models': 'listModels',
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

  const config = resolveConfig(flags, 'generate');
  if (flags.listModels) {
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(config.modelList, null, 2)}\n`);
    } else {
      for (const m of config.modelList) console.log(m);
    }
    return 0;
  }

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
  const size = parseSizeArg(flags.size, 'generate');

  requireKey(config);
  const model = await resolveModel(flags, config.modelList);

  // 只发文档里列出的字段。生成接口的参数表没有 response_format —— 真 OpenAI 的
  // gpt-image-1 收到它会回 400，而 b64_json / url 两种返回 parseImageData 都能吃，
  // 所以不必指定。
  const body = { prompt, model, n };
  if (size) body.size = size;

  info(`生成中：${n} 张${size ? ` ${size}` : ''}，${prompt.length} 字提示词，模型 ${model}`);
  const startedAt = Date.now();
  const { status, json } = await post(config, JSON.stringify(body), { timeoutMs, isJson: true });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (status !== 200 || !json || !Array.isArray(json.data)) {
    throw explain(status, json, config, {
      model,
      suggestions: [
        `检查当前模型 [${model}] 是否支持文生图`,
        ...(size && size !== KNOWN_GOOD_SIZE ? [`尺寸 ${size} 可能不被模型支持，改用 ${KNOWN_GOOD_SIZE} 或去掉 --size 重试`] : []),
        ...(n > 1 ? [`单次请求生成 ${n} 张可能导致超时或失败，可尝试 -n 1`] : []),
        ...(prompt.length > 4000 ? [`提示词 ${prompt.length} 字偏长，部分模型上限低于此，可压缩后重试`] : []),
        '使用 --doctor 检查连通性与模型列表',
      ],
    });
  }

  const images = await Promise.all(json.data.map(parseImageData));
  if (!images.length) throw new Fail('上游接口返回成功但未包含图片数据', JSON.stringify(json).slice(0, 300));

  const saved = await saveImages(images, flags, safeStem(prompt));
  info(`完成：${saved.length} 张，模型 ${model}，耗时 ${seconds} 秒`);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({
      success: true,
      model,
      prompt,
      size: size || null,
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
