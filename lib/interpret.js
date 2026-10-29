/**
 * 语义层 —— 把控件树 + 帧差原始数据翻译为结构化语义：
 *   · visible_text / ui_elements / layout_hierarchy / attention_regions
 *   · scroll_event（方向、速度、位移）· video_state · motion_summary
 *   · 隐私遮罩（privacyRects 命中、密码框检测、input 节点打码）
 *
 * 设计原则：所有数值都来自真实推断，置信度（confidence）按证据强度给出，
 * 拒绝「拍脑袋的 0.99」：
 *   · 滚动：文本锚点位移 > 像素运动估计 > 仅帧差（0.9 / 0.6 / 0.4 三档）
 *   · 视频：连续 N 帧高变化比 + 控件树静止（≥0.7），字幕/播放器控件再加成
 *   · 窗口切换：前台包名变化（0.95）；树完全重建但包名相同（0.6）
 */

const MASK = "[MASKED]";
// 字幕候选的最小长度：低于它的大多是壳层节点名（StatusView、DesktopWindowXamlSource）
// 或按钮文字，不是真字幕。v1.1.0 里 captionTexts 的 else 分支写成
// 「长度 >= MIN_CAPTION_FRAMES(=1) 也收」，等于不过滤，于是 StatusView 被当字幕
// 报成 caption_change。
const MIN_CAPTION_CHARS = 8;

/**
 * input 节点是否疑似密码框。
 * Windows 的第一手证据是 UIA 的 Current.IsPassword（采集层放在 node.password 上）——
 * v1.1.0 只匹配 Android 的 EditorInfo 类名，Windows 密码框因此从不被遮蔽。
 * 类名匹配作为旧采集层/未上报 IsPassword 时的兜底。
 */
const PWD_CLASS = /password|secure|passwd/i;
function looksLikePassword(node) {
  if (node && node.password === true) return true;
  const cls = String(node && node.cls || "");
  const aid = String(node && node.automationId || "");
  const desc = String(node && node.desc || "");
  return PWD_CLASS.test(cls) || PWD_CLASS.test(aid) || /密码|password/i.test(desc);
}

/** 分数矩形是否覆盖节点中心。 */
function rectHits(rect, node) {
  const cx = (node.x + node.w / 2), cy = (node.y + node.h / 2);
  return cx >= rect.fx1 && cx <= rect.fx2 && cy >= rect.fy1 && cy <= rect.fy2;
}

/** 折叠空白并截断。 */
function cleanLabel(label, maxLen) {
  return String(label || "").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

/**
 * 从控件树提取「字幕区域」内可见文本（如视频播放时的弹幕/字幕）。
 * @param {Array} nodes - 控件树节点。
 * @param {object} dims - {w,h} 当前屏幕尺寸（像素）。
 * @param {Array} fyRange - [fy1,fy2] 字幕区域纵向分数范围，默认屏幕下部。
 * @returns {string[]} 去重后的字幕文本（长度 >= MIN_CAPTION_CHARS，壳层节点名已排除）。
 */
export function captionTexts(nodes, dims, fyRange = [0.78, 0.96]) {
  if (!Array.isArray(nodes) || !dims || !dims.w || !dims.h) return [];
  const fy1 = Math.min(Math.max(fyRange[0] || 0, 0), 1);
  const fy2 = Math.max(Math.min(fyRange[1] || 1, 1), 0);
  if (fy2 <= fy1) return [];
  const y1 = fy1 * dims.h, y2 = fy2 * dims.h;
  const texts = new Set();
  for (const n of nodes) {
    if (!n.text && !n.desc) continue;
    const cx = (n.x + n.w / 2), cy = (n.y + n.h / 2);
    if (cy < y1 || cy > y2) continue;      // 不在字幕纵向区间 → 跳过
    const t = cleanLabel(n.text || n.desc || "", 120);
    if (!t || t === MASK) continue;
    // 壳层噪声一律排除；短文本只在确实像句子时才收
    if (/^(StatusView|DesktopWindowXamlSource|Chrome Legacy Window|WorkerW|Program Manager|Shell_.*)$/i.test(t)) continue;
    if (t.length >= MIN_CAPTION_CHARS) texts.add(t);
  }
  return [...texts];
}

/**
 * 字幕变化检测：前后两帧的字幕文本集合差异。
 * @param {string[]} prev - 上一帧字幕文本。
 * @param {string[]} curr - 当前帧字幕文本。
 * @returns {{changed:boolean, added:string[], removed:string[]} | null}
 */
export function captionDiff(prev, curr) {
  const pSet = new Set(prev || []), cSet = new Set(curr || []);
  const added = [...cSet].filter(t => !pSet.has(t));
  const removed = [...pSet].filter(t => !cSet.has(t));
  if (!added.length && !removed.length) return null;
  return { changed: true, added: added.slice(0, 6), removed: removed.slice(0, 6) };
}

/**
 * 场景切换检测：单帧变化比例高、且变化不是整屏平移（滚动/轮播），
 * 控件树又基本静止（tree fingerprint 不变），则判定为画面场景切换。
 * @param {number} ratio - 当前帧差变化比例（0~1）。
 * @param {object} motion - estimateMotion 的结果 {dx,dy,residual}。
 * @param {object} cfg - 钳制后配置（含 sceneChangeThreshold）。
 * @returns {{changed:boolean, direction:string|null, confidence:number} | null}
 */
export function inferSceneChange(ratio, motion, cfg) {
  const th = cfg && typeof cfg.sceneChangeThreshold === "number" ? cfg.sceneChangeThreshold : 0.45;
  if (ratio < th) return null;
  // 平移量大 ⇒ 更像滚动而非场景切换；residual 小 ⇒ 平移拟合好 ⇒ 滚动
  const isTranslate = motion && Math.abs(motion.dx) + Math.abs(motion.dy) >= 2 && motion.residual < 40;
  if (isTranslate) return null;
  const direction = motion && Math.abs(motion.dy) >= Math.abs(motion.dx)
    ? (motion.dy > 0 ? "down" : "up")
    : null;
  return { changed: true, direction, confidence: Math.min(0.85, 0.55 + ratio * 0.3) };
}

/**
 * 从控件树里识别视频/播放器相关控件的位置区域（用于 attention_regions 与 video region）。
 * @param {Array} uiElements - interpretTree 输出的 uiElements。
 * @param {object} dims - {w,h}。
 * @returns {{fx1,fy1,fx2,fy2,cells} | null} 分数矩形（优先最大的 video 类节点）。
 */
export function videoRegionFromTree(uiElements, dims) {
  if (!dims || !dims.w || !dims.h || !Array.isArray(uiElements)) return null;
  const videos = uiElements.filter(e => e.kind === "video" || /VideoView|MediaController|TextureView|SurfaceView|MediaPlayer|D3D11|VideoPanel/i.test(e.cls || ""));
  if (!videos.length) return null;
  // 取最大面积的视频控件
  let best = null;
  for (const v of videos) {
    const area = v.w * v.h;
    if (!best || area > best.area) best = { ...v, area };
  }
  const fx1 = Math.max(0, Math.min(best.x / dims.w, 1));
  const fy1 = Math.max(0, Math.min(best.y / dims.h, 1));
  const fx2 = Math.max(0, Math.min((best.x + best.w) / dims.w, 1));
  const fy2 = Math.max(0, Math.min((best.y + best.h) / dims.h, 1));
  return { fx1: Number(fx1.toFixed(3)), fy1: Number(fy1.toFixed(3)), fx2: Number(fx2.toFixed(3)), fy2: Number(fy2.toFixed(3)) };
}

/**
 * 从控件树提炼语义视图（受 detail 与隐私配置约束）。
 * @param {object} snap - structuralSnapshot() 的结果。
 * @param {object} cfg - 钳制后的配置。
 * @param {object} dims - {w,h} 当前屏幕尺寸（分数→像素换算用；0 时跳过遮罩）。
 */
export function interpretTree(snap, cfg, dims = { w: 0, h: 0 }) {
  const pkg = snap.package || "";
  const privacyApp = cfg.privacyPackages.includes(pkg);
  const nodes = snap.ok ? snap.nodes : [];

  if (privacyApp) {
    return {
      privacyMasked: true,
      visibleText: `（${pkg} 在隐私名单内：内容已按配置遮蔽）`,
      uiElements: [],
      layoutHierarchy: { depth: 0, containers: 0, note: "privacy-masked" },
      inputFocus: null,
      clickables: 0,
      scrollables: 0,
    };
  }

  const pxRects = dims.w && dims.h && cfg.privacyRects.length
    ? cfg.privacyRects.map((r) => ({
        x1: r.fx1 * dims.w, y1: r.fy1 * dims.h, x2: r.fx2 * dims.w, y2: r.fy2 * dims.h, label: r.label,
      }))
    : [];
  const inPrivacyRect = (n) => pxRects.some((r) =>
    n.x + n.w / 2 >= r.x1 && n.x + n.w / 2 <= r.x2 && n.y + n.h / 2 >= r.y1 && n.y + n.h / 2 <= r.y2);

  const texts = [];
  const uiElements = [];
  let clickables = 0, scrollables = 0, inputFocus = null;
  let maxDepth = 0, containers = 0;

  for (const n of nodes) {
    if (typeof n.depth === "number" && n.depth > maxDepth) maxDepth = n.depth;
    if (!n.text && !n.desc) { containers++; continue; }
    // 密码框无条件打码（UIA 可能不把密码域标成 input/value 模式）
    const sensitive = (n.input === true || n.password === true) && (looksLikePassword(n) || inPrivacyRect(n));
    const masked = sensitive || inPrivacyRect(n);

    const clsName = String(n.cls || "");
    const ctName = String(n.controlType || "");
    const label = (n.text || n.desc || "").slice(0, cfg.detail === "verbose" ? 160 : 80);
    if (n.input === true || n.password === true) {
      // 当前输入焦点：优先 UIA HasKeyboardFocus 命中的节点，其次首个 input 节点
      if (!inputFocus || (n.focused === true && !inputFocus.focused)) {
        inputFocus = {
          text: masked ? MASK : label,
          cls: (clsName || ctName).slice(0, 60),
          x: n.x, y: n.y, w: n.w, h: n.h,
          password: looksLikePassword(n),
          focused: n.focused === true,
        };
      }
    }
    if (n.clickable) clickables++;
    if (n.scrollable) scrollables++;

    if (texts.length < 200 && label) texts.push(masked ? MASK : label);

    const WIDGETISH = n.clickable || n.input || n.password || n.scrollable
      // 浏览器/Electron/WinUI 的文档与图像节点：不含它们，可见文本与视频区都会漏
      || /Edit|Button|Hyperlink|Image|Document|List|DataGrid|TabItem|MenuItem$/i.test(ctName)
      || /^(Chrome_RenderWidgetHostHWND|Chrome Legacy Window|DirectUIHWND|CtrlNotifySink|SysListView32|SysTreeView32|Internet Explorer_Server|MediaPlayer|Windows.UI.Core.CoreWindow|Shell_TrayWnd)$/i.test(clsName);
    if (uiElements.length < cfg.maxUiElements && WIDGETISH) {
      uiElements.push({
        kind: (n.password === true || /Edit$/i.test(ctName) || /PasswordBox|TextBox|Edit/i.test(clsName)) ? "input" :
          /Video|Media|player/i.test(ctName + clsName) ? "video" :
          /List|DataGrid|Table|Scroll|Tab/i.test(ctName) ? "list" :
          /Document|Text$/i.test(ctName) && !n.clickable ? "region" :
          /Image/i.test(ctName + clsName) ? "image" :
          "button",
        text: masked ? MASK : label,
        cls: (clsName || ctName).slice(0, 60),
        x: n.x, y: n.y, w: n.w, h: n.h,
        clickable: !!n.clickable, input: !!n.input, scrollable: !!n.scrollable,
      });
    }
  }

  let visibleText = texts.join(" ").replace(/\s+/g, " ").trim();
  if (visibleText.length > cfg.maxTextChars) visibleText = visibleText.slice(0, cfg.maxTextChars) + "…";

  // v1.1.0：字幕区域文本（下部区间），供视频字幕变化检测使用
  const captionTextsResult = captionTexts(nodes, dims, cfg.captionRegionFy);

  return {
    privacyMasked: false,
    visibleText,
    uiElements,
    layoutHierarchy: {
      depth: maxDepth,
      containers,
      nodeCount: nodes.length,
      truncated: !!snap.truncated,
      ...(cfg.detail === "minimal" ? {} : {
        scrollableContainers: scrollables,
        clickableCount: clickables,
      }),
    },
    inputFocus,
    clickables,
    scrollables,
    captionTexts: captionTextsResult,
  };
}

/**
 * 滚动事件推断：文本锚点位移（同一文本节点在前后帧的 y 差）为主证据，
 * 像素运动估计为辅。返回 null 表示「本轮没有滚动」。
 */
export function inferScroll(prevNodes, currNodes, motion, cfg, dims) {
  if (!Array.isArray(prevNodes) || !Array.isArray(currNodes)) return null;
  // 文本锚点：取前后帧都出现的文本节点，按 (text,x) 匹配
  const idx = new Map();
  for (const n of currNodes) {
    const t = String(n.text || "").trim();
    if (t && t !== MASK && !idx.has(t)) idx.set(t, n);
  }
  const deltas = [];
  for (const n of prevNodes) {
    const t = String(n.text || "").trim();
    if (!t || t === MASK) continue;
    const m = idx.get(t);
    if (m && m.y !== n.y && Math.abs(m.x - n.x) < dims.w * 0.3) deltas.push(n.y - m.y); // 正=内容上移=向下滚动
  }
  const anchorDelta = deltas.length >= 2 ? median(deltas) : null;

  if (anchorDelta !== null && Math.abs(anchorDelta) >= 24) {
    const gapMs = cfg.__frameGapMs || cfg.minPollMs;
    return {
      type: "scroll",
      direction: anchorDelta > 0 ? "down" : "up",   // 正=同文本上移=用户向下滚动看新内容
      displacementPx: Math.round(Math.abs(anchorDelta)),
      speedPxPerSec: Math.round((Math.abs(anchorDelta) * 1000) / Math.max(100, gapMs)),
      evidence: "text-anchor",
      confidence: deltas.length >= 4 ? 0.9 : 0.75,
    };
  }
  // 像素平移佐证：motion.dy 符号与文本锚点无关时才采信（dy>0 ⇒ 内容向下移 ⇒ 用户向上滚动）
  if (motion && Math.abs(motion.dy) >= 2 && motion.residual < 40) {
    const gapMs = cfg.__frameGapMs || cfg.minPollMs;
    return {
      type: "scroll",
      direction: motion.dy > 0 ? "up" : "down",
      displacementPx: Math.round(Math.abs(motion.dy) * (dims.h / (motion.__gy || cfg.gridY))),
      speedPxPerSec: Math.round(Math.abs(motion.dy) * (dims.h / cfg.gridY) * (1000 / Math.max(100, gapMs))),
      evidence: "pixel-motion",
      confidence: 0.55,
    };
  }
  return null;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/**
 * 视频状态推断：连续 N 帧高变化比 + 控件树静止 ⇒ 疑似视频/动画区域。
 * v1.1.0 新增：估算播放进度（最近高变化帧数/视频MinFrames），并输出字幕区域文本用于字幕变化检测。
 * @param {Array} recentFrames - [{ratio, nodesFingerprint, captionTexts}] 最近帧序列。
 * @param {object} ui - interpretTree 的结果（找 VideoView 等控件）。
 * @param {object} cfg - 钳制后配置。
 */
export function inferVideo(recentFrames, ui, cfg) {
  const frames = recentFrames.slice(-Math.max(3, cfg.videoMinFrames));
  if (frames.length < cfg.videoMinFrames) return null;
  const highFrames = frames.filter((f) => f.ratio >= cfg.videoMotionHigh).length;
  const treeStable = frames.every((f) => f.fingerprint === frames[0].fingerprint);
  const videoWidgets = (ui.uiElements || []).filter((e) => e.kind === "video");
  if (!treeStable) return null;
  if (highFrames >= cfg.videoMinFrames) {
    // 播放进度：近窗口内高变化帧占比（0~1，仅供 AI 粗略判断是否在推进）
    const progress = Number((highFrames / frames.length).toFixed(2));
    const conf = Math.min(0.9, 0.5 + 0.1 * highFrames + (videoWidgets.length ? 0.25 : 0));
    // 字幕文本：取最近一帧的字幕区域文本
    const last = frames[frames.length - 1];
    const captions = last && Array.isArray(last.captionTexts) ? last.captionTexts : [];
    return {
      state: "playing",
      playing: true,
      progress,
      region: locateMotionRegion(frames, cfg),
      evidence: highFrames + "/" + frames.length + " frames above threshold, tree stable",
      playerWidgets: videoWidgets.map((e) => e.cls),
      captions,
      confidence: Number(conf.toFixed(2)),
    };
  }
  // 树静止 + 帧差低 + 曾有高帧 ⇒ 暂停
  const hadHigh = recentFrames.some((f) => f.ratio >= cfg.videoMotionHigh);
  if (hadHigh && videoWidgets.length) {
    return { state: "paused", playing: false, progress: 0, confidence: 0.5, evidence: "motion stopped, video widgets present" };
  }
  return null;
}

/** 找出最近帧差最大的一帧的变化区域（格子坐标→分数坐标）。 */
function locateMotionRegion(frames, cfg) {
  let best = null;
  for (const f of frames) {
    if (!f.regions || !f.regions.length) continue;
    const top = f.regions[0];
    if (!best || top.cells > best.top.cells) best = { f, top };
  }
  if (!best) return null;
  const { x0, y0, x1, y1 } = best.top;
  return {
    fx1: Number((x0 / cfg.gridX).toFixed(3)), fy1: Number((y0 / cfg.gridY).toFixed(3)),
    fx2: Number(((x1 + 1) / cfg.gridX).toFixed(3)), fy2: Number(((y1 + 1) / cfg.gridY).toFixed(3)),
    cells: best.top.cells,
  };
}

/**
 * attention_regions：AI 应重点关注的区域（按优先级）。
 *   1. 当前输入框（用户正在输入/聚焦处）
 *   2. 本轮变化最大的帧差区域
 *   3. 可滚动容器（交互热点）
 *   4. 视频播放区域与字幕区域（v1.1.0 新增）
 *   5. 前几大可见控件（标题栏、视频等）
 */
export function attentionRegions(ui, motionRegions, cfg) {
  const out = [];
  if (ui.inputFocus) {
    out.push({
      reason: "input-focus",
      note: "当前输入框（用户可能正在输入）",
      x: ui.inputFocus.x, y: ui.inputFocus.y, w: ui.inputFocus.w, h: ui.inputFocus.h,
    });
  }
  if (motionRegions && motionRegions.length) {
    out.push({
      reason: "recent-motion",
      note: "最近变化最集中的区域",
      region: { fx1: motionRegions.fx1, fy1: motionRegions.fy1, fx2: motionRegions.fx2, fy2: motionRegions.fy2 },
    });
  }
  // v1.1.0：视频区域 + 字幕区域（优先于普通控件，用户看视频时最关注）
  const vr = videoRegionFromTree(ui.uiElements || [], { w: cfg.__dimsW || 0, h: cfg.__dimsH || 0 });
  if (vr) out.push({ reason: "video-region", note: "视频播放区域", region: vr });
  const [fy1, fy2] = (cfg && Array.isArray(cfg.captionRegionFy)) ? cfg.captionRegionFy : [0.78, 0.96];
  if (fy2 > fy1) out.push({ reason: "caption-region", note: "字幕区域（下部文本）", region: { fx1: 0, fy1, fx2: 1, fy2 } });
  const scrollers = (ui.uiElements || []).filter((e) => e.scrollable).slice(0, 2);
  for (const s of scrollers) {
    out.push({ reason: "scrollable", note: "可滚动容器", x: s.x, y: s.y, w: s.w, h: s.h });
  }
  return out.slice(0, 6);
}
