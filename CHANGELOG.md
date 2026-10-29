# 更新日志

## 1.1.4 —— 2026-10-29（把帧率说清楚，并让它可调）

重启到 1.1.3 后测稳态，发现**我上一版写进 README 的数字是错的**：「worker 627~871ms/帧、1.2~1.6fps」是在轻量前台窗口下测的，浏览器一类复杂窗口实测 **1.9~3.5s/帧（≈0.3fps）**。分解计时定位了原因：单帧成本几乎全在 UIA 跨进程逐节点查询（每个节点的 Name/Class/Rect/Pattern 各一次），GDI+ 截图只占 ~320ms。

- 新增 `maxTreeNodes` / `maxTreeDepth` 配置（默认 600/12 = 完整遍历）。实测同一窗口 600/12 采到 280 节点耗时 1.9~3.2s，200/8 采到 15 节点耗时 0.26~0.53s——预算可以换帧率，但会丢深层控件（浏览器正文常在 depth 8 以下），所以默认不动。
- `minPollMs` 默认 500 → **1200**，并把下限从 100 提到 300。原来的 500 是照着 Android 版写的，在 Windows 上只会让引擎每帧撞超时；引擎的 `lastCaptureMs×1.6` 自适应（v1.1.3 才真正可用）现在也会照实放宽。
- README 性能表按真机实测重写，并新增「帧率不是常数」一节说明成本构成。

## 1.1.3 —— 2026-10-29（真机接入后修掉两个自曝的问题）

装上本机 desktop profile 后，宿主里的插件自己把两个 bug 跑出来了（都是 v1.1.x 我引入的，
不是 v1.1.0 遗留）：

- **`caption_change` 把应用状态栏当成字幕**。字幕检测按屏幕下部 78%~96% 的带区筛文本节点，
  而那条带区同时也是大量应用状态栏的位置。真机 60 秒内它连报三条假字幕：
  「缓存命中 88%」「27 tok/s」「1 个子智能体运行中…」——静态页面上每次内容变化都会重复
  产生一条，事件环被噪声占满。修法：`caption_change` 改为**只在有视频证据时上报**
  （`videoState || lastVideoState`），且无视频证据时清空字幕基线，避免暂停再播时把
  旧字幕当「新字幕」补报一次。修复后同一场景 `caption_change` 为 0 条。
- **`lastCaptureMs` 测量错误**，把 ~700ms 的单帧报成 5ms。`workerPass` 里 `w.lastUse`
  在写 stdin 之前就被赋值，而 `ms` 用的是「读结果文件前」的时刻，于是只量到本地读文件的
  耗时。这个值不是摆设——引擎的自适应节拍用 `lastCaptureMs × 1.6` 放宽间隔，报小了就等于
  节拍保护失效。修法：`started` 在写 stdin 前取，`doneAt` 在收到行响应时取，
  `ms = doneAt - started`。

顺带在宿主里实测确认：`vision_stop` 能真正停住已启动的循环（帧数停止增长、`running:false`），
常驻采集进程随之回收。

新增 5 条防回归断言（`test/run.mjs` 共 **63 项**）：字幕门控、耗时测量表达式、降级退避分支、
超时参数贯穿、以及 apply 的失败隔离。全部为源码静态断言，不需要真屏幕。


## 1.1.2 —— 2026-10-29（配置面收口 + 安装本机 profile）

- `autoStart` 改走 `mergeConfig` 三层覆盖。v1.1.1 里 `index.js` 直读 raw patch config，
  所以 `DSH_VISION_CONFIG` 与 `reloadConfig()` 都改不动它，也不出现在 `vision_status` 的
  `config` 里；现在 `engine.cfg.autoStart` 生效，环境变量同样能开。
- `hotReload` 补进 `cordis.patch.yml`（此前该文件声称「全部字段见此」，实际缺这个键）。
- 日志前缀统一为 `[dsh-screen-vision-win]`（`tools.js` 里残留 3 处旧前缀，排查时会对不上）。
- `package.json` 的 `files` 加上 `test`，`npm pack` 后 `node test/run.mjs` 才真的能跑。
- 真机复测修正一处结论：常驻 worker 在真实宿主环境**可用**（此前 EPERM 是 DSH 受限沙箱
  禁管道造成的假阴性）。实测经 worker 连续 6 帧 627~871ms/帧 ≈ **1.2~1.6fps**，首帧
  3.3s 含 worker 冷启；`window_switch`/`focus`/`popup`/`content_change` 均如期产生。
- README 的耗时表已按上列真机数字校准。

## 1.1.1 —— 2026-10-29（Windows 采集层重写：可实际运行）

v1.1.0 名义上支持 Windows，实际四条采集通道全断，装好后只会持续输出 `degraded`。
本版逐条修复，并在真机（Windows 11 / 2560×1600 / 150% 缩放 / Node 24）上跑通验收。

### 修复（采集层 lib/capture.js + lib/ps/tick.ps1，全部重写）

- **截图通道**：补 `Add-Type System.Windows.Forms`（v1.1.0 只加载 Drawing 就引用
  `[System.Windows.Forms.Screen]`，TypeNotFound → 整段失败），并给出
  `{"ok":true,"data":"","w":,"h":}` 这种非法 JSON 却标称成功的结果；`New-Object
  Bitmap` 补上参数括号。现在结果必须可解析且 `ok===true` 才算成功。
- **前台窗口**：不再赋值给 PowerShell 只读自动变量 `$pid`（VariableNotWritable 会中断
  整段），不再使用 5.1 中不存在的 `[json]::Escape`。此前 `package` 恒为空 ⇒
  `window_switch` 事件从不触发。进程名改走 `OpenProcess` + `QueryFullProcessImageName`，
  不快照进程表、目标进程退出也不抛。
- **UIA 树**：改以 `AutomationElement::FromHandle(前台 hwnd)` 为根（桌面根只有二十几个
  壳层节点，拿不到前台应用内部），桌面根仅作兜底。实测前台树 228 节点、199 带文本。
- **Infinity 崩溃**（v1.1.0 真实死因）：离屏/隐藏元素的 `BoundingRectangle` X/Y 为
  `Infinity`，`ConvertTo-Json` 原样输出裸 `Infinity`，Node `JSON.parse` 抛异常，整棵树
  被误判为「UI Automation unavailable」（实测一次 20 处）。所有矩形数值改经 `DshNum()`。
- **stdout 污染**：`$nodes.Add(...)` 的返回值会一并打进 stdout（实测前面糊了一层
  `0 1 2 3 …`），现用 `[void]` 吞掉。
- **DPI 坐标错位**：脚本开头 `SetProcessDPIAware()`。此前截图是逻辑像素（1707×1067），
  UIA 矩形是物理像素（2560×1600），差一个缩放倍率，导致分数坐标、隐私矩形、字幕区域、
  滚动位移全部错位。
- **中文乱码**：结果改写入 UTF-8 文件由 Node 读取。此前 PS 5.1 的重定向 stdio 走 OEM
  码页（本机 936），窗口标题里的中文被造成不可逆替换符。worker 的行内协议只传 ASCII，
  路径经进程参数（宽字符无损）传入，错误文本 base64 回传。
- **帧率不成立**：一轮 tick 原本起 3 个 powershell.exe（实测各 0.8~1.9s，合计 3~4s），
  `minPollMs: 500` 物理上不可能。现在一次采全（前台 + UIA + 截图），并新增**常驻
  worker**（Add-Type 只热一次，实测 READY 约 780ms、单帧约 500ms）；管道不可用时自动
  回落单进程通道（约 1500ms/帧）并如实报告原因。
- **阻塞宿主**：`execFileSync` 换成异步 `spawn`（含超时 kill）——v1.1.0 会把宿主
  Electron 事件循环卡住数秒。stdout/stderr 走文件描述符，受限沙箱里带管道 spawn 会
  EPERM，因此单进程通道不依赖管道。
- **能力探测谎报**：因缺 Add-Type 报 `a11yCanScreenshot:false / screenW:0`，又称
  `a11yCanGesture:true` 而 Windows 并无实现。现据实汇报，并额外报出所用通道与单帧耗时。

### 修复（语义层与配置）

- **密码框从不被遮蔽**：v1.1.0 只匹配 Android `EditorInfo` 类名。现采集 UIA
  `Current.IsPassword` 并无条件打码（类名/名称含 password/secure 作兜底）。
- **焦点靠猜**：改采集 `Current.HasKeyboardFocus`，真焦点优先于「首个 input 节点」。
- **隐私名单形同虚设**：`privacyPackages` 正则 `^[A-Za-z0-9._]+$` 不收空格，
  `DeepSeek Harness`、`Premiere Pro` 等 Windows 进程名一律被丢弃。改为接受 Unicode
  字母/数字与空格、连字符等。
- **字幕误报**：`captionTexts` 的 else 分支写成「长度 ≥ `MIN_CAPTION_FRAMES`(=1) 也收」，
  等于不过滤，于是 `StatusView` 被当字幕报成 `caption_change`。现设 8 字符下限并显式
  排除壳层节点名。
- **控件识别全空**：`ui_elements` 的类名匹配只认 `android.widget.*`。现按 UIA
  ControlType 与 Windows 常见类名（`Edit`/`Button`/`Chrome_RenderWidgetHostHWND` 等）
  分类，并新增 `region` 类型；`cls` 在类名为空时回落 ControlType。
- **应用别名**：`narrate` 的别名词表补 Windows 进程名（chrome/msedge/explorer/…），
  屏幕尺寸文案改为「屏幕」而非「可视区域」。

### 修复（宿主契约）

- **参数 schema 畸形**：v1.1.0 绕过 `defineTool` 直接 `ctx.tools.register()`，把裸属性表
  （`{include_events:{type:"boolean"}}`）交给宿主；而宿主 `register()` 只校验 output、
  **不编译 parameters**，于是畸形 schema 被原样投影给模型。现全部写成完整 JSON Schema。
  另注意宿主子集不支持 `minimum`/`maximum`，取值范围写进描述并在 execute 内钳制。
- **注册无兜底**：宿主未注入 tools 服务时 `registerVisionTools` 会抛，现优雅返回 0。
- **身份不一致**：patch 用 `dsh-screen-vision-win`，而 `lib/index.js` 导出 `dsh-screen-vision`。
  现统一为 `dsh-screen-vision-win`（package.json / patch id+name / 导出 name 三者一致）。

### 新增

- `captureMode`（`auto`/`worker`/`oneshot`）、`workerIdleMs`、`captureTimeoutMs` 三个配置项。
  `captureMode: worker` 时失败**如实报错**，不偷偷换通道。
- `test/run.mjs` 自检套件：58 项断言，覆盖配置钳制、自构造 PNG（5 种 filter 全枚举）
  解码、帧差/运动/连通域/方位命名、密码与隐私打码、字幕过滤、滚动/场景/视频推断、
  语言化摘要、宿主 JSON Schema 契约、以及 PowerShell 脚本的 5.1 兼容性静态检查。
- 引擎降级退避：连续失败按 `minPollMs × 2^n` 退避（上限 30s），并按实测单帧耗时放宽
  节拍；`vision_status` 新增 `captureVia` / `lastCaptureMs` / `degradedStreak` / `captureMode`。
- `vision_stop` 与 dispose 会回收常驻采集进程并 `purgeWorkDir()`，不在临时目录留屏幕画面。
- `os: ["win32"]`、repository/LICENSE/CHANGELOG 字段补齐。

### 文档

README 全面改为 Windows 实态：删去「系统设置 → 无障碍 → DeepSeek Harness 屏幕助手」等
Android 授权指引、`profiles/web` 安装路径与 `DeepSeekHarness/screenshots`，补上真实
耗时表、双通道说明、15 条修复清单与 14 条验收用例。

### 破坏性变更

- 包名/插件 id 由 `dsh-screen-vision` 改为 **`dsh-screen-vision-win`**。若之前装过 v1.1.0，
  需要在 profile 的 `package.json` 与 `bundles` 里改名，并删除旧的 patch 行。
- 依赖声明里移除了 `engines` 之外的 Android 期概念（`vscreen*` 字段仍保留但恒为
  `false/-1`，以便与 Android 版共用同一份 `vision_status` 输出格式）。

## 1.1.0 —— 2026-10-28

- 字幕/场景变化检测（`sceneChangeThreshold` / `captionRegionFy` / `caption_change` 事件）。
- 配置热重载 `reloadConfig()`。
- ⚠ 本版的 Windows 采集层实际不可用，请使用 1.1.1。

## 1.0.x

- Android 版（App 内嵌无障碍服务 + vscreen），与本包无关。
