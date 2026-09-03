import { describe, it, expect } from 'vitest';
import { probeOtelGlobals, renderOtelProbe } from '../src/telemetryTap';

/**
 * 遥测旁听探查是「在陌生环境里报告事实」的工具，因此它的价值全在于
 * **各种畸形/缺失形状下都不抛异常、且结论正确**。这里用假的 globalThis 把几种
 * 现实可能出现的形状都走一遍。
 */

const SYM1 = Symbol.for('opentelemetry.js.api.1');

function fakeGlobal(registry: unknown): Record<PropertyKey, unknown> {
  const g: Record<PropertyKey, unknown> = {};
  if (registry !== undefined) g[SYM1] = registry;
  return g;
}

class FakeMeter {
  createHistogram() {
    return { record: () => {} };
  }
  createCounter() {
    return { add: () => {} };
  }
}
class FakeMeterProvider {
  getMeter() {
    return new FakeMeter();
  }
}
class NoopMeterProvider {
  getMeter() {
    return new FakeMeter();
  }
}

describe('probeOtelGlobals - 结论判定', () => {
  it('注册表不存在 → 不可行，且给出可能原因', () => {
    const r = probeOtelGlobals(fakeGlobal(undefined));
    expect(r.registrySymbols).toEqual([]);
    expect(r.hasMeterProvider).toBe(false);
    expect(r.notes.join()).toContain('未找到 OTel 全局注册表');
    expect(renderOtelProbe(r).join('\n')).toContain('不可行');
  });

  it('注册表在但没有 metrics → 暂不可行（等遥测初始化）', () => {
    const r = probeOtelGlobals(fakeGlobal({ version: '1.9.0', diag: {} }));
    expect(r.registrySymbols).toEqual(['opentelemetry.js.api.1']);
    expect(r.apiVersion).toBe('1.9.0');
    expect(r.hasMeterProvider).toBe(false);
    expect(renderOtelProbe(r).join('\n')).toContain('暂不可行');
  });

  it('provider 是 Noop → 明确区分「找不到」与「找到了但没启用」', () => {
    const r = probeOtelGlobals(fakeGlobal({ metrics: new NoopMeterProvider() }));
    expect(r.hasMeterProvider).toBe(true);
    expect(r.meterProviderName).toBe('NoopMeterProvider');
    expect(renderOtelProbe(r).join('\n')).toContain('Noop');
  });

  it('真实 provider 且 Meter 有 createHistogram → 可行', () => {
    const r = probeOtelGlobals(
      fakeGlobal({ version: '1.9.0', metrics: new FakeMeterProvider(), trace: {} })
    );
    expect(r.hasMeterProvider).toBe(true);
    expect(r.meterProviderName).toBe('FakeMeterProvider');
    expect(r.meterName).toBe('FakeMeter');
    expect(r.meterMethods).toContain('createHistogram');
    expect(r.meterMethods).toContain('createCounter');
    expect(renderOtelProbe(r).join('\n')).toContain('可行');
  });

  it('Meter 缺 createHistogram → 报「形状不符」而不是笼统失败', () => {
    const provider = { getMeter: () => ({ somethingElse: () => {} }) };
    const r = probeOtelGlobals(fakeGlobal({ metrics: provider }));
    expect(r.meterMethods).not.toContain('createHistogram');
    expect(renderOtelProbe(r).join('\n')).toContain('形状与预期不符');
  });

  it('getMeter 抛异常 → 记进 notes 且不向上抛', () => {
    const provider = {
      getMeter: () => {
        throw new Error('boom');
      },
    };
    expect(() => probeOtelGlobals(fakeGlobal({ metrics: provider }))).not.toThrow();
    const r = probeOtelGlobals(fakeGlobal({ metrics: provider }));
    expect(r.notes.join()).toContain('boom');
    expect(r.meterName).toBeNull();
  });

  it('MeterProvider 上没有 getMeter → 记进 notes', () => {
    const r = probeOtelGlobals(fakeGlobal({ metrics: { foo: 1 } }));
    expect(r.notes.join()).toContain('没有 getMeter');
  });

  it('原型上的 getter 抛异常时枚举不崩', () => {
    const proto = {};
    Object.defineProperty(proto, 'evil', {
      get() {
        throw new Error('getter boom');
      },
      enumerable: false,
      configurable: true,
    });
    const provider = Object.create(proto) as { getMeter?: unknown };
    provider.getMeter = () => new FakeMeter();
    expect(() => probeOtelGlobals(fakeGlobal({ metrics: provider }))).not.toThrow();
  });

  it('探查是只读的：不往 globalThis 写任何东西', () => {
    const g = fakeGlobal({ metrics: new FakeMeterProvider() });
    const before = Reflect.ownKeys(g).length;
    probeOtelGlobals(g);
    expect(Reflect.ownKeys(g).length).toBe(before);
  });
});

describe('renderOtelProbe - 输出形状', () => {
  it('结论行紧跟标题，细节在后', () => {
    const lines = renderOtelProbe(
      probeOtelGlobals(fakeGlobal({ version: '1.9.0', metrics: new FakeMeterProvider() }))
    );
    expect(lines[0]).toContain('可行性探查');
    expect(lines.find((l) => l.startsWith('结论：'))).toBeTruthy();
    expect(lines.join('\n')).toContain('MeterProvider');
  });

  it('没有备注时不输出空的「备注」小节', () => {
    const lines = renderOtelProbe(
      probeOtelGlobals(fakeGlobal({ metrics: new FakeMeterProvider() }))
    );
    expect(lines.join('\n')).not.toContain('备注');
  });
});
