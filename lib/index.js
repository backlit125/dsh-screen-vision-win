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
 * 插件装载入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 宿主上下文。
 * @param {object} config - patch 层 config（可空对象）。
 */
export function apply(ctx, config = {}) {
  const engine = new VisionEngine(config);
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
