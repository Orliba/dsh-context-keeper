# dsh-context-keeper · v3 设计稿：上下文蒸馏与交接

> 起草：奥小巴 · 2026-10-29
> 状态：P1+P2 已实现（宿主侧）；**P3 基本完成（客户端徽章 + 橙红档提醒 + 开新会话按钮，2026-10-30）**；P4 未做
> 承接：`docs/plugin-design-v2.md`（v2 已实现：系统提示规则段落 + 离线思考分析 CLI）
> 本文回答奥利巴新提的三点：①蒸馏 `dsh-context`；②参考 `billion-context` 蒸馏提纯、省 token；③上下文过长时提醒/自动开新会话，并把前面内容总结打包。
>
> 实现落点（P1+P2）：`src/budget.mjs`（占用/档位/增速）、`src/handoff.mjs`（交接包+全文归档）、`src/session.mjs` 的 `readSessionDetail()`（用户/工具/报错/压缩摘要提取）、`bin/cli.mjs` 的 `context` 与 `handoff` 命令、`plugin/index.mjs` 的 `/context-watch` 与 `/handoff` 命令 + 静态预算提醒段。两种检索均零模型调用。
>
> 实现落点（P3）：`plugin/client.js`（客户端半，`dsh.client` 声明）。两处座位：① `conversation.chat.turnTail` 挂色块徽章，读官方 `contextPressure` 投影（`pressureTokens / projectedTokens / contextWindow`）算档位，颜色点 + 百分比；② `conversation.composer.dock` 挂提醒气泡 +「开新会话」按钮，仅橙/红档出现，按钮走 `remote.session.create` + `remote.session.prompt` 在 `session.cwd` 新建会话并投喂"读最新交接包"的续接指令。均为纯展示 + 一次显式点击，零 token、不进模型输入。`src/budget.mjs` 增加 `formatBadge()` 与 `BAND_COLOR`，`test/client-badge.test.mjs` 校验客户端内联副本与宿主 `formatBadge` 逐点一致，并覆盖提醒门控与开新会话流程。

---

## 一、一句话

v2 管的是"想得好不好"；v3 管的是"装得下装不下"。核心是三件事：
**看得见余量（Guard）→ 一键把当前进度蒸馏成可带走的包（Handoff）→ 到了临界点提醒开新会话（提醒优先，自动可开但默认关）。**

我们**不重造** `dsh-context` 的仪表盘，也**不搬** `billion-context` 的整条压缩管线。只把两者里最值钱、最轻的那部分"蒸馏"出来，接到 DSH 官方已有的测量与压缩接口上。

---

## 二、从 `dsh-context`（上下文洞察插件）蒸馏什么

`dsh-context` 很重（`lib/client.js` 533KB，一整套仪表盘 / 浏览器 / 文件活动 / Agent 网络）。我们只要它背后的**信号**，不要它的**界面**。

| 它有的东西 | 蒸馏结论 | 理由 |
|---|---|---|
| 用官方投影 `contextPressure`（pressureTokens / projectedTokens / contextWindow）和 `contextBreakdown`（system / tools / messages）算占用 | **保留（只读复用）** | 这是 DSH 官方 token-meter 已经算好的，插件只需读，不必自己数 token。自己数会算错、还烧钱 |
| "上下文是一份能看见、能花掉的预算"这个心智 | **保留** | 这正是"过长提醒"的立论基础 |
| `compaction/summary`、`compaction/prune`、注入、模型切换等**事件**（带净 token 增减） | **保留（只取 3 类）** | 用户最需要知道"为什么突然掉下去"：压缩/裁剪/换模型。其余事件不取 |
| 占用趋势（每请求/每步一条） | **降级保留** | 只保留"最近若干次请求的占用斜率"，用于判断"涨得快不快"，不画图 |
| 仪表盘、热力图、Context Browser、File Activity、Agent Network | **丢弃** | 重 UI，且奥利巴已经装了 `dsh-context`，看数据去那儿看；context-keeper 不自建 |

**蒸馏产物**：一个 **Context Budget Guard**——用官方投影读占用，算"余量 / 斜率 / 上次压缩回收了多少"，作为提醒和打包的触发源。

---

## 三、从 `billion-context`（ACP）蒸馏什么

`billion-context` 的价值不在"它接管了 Pi 的 context 事件"这套管线（那是给 Pi 的，且 DSH 已有自己的 compaction，硬搬会打架）；价值在**压缩的质量标准**。

| 它有的东西 | 蒸馏结论 | 理由 |
|---|---|---|
| 高保真结构化摘要：**逐字保留**路径、命令、错误串、标识符、数值、函数签名；**丢弃**冗长日志、重复内容、已消费的探索 | **保留（第一优先）** | 这是纯 prompt 层面的东西，最便宜、最通用、收益最大。DSH 自带的 compaction 指令已经不错，我们再加"逐字保留清单"这条硬规则 |
| 保护三类内容：最后一条用户消息（永久）、最近尾部（软保护 ~5K token / 最后 N 条）、compress 调用本身 | **保留（落进打包规则）** | 打包绝不能吞掉"用户最后的意图"和"最近正在干的事" |
| 多级蒸馏 T1→T2→T3（摘要再摘要，保持有界） | **保留（落进打包格式）** | 包本身要能再蒸一次：第一次带全，第二次只留骨架，保证新会话接得上又不太占地方 |
| 可搜索：压缩后仍能 `search_context` 搜到块内信息 | **保留（换成"落盘归档 + grep"）** | DSH 里不搞内存块，直接把被压缩前的全文写到一个文件，包只写"详见 <路径>"，需要时 `grep`/`read` |
| 8 阶段管线拦截每次 context 事件、`acp_delegate` 子代理、acp-kernel 引擎 | **丢弃** | 与 DSH 内建 `dsh-compaction-basic` 职责重叠，硬接管只会互相覆盖。子代理 DSH 已有 `subagent` |
| 每轮把压缩指导注入系统提示 | **丢弃（关键！见铁律 1）** | 在 DSH 里逐轮改系统提示 = 前缀缓存每次失效，反而更费 token |

**蒸馏产物**：一套**交接包模板**（8 段结构 + 逐字保留清单 + 多级蒸馏），打包时用一次模型调用生成，全文另存归档。

---

## 四、三条设计铁律（决定"省不省 token"和"会不会帮倒忙"）

**铁律 1：动态数字绝不写进系统提示。**
DSH 的系统提示在请求最前面。往里塞"当前占用 73%"这种每轮都变的数字，等于每轮让整段前缀缓存失效，下一轮全价重算——省的那点不如亏的多。（这条和 mnemon 热记忆"写一次就废缓存"是同一个坑。）
→ 做法：系统提示里只放**静态**一句"接近上限就收尾交接"，**具体百分比只走 UI 徽章 / `/context-watch` 命令 / 提醒**，不进模型输入。

**铁律 2：只读不写模型的思考与输入。**
Guard 只读 `tokenMeter` 与投影，不改任何请求内容。打包是**用户点一下**才发生的一次独立摘要请求（`purpose: compaction`），不改当前这轮对话。

**铁律 3：默认只提醒，不自动开新会话。**
"自动开新会话"是不可逆、且会打断用户的操作，默认必须关。做成"提醒 + 一键打包 + 一键跳新会话"，自动档要显式打开。

---

## 五、新功能 A：Context Budget Guard（上下文预算看护）

- **数据源**：`ctx.tokenMeter.measure(session)`（无模型调用、纯计算）+ 会话投影 `contextPressure` / `contextBreakdown`。
- **触发点**：`agent/pre-step` 监听（与 `dsh-compaction-basic` 同一处检查压力，保证时机一致），外加 `/context-watch` 命令按需查。
- **算三个数**：
  1. `occupancy = projectedTokens / contextWindow`（现在离满还有多远）
  2. `slope`（最近 K 次请求的平均增量，判断"涨得快不快"）
  3. `lastReclaim`（最近一次 `compaction/summary` / `prune` 回收了多少）
- **分级（阈值可配，默认给保守值）**：

| 档 | 占用 | 动作 |
|---|---|---|
| 绿 | < 50% | 不打扰 |
| 黄 | 50%–65% | 提醒一次："上下文约 X%，还能撑约 N 轮；要开新话题可以先 `/handoff` 打包" |
| 橙 | 65%–80% | 强提醒，附一句"建议现在收尾/开新会话"，并把 `/handoff` 摆在显眼处 |
| 红 | ≥ 80%（或斜率超阈值） | 提示"再往下 DSH 会自动压缩旧内容"，建议立即 `/handoff` |

> 阈值（默认 50 / 65 / 80）由奥利巴 2026-10-30 定：比原来的 60/75/85 更早提醒。为什么红档要早于 DSH 自动压缩：`dsh-compaction-basic` 默认在 `floor(min(W×0.8, W−O−B))` 就自动压缩（`B=65536`），也就是说它**会先于用户**动手、悄悄把旧内容换成摘要。Guard 要抢在它前面，让用户有机会"干净地交接"而不是"被压缩后接着用"。

- **提醒怎么呈现（分级，越轻越好）**：
  - v1：`/context-watch` 命令的文本结果 + 徽章（client 侧，复用 v2 已规划的 `conversation.chat.reasoning.body` 插槽附近）。
  - 不做每条消息弹窗、不打断输入。

---

## 六、新功能 B：Handoff Packager（交接包，`/handoff`）

用户输入 `/handoff`（或从提醒里点），执行：

1. **选材**：从当前会话取"要带走的东西"（近期尾段逐字保留；更早的按模板压缩）。
2. **一次蒸馏**（1 次模型调用，`purpose: compaction`，不产生对话轮次）：
   用融合模板生成结构化交接包（见下）。
3. **落盘**：被压缩前的全文 + 摘要一起写到
   `H:\Deepseekstudio\workspace2\dsh-context-keeper\handoff\<日期>-<会话id>.md`（可换目录，配置项）。
4. **回一个可粘贴块**：命令结果里给出简短"续接提示"，用户开新会话粘一句"继续，详见 <路径>"即可。
5. **可选即时减压**：顺手调用一次 `compactNow(agent, signal)` 当场压缩当前会话（`dsh-compaction-basic` 提供的引擎接口），让当前会话还能继续用。

**交接包模板（融合 DSH compaction 指令 + billion-context 保真规则）**

```markdown
# 交接包 · <项目/话题>

## 1. 要做的事（Primary Request and Intent）
- [原始目标 + 后来怎么变化的；关键措辞逐字引]

## 2. 关键技术概念（Key Technical Concepts）
- [技术栈 / 框架 / 约定]

## 3. 文件与代码（Files and Code）
- [精确路径：为什么重要、改了哪几处；关键代码/签名逐字]

## 4. 错误与修复（Errors and Fixes）
- [错误原串：怎么解决的；用户的反馈/纠正]

## 5. 未完成的活（Pending Jobs）
- [明确要求但还没做完的]

## 6. 当前进行到哪（Current Work）
- [此刻正在做的]

## 7. 下一步（Next Step）
- [最贴合最近请求的、单一动作；没有就写 none]

## 8. 关键上下文（Critical Context）
- [决策与理由、约束、偏好、悬而未决的问题、继续所需的资料]

## 9. 全文归档（Archive）
- 完整原始内容见：<落盘绝对路径>
- 需要查细节用：`grep -n "<关键词>" <路径>`
```

**硬规则（写进 prompt）**：
- 逐字保留：文件路径、命令、错误串、标识符、数值、函数签名、语法片段。
- 必留：最后一条用户消息的意图；最近工作集；用户明确纠正过的地方。
- 丢弃：冗长日志、重复内容、已经消费掉的探索。
- 若已有 `<compacted-summary>` 旧包：不要照抄，保留仍为真的、丢掉过期的、把新信息并进去（多级蒸馏）。
- 只输出包本身，不调用任何工具、不寒暄。

---

## 七、"自动开新会话"的可行性边界（先说清楚，不吹）

- **能确认的**：`dsh-api-session-controller` 提供 `session.create`（建新会话，返回会话对象）与 `session/prompt`（向会话提交 prompt）；`dsh-command-compact` 演示了"命令 → 直接作用 agent、不产生模型消息"的范式；`dsh-commands` 提供 `ctx.commands.register()`。
- **待核实/偏 client 的**：`session.create` / `session.prompt` 属 **Remote（Web/Client）API**，宿主侧插件不一定能直接调。因此：
  - **P1（宿主侧就能做）**：Guard + `/handoff` 打包 + 归档 + 可选 `compactNow`。用户手动"新建会话→粘贴"。
  - **P2（client 侧要做）**：徽章提醒 + 提醒里的"开新会话"按钮（走 `session.create` + `session.prompt`，把交接包当首条消息）。
  - **P3（全自动，默认关）**：橙/红档自动 create+prompt 新会话。必须显式开启，且要处理"当前会话还有未完成轮次"的就绪判断。

> 结论：**"自动开新会话"不是 P1 能不能写的问题，而是它天生属于 client 侧动作**。宿主插件无法凭空拉起一个新对话窗口。这点必须先讲明，免得做出来发现够不着。

---

## 八、接口映射（都带证据来源，不是猜的）

| 能力 | 接口 | 证据 |
|---|---|---|
| 读占用/构成 | `ctx.tokenMeter.measure(session)`；投影 `contextPressure`（pressureTokens/projectedTokens/contextWindow）、`contextBreakdown`（system/tools/message） | `dsh-token-meter` README《Measuring pressure》《Session projections》 |
| 每步检查压力 | `agent/pre-step` 监听 | `dsh-compaction-basic` README 明确"a serial `agent/pre-step` listener checks pressure" |
| 事件（压缩/裁剪） | 会话事件 `compaction/summary`、`compaction/prune`，带 `shadowedSeqs` 长度 | `dsh-context` 源码 `case "compaction/summary" / "compaction/prune"`（`lib/index.js:1485`） |
| 立即压缩当前会话 | `compactNow(agent, signal)`（CompactionEngine 接口） | `dsh-command-compact` README《Design philosophy》 |
| 结构化摘要模板 | compaction 指令（8 段结构） | `dsh-compaction-basic` README《Compaction instruction》提示词全文 |
| 注册斜杠命令 | `ctx.commands.register({name, description, input, handler})` | `dsh-commands` README《Registering a command》 |
| 建新会话/发消息 | `session.create` / `session.prompt`（Remote） | `dsh-api-session-controller` README 第 44 行等 |
| 静态规则段落 | `ctx.systemPrompt.section({name, order, interpolate:false, text})` | v2 已用，`plugin/index.mjs` |

---

## 九、分阶段实现与验收

| 阶段 | 内容 | 归属 | 验收 | 预计 |
|---|---|---|---|---|
| **P1** | Context Budget Guard（读 tokenMeter，算占用/斜率/回收）+ `/context-watch` 命令 + 静态提示补一句"近上限就收尾" | 宿主 | 任一会话 `/context-watch` 能报出占用%、斜率、上次压缩回收；数字与 `dsh-context` 显示一致 | 小 |
| **P2** | `/handoff` 交接包：一次蒸馏 + 归档落盘 + 命令回可粘贴块 + 可选 `compactNow` | 宿主 | `/handoff` 生成包 ≤ 约定字数、含 9 段、归档文件可在磁盘找到、`grep` 能命中关键词 | 中 |
| **P3** | 徽章 + 提醒 + "开新会话"按钮（client） | client | 进橙档出现提醒；点按钮建新会话且首条=交接包 | 中 |
| **P4** | 全自动新会话（默认关，显式开） | client | 仅开关打开才触发；当前轮次未就绪时安全跳过并记录 | 中 |

**P3 进度（2026-10-30）**：**P3 基本完成**。
- **色块徽章**挂在 `conversation.chat.turnTail`（每轮回复末尾，与 cost-meter 用量条同位）：绿/黄/橙/红用颜色点表示，文字只留百分比，橙档起加"建议交接/该交接了"，悬停给完整一句。
- **提醒气泡 +「开新会话」按钮**挂在 `conversation.composer.dock`（输入框下沿），**仅橙/红档出现**：按钮走客户端 Remote `session.create` + `session.prompt`，在同一 cwd 新建会话并自动投喂"去读 `.context-keeper/handoff/` 最新包接着做"。新会话是完整 agent，自己读包，按钮不内联正文（不重复烧 token）。
- **两条诚实的边界**（已核源码）：① 插槽 API 没有导航，"新建后自动切过去"做不到，需用户在左侧点开新会话——面板文案如实告知；② 命令名受 `^[a-z][a-z0-9_-]*$` 约束、第三方菜单只显示命令名（无独立显示 `label`），故 `Handoff`/`Context-Watch` 的 Title Case **在公开接口上做不了**，不是没做。既然名字美化不了，可读性就放到**菜单里那行中文说明**上：`/context-watch`、`/handoff` 的 description 已改为中文。
- 未做/未验：真机装包 + 重启验证；`session.create` 的 `cwd` 语义是否与 app 内"新建会话"完全一致，只能真机确认。

先做 P1+P2，两天内可验证"看得见 + 带得走"，再决定 P3/P4 投不投入。

---

## 十、token 账（每一项都要能算清）

| 动作 | 模型调用 | 说明 |
|---|---|---|
| Guard 检查占用 | 0 | `tokenMeter.measure` 纯重放计算，无模型调用 |
| `/context-watch` 查询 | 0 | 读投影 |
| `/handoff` 打包 | **1 次** | 独立摘要请求，`purpose: compaction`，输出受 `maxTokens` 限 |
| 即时 `compactNow` | **1 次** | 同一次若同时打包可复用，不重复花 |
| 提醒/徽章 | 0 | 不进模型输入 |
| **反例（禁止）**：把动态占用%写进系统提示 | 每轮全价 | 前缀缓存失效，越用越贵 |

---

## 十一、风险与回滚

| 风险 | 处置 |
|---|---|
| DSH 版本变化导致 `tokenMeter` / `compactNow` 接口改名 | 启动时探测；缺失则 Guard 降级为"只读离线 CLI"，绝不崩 |
| 把动态数字塞进系统提示导致缓存失效 | 铁律 1 硬编码禁止；`maxChars` 截断；单测断言规则文本里不含运行时数字 |
| 自动开新会话误触发 | 默认关；橙/红档才触发；未就绪安全跳过；记录 `session/create` 失败 |
| 打包摘要丢关键信息 | 模板强制 9 段 + 逐字保留清单；归档全文兜底；`grep` 可回查 |
| 与 `dsh-context` / `dsh-compaction-basic` 职责打架 | 只读不接管：不注册 context 事件拦截、不改 compaction 行为，只在旁边"看"和"按需打包" |

回滚：`cordis.patch.yml` 里 `- id: context-keeper` 加 `disabled: true`，或把 `guard` / `handoff` 子项配置置 `false`。

---

## 十二、待奥利巴拍板

1. **默认档位**：Guard 默认"只提醒不自动"（推荐）／"提醒+一键打包"／"到档自动打包"？
2. **红档阈值**：80%（推荐，抢在 DSH 自动压缩前）／更低 75%？
3. **先做哪几步**：P1+P2（宿主侧先跑通，推荐）／直接连 P3 client 徽章一起？
4. **交接包落盘目录**：默认 `dsh-context-keeper\handoff\`，还是放你某个固定目录？
5. **要不要同步进 `dsh-context`**：还是保持独立插件、各管一摊（推荐独立，免得跟已装插件耦合）？
