# Implementation Plan: Kiro Chat Search

## Overview

当前仓库已有 `src/extension.ts`、`src/paths.ts`、`src/search.ts`、`src/webview.ts` 的初版实现，覆盖了"活动栏入口 + 居中 Webview + 搜索 + 跳转命令"的核心交互（对应 Requirement 3、4、6、8、9 的运行时行为）。本计划在这一基础上聚焦三件事：

1. **解耦与可测性重构**：把 `EnvChecker` 抽到 `src/env.ts`、把 `JumpCommandResolver` 抽到 `src/jump.ts`、为 `PathResolver` 增加可选 `deps` 参数（保留现有签名），并把 Webview 中的 `escapeHtml` / `highlight` / `fmtTime` 抽到 `src/webview/format.ts`。
2. **测试体系建立**：引入 vitest 与 fast-check，建立 `tests/` 目录，按设计文档的 8 条 Correctness Properties 编写属性测试，并配以表驱动单元测试覆盖跨平台路径、错误优先级、跳转回退、消息结构兼容、JSON 容错与时间格式。
3. **文档完善与编译验证**：按 Requirement 11 重写 README，并在最后跑通 `tsc` 与 `vitest`。

下面的 Task Dependency Graph 用 Mermaid 给出按 Wave 划分的并行执行视图，便于直观理解任务间的依赖。文末另附 JSON 形式的依赖图供编排器使用。

## Task Dependency Graph (Mermaid)

```mermaid
flowchart LR
  subgraph W0[Wave 0 - 基础准备]
    direction TB
    T11[1.1 paths deps 参数]
    T13[1.3 jump.ts]
    T21[2.1 webview/format.ts]
    T31[3.1 引入 vitest/fast-check]
  end
  subgraph W1[Wave 1 - 核心抽取]
    direction TB
    T12[1.2 env.ts]
    T22[2.2 webview 复用 format]
    T32[3.2 vitest 配置 + npm test]
  end
  subgraph W2[Wave 2 - 集成与脚手架]
    direction TB
    T14[1.4 extension 接入新模块]
    T23[2.3 CSP / nonce 校验]
    T33[3.3 测试 helper / mocks]
  end
  subgraph W3[Wave 3 - 单测与首批属性]
    direction TB
    T41[4.1 paths 单测]
    T42[4.2 Property 1]
    T51[5.1 search 单测]
    T52[5.2 Property 4]
    T61[6.1 env 单测]
    T62[6.2 jump 单测]
    T71[7.1 format 单测]
  end
  subgraph W4[Wave 4 - 第二轮属性]
    direction TB
    T43[4.3 Property 2]
    T53[5.3 Property 5]
    T72[7.2 Property 8]
  end
  subgraph W5[Wave 5 - 第三轮属性]
    direction TB
    T44[4.4 Property 3]
    T54[5.4 Property 6]
  end
  subgraph W6[Wave 6 - 收尾属性]
    direction TB
    T55[5.5 Property 7]
  end
  subgraph W7[Wave 7 - README 主体]
    direction TB
    T81[8.1 README 主体]
  end
  subgraph W8[Wave 8 - README 增补]
    direction TB
    T82[8.2 README 排错与开发]
  end
  subgraph W9[Wave 9 - 编译]
    direction TB
    T91[9.1 tsc 编译]
  end
  subgraph W10[Wave 10 - 测试]
    direction TB
    T92[9.2 vitest run]
  end

  W0 --> W1 --> W2 --> W3 --> W4 --> W5 --> W6 --> W7 --> W8 --> W9 --> W10
```

## Tasks

- [x] 1. 重构核心模块（保持向后兼容，提升可测性）
  - [x] 1.1 为 `PathResolver` 增加可选 `deps` 参数
    - 在 `src/paths.ts` 中定义 `PathResolverDeps`（platform / env / homedir / existsSync / statSync），并为 `getKiroUserDataDir`、`getSessionsRoot`、`resolveWorkspaceSessionDir` 增加可选 `deps` 形参
    - 默认行为必须与现有实现完全等价（不传 `deps` 时行为不变）
    - 保留现有导出函数签名，避免破坏 `extension.ts` 中已有调用
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.5, 2.6, 10.2_

  - [x] 1.2 抽出 `EnvChecker` 到 `src/env.ts`
    - 新建 `src/env.ts`，迁移 `extension.ts` 中的 `EnvCheck` 类型与 `checkEnvironment` 函数
    - 增加 `EnvCheckerDeps`（workspaceFolder / pathResolver），允许测试通过 `deps` 注入而不污染 `process.platform`
    - 保持错误返回顺序：UserDataDir → SessionsRoot → 未打开工作区 → WorkspaceSessionDir
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 1.3 抽出 `JumpCommandResolver` 到 `src/jump.ts`
    - 新建 `src/jump.ts`，导出 `resolveAndExecuteJumpCommand(sessionId, deps?)`
    - `JumpDeps` 包含 `getCommands` / `executeCommand` / `showError` / `candidates`，默认候选为 `['kiroAgent.viewSpecSession', 'kiroAgent.openChatSession']`
    - 命令存在但抛错时回退到下一候选；全部失败时通过 `showError` 输出同时含两个命令名的中文提示
    - _Requirements: 7.8, 9.1, 9.2, 9.3, 9.4, 9.5_

  - [x] 1.4 在 `extension.ts` 中接入新模块
    - 删除 `extension.ts` 中内联的 `checkEnvironment` / `EnvCheck` 与 `SearchPanel.openSession` 内的命令查找逻辑，改为从 `./env` / `./jump` 导入
    - 保持 `SearchPanel`、`EntryViewProvider`、`activate` / `deactivate` 行为与现有用户体验一致（单例复用、`focus` 消息、`retainContextWhenHidden` 等）
    - 跳转成功后不关闭 SearchPanel
    - _Requirements: 6.3, 6.4, 6.5, 9.5_

- [x] 2. 抽取 Webview 纯函数到独立模块
  - [x] 2.1 创建 `src/webview/format.ts`
    - 导出 `escapeHtml(s)`、`escapeRegExp(s)`、`highlight(text, keyword)`、`fmtTime(ms, now?)`
    - `highlight` 必须先 `escapeHtml` 再以 `<mark>` 包裹关键词命中段，且支持注入 `now` 以便测试 `fmtTime` 跨日 / 跨年逻辑
    - _Requirements: 8.1, 8.9_

  - [x] 2.2 在 `webview.ts` 中通过模板注入复用同一份 format 实现
    - 在生成 HTML 时把 `format.ts` 中的纯函数源码（或等价字符串）注入到 `<script nonce="...">`，确保运行时与单测使用同一份逻辑
    - 移除 `webview.ts` 内联脚本中重复定义的 `escapeHtml` / `highlight` / `fmtTime`
    - _Requirements: 6.6, 8.1, 8.9_

  - [x] 2.3 校验注入后 CSP / nonce 仍然有效
    - 在 `webview.ts` 中确认 `default-src 'none'` 与 `script-src 'nonce-${nonce}'` 拼接正确
    - 每次创建 SearchPanel 时生成新的 32 字符随机 nonce
    - _Requirements: 6.5, 6.6_

- [x] 3. 引入测试框架与基础设施
  - [x] 3.1 添加 vitest / fast-check 等 devDependencies
    - 在 `package.json` 的 `devDependencies` 中新增 `vitest`、`fast-check`，并保持 `@types/node` / `@types/vscode` / `typescript` 版本不变
    - _Requirements: 10.1_

  - [x] 3.2 创建 `vitest.config.ts` 与 `npm test` 脚本
    - 在仓库根新增 `vitest.config.ts`，启用 `node` 环境（涉及 jsdom 的子集走 `--environment=jsdom` 单独覆盖，本期可暂不引入）
    - 在 `package.json` 的 `scripts` 中新增 `test`(=`vitest run`)、`test:watch`(=`vitest`)
    - _Requirements: 10.1_

  - [x] 3.3 创建 `tests/` 目录与公共 helper
    - 新建 `tests/_helpers.ts`，提供 `mkTempDir()` / `rmTempDir()`（基于 `fs.mkdtempSync` + `fs.rmSync({recursive:true,force:true})`）以及 `writeSession(dir, name, obj)` 工具
    - 在 `tsconfig.json` 中确保 `tests/` 不被发布产物包含（必要时新增 `exclude`）
    - _Requirements: 10.1, 10.4, 10.7_

- [x] 4. PathResolver 单元测试与属性测试
  - [x]* 4.1 PathResolver 表驱动单元测试
    - 在 `tests/paths.spec.ts` 中通过 `deps` 注入 `platform`/`env`/`homedir`/`existsSync` 表驱动地覆盖 Windows / macOS / Linux / `XDG_CONFIG_HOME` 缺失 / `APPDATA` 缺失等分支
    - 在临时目录中创建多种 EncodedKey 子目录，断言 `resolveWorkspaceSessionDir` 命中规则与 `null` 回退
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.5, 2.6, 10.2, 10.4_

  - [x]* 4.2 Property 1: base64url 编码合法且可逆
    - 在 `tests/paths.property.spec.ts` 中以 `fc.string()` 生成任意 UTF-8 输入，断言编码输出仅含 `[A-Za-z0-9_-]`，且经 `_→/`、`-→+`、补 `=` 后能还原原字符串
    - **Property 1: base64url 编码合法且可逆**
    - **Validates: Requirements 2.1**

  - [x]* 4.3 Property 2: 路径变体覆盖（盘符与斜杠维度）
    - 在 `tests/paths.property.spec.ts` 中以 fast-check 构造含盘符与混合斜杠的 Windows 风格路径，断言 `encodeWorkspaceKeys` 输出覆盖盘符大小写 × 全反斜杠/全正斜杠的全部组合
    - **Property 2: 路径变体覆盖**
    - **Validates: Requirements 2.2, 2.3**

  - [x]* 4.4 Property 3: 候选去重
    - 在 `tests/paths.property.spec.ts` 中断言 `new Set(keys).size === keys.length`，对任意输入路径都成立
    - **Property 3: 候选去重**
    - **Validates: Requirements 2.4**

- [x] 5. SearchEngine 单元测试与属性测试
  - [x]* 5.1 SearchEngine 表驱动单元测试（命中场景 + 容错 + 排序限流）
    - 在 `tests/search.spec.ts` 中以临时目录构造 SessionFile，覆盖：标题命中 → `matchField === 'title'` 且 `snippet === title`；不同结构（`history[].message.content` 字符串 / `content[].text` 数组 / `messages[].content` / `messages[].text`）的消息命中；缺失 `title` / `name` 时 `Untitled` 兜底；空白关键词返回 `[]`；多于 `limit` 的命中按 `mtimeMs` 倒序截断
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 5.4, 10.5, 10.6, 10.8_

  - [x]* 5.2 Property 4: 关键词命中标题
    - 在 `tests/search.property.spec.ts` 中以 fast-check 生成 `title` 与不含正则元字符的关键词 `k`，断言只要标题包含与 `k` 大小写无关的子串，对应 SearchHit 必满足 `matchField === 'title'` 且 `snippet === title`
    - **Property 4: 关键词命中标题**
    - **Validates: Requirements 4.1, 4.2**

  - [x]* 5.3 Property 5: 消息 snippet 截取不变量
    - 在 `tests/search.property.spec.ts` 中对 `makeSnippet(text, idx, span=80)`（必要时从 `search.ts` 导出测试入口）断言：长度不超过 `2*80 + k.length + 2`、含 `k`（大小写无关子串）、不含连续两个空白字符
    - **Property 5: 消息 snippet 截取不变量**
    - **Validates: Requirements 4.3**

  - [x]* 5.4 Property 6: 结果排序与限流
    - 在 `tests/search.property.spec.ts` 中以 fast-check 在临时目录中生成 `N > limit` 个均命中关键词且 `mtimeMs` 互不相同的 SessionFile，断言 `out.length ≤ limit` 且对相邻对 `out[i].modified >= out[i+1].modified`
    - **Property 6: 结果排序与限流**
    - **Validates: Requirements 4.5, 4.6**

  - [x]* 5.5 Property 7: 损坏文件不影响其他命中
    - 在 `tests/search.property.spec.ts` 中以 fast-check 构造合法 SessionFile 集合，再向同目录写入任意非合法 JSON 的 `.json` 文件，断言加入前后返回的 `SearchHit[]` 完全相等且函数不抛异常
    - **Property 7: 损坏文件不影响其他命中**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.5, 7.7**

- [x] 6. EnvChecker 与 JumpCommandResolver 测试
  - [x]* 6.1 EnvChecker 表驱动单元测试
    - 在 `tests/env.spec.ts` 中通过 `deps` 注入构造下列场景并断言返回值：UserDataDir 缺失（仅给出错误，无 `userDataDir` 字段）；UserDataDir 在但 SessionsRoot 缺失（保留 `userDataDir`）；无工作区；WorkspaceSessionDir 缺失；全部就绪
    - 显式断言"多异常并存时按优先级返回第一个"（同时构造 UserDataDir 缺失 + 无工作区，应只看到 UserDataDir 错误）
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x]* 6.2 JumpCommandResolver 候选回退与失败提示单测
    - 在 `tests/jump.spec.ts` 中通过 `deps` 注入 mock 的 `getCommands` / `executeCommand` / `showError`，覆盖：`viewSpecSession` 存在并成功 → 用它；`viewSpecSession` 抛错 → 回退到 `openChatSession`；只有 `openChatSession`；两者均不存在 → `showError` 文案同时包含两个命令名；`sessionId` 为空 → 不调用任何命令
    - _Requirements: 7.8, 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 7. Webview format 单元测试与 Property 8
  - [x]* 7.1 escapeHtml / fmtTime 表驱动单测
    - 在 `tests/webview.format.spec.ts` 中表驱动地覆盖 `escapeHtml` 对 `& < > " '` 的转义；`fmtTime` 在"今天 / 同年 / 跨年"三种场景下分别得到 `今天 HH:mm` / `MM-DD HH:mm` / `YYYY-MM-DD HH:mm`（通过注入 `now` 控制基准时间）
    - _Requirements: 8.9_

  - [x]* 7.2 Property 8: 高亮包裹不变量
    - 在 `tests/webview.highlight.property.spec.ts` 中以 fast-check 生成任意文本 `t` 与非空关键词 `k`，断言 `highlight(t, k)` 输出 `html`：剥离所有 `<mark>` 标签并 HTML 反转义后等于 `t`；所有与 `k` 大小写无关的匹配段都被 `<mark>...</mark>` 精确包裹一次（不嵌套、不遗漏）
    - **Property 8: 高亮包裹不变量**
    - **Validates: Requirements 8.1**

- [x] 8. 完善 README 文档
  - [x] 8.1 重写 README 主体
    - 在 `README.md` 中补齐：扩展功能概述、跨平台路径规则表、激活方式（Activity Bar 入口 + `Ctrl+Alt+K` / `Cmd+Alt+K`）、搜索规则（标题与消息、最多 10 条、按 `mtimeMs` 倒序、120ms 防抖）、JumpCommand 优先级与回退顺序
    - _Requirements: 11.1, 11.2_

  - [x] 8.2 README 增补排错与本地开发章节
    - 在 `README.md` 中追加：四类环境错误（UserDataDir / SessionsRoot / 无工作区 / WorkspaceSessionDir）+ 单文件 JSON 损坏 + JumpCommand 均不可用 共六类错误的排查方法；本地开发与打包步骤（`npm install` / `npm run compile` / `npm test` / `npx vsce package`）；WorkspacePath 编码规则（`base64` 去 `=`、`+→-`、`/→_`）以及盘符大小写与斜杠变体的处理策略
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.7, 7.8, 11.3, 11.4, 11.5_

- [x] 9. 最终编译与测试验证（Checkpoint）
  - [x] 9.1 运行 `tsc` 编译
    - 执行 `npm run compile`，修复因新增 `deps` 参数 / 新模块导入引发的类型错误
    - 确认 `out/` 输出存在 `extension.js`、`paths.js`、`search.js`、`webview.js`、`env.js`、`jump.js`、`webview/format.js`
    - _Requirements: 10.1_

  - [x] 9.2 运行 `vitest run` 并确保全部测试通过
    - 执行 `npm test`，确保 8 条 property 测试 + 全部表驱动单测通过（默认 100 次随机迭代）
    - 如有失败，按失败用例反查相应模块，修复后重跑；测试无问题再向用户反馈
    - Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8_

## Notes

- 标 `*` 的子任务为可选测试任务（property 测试与单元测试），可在 MVP 路径上跳过；但本计划建议全部实现以满足 Requirement 10 的覆盖要求。
- 每条 Property 测试都对应 design.md 中的同名属性，独立成一个 `it(...)`，并在注释中标注 `Feature: kiro-chat-search, Property N: <标题>`。
- 所有 fs/平台相关测试都通过 `deps` 注入或临时目录运行，**不修改 `process.platform`、不读写真实的 `%APPDATA%/Kiro` 等用户目录**。
- 重构原则：保留 `src/paths.ts`、`src/search.ts`、`src/extension.ts`、`src/webview.ts` 中现有导出函数签名与默认行为，新增能力以可选 `deps` 参数或新建模块的形式提供，避免破坏既有调用。
- Checkpoint（任务 9）作为统一验收点；中间任意阶段如出现重大歧义可提前与用户确认。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3", "2.1", "3.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "3.2"] },
    { "id": 2, "tasks": ["1.4", "2.3", "3.3"] },
    { "id": 3, "tasks": ["4.1", "4.2", "5.1", "5.2", "6.1", "6.2", "7.1"] },
    { "id": 4, "tasks": ["4.3", "5.3", "7.2"] },
    { "id": 5, "tasks": ["4.4", "5.4"] },
    { "id": 6, "tasks": ["5.5"] },
    { "id": 7, "tasks": ["8.1"] },
    { "id": 8, "tasks": ["8.2"] },
    { "id": 9, "tasks": ["9.1"] },
    { "id": 10, "tasks": ["9.2"] }
  ]
}
```
