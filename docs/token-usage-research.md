# 取真实 token 数与缓存命中率：方案研究记录

> 目的：把「在对话结束的 `Est. Credits Used / Elapsed time` 后面追加显示本轮输入/输出
> token、缓存命中率」这件事的全部已知方案、依据与代价记下来，供后续继续开发时直接参考，
> 不必重新逆向一遍。
>
> 研究对象：Kiro 1.0.337（`resources/app/extensions/kiro.kiro-agent`）。
> 所有结论都标注了取证方式，凡未实测的一律写明「未验证」。

## 1. 结论速览

| 方案 | 可行性 | 精确到一轮 | 主要代价 |
| --- | --- | --- | --- |
| A. 读会话文件 `messages.jsonl` | ❌ | — | 数据根本不在里面 |
| B. 读 webview 的流式事件 | ❌ | — | `_meta.kiro` 只带 credit，不带 token |
| C. `KIRO_CHAT_LOG_FILE` | ✅ | ✅ | 每轮把**完整上下文**写盘（实测单请求 284KB） |
| D. `KIRO_DUMP_REQUESTS` | ✅ | ✅ | 同样带完整请求体；响应头白名单只有 `x-amzn-requestid` |
| E. 旁听 OTel 全局 MeterProvider | ❌ | — | Kiro 走私有 provider，**从不注册全局**（已实测） |
| F. `OTEL_EXPORTER_OTLP_ENDPOINT` 指向本地 | ✅ | ✅ | 改 OS 环境变量 + **整个 Kiro 重启** + 遥测不再上报 AWS |
| G. hook `https.request` 抄 OTLP 请求体 | ⚠️ | ✅ | 默认 protobuf 需自解码；扩展要经手全部遥测流量 |
| **H. 给 `dist/extension.js` 打补丁 + `globalThis` 回传** | ⚠️ **最优待验** | ✅ | 改 12.4MB 的 agent 核心；依赖同进程 |

推荐顺序：**H → F → G**。A/B/E 已排除，C/D 因日志体积被否决。

## 2. 数据到底在哪

### 2.1 真实 token 存在，但只喂给遥测

`dist/extension.js` 里有一个提取函数（minified 名每次构建都变，本次为 `Kgt`）：

```js
function Kgt(t) {
  let e = {}, r = t.usage_metadata;
  r && (
    e.inputTokens  = r.input_tokens,
    e.outputTokens = r.output_tokens,
    e.cacheReadInputTokens  = r.input_token_details.cache_read,
    e.cacheWriteInputTokens = r.input_token_details.cache_creation
  );
  let n = t.response_metadata;
  if (n?.metadata) {
    let a = n.metadata.usage;                       // Bedrock 口径兜底
    a && (…同上四项…);
    e.callLatency = n.metadata.metrics?.latencyMs;  // ★ 服务端自报的模型耗时
  }
  let o = t.additional_kwargs?.usageSummaryEntry;
  return o && (e.meteringUsage = o.usage, e.meteringUnit = o.unit), e;
}
```

可得字段：

| 字段 | 含义 |
| --- | --- |
| `inputTokens` / `outputTokens` | **真实** token 数（非估算） |
| `cacheReadInputTokens` / `cacheWriteInputTokens` | 缓存读 / 写的 token 数 |
| `callLatency` | 服务端自报的模型调用耗时（ms） |
| `meteringUsage` / `meteringUnit` | credit 计费 |

缓存命中率 = `cacheRead / (cacheRead + inputTokens)`。

唯一消费者是遥测：

```js
A = { [Oh.RequestId]: k.$metadata.requestId, [Oh.ModelIdentifier]: … }
this.metrics.reportHistogramMetrics({ inputTokens, outputTokens,
                                      cacheReadInputTokens, cacheWriteInputTokens }, A)
```

**不落盘、不下发 UI。** 这与「0.9x 也拿不到、当年需要劫持请求」的印象一致。

### 2.2 精确归属到一轮：靠 RequestId 关联

metric 的 attributes 带 `RequestId`（每次模型调用唯一），而会话文件里有本轮的清单：

```json
{"type":"usage_summary","elapsedTime":727407,"status":"success",
 "requestIds":["b21062aa-…","24c68348-…", …16 条]}
```

```
usage_summary.requestIds[]  ⨝(requestId)  每次调用的用量
```

因此**本轮 token = 该轮 requestIds 对应记录的求和**。requestId 全局唯一，并发多会话
也不会混，且无需在轮边界前后做差值。

### 2.3 上下文百分比是另一回事，别混用

`session_metadata.contextUsage.usagePercentage` 是**客户端估算**：bundle 里的
`TokenEstimator` 用 `estimateWithClaude = ceil(len/4)`、`estimateWithLlama = ceil(len/3.5)`，
而 `estimateWithTiktoken` 实际转调 `estimateGeneric`——也就是说**没有任何真实分词**。
另有固定开销：每条消息 +10、`document(file)` 固定 +100（不看文件大小）、`toolUse` +20。

由 `usagePercentage × maxInputTokens`（后者来自服务端模型列表 `tokenLimits.maxInputTokens`）
可反推 token，但那是「估算的估算」，且中文按 `char/4` 会**低估 3～4 倍**。
它表示的是**累计上下文大小**，不是本轮输入/输出。**不要用它冒充 token 数。**

## 3. 已排除的方案

### A. 读 `messages.jsonl` — 数据不在里面

扫本机 37 个会话文件、287 条 `usage_summary`：`token` / `cache` 字段出现 **0 次**。
`session_metadata` 只有 `contextUsage` 与 `displayError` 两个 key。

### B. 读 webview 流式事件 — 只有 credit

`turn_completion` → `{promptTurnSummaries, elapsedTime, status}`，用量项形状是
`{unit, unitPlural, usage, usedTools}`，`unit` 只出现过 `credit`。
对话面板 bundle 里搜 `token` 命中的全是 shiki 主题的 `tokenColors` 与 mermaid 词法
分析器的 `TokenBuilder`，**没有一个是 token 计数**——UI 若能显示必然有对应字段名。

### E. 旁听 OTel 全局 MeterProvider — Kiro 从不注册

```js
kCo(t) {
  let e = t?.meterProvider, r = t?.tracerProvider;
  if (e && r) { setGlobalMeterProvider(e); … info("Initialized with external providers") }
  else {
    let o = X6c(t?.qServiceEndpoint);
    new OTLPMetricExporter({ url: `${o}/v1/metrics`, temporalityPreference: DELTA, … })
  }
}
```

实际日志是 `[AgentTelemetry] Initialized {"endpoint":…,"serviceName":"kiroAgent"}`，
**不是** `Initialized with external providers` → 走 `else`，自建私有 provider。

诊断命令 `Kiro: 遥测旁听可行性探查（诊断）` 实测输出：

```
结论：不可行（同进程里没有 OTel 全局注册表）
全局注册表 symbol : （未找到）
```

OTel 的全局注册表本应在 `globalThis[Symbol.for('opentelemetry.js.api.<major>')]`
（代码里 `a0e = globalThis`，该设计正是为让多个打包副本互通），但从未被写入。

## 4. 可行但代价明确的方案

### C. `KIRO_CHAT_LOG_FILE=<路径>`

`qChatLogger` 把完整 request / response 写文件，response 那份含 `fullMessage`
（即带 `usage_metadata` 的对象）。`appendLine` 调用是无条件的，开关在 logger 内部。

- ✅ 立刻可用，无需打补丁，官方 debug 通道（比补丁抗升级）
- ❌ **每轮写入完整上下文**，实测单次请求 284KB（日志有 `Request payload: N chars`），
  且明文包含全部源码与对话

### D. `KIRO_DUMP_REQUESTS=1`（+ `KIRO_DUMP_REQUESTS_DIR`）

每次调用一个 JSON：`{invocation, request:{conversationState}, response:{conversationId, $metadata, headers}}`。

- ❌ 同样带完整请求体；响应头白名单 `Luu = new Set(["x-amzn-requestid"])`，
  **没有** `x-amzn-bedrock-*-token-count` 之类的 token 头，所以响应侧拿不到 token

### F. `OTEL_EXPORTER_OTLP_ENDPOINT` 指向本地

`X6c()` 明写 `return process.env.OTEL_EXPORTER_OTLP_ENDPOINT || (…默认…)`，确定生效。

```
OTEL_EXPORTER_OTLP_ENDPOINT = http://127.0.0.1:<端口>
OTEL_EXPORTER_OTLP_PROTOCOL = http/json     # 否则默认 protobuf
OTEL_METRIC_EXPORT_INTERVAL = 5000          # 默认 60s 太粗
```

- ✅ 数据量极小（纯数字）、**零对话内容**
- ✅ `temporalityPreference: DELTA` → 每次导出只含增量，不用做累积差值
- ❌ 扩展设 OS 环境变量对**已运行的 Kiro 无效**，需**整个 Kiro 重启**（reload window 不换
  进程环境），且污染全局环境
- ❌ **遥测不再上报 AWS**（等价于关掉遥测）
- ⚠️ 未验证：`OTEL_EXPORTER_OTLP_PROTOCOL` / `OTEL_METRIC_EXPORT_INTERVAL` 是通用 OTel SDK
  的 env，Kiro 显式构造 exporter 时可能不采纳；只有 `..._ENDPOINT` 是代码里明写读取的

同进程改 `process.env` 可以免掉重启，但要抢在 Kiro 遥测初始化之前，**扩展激活顺序不保证**。

### G. hook `https.request` 抄 OTLP 请求体

同进程下可包 `https.request`，在不改端点、遥测照常上报 AWS 的前提下抄一份。

- ❌ 默认 protobuf，需要自己解码
- ❌ 我们的扩展要经手全部遥测流量，脆弱且职责过重
- ⚠️ 未验证：esbuild 可能已把 `request` 绑定捕获，后打的 patch 不一定生效
  （与 `Object.freeze(window.vscode)` 同一类坑）

## 5. 推荐方案 H：给 `extension.js` 打补丁 + `globalThis` 回传

思路与已上线的「对话面板实时耗时」补丁同构：改 Kiro 磁盘产物，注入一句回调，
由本扩展在同进程接收。

### 5.1 注入点（已只读验证，锚点唯一）

原文：

```js
…this.metrics.reportCountMetrics({success:1},A);let J=Kgt(Z?.message);return this.metrics.reportHistogramMetrics({…},A),…
```

在 `let J=Kgt(Z?.message);` 之后插一句：

```js
try{globalThis.__kcsUsageTap&&globalThis.__kcsUsageTap(J,A)}catch{}
```

此处**同时**能拿到用量对象 `J` 与带 `RequestId` 的属性对象 `A`——正是精确归属所需的
全部信息。插入位置是干净的语句边界。

### 5.2 锚点必须按语义定位，不能写死名字

`Kgt` / `J` / `A` 都是每次构建都变的 minified 名。定位方式：

1. 用**函数体的语义特征**反解提取函数名：
   ```
   function (\w+)\((\w+)\)\{if\(!\2\)return\{\};let (\w+)=\{\},(\w+)=\2\.usage_metadata;
   ```
   并校验函数体含 `input_tokens` / `input_token_details` / `cache_read` / `cache_creation` /
   `cacheReadInputTokens` / `cacheWriteInputTokens` / `latencyMs` / `usageSummaryEntry`
2. 再找 `let X = <该函数名>(` 且 900 字符内紧邻 `reportHistogramMetrics` 的调用点
3. 从上报语句里取第二个实参名，即 attributes 变量

**实测（Kiro 1.0.337，extension.js 12.38MB）：**

```
[1] 提取函数命中 = 1     名字 = Kgt   语义特征齐全 = true
[2] 形如 let X=Kgt(…) 的调用 = 1     变量 = J   紧邻上报 = true   attributes = A
[3] 可用注入点 = 1
[4] attributes 定义处 = 2   A={[Oh.RequestId]:k.$metadata.requestId} / …S.$metadata.requestId
[5] 是否已打过补丁 = false
```

各步均**唯一命中**，无歧义。

### 5.3 前提：必须同进程

`globalThis` 回传要求 kiro-agent 与本扩展在同一 Node 进程。

- 支持证据：`Handshake: returning logging config` 这句就在 `extension.js` 里，说明 ACP 的
  agent 侧逻辑在扩展内；`StdioClientTransport` 只用于 MCP 子进程；进程列表里没有独立 agent 进程
- kiro-agent 几乎不往 `globalThis` 写东西（只有一处 `globalThis.awslambda`，属 AWS SDK 死代码），
  所以**无法间接证明**共享
- **决定性判据**：`require.cache` 里有没有它的 `extension.js`。同进程 ⇒ 共享
  `require.cache` 与 `globalThis`。已加入诊断命令（`agentInSameProcess`），只读、零风险

若判为不同进程，则 F/G/H 三条 in-process 方案全部不成立，只剩 C/D。

### 5.4 代价与风险

- ❌ 目标是 **12.4MB 的 agent 核心**，远比对话面板那个 700 字节 loader 高危；写坏则 Kiro
  agent 整体不可用。缓解：整份备份 + 字节级还原 + 注入语句全包在 `try{}catch{}` 里
- ❌ Kiro 升级会覆盖，需按既有机制自愈重打（同 TurnTimerPatch）
- ⚠️ 依赖内部结构：Kiro 重构这段代码后锚点可能失效。缓解：锚点建立在语义字符串上，
  且定位失败时**静默降级不显示 token**，不影响主功能
- ✅ 不改端点、不设环境变量、不重启、遥测照常上报 AWS

### 5.5 若继续开发的落地顺序

1. 跑诊断命令确认 `agentInSameProcess = 是`（**前提，不通则放弃 H**）
2. 先只插一句 `globalThis.__kcsPatchAlive = Date.now()` 的最小标记补丁，reload 后由诊断命令
   确认能收到 → 同时验证「补丁生效」与「globalThis 共享」
3. 换成真正的 `__kcsUsageTap(J, A)`，扩展侧按 `RequestId` 收集
4. 读 `usage_summary.requestIds[]` 做 join，求和后接在原生 footer 后面展示
5. 复用设置页的探测 / 重试 / 还原三件套

## 6. 相关但独立的发现

- **`KIRO_TIMELINE=1`**：把 `model_start` / `model_end` / `tool_start` / `tool_end`（带
  `durationMs`）写进 `~/.kiro/logs/*/kiro.log`，**体积很小**。配合 `callLatency` 可得
  「网络开销 = 客户端墙钟 − 服务端自报耗时」，是判断「网络慢还是服务端慢」的正解
- **`_kiroModelTiming`**：`additional_kwargs._kiroTiming` 带 `modelRequestSentAt` /
  `firstTokenReceivedAt`，经 `_meta.kiro.ttft` 下发给 webview（受 capability 开关控制），
  **不落盘**
- **`timeToFirstToken` / `timeToFirstInference`**：也是 histogram，带同一组 attributes，
  因此 H 方案顺带能拿到调用级首字延迟
- **`RecapService`** 会无条件 `P.info` 出 `in=… out=… cacheRead=… cacheWrite=…` 到
  `kiro.log`——但只覆盖会话摘要那次模型调用，不是主对话

## 7. 术语与文件位置

| 名称 | 位置 |
| --- | --- |
| agent 主 bundle | `<Kiro>/resources/app/extensions/kiro.kiro-agent/dist/extension.js` |
| 对话面板产物 | `…/kiro.kiro-agent/packages/kiro-ui-agent-chat/dist/` |
| agent 运行日志 | `~/.kiro/logs/<时间戳>/kiro.log` |
| 会话数据 | `~/.kiro/sessions/<WsHash16>/<sessionId>/messages.jsonl` |
| 遥测端点 | `https://prod.<region>.telemetry.desktop.kiro.dev` |
| 模型请求端点 | `https://runtime.<region>.kiro.dev` |
| region 来源 | `%APPDATA%/Kiro/User/globalStorage/kiro.kiroagent/profile.json` 的 ARN |
