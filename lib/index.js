/**
 * dsh-screen-vision-win 宿主入口 —— Cordis 插件（name/inject/apply）。
 *
 * 装载链：profile 的 package.json 里 dsh.profile.bundles 含本包 → 本包
 * cordis.patch.yml insert 一行（id=screen-vision-win，
 * name='dsh-screen-vision-win'）→ loader 解析 lib/index.js → apply(ctx, config)。
 *
 * 约定（与 dsh-memory-card 等本机已跑通的插件一致）：patch 的 name、本模块导出的
 * name、package.json 的 name 三者同名，装载期不存在 id 与插件名错位的歧义。
 *
 * 零平台依赖（纯 node: 内建）：peerDependencies 只声明、绝不静态 import ——
 * 宿主运行时注入 'tools' 服务，我们只用 ctx 上的能力，因此插件在任何 dsh
 * 安装布局（app.asar / pnpm profile）下都能装载。
 *
 * 生命周期：
 *   apply：new VisionEngine(config) → registerVisionTools(ctx, engine) 注册 7 工具
 *   ctx.on('dispose')：停引擎、停采集进程、清临时目录、清模块级句柄
 *   （profile 热重载/卸载时干净退出，不留 powershell.exe 与屏幕画面）。
 */
import { VisionEngine } from "./engine.js";
import { registerVisionTools } from "./tools.js";
import { purgeWorkDir, stopWorker } from "./capture.js";

export const name = "dsh-screen-vision-win";
export const inject = ["tools"];

/** 模块级引擎句柄（供 reloadConfig 与 cordis 热重载复用）。 */
let currentEngine = null;

/**
 * 引擎构造失败时的兜底对象：保持与 VisionEngine 相同的调用面，所有读操作返回
 * ok:false + 原因。这样 7 个工具仍能注册（宿主不会因缺工具而报错），AI 调用时拿到的
 * 是一句可读的失败，而不是插件抛出异常打断 profile 装载。
 */
function makeStubEngine(reason) {
  const fail = async () => ({ ok: false, error: "感知引擎未能启动：" + reason, timestamp: Date.now() });
  return {
    cfg: { recentWindowMs: 12000, minPollMs: 1000, captureTimeoutMs: 6000, captureMode: "auto" },
    running: false, ring: [], current: null, prev: null, lastCaptureMs: 0, captureVia: "",
    lastVideoState: null,
    start: async () => ({ started: false, capabilities: { a11yRunning: false, a11yCanScreenshot: false, guide: "engine unavailable: " + reason } }),
    stop: () => ({ stopped: false, alreadyStopped: true }),
    pollNow: fail,
    read: fail,
    status: () => ({ running: false, frames: 0, events: 0, uptimeMs: 0, capabilities: null, config: null, currentBrief: null, degradedStreak: 0, captureVia: "", captureMode: "auto", lastCaptureMs: 0, consecutiveSilentTicks: 0 }),
    reloadConfig: () => ({ ok: false, error: "engine unavailable: " + reason }),
  };
}

/**
 * 插件装载入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 宿主上下文。
 * @param {object} config - patch 层 config（可空对象）。
 */
export function apply(ctx, config = {}) {
  // 整个装载体包在 try 里：本插件坏掉绝不能连带把 profile 其它插件（例如 QQ 机器人通道）
  // 一起拖死。失败时留一个 stub 引擎，7 个工具照常注册，调用时返回明确错误。
  let engine;
  try {
    engine = new VisionEngine(config);
  } catch (e) {
    console.error("[dsh-screen-vision-win] engine construction failed:", String((e && e.message) || e));
    engine = makeStubEngine(String((e && e.message) || e));
  }
  currentEngine = engine;

  // 工具注册（tools 服务就绪即挂）
  try {
    registerVisionTools(ctx, engine);
  } catch (e) {
    console.error("[dsh-screen-vision-win] tool registration error:", String(e && e.message || e));
  }

  // 默认「即用即读」：不自动起循环（AI 首次 vision_read 会即时采一帧，无需预热）。
  // 想开机即持续监听：patch config 里加 autoStart: true（或环境变量 DSH_VISION_AUTOSTART=1）。
  // 走 engine.cfg（已含 patch ← DSH_VISION_CONFIG 三层覆盖），不直读 raw config，
  // 否则环境变量与热重载都改不动这个开关。
  if (engine.cfg.autoStart === true || process.env.DSH_VISION_AUTOSTART === "1") {
    engine.start().catch((e) => console.error("[dsh-screen-vision-win] autostart failed:", String(e && e.message || e)));
  }

  // 热重载/卸载时干净退出（loader 的 effect 语义也可以，但显式 dispose 更稳）
  ctx.on("dispose", () => {
    try { engine.stop(); } catch { /* best effort */ }
    // 兜底：即使引擎本来就没在监听，也要回收采集进程与临时屏幕画面
    try { stopWorker("plugin-dispose"); } catch { /* best effort */ }
    purgeWorkDir().catch(() => { /* best effort */ });
    if (currentEngine === engine) currentEngine = null;
  });

  // 把引擎挂到 ctx 上，供同进程其它插件/调试复用（可选能力）
  try {
    ctx.set?.("screenVision", engine);
  } catch { /* 老版 cordis 没有 set 时忽略 */ }

  console.log("[dsh-screen-vision-win] plugin loaded (Windows capture channel: PowerShell + UI Automation / GDI+)");
}

/** 配置热重载：把最新 patch config 合并到运行态引擎（不重启感知循环）。 */
export function reloadConfig(nextConfig = {}) {
  if (!currentEngine) return { ok: false, error: "engine not loaded" };
  return currentEngine.reloadConfig(nextConfig);
}
