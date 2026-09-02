import * as path from 'path';
import { hash32 } from '../credits';
import type { StorageCategory } from './types';

/**
 * 路径分类器：把被统计根下的**每个文件**映射到**唯一**一个 StorageCategory。
 *
 * 两套布局各有一个入口、各有一组根，互不干扰：
 * - 0.9x：{@link buildClassifyRoots}（UserDataDir 派生）+ {@link classifyPath}
 * - 1.x：{@link buildNewClassifyRoots}（HomeKiroDir 派生）+ {@link classifyNewPath}
 *
 * 两者共用 {@link isUnder} 的归属语义，故「同一个文件在统计侧与删除侧被判成同一类」
 * 这一点在两套布局下都成立。
 *
 * 本模块是纯函数（只做字符串与路径计算），**不做任何文件系统调用**，
 * 因此既被统计侧（scanner / analyzer）使用，也被删除侧（cleaner 的 assertDeletable）
 * 复用 `isUnder`——删除侧与统计侧对「这个文件是不是执行存档」必须给出同一答案，
 * 否则会出现「统计说是存档、删除说不在白名单」的裂缝。
 *
 * 因为每个文件恰好落入一个分类，「各分类字节数之和 = 总字节数」与
 * 「各分类路径集合两两不相交」是构造性成立的，而非事后校验的结果。
 */

export type { StorageCategory };

/** Kiro 执行存档桶目录名的哈希输入串（逆向自 Kiro 扩展）。 */
export const SAVES_BUCKET_KEY = 'KIRO::EXECUTION::SAVES';
/** Kiro 执行索引桶目录名的哈希输入串。 */
export const METADATA_BUCKET_KEY = 'KIRO::EXECUTION::METADATA';

/** WorkspaceId 目录名形态：sha256 十六进制前 32 位，**小写**。 */
const HEX32 = /^[0-9a-f]{32}$/;

export interface ClassifyRoots {
  /** 统计根范围，由 PathResolver 提供，不在此处硬编码平台绝对路径 */
  userDataDir: string;
  /** <UserDataDir>/User/globalStorage/kiro.kiroagent */
  storeRoot: string;
  /** <storeRoot>/workspace-sessions */
  sessionsRoot: string;
  /** hash32('KIRO::EXECUTION::SAVES')，仅目录名而非完整路径 */
  savesBucket: string;
  /** hash32('KIRO::EXECUTION::METADATA')，仅目录名而非完整路径 */
  metadataBucket: string;
  /** <UserDataDir>/logs */
  logsDir: string;
  /** <UserDataDir>/User/workspaceStorage */
  workspaceStorageDir: string;
}

/**
 * 由 UserDataDir 派生全部统计根。
 *
 * 刻意**不**对 `userDataDir` 做 `path.resolve`：调用方给的可能是其它平台形态的
 * 路径（测试注入 platform/env 组合时常见），resolve 会按当前进程 cwd 补前缀，
 * 反而破坏「每个根都以 UserDataDir 为前缀」这一不变式。
 */
export function buildClassifyRoots(userDataDir: string): ClassifyRoots {
  const storeRoot = path.join(userDataDir, 'User', 'globalStorage', 'kiro.kiroagent');
  return {
    userDataDir,
    storeRoot,
    sessionsRoot: path.join(storeRoot, 'workspace-sessions'),
    savesBucket: hash32(SAVES_BUCKET_KEY),
    metadataBucket: hash32(METADATA_BUCKET_KEY),
    logsDir: path.join(userDataDir, 'logs'),
    workspaceStorageDir: path.join(userDataDir, 'User', 'workspaceStorage'),
  };
}

/**
 * 路径段边界归属判断：`child` 是否位于 `parent` 之内（含 `child === parent`）。
 *
 * 判据为 `path.relative(parent, child)` 的结果既不以 `..` 路径段开头、也不是绝对路径。
 * 这里按**路径段**比较 `..` 而不是裸 `startsWith('..')`——否则名为 `..bar` 的
 * 合法子目录会被误判为越界。同理，裸字符串前缀比较会把 `logs-old` 误判为 `logs`
 * 的子目录，因此全程只走这一个函数。
 */
export function isUnder(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  const first = splitSegments(rel)[0];
  return first !== '..';
}

/** 按两种分隔符切分相对路径（跨平台混用时也能正确取段）。 */
function splitSegments(rel: string): string[] {
  return rel.split(/[\\/]+/).filter((s) => s.length > 0);
}

/**
 * 把一个绝对路径归入唯一分类。规则**按序**匹配，先命中者胜：
 *
 * | 序 | 条件 | 分类 |
 * | --- | --- | --- |
 * | 1 | `<SessionsRoot>` 下 | `sessionJson` |
 * | 2 | `<StoreRoot>/<hex32>/<hash32(SAVES)>` 下 | `executionSaves` |
 * | 3 | `<StoreRoot>/<hex32>/<hash32(METADATA)>` 下 | `executionMetadata` |
 * | 4 | `<StoreRoot>/<hex32>` 下的其余内容（含直接子文件） | `unclassified` |
 * | 5 | `<UserDataDir>/logs` 下 | `logs` |
 * | 6 | `<UserDataDir>/User/workspaceStorage` 下 | `workspaceStorage` |
 * | 7 | 其余 | `otherFiles` |
 *
 * 桶名按小写十六进制**区分大小写**精确匹配：大写变体不是 Kiro 生成的桶目录，
 * 落入规则 4 的 `unclassified`。
 */
export function classifyPath(roots: ClassifyRoots, fullPath: string): StorageCategory {
  // 规则 1：对话 JSON
  if (isUnder(roots.sessionsRoot, fullPath)) return 'sessionJson';

  // 规则 2~4：<StoreRoot>/<WorkspaceId> 下的三分
  if (isUnder(roots.storeRoot, fullPath)) {
    const segs = splitSegments(path.relative(roots.storeRoot, fullPath));
    if (segs.length >= 2 && HEX32.test(segs[0])) {
      if (segs[1] === roots.savesBucket) return 'executionSaves';
      if (segs[1] === roots.metadataBucket) return 'executionMetadata';
      return 'unclassified';
    }
    // <StoreRoot>/<hex32> 的直接子文件也算该工作区目录下的其余内容
    if (segs.length === 1 && HEX32.test(segs[0])) return 'unclassified';
  }

  // 规则 5：运行日志
  if (isUnder(roots.logsDir, fullPath)) return 'logs';

  // 规则 6：工作区存储
  if (isUnder(roots.workspaceStorageDir, fullPath)) return 'workspaceStorage';

  // 规则 7：其余
  return 'otherFiles';
}

/* ------------------------------------------------------------------ *
 * 1.x 新布局（`~/.kiro`）
 * ------------------------------------------------------------------ */

/** 会话目录内快照子目录名（区分大小写精确匹配，见 {@link classifyNewPath}）。 */
const SNAPSHOTS_DIR = 'snapshots';
/** 会话目录内子执行子目录名（区分大小写精确匹配）。 */
const SUB_EXECUTIONS_DIR = 'sub-executions';

/**
 * `<newSessionsRoot>` 到会话目录的段数：`<WsHash16>/<sessionId>` 两段。
 * 因此 `snapshots` / `sub-executions` 只在**相对 sessions 根的第 3 段**（下标 2）
 * 这一位置才被识别。
 */
const SESSION_DIR_DEPTH = 2;

export interface NewClassifyRoots {
  /** 1.x 新存储根 `~/.kiro`，由 LayoutDetector 经 `os.homedir()` 解析后传入 */
  homeKiroDir: string;
  /** `<homeKiroDir>/sessions`，全部工作区会话目录的公共根 */
  newSessionsRoot: string;
  /** `<homeKiroDir>/session-index`，`<WsHash16>.jsonl` 追加式索引与 `.migration-v3` 标记 */
  newSessionIndexRoot: string;
}

/**
 * 由 HomeKiroDir 派生 1.x 的统计根，与 {@link buildClassifyRoots} 由 UserDataDir
 * 派生旧布局各根一一对应。
 *
 * 同样刻意**不**对 `homeKiroDir` 做 `path.resolve`：调用方注入的可能是其它平台
 * 形态的路径或临时夹具路径，resolve 会按当前进程 cwd 补前缀，反而破坏
 * 「每个根都以 HomeKiroDir 为前缀」这一不变式。
 */
export function buildNewClassifyRoots(homeKiroDir: string): NewClassifyRoots {
  return {
    homeKiroDir,
    newSessionsRoot: path.join(homeKiroDir, 'sessions'),
    newSessionIndexRoot: path.join(homeKiroDir, 'session-index'),
  };
}

/**
 * 把一个绝对路径归入唯一分类（1.x 新布局）。规则**按序**匹配，先命中者胜：
 *
 * | 序 | 条件 | 分类 |
 * | --- | --- | --- |
 * | 1 | `<newSessionIndexRoot>` 下 | `newSessionIndex` |
 * | 2 | 某 `<sessionDir>/snapshots` 下 | `newSnapshots` |
 * | 3 | 某 `<sessionDir>/sub-executions` 下 | `newSubExecutions` |
 * | 4 | `<newSessionsRoot>` 下的其余内容（`session.json`、`messages.jsonl`、`publish*.cursor` 等） | `newSession` |
 * | 5 | 其余 | `otherFiles` |
 *
 * **规则 2/3 的层级判据**：实测布局为
 * `<newSessionsRoot>/<WsHash16>/<sessionId>/snapshots/<hash>/<工作区相对路径>`，
 * 故只把**相对 sessions 根的第 3 段**（`segs[2]`，即会话目录的直接子级）与
 * `snapshots` / `sub-executions` 做区分大小写的**整段**相等比较。两点都是刻意的：
 * - 按**路径段**而非 `includes('snapshots')` 比较，故 `my-snapshots-backup`、
 *   `snapshots-old` 这类同前缀兄弟目录，以及 id 里含该词的会话，都不会被误判；
 * - 只认**这一层**，故 `snapshots/<hash>/.../snapshots/` 这种快照内容里恰好同名的
 *   深层目录仍随 `segs[2]` 归入 `newSnapshots`（它确实是快照内容），而
 *   `<sessionId>/foo/snapshots/` 则归入 `newSession`（它不是该会话的快照目录）。
 *
 * `<WsHash16>` 与 `<sessionId>` 两段**按位置**认定、不做形态校验：新布局没有
 * 旧布局 `unclassified` 那样的旁路分类，rule 4 已兜住 sessions 根下的一切剩余内容，
 * 再加形态校验只会把同一批文件在两个分类之间挪动，不改变划分性质。
 *
 * **划分性质（Requirement 6.5）由构造保证**，不依赖事后校验：
 * 规则有序 ⇒ 先命中者胜，任一路径至多落入一类；规则 4 兜住 `<newSessionsRoot>`
 * 下被规则 2/3 漏掉的全部剩余文件，规则 5 兜住其余一切 ⇒ 任一路径至少落入一类。
 * 二者合起来即「各分类路径集合两两不相交且并集覆盖全部路径」，于是
 * 「各分类字节数之和 = 所统计根范围总字节数」随之成立（Property 6 的依据）。
 */
export function classifyNewPath(roots: NewClassifyRoots, fullPath: string): StorageCategory {
  // 规则 1：全局会话索引。放在最前，因为它与 sessions 根是兄弟目录、不会互相遮蔽，
  // 但排在前面可省掉后续判断。
  if (isUnder(roots.newSessionIndexRoot, fullPath)) return 'newSessionIndex';

  // 规则 2~4：sessions 根下按会话目录的直接子级三分
  if (isUnder(roots.newSessionsRoot, fullPath)) {
    const segs = splitSegments(path.relative(roots.newSessionsRoot, fullPath));
    if (segs.length > SESSION_DIR_DEPTH) {
      const marker = segs[SESSION_DIR_DEPTH];
      if (marker === SNAPSHOTS_DIR) return 'newSnapshots';
      if (marker === SUB_EXECUTIONS_DIR) return 'newSubExecutions';
    }
    // 规则 4：含会话本体文件、`publish*.cursor`，以及 sessions 根 / 工作区目录 /
    // 会话目录自身这三级目录条目
    return 'newSession';
  }

  // 规则 5：其余（含 `~/.kiro` 下不在本特性统计范围内的 `tasks/` 等子目录）
  return 'otherFiles';
}

/** 各分类的中文标签与磁盘路径模板（供 tooltip、SummaryBar 与报告展示）。 */
export const CATEGORY_META: Record<
  StorageCategory,
  { label: string; pathHint: string; note?: string }
> = {
  sessionJson: {
    label: '对话 JSON',
    pathHint: path.join('<StoreRoot>', 'workspace-sessions'),
  },
  executionSaves: {
    label: '执行存档',
    pathHint: path.join('<StoreRoot>', '<WorkspaceId>', '<hash32(KIRO::EXECUTION::SAVES)>'),
  },
  executionMetadata: {
    label: '执行索引',
    pathHint: path.join('<StoreRoot>', '<WorkspaceId>', '<hash32(KIRO::EXECUTION::METADATA)>'),
  },
  unclassified: {
    label: '其他/未分类',
    pathHint: path.join('<StoreRoot>', '<WorkspaceId>', '<其余目录与直接子文件>'),
    note: '实测包含源码文件快照',
  },
  logs: {
    label: '运行日志',
    pathHint: path.join('<UserDataDir>', 'logs'),
  },
  workspaceStorage: {
    label: '工作区存储',
    pathHint: path.join('<UserDataDir>', 'User', 'workspaceStorage'),
  },
  otherFiles: {
    label: '其他文件',
    pathHint: path.join('<UserDataDir>', '<其余位置>'),
  },
  // 以下 4 项为 1.x 新布局。路径写成具体的 `~/.kiro/...` 而非 `<Root>` 占位符：
  // 新布局的根跨平台恒为 `<home>/.kiro`，写具体路径对用户更可操作；旧布局那几项
  // 只能用占位符，是因为 UserDataDir 各平台不同。
  newSession: {
    label: '新格式会话',
    pathHint: path.join('~', '.kiro', 'sessions', '<工作区哈希>', '<会话 id>'),
    note: '含 session.json 与 messages.jsonl',
  },
  newSnapshots: {
    label: '新格式快照',
    pathHint: path.join('~', '.kiro', 'sessions', '<工作区哈希>', '<会话 id>', 'snapshots'),
    note: '1.x 的文件快照，是 0.9x「执行存档」的对应物',
  },
  newSubExecutions: {
    label: '新格式子执行',
    pathHint: path.join('~', '.kiro', 'sessions', '<工作区哈希>', '<会话 id>', 'sub-executions'),
  },
  newSessionIndex: {
    label: '新格式索引',
    pathHint: path.join('~', '.kiro', 'session-index', '<工作区哈希>.jsonl'),
    note: '追加式 op 日志，不归属任何单个工作区',
  },
};

/**
 * 分类的固定展示顺序（报告与 tooltip 共用，按吃盘量级从大到小的经验排序）。
 *
 * 旧布局 7 项在前、1.x 新布局 4 项在后：报告与 tooltip 按本数组逐项渲染，
 * 漏掉某项就等于该分类的区块从界面上消失，故新增分类必须同时追加到这里。
 */
const CATEGORY_ORDER_ENTRIES = [
  'executionSaves',
  'unclassified',
  'executionMetadata',
  'sessionJson',
  'workspaceStorage',
  'logs',
  'otherFiles',
  'newSnapshots',
  'newSubExecutions',
  'newSession',
  'newSessionIndex',
] as const;

/** 约束为 `never`：实参不是 `never` 时在此处报编译错误。 */
type AssertNever<T extends never> = T;

/**
 * 穷尽性守卫：`StorageCategory` 新增取值而漏改 {@link CATEGORY_ORDER} 时，
 * 这一行会因 `Exclude<...>` 不是 `never` 而编译报错，把人拽到本文件来。
 *
 * 没有它，漏改的后果是**静默**的：`CATEGORY_META` 是 `Record<StorageCategory, …>`
 * 会先报错，但报告与 tooltip 是逐项遍历本数组渲染的，少一项只表现为界面上少一个
 * 区块。守卫写成纯类型层（不产生运行时代码），故 {@link CATEGORY_ORDER} 的导出类型
 * 仍是 `readonly StorageCategory[]` 而非 tuple——既有调用方（report / analyzer 与
 * 测试里的 `[...CATEGORY_ORDER]`、`fc.subarray`）的类型契约不变。
 */
type _CategoryOrderCoversAllCategories = AssertNever<
  Exclude<StorageCategory, (typeof CATEGORY_ORDER_ENTRIES)[number]>
>;

export const CATEGORY_ORDER: readonly StorageCategory[] = CATEGORY_ORDER_ENTRIES;
