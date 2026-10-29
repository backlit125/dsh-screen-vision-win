# dsh-screen-vision-win

AI 连续视觉（Windows 版）：把桌屏幕面的动态变化——滚动、切窗、弹窗、焦点、内容增删、视频播放、画面运动——持续转成**带时间戳的结构化 JSON 事件流 + 自然语言摘要**，供 dsh agent 直接调用消费。

零外部依赖：纯 `node:` 内置模块 + PowerShell 调 Win32（UI Automation 取控件树，GDI+ 取画面）。不需要 npm 包、不需要原生编译、不需要额外 exe。

`dsh-screen-vision` 的 Windows 移植版。v1.1.0 的语义层/语言化层/工具层完全复用，本版把**采集层按 Windows 实际行为重写**，并修掉了 4 条采集通道在 Windows 上全断的问题（见「v1.1.1 修复清单」）。

---

## 1. 架构

```
lib/index.js      Cordis 入口：apply(ctx, config) → 注册 7 个 vision_* 工具
lib/config.js     默认值 + 合并器（patch config ← DSH_VISION_CONFIG，坏值一律钳制回落）
lib/capture.js    ★ 采集层：起 PowerShell、传参、读回 UTF-8 结果（worker / oneshot 双通道）
lib/ps/tick.ps1   ★ PowerShell 正文（纯 ASCII；一次采全：前台窗口 + UIA 树 + 截图）
lib/pixel.js      PNG 自解码（zlib + 反滤波）→ 网格采样 → 帧差 / 运动估计 / 连通域
lib/interpret.js  语义层：可见文本、控件、层级、滚动、视频、场景、字幕、隐私打码
lib/narrate.js    语言化层：结构化字段 → 自然语言摘要（模板生成，无幻觉来源）
lib/engine.js     感知循环：自适应频率、事件环、降级退避
lib/tools.js      7 个工具的宿主注册定义（完整 JSON Schema）
```

### 感知优先级与降级链

| 层级 | 通道 | 产出 | 不可用时 |
|---|---|---|---|
| L1 结构 | UI Automation（前台窗口为根） | 可见文本、控件、层级、切窗/弹窗/焦点/内容事件 | 只剩像素证据 |
| L2 画面 | GDI+ `CopyFromScreen` | 网格帧差 → 滚动/运动/视频/场景/字幕事件 | 只报结构事件 |
| L3 保底 | — | 一条 `degraded` 事件 + `vision_status` 里的原因 | 如实报告，绝不静默 |

引擎按证据强度给 `confidence`：文本锚点滚动 0.9 > 像素平移 0.55 > 仅帧差 0.6；窗口切换（前台进程名变化）0.95。

### 性能与省电

- **自适应降频**：变化期用 `minPollMs`；静默 2 帧升到 `idlePollMs`；静默超 `idleDemoteAfterMs` 降到 8s 一档，且那一档**先只看控件树指纹，指纹变了才截图**。
- **耗时自适应**：引擎读到上帧实测 `lastCaptureMs`，若接近当前节拍就自动放宽间隔——不会把「采集比间隔还慢」当成常态，也不会疯狂超时。
- **采集失败退避**：连续失败按 `minPollMs × 2^n` 指数退避（上限 30s），每 10 次重复上报一条 degraded（首次必报）。
- **常驻 worker 空闲回收**：`workerIdleMs` 不用就收掉，不监听时不留 `powershell.exe`。
- **像素不留盘**：截图读进内存即删；帧只保留 `gridX×gridY×3` 个数字，原始像素差分完即丢。

本机实测（2560×1600，150% 缩放）：

| 环节 | 耗时 |
|---|---|
| PowerShell 冷启动到 `READY`（含 Add-Type） | ~780ms |
| 单帧采集 · 常驻 worker（真机连续 6 帧实测） | 627~871ms（≈1.2~1.6fps，首帧 3.3s 含冷启） |
| 单帧采集 · 每帧新进程（oneshot） | ~1500ms |
| Node 侧 PNG 自解码（5.8MB → 16.4M 像素） | ~80ms |
| `sampleGrid` 24×11 全采 | ~30ms |
| `diffGrids` + `estimateMotion` + `clusterChanged` | ~3ms |

---

## 2. 输出 JSON 契约（vision_read）

```jsonc
{
  "ok": true,
  "timestamp": 1761...
  "source_window": "DeepSeek Harness",       // 前台进程名（不含扩展名）
  "window_title": "...",                     // 前台窗口标题
  "viewport": { "width": 2560, "height": 1600, "full": true },
  "visible_text": "…拼接后的可见文本…",
  "ui_elements": [ { "kind": "input", "text": "…", "cls": "Edit", "x":…, "y":…, "w":…, "h":…,
                     "clickable": false, "input": true, "scrollable": false } ],
  "layout_hierarchy": { "depth": 9, "containers": 41, "nodeCount": 228, "truncated": false },
  "privacy_masked": false,
  "scroll_event": { "direction": "down", "displacementPx": 86, "speedPxPerSec": 172,
                    "evidence": "text-anchor", "confidence": 0.9 },
  "video_state": { "state": "playing", "progress": 0.83, "region": { "fy1": 0.1, "fy2": 0.7 },
                   "evidence": "4/4 frames above threshold, tree stable", "captions": ["…"],
                   "confidence": 0.75 },
  "motion_summary": { "changeRatio": 0.15, "motionVector": { "dxCells": 0, "dyCells": 1, "residual": 22 },
                      "regions": [ { "label": "屏幕下部横向大半区", "fx1": 0, "fy1": 0.66, "fx2": 1, "fy2": 1 } ] },
  "attention_regions": [ { "reason": "input-focus", "note": "…" } ],
  "confidence": { "tree": 0.9, "scroll": 0.9, "video": null, "motion": 0.6 },
  "natural_language_summary": "当前前台是 DeepSeek Harness，屏幕 2560×1600px。最近的动态：…",
  "events": [ … 窗口内事件流，含时间戳与 summary … ]
}
```

## 3. AI 可调用的 7 个工具

| 工具 | 作用 |
|---|---|
| `vision_start` | 启动连续感知循环（幂等）。返回能力探测结果与诊断提示 |
| `vision_stop` | 停止循环，回收采集进程并清临时画面（幂等） |
| `vision_read` | **看一眼屏幕的统一入口**：一次调用拿完整语义快照 + 事件流 + NL 摘要。未监听时也能调（即时采一帧） |
| `vision_watch_events` | 增量拉事件（`since_ms`），「持续关注」而不必整帧重读 |
| `vision_video_status` | 视频/动画播放状态与证据 |
| `vision_status` | 引擎状态：帧数、事件水位、静默时长、连续降级次数、**所用采集通道与单帧实测耗时**、生效配置 |
| `vision_capture` | 存一张截图到磁盘供人工核查（排查兜底，不喂模型） |

推荐用法：先 `vision_read` 建立基线，操作后 1~3 秒 `vision_watch_events(since_ms=…)` 拉增量。

---

## 4. 安装

```bash
# 1) 放进 profile（两种都行）
#    a. tgz：拷贝到 <profile>/vendor/，package.json 加
#       "dsh-screen-vision-win": "file:./vendor/dsh-screen-vision-win-1.1.1.tgz"
#    b. link：把目录放到某处，package.json 加
#       "dsh-screen-vision-win": "link:C:/path/to/dsh-screen-vision-win"
# 2) 把包名追加进同一个 package.json 的 dsh.profile.bundles 数组：
#       "dsh-screen-vision-win"
# 3) 安装依赖并重启宿主
pnpm install                          # 在 profile 目录
# 然后结束 DeepSeek Harness.exe（宿主守护会自动拉起）
```

装载成功日志：

```
[dsh-screen-vision-win] registered 7/7 tools
[dsh-screen-vision-win] plugin loaded (Windows capture channel: PowerShell + UI Automation / GDI+)
```

配置三层覆盖：**内置默认（lib/config.js）← bundle patch config ← profile 的 cordis.patch.yml（按 id 覆盖）← 环境变量 `DSH_VISION_CONFIG=<json>`**。运行时生效值看 `vision_status` 的 `config` 字段；`reloadConfig()` 支持不重启循环热调。

> 三个 `name` 必须一致：patch 的 `name` = `lib/index.js` 导出的 `name` = `package.json` 的 `name` = `dsh-screen-vision-win`。

## 5. 权限、安全与隐私

- **无需管理员权限。** UI Automation 读的是当前桌面会话的无障碍信息；GDI+ 截的是当前用户屏幕。
- **执行策略。** 采集通过 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <临时脚本>` 完成。若企业策略禁用 Bypass 或禁 `Add-Type`，采集会失败——`vision_start` / `vision_status` 会如实报告原因而不是静默瞎掉。
- **进程生命周期。** 常驻 worker 在停止监听、空闲超时（`workerIdleMs`）、插件 dispose 时都会被回收；不会遗留 `powershell.exe`。
- **屏幕画面。** 默认只在内存，差分后即弃；临时 JSON/PNG 每次采帧后删除，`vision_stop` / dispose 会 `purgeWorkDir()`。只有 `vision_capture(keep=true)` 才显式落盘。
- **密码框。** UIA `Current.IsPassword` 命中的节点一律 `[MASKED]`，类名/名称含 password/secure 也兜底打码。
- **`privacyPackages`**（进程名，可含空格与连字符）：命中的前台应用只报「在场」，不采集控件树与画面。
- **`privacyRects`**（分数坐标 0~1）：落入矩形的节点文本与画面差分都以 `[MASKED]` 汇报。
- **只读。** 插件不注入输入、不点击、不滚动、不改屏幕（`a11yCanGesture: false` 如实上报）。

---

## 6. v1.1.1 修复清单（Windows）

v1.1.0 装好后不会崩，但会**一直输出 `degraded`**——四条采集通道全断，且失败被 `psEval` 的 `catch{ return "" }` 吞成空字符串，看起来「装了但瞎」。逐条：

| # | v1.1.0 的问题 | v1.1.1 的修法 |
|---|---|---|
| 1 | 一轮 tick 起 **3 个** powershell.exe（各 0.8~1.9s，合计 3~4s），`minPollMs: 500` 物理上不可能 | 一次采全（前台+UIA+截图）；再合并为**常驻 worker**，Add-Type 只热一次 |
| 2 | 截图前只 `Add-Type System.Drawing` 就引用 `[System.Windows.Forms.Screen]` → TypeNotFound 整段失败，且吐出 `{"ok":true,"data":"","w":,"h":}`：**非法 JSON 却标称成功** | 补齐 `Add-Type`；`New-Object Bitmap(w,h)` 加括号；结果必须是可解析 JSON 且 `ok===true` 才算成功 |
| 3 | `$pid = 0` 撞 PowerShell **只读自动变量** → VariableNotWritable 中断；`[json]::Escape` 在 5.1 **不存在** | 变量改名 `$winPid`；统一 `ConvertTo-Json`。此前 `package` 恒为空 ⇒ `window_switch` 永不触发 |
| 4 | UIA 从 `RootElement` 遍历：只有二十几个桌面节点（任务栏/标题/DesktopWindowXamlSource），**拿不到前台应用内部控件** | 改以 `AutomationElement::FromHandle(前台 hwnd)` 为根，桌面根仅兜底。实测前台树 228 节点、199 带文本 |
| 5 | 离屏/隐藏元素 `BoundingRectangle` 是 `Infinity`，`ConvertTo-Json` 原样输出裸 `Infinity` → Node `JSON.parse` **抛异常** → 整棵树被判「UI Automation unavailable」（真实死因，实测一次 20 处） | 所有矩形数值过 `DshNum()` 归零；另把 `$nodes.Add()` 用 `[void]` 吞掉，避免返回值污染 stdout |
| 6 | powershell.exe 非 DPI-aware：截图是逻辑像素（1707×1067），UIA 是物理像素（2560×1600），**两套坐标差缩放倍率** → 分数坐标/隐私矩形/字幕区/滚动位移全错位 | 脚本开头 `SetProcessDPIAware()`，两边统一到物理像素空间 |
| 7 | PS 5.1 重定向 stdio 走 OEM 码页（本机 936），按 utf8 读回**中文标题不可逆乱码** | 结果写 UTF-8 文件由 Node 读；worker 行内协议只传 ASCII，路径经进程参数（宽字符）传入，错误文本 base64 回传 |
| 8 | `execFileSync` **阻塞宿主 Electron 事件循环**数秒 | 全异步 `spawn` + 超时 kill；stdout/stderr 用文件描述符（受限沙箱里带管道 spawn 会 EPERM，故 oneshot 通道不依赖管道） |
| 9 | `probeCapabilities` 谎报：因缺 Add-Type 报 `a11yCanScreenshot:false/screenW:0`，又说 `a11yCanGesture:true` 而 Windows 无实现 | 据实探测并汇报所用通道与单帧耗时；`a11yCanGesture: false` |
| 10 | 工具 `parameters` 传**裸属性表**（`{include_events:{…}}`）。宿主 `register()` 只校验 output、**不编译 parameters**，于是畸形 schema 被原样投影给模型 | 一律写成完整 JSON Schema；宿主不支持 `minimum/maximum`，取值范围写进描述并在 execute 里钳制 |
| 11 | 密码打码只认 Android `EditorInfo` 类名 → Windows 密码框**从不被遮蔽** | 采 `Current.IsPassword`（+ 类名兜底），无条件打码 |
| 12 | `privacyPackages` 正则 `^[A-Za-z0-9._]+$` 不收空格 → `DeepSeek Harness`、`Premiere Pro` **都进不了隐私名单** | 改为 Unicode 字母/数字 + 空格/连字符等，保留 64 字符上限 |
| 13 | `captionTexts` 的 else 分支写成「长度 ≥ `MIN_CAPTION_FRAMES`(=1) 也收」，等于**不过滤**：`StatusView` 被当字幕报成 `caption_change` | 设 `MIN_CAPTION_CHARS = 8` 并显式排除壳层节点名 |
| 14 | 焦点靠「第一个 input 节点」猜 | 采 `Current.HasKeyboardFocus`，优先真焦点 |
| 15 | README/文案/安装路径还是 Android 的（「系统设置→无障碍→DeepSeek Harness 屏幕助手」、`profiles/web`、`DeepSeekHarness/screenshots`），patch `id/name` 与导出 `name` 也不一致 | 全部改 Windows 实态；三个 `name` 统一为 `dsh-screen-vision-win` |

---

## 7. 兼容性与功能边界

- **Windows 10/11 桌面会话**。DSH 必须跑在**有交互式桌面的会话**里：服务、计划任务、或 Session 0 里截不到屏幕。
- **远程桌面**：RDP 会话断开后屏幕不可截（GDI+ 返回黑屏或旧帧），此时结构通道仍可能有内容——`vision_status` 会显示两通道各自状态。
- **主屏 only**：采 `Screen.PrimaryScreen`。多屏要扩 `tick.ps1` 逐屏遍历（`AllScreens`）。
- **受保护内容**：DRM 视频、部分安全输入框、`SetWindowDisplayAffinity` 的窗口会截成黑/空。这类情形帧差报 0 变化，属预期。
- **游戏 / Unity / D3D 全屏**：UIA 常只有一个窗口节点，控件树拿不到内部；此时像素通道是主感知源（motion/video 仍有效）。
- **浏览器/Electron**：Chromium 需开无障碍才吐细粒度树；否则只见 `Chrome_RenderWidgetHostHWND` 一类容器。**若控件树空，可 `captureMode: oneshot` 排除「UIA 桥没起来」这一路**。
- **受限执行环境**：若宿主沙箱禁管道 spawn，worker 起不来，自动回落 oneshot（帧率约减半），`vision_status` 的 `captureVia` 与 `workerError` 会写明原因。想固定单进程设 `captureMode: oneshot`。
- **不支持**：点击/滚动等注入式手势（`a11yCanGesture: false`）、跨屏拼接、后台窗口内容（只读前台）。

## 8. 验收用例

`node test/run.mjs` 跑纯逻辑 + 契约自检（无需真屏幕）；带屏幕的用例用下面的手工清单。

| 用例 | 操作 | 期望 | 本机实测 |
|---|---|---|---|
| U1 静态读取 | `vision_read` | `ok=true`，source_window/viewport/visible_text/ui_elements/layout 齐全，中文不乱码 | ✅ 2560×1600，标题中文正确 |
| U2 能力探测 | `vision_start` | `a11yRunning/a11yCanScreenshot=true`，`screenW/H` 为物理像素，`captureVia` 如实 | ✅ oneshot ~1500ms；worker 627~871ms |
| U3 窗口切换 | 切到别的应用 | `window_switch`（from→to，confidence 0.95） | ✅ DeepSeek Harness → AgentHub |
| U4 画面运动 | 播放视频 / 滚动 | `motion`/`scroll`/`scene_change` + 区域标签 | ✅ 「画面横向大半屏发生变化（58% 区域）」 |
| U5 内容增删 | 页面刷新/弹窗 | `content_change` added/removed texts | ✅ 新增 6 条 |
| U6 噪声不报 | 桌面壳层在场 | `StatusView` 类节点**不**产生 `caption_change` | ✅（v1.1.0 会误报） |
| U7 增量拉取 | `vision_watch_events(since_ms=T)` | 只返回 T 之后事件，`latest_timestamp` 推进 | ✅ |
| U8 降级如实 | 阻断 powershell | `degraded` 带原因，且**指数退避**不刷屏 | ✅ 单测覆盖 |
| U9 隐私 | `privacyPackages:["DeepSeek Harness"]` | 只报在场，文本空、`privacy_masked=true` | ✅ |
| U10 密码打码 | 聚焦密码框 | 该节点 `[MASKED]`，`inputFocus.password=true` | ✅ IsPassword 路径 |
| U11 省电 | 静置 30s | `consecutiveSilentTicks` 增长，节拍升档到 8s | ✅ |
| U12 幂等 | 重复 start/stop | `already_running`/`already_stopped` 如实 | ✅ |
| U13 不留进程 | `vision_stop` 后 | 无常驻 `powershell.exe`，临时画面已清 | ✅ `purgeWorkDir` |
| U14 通道开关 | `captureMode: worker` 且管道被禁 | **如实失败**（不许偷偷换通道）；`auto` 才回落 | ✅ |

## 9. 已知边界

- 帧差是 `24×11` 粗网格（给 LLM 的正确粒度），不是逐像素 mask：极小区域的变化（光标闪烁、单字符计时器）可能被平均掉。
- 滚动位移用文本锚点中位数估计；整屏文本同时变化（如换页）会被判成 `scene_change` 而非 `scroll`。
- 视频判定依赖「连续高变化 + 控件树静止」，静态画面占比高的教学视频会偏保守。
- 字幕检测按屏幕下部 `captionRegionFy` 的矩形筛文本节点；播放器把字幕渲染进画面（非 UIA 节点）时拿不到文字，只能报「有运动」。
- 单帧 `minPollMs` 下限受采集耗时约束，不是可以无限调小的旋钮。
