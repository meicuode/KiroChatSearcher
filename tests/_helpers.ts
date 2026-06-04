import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 创建一个唯一临时目录 */
export function mkTempDir(prefix = 'kcs-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 递归删除临时目录 */
export function rmTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** 写入一个会话 JSON 文件，可选地设置 mtime */
export function writeSession(
  dir: string,
  name: string,
  obj: unknown,
  mtimeMs?: number
): string {
  const full = path.join(dir, name.endsWith('.json') ? name : name + '.json');
  fs.writeFileSync(full, JSON.stringify(obj), 'utf8');
  if (typeof mtimeMs === 'number') {
    const t = mtimeMs / 1000;
    fs.utimesSync(full, t, t);
  }
  return full;
}

/** 写入一个原始（可能损坏）文件 */
export function writeRaw(dir: string, name: string, content: string): string {
  const full = path.join(dir, name);
  fs.writeFileSync(full, content, 'utf8');
  return full;
}
