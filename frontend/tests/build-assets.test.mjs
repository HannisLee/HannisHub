// 验证跨构建资源保留与到期清理，测试仅使用临时目录。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { retainAssets, RETENTION_MS } from '../scripts/build.mjs';

test('旧资源保留七天，新构建保留当前资源且不续期旧资源', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hannishub-assets-'));
  try {
    const source = join(root, 'current');
    const retained = join(root, 'retained');
    await mkdir(source);
    const now = Date.now();
    await writeFile(join(source, 'old.js'), '旧脚本');
    await retainAssets(source, retained, now);
    await rm(join(source, 'old.js'));
    await writeFile(join(source, 'new.js'), '新脚本');
    await retainAssets(source, retained, now + RETENTION_MS / 2);
    assert.equal(await readFile(join(retained, 'old.js'), 'utf8'), '旧脚本');
    await retainAssets(source, retained, now + RETENTION_MS + 1000);
    await assert.rejects(readFile(join(retained, 'old.js')), { code: 'ENOENT' });
    assert.equal(await readFile(join(retained, 'new.js'), 'utf8'), '新脚本');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
