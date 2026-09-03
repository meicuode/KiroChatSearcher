/**
 * TelemetryTap（诊断阶段）：探查能否从**同进程**的 OpenTelemetry 全局注册表里
 * 旁听 kiro-agent 上报的用量指标。
 *
 * ── 为什么盯这条路 ──────────────────────────────────────────────────────────
 *
 * Kiro 手里有真实的 token 数（`inputTokens` / `outputTokens` /
 * `cacheReadInputTokens` / `cacheWriteInputTokens`）与服务端自报延迟
 * （`response_metadata.metadata.metrics.latencyMs`），但它只把这些喂给遥测：
 *
 * ```js
 * A = { [RequestId]: k.$metadata.requestId, [ModelIdentifier]: … }
 * this.metrics.reportHistogramMetrics({ inputTokens, outputTokens,
 *                                       cacheReadInputTokens, cacheWriteInputTokens }, A)
 * ```
 *
 * 既不落盘也不下发给 UI。而 `A` 里带的 **RequestId** 正好能和会话文件里
 * `usage_summary.requestIds[]` 做 join —— 于是「本轮消耗多少 token」可以精确到一轮、
 * 并发多个会话也不会混。
 *
 * 拿到它有三条路，这里探的是第三条：
 *
 * | 路 | 代价 |
 * |---|---|
 * | `KIRO_CHAT_LOG_FILE` | 每轮把**完整上下文**写盘（实测单次请求 284KB） |
 * | `OTEL_EXPORTER_OTLP_ENDPOINT` 指向本地 | 要改 OS 环境变量 + 重启 Kiro，且遥测不再上报 |
 * | **旁听全局 MeterProvider** | 不设环境变量、不重启、遥测照常上报，只是抄一份 |
 *
 * ── 为什么同进程就能碰到它 ──────────────────────────────────────────────────
 *
 * OTel JS 的全局 API 存放在 `globalThis[Symbol.for('opentelemetry.js.api.<major>')]`
 * 上——这个设计的目的**就是**让多个各自打包的 OTel 副本互通。kiro-agent 的 OTel 是
 * 用 esbuild 打进它自己的 bundle 的（不是共享 `require`），所以 hook `require` 没用，
 * 但全局注册表这条缝是通的：它调 `setGlobalMeterProvider` 写进去，我们读得到。
 *
 * ── 本文件当前只做「看」，不做「改」 ────────────────────────────────────────
 *
 * 包装 provider 有一个已知的时序风险：`reportHistogramMetrics` 走 `resolve()` 懒解析
 * 并把 delegate **缓存**在实例上，早于我们包装完成的那批 delegate 握着的是真实 Meter，
 * 抄不到。所以先出一份事实报告（注册表在不在、provider 是什么、instrument 怎么建），
 * 再决定要不要包、以及要不要为了抢在前面调整激活时机。
 *
 * 全程只读：不写 `globalThis`、不替换任何对象、不产生任何副作用。
 */

/** 一次探查的结果。字段刻意都是可序列化的,直接打进输出面板。 */
export interface OtelProbeResult {
  /** 命中的注册表 symbol 描述（如 `opentelemetry.js.api.1`）；一个都没命中时为空数组。 */
  registrySymbols: string[];
  /** 注册表对象上的键（通常是 `metrics` / `trace` / `diag` / `context` / `propagation` / `version`）。 */
  registryKeys: string[];
  /** 注册表里记录的 API 版本。 */
  apiVersion: string | null;
  /** 全局 MeterProvider 是否已注册。 */
  hasMeterProvider: boolean;
  /** MeterProvider 的构造函数名（`NoopMeterProvider` 说明遥测没真正启用）。 */
  meterProviderName: string | null;
  /** MeterProvider 上可枚举到的方法名。 */
  meterProviderMethods: string[];
  /** `getMeter()` 能否调通，以及返回对象的构造函数名。 */
  meterName: string | null;
  /** Meter 上可枚举到的方法名（关心 `createHistogram` / `createCounter` 在不在）。 */
  meterMethods: string[];
  /** 全局 TracerProvider 的构造函数名（span 属性是另一条可能的取数路径）。 */
  tracerProviderName: string | null;
  /** 探查过程中的异常信息（每条都不致命，收集起来一起看）。 */
  notes: string[];
}

/**
 * OTel 全局注册表可能用到的 symbol。
 *
 * 版本号取自 API 包的**大版本**（代码里 `S2.split(".")[0]`），当前主流是 `1`；
 * 多探几个是为了 Kiro 升级 OTel 大版本后这份诊断仍能给出有用信息，而不是直接空手。
 */
const CANDIDATE_MAJORS = ['1', '2', '3'] as const;

/**
 * 只读探查同进程里的 OTel 全局注册表。
 *
 * **不抛异常**：任何一步失败都记进 `notes` 并继续，因为这个函数的唯一价值就是
 * 「在陌生环境里报告事实」，半路抛掉等于什么都没说。
 */
export function probeOtelGlobals(globalObject: Record<PropertyKey, unknown> = globalThis as never): OtelProbeResult {
  const out: OtelProbeResult = {
    registrySymbols: [],
    registryKeys: [],
    apiVersion: null,
    hasMeterProvider: false,
    meterProviderName: null,
    meterProviderMethods: [],
    meterName: null,
    meterMethods: [],
    tracerProviderName: null,
    notes: [],
  };

  let registry: Record<string, unknown> | undefined;
  for (const major of CANDIDATE_MAJORS) {
    const key = Symbol.for(`opentelemetry.js.api.${major}`);
    const value = globalObject[key];
    if (value && typeof value === 'object') {
      out.registrySymbols.push(`opentelemetry.js.api.${major}`);
      registry ??= value as Record<string, unknown>;
    }
  }

  if (!registry) {
    out.notes.push(
      '未找到 OTel 全局注册表。可能是：kiro-agent 尚未初始化遥测、它用了私有 provider ' +
        '而不注册全局、或 OTel 大版本超出探测范围。'
    );
    return out;
  }

  try {
    out.registryKeys = Object.keys(registry).sort();
    const version = (registry as { version?: unknown }).version;
    out.apiVersion = typeof version === 'string' ? version : null;
  } catch (e) {
    out.notes.push('读取注册表键失败：' + messageOf(e));
  }

  // --- MeterProvider ---
  const meterProvider = registry['metrics'];
  out.hasMeterProvider = !!meterProvider && typeof meterProvider === 'object';
  if (out.hasMeterProvider) {
    const mp = meterProvider as Record<string, unknown>;
    out.meterProviderName = constructorNameOf(mp);
    out.meterProviderMethods = methodNamesOf(mp);
    // `getMeter` 是只读调用（OTel 语义上就是拿一个句柄），不会产生上报
    const getMeter = mp['getMeter'];
    if (typeof getMeter === 'function') {
      try {
        const meter = (getMeter as (n: string, v?: string) => unknown).call(
          mp,
          'kiro-chat-search.probe'
        );
        if (meter && typeof meter === 'object') {
          const m = meter as Record<string, unknown>;
          out.meterName = constructorNameOf(m);
          out.meterMethods = methodNamesOf(m);
        }
      } catch (e) {
        out.notes.push('调用 getMeter() 失败：' + messageOf(e));
      }
    } else {
      out.notes.push('MeterProvider 上没有 getMeter 方法，形状与预期不符。');
    }
  } else {
    out.notes.push('注册表里没有 metrics（全局 MeterProvider 未注册）。');
  }

  // --- TracerProvider（备选取数路径：span 属性） ---
  const tracerProvider = registry['trace'];
  if (tracerProvider && typeof tracerProvider === 'object') {
    out.tracerProviderName = constructorNameOf(tracerProvider as Record<string, unknown>);
  }

  return out;
}

/**
 * 把探查结果渲染成可读文本（纯函数，供输出面板与单元测试共用）。
 *
 * 结论行放最前面：绝大多数时候读的人只想知道「这条路通不通」，
 * 细节是通不通之后才需要的。
 */
export function renderOtelProbe(r: OtelProbeResult): string[] {
  const lines: string[] = [];
  lines.push('=== Kiro 遥测旁听可行性探查（只读，未做任何修改）===');
  lines.push('');
  lines.push('结论：' + verdictOf(r));
  lines.push('');
  lines.push('全局注册表 symbol : ' + (r.registrySymbols.join(', ') || '（未找到）'));
  lines.push('注册表键          : ' + (r.registryKeys.join(', ') || '—'));
  lines.push('API 版本          : ' + (r.apiVersion ?? '—'));
  lines.push('MeterProvider     : ' + (r.meterProviderName ?? '（未注册）'));
  lines.push('  方法            : ' + (r.meterProviderMethods.join(', ') || '—'));
  lines.push('Meter             : ' + (r.meterName ?? '—'));
  lines.push('  方法            : ' + (r.meterMethods.join(', ') || '—'));
  lines.push('TracerProvider    : ' + (r.tracerProviderName ?? '—'));
  if (r.notes.length > 0) {
    lines.push('');
    lines.push('备注：');
    for (const n of r.notes) lines.push('  · ' + n);
  }
  return lines;
}

/**
 * 三态判断。
 *
 * `Noop*` 单独拎出来说：那不是「找不到」，而是「找到了但遥测没真正启用」——
 * 两者的下一步完全不同（前者要换取数路径，后者只要等遥测初始化）。
 */
function verdictOf(r: OtelProbeResult): string {
  if (r.registrySymbols.length === 0) return '不可行（同进程里没有 OTel 全局注册表）';
  if (!r.hasMeterProvider) return '暂不可行（注册表在，但全局 MeterProvider 还没注册）';
  if ((r.meterProviderName ?? '').toLowerCase().includes('noop')) {
    return '注册表与 provider 都在，但当前是 Noop（遥测未启用或已被关闭），此刻抄不到数据';
  }
  if (!r.meterMethods.includes('createHistogram')) {
    return '可达，但 Meter 上没有 createHistogram，形状与预期不符，需重新适配';
  }
  return '可行：能拿到真实 MeterProvider 且 Meter 具备 createHistogram，可以包一层旁听';
}

function constructorNameOf(o: Record<string, unknown>): string | null {
  try {
    const proto = Object.getPrototypeOf(o) as { constructor?: { name?: unknown } } | null;
    const name = proto?.constructor?.name;
    return typeof name === 'string' && name ? name : null;
  } catch {
    return null;
  }
}

/** 列出对象自身与其原型上的函数名（不含 `constructor`）。 */
function methodNamesOf(o: Record<string, unknown>): string[] {
  const names = new Set<string>();
  try {
    for (const k of Object.getOwnPropertyNames(o)) {
      if (typeof o[k] === 'function') names.add(k);
    }
    const proto = Object.getPrototypeOf(o) as Record<string, unknown> | null;
    if (proto) {
      for (const k of Object.getOwnPropertyNames(proto)) {
        if (k === 'constructor') continue;
        try {
          if (typeof proto[k] === 'function') names.add(k);
        } catch {
          /* getter 抛异常就跳过 */
        }
      }
    }
  } catch {
    /* 枚举失败就返回已收集到的部分 */
  }
  return [...names].sort();
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return typeof m === 'string' ? m : String(e);
}
