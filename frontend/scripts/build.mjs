// 构建前后保留七天内用过的哈希资源，让旧标签页仍能打开按需加载的聊天面板。
import { copyFile, mkdir, readdir, rm, stat, utimes } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

async function files(root, prefix = "") {
  const entries = await readdir(join(root, prefix), { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const result = [];
  for (const entry of entries) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await files(root, path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

export async function retainAssets(source, retained, now = Date.now()) {
  for (const path of await files(source)) {
    const target = join(retained, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, path), target);
    const time = new Date(now);
    await utimes(target, time, time);
  }
  for (const path of await files(retained)) {
    const target = join(retained, path);
    if (now - (await stat(target)).mtimeMs > RETENTION_MS) await rm(target);
  }
}

async function build() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const retained = join(root, ".static-cache");
  const current = join(root, "out", "_next", "static");
  // 首次采用保留机制时，接住当前已部署版本；保留区独立于 Next.js 会清理的目录。
  await retainAssets(current, retained);
  const result = spawnSync(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "build"], {
    cwd: root, stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  // 只刷新本次实际生成资源的时间，旧资源不会因再次部署而无限续期。
  await retainAssets(join(root, ".next", "static"), retained);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build();
