import * as crypto from 'crypto';
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
/* ------------------------------------------------------------------ *
 * 目录树夹具：mkTree / snapshotTree
 * ------------------------------------------------------------------ */

/** 文件节点：按字节数或按内容创建，可指定 mtime */
export interface FileNode {
  kind: 'file';
  /** 字节数（用 'a' 填充）；与 content 二选一，content 优先 */
  bytes?: number;
  content?: string;
  mtimeMs?: number;
}

/** 目录节点：children 为嵌套描述；mtime 在子项全部创建后设置 */
export interface DirNode {
  kind: 'dir';
  children?: TreeSpec;
  mtimeMs?: number;
}

/**
 * 符号链接节点。target 为绝对路径时原样使用，否则相对 `mkTree` 的 root 解析。
 * type 缺省时按 target 实际是目录还是文件自动判断；win32 上目录链接用 junction
 * （不需要管理员权限），文件链接在无权限时会抛 EPERM，可先用 `canSymlink()` 探测。
 */
export interface LinkNode {
  kind: 'link';
  target: string;
  type?: 'file' | 'dir';
}

/** 声明式目录树描述：值为数字（字节数）/ 字符串（内容）/ 节点 / 嵌套目录简写 */
export type TreeNode = number | string | FileNode | DirNode | LinkNode | TreeSpec;
export interface TreeSpec {
  [name: string]: TreeNode;
}

function isNode(v: TreeNode): v is FileNode | DirNode | LinkNode {
  return typeof v === 'object' && v !== null && typeof (v as { kind?: unknown }).kind === 'string';
}

function setMtime(p: string, mtimeMs: number): void {
  const t = mtimeMs / 1000;
  fs.utimesSync(p, t, t);
}

/**
 * 按声明式描述创建嵌套目录树。root 不存在时递归创建。
 *
 * ```ts
 * mkTree(root, {
 *   logs: { 'a.log': 100 },                                  // 目录简写
 *   'b.json': { kind: 'file', content: '{}', mtimeMs: 1000 },
 *   link: { kind: 'link', target: 'logs' },                   // 指向目录
 * });
 * ```
 */
export function mkTree(root: string, spec: TreeSpec): void {
  fs.mkdirSync(root, { recursive: true });
  buildInto(root, root, spec);
}

function buildInto(root: string, dir: string, spec: TreeSpec): void {
  for (const [name, node] of Object.entries(spec)) {
    const full = path.join(dir, name);
    if (typeof node === 'number') {
      fs.writeFileSync(full, Buffer.alloc(node, 0x61));
      continue;
    }
    if (typeof node === 'string') {
      fs.writeFileSync(full, node, 'utf8');
      continue;
    }
    if (!isNode(node)) {
      fs.mkdirSync(full, { recursive: true });
      buildInto(root, full, node);
      continue;
    }
    if (node.kind === 'file') {
      const data =
        typeof node.content === 'string'
          ? Buffer.from(node.content, 'utf8')
          : Buffer.alloc(node.bytes ?? 0, 0x61);
      fs.writeFileSync(full, data);
      if (typeof node.mtimeMs === 'number') setMtime(full, node.mtimeMs);
      continue;
    }
    if (node.kind === 'dir') {
      fs.mkdirSync(full, { recursive: true });
      buildInto(root, full, node.children ?? {});
      // 子项创建会改动目录 mtime，故在最后设置
      if (typeof node.mtimeMs === 'number') setMtime(full, node.mtimeMs);
      continue;
    }
    // link
    const target = path.isAbsolute(node.target) ? node.target : path.resolve(root, node.target);
    let type = node.type;
    if (!type) {
      let isDir = false;
      try {
        isDir = fs.statSync(target).isDirectory();
      } catch {
        isDir = false;
      }
      type = isDir ? 'dir' : 'file';
    }
    const winType = type === 'dir' ? 'junction' : 'file';
    fs.symlinkSync(target, full, process.platform === 'win32' ? winType : type);
  }
}

/**
 * 探测当前进程能否在 dir 下创建文件符号链接（Windows 无权限时为 false）。
 * 目录链接走 junction，通常总是可用。
 */
export function canSymlink(dir: string): boolean {
  const target = path.join(dir, `.probe-target-${process.pid}`);
  const link = path.join(dir, `.probe-link-${process.pid}`);
  try {
    fs.writeFileSync(target, 'x', 'utf8');
    fs.symlinkSync(target, link, 'file');
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(link);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(target);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 递归快照目录树：`相对路径（'/' 分隔，root 自身为 '.'）→ { size, mtimeMs }`。
 * 用 `lstat` 因此不跟随符号链接；目录自身也入表，故子项增删可被前后对比捕获。
 */
export function snapshotTree(root: string): Record<string, { size: number; mtimeMs: number }> {
  const out: Record<string, { size: number; mtimeMs: number }> = {};
  const walk = (abs: string, rel: string): void => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      return;
    }
    out[rel] = { size: st.size, mtimeMs: st.mtimeMs };
    if (st.isDirectory()) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(abs).sort();
      } catch {
        return;
      }
      for (const name of names) {
        walk(path.join(abs, name), rel === '.' ? name : `${rel}/${name}`);
      }
    }
  };
  walk(root, '.');
  return out;
}

/* ------------------------------------------------------------------ *
 * 记录型只读 fs：recordingReadFs
 * ------------------------------------------------------------------ */

export interface DirentLike {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFile(): boolean;
}

export interface StatLike {
  size: number;
  mtimeMs: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** 与 `src/storage/scanner.ts` 的 ScannerFsDeps 结构一致（结构化类型，无需 import） */
export interface ScannerFsDeps {
  readdir: (p: string, o: { withFileTypes: true }) => Promise<DirentLike[]>;
  lstat: (p: string) => Promise<StatLike>;
  yieldNow?: () => Promise<void>;
}

/** ReadOnlyPaths 上除扫描外还会用到的两个只读调用（analyzer / orphan / ranking 取数） */
export interface ReadFsExtras {
  stat: (p: string) => Promise<StatLike>;
  readFile: (p: string, enc: 'utf8') => Promise<string>;
}

export interface CallRecord {
  op: string;
  args: unknown[];
}

/**
 * 记录型只读 fs：只暴露读调用，记录每次调用的方法名与实参，
 * 供「统计路径只读 + 调用面 ⊆ {readdir, lstat, stat, readFile}」这类断言使用。
 * `base` 可逐个覆盖实现（缺省委托真实 `fs.promises`）。
 */
export function recordingReadFs(base: Partial<ScannerFsDeps & ReadFsExtras> = {}): {
  deps: ScannerFsDeps & ReadFsExtras;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  const rec =
    <A extends unknown[], R>(op: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      calls.push({ op, args });
      return fn(...args);
    };

  const deps: ScannerFsDeps & ReadFsExtras = {
    readdir: rec(
      'readdir',
      base.readdir ??
        ((p: string, o: { withFileTypes: true }) =>
          fs.promises.readdir(p, o) as unknown as Promise<DirentLike[]>)
    ),
    lstat: rec(
      'lstat',
      base.lstat ?? ((p: string) => fs.promises.lstat(p) as unknown as Promise<StatLike>)
    ),
    stat: rec(
      'stat',
      base.stat ?? ((p: string) => fs.promises.stat(p) as unknown as Promise<StatLike>)
    ),
    readFile: rec(
      'readFile',
      base.readFile ?? ((p: string, enc: 'utf8') => fs.promises.readFile(p, enc))
    ),
    yieldNow: rec('yieldNow', base.yieldNow ?? (() => Promise.resolve())),
  };
  return { deps, calls };
}

/* ------------------------------------------------------------------ *
 * 记录型可写 fs：recordingCleanerFs
 * ------------------------------------------------------------------ */

/** 与 `src/storage/cleaner.ts` 的 CleanerFsDeps 结构一致 */
export interface CleanerFsDeps {
  unlink: (p: string) => Promise<void>;
  stat: (p: string) => Promise<{ size: number; mtimeMs: number; isSymbolicLink(): boolean }>;
  readFile: (p: string, enc: 'utf8') => Promise<string>;
  writeFile: (p: string, data: string, enc: 'utf8') => Promise<void>;
  delay?: (ms: number) => Promise<void>;
}

/** 内存文件：数字为字节数、字符串为内容，或给出完整描述 */
export interface MemFile {
  content?: string;
  size?: number;
  mtimeMs?: number;
  symlink?: boolean;
}
export type MemTree = Record<string, MemFile | string | number>;

export type CleanerOp = 'unlink' | 'stat' | 'readFile' | 'writeFile';

/** 单个注入点：命中路径（可限定 op）时抛出带 code 的错误，最多 times 次 */
export interface FaultInjection {
  code?: string;
  /** 失败次数上限，缺省为无限（恒失败） */
  times?: number;
  /** 限定只对某个调用生效，缺省对所有调用生效 */
  op?: CleanerOp;
}

/** 「确认后变更」：改 size / mtimeMs，或让文件消失，用于 TOCTOU 复核 */
export interface MutationSpec {
  size?: number;
  mtimeMs?: number;
  missing?: boolean;
}

export interface FaultSpec {
  /** 可重试的锁类失败（EBUSY / EPERM / EACCES），默认 code 为 EBUSY */
  lock?: Record<string, FaultInjection>;
  /** 不可重试的失败，默认 code 为 EIO */
  fatal?: Record<string, FaultInjection>;
  /** 由 `applyAfterConfirm()` 触发的变更（在确认之后、re-stat 复核之前） */
  afterConfirm?: Record<string, MutationSpec>;
}

export interface RecordingCleanerFs {
  deps: CleanerFsDeps;
  calls: CallRecord[];
  /** 已注入的等待毫秒数序列（deps.delay 不真的睡） */
  delays: number[];
  /** 当前内存树快照：绝对路径 → { size, mtimeMs } */
  snapshot(): Record<string, { size: number; mtimeMs: number }>;
  exists(p: string): boolean;
  /** 应用 faults.afterConfirm 声明的变更；返回被改动的路径数 */
  applyAfterConfirm(): number;
  /** 手动改动内存树（测试自定义 TOCTOU 场景） */
  setFile(p: string, f: MemFile | string | number): void;
  removeFile(p: string): boolean;
}

interface MemEntry {
  content: string | undefined;
  size: number;
  mtimeMs: number;
  symlink: boolean;
}

function normalizeMemFile(v: MemFile | string | number, fallbackMtime: number): MemEntry {
  if (typeof v === 'number') {
    return { content: undefined, size: v, mtimeMs: fallbackMtime, symlink: false };
  }
  if (typeof v === 'string') {
    return {
      content: v,
      size: Buffer.byteLength(v, 'utf8'),
      mtimeMs: fallbackMtime,
      symlink: false,
    };
  }
  const content = v.content;
  return {
    content,
    size: typeof v.size === 'number' ? v.size : content ? Buffer.byteLength(content, 'utf8') : 0,
    mtimeMs: typeof v.mtimeMs === 'number' ? v.mtimeMs : fallbackMtime,
    symlink: v.symlink === true,
  };
}

function errWithCode(code: string, op: string, p: string): Error {
  const e = new Error(`${code}: ${op} '${p}'`);
  (e as Error & { code: string }).code = code;
  return e;
}

const DEFAULT_MEM_MTIME = 1_700_000_000_000;

/**
 * 记录型可写 fs：在内存目录树上模拟 `unlink` / `stat` / `readFile` / `writeFile`。
 *
 * - 记录每次调用的方法名与实参，供「删除路径调用面白名单」与
 *   「unlink 实参 ⊆ CleanupPlan 文件集合」这类断言使用
 * - `faults.lock` 注入可重试的锁类失败（`EBUSY` / `EPERM` / `EACCES`），
 *   `times` 用完后自动放行，可断言「至多重试 3 次」
 * - `faults.fatal` 注入不可重试失败
 * - `faults.afterConfirm` + `applyAfterConfirm()` 模拟「确认后变更」
 *   （改 `size` / `mtimeMs` 或让文件消失）以测 TOCTOU 复核
 * - `deps.delay` 只记录毫秒数，不真的等待
 */
export function recordingCleanerFs(tree: MemTree, faults: FaultSpec = {}): RecordingCleanerFs {
  const files = new Map<string, MemEntry>();
  for (const [p, v] of Object.entries(tree)) {
    files.set(path.resolve(p), normalizeMemFile(v, DEFAULT_MEM_MTIME));
  }

  const calls: CallRecord[] = [];
  const delays: number[] = [];
  const hits = new Map<string, number>();

  const faultFor = (kind: 'lock' | 'fatal', op: CleanerOp, p: string): FaultInjection | null => {
    const table = faults[kind];
    if (!table) return null;
    const spec = table[p] ?? table[path.resolve(p)];
    if (!spec) return null;
    if (spec.op && spec.op !== op) return null;
    const key = `${kind}:${op}:${path.resolve(p)}`;
    const used = hits.get(key) ?? 0;
    const limit = typeof spec.times === 'number' ? spec.times : Number.POSITIVE_INFINITY;
    if (used >= limit) return null;
    hits.set(key, used + 1);
    return spec;
  };

  const checkFaults = (op: CleanerOp, p: string): void => {
    const fatal = faultFor('fatal', op, p);
    if (fatal) throw errWithCode(fatal.code ?? 'EIO', op, p);
    const lock = faultFor('lock', op, p);
    if (lock) throw errWithCode(lock.code ?? 'EBUSY', op, p);
  };

  const get = (op: CleanerOp, p: string): MemEntry => {
    const entry = files.get(path.resolve(p));
    if (!entry) throw errWithCode('ENOENT', op, p);
    return entry;
  };

  const deps: CleanerFsDeps = {
    async unlink(p) {
      calls.push({ op: 'unlink', args: [p] });
      checkFaults('unlink', p);
      get('unlink', p);
      files.delete(path.resolve(p));
    },
    async stat(p) {
      calls.push({ op: 'stat', args: [p] });
      checkFaults('stat', p);
      const e = get('stat', p);
      return { size: e.size, mtimeMs: e.mtimeMs, isSymbolicLink: () => e.symlink };
    },
    async readFile(p, enc) {
      calls.push({ op: 'readFile', args: [p, enc] });
      checkFaults('readFile', p);
      const e = get('readFile', p);
      return e.content ?? '';
    },
    async writeFile(p, data, enc) {
      calls.push({ op: 'writeFile', args: [p, data, enc] });
      checkFaults('writeFile', p);
      const key = path.resolve(p);
      const prev = files.get(key);
      files.set(key, {
        content: data,
        size: Buffer.byteLength(data, 'utf8'),
        mtimeMs: (prev?.mtimeMs ?? DEFAULT_MEM_MTIME) + 1,
        symlink: prev?.symlink ?? false,
      });
    },
    async delay(ms) {
      calls.push({ op: 'delay', args: [ms] });
      delays.push(ms);
    },
  };

  return {
    deps,
    calls,
    delays,
    snapshot() {
      const out: Record<string, { size: number; mtimeMs: number }> = {};
      for (const [p, e] of files) out[p] = { size: e.size, mtimeMs: e.mtimeMs };
      return out;
    },
    exists(p) {
      return files.has(path.resolve(p));
    },
    applyAfterConfirm() {
      let changed = 0;
      for (const [p, m] of Object.entries(faults.afterConfirm ?? {})) {
        const key = path.resolve(p);
        if (m.missing) {
          if (files.delete(key)) changed++;
          continue;
        }
        const e = files.get(key);
        if (!e) continue;
        if (typeof m.size === 'number') e.size = m.size;
        if (typeof m.mtimeMs === 'number') e.mtimeMs = m.mtimeMs;
        changed++;
      }
      return changed;
    },
    setFile(p, f) {
      files.set(path.resolve(p), normalizeMemFile(f, DEFAULT_MEM_MTIME));
    },
    removeFile(p) {
      return files.delete(path.resolve(p));
    },
  };
}

/* ------------------------------------------------------------------ *
 * Kiro 1.x（新格式）夹具：
 *   mkNewSessionTree / mkMessagesJsonl / mkMigrationMarker
 *
 * 对应的真实磁盘结构（研究笔记第 2 节实测）：
 *
 *   ~/.kiro/sessions/<wsHash16>/<sessionId>/
 *       session.json                    会话元数据
 *       messages.jsonl                  对话本体，一行一事件
 *       snapshots/<hash>/<相对路径>      文件检查点（1.x 的"执行存档"对应物）
 *       sub-executions/...              子代理执行
 *       publish.cursor / publish-sub.cursor
 *
 * 旧目录（0.9x）里迁移后留下的标记：
 *   <workspace-sessions>/<EncodedKey>/._migration-<uuid>.json
 * ------------------------------------------------------------------ */

/** 夹具默认工作区路径（仅作占位；关心该值的测试请显式指定） */
const DEFAULT_FIXTURE_WORKSPACE = process.platform === 'win32' ? 'd:\\ws' : '/ws';
/** 夹具默认时间基准：createdAt */
const DEFAULT_CREATED_AT = '2026-08-01T00:00:00.000Z';
/** 夹具默认时间基准：lastModifiedAt，同时用作 messages.jsonl 事件 timestamp 起点 */
const DEFAULT_MODIFIED_AT = '2026-09-01T00:00:00.000Z';

/**
 * `session.json` 的字段描述。字段名与 1.x 实测结构一致。
 * 显式写成 `undefined` 的字段会从产出的 JSON 中**省略**（用于构造缺字段的夹具）。
 * 额外字段原样写入，便于构造未知/新增字段的夹具。
 */
export interface NewSessionJsonSpec {
  schemaVersion?: string;
  dataModelVersion?: number;
  /** 会话 id，缺省取 `NewSessionTreeSpec.sessionId`（即目录名） */
  id?: string;
  /** 标题；空串或纯空白用于测「空白标题 → Untitled」占位 */
  title?: string;
  agentMode?: string;
  workspacePaths?: string[];
  rootPaths?: string[];
  createdAt?: string;
  /** 最后修改时间；非法值用于测「回退 messages.jsonl 的 mtime」 */
  lastModifiedAt?: string;
  modelId?: string;
  autopilot?: boolean;
  effortLevel?: string;
  status?: string;
  [extra: string]: unknown;
}

/** 一条合法的 `messages.jsonl` 事件：磁盘上每行即一个此对象 */
export interface MessageEventSpec {
  /** 缺省 `evt-<序号>` */
  id?: string;
  /** 缺省由 `baseTimestampMs` 起每条 +1s 推导 */
  timestamp?: string;
  /** `payload.type` 为 `user` / `assistant` / `usage_summary` / `tool_call` 等 14 种之一 */
  payload: MessagePayloadSpec;
}

/** 事件负载：`type` 必填，其余字段随事件类型自由扩展 */
export interface MessagePayloadSpec {
  type: string;
  [extra: string]: unknown;
}

/** 原样写入的一行：用于在任意位置插入**非法 JSON 行**以测容错（Property 4） */
export interface RawJsonlLine {
  /** 行内容，原样写入（不做转义、不加引号） */
  raw: string;
}

/**
 * `messages.jsonl` 的一行描述：
 * - `MessageEventSpec` → 序列化为 `{id,timestamp,payload}` 的合法 JSON 行
 * - `RawJsonlLine` / 裸字符串 → 原样写入，可为任意非法 JSON
 */
export type JsonlLineSpec = MessageEventSpec | RawJsonlLine | string;

export interface MkMessagesJsonlOptions {
  /** 自动推导 timestamp 的起点（毫秒），缺省 `DEFAULT_MODIFIED_AT` */
  baseTimestampMs?: number;
  /** 相邻事件的时间步长（毫秒），缺省 1000 */
  stepMs?: number;
  /** 是否以换行结尾，缺省 true（与真实追加式写入一致） */
  trailingNewline?: boolean;
}

function isRawLine(v: JsonlLineSpec): v is RawJsonlLine {
  return typeof v === 'object' && v !== null && typeof (v as { raw?: unknown }).raw === 'string';
}

/**
 * 生成 `messages.jsonl` 文本：每行一个 `{ id, timestamp, payload }`。
 *
 * 裸字符串或 `{ raw }` 元素**原样写入**，因此可以在任意位置插入非法 JSON 行、
 * 空行或截断行，用于验证「单行非法 → 跳过该行、其余行照常解析」。
 *
 * ```ts
 * mkMessagesJsonl([
 *   { payload: { type: 'user', content: 'hello' } },
 *   '{ not json',                                        // 非法行
 *   { payload: { type: 'assistant', content: 'hi' } },
 *   { payload: { type: 'usage_summary', usage: [{ unit: 'credit', amount: 1.5 }] } },
 * ]);
 * ```
 *
 * @param lines 行描述序列，顺序即磁盘上的行顺序
 * @param opts  timestamp 推导与结尾换行控制
 */
export function mkMessagesJsonl(
  lines: JsonlLineSpec[],
  opts: MkMessagesJsonlOptions = {}
): string {
  const base = opts.baseTimestampMs ?? Date.parse(DEFAULT_MODIFIED_AT);
  const step = opts.stepMs ?? 1000;
  const out: string[] = [];

  lines.forEach((line, i) => {
    if (typeof line === 'string') {
      out.push(line);
      return;
    }
    if (isRawLine(line)) {
      out.push(line.raw);
      return;
    }
    out.push(
      JSON.stringify({
        id: line.id ?? `evt-${i + 1}`,
        timestamp: line.timestamp ?? new Date(base + i * step).toISOString(),
        payload: line.payload,
      })
    );
  });

  if (out.length === 0) return '';
  const text = out.join('\n');
  return opts.trailingNewline === false ? text : text + '\n';
}

/** 新格式会话目录的夹具描述 */
export interface NewSessionTreeSpec {
  /** 工作区目录名，即 `<sessionsRoot>/<wsHash16>`（由调用方给定，helper 不计算哈希） */
  wsHash16: string;
  /** 会话目录名：迁移来的为裸 uuid，1.x 新建的形如 `sess_<uuid>` */
  sessionId: string;
  /** `session.json` 字段；`null` 表示**不生成该文件**（测「缺文件的会话被跳过」） */
  session?: NewSessionJsonSpec | null;
  /** 原样写入 `session.json`（可为非法 JSON），优先于 `session` */
  sessionJsonRaw?: string;
  /** `session.json` 的 mtime（测 `(mtimeMs,size)` 缓存失效） */
  sessionJsonMtimeMs?: number;
  /** `messages.jsonl` 的行序列；`null` 表示**不生成该文件** */
  events?: JsonlLineSpec[] | null;
  /** 原样写入 `messages.jsonl`，优先于 `events` */
  messagesJsonlRaw?: string;
  /** `messages.jsonl` 的 mtime（测 `lastModifiedAt` 非法时回退 mtime、以及缓存失效） */
  messagesMtimeMs?: number;
  /** `mkMessagesJsonl` 的选项（仅在使用 `events` 时生效） */
  messagesOptions?: MkMessagesJsonlOptions;
  /**
   * `snapshots/` 子树。键可含 `/` 或 `\` 表示多级路径，
   * 故可直接写 `{ 'abc123/src/a.ts': 100 }` 得到 `snapshots/abc123/src/a.ts`（100 字节）。
   * 给空对象 `{}` 则只建出空的 `snapshots/` 目录。
   */
  snapshots?: TreeSpec;
  /** `sub-executions/` 子树，键的多级路径展开规则同 `snapshots` */
  subExecutions?: TreeSpec;
  /** 会话目录下的其余文件，如 `{ 'publish.cursor': 12 }` */
  extra?: TreeSpec;
}

/** `mkNewSessionTree` 产出的关键路径；未生成的部分为 `null` */
export interface NewSessionTreePaths {
  /** 传入的 sessions 根（对应 `~/.kiro/sessions`） */
  root: string;
  wsHash16: string;
  /** `<root>/<wsHash16>` */
  workspaceDir: string;
  sessionId: string;
  /** `<root>/<wsHash16>/<sessionId>` */
  sessionDir: string;
  sessionJson: string | null;
  messagesJsonl: string | null;
  snapshotsDir: string | null;
  subExecutionsDir: string | null;
}

/**
 * 在临时目录里构造一个 1.x **目录型**会话：
 * `<root>/<spec.wsHash16>/<spec.sessionId>/` 下按需生成
 * `session.json`、`messages.jsonl`、`snapshots/<hash>/<相对路径>`、`sub-executions/`
 * 与其它文件（如 `publish.cursor`）。
 *
 * `root` 对应 `~/.kiro/sessions`；`wsHash16` 由调用方给定（本 helper 不实现哈希算法，
 * 以免与被测的 `computeWsHash16` 互相印证成同义反复）。
 *
 * ```ts
 * const t = mkNewSessionTree(sessionsRoot, {
 *   wsHash16: 'cc5023603866cd91',
 *   sessionId: 'sess_1f0d…',
 *   session: { title: 'Spec: foo', lastModifiedAt: '2026-09-01T05:07:55.425Z' },
 *   events: [{ payload: { type: 'user', content: 'hi' } }],
 *   snapshots: { 'h1/src/a.ts': 120 },
 *   extra: { 'publish.cursor': 8 },
 * });
 * ```
 *
 * 底层复用 `mkTree`，故 `snapshots` / `subExecutions` / `extra` 支持 `mkTree`
 * 的全部节点形态（数字=字节数、字符串=内容、`FileNode` / `DirNode` / `LinkNode`）；
 * `LinkNode.target` 的相对路径以**会话目录**为基准解析。
 *
 * @param root sessions 根目录（`~/.kiro/sessions` 的替身）
 * @param spec 会话目录内容描述
 * @returns 各关键路径，便于测试直接 stat / 读改
 */
export function mkNewSessionTree(root: string, spec: NewSessionTreeSpec): NewSessionTreePaths {
  const workspaceDir = path.join(root, spec.wsHash16);
  const sessionDir = path.join(workspaceDir, spec.sessionId);

  const sessionJsonText = buildSessionJsonText(spec);
  const messagesText = buildMessagesText(spec);

  const tree: TreeSpec = {};
  if (sessionJsonText !== null) {
    tree['session.json'] = {
      kind: 'file',
      content: sessionJsonText,
      mtimeMs: spec.sessionJsonMtimeMs,
    };
  }
  if (messagesText !== null) {
    tree['messages.jsonl'] = {
      kind: 'file',
      content: messagesText,
      mtimeMs: spec.messagesMtimeMs,
    };
  }
  if (spec.snapshots) {
    tree['snapshots'] = { kind: 'dir', children: nestTreeSpec(spec.snapshots) };
  }
  if (spec.subExecutions) {
    tree['sub-executions'] = { kind: 'dir', children: nestTreeSpec(spec.subExecutions) };
  }
  if (spec.extra) {
    Object.assign(tree, nestTreeSpec(spec.extra));
  }

  mkTree(sessionDir, tree);

  return {
    root,
    wsHash16: spec.wsHash16,
    workspaceDir,
    sessionId: spec.sessionId,
    sessionDir,
    sessionJson: sessionJsonText === null ? null : path.join(sessionDir, 'session.json'),
    messagesJsonl: messagesText === null ? null : path.join(sessionDir, 'messages.jsonl'),
    snapshotsDir: spec.snapshots ? path.join(sessionDir, 'snapshots') : null,
    subExecutionsDir: spec.subExecutions ? path.join(sessionDir, 'sub-executions') : null,
  };
}

/** 组装 `session.json` 文本；返回 `null` 表示不生成该文件 */
function buildSessionJsonText(spec: NewSessionTreeSpec): string | null {
  if (typeof spec.sessionJsonRaw === 'string') return spec.sessionJsonRaw;
  if (spec.session === null) return null;

  const defaults: NewSessionJsonSpec = {
    schemaVersion: '1.0.0',
    dataModelVersion: 1,
    id: spec.sessionId,
    title: `Session ${spec.sessionId}`,
    agentMode: 'vibe',
    workspacePaths: [DEFAULT_FIXTURE_WORKSPACE],
    rootPaths: [DEFAULT_FIXTURE_WORKSPACE],
    createdAt: DEFAULT_CREATED_AT,
    lastModifiedAt: DEFAULT_MODIFIED_AT,
    modelId: 'claude-opus-5',
    autopilot: true,
    effortLevel: 'high',
    status: 'in_progress',
  };
  // 显式 undefined 的字段经 JSON.stringify 后被省略 —— 即"缺该字段"的夹具
  return JSON.stringify({ ...defaults, ...(spec.session ?? {}) });
}

/** 组装 `messages.jsonl` 文本；返回 `null` 表示不生成该文件 */
function buildMessagesText(spec: NewSessionTreeSpec): string | null {
  if (typeof spec.messagesJsonlRaw === 'string') return spec.messagesJsonlRaw;
  if (spec.events === null) return null;
  return mkMessagesJsonl(spec.events ?? [], spec.messagesOptions);
}

/**
 * 把键里的多级路径（`a/b/c.ts`、`a\b\c.ts`）展开为嵌套 `TreeSpec`，
 * 使 `mkTree` 能逐级建目录。同名目录合并，`DirNode.children` 亦递归展开。
 */
function nestTreeSpec(spec: TreeSpec): TreeSpec {
  const out: TreeSpec = {};
  for (const [rawName, node] of Object.entries(spec)) {
    const segs = rawName.split(/[/\\]+/).filter((s) => s.length > 0 && s !== '.');
    if (segs.length === 0) continue;

    let cursor = out;
    for (const seg of segs.slice(0, -1)) {
      const existing = cursor[seg];
      if (isPlainSpec(existing)) {
        cursor = existing;
      } else {
        const next: TreeSpec = {};
        cursor[seg] = next;
        cursor = next;
      }
    }

    const leaf = segs[segs.length - 1];
    const value = normalizeNestedNode(node);
    const prev = cursor[leaf];
    cursor[leaf] = isPlainSpec(prev) && isPlainSpec(value) ? { ...prev, ...value } : value;
  }
  return out;
}

function isPlainSpec(v: TreeNode | undefined): v is TreeSpec {
  return typeof v === 'object' && v !== null && !isNode(v);
}

function normalizeNestedNode(node: TreeNode): TreeNode {
  if (isPlainSpec(node)) return nestTreeSpec(node);
  if (isNode(node) && node.kind === 'dir' && node.children) {
    return { ...node, children: nestTreeSpec(node.children) };
  }
  return node;
}

/** `._migration-<uuid>.json` 的可选覆盖项（缺省值取实测形态） */
export interface MigrationMarkerOptions {
  /** 文件名里的 uuid，缺省随机 */
  uuid?: string;
  /** 迁移时间，缺省 `DEFAULT_MODIFIED_AT` */
  migratedAt?: string;
  /**
   * 标记内的 `workspaceHash`。缺省按**旧**算法 `sha256(原始路径).slice(0,16)` 计算 ——
   * 注意它与新目录名 `wsHash16`（先归一化再哈希）不是一回事，不能用来定位新目录。
   */
  workspaceHash?: string;
  /** 标记版本，缺省 2 */
  markerVersion?: number;
  /** 额外字段，原样合并进 JSON */
  extra?: Record<string, unknown>;
}

/**
 * 在**旧**格式的工作区会话目录里生成迁移标记
 * `<dir>/._migration-<uuid>.json`，内容形如：
 *
 * ```json
 * { "migratedAt": "...", "v2SessionId": "...", "workspaceHash": "...",
 *   "v1WorkspaceDirectory": "d:\\Projects\\...", "markerVersion": 2 }
 * ```
 *
 * 它是「已迁移仅残留」判定的第二个依据（第一个是新目录里存在同 sessionId 目录）。
 *
 * @param dir                  旧目录 `<workspace-sessions>/<EncodedKey>`（不存在时递归创建）
 * @param v2SessionId          迁移后在 1.x 里的 sessionId（即新目录名）
 * @param v1WorkspaceDirectory 迁移时记录的工作区绝对路径（原始大小写与斜杠方向）
 * @param opts                 覆盖 uuid / migratedAt / workspaceHash / markerVersion / 额外字段
 * @returns 标记文件的完整路径
 */
export function mkMigrationMarker(
  dir: string,
  v2SessionId: string,
  v1WorkspaceDirectory: string,
  opts: MigrationMarkerOptions = {}
): string {
  fs.mkdirSync(dir, { recursive: true });
  const uuid = opts.uuid ?? crypto.randomUUID();
  const full = path.join(dir, `._migration-${uuid}.json`);
  const marker = {
    migratedAt: opts.migratedAt ?? DEFAULT_MODIFIED_AT,
    v2SessionId,
    workspaceHash: opts.workspaceHash ?? legacyWorkspaceHash16(v1WorkspaceDirectory),
    v1WorkspaceDirectory,
    markerVersion: opts.markerVersion ?? 2,
    ...(opts.extra ?? {}),
  };
  fs.writeFileSync(full, JSON.stringify(marker), 'utf8');
  return full;
}

/** 旧算法：`sha256(原始路径)` 十六进制前 16 位，**不做任何归一化** */
function legacyWorkspaceHash16(p: string): string {
  return crypto.createHash('sha256').update(p, 'utf8').digest('hex').slice(0, 16);
}
