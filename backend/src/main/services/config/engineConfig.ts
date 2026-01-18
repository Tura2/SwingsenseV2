import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// JSON module import using import attributes (NodeNext requires explicit type)
import defaultJson from './default-engine-config.json' with { type: 'json' };

export function loadEngineConfig() {
  const envPath = process.env.ENGINE_CONFIG_PATH;
  let user: any = {};
  if (envPath && fs.existsSync(envPath)) {
    try { user = JSON.parse(fs.readFileSync(envPath,'utf8')); } catch {}
  }
  return deepMerge(defaultJson, user);
}

function deepMerge(a: any, b: any): any {
  if (Array.isArray(a) && Array.isArray(b)) return b.slice();
  if (typeof a === 'object' && typeof b === 'object') {
    const out: any = { ...a };
    for (const k of Object.keys(b)) out[k] = deepMerge(a?.[k], b[k]);
    return out;
  }
  return b === undefined ? a : b;
}
