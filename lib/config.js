/**
 * dsh-screen-vision · 默认配置与合并器
 *
 * 用户可通过 profile 的 cordis.patch.yml 里 `id: dsh-screen-vision` 的
 * config: {...} 覆盖任意字段（dsh patch 层栈语义），也可用环境变量
 * DSH_VISION_CONFIG=<json> 整份覆盖（便于临时调试）。本模块合并顺序：
 *   DEFAULTS ← patch config ← DSH_VISION_CONFIG
 * 全部字段带类型收敛与范围钳制，坏值回落默认（决不抛错——感知插件不能因
 * 配置问题而拒绝启动）。
 */

/** 内置默认值。每条与 cordis.patch.yml 里的推荐值一一对应。 */
export const DEFAULTS = Object.freeze({
  minPollMs: 500,
  idlePollMs: 2000,
  idleDemoteAfterMs: 15000,
  eventRingSize: 200,
  gridX: 24,
  gridY: 11,
  pixelStride: 1,
  maxTextChars: 2000,
  maxUiElements: 40,
  privacyPackages: [],
  privacyRects: [],
  detail: "standard",
  videoMotionHigh: 0.18,
  videoMinFrames: 4,
  motionRegionMinCells: 6,
  recentWindowMs: 12000,
  // 字幕/场景变化检测（v1.1.0 新增）
  sceneChangeThreshold: 0.45,     // 单帧变化比例超过此值且非平移 ⇒ 场景切换
  captionRegionFy: [0.78, 0.96],  // 字幕区域纵向分数范围（下部 7.8%~9.6%）
  captionTextStableFrames: 3,     // 字幕文本连续 N 帧不变 ⇒ 字幕未更新
  // 采集通道（v1.1.1）：worker=常驻 PowerShell（快，需允许管道子进程），
  // oneshot=每帧一个进程（受限环境兜底），auto=先试 worker 失败即回落。
  captureMode: "auto",
  // 常驻 worker 空闲多久后回收（不再监听时不留 powershell.exe 进程）。
  workerIdleMs: 60000,
  // 单帧采集超时。worker 约 0.5s/帧、oneshot 约 1.5s/帧，留一倍余量。
  captureTimeoutMs: 6000,
  // 配置热重载
  hotReload: true,                // 允许运行时重新读取 patch 配置
});

const clampNum = (v, lo, hi, fallback) => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

const clampFloat = (v, lo, hi, fallback) => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * 合并配置。所有非法输入静默回落默认值；privacyRects 只接受分数矩形。
 * @param {any} patchConfig - patch 层给的 config（可能为 undefined）。
 * @returns {typeof DEFAULTS} 钳制后的成品配置。
 */
export function mergeConfig(patchConfig = {}) {
  const p = patchConfig && typeof patchConfig === "object" ? patchConfig : {};
  let env = {};
  try {
    if (typeof process.env.DSH_VISION_CONFIG === "string" && process.env.DSH_VISION_CONFIG.trim()) {
      const parsed = JSON.parse(process.env.DSH_VISION_CONFIG);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) env = parsed;
    }
  } catch {
    /* 坏 JSON 忽略 */
  }
  const c = { ...p, ...env };

  const rects = Array.isArray(c.privacyRects)
    ? c.privacyRects
        .filter((r) => r && typeof r === "object" &&
          [r.fx1, r.fy1, r.fx2, r.fy2].every((v) => typeof v === "number" && v >= 0 && v <= 1))
        .map((r) => ({
          fx1: Math.min(r.fx1, r.fx2), fy1: Math.min(r.fy1, r.fy2),
          fx2: Math.max(r.fx1, r.fx2), fy2: Math.max(r.fy1, r.fy2),
          label: typeof r.label === "string" ? r.label.slice(0, 40) : "privacy",
        }))
        .slice(0, 16)
    : [];

  // Windows 进程名带空格与连字符（DeepSeek Harness、Premiere Pro），
  // v1.1.0 的 ^[A-Za-z0-9._]+$ 会把它们全部拒掉，隐私名单形同虚设。
  const pkgs = Array.isArray(c.privacyPackages)
    ? c.privacyPackages
        .filter((s) => typeof s === "string" && /^[\p{L}\p{N}][\p{L}\p{N} ._+()-]{0,63}$/u.test(s.trim()))
        .map((s) => s.trim())
        .slice(0, 32)
    : [];

  const detail = ["minimal", "standard", "verbose"].includes(c.detail) ? c.detail : DEFAULTS.detail;

  return {
    minPollMs: clampNum(c.minPollMs, 100, 10000, DEFAULTS.minPollMs),
    idlePollMs: clampNum(c.idlePollMs, 200, 30000, DEFAULTS.idlePollMs),
    idleDemoteAfterMs: clampNum(c.idleDemoteAfterMs, 1000, 300000, DEFAULTS.idleDemoteAfterMs),
    eventRingSize: clampNum(c.eventRingSize, 10, 2000, DEFAULTS.eventRingSize),
    gridX: clampNum(c.gridX, 4, 64, DEFAULTS.gridX),
    gridY: clampNum(c.gridY, 4, 64, DEFAULTS.gridY),
    pixelStride: clampNum(c.pixelStride, 1, 8, DEFAULTS.pixelStride),
    maxTextChars: clampNum(c.maxTextChars, 200, 20000, DEFAULTS.maxTextChars),
    maxUiElements: clampNum(c.maxUiElements, 5, 200, DEFAULTS.maxUiElements),
    privacyPackages: pkgs,
    privacyRects: rects,
    detail,
    videoMotionHigh: clampFloat(c.videoMotionHigh, 0.02, 0.9, DEFAULTS.videoMotionHigh),
    videoMinFrames: clampNum(c.videoMinFrames, 1, 30, DEFAULTS.videoMinFrames),
    motionRegionMinCells: clampNum(c.motionRegionMinCells, 2, 64, DEFAULTS.motionRegionMinCells),
    recentWindowMs: clampNum(c.recentWindowMs, 2000, 120000, DEFAULTS.recentWindowMs),
    sceneChangeThreshold: clampFloat(c.sceneChangeThreshold, 0.05, 0.95, DEFAULTS.sceneChangeThreshold),
    captionRegionFy: Array.isArray(c.captionRegionFy) && c.captionRegionFy.length === 2
      ? [clampFloat(c.captionRegionFy[0], 0, 1, DEFAULTS.captionRegionFy[0]),
         clampFloat(c.captionRegionFy[1], 0, 1, DEFAULTS.captionRegionFy[1])]
      : DEFAULTS.captionRegionFy,
    captionTextStableFrames: clampNum(c.captionTextStableFrames, 1, 60, DEFAULTS.captionTextStableFrames),
    captureMode: ["auto", "worker", "oneshot"].includes(c.captureMode) ? c.captureMode : DEFAULTS.captureMode,
    workerIdleMs: clampNum(c.workerIdleMs, 5000, 600000, DEFAULTS.workerIdleMs),
    captureTimeoutMs: clampNum(c.captureTimeoutMs, 1500, 60000, DEFAULTS.captureTimeoutMs),
    hotReload: c.hotReload !== false,
  };
}
