# Kiro 1.x 存储结构勘查笔记

> 本文件是 `kiro-1x-storage-adaptation` spec 的**技术输入**，内容全部为在真实机器上
> 实测所得（Kiro 1.0.337，内置 kiro-agent 1.0.653），非推测。需求与设计阶段可直接引用，
> 无需重新勘查。勘查日期：2026-09-01。

## 1. 旧存储（0.9x）—— 仍在盘上，仍需兼容

```
%APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\
    workspace-sessions\<EncodedKey>\
        <sessionId>.json          单文件即一个会话
        sessions.json             清单
        ._migration-<uuid>.json   迁移标记（1.x 迁移后留下）
    <workspaceId>\<bucket>\<hash32(executionId)>   执行存档（附件 + 积分数据）
```

- `EncodedKey` = base64url(工作区路径)，`=` 替换为 `_`
- `workspaceId` = `sha256(原始路径).slice(0,32)`，**不做任何归一化**
- 本机实测：3.6 GB / 7735 文件 / 7 个工作区

## 2. 新存储（1.x）

```
~\.kiro\sessions\<wsHash16>\<sessionId>\
    session.json        元数据
    messages.jsonl      对话本体（一行一事件）
    snapshots\<hash>\<相对路径>    文件检查点 = 1.x 的"执行存档"对应物
    sub-executions\     子代理执行
    publish.cursor / publish-sub.cursor
~\.kiro\session-index\<wsHash16>.jsonl    追加式索引
~\.kiro\session-index\.migration-v3
~\.kiro\tasks\<wsHash16>\<spec>.meta.json
```

- **`wsHash16 = sha256( 路径.replace(/\\/g,"/").toLowerCase() ).slice(0,16)`**
  已用两个样本验证：
  - `d:\Projects\KiroExt\KiroChatSearcher` → `cc5023603866cd91`
  - `d:\SurErp\ERP-OMS-Workspaces` → `6082f0c94c5c4af8`
  与旧算法**既换了摘要范围也换了归一化**，不能复用。
- 会话不再是单文件，而是**一个目录** —— 清理语义因此完全不同。
- sessionId：迁移过来的沿用原 uuid；1.x 新建的形如 `sess_<uuid>`。
- 本机实测：256 MB / 2856 文件。

### session.json 字段（实测）

```json
{
  "schemaVersion": "1.0.0", "dataModelVersion": 1,
  "id": "9f8fb2af-...", "title": "Spec: storage-usage-analytics",
  "agentMode": "spec",
  "workspacePaths": ["d:\\Projects\\KiroExt\\KiroChatSearcher"],
  "rootPaths": ["d:\\Projects\\KiroExt\\KiroChatSearcher"],
  "createdAt": "2026-08-12T08:23:21.781Z",
  "lastModifiedAt": "2026-09-01T05:07:55.425Z",
  "modelId": "claude-opus-5", "autopilot": true,
  "effortLevel": "xhigh", "status": "in_progress"
}
```

### messages.jsonl 格式（实测）

每行 `{ id, timestamp, payload: { type, ... } }`。某个 3 MB 会话的 type 分布：

| payload.type | 条数 |
| --- | --- |
| tool_call / tool_result | 249 / 249 |
| assistant | 190 |
| session_metadata | 110 |
| sub_agent_start / sub_agent_complete | 92 / 92 |
| pending_interaction / interaction_resolved | 79 / 79 |
| turn_start / turn_end | 15 / 14 |
| user | 15 |
| session_event | 8 |
| **usage_summary** | 8 |
| tombstone | 1 |

#### usage_summary 事件的实测形状（任务 6.1 期间在真实会话上读到）

```json
{ "payload": {
  "type": "usage_summary",
  "promptTurnSummaries": [
    { "unit": "credit", "unitPlural": "credits", "usage": 147.15274264905472,
      "usedTools": ["read_file", "..."] }
  ],
  "elapsedTime": 1056804, "status": "success",
  "executionId": "25dcf9dc-...", "requestIds": ["..."]
}}
```

要点（都影响实现口径）：

- 用量数组的字段名是 **`promptTurnSummaries`**，不是 0.9x 存档里的 `usageSummary`。
- 但**数组项与 0.9x 同构**（都是 `{usage, unit, unitPlural}`），差别只在 0.9x 把
  `usedTools` 另立一项、1.x 并进了同一项。既有谓词「`usage` 是有限数 且 `unit`
  不分大小写等于 `credit`」在两种排布下结果一致，故求和逻辑可以复用，
  不需要为 1.x 另写一份口径。
- 真实数据里存在 `promptTurnSummaries: []` 的空事件（status 为 failed 的执行）。
  这类事件贡献 0 项；若整个会话都是这种，结果应落到「不可用」而不是 0。
- 交叉验证：本机某会话 28 个 `usage_summary` 事件 / 16 个 credit 项 /
  合计 `737.5206366955888`，用独立写的朴素统计脚本重算得到完全相同的数值。
**积分/用量数据搬进了 messages.jsonl 的 `usage_summary` 事件**。旧的
`credits.ts` 靠 `hash32(executionId)` 反查独立存档文件的机制在 1.x 上完全失效。

### 迁移标记（留在旧目录里）

```json
{
  "migratedAt": "2026-08-31T09:50:30.724Z",
  "v2SessionId": "9f8fb2af-0d80-4521-852d-f1404757d60f",
  "workspaceHash": "2cdaa0f6fffc6b9e",
  "v1WorkspaceDirectory": "d:\\Projects\\KiroExt\\KiroChatSearcher",
  "markerVersion": 2
}
```

注意坑：标记里的 `workspaceHash` 是**旧**算法 `sha256(原始路径).slice(0,16)`，
与新目录名 `wsHash16` 不是一回事，不能拿它去定位新目录。

## 3. 迁移是用户手动触发的（官方 changelog 1.0.52 确认）

本机迁移率：

| 工作区 | 旧会话 | 已迁移 |
| --- | --- | --- |
| d:\SurErp\ERP-OMS-Workspaces | 157 | 5 |
| d:\Projects\DotNet\CsCodeMap | 26 | 0 |
| d:\Projects\KiroExt\KiroChatSearcher | 6 | 6 |
| d:\Projects\Js\JSTOrderHelper | 4 | 0 |
| d:\Projects\CCN | 2 | 0 |
| d:\Projects\work_order | 1 | 0 |
| d:\SurErp\ERP-KB | 1 | 0 |

197 个旧会话仅迁移 11 个。未迁移的会话在 1.x 里**看不见也续不上**，只存在于旧目录。

## 4. 跳转命令变更（对 kiro-agent 1.0.653 的 dist/extension.js 实测）

| 插件原用候选 | 1.x 状态 |
| --- | --- |
| `kiroAgent.showExecutionInChatTab` | **已移除**（原首选） |
| `kiroAgent.viewSpecSession` | **已移除**（原次选） |
| `kiroAgent.loadSessionWithPrompt` | 还在，但签名变为 `(_sessionId, prompt)`，**sessionId 被忽略** |

正确替代品：

```js
registerCommand("kiroAgent.viewSession", (sessionId, title) => {
  const mgr = getSessionPanelManager();
  if (!mgr || !sessionId) return;
  mgr.switchToSidebarSession(sessionId, typeof title === "string" ? title : void 0);
})
```

`kiroAgent.viewSession(sessionId, title?)` 无副作用，Kiro 自身内部到处在用。
备选 `kiroAgent.sessions.switch(sessionId, windowId, source)`。
`kiroAgent.openChatSession()` 不接受参数（内部弹 QuickPick），不能用于定点跳转。

## 5. 已修掉的历史 bug（供回归参考）

排行页永久卡在「统计中…」：`pageOf` / `rankingTitleCell` 引用了**被导出的** const，
tsc 的 CommonJS 输出把引用重写成 `exports.X`；这些函数经 `toString()` 注入 webview 后
`exports` 不存在 → 脚本收尾的 `render()` 抛 ReferenceError → 紧随其后的
`postMessage({type:"ready"})` 永不发出 → 宿主从不取数 → 页面停在骨架里的静态文案。
同类隐患还有跨模块导入被重写成 `mod_1.X`。已由 `tests/webview.inline-script.spec.ts`
的 CJS 路径执行 + 文本扫描守卫钉住。
