/**
 * 工具注册层 —— 7 个 vision_* 工具，AI（即我这样的 agent）可直接调用。
 *
 * 注册方式与 dsh-office-tools / dsh-memory-card 一致：
 *   ctx.inject(['tools']) → apply(ctx) → ctx.tools.register(definition)
 * 宿主 loader 运行时注入 tools 服务；@deepseek-ai/dsh-tools 只是 peerDependency，
 * 磁盘上不可 import，所以本文件零依赖、不引 defineTool。
 *
 * ⚠ 宿主契约（v1.1.0 踩错，模型侧因此拿到畸形参数 schema）：
 *   registry.register() 只校验 output（必须声明 {schema, render}，schema.type 必须是
 *   七种具体类型之一），**不会编译 parameters**。把 defineTool 风格的裸属性表
 *   （{include_events:{type:"boolean"}}）交给 register()，会被原样投影给模型——那不是
 *   合法 JSON Schema。因此这里 parameters 一律写成完整 JSON Schema（obj() 构造），
 *   参数收敛也在 execute 里自己做，不指望宿主兜底。
 *   output.schema 用 object + additionalProperties:true，允许字段随调用动态变化。
 */

/**
 * 统一输出约定：所有 vision_* 工具返回一个自由 JSON 对象（字段按调用
 * 动态变化），schema 声明为「object 根 + 任意属性」。宿主 dsh-tools 的
 * 输出校验要求 schema.type 必须是七种具体类型之一（不支持裸 'json'），
 * object + 无 properties 即「任意对象」，渲染走 JSON.stringify。
 */
/** 完整 JSON Schema 的 object 根（宿主不编译裸属性表，见文件头）。 */
function obj(properties, required = []) {
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/** 统一的自由对象输出：字段按调用动态变化，渲染走 JSON.stringify。 */
const TEXT_RENDER = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }],
};

/** 数值参数收敛（宿主不再替我们校验 parameters）。 */
const num = (v, fallback) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** 通用参数说明：所有工具共享「可以不传任何参数」的易用性。 */
const P = {
  include_events: { type: "boolean", description: "是否附带最近事件流（默认 true）" },
  include_ui: { type: "boolean", description: "是否展开控件/布局字段（默认 true）" },
  include_text: { type: "boolean", description: "是否附带可见文本（默认 true）" },
  // 宿主支持的 JSON Schema 子集不含 minimum/maximum，取值范围写进描述文字。
  event_window_ms: { type: "integer", description: "事件回看窗口毫秒，2000~120000（默认取配置 recentWindowMs）" },
  limit: { type: "integer", description: "最多返回多少条，1~200（默认 30）" },
};

/**
 * 生成全部工具定义。
 * @param {import('./engine.js').VisionEngine} engine - 已构建的引擎实例。
 */
export function buildTools(engine) {
  return [
    {
      name: "vision_start",
      description:
        "启动 Windows 屏幕连续感知（watch）：以自适应频率监测屏幕（快档受实测单帧耗时约束），" +
        "识别滚动方向/速度/位移、窗口切换、弹窗出现、焦点变化、内容增删、视频播放与画面运动，" +
        "全部沉淀为带时间戳的事件环。启动后用 vision_read 读当前理解、vision_watch_events 拉增量事件。" +
        "幂等：已在监听时重复调用无害。",
      parameters: obj({}),
      output: TEXT_RENDER,
      async execute() {
        const r = await engine.start();
        const st = engine.status();
        const caps = r.capabilities || st.capabilities || {};
        return {
          ok: true, started: r.started, already_running: !!r.alreadyRunning,
          capabilities: caps,
          hint: !caps.a11yRunning
            ? "UI Automation 没拿到控件树，结构感知不可用（事件将只有像素/降级信息）。检查 powershell.exe 能否执行、执行策略是否允许 Bypass。"
            : !caps.a11yCanScreenshot
              ? "GDI+ 截图通道不可用：只报结构事件，没有 motion/video/scroll 的像素证据。"
              : caps.captureVia === "oneshot"
                ? "当前用单进程采帧（实测约 " + (caps.captureMs || 0) + "ms/帧），轮询已自动放慢；原因：" + caps.guide
                : "",
        };
      },
    },
    {
      name: "vision_stop",
      description:
        "停止屏幕连续感知（省电）：同时回收常驻 PowerShell 采集进程、清掉临时目录里的屏幕画面。" +
        "已产生的事件仍保留在环里，可继续用 vision_watch_events 读取。幂等。",
      parameters: obj({}),
      output: TEXT_RENDER,
      async execute() {
        const r = engine.stop();
        return { ok: true, stopped: r.stopped, already_stopped: !!r.alreadyStopped };
      },
    },
    {
      name: "vision_read",
      description:
        "读取当前 Windows 屏幕的结构化理解（一次调用 = 一份完整「视觉快照」）：" +
        "source_window 前台应用、viewport、visible_text 可见文本、ui_elements 控件、" +
        "layout_hierarchy 层级、scroll_event 最近滚动、video_state 视频状态、" +
        "motion_summary 帧差摘要、attention_regions 关注区域、natural_language_summary " +
        "自然语言摘要、confidence 置信度，以及最近事件流（含时间戳）。" +
        "监听未启动时也能调用（会即时采一轮）。这是「看一眼屏幕」的统一入口。",
      parameters: obj({
        include_events: P.include_events,
        include_ui: P.include_ui,
        include_text: P.include_text,
        event_window_ms: P.event_window_ms,
      }),
      output: TEXT_RENDER,
      async execute(args) {
        const a = args && typeof args === "object" ? args : {};
        const r = await engine.read({
          include_events: a.include_events !== false,
          include_ui: a.include_ui !== false,
          include_text: a.include_text !== false,
          event_window_ms: Math.max(2000, Math.min(120000, num(a.event_window_ms, engine.cfg.recentWindowMs))),
        });
        return r.ok === true
          ? r
          : { ok: false, error: r.error, capabilities: r.capabilities, timestamp: r.timestamp };
      },
    },
    {
      name: "vision_watch_events",
      description:
        "读取感知事件流的（增量）切片：带时间戳的滚动/切窗/弹窗/焦点/内容变化/视频/运动/降级事件，" +
        "每条含结构化字段 + summary 短句。用 sinceMs 做增量拉取（只返回该时间戳之后的事件），" +
        "实现「持续关注屏幕」而不必整帧重读。建议节奏：操作后 1~3 秒调一次。",
      parameters: obj({
        since_ms: { type: "integer", description: "只返回 timestamp > since_ms 的事件（增量拉取用，Unix 毫秒）" },
        event_window_ms: P.event_window_ms,
        limit: P.limit,
      }),
      output: TEXT_RENDER,
      async execute(args) {
        const a = args && typeof args === "object" ? args : {};
        const windowMs = Math.max(2000, Math.min(120000, num(a.event_window_ms, engine.cfg.recentWindowMs)));
        const since = num(a.since_ms, 0) > 0 ? a.since_ms : Date.now() - windowMs;
        const limit = Math.max(1, Math.min(200, Math.round(num(a.limit, 30))));
        const events = engine.ring.filter((e) => e.timestamp > since).slice(-limit);
        return {
          ok: true, count: events.length,
          latest_timestamp: events.length ? events[events.length - 1].timestamp : since,
          watching: engine.running,
          events,
        };
      },
    },
    {
      name: "vision_video_status",
      description:
        "查询视频/动画播放状态：基于「连续帧高变化比 + 控件树静止 + 视频控件在场」的证据融合，" +
        "报告 state=playing/paused、区域（分数坐标）、证据与置信度。需要在播放状态附近有过感知帧" +
        "（监听中自动满足；未监听则即时采几帧再判断）。",
      parameters: obj({}),
      output: TEXT_RENDER,
      async execute() {
        // 未监听时即时补 3 帧；间隔按实测单帧耗时走，别用固定 1200ms 空等
        if (!engine.running) {
          const gap = Math.min(1500, Math.max(300, engine.lastCaptureMs || engine.cfg.minPollMs));
          for (let i = 0; i < 3; i++) {
            await engine.pollNow();
            if (i < 2) await new Promise((res) => setTimeout(res, gap));
          }
        }
        const cur = engine.current;
        const vs = cur && (cur.video_state || engine.lastVideoState);
        return {
          ok: true,
          video_state: vs || null,
          source_window: cur ? cur.source_window : "",
          evidence_note: vs
            ? `判断依据：${vs.evidence || "帧差证据"}`
            : "未检测到视频/动画活动的证据（画面稳定或证据不足）",
        };
      },
    },
    {
      name: "vision_status",
      description:
        "查询感知引擎状态：是否在监听、运行时长、感知帧数、事件环水位、静默时长、连续降级次数、" +
        "采集通道（常驻 worker 还是单进程）、单帧实测耗时、能力探测（UIA/截图/屏幕尺寸）与当前生效配置。" +
        "诊断与调参用；想知道实际能跑多快就看 lastCaptureMs 与 captureVia。",
      parameters: obj({}),
      output: TEXT_RENDER,
      async execute() {
        return { ok: true, ...engine.status() };
      },
    },
    {
      name: "vision_capture",
      description:
        "保存一张当前屏幕截图到磁盘（不解析、不喂给模型——供人工核查或后续工具使用）。" +
        "文件落在系统临时目录的 dsh-screen-vision-win 下；keep=false 时读取后立即删除。" +
        "注意：连续视觉请优先用 vision_read / vision_watch_events；本工具是排查兜底。",
      parameters: obj({
        keep: { type: "boolean", description: "true=保留 PNG 文件（默认）；false=读取后即删" },
      }),
      output: TEXT_RENDER,
      async execute(args) {
        const { captureFrame } = await import("./capture.js");
        const cap = await captureFrame({
          keepFile: !args || args.keep !== false,
          timeoutMs: engine.cfg.captureTimeoutMs,
        });
        return cap.ok
          ? { ok: true, path: cap.path, w: cap.w, h: cap.h, kept: args ? args.keep !== false : true, bytes: cap.data.length }
          : { ok: false, error: cap.error };
      },
    },
  ];
}

/** 注册到 tools 服务。幂等（重名时先跳过，报 already registered 不致命）。 */
export function registerVisionTools(ctx, engine) {
  const defs = buildTools(engine);
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== "function") {
    console.warn("[dsh-screen-vision] 宿主未注入 tools 服务，工具未注册");
    return 0;
  }
  let n = 0;
  for (const d of defs) {
    try {
      ctx.tools.register(d);
      n++;
    } catch (e) {
      const msg = String(e && e.message || e);
      if (!/already registered|already exists/i.test(msg)) {
        console.error("[dsh-screen-vision] register failed:", d.name, msg);
      }
    }
  }
  console.log(`[dsh-screen-vision] registered ${n}/${defs.length} tools`);
  return n;
}
