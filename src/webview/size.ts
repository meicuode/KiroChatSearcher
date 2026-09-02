/**
 * SizeFormatter：字节数与可读文本之间的纯函数互转。
 *
 * 与 webview/format.ts、webview/filter.ts 一样，这些函数的源码会被 toString()
 * 注入到 webview 的内联脚本中，同时被扩展宿主侧的 storage/report.ts 与
 * storage/ranking.ts 复用，因此：
 *   - 不依赖 DOM 与 vscode API；
 *   - 函数体内不引用任何模块级符号（含常量与类型），保证序列化后可独立运行。
 */

/**
 * 1024 进制格式化，单位序列 `B`/`KB`/`MB`/`GB`/`TB`：
 *   - `< 1024`        → 整数 + `B`
 *   - `[1KB, 1GB)`    → 1 位小数 + `KB`/`MB`
 *   - `>= 1GB`        → 2 位小数 + `GB`/`TB`
 * 负数、`NaN` 与非有限数返回占位文本 `-`。
 *
 * 单位切换边界上取「低单位进位」而非提前换单位（例：1024³-1 → `1024.0MB`），
 * 使 parseSize(formatSize(n)) 在边界处相等而非回退，从而保持单调性。
 */
export function formatSize(bytes: number): string {
  if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '-';
  const k = 1024;
  if (bytes < k) return String(Math.round(bytes)) + 'B';
  if (bytes < k * k) return (bytes / k).toFixed(1) + 'KB';
  if (bytes < k * k * k) return (bytes / (k * k)).toFixed(1) + 'MB';
  if (bytes < k * k * k * k) return (bytes / (k * k * k)).toFixed(2) + 'GB';
  return (bytes / (k * k * k * k)).toFixed(2) + 'TB';
}

/**
 * formatSize 的逆向解析：`'12.3MB'` → 12.3 × 1024²。
 * 单位大小写不敏感，允许首尾空白与数值和单位之间的空白。
 * 占位文本 `-` 与任何不可识别文本返回 `NaN`。
 */
export function parseSize(text: string): number {
  if (typeof text !== 'string') return NaN;
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|TB)\s*$/i.exec(text);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return NaN;
  const k = 1024;
  const unit = m[2].toUpperCase();
  const factor =
    unit === 'B'
      ? 1
      : unit === 'KB'
        ? k
        : unit === 'MB'
          ? k * k
          : unit === 'GB'
            ? k * k * k
            : k * k * k * k;
  return n * factor;
}
/**
 * 结果角标（SizeBadge）的展示文本与 tooltip。
 *
 * `scope` 与既有 `Σ` 开关共用状态：`self` 取自身口径（可相加），`lineage`
 * 取累计口径（含 checkpoint 继承，不可跨会话相加）。
 *
 * 返回：
 *   - `value`：角标文本，恒等于 `formatSize(jsonBytes + archiveBytes)`；
 *   - `title`：分行拆解 JSON 与归因存档字节数，两行之和的格式化结果恒等于 `value`；
 *   - `warn`：总占用 ≥ 100MB 时为 `true`，渲染层据此加警示配色类；
 *   - `null`：会话 JSON 字节数不可取得（数值无法取得），渲染层省略该条角标。
 *
 * `archivesFound === false`（或对应口径的存档字节数缺失）时只展示 `jsonBytes`，
 * 存档部分按 0 计入并在 tooltip 说明存档不可用。
 *
 * 仅引用同一批被注入 webview 的 `formatSize`（与 format.ts 中 `highlight`
 * 引用 `escapeHtml` 同例），不依赖 DOM 与 vscode。
 */
export function sizeBadgeLabel(opts: {
  scope?: 'self' | 'lineage';
  jsonBytes?: number;
  archiveBytesSelf?: number;
  archiveBytesLineage?: number;
  archivesFound?: boolean;
  /**
   * 该会话数据所在格式（`SearchHit.layout`）。`'new'` 时 tooltip 追加一句说明
   * 「两种口径取同一值」及其原因（Requirement 4.4、设计决策 D4）。
   *
   * 不说明的话，1.x 用户切 `Σ` 会看到数字一动不动，只能理解成开关坏了。
   * 真正的原因是 1.x 的快照按会话目录物理隔离、不存在跨会话继承，累计口径无从产生差异。
   */
  layout?: 'old' | 'new';
}): { value: string; title: string; warn: boolean } | null {
  const has = (n: unknown): n is number => typeof n === 'number' && isFinite(n) && n >= 0;
  if (!has(opts.jsonBytes)) return null;

  const scope = opts.scope === 'lineage' ? 'lineage' : 'self';
  const scoped = scope === 'lineage' ? opts.archiveBytesLineage : opts.archiveBytesSelf;
  const archivesUnavailable = opts.archivesFound === false || !has(scoped);
  const archiveBytes = archivesUnavailable ? 0 : (scoped as number);
  const jsonBytes = opts.jsonBytes;
  const total = jsonBytes + archiveBytes;

  const isNew = opts.layout === 'new';
  const lines = isNew
    ? [
        // 1.x 的两列口径不同：会话本体（session.json + messages.jsonl）与快照/子执行
        '会话本体 ' + formatSize(jsonBytes),
        '快照与子执行 ' + formatSize(archiveBytes),
      ]
    : [
        '会话 JSON ' + formatSize(jsonBytes),
        '归因存档' +
          (scope === 'lineage' ? '（累计口径，含 checkpoint 继承）' : '（自身口径）') +
          ' ' +
          formatSize(archiveBytes),
      ];
  if (archivesUnavailable) {
    lines.push(
      isNew
        ? '快照数据不可用，仅展示会话本体占用'
        : '存档数据不可用或已被 LRU 索引淘汰，仅展示会话 JSON 占用'
    );
  }
  if (isNew) {
    // Req 4.4：必须说明「切 Σ 数值不变」不是开关失效
    lines.push('1.x 会话：自身口径与累计口径取同一值');
    lines.push('原因：快照按会话目录物理隔离，不存在跨会话继承，故累计口径无从产生差异');
  } else if (scope === 'lineage') {
    lines.push('累计口径含继承部分，不可跨会话相加');
  }

  return { value: formatSize(total), title: lines.join('\n'), warn: total >= 100 * 1024 * 1024 };
}

/**
 * 结果项的**来源角标**（Requirement 9.7）：把 SessionOrigin 渲染成一个短标签 + tooltip。
 *
 * 与排行页的 MigrationStatus 是同一件事的两个展示位，但**刻意各自实现**：排行页那份
 * （`ranking.ts` 的 `migrationStatusCell`）走的是表格单元格、文案更长、还要带磁盘根路径；
 * 搜索结果这份要挤在标题行的角标区里，只能给三四个字。把两者强行合并只会得到一个
 * 带一堆开关的函数，而它们的取值语义本来就由 `types.ts` 的 `SessionOrigin` 统一约束。
 *
 * `origin` 取 `unknown`：值来自宿主下发的 JSON。取值超出三者时返回 `null`，渲染层省略该
 * 角标 —— 与「credit 不可用时省略用量角标」同一处理方式，不显示一个含义不明的标记。
 *
 * 只做纯字符串计算，不引用任何模块作用域绑定（本函数被 `toString()` 注入 webview）。
 */
export function originBadgeLabel(
  origin: unknown
): { value: string; title: string; warn: boolean } | null {
  if (origin === 'new') {
    return {
      value: '1.x',
      title: 'Kiro 1.x 中新建的会话（数据位于 ~/.kiro/sessions）',
      warn: false,
    };
  }
  if (origin === 'migrated') {
    return {
      value: '已迁移',
      title:
        '由 0.9x 迁移而来，现以 ~/.kiro/sessions 下的新格式目录为准；\n' +
        '旧目录若仍有残留，不计入本条占用，可在占用排行页的「旧格式残留」维度查看与清理',
      warn: false,
    };
  }
  if (origin === 'legacy-unmigrated') {
    return {
      value: '未迁移',
      title:
        '仅存在于 0.9x 旧目录、尚未迁移到 1.x 的会话。\n' +
        '该会话在 Kiro 1.x 界面中不可见，点击可能无法打开；\n' +
        '如需继续对话请先在 Kiro 内手动迁移，删除后不可恢复',
      // 唯一带破坏性后果的取值：让它在角标里就带上警示配色
      warn: true,
    };
  }
  return null;
}

/**
 * 汇总条（SummaryBar）的文本与 tooltip，四态输出：
 *   - `idle`（缺省）    → 「点击 ⛁ 统计占用」
 *   - `loading`        → 「统计中…」
 *   - `unavailable`    → 「占用统计不可用」
 *   - `ok`             → 项目 / 结果 / 孤儿三项数值
 *
 * 前三态恒不输出任何占用数值（文本与 tooltip 均不含数字）。`ok` 态下：
 *   - 文本恒同时含 ProjectFootprintTotal、ResultSetFootprintTotal 与孤儿存档三项格式化数值；
 *   - tooltip 恒给出会话 JSON 与归因存档字节数的拆解、参与统计的会话数与结果条数；
 *   - `categories` 存在时在同一 tooltip 追加各分类的标签、格式化字节数与磁盘路径；
 *   - `partial` 为 true 时数值前加 `≥` 前缀（该前缀只在 partial 时出现）并在 tooltip 给出被跳过条目数。
 *
 * `jsonBytes` / `archiveBytes` 为 ProjectFootprintTotal 的拆解，缺省时回退到
 * `categories` 中对应分类（`key` 为 `sessionJson` / `executionSaves`），再缺省按 0 展示。
 * 未识别的 `state` 返回 `null`。
 */
export function summaryLabel(opts: {
  state?: 'idle' | 'loading' | 'ok' | 'unavailable';
  totalBytes?: number;       // ProjectFootprintTotal
  resultSetBytes?: number;   // ResultSetFootprintTotal
  orphanBytes?: number;
  orphanState?: 'ok' | 'pending' | 'unknown';
  sessionCount?: number;
  resultCount?: number;
  jsonBytes?: number;
  archiveBytes?: number;
  categories?: Array<{ key?: string; label: string; bytes: number; pathHint: string }>;
  partial?: boolean;
  skippedCount?: number;
}): { text: string; title: string } | null {
  const state = opts.state === undefined ? 'idle' : opts.state;
  if (state === 'idle') {
    return {
      text: '点击 ⛁ 统计占用',
      title: '左键点击 ⛁ 占用 统计当前项目占用 · 右键打开占用排行',
    };
  }
  if (state === 'loading') {
    return {
      text: '统计中…',
      title: '正在统计当前项目的存储占用，可继续输入关键词与浏览结果',
    };
  }
  if (state === 'unavailable') {
    return {
      text: '占用统计不可用',
      title: '无法定位 Kiro 用户数据目录，或统计过程整体失败；搜索与用量展示不受影响',
    };
  }
  if (state !== 'ok') return null;

  const has = (n: unknown): n is number => typeof n === 'number' && isFinite(n) && n >= 0;
  const num = (n: unknown) => (typeof n === 'number' && isFinite(n) && n >= 0 ? n : 0);
  const cats = Array.isArray(opts.categories) ? opts.categories : [];
  const pickCat = (key: string) => {
    for (let i = 0; i < cats.length; i++) {
      const c = cats[i];
      if (c && c.key === key && has(c.bytes)) return c.bytes;
    }
    return undefined;
  };
  const partial = opts.partial === true;
  const pfx = partial ? '≥' : '';
  const size = (n: unknown) => pfx + formatSize(num(n));

  const jsonBytes = has(opts.jsonBytes) ? opts.jsonBytes : pickCat('sessionJson');
  const archiveBytes = has(opts.archiveBytes) ? opts.archiveBytes : pickCat('executionSaves');

  const orphanState =
    opts.orphanState === 'pending' || opts.orphanState === 'unknown' ? opts.orphanState : 'ok';
  const orphanSuffix =
    orphanState === 'pending' ? '（待判定）' : orphanState === 'unknown' ? '（未确定）' : '';

  const text =
    '项目 ' + size(opts.totalBytes) +
    ' · 结果 ' + size(opts.resultSetBytes) +
    ' · 孤儿 ' + size(opts.orphanBytes) + orphanSuffix;

  const lines = [
    '当前项目全部会话占用 ' + size(opts.totalBytes),
    '　拆解：会话 JSON ' + size(jsonBytes) + ' + 归因存档 ' + size(archiveBytes),
    '当前结果列表展示会话占用合计 ' + size(opts.resultSetBytes),
    '孤儿存档占用 ' + size(opts.orphanBytes) + orphanSuffix,
    '参与统计的会话数 ' + num(opts.sessionCount) + ' · 结果条数 ' + num(opts.resultCount),
  ];
  if (orphanState === 'pending') {
    lines.push('会话清单尚未完整读取，孤儿判定暂缓，该数值可能偏低');
  } else if (orphanState === 'unknown') {
    lines.push('未能取得任何现存会话 ID，不把全部存档判为孤儿');
  }
  if (partial) {
    lines.push('统计不完整，已跳过 ' + num(opts.skippedCount) + ' 个条目，数值为下限');
  }
  if (cats.length > 0) {
    lines.push('分类明细：');
    for (let i = 0; i < cats.length; i++) {
      const c = cats[i];
      if (!c) continue;
      lines.push('　' + c.label + ' ' + size(c.bytes) + ' — ' + c.pathHint);
    }
  }

  return { text, title: lines.join('\n') };
}
