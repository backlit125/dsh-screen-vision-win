/**
 * 感知引擎 —— dsh-screen-vision 的心脏：自适应频率的连续感知循环。
 *
 * 每轮 tick（不抛错，全部结果进事件环）：
 *   1) /dump 控件树（~30ms）→ 树语义 + 窗口切换/弹窗/焦点/文本 diff 事件
 *   2) /screenshot 截图（~200ms）→ 解码 → 网格采样 → 帧差/运动/视频事件
 *   3) 两路证据融合：滚动方向（文本锚点优先，像素运动兜底）
 *
 * 自适应降频（省电的关键）：
 *   变化期  minPollMs（500ms）
 *   静默 N 帧 → idlePollMs（2s）
 *   静默 > idleDemoteAfterMs → 8s 深度空闲（每次 tick 仍然轻：先 /dump 的
 *   指纹，只有变了才截图）
 *
 * 隐私：截图读回内存即删盘文件；帧像素只保留网格（GX×GY×3 个数字），
 * 原始像素在差分后立刻丢弃；password 输入框文本一律 [MASKED]。
 */

import { captureFrame, structuralSnapshot, probeCapabilities, stopWorker, purgeWorkDir, configureCapture } from "./capture.js";
import { decodePngRgba, sampleGrid, diffGrids, estimateMotion, clusterChanged, regionLabel } from "./pixel.js";
import { interpretTree, inferScroll, inferVideo, inferSceneChange, captionTexts, captionDiff, attentionRegions } from "./interpret.js";
import { narrate, summarizeEvent } from "./narrate.js";
import { mergeConfig } from "./config.js";

/** 树指纹：包名+节点数+前 40 节点文字@坐标。滚动/跳页/弹窗都会变。 */
function treeFingerprint(snap) {
  if (!snap.ok) return "ERR";
  const parts = [snap.package || "", String(snap.nodes.length)];
  for (let i = 0; i < Math.min(40, snap.nodes.length); i++) {
    const n = snap.nodes[i] || {};
    parts.push(String(n.text || n.desc || "").slice(0, 60) + "@" + n.x + "," + n.y);
  }
  return parts.join("|");
}

/** 从树里抽取可见文本集合（去重，限量）。 */
function textSet(nodes) {
  const s = new Set();
  for (const n of nodes) {
    const t = String(n.text || n.desc || "").trim();
    if (t && t !== "[MASKED]" && s.size < 400) s.add(t);
  }
  return s;
}

/** 深度空闲档位（静默超过 idleDemoteAfterMs 后的 tick 间隔）。 */
const DEEP_IDLE_MS = 8000;

export class VisionEngine {
  /** @param {object} patchConfig - patch 层 config（可空）。 */
  constructor(patchConfig) {
    this.cfg = mergeConfig(patchConfig);
    // 采集通道策略与超时交给采集层（captureMode / workerIdleMs）
    configureCapture(this.cfg);
    // 运行态
    this.running = false;
    this.timer = null;
    this.tickPromise = null;
    this.consecutiveSilent = 0;
    this.lastChangeAt = 0;
    this.lastTickAt = 0;
    this.frames = 0;
    // 上一帧状态
    this.prev = null; // {snapFingerprint, pkg, nodes, grid, texts, dims, ui, ts}
    this.recentGrids = []; // [{ratio, fingerprint, regions}] 供视频推断
    this.prevCaptionTexts = null; // v1.1.0：上一帧字幕文本（供字幕变化检测）
    // 事件环（定长）
    this.ring = [];
    // 当前语义快照（vision_read 直接读）
    this.current = null;
    this.caps = null;
    this.startedAt = null;
    this.degradedStreak = 0;
    /** 采集通道（worker / oneshot），来自最近一次成功采帧。 */
    this.captureVia = "";
    /** 最近一次采帧耗时（毫秒）；决定自适应间隔下限。 */
    this.lastCaptureMs = 0;
    /** 采集层报来的屏幕尺寸，像素通道尚未跑通时的兜底。 */
    this.lastDims = { w: 0, h: 0 };
  }

  /** 启动感知循环。幂等。 */
  async start() {
    if (this.running) return { started: false, alreadyRunning: true };
    this.running = true;
    this.startedAt = Date.now();
    this.caps = await probeCapabilities(true, this.cfg);
    this.#loop();
    return { started: true, capabilities: this.caps };
  }

  /** 停止感知循环。幂等。 */
  stop() {
    if (!this.running) return { stopped: false, alreadyStopped: true };
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    // 不监听了就别留一个常驻 powershell.exe，也别在临时目录留屏幕画面
    stopWorker("engine-stop");
    purgeWorkDir().catch(() => { /* best effort */ });
    return { stopped: true };
  }

  /** 立刻跑一轮感知（vision_read / vision_start 都会调）。不与循环并发。 */
  async pollNow() {
    const p = this.tickPromise;
    if (p) return p;
    const t = this.#tick();
    this.tickPromise = t.finally(() => { this.tickPromise = null; });
    return this.tickPromise;
  }

  #loop() {
    if (!this.running) return;
    this.tickPromise = this.#tick().finally(() => {
      this.tickPromise = null;
      if (!this.running) return;
      // 自适应间隔：变化刚发生 → 快档；静默累计 → 慢档 → 深度空闲
      let delay = this.cfg.minPollMs;
      if (this.consecutiveSilent >= 2) delay = this.cfg.idlePollMs;
      if (Date.now() - this.lastChangeAt > this.cfg.idleDemoteAfterMs && this.consecutiveSilent >= 2) {
        delay = DEEP_IDLE_MS;
      }
      // 通道不可用时指数退避（上限 30s）：坏掉的 powershell 不该被每秒敲一次
      if (this.degradedStreak > 0) {
        delay = Math.max(delay, Math.min(30000, this.cfg.minPollMs * 2 ** Math.min(5, this.degradedStreak)));
      }
      // 采集本身比 minPollMs 还慢时（单进程通道约 1.5s/帧），不要每次都超时
      if (this.lastCaptureMs > delay * 0.6) delay = Math.max(delay, this.lastCaptureMs * 1.6);
      this.timer = setTimeout(() => this.#loop(), delay);
    });
  }

  /** 一轮感知。永不 reject（内部消化一切错误）。 */
  async #tick() {
    const ts = Date.now();
    const cfg = this.cfg;
    try {
      // ---- 1) 结构通道：控件树 ----
      const snap = await structuralSnapshot(this.cfg.captureTimeoutMs);
      const fp = treeFingerprint(snap);
      const events = [];

      let treeChanged = this.prev ? fp !== this.prev.snapFingerprint : true;
      if (!snap.ok) {
        this.degradedStreak++;
        // 每 10 次重复上报一次，但首次必须报（否则用户以为插件在静默工作）
        if (this.degradedStreak === 1 || this.degradedStreak % 10 === 0) {
          this.#push({
            type: "degraded", timestamp: ts,
            reason: snap.error || "capture unavailable",
            sourceWindow: snap.package || "", confidence: 0,
          }, "感知通道不可用：" + (snap.error || ""));
        }
        // 通道坏了要退避：采集失败通常是每次撞满超时，按 5s/15s/30s 逐级拉长
        this.lastCaptureMs = snap.captureMs || 0;
        this.#silence();
        return;
      }
      this.degradedStreak = 0;
      this.captureVia = snap.via || "";
      this.lastCaptureMs = snap.captureMs || 0;
      // Windows 采集自带屏幕尺寸，作为像素通道尚未跑通时的兜底
      if (snap.dims && snap.dims.w && (!this.prev || !this.prev.dims.w)) {
        this.lastDims = snap.dims;
      }

      // ---- 窗口切换 ----
      if (this.prev && snap.package !== this.prev.pkg) {
        this.#push({
          type: "window_switch", timestamp: ts,
          from: this.prev.pkg, to: snap.package,
          source_window: snap.package,
          confidence: 0.95,
        }, "");
      }

      // ---- 2) 像素通道（仅当树变了或非深度静默时才截图——省电核心）----
      const deepIdle = this.consecutiveSilent >= 3;
      let motionSummary = null, scrollEvent = null, videoState = null, regions = [];
      let ui = this.prev ? this.prev.ui : null;
      let dims = this.prev && this.prev.dims && this.prev.dims.w
        ? this.prev.dims
        : (snap.dims && snap.dims.w ? snap.dims : { w: 0, h: 0 });

      if (!deepIdle || treeChanged) {
        const cap = await captureFrame();
        if (cap.ok) {
          const dec = decodePngRgba(cap.data);
          if (dec && !dec.unsupported) {
            dims = { w: dec.w, h: dec.h };
            const grid = sampleGrid(dec.pixels, dec.w, dec.h, cfg.gridX, cfg.gridY, cfg.pixelStride);
            if (this.prev && this.prev.grid) {
              const { changed, ratio } = diffGrids(this.prev.grid, grid);
              const motion = estimateMotion(this.prev.grid, grid);
              const clusters = clusterChanged(changed, cfg.gridX, cfg.gridY);

              // v1.1.0：场景切换检测（非平移的大面积变化）
              const sc = inferSceneChange(ratio, motion, cfg);
              if (sc) {
                this.#push({
                  type: "scene_change", timestamp: ts, source_window: snap.package,
                  direction: sc.direction, change_ratio: Number(ratio.toFixed(3)),
                  confidence: sc.confidence,
                }, `画面场景发生切换${sc.direction ? `（内容向${sc.direction === "down" ? "下" : "上"}滑动）` : ""}`);
              }

              if (ratio > 0.01) {
                const top = clusters.filter((c) => c.cells >= cfg.motionRegionMinCells).slice(0, 3);
                const label = top.length ? regionLabel(top[0].x0, top[0].y0, top[0].x1, top[0].y1, cfg.gridX, cfg.gridY) : "局部";
                motionSummary = {
                  changeRatio: Number(ratio.toFixed(3)),
                  motionVector: { dxCells: motion.dx, dyCells: motion.dy, residual: Math.round(motion.residual) },
                  regions: top.map((c) => ({
                    label: regionLabel(c.x0, c.y0, c.x1, c.y1, cfg.gridX, cfg.gridY),
                    cells: c.cells,
                    fx1: c.x0 / cfg.gridX, fy1: c.y0 / cfg.gridY,
                    fx2: (c.x1 + 1) / cfg.gridX, fy2: (c.y1 + 1) / cfg.gridY,
                  })),
                };
                regions = motionSummary.regions;

                // 滚动：文本锚点 + 像素运动融合
                const se = inferScroll(this.prev.nodes, snap.nodes, { ...motion, __gy: cfg.gridY }, { ...cfg, __frameGapMs: ts - this.prev.ts }, dims);
                if (se) {
                  scrollEvent = se;
                  this.#push({ type: "scroll", timestamp: ts, scroll_event: se, source_window: snap.package, confidence: se.confidence }, "");
                } else if (ratio > 0.08) {
                  // 非平移变化 → motion 事件（若树没变，可能是视频/动画）
                  this.#push({
                    type: "motion", timestamp: ts, source_window: snap.package,
                    change_ratio: Number(ratio.toFixed(3)), regions: motionSummary.regions.map((r) => r.label),
                    confidence: 0.6,
                  }, `画面${label}发生变化（${(ratio * 100) | 0}% 区域）`);
                }
              }

              // 视频证据帧（树静止 + 高帧差）——带字幕文本
              const capTexts = captionTexts(snap.nodes, dims, cfg.captionRegionFy);
              this.recentGrids.push({ ratio, fingerprint: fp, regions: clusters, ts, captionTexts: capTexts });
              if (this.recentGrids.length > 12) this.recentGrids.shift();
              ui = interpretTree(snap, cfg, dims);
              const vs = inferVideo(this.recentGrids.filter((f) => ts - f.ts < 4000), ui, cfg);
              if (vs && (!this.lastVideoState || this.lastVideoState.state !== vs.state)) {
                videoState = vs;
                this.#push({ type: "video", timestamp: ts, source_window: snap.package, video_state: vs, confidence: vs.confidence }, "");
                this.lastVideoState = vs;
              } else if (vs) { videoState = vs; }

              // v1.1.0：字幕变化检测（连续稳定字幕被新文本取代）
              if (this.prevCaptionTexts) {
                const cd = captionDiff(this.prevCaptionTexts, capTexts);
                if (cd && cd.added.length) {
                  this.#push({
                    type: "caption_change", timestamp: ts, source_window: snap.package,
                    added_texts: cd.added, removed_texts: cd.removed,
                    confidence: 0.7,
                  }, `字幕更新：${cd.added.slice(0, 3).join(" / ")}`);
                }
              }
              this.prevCaptionTexts = capTexts;
            }
            // 保存网格，丢弃像素
            this.pendingGrid = grid;
          }
        } else if (!this.prev) {
          this.#push({ type: "degraded", timestamp: ts, reason: cap.error, source_window: snap.package, confidence: 0.5 }, "截图通道不可用：" + cap.error);
        }
      }

      // ---- 树变化事件：文本 diff / 弹窗 / 焦点 ----
      if (this.prev && treeChanged) {
        const prevTexts = this.prev.texts;
        const currTexts = textSet(snap.nodes);
        const added = [...currTexts].filter((t) => !prevTexts.has(t)).slice(0, 6);
        const removed = [...prevTexts].filter((t) => !currTexts.has(t)).slice(0, 6);

        ui = ui || interpretTree(snap, cfg, dims);
        const isPopup = added.length && !scrollEvent && snap.package === this.prev.pkg &&
          (snap.nodes.length - this.prev.nodes.length) > 3 && (dims.h ? (added.length >= 2 && Math.abs(snap.nodes.length - this.prev.nodes.length) / this.prev.nodes.length > 0.15) : false);
        const focusChanged = ui.inputFocus && this.prev.ui && this.prev.ui.inputFocus &&
          (ui.inputFocus.text !== this.prev.ui.inputFocus.text || ui.inputFocus.y !== this.prev.ui.inputFocus.y);

        if (added.length || removed.length) {
          this.#push({
            type: "content_change", timestamp: ts, source_window: snap.package,
            added_texts: added, removed_texts: removed,
            ...(scrollEvent ? { with_scroll: true } : {}),
            confidence: 0.8,
          }, "");
        }
        if (isPopup) {
          this.#push({ type: "popup", timestamp: ts, source_window: snap.package, added_texts: added.slice(0, 3), confidence: 0.6 },
            `疑似弹窗/新界面层（节点数 ${this.prev.nodes.length}→${snap.nodes.length}）`);
        }
        if (focusChanged) {
          this.#push({ type: "focus", timestamp: ts, source_window: snap.package, confidence: 0.7 },
            `输入焦点移至「${ui.inputFocus.text.slice(0, 30)}」`);
        }
      }

      // ---- 汇总当前帧语义 ----
      if (!ui) ui = interpretTree(snap, cfg, dims);
      this.current = {
        timestamp: ts,
        source_window: snap.package,
        viewport: { width: dims.w, height: dims.h, full: true },
        visible_text: ui.visibleText,
        ui_elements: ui.uiElements,
        layout_hierarchy: ui.layoutHierarchy,
        privacy_masked: ui.privacyMasked,
        scroll_event: scrollEvent,
        video_state: videoState || this.lastVideoState || null,
        motion_summary: motionSummary,
        attention_regions: attentionRegions(ui, regions[0] ? { fx1: regions[0].fx1, fy1: regions[0].fy1, fx2: regions[0].fx2, fy2: regions[0].fy2 } : null, { ...cfg, __dimsW: dims.w, __dimsH: dims.h }),
        confidence: {
          tree: snap.ok ? (snap.truncated ? 0.7 : 0.9) : 0.2,
          scroll: scrollEvent ? scrollEvent.confidence : null,
          video: (videoState || this.lastVideoState) ? (videoState || this.lastVideoState).confidence : null,
          motion: motionSummary ? 0.6 : null,
        },
      };

      // ---- 更新 prev / 静默计数 ----
      const changedNow = treeChanged || (motionSummary && motionSummary.changeRatio > 0.01);
      if (changedNow) { this.lastChangeAt = ts; this.consecutiveSilent = 0; }
      else this.consecutiveSilent++;

      this.prev = {
        snapFingerprint: fp, pkg: snap.package, nodes: snap.nodes,
        grid: this.pendingGrid || (this.prev ? this.prev.grid : null),
        texts: textSet(snap.nodes), dims, ui, ts,
      };
      this.frames++;
    } catch (e) {
      // 引擎级异常：只记一条 degraded，绝不让循环死掉
      this.#push({ type: "degraded", timestamp: ts, reason: String(e && e.message || e), source_window: "", confidence: 0 }, "感知引擎异常：" + String(e && e.message || e));
      this.consecutiveSilent++;
    }
  }

  #silence() { this.consecutiveSilent++; }

  /** 事件入环（带短句）。 */
  #push(e, summaryText) {
    e.summary = summaryText || summarizeEvent(e);
    this.ring.push(e);
    if (this.ring.length > this.cfg.eventRingSize) this.ring.splice(0, this.ring.length - this.cfg.eventRingSize);
  }

  /** 最近窗口内的事件（时间正序）。 */
  recentEvents(windowMs = this.cfg.recentWindowMs, limit = 50) {
    const since = Date.now() - windowMs;
    return this.ring.filter((e) => e.timestamp >= since).slice(-limit);
  }

  /** 组装 vision_read 的完整输出（当前帧 + 事件回顾 + NLG）。 */
  async read(options = {}) {
    const o = {
      includeEvents: options.include_events !== false,
      includeUi: options.include_ui !== false,
      includeText: options.include_text !== false,
      eventWindowMs: options.event_window_ms || this.cfg.recentWindowMs,
    };
    // 感知循环未跑时先取一轮，保证「随时可读」
    if (!this.running || !this.current) await this.pollNow();
    const cur = this.current;
    if (!cur) {
      return {
        ok: false,
        timestamp: Date.now(),
        error: "屏幕感知不可用：Windows 采集通道（PowerShell + UI Automation / GDI+）没有产出一帧。"
          + "常见原因：powershell.exe 不可执行或被执行策略拦（需允许 -ExecutionPolicy Bypass）、"
          + "当前进程无法启动子进程（受限沙箱禁管道）、或前台窗口不可读 UIA。详见 capabilities 与 guide 字段。",
        capabilities: this.caps,
      };
    }
    const events = o.includeEvents ? this.recentEvents(o.eventWindowMs) : [];
    const out = {
      ok: true,
      timestamp: cur.timestamp,
      source_window: cur.source_window,
      viewport: cur.viewport,
      privacy_masked: cur.privacy_masked,
      scroll_event: cur.scroll_event,
      video_state: cur.video_state,
      motion_summary: cur.motion_summary,
      attention_regions: cur.attention_regions,
      confidence: cur.confidence,
      natural_language_summary: narrate(cur, events),
      events,
    };
    if (o.includeText) out.visible_text = cur.visible_text;
    if (o.includeUi) out.ui_elements = cur.ui_elements;
    if (o.includeUi) out.layout_hierarchy = cur.layout_hierarchy;
    return out;
  }

  /** 运行状态（vision_status）。 */
  status() {
    return {
      running: this.running,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      frames: this.frames,
      events: this.ring.length,
      lastChangeAt: this.lastChangeAt || null,
      quietMs: this.lastChangeAt ? Date.now() - this.lastChangeAt : null,
      consecutiveSilentTicks: this.consecutiveSilent,
      capabilities: this.caps,
      captureVia: this.captureVia || (this.caps && this.caps.captureVia) || "",
      captureMode: this.cfg.captureMode,
      lastCaptureMs: this.lastCaptureMs,
      degradedStreak: this.degradedStreak,
      config: this.cfg,
      currentBrief: this.current ? {
        source_window: this.current.source_window,
        timestamp: this.current.timestamp,
        privacy_masked: this.current.privacy_masked,
      } : null,
    };
  }

  /** 配置热重载：把最新 patch config 重新合并到运行态（不重启引擎）。 */
  reloadConfig(nextConfig = {}) {
    this.cfg = mergeConfig(nextConfig);
    configureCapture(this.cfg);
    return { ok: true, config: this.cfg, capture: configureCapture(this.cfg) };
  }
}
