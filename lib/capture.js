/**
 * Windows 采集层 —— dsh-screen-vision-win 的「眼睛」（v1.1.1 重写）。
 *
 * 零外部 npm 依赖：UI Automation（控件树）+ GDI+（截图），都经 PowerShell 调 Win32。
 * PowerShell 正文在 lib/ps/tick.ps1（纯 ASCII，避开 PS 5.1 的 ANSI 解码陷阱）；本模块
 * 负责起进程、传参、读回 UTF-8 结果。
 *
 * 两条采集通道，自动择优：
 *   worker  —— 常驻 powershell.exe，Add-Type 只热一次。实测冷启动到 READY 约 0.78s，
 *              单帧 0.63~0.87s（≈1.2~1.6fps，真机连续 6 帧实测）。没有 worker 就做不到
 *              亚秒级轮询。
 *   oneshot —— 每帧起一个新进程（stdout/stderr 走文件描述符）。受限沙箱里带管道的
 *              spawn 会 EPERM，此时自动回落到这条路径：功能相同、帧率减半。
 *
 * v1.1.0 在 Windows 上四条感知通道全断，本版逐条修掉（细节见 README）：
 *  1. 一轮 tick 只起一个进程，同时产出前台窗口 + UIA 树 + 截图。原来一轮起 3 个
 *     （实测各 0.8~1.9s，本机合计 3~4s），配置里的 minPollMs=500 物理上不可能达到。
 *  2. 结果用 UTF-8 文件回传。PS 5.1 重定向 stdio 走 OEM 码页（本机 936），按 utf8
 *     读会把窗口标题里的中文打成不可逆替换符；因此 worker 的行内协议只传 ASCII，
 *     路径一律经进程参数（宽字符无损）传入，错误文本 base64 回传。
 *  3. 截图前先 Add-Type System.Windows.Forms。v1.1.0 只加载 Drawing 就引用
 *     [System.Windows.Forms.Screen] → TypeNotFound → 整段失败，还吐出
 *     {"ok":true,"data":"","w":,"h":} 这种「非法 JSON 却标称成功」的结果。
 *  4. 前台窗口不再用自动变量 $pid（只读，赋值即 VariableNotWritable 中断），也不用
 *     不存在的 [json]::Escape；v1.1.0 因此 package 恒为空 → window_switch 永不触发。
 *     进程名改用 OpenProcess + QueryFullProcessImageName，不快照进程表也不抛。
 *  5. UIA 树以 FromHandle(前台 hwnd) 为根。从 RootElement 遍历只有二十几个桌面节点
 *     （任务栏 / 标题 / DesktopWindowXamlSource），拿不到前台应用内部控件；实测以前
 *     台窗口为根能拿到 228 个节点、其中 199 个带文本。
 *  6. BoundingRectangle 数值过 DshNum()。离屏 / 隐藏元素的 X、Y 是 Infinity，
 *     ConvertTo-Json 原样输出裸 Infinity → Node JSON.parse 抛异常 → 整棵树被判
 *     「UI Automation unavailable」，这是 v1.1.0 的真实死因（实测一次 20 处）。
 *  7. SetProcessDPIAware()。非 DPI-aware 进程里 Screen::Bounds 是逻辑像素（本机
 *     1707x1067）而 UIA 矩形是物理像素（2560x1600），两套坐标差一个缩放倍率，分数
 *     坐标 / 隐私矩形 / 字幕区 / 滚动位移全部错位。
 *  8. 采集 Current.IsPassword 与 Current.HasKeyboardFocus：Windows 密码框由此可识别
 *     打码（v1.1.0 只认 Android 的 EditorInfo 类名，密码从不被遮蔽），焦点事件也不再
 *     靠「第一个 input 节点」猜测。
 *  9. 全程异步 spawn —— v1.1.0 的 execFileSync 会把宿主 Electron 事件循环卡住数秒。
 *
 * 上层契约（engine / interpret / tools 零改动）：
 *   structuralSnapshot(timeoutMs, opts) -> {ok, package, title, nodes, truncated, dims, treeRoot}
 *   captureFrame({keepFile,timeoutMs})  -> {ok, data:Buffer, w, h, path}
 *   probeCapabilities(force, cfg)       -> {a11yRunning, a11yCanScreenshot, screenW, screenH, ...}
 */
import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "ps", "tick.ps1");
const WORK_DIR = join(tmpdir(), "dsh-screen-vision-win");
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** 同一次 tick 截的图：captureFrame 直接复用，省一整次进程。 */
let shotCache = null; // { at, data, meta }
let capsCache = null; // { at, value }
const CAPS_TTL_MS = 30000;
const SHOT_FRESH_MS = 1500;
/** 连续失败计数：进程反复起不来时用于退避与降级判断。 */
let failureStreak = 0;
/**
 * 采集通道策略（由 engine 从配置注入）：
 *   auto    —— 先试常驻 worker，起不来即回落单进程（默认）
 *   worker  —— 只用常驻 worker（受限环境会直接失败，适合确认管道可用的机器）
 *   oneshot —— 只用单进程（最稳，帧率减半）
 */
let captureMode = "auto";
/** 常驻 worker 的空闲回收时限，由 configureCapture 从配置注入。 */
let workerIdleMs = 60000;

/** 注入采集相关配置（captureMode / captureTimeoutMs / workerIdleMs）。 */
export function configureCapture(cfg = {}) {
  if (["auto", "worker", "oneshot"].includes(cfg.captureMode)) captureMode = cfg.captureMode;
  if (typeof cfg.workerIdleMs === "number" && cfg.workerIdleMs >= 5000) workerIdleMs = cfg.workerIdleMs;
  if (captureMode === "oneshot") {
    // 显式只要单进程：收掉已存在的常驻通道，并禁止再去起 worker
    if (worker) stopWorker("mode-oneshot");
    workerDisabled = true;
    workerError = "captureMode=oneshot（按配置禁用常驻 worker）";
  } else {
    // 配置允许常驻：清掉上次的禁用标记，给一次重试机会
    workerDisabled = false;
    workerError = "";
  }
  return { captureMode, workerDisabled };
}
let oneshotSeq = 0;

let scriptBody = null;
/** 脚本正文缓存（磁盘上的 tick.ps1 不含占位符，占位符只在本模块内替换）。 */
function readScript() {
  if (scriptBody === null) scriptBody = readFileSync(SCRIPT, "utf8");
  return scriptBody;
}

function ensureDir() {
  if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });
  return WORK_DIR;
}

/** PS 单引号字符串内转义（翻倍）。 */

/* ─────────────────────────── 通道一：常驻 worker ─────────────────────────── */

let worker = null; // { child, seq, pending, buf, dead, lastUse, stderr }
let workerDisabled = false; // 管道起不来（沙箱 EPERM）后不再尝试
let workerError = "";

/** 起常驻 worker。失败即置 workerDisabled，由调用方回落 oneshot。 */
async function ensureWorker(timeoutMs) {
  if (workerDisabled || captureMode === "oneshot") return null;
  if (worker && !worker.dead) return worker;
  ensureDir();
  let child;
  try {
    child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", SCRIPT, "-Mode", "worker", "-WorkDir", WORK_DIR,
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  } catch (e) {
    workerDisabled = true;
    workerError = "worker spawn blocked: " + String((e && e.code) || e);
    return null;
  }
  const w = { child, seq: 0, pending: new Map(), buf: "", dead: false, lastUse: Date.now(), stderr: "" };
  let readyResolve = null;
  const ready = new Promise((res) => { readyResolve = res; });
  child.stdout.on("data", (d) => {
    w.buf += d.toString("utf8");
    let nl;
    while ((nl = w.buf.indexOf("\n")) >= 0) {
      const line = w.buf.slice(0, nl).replace(/\r+$/, "");
      w.buf = w.buf.slice(nl + 1);
      if (!line) continue;
      if (line.indexOf("READY") === 0) { readyResolve(true); continue; }
      const id = line.split("|")[0];
      const p = w.pending.get(id);
      if (p) { w.pending.delete(id); p(line); }
    }
  });
  child.stderr.on("data", (d) => { w.stderr = (w.stderr + d.toString("latin1")).slice(-2000); });
  child.on("error", (e) => {
    w.dead = true;
    workerError = "worker error: " + String((e && e.code) || e);
    readyResolve(false);
    failAllPending(w, workerError);
    if (worker === w) worker = null;
  });
  child.on("exit", (code) => {
    w.dead = true;
    if (!/exited/.test(workerError)) workerError = "worker exited (" + code + ")";
    readyResolve(false);
    failAllPending(w, workerError);
    if (worker === w) worker = null;
  });
  const timer = setTimeout(() => readyResolve(false), Math.max(3000, timeoutMs));
  const okReady = await ready;
  clearTimeout(timer);
  if (!okReady) {
    try { child.kill(); } catch { /* ignore */ }
    if (w.stderr) workerError += " | " + w.stderr.slice(0, 200);
    // 起不来通常是执行环境受限（沙箱禁管道）或 powershell 不可用，不再反复尝试
    workerDisabled = true;
    return null;
  }
  worker = w;
  workerError = "";
  // 关键：不能只靠 probeCapabilities 启动回收器。即用即读路径（vision_read 在没有
  // 监听的情况下直接采帧）也会起 worker，若不挂回收器，这个 powershell.exe 会一直
  // 活到宿主重启 —— stop() 只在「曾经 start() 过」的情况下才会被调到。
  startReaper(workerIdleMs);
  return w;
}

function failAllPending(w, msg) {
  for (const p of w.pending.values()) p("X|ERR|" + msg);
  w.pending.clear();
}

/** 走 worker 完成一次采帧。返回 null 表示「worker 不可用，请回落 oneshot」。 */
async function workerPass(o) {
  if (captureMode === "oneshot") return null;
  const w = await ensureWorker(o.timeoutMs);
  if (!w) return captureMode === "worker" ? { ok: false, error: workerError || "worker unavailable", via: "worker" } : null;
  const id = "p" + (++w.seq);
  const started = Date.now();
  const jsonPath = join(WORK_DIR, "pass-" + id + ".json");
  const pngPath = join(WORK_DIR, "pass-" + id + ".png");
  const line = await new Promise((res) => {
    const to = setTimeout(() => {
      w.pending.delete(id);
      res(id + "|TIMEOUT|worker pass exceeded " + o.timeoutMs + "ms");
    }, Math.max(3000, o.timeoutMs));
    w.pending.set(id, (l) => { clearTimeout(to); res(l); });
    try {
      w.child.stdin.write(id + "|" + o.maxNodes + "|" + o.maxDepth + "|" + (o.tree ? 1 : 0) + "|" + (o.shot ? 1 : 0) + "\n");
    } catch (e) {
      clearTimeout(to);
      w.pending.delete(id);
      res(id + "|ERR|stdin write failed: " + String((e && e.message) || e));
    }
  });
  const doneAt = Date.now();
  if (line.indexOf(id + "|OK") !== 0) {
    // 单次超时不代表 worker 坏了（PS 只是慢）；连续超时由 grab 决定重启
    if (line.indexOf(id + "|TIMEOUT") === 0) { try { w.child.kill(); } catch { /* ignore */ } }
    let detail = line.slice(id.length + 1);
    const parts = line.split("|");
    if (parts.length > 2 && parts[2]) {
      try { detail = Buffer.from(parts[2], "base64").toString("utf8"); } catch { /* keep raw */ }
    }
    failureStreak++;
    return { ok: false, error: detail || "worker pass failed", via: "worker" };
  }
  w.lastUse = doneAt;
  let meta = null;
  let png = null;
  try {
    meta = JSON.parse(await readFile(jsonPath, "utf8"));
    if (o.shot && meta && meta.pngPath) {
      try { png = await readFile(meta.pngPath); } catch { /* 截图缺失只降级，不判整轮失败 */ }
    }
  } catch (e) {
    return { ok: false, error: "worker result unreadable: " + String((e && e.message) || e), via: "worker" };
  } finally {
    for (const f of [jsonPath, pngPath]) { try { await unlink(f); } catch { /* ignore */ } }
  }
  if (!meta) return { ok: false, error: "worker returned no result", via: "worker" };
  failureStreak = 0;
  return { ok: meta.ok === true, meta, png, error: meta.error, via: "worker", ms: doneAt - started };
}

/** 空闲回收：不监听时不留一个常驻 powershell.exe。 */
let reaper = null;
function startReaper(idleMs) {
  stopReaper();
  reaper = setInterval(() => {
    if (!worker || worker.dead) return;
    if (Date.now() - worker.lastUse > Math.max(5000, idleMs)) stopWorker("idle");
  }, 5000);
  if (typeof reaper.unref === "function") reaper.unref();
}
function stopReaper() { if (reaper) { clearInterval(reaper); reaper = null; } }

/** 主动结束常驻 worker（停止监听 / dispose / 通道降级）。 */
export function stopWorker(reason) {
  if (!worker || worker.dead) return { stopped: false, reason: reason || "" };
  const w = worker;
  worker = null;
  try { w.child.stdin.write("EXIT\n"); } catch { /* ignore */ }
  try { w.child.stdin.end(); } catch { /* ignore */ }
  const t = setTimeout(() => { try { w.child.kill(); } catch { /* ignore */ } }, 800);
  if (typeof t.unref === "function") t.unref();
  return { stopped: true, reason: reason || "" };
}

/* ─────────────────────────── 通道二：单进程 ─────────────────────────── */

/**
 * 单进程采集。stdout/stderr 走文件描述符（受限沙箱里带管道 spawn 会 EPERM），
 * 结果走 UTF-8 文件；路径经进程参数传入，脚本正文无需替换占位符。
 */
function oneShot(o) {
  const started = Date.now();
  return new Promise((resolve) => {
    let jsonFile;
    let pngFile;
    let logFile;
    let scriptPath;
    let fd;
    try {
      ensureDir();
      const stem = join(WORK_DIR, "one-" + (++oneshotSeq));
      jsonFile = stem + ".json";
      pngFile = stem + ".png";
      logFile = stem + ".log";
      scriptPath = stem + ".ps1";
      // 磁盘上的 tick.ps1 原样执行即可（-Mode oneshot 走参数分支），但仍补 BOM 写一份
      // 副本，避免与并发调用共享同一路径的只读文件锁。
      writeFileSync(scriptPath, Buffer.concat([BOM, Buffer.from(readScript(), "utf8")]));
      fd = openSync(logFile, "w");
    } catch (e) {
      return resolve({ ok: false, error: "setup failed: " + String((e && e.message) || e), ms: 0, via: "oneshot" });
    }
    const paths = [jsonFile, pngFile, logFile, scriptPath];
    const settle = (ok, error) => {
      try { closeSync(fd); } catch { /* ignore */ }
      (async () => {
        let meta = null;
        let png = null;
        let err = error;
        if (ok) {
          try {
            const text = await readFile(jsonFile, "utf8");
            meta = text && text.trim() ? JSON.parse(text) : null;
          } catch (e) {
            err = "result json unreadable: " + String((e && e.message) || e);
          }
          if (meta && meta.ok !== true) { ok = false; err = meta.error || err || "collector reported failure"; }
          if (ok && o.shot && meta && meta.pngPath) {
            try { png = await readFile(meta.pngPath); } catch { /* 截图缺失只降级 */ }
          }
          if (!meta) { ok = false; err = err || "result file missing or empty"; }
        }
        if (!ok) {
          let tail = "";
          try { tail = (await readFile(logFile, "latin1")).trim().slice(-400); } catch { /* ignore */ }
          if (tail) err = (err || "powershell failed") + " | " + tail;
          failureStreak++;
        } else {
          failureStreak = 0;
        }
        for (const f of paths) { try { await unlink(f); } catch { /* 已删或本就不存在 */ } }
        resolve({ ok, meta, png, error: err, ms: Date.now() - started, via: "oneshot" });
      })();
    };
    let child;
    try {
      child = spawn("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
        "-Mode", "oneshot",
        "-MaxNodes", String(o.maxNodes),
        "-MaxDepth", String(o.maxDepth),
        "-WantTree", o.tree ? "1" : "0",
        "-WantShot", o.shot ? "1" : "0",
        "-JsonPath", jsonFile,
        "-PngPath", pngFile,
      ], { stdio: ["ignore", fd, fd], windowsHide: true });
    } catch (e) {
      return settle(false, "spawn threw: " + String((e && e.message) || e));
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      settle(false, "powershell exceeded " + o.timeoutMs + "ms");
    }, Math.max(3000, o.timeoutMs));
    child.on("error", (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      settle(false, "spawn powershell.exe failed: " + String((e && e.code) || e));
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      settle(true, code === 0 ? undefined : "powershell exit " + code);
    });
  });
}

/* ─────────────────────────── 对外统一入口 ─────────────────────────── */

/**
 * 采一帧：worker 优先，任何一层不可用即回落 oneshot。永不 reject。
 * @param {{tree?:boolean,shot?:boolean,maxNodes?:number,maxDepth?:number,timeoutMs?:number}} raw
 */
async function grab(raw = {}) {
  const o = {
    tree: raw.tree !== false,
    shot: raw.shot !== false,
    maxNodes: raw.maxNodes || 600,
    maxDepth: raw.maxDepth || 12,
    timeoutMs: raw.timeoutMs || 6000,
  };
  const w = await workerPass(o);
  if (w && w.ok) return w;
  if (w && /TIMEOUT/.test(String(w.error || ""))) stopWorker("pass-timeout");
  // captureMode=worker 是用户的显式选择：worker 失败就如实报错，不许偷偷换通道
  if (captureMode === "worker") {
    return { ok: false, error: (w && w.error) || workerError || "worker unavailable", via: "worker" };
  }
  const one = await oneShot(o);
  if (!one.ok && w && w.error) one.error = String(w.error) + " ; oneshot: " + String(one.error || "");
  return one;
}

/** 把采帧结果归一成上层的控件树快照。 */
function toSnapshot(meta) {
  const rawNodes = Array.isArray(meta.nodes) ? meta.nodes : [];
  const nodes = rawNodes.map((n) => ({
    text: n.text || "",
    desc: n.desc || "",
    cls: n.cls || n.controlType || "",
    automationId: n.automationId || "",
    controlType: n.controlType || "",
    x: typeof n.x === "number" ? n.x : 0,
    y: typeof n.y === "number" ? n.y : 0,
    w: typeof n.w === "number" ? n.w : 0,
    h: typeof n.h === "number" ? n.h : 0,
    clickable: !!n.clickable,
    scrollable: !!n.scrollable,
    input: !!n.input,
    password: !!n.password,
    focused: !!n.focused,
    depth: typeof n.depth === "number" ? n.depth : 0,
  }));
  return {
    ok: true,
    package: meta.processName || "",
    title: meta.title || "",
    nodes,
    truncated: !!meta.truncated,
    treeRoot: meta.treeRoot || "",
    dims: { w: meta.screenW || 0, h: meta.screenH || 0 },
    fgRect: meta.fgRect || null,
    windowPid: typeof meta.windowPid === "number" ? meta.windowPid : 0,
  };
}

/**
 * 一次结构性快照：前台窗口 + UIA 控件树（顺带截图，写进 shotCache 供帧差复用）。
 * 永不 reject；失败返回 {ok:false,error,...}。
 */
export async function structuralSnapshot(timeoutMs = 6000, opts = {}) {
  const r = await grab({
    timeoutMs,
    maxNodes: opts.maxNodes || 600,
    maxDepth: opts.maxDepth || 12,
    tree: true,
    shot: opts.shot !== false,
  });
  if (!r.ok) {
    return {
      ok: false, error: r.error || "capture unavailable", package: "", title: "",
      nodes: [], truncated: false, treeRoot: "", dims: { w: 0, h: 0 },
      via: r.via || "",
    };
  }
  const snap = toSnapshot(r.meta);
  snap.captureMs = r.ms;
  snap.via = r.via || "";
  if (r.meta.shotError) snap.shotError = r.meta.shotError;
  if (r.png) shotCache = { at: Date.now(), data: r.png, meta: r.meta };
  return snap;
}

/**
 * 取一张截图，返回 {ok, data:Buffer, w, h, path} 或 {ok:false,error}。
 * 优先复用同一次 tick 的截图；否则单独采（跳过控件树，省一大段时间）。
 * keepFile=true 时把 PNG 留在 WORK_DIR 供人工核查。
 */
export async function captureFrame({ keepFile = false, timeoutMs = 6000 } = {}) {
  let data = null;
  let meta = null;
  if (shotCache && Date.now() - shotCache.at < SHOT_FRESH_MS && shotCache.data) {
    data = shotCache.data;
    meta = shotCache.meta;
  } else {
    const r = await grab({ tree: false, shot: true, timeoutMs });
    if (!r.ok) return { ok: false, error: r.error || "screenshot failed" };
    data = r.png;
    meta = r.meta;
    if (data) shotCache = { at: Date.now(), data, meta };
  }
  if (!data || !data.length) {
    return { ok: false, error: (meta && meta.shotError) || "screenshot produced no bytes" };
  }
  let path = "";
  if (keepFile) {
    try {
      ensureDir();
      path = join(WORK_DIR, "shot-" + Date.now() + ".png");
      writeFileSync(path, data);
    } catch { /* best effort */ }
  }
  return {
    ok: true, data, path,
    w: (meta && meta.screenW) || 0,
    h: (meta && meta.screenH) || 0,
  };
}

/**
 * 能力探测：据实汇报采集通道、屏幕尺寸与所用通道；字段名与 Android 版对齐，
 * 让 engine.status() / vision_status 输出一致。
 */
export async function probeCapabilities(force = false, cfg = {}) {
  if (!force && capsCache && Date.now() - capsCache.at < CAPS_TTL_MS) return capsCache.value;
  const budget = cfg.captureTimeoutMs || 8000;
  // captureMode=oneshot 时不试探 worker，直接单进程（省掉一次必然失败的 spawn）
  const r = captureMode === "oneshot"
    ? await oneShot({ tree: true, shot: true, maxNodes: 40, timeoutMs: budget })
    : await grab({ tree: true, shot: true, maxNodes: 40, timeoutMs: budget });
  const meta = (r.ok && r.meta) || {};
  const nodeCount = Array.isArray(meta.nodes) ? meta.nodes.length : 0;
  const canShot = !!(r.ok && r.png && r.png.length > 1000);
  if (r.ok) startReaper(cfg.workerIdleMs || 60000);
  const value = {
    a11yRunning: !!r.ok && nodeCount > 0,
    a11yForeground: r.ok ? meta.processName || "" : "",
    a11yNodeCount: nodeCount,
    a11yCanScreenshot: canShot,
    a11yCanGesture: false,
    a11yApiLevel: 0,
    vscreenServer: false,
    vscreenDisplayId: -1,
    tokenPresent: false,
    screenW: meta.screenW || 0,
    screenH: meta.screenH || 0,
    treeRoot: meta.treeRoot || "",
    captureMs: r.ms || 0,
    captureVia: r.via || "",
    workerActive: !!worker && !worker.dead,
    failureStreak,
    powershell: "powershell.exe (Windows PowerShell 5.1)",
    guide: !r.ok
      ? "采集通道不可用：" + (r.error || "unknown") +
        "（检查 powershell.exe 能否执行、ExecutionPolicy 是否允许 Bypass）"
      : !canShot
        ? "控件树可用、GDI+ 截图不可用：降级为「仅结构」感知（无 motion/video 事件）"
        : r.via === "worker"
          ? "UI Automation + GDI+ 经常驻 worker 采帧，支持亚秒级轮询"
          : "UI Automation + GDI+ 经单进程采帧（" + (workerError || "常驻通道不可用") + "，帧率受限）",
  };
  capsCache = { at: Date.now(), value };
  return value;
}

/** 采集通道诊断（vision_status 用）。 */
export function captureDiagnostics() {
  return {
    mode: worker && !worker.dead ? "worker" : "oneshot",
    workerActive: !!worker && !worker.dead,
    workerDisabled,
    workerError: workerError || "",
    failureStreak,
    workDir: WORK_DIR,
    script: SCRIPT,
    scriptPresent: existsSync(SCRIPT),
  };
}

/** 兼容 v1.1.0 的导出名。 */
export function parseResult(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") { try { return JSON.parse(raw); } catch { /* fallthrough */ } }
  return { ok: false, error: "unparseable response" };
}

/** 清掉中间产物（隐私：不在盘上留屏幕截图与控件树）。 */
export async function purgeWorkDir() {
  shotCache = null;
  capsCache = null;
  stopWorker("purge");
  stopReaper();
  try {
    if (!existsSync(WORK_DIR)) return { ok: true, removed: 0 };
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(WORK_DIR);
    let removed = 0;
    for (const n of names) {
      if (!/^(pass|one|shot)-/.test(n)) continue;
      try { await unlink(join(WORK_DIR, n)); removed++; } catch { /* ignore */ }
    }
    return { ok: true, removed };
  } catch {
    return { ok: false, removed: 0 };
  }
}
