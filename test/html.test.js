/* index.html 里的内联脚本必须能解析。
   2026-08-21 加的全局错误探针，字符串里混进了一个真换行（本该是 \n），整段脚本解析失败，
   window.onerror 从来没装上——线上那一版的红条一次都不可能出现。`node --check` 只查 .js 文件，
   查不到 HTML 里的脚本，所以单独补这一条。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', 'index.html'), 'utf8');

test('index.html 的每段内联脚本都能解析', () => {
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(blocks.length > 0, '没找到内联脚本');
  for (const [i, code] of blocks.entries()){
    assert.doesNotThrow(() => new vm.Script(code, { filename:`index.html 第 ${i + 1} 段内联脚本` }));
  }
});

test('外链脚本的加载顺序：music.js 要在 script.js 之前', () => {
  const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]);
  const at = name => srcs.indexOf(name);
  assert.ok(at('music.js') >= 0, '没引入 music.js');
  assert.ok(at('music.js') < at('script.js'), 'music.js 排在了 script.js 后面');
});
