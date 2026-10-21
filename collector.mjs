#!/usr/bin/env node
// 赏金窗口观测采集器：每到新窗口记录一次 {Seed, Oracle 任务链, Jobs 类型}。
// 仅访问公开端点，不携带任何凭据；数据追加到 data/bounty-cycles.jsonl。
//
// 用法：node collector.mjs [--dry-run]
//   --dry-run  只打印将要写入的记录，不落盘（适合本地先验证端点连通性）

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { request } from 'node:https';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, 'data');
const DATA_FILE = join(DATA_DIR, 'bounty-cycles.jsonl');
const UA = 'voxalic-bounty-collector/1.0 (research; public endpoints only)';
// DE 官方 CDN 会对 GitHub 云端 IP 返回 403，因此官方优先、社区镜像兜底。
// 记录里写明实际来源，避免把镜像数据误标成官方。
const WORLDSTATE_URLS = [
  'https://api.warframe.com/cdn/worldState.php',
  'https://content.warframe.com/dynamic/worldState.php',
  'https://oracle.browse.wf/worldState.json',
];
const ORACLE_URL = 'https://oracle.browse.wf/bounty-cycle';
const TAGS = [
  'ZarimanSyndicate',
  'EntratiLabSyndicate',
  'HexSyndicate',
  'CetusSyndicate',
  'SolarisSyndicate',
  'EntratiSyndicate',
];

function getJsonOnce(url) {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Encoding': 'identity' } },
      res => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`${url} -> HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(new Error(`${url} -> invalid JSON: ${error.message}`));
          }
        });
      },
    );
    req.setTimeout(25_000, () => req.destroy(new Error(`${url} -> timeout`)));
    req.on('error', reject);
    req.end();
  });
}

async function getJson(url) {
  // 社区端点会间歇性超时 / 被 Cloudflare 重置，重试 3 次再放弃。
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await getJsonOnce(url);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 2_000));
    }
  }
  throw lastError;
}

function ms(value) {
  if (typeof value === 'number') return value;
  const raw = value?.$date?.$numberLong;
  return raw == null ? null : Number(raw);
}

function extractWindow(worldstate, now) {
  const entries = (worldstate?.SyndicateMissions ?? []).filter(e => TAGS.includes(e.Tag));
  // 用解到圣所的窗口作为主窗口；该派系每 150 分钟一轮。
  const main = entries.find(e => e.Tag === 'EntratiLabSyndicate');
  if (!main) throw new Error('worldstate 缺少 EntratiLabSyndicate');
  const activation = ms(main.Activation);
  const expiry = ms(main.Expiry);
  if (!activation || !expiry || !(activation <= now && now < expiry)) {
    throw new Error(`worldstate 窗口不在当前时间：activation=${activation} expiry=${expiry} now=${now}`);
  }
  const seeds = {};
  const jobs = {};
  for (const entry of entries) {
    seeds[entry.Tag] = entry.Seed ?? null;
    const list = (entry.Jobs ?? []).map(j => j.jobType).filter(Boolean);
    if (list.length) jobs[entry.Tag] = list;
  }
  return { activation, expiry, seed: main.Seed ?? null, seeds, jobs };
}

async function lastExpiry() {
  try {
    const raw = await readFile(DATA_FILE, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (!lines.length) return null;
    return JSON.parse(lines.at(-1)).window?.expiry ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const now = Date.now();
  const failures = [];
  let worldstate = null;
  for (const url of WORLDSTATE_URLS) {
    try {
      worldstate = { data: await getJson(url), source: url };
      break;
    } catch (error) {
      failures.push(error.message);
    }
  }
  if (!worldstate) throw new Error(`worldstate unavailable: ${failures.join(' | ')}`);
  const window = extractWindow(worldstate.data, now);
  const cycle = await getJson(ORACLE_URL);

  const oracleExpiry = typeof cycle?.expiry === 'number' ? cycle.expiry : null;
  if (oracleExpiry == null) throw new Error('Oracle 响应缺少 expiry');

  // 官方与社区窗口必须一致才落盘，避免把上一窗口的 Seed 配到下一窗口的任务链。
  if (oracleExpiry !== window.expiry) {
    console.log(
      `skip: 窗口不一致 official=${window.expiry} oracle=${oracleExpiry}（下次轮询重试）`,
    );
    return;
  }

  const previous = await lastExpiry();
  if (previous === window.expiry) {
    console.log(`skip: 窗口 ${window.expiry} 已记录`);
    return;
  }

  const bounties = {};
  for (const tag of ['ZarimanSyndicate', 'EntratiLabSyndicate', 'HexSyndicate']) {
    const rows = cycle?.bounties?.[tag];
    if (!Array.isArray(rows) || !rows.length) continue;
    bounties[tag] = rows.map(r => ({ node: r.node ?? null, challenge: r.challenge ?? null }));
  }
  const record = {
    collected_at: new Date(now).toISOString(),
    window: {
      activation: window.activation,
      expiry: window.expiry,
      seed: window.seed,
      seeds: window.seeds,
      source: worldstate.source,
    },
    oracle: { expiry: oracleExpiry, rot: cycle.rot ?? null, vaultRot: cycle.vaultRot ?? null, bounties },
    jobs: window.jobs,
  };

  const line = JSON.stringify(record);
  if (dryRun) {
    console.log(line);
    return;
  }
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(DATA_FILE, `${line}\n`, 'utf8');
  console.log(
    `recorded: expiry=${window.expiry} seed=${window.seed} oracle=${Object.keys(bounties).length} 阵营`,
  );
}

main().catch(error => {
  console.error(`collect failed: ${error.message}`);
  process.exitCode = 1;
});
