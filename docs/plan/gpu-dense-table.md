# 方案一：GPU 密集表格 — 最终完整版

> 状态：最终完整方案（定稿）｜ 归属：`docs/plan/gpu-dense-table.md` ｜ 优先级：P0
> 关键词：密集大表 / 行下双行展开 / 服务器合并·打散 / 浅底色区分 / 0-100 跑分 / 仅成功 p5/p95 归一 / 7 天窗口直接删盘 / 列自定义 / 多列排序 / 任意线拖动行距列距 + 记忆 / 进程指令换行完整

---

## 1. 总览与设计哲学

### 1.1 一句话定位
平时即**完整密集大表**（一屏塞最多行列、信息密度优先），点击任意行在**该行正下方插入两行展开区**做细节下钻，**不跳页、不弹窗、不抽屉**，表不离眼、上下文不丢。

### 1.2 核心矛盾与取舍
- 密度 vs 可读：默认高密度，靠**行距/列距任意拖动 + 全局滑杆**让用户自行 trade-off，且**记住布局**。
- 总览 vs 细节：总览常驻表内，细节按需插入展开区，**一次只展开一行**（点击同行收起，点击他行切换）。
- 美观 vs 可区分：服务器区分用**浅底色**（饱和度 <15%），不遮字、不伤眼，不用深色块。

### 1.3 方案边界
- 本方案 = 方案一（密集表格方向）最终完整版，后续实现严格按本文执行，不增需求、不减特性。
- 仅支持**一周窗口**（7 天），不做多窗口切换；删盘即 `unlink` 删文件 + 内存删记录。
- 评分仅统计**成功**任务，失败/取消不入分。

---

## 2. 信息架构与表格形态

### 2.1 表格 = 平时即完整大表
- 首屏即全量表头 + 全量行，无折叠、无分页默认截断（分页仅作为兜底，默认 100 行/页，可切 50/100/200）。
- 列宽默认紧凑（按内容自适应 + 最小 60px），`table-layout: fixed` 保证拖动可控。
- 行高默认 30px，支持 24–48px 区间拖动（见 §7）。
- 表头吸顶（`position: sticky; top: 0`），横向滚动时首列（任务名/ID）可选冻结。
- 空状态、加载态、错误态均在表区内就地展示，不覆层。

### 2.2 默认列清单（可自定义，见 §6）
| 列 | 含义 | 默认可见 | 排序 | 筛选 |
|---|---|---|---|---|
| 任务名 / ID | `name` + 短 ID 尾缀 | ✅ | 文本 | 关键字 |
| 服务器 | `serverId` / `serverName` | ✅ | 枚举 | 多选 |
| GPU | `gpuId` / 型号简写 | ✅ | 数值 | 多选 |
| 状态 | 成功/失败/运行中/排队/取消 | ✅ | 枚举 | 多选 |
| 评分 0-100 | 跑得快=高分，p5/p95 归一（§4） | ✅ | 数值 | 区间 |
| 时长 | `duration` | ✅ | 数值 | 区间 |
| 开始时间 | `startedAt` | ✅ | 时间 | 区间 |
| 结束时间 | `finishedAt` | ✅ | 时间 | 区间 |
| 进程数 | 展开区进程条数 | ✅ | 数值 | — |
| 操作 | 删盘 / 详情锚点 | ✅ | — | — |
| （可扩展）队列等待 | `queuedDuration` | ◻️ | 数值 | 区间 |
| （可扩展）提交人 | `owner` | ◻️ | 文本 | 多选 |
| （可扩展）项目/标签 | `tags` | ◻️ | 文本 | 多选 |

> 列顺序可拖动表头重排（HTML5 DnD），宽度可拖动竖线调整，均持久化。

---

## 3. 行点击展开：下方插入两行展开区

### 3.1 交互规则
- 点击任意数据行 → 在**该行正下方插入 2 行展开区**（`tr.expand-row-1` + `tr.expand-row-2`），两行各 `colspan=全部列数`，撑满表宽。
- 再次点击同一行 → 收起；点击另一行 → 收起旧行、展开新行（单开互斥）。
- 展开区不参与排序/筛选/分页计数；打印/导出时默认不含展开区（可选项）。
- 键盘：`Enter` 展开/收起，`Esc` 收起，`↑/↓` 切行。
- 动画：`height 0→auto` 120ms ease-out，不阻塞表滚动；展开后自动 `scrollIntoView({block:"nearest"})`。

### 3.2 展开第一行：1 天曲线（最近 3h 放大）
- 内容：该任务关联 GPU/指标的**近 1 天时序曲线**（默认 `gpuUtil` + `memUtil` 双线，可切 `temp/power`）。
- X 轴：过去 24h，刻度按 6h 均分；**最近 3h 区间视觉放大**（非线性拉伸 1.6× 或右侧子图联动，两案择一，默认子图联动更清晰）。
  - 方案 A（推荐）：主图 0–24h + 右下角 inset 小图放最近 3h（同数据，X 域 `[now-3h, now]`，Y 自适应）。
  - 方案 B：X 轴分段比例尺，前 21h 占 60% 宽度，后 3h 占 40% 宽度，中间以虚线分隔并标注“近 3h 放大”。
- Y 轴：0–100%（利用率）或自适应；Tooltip 显示精确值 + 时间戳。
- 数据：前端按 `taskId + gpuId + range=24h` 拉取，缺点补 `null` 断线，加载骨架屏。
- 交互：悬停十字线、图例点击显隐、双击重置缩放。

### 3.3 展开第二行：进程列表（换行完整）
- 内容：该任务在该 GPU/节点上的**全部进程快照**列表。
- 字段：`PID` | `GPU` | `显存` | `用户` | `原始指令 CMD`（重点）| `启动时间` | `状态`。
- **进程原始指令换行完整显示不截断**（§8 详述）：
  - `CMD` 列 `white-space: pre-wrap; word-break: break-all; overflow-wrap: anywhere`，不 `ellipsis`、不限 `max-height`。
  - 每行进程为 `div.process-row`，CMD 独占一行或与元信息分两行排布，保证长指令完整换行可见。
  - 提供“复制指令”按钮（`navigator.clipboard.writeText`），复制完整原文（含换行/空格）。
- 进程行悬停高亮，支持按显存/启动时间排序（小表头）。
- 为空时显示“暂无进程快照”而非空白。

### 3.4 展开区视觉
- 展开区两行左侧加 3px 主题色边框（`border-left: 3px solid var(--accent)`），背景 `var(--bg-subtle)` 区分数据行。
- 展开区不设底色遮字，与 §4 浅底色叠加时取**最浅叠加**（`mix-blend` 或直接取展开区底色优先）。

---

## 4. 服务器合并/打散双模式 + 浅底色按服务器区分

### 4.1 双模式定义
- **合并模式（Grouped）**：按 `serverId` 分组，组头行（`tr.group-header`）置顶该组，组头显示 `服务器名 (N 行) | 均分 | 均时长 | 展开/收起组`，组内行按当前排序二次排。
- **打散模式（Flat）**：所有行平铺，按全局排序，不分组。
- 切换器：表工具栏 `SegmentedControl`（合并 | 打散），默认**合并**，状态持久化到 `localStorage`。
- 分组聚合：组头右侧显示组内**平均评分/中位数时长**（仅成功样本），便于横向对比服务器。

### 4.2 浅底色按服务器区分
- 每个 `serverId` 分配一种**浅底色**（HSL 固定色相、S 12–18%、L 96–98%），**不遮字**（前景文字保持 `var(--text-primary)`，对比度 ≥ 4.5:1）。
- 调色板预置 12 色（`#f8f9ff` `#fff8f8` `#f6fff8` `#fffbf0` `#f8f6ff` `#f0fbff` …），超 12 台时 HSL 环绕生成（`hue = hash(serverId) % 360`）。
- 同服务器的所有数据行（含组头）在两种模式下均涂该浅色；打散模式下靠底色即可一眼归属。
- 辅助区分：除底色外，行首 2px 竖线取对应色相的 40% 饱和度深 1 档，避免纯依赖颜色（色盲友好）。
- 打印时浅底色可保留（`-webkit-print-color-adjust: exact`）。

---

## 5. 评分 0-100（跑得快=高分，p5/p95 归一，仅成功，7 天窗口直接删盘，仅一周）

### 5.1 评分口径
- 对象：**仅成功的任务**（`status === 'success'`）；失败/取消/运行中**不计分**，表内显示 `—`。
- 指标：以**时长 `duration` 越短越好**为唯一因子（跑得快=高分）。如有 `throughput` 可扩展为 `score = w1*durationScore + w2*throughputScore`，但本版**仅 duration**。
- 归一：对全量成功样本的 `duration` 取 **p5 / p95** 为归一边界，线性映射到 100→0（快→高分）：
  ```
  p5  = percentile(duration, 5)   // 最快 5% 分位，近最小值但抗异常
  p95 = percentile(duration, 95)  // 最慢 5% 分位，抗长尾
  clamped = clamp(duration, p5, p95)
  score = 100 * (1 - (clamped - p5) / (p95 - p5))   // p5→100, p95→0
  score = round(score)  // 0–100 整数
  ```
- 边界：
  - 若 `p95 === p5`（样本无方差）→ 全部 100 分。
  - 样本数 < 20 时仍计算，但 Tooltip 提示“样本较少，分数仅供参考”。
  - 新任务落库即重算该任务分数；全表分数随窗口滑动每日重算一次（增量）。

### 5.2 7 天窗口与直接删盘
- **仅一周窗口**：查询与评分均在 `now - 7d` 窗口内；窗口外数据**不在表内出现**，亦不参与 p5/p95。
- **直接删盘**：用户在行操作点“删除” → 二次确认（`Modal.confirm` 文案：`将直接删除磁盘文件与内存记录，不可恢复`）→ 执行：
  1. 后端 `fs.unlink(taskFilePath)` 删文件（不存在则视为已删，仍继续）；
  2. 内存 `taskStore.delete(taskId)` + `gpuHistory.delete(taskId)` 删记录；
  3. 前端乐观移除该行，若后端失败则回滚并 toast。
- 批量删：表头勾选 + 工具栏“批量删盘”，同为逐个 `unlink` + 原子内存删除，失败项汇总提示。
- 审计：删盘操作写 `audit.log`（`who/when/ids`），便于追溯。
- 定时清理：`cron 02:00` 扫描 `finishedAt < now-7d` 的残留文件，同样 `unlink + 删记录`，保证窗口严格 7 天。

### 5.3 展示
- 分数列用**胶囊徽章** + 底色渐变（0 红→50 黄→100 绿，浅色徽章不遮字），Tooltip 显示 `duration / p5 / p95 / 样本数`。
- 支持按分数排序/区间筛选（`[60,100]` 等）。

---

## 6. 可自定义列（齿轮在表头右上角）+ 多列排序

### 6.1 齿轮入口
- 位置：**表头右上角**（`th:last-child` 右侧或表工具栏最右），`IconButton` 齿轮图标（`Settings`），`aria-label="自定义列"`。
- 点击弹出 `Popover`（宽 320px）：
  - 顶部“列展示”：全部列的 `Checkbox` 列表，拖动手柄可重排顺序；
  - 中部“固定列”：勾选首列冻结；
  - 底部“重置默认 / 确认”；
  - 实时预览（勾选即表内显隐，无需确认才生效；提供“取消”回滚）。
- 状态持久化：`localStorage['gpu-dense-table:columns'] = { order, visible, pinned }`，按用户维度。

### 6.2 多列排序
- 交互：
  - 单击表头 → 单列排序（`asc → desc → none` 循环）；
  - `Shift + 单击` 或 `Cmd/Ctrl + 单击` → 追加为第二/三排序键；
  - 已排序列头显示序号徽章 `1` `2` `3` + 升降箭头；
  - 表头 tooltip 显示当前排序栈（如 `1. 评分 ↓  2. 时长 ↑`）。
- 排序栈 UI：表工具栏显示 `SortChips`（`评分 ↓ ×` `时长 ↑ ×`），可拖动重排优先级、点击翻转方向、`×` 移除，清空即无排序（回落库序）。
- 规则：
  - 最多 3 级排序（超限 toast 提示）；
  - 数值/时间/文本各自比较器，`null/—` 沉底；
  - 排序为前端本地排序（数据已全量拉取），合并模式下组内二次排、组间按组头聚合值排。
- 持久化：`localStorage['gpu-dense-table:sorts']`。

---

## 7. 任意线拖动行距列距 + 全局滑杆且记住布局

### 7.1 拖动能力
- **列距（列宽）**：表头每根**竖线**为拖动手柄（`cursor: col-resize`，热点 8px），拖动改该列 `width`，范围 **60–400px**，双击竖线自适应内容宽度（`autoFit`）。
- **行距（行高）**：每行**底横线**为拖动手柄（`cursor: row-resize`，热点 6px），拖动改**全表行高**（统一行高，保证密度一致），范围 **24–48px**，双击横线重置 30px。
- 拖动时表头/行实时跟随（`requestAnimationFrame` 节流），松手落盘。

### 7.2 全局滑杆
- 工具栏提供两根滑杆：
  - `列距`：`Slider 60–400px`（实际控制“基准列宽”或“当前选中列宽”，默认前者；选中某列时滑杆联动该列）。
  - `行距`：`Slider 24–48px`（控制全表 `rowHeight`）。
- 滑杆与拖动**双向绑定**：拖线即改滑杆值，拨滑杆即改表布局，无割裂。
- 提供“重置布局”按钮，一键回 `rowHeight=30, colWidths=auto`。

### 7.3 记住布局
- 存储：`localStorage['gpu-dense-table:layout'] = { rowHeight, colWidths: Record<colKey, px>, colOrder, sorts, grouping, columns }`。
- 作用域：按 `userId` 隔离（如无用户则按浏览器维度）；导入/导出配置（JSON 拷贝）便于同组同步。
- 首次加载无缓存时用默认值；缓存损坏时回退默认并 `console.warn`。
- 响应式：窗口宽度 < 1280px 时列宽按比例压缩但不低于 60px，横向滚动兜底。

---

## 8. 进程原始指令换行完整显示不截断

### 8.1 展示规则（强约束）
- 进程 `CMD` **永不截断、永不省略号、永不 `max-height` 裁剪**，必须**换行完整显示**。
- 样式：
  ```css
  .process-cmd {
    white-space: pre-wrap;      /* 保留空格/换行，原样展示 */
    word-break: break-word;
    overflow-wrap: anywhere;    /* 长 token 可断 */
    line-break: anywhere;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 12px;
    line-height: 1.6;
    background: var(--bg-code);
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid var(--border-subtle);
  }
  ```
- 布局：进程列表每行 `display: grid; grid-template-columns: 90px 80px 1fr;` 或 CMD 独占整行（`grid-column: 1 / -1`），保证 CMD 有最大可用宽度。
- 长指令（> 500 字符）仍完整渲染，不做“展开更多”折叠；若担心极长指令撑爆视口，允许**纵向滚动容器**但**不横向截断**（`max-height: 50vh; overflow-y: auto` 包在展开区第二行内）。

### 8.2 交互增强
- 行首提供“复制”按钮，复制 CMD 全文；复制成功 `toast`。
- CMD 中可点击的路径/参数不高亮，避免误判；如需高亮则仅下划线虚线，不改原文。
- 支持 `Ctrl+F` 浏览器内搜索直达（因未截断，天然可搜）。

### 8.3 数据侧
- 后端 `process.cmd` 原样存储，不做 `truncate`；前端不做 `slice`。
- 若 `cmd` 为空则显示 `—` + 灰字提示“未采集到指令”。

---

## 9. 数据模型与接口

### 9.1 前端类型（TypeScript）
```ts
type GpuTaskRow = {
  id: string;
  name: string;
  serverId: string;
  serverName: string;
  gpuId: string;
  status: 'success' | 'failed' | 'running' | 'queued' | 'cancelled';
  duration: number; // ms
  startedAt: string; // ISO
  finishedAt: string;
  score: number | null; // 0-100，仅 success 有值
  processCount: number;
};

type GpuHistoryPoint = { t: string; gpuUtil: number; memUtil: number; temp?: number };
type ProcessSnapshot = { pid: number; gpuId: string; vram: string; user: string; cmd: string; startedAt: string; status: string };

type TableLayout = {
  rowHeight: number; // 24-48
  colWidths: Record<string, number>; // 60-400
  colOrder: string[];
  visibleCols: string[];
  sorts: Array<{ key: string; dir: 'asc'|'desc' }>;
  grouping: 'grouped' | 'flat';
};
```

### 9.2 接口
```
GET  /api/gpu-tasks?range=7d&serverIds=&status=&sort=&order=
GET  /api/gpu-tasks/:id/history?range=24h&metrics=gpuUtil,memUtil
GET  /api/gpu-tasks/:id/processes
DELETE /api/gpu-tasks/:id          // 单删：unlink + 内存删
POST /api/gpu-tasks/batch-delete   // 批量：{ ids: string[] }
GET  /api/gpu-tasks/scores         // 可选：服务端算分后下发，或前端自算
```

### 9.3 存储
- 任务文件：`data/gpu-tasks/<id>.json`（或既有 `simple_cluster` 落盘），删盘即 `unlink`。
- 内存：`Map<id, GpuTaskRow>` + `Map<id, GpuHistoryPoint[]>`，删盘同步删。
- 布局：`localStorage`，键名 `gpu-dense-table:*`。

---

## 10. 前端实现要点

- 组件：`GpuDenseTable.tsx`（主表）+ `ExpandCurveRow.tsx`（展开行1）+ `ExpandProcessRow.tsx`（展开行2）+ `ColumnCustomizer.tsx`（齿轮）+ `LayoutSliders.tsx`（滑杆）。
- 表格：`@tanstack/react-table` 或自研 `table-layout:fixed` + 虚拟滚动（`@tanstack/react-virtual`，行数 > 300 时启用）。
- 曲线：`recharts` 或 `echart` 轻量封装，inset 小图用同一数据源双实例。
- 拖动：表头竖线 `onPointerDown` + `setPointerCapture` + 全局 `pointermove/up`，列宽写 `colWidths`；行底横线同理改 `rowHeight`。
- 浅底色：`getServerTint(serverId)` → `hsl(...)`，行 `style={{ background: tint }}`。
- 评分：前端 `computeScores(rows)`（p5/p95）或复用后端 `scores` 字段，以前端为准便于窗口一致。
- 进程 CMD：`pre-wrap` + `overflow-wrap:anywhere`，禁止 `text-overflow:ellipsis`。

---

## 11. 验收标准（Manual Acceptance）

- [ ] 默认即密集大表，首屏 ≥ 20 行可见（1080p）。
- [ ] 点击行下方插入两行展开区：第一行 1 天曲线含最近 3h 放大（inset 或分段拉伸），第二行进程列表 CMD 换行完整不截断。
- [ ] 合并/打散双模式可切，浅底色按服务器区分（每服一种浅色，不遮字，对比度达标）。
- [ ] 评分 0-100 跑得快=高分，p5/p95 归一，仅成功样本，7 天窗口；删盘为 `unlink + 内存删`，仅一周窗口可验。
- [ ] 齿轮在表头右上角，可勾选/重排/显隐列；多列排序（≤3 级，序号徽章 + SortChips）。
- [ ] 任意竖线拖列宽 60-400px，任意横线拖行高 24-48px，全局滑杆双向绑定，刷新后记住布局。
- [ ] 进程原始指令 `pre-wrap` 完整换行，`rg "text-overflow: ellipsis" src/**/GpuDenseTable*` 零命中 CMD 列。
- [ ] 批量删盘、二次确认、审计日志、定时 7 天清理均可验。
- [ ] `npm run build` + `vm.Script` 双门禁通过，无 P0 模板剥离坑。

---

## 12. 风险与约束

- P0 模板剥离坑：若涉及 `PanelHtml.ts` 外层模板，内层正则/字符串的 `\` 必须双写 `\\`。
- 浅底色需做色盲/对比度校验，避免仅靠颜色区分（已加竖线辅助）。
- 进程 CMD 极长（> 10KB）时注意虚拟滚动与滚动容器性能，必要时对 CMD 做**视觉**软换行而非截断。
- 7 天窗口删盘不可逆，需二次确认 + 审计。

---

## 13. 待办列表（Todo List）— 严格按计划执行，禁止遗漏和偷懒

> 执行顺序严格按编号，单项完成即勾选，禁止跳项、合并或省略。

- [ ] TODO-01：新建分支 `feat/gpu-dense-table`，拉取最新主干并通过 `npm run build` 基线门禁
- [ ] TODO-02：定义前端类型与接口契约（`GpuTaskRow` / `ProcessSnapshot` / `TableLayout` / `GET /api/gpu-tasks` 等），落 `src/types` 或 `src/api`
- [ ] TODO-03：实现后端 7 天窗口查询与 p5/p95 评分（仅成功样本，`score = 100*(1-(clamp-p5)/(p95-p5))`），单元测试覆盖 `p95===p5` / 样本<20 / 空窗口
- [ ] TODO-04：实现后端直接删盘（`fs.unlink` + `taskStore.delete` + `gpuHistory.delete`，单删 + 批量 `POST /batch-delete`），补审计日志与 02:00 定时清理 `finishedAt < now-7d`
- [ ] TODO-05：实现后端 `GET /:id/history?range=24h` 与 `GET /:id/processes`（`cmd` 原样不截断），前端联调
- [ ] TODO-06：搭建 `GpuDenseTable.tsx` 大表骨架（`table-layout:fixed` / 吸顶表头 / 首列可选冻结 / 分页 100 行 / 虚拟滚动阈值 300 行）
- [ ] TODO-07：实现行点击下方插入两行展开区（单开互斥、动画、`scrollIntoView`、键盘 Enter/Esc/↑↓）
- [ ] TODO-08：实现展开第一行 1 天曲线 + 最近 3h 放大（`recharts/echarts` 双实例 inset 小图，Tooltip/图例/缺值断线）
- [ ] TODO-09：实现展开第二行进程列表，`CMD` 列 `pre-wrap + overflow-wrap:anywhere` 换行完整不截断，补“复制指令”与空态
- [ ] TODO-10：实现服务器合并/打散双模式（`SegmentedControl`，Grouped 组头聚合均分/均时长，Flat 全局排序），状态持久化
- [ ] TODO-11：实现浅底色按服务器区分（`getServerTint` HSL 12 色环绕，S 12-18% L 96-98%，行首 2px 竖线辅助，打印保留）
- [ ] TODO-12：实现评分列 0-100 徽章（p5/p95 Tooltip、区间筛选、排序），与后端口径对齐
- [ ] TODO-13：实现表头右上角齿轮 `ColumnCustomizer`（Popover 勾选/拖动重排/冻结首列/重置默认，`localStorage` 持久化）
- [ ] TODO-14：实现多列排序（单击单列、`Shift/Cmd+单击`追加、序号徽章、SortChips 拖动/翻转/移除，最多 3 级，持久化）
- [ ] TODO-15：实现任意线拖动（表头竖线 60-400px 列宽、行底横线 24-48px 行高，`pointerCapture + rAF`，双击自适应/重置）
- [ ] TODO-16：实现全局滑杆（`行距 24-48px` / `列距 60-400px`，与拖动双向绑定，“重置布局”一键回默认）
- [ ] TODO-17：实现布局记忆（`localStorage['gpu-dense-table:layout']` 含 `rowHeight/colWidths/colOrder/visible/grouping/sorts`，按用户隔离，损坏回退，导入/导出 JSON）
- [ ] TODO-18：补空态/加载态/错误态、批量删盘二次确认、审计提示、响应式 <1280px 列宽压缩与横向滚动兜底
- [ ] TODO-19：自测与门禁（`npm run build` + `node -c dist/**` + `vm.Script` 双校验，`rg "10890"` / `rg "ellipsis"` CMD 列零命中，人工走查 §11 验收清单全绿）
- [ ] TODO-20：更新 `docs`（本方案已落盘）与 `CHANGELOG.md`，提 PR 并附录 `文件:行号` 改动清单与验证日志，供 Review 终审

---

*— 方案一密集表格最终完整版定稿，执行以本文件为准 —*
