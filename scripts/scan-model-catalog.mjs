#!/usr/bin/env node
// Regenerate lib/model-catalog.mjs from ai.paratera.com's 模型广场 detail dialogs.
// The public /v1/models endpoint only publishes ids, so the plaza's 上下文长度 is
// the authoritative source for context windows. Read-only: it never clicks
// 申请API, never reveals a key and never writes to the profile.
//
//   node scripts/scan-model-catalog.mjs
//
// The browser profile is the plugin's dedicated one; the console session must
// already be connected (设置 → 清华算力余额 → 连接控制台).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openPage, closePage, acquireRefreshLock } from '../lib/refresh.mjs';
import { authenticateConsolePage, consoleEvaluate, EASYCOMPUTE_HOME } from '../lib/console.mjs';

const OUTPUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'model-catalog.mjs');

function parseSize(value) {
  const text = String(value ?? '').match(/(\d+(?:\.\d+)?)\s*([KM])/i);
  if (!text) return null;
  return Math.round(Number(text[1]) * (text[2].toUpperCase() === 'M' ? 1048576 : 1024));
}

const idVision = (id) => /vision|(?:^|[-_.])vl(?:$|[-_.\d])|\d+(?:\.\d+)?v(?:$|[-_.\d])|omni/i.test(id);

async function readModel(send, index) {
  await consoleEvaluate(send, `(() => {
    const nodes = [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && String(el.textContent || '').trim() === '查看详情');
    const node = nodes[${index}];
    if (!node) return false;
    (node.closest('a,button') || node).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 850));
  const info = await consoleEvaluate(send, `(() => {
    const modal = document.querySelector('.ant-modal, .ant-drawer');
    if (!modal) return { error: 'no-modal' };
    const text = String(modal.innerText || '');
    const id = (text.match(/模型ID\\s*\\n?\\s*([^\\n]+)/) || [])[1]?.trim();
    const context = (text.match(/上下文长度\\s*\\n?\\s*([^\\n]*)/) || [])[1]?.trim();
    const intro = (text.split('模型信息')[0] || '').slice(0, 400);
    const tags = [...modal.querySelectorAll('.ant-tag')].map((el) => String(el.innerText || '').trim()).filter(Boolean);
    return { id, context, intro, tags };
  })()`);
  await consoleEvaluate(send, `(() => { const close = document.querySelector('.ant-modal-close, .ant-drawer-close'); if (close) close.click(); return true; })()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  return info;
}

async function main() {
  const release = acquireRefreshLock();
  if (!release) throw new Error('another browser operation is running; retry later');
  let opened;
  try {
    opened = await openPage({ headed: false, url: EASYCOMPUTE_HOME });
    if (opened.error) throw new Error(opened.error);
    const auth = await authenticateConsolePage(opened.send);
    if (!auth.ok) throw new Error(auth.error || 'console authentication failed');
    await consoleEvaluate(opened.send, `(() => { location.hash = '#/lms/model'; return true; })()`);
    await new Promise((resolve) => setTimeout(resolve, 7000));
    const total = await consoleEvaluate(opened.send, `[...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && String(el.textContent || '').trim() === '查看详情').length`);
    if (!Number.isInteger(total) || total <= 0) throw new Error('model plaza listed no models');
    const catalog = {};
    for (let index = 0; index < total; index += 1) {
      const info = await readModel(opened.send, index);
      if (!info?.id) continue;
      const tags = info.tags || [];
      const contextWindow = parseSize(info.context) ?? tags.map(parseSize).find(Boolean);
      if (!contextWindow) continue; // generation/OCR models publish no context length
      catalog[info.id] = {
        contextWindow,
        vision: idVision(info.id) || tags.some((tag) => /视觉|图片理解|全模态|OCR|视频理解/.test(tag)) || /(?:支持|具备)[^。；]{0,40}(?:图像|图片|视觉|图文)|多模态|视觉语言/.test(info.intro || ''),
        reasoning: tags.some((tag) => /深度思考|强推理|推理模型/.test(tag)) || /推理模型|深度思考|思维链/.test(info.intro || ''),
      };
    }
    const ids = Object.keys(catalog).sort();
    const lines = ids.map((id) => `  ${JSON.stringify(id)}: { contextWindow: ${catalog[id].contextWindow}, vision: ${catalog[id].vision}, reasoning: ${catalog[id].reasoning} }`).join(',\n');
    const body = `// Context lengths captured from ai.paratera.com model plaza detail dialogs.\n// Regenerate with scripts/scan-model-catalog.mjs when the platform catalog changes.\nexport const MODEL_CATALOG = {\n${lines}\n};\n`;
    writeFileSync(OUTPUT, body);
    console.log(JSON.stringify({ ok: true, models: ids.length, output: OUTPUT }));
  } finally {
    try { if (opened && !opened.error) await closePage(opened); } catch {}
    release();
  }
}

main().catch((error) => { console.error(`model catalog scan failed: ${error.message}`); process.exitCode = 1; });
