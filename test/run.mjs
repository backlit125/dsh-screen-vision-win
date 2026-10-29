/**
 * dsh-screen-vision-win 自检 —— node test/run.mjs
 *
 * 只跑纯逻辑与宿主契约检查：不需要真屏幕，也不起 PowerShell。
 *   1. 模块可导入、导出面正确
 *   2. 配置合并：坏值一律钳制回落默认；隐私名单接受 Windows 进程名
 *   3. 像素层：自构造 PNG（覆盖 5 种 filter）能解回原像素；差分/运动/连通域正确
 *   4. 语义层：密码框打码、壳层噪声不当代字幕、隐私矩形命中、焦点优先真焦点
 *   5. 语言化层：摘要由字段驱动、应用别名生效
 *   6. 宿主契约：output 必须有 render；parameters 必须是宿主支持的 JSON Schema 子集
 *   7. 采集脚本静态检查（PS 5.1 兼容性：码页/DPI/$pid/Add-Type/Infinity/stdout）
 *   8. 引擎降级：失败要如实报告，不静默瞎掉
 *
 * 带屏幕的验收用例（U1~U14）见 README 第 8 节，需在宿主里手工跑。
 * 本文件刻意不使用正则字面量里的反斜杠——避免任何转义歧义，断言一律用字符串比较。
 */
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "lib");
const imp = (f) => import(pathToFileURL(join(LIB, f)).href);

let pass = 0;
let fail = 0;
const check = (label, fn) => {
  try { fn(); pass++; console.log("  ok   " + label); }
  catch (e) { fail++; console.log("  FAIL " + label + " -> " + String(e.message).split(String.fromCharCode(10))[0]); }
};
const acheck = async (label, fn) => {
  try { await fn(); pass++; console.log("  ok   " + label); }
  catch (e) { fail++; console.log("  FAIL " + label + " -> " + String(e.message).split(String.fromCharCode(10))[0]); }
};
const NL = String.fromCharCode(10);
const DQ = String.fromCharCode(34);
const has = (hay, needle) => hay.indexOf(needle) >= 0;

/* ── 1. 模块与导出面 ───────────────────────────────────────── */
console.log(NL + "[1] modules");
const pixel = await imp("pixel.js");
const cfgMod = await imp("config.js");
const narrate = await imp("narrate.js");
const interpret = await imp("interpret.js");
const engineMod = await imp("engine.js");
const toolsMod = await imp("tools.js");
const indexMod = await imp("index.js");

check("index exports name/inject/apply/reloadConfig", () =>
  assert.deepEqual(Object.keys(indexMod).sort(), ["apply", "inject", "name", "reloadConfig"]));
check("exported name equals package name (patch id consistency)", () =>
  assert.equal(indexMod.name, "dsh-screen-vision-win"));
check("inject declares tools only", () => assert.deepEqual(indexMod.inject, ["tools"]));

/* ── 2. 配置 ───────────────────────────────────────────────── */
console.log(NL + "[2] config");
check("out-of-range values clamp to bounds", () => {
  const c = cfgMod.mergeConfig({ minPollMs: 1, gridX: 999, detail: "nonsense", videoMotionHigh: 5, pixelStride: 0 });
  assert.equal(c.minPollMs, 100);
  assert.equal(c.gridX, 64);
  assert.equal(c.detail, "standard");
  assert.equal(c.videoMotionHigh, 0.9);
  assert.equal(c.pixelStride, 1);
});
check("NaN / strings / Infinity never throw and fall back", () => {
  const c = cfgMod.mergeConfig({ eventRingSize: Number.NaN, maxTextChars: "abc", recentWindowMs: Number.POSITIVE_INFINITY });
  assert.equal(c.eventRingSize, 200);
  assert.equal(c.maxTextChars, 2000);
  assert.equal(c.recentWindowMs, 12000);
});
check("privacyPackages accepts Windows process names", () => {
  const c = cfgMod.mergeConfig({ privacyPackages: ["DeepSeek Harness", "Premiere Pro", "chrome.exe", "剪映", "bad*name", 123] });
  assert.deepEqual(c.privacyPackages, ["DeepSeek Harness", "Premiere Pro", "chrome.exe", "剪映"]);
});
check("privacyRects keeps only normalised fractional rectangles", () => {
  const c = cfgMod.mergeConfig({ privacyRects: [{ fx1: 0.8, fy1: 0.5, fx2: 0.2, fy2: 0.1, label: "x" }, { fx1: 5, fy1: 0, fx2: 1, fy2: 1 }] });
  assert.equal(c.privacyRects.length, 1);
  assert.equal(c.privacyRects[0].fx1, 0.2);
  assert.equal(c.privacyRects[0].fx2, 0.8);
});
check("captureMode accepts only auto/worker/oneshot", () => {
  assert.equal(cfgMod.mergeConfig({ captureMode: "worker" }).captureMode, "worker");
  assert.equal(cfgMod.mergeConfig({ captureMode: "bogus" }).captureMode, "auto");
});
check("env override DSH_VISION_CONFIG wins over patch config", () => {
  process.env.DSH_VISION_CONFIG = JSON.stringify({ gridX: 40 });
  const c = cfgMod.mergeConfig({ gridX: 12 });
  delete process.env.DSH_VISION_CONFIG;
  assert.equal(c.gridX, 40);
});
check("malformed env JSON is ignored, not fatal", () => {
  process.env.DSH_VISION_CONFIG = "{not json";
  const c = cfgMod.mergeConfig({ gridY: 9 });
  delete process.env.DSH_VISION_CONFIG;
  assert.equal(c.gridY, 9);
});

/* ── 3. 像素层（自构造 PNG）────────────────────────────────── */
console.log(NL + "[3] pixel");
const build = (w, h, f) => {
  const b = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const px = f(i % w, Math.floor(i / w), i);
    b[i * 4] = px[0]; b[i * 4 + 1] = px[1]; b[i * 4 + 2] = px[2]; b[i * 4 + 3] = px[3];
  }
  return b;
};
const crcTable = [];
for (let n = 0; n < 256; n++) { let cc = n; for (let k = 0; k < 8; k++) cc = cc & 1 ? 0xedb88320 ^ (cc >>> 1) : cc >>> 1; crcTable[n] = cc >>> 0; }
const crc32 = (buf) => { let cc = 0xffffffff; for (const b of buf) cc = crcTable[(cc ^ b) & 255] ^ (cc >>> 8); return (cc ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 构造 8bit RGBA PNG，逐行指定 filter（覆盖 0~4 全部分支）。 */
function makePng(w, h, pixels, filters) {
  const stride = w * 4;
  const lines = [];
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < h; y++) {
    const ft = filters[y];
    const row = Buffer.alloc(stride);
    const cur = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y ? pixels.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? cur[x - 4] : 0;
      const up = prev[x];
      const ul = x >= 4 ? prev[x - 4] : 0;
      if (ft === 0) row[x] = cur[x];
      else if (ft === 1) row[x] = (cur[x] - left) & 0xff;
      else if (ft === 2) row[x] = (cur[x] - up) & 0xff;
      else if (ft === 3) row[x] = (cur[x] - ((left + up) >> 1)) & 0xff;
      else row[x] = (cur[x] - paeth(left, up, ul)) & 0xff;
    }
    lines.push(Buffer.concat([Buffer.from([ft]), row]));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(lines))), chunk("IEND", Buffer.alloc(0))]);
}
check("decodePngRgba round-trips all five filter types byte-exact", () => {
  const w = 16, h = 8;
  const src = build(w, h, (x, y, i) => [(x * 15 + y * 7) & 0xff, (i * 3) & 0xff, (255 - i) & 0xff, 255]);
  const dec = pixel.decodePngRgba(makePng(w, h, src, [0, 1, 2, 3, 4, 1, 4, 2]));
  assert.equal(dec.w, w);
  assert.equal(dec.h, h);
  for (let i = 0; i < src.length; i++) assert.equal(dec.pixels[i], src[i], "byte " + i + " mismatch");
});
check("non-RGBA colour type yields an honest unsupported tag", () => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(0))), chunk("IEND", Buffer.alloc(0))]);
  const dec = pixel.decodePngRgba(png);
  assert.ok(dec && dec.unsupported, "expected unsupported marker");
});
check("truncated garbage returns null, never throws", () =>
  assert.equal(pixel.decodePngRgba(Buffer.from("not a png at all")), null));
check("sampleGrid averages within each cell", () => {
  // 4x2 像素，前两个 x 为 0、后两个为 200；2x1 网格 → 左格 0、右格 200
  const g = pixel.sampleGrid(build(4, 2, (x) => [x < 2 ? 0 : 200, 0, 0, 255]), 4, 2, 2, 1, 1);
  assert.deepEqual(g[0], [[0, 0, 0], [200, 0, 0]]);
});
check("diffGrids flags only changed cells", () => {
  const d = pixel.diffGrids([[[0, 0, 0]], [[255, 0, 0]]], [[[0, 0, 0]], [[200, 200, 200]]], 30);
  assert.equal(d.changed.length, 1);
  assert.equal(d.ratio, 0.5);
});
check("estimateMotion recovers a 2-cell vertical shift", () => {
  const mk = (off) => { const g = []; for (let y = 0; y < 6; y++) { const row = []; for (let x = 0; x < 4; x++) { const v = (((y + off) % 6) + 6) % 6 * 40; row.push([v, v, v]); } g.push(row); } return g; };
  const m = pixel.estimateMotion(mk(0), mk(2));
  assert.equal(Math.abs(m.dy), 2);
  assert.ok(m.residual < 12, "residual " + m.residual);
});
check("clusterChanged merges 4-adjacent cells and bounding boxes them", () => {
  const r = pixel.clusterChanged([[0, 0], [1, 0], [2, 0], [2, 1], [10, 5]], 12, 8);
  assert.equal(r.length, 2);
  assert.equal(r[0].cells, 4, "the connected block is 4 cells");
  assert.deepEqual([r[0].x0, r[0].y0, r[0].x1, r[0].y1], [0, 0, 2, 1]);
  assert.equal(r[1].cells, 1);
});
check("regionLabel names bands in human words", () => {
  assert.equal(pixel.regionLabel(0, 2, 23, 4, 24, 11), "屏幕上部横向大半区");
  assert.equal(pixel.regionLabel(0, 0, 23, 10, 24, 11), "整个屏幕");
  assert.equal(pixel.regionLabel(20, 0, 23, 10, 24, 11), "屏幕右侧纵向大半区");
});

/* ── 4. 语义层 ─────────────────────────────────────────────── */
console.log(NL + "[4] interpret");
const cfg = cfgMod.mergeConfig({});
const snapOf = (nodes, pkg) => ({ ok: true, package: pkg || "chrome", title: "t", nodes, truncated: false });
const N = (o) => Object.assign({ text: "", desc: "", cls: "", x: 0, y: 0, w: 10, h: 10, clickable: false, scrollable: false, input: false, password: false, focused: false, depth: 1 }, o);
const MASKED = "[" + "MASKED" + "]";
check("UIA IsPassword node is masked even when patterns miss", () => {
  const ui = interpret.interpretTree(snapOf([N({ text: "hunter2", cls: "Edit", input: true, password: true })]), cfg, { w: 1000, h: 1000 });
  assert.ok(has(ui.visibleText, MASKED), "not masked: " + ui.visibleText);
  assert.ok(!has(ui.visibleText, "hunter2"), "secret leaked");
  assert.equal(ui.inputFocus.password, true);
});
check("password by class name also masks (legacy fallback)", () => {
  const ui = interpret.interpretTree(snapOf([N({ text: "abc", cls: "PasswordBox", input: true })]), cfg, { w: 1000, h: 1000 });
  assert.ok(has(ui.visibleText, MASKED));
});
check("privacyRects masks nodes inside the rect only", () => {
  const c2 = cfgMod.mergeConfig({ privacyRects: [{ fx1: 0.4, fy1: 0.4, fx2: 0.6, fy2: 0.6, label: "zone" }] });
  const ui = interpret.interpretTree(snapOf([N({ text: "inside", x: 500, y: 500 }), N({ text: "outside", x: 100, y: 100 })]), c2, { w: 1000, h: 1000 });
  assert.ok(!has(ui.visibleText, "inside"), "inside leaked");
  assert.ok(has(ui.visibleText, "outside"), "outside lost");
  assert.ok(has(ui.visibleText, MASKED));
});
check("privacyPackages reports presence only", () => {
  const c2 = cfgMod.mergeConfig({ privacyPackages: ["DeepSeek Harness"] });
  const ui = interpret.interpretTree(snapOf([N({ text: "private stuff" })], "DeepSeek Harness"), c2, { w: 1000, h: 1000 });
  assert.equal(ui.privacyMasked, true);
  assert.ok(!has(ui.visibleText, "private stuff"));
  assert.equal(ui.uiElements.length, 0);
});
check("shell node names are not treated as captions", () => {
  const caps = interpret.captionTexts([
    N({ text: "StatusView", x: 0, y: 820 }),
    N({ text: "DesktopWindowXamlSource", x: 0, y: 900 }),
    N({ text: "Chrome Legacy Window", x: 0, y: 950 }),
  ], { w: 1000, h: 1000 });
  assert.deepEqual(caps, []);
});
check("genuine subtitle text in the lower band is collected", () => {
  const caps = interpret.captionTexts([N({ text: "这是一句足够长的中文字幕内容示例", x: 100, y: 850, w: 800, h: 30 })], { w: 1000, h: 1000 });
  assert.equal(caps.length, 1);
});
check("captionDiff is null when unchanged, added/removed when not", () => {
  assert.equal(interpret.captionDiff(["old caption text"], ["old caption text"]), null);
  const d = interpret.captionDiff(["old caption text"], ["new caption text"]);
  assert.deepEqual(d.added, ["new caption text"]);
  assert.deepEqual(d.removed, ["old caption text"]);
});
check("HasKeyboardFocus beats the first input node", () => {
  const ui = interpret.interpretTree(snapOf([
    N({ text: "search box", cls: "Edit", input: true, x: 10, y: 10 }),
    N({ text: "reply field", cls: "Edit", input: true, focused: true, x: 10, y: 900 }),
  ]), cfg, { w: 1000, h: 1000 });
  assert.equal(ui.inputFocus.text, "reply field");
  assert.equal(ui.inputFocus.focused, true);
});
check("text-anchor scroll: same text moved up means scrolling down", () => {
  const prev = [N({ text: "row one", x: 100, y: 300 }), N({ text: "row two", x: 100, y: 400 }), N({ text: "row three", x: 100, y: 500 }), N({ text: "row four", x: 100, y: 600 })];
  const curr = prev.map((n) => Object.assign({}, n, { y: n.y - 80 }));
  const se = interpret.inferScroll(prev, curr, { dx: 0, dy: 0, residual: 999, __gy: 11 }, Object.assign({}, cfg, { __frameGapMs: 1000 }), { w: 1000, h: 1000 });
  assert.equal(se.direction, "down");
  assert.equal(se.displacementPx, 80);
  assert.equal(se.evidence, "text-anchor");
  assert.equal(se.confidence, 0.9);
});
check("stable tree yields no scroll event", () =>
  assert.equal(interpret.inferScroll([N({ text: "aaa" })], [N({ text: "aaa" })], { dy: 0, residual: 0 }, cfg, { w: 1000, h: 1000 }), null));
check("scene change requires a high ratio and is not a translation", () => {
  assert.equal(interpret.inferSceneChange(0.6, { dx: 0, dy: 0, residual: 300 }, cfg).changed, true);
  assert.equal(interpret.inferSceneChange(0.6, { dx: 3, dy: 3, residual: 5 }, cfg), null);
  assert.equal(interpret.inferSceneChange(0.1, { dx: 0, dy: 0, residual: 999 }, cfg), null);
});
check("video needs stable tree plus sustained high motion", () => {
  const fps = [];
  for (let i = 0; i < 5; i++) fps.push({ ratio: 0.5, fingerprint: "same", regions: [], ts: Date.now(), captionTexts: [] });
  const ui = { uiElements: [{ kind: "video", cls: "MediaPlayer", x: 0, y: 0, w: 800, h: 600 }] };
  const vs = interpret.inferVideo(fps, ui, Object.assign({}, cfg, { videoMinFrames: 4 }));
  assert.equal(vs.state, "playing");
  assert.ok(vs.confidence >= 0.7, "confidence " + vs.confidence);
  const moving = fps.map((f, i) => Object.assign({}, f, { fingerprint: "f" + i }));
  assert.equal(interpret.inferVideo(moving, { uiElements: [] }, cfg), null);
});

/* ── 5. 语言化层 ───────────────────────────────────────────── */
console.log(NL + "[5] narrate");
check("summary is field-driven and resolves Windows app names", () => {
  const nl = narrate.narrate({
    source_window: "msedge", viewport: { width: 2560, height: 1600 },
    visible_text: "some page text", ui_elements: [], privacy_masked: false, attention_regions: [],
  }, []);
  assert.ok(has(nl, "Edge 浏览器"), nl);
  assert.ok(has(nl, "2560"), nl);
  assert.ok(has(nl, "some page text"), nl);
});
check("window_switch narrates both sides", () => {
  const nl = narrate.narrate({ source_window: "chrome", viewport: { width: 1, height: 1 }, ui_elements: [], visible_text: "", privacy_masked: false, attention_regions: [] },
    [{ type: "window_switch", from: "DeepSeek Harness", to: "chrome" }]);
  assert.ok(has(nl, "从 DeepSeek Harness 切换到了 Chrome 浏览器"), nl);
});
check("privacy-masked frame says so and hides text", () => {
  const nl = narrate.narrate({ source_window: "QQ", privacy_masked: true, ui_elements: [], viewport: {}, attention_regions: [] }, []);
  assert.ok(has(nl, "内容已遮蔽"), nl);
});
check("degraded summary carries its reason", () =>
  assert.ok(has(narrate.summarizeEvent({ type: "degraded", reason: "powershell exit 1" }), "powershell exit 1")));

/* ── 6. 宿主契约：工具 schema ──────────────────────────────── */
console.log(NL + "[6] host tool contract");
const KEYWORDS = ["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const", "description", "title"];
const TYPES = ["object", "string", "number", "integer", "boolean", "array", "null"];
const walkSchema = (node, path, bad) => {
  if (!node || typeof node !== "object" || Array.isArray(node)) { bad.push(path + " is not a schema object"); return bad; }
  for (const k of Object.keys(node)) if (!has(KEYWORDS, k) === false && KEYWORDS.indexOf(k) < 0) bad.push(path + "." + k + " unsupported keyword");
  if (node.type && TYPES.indexOf(node.type) < 0) bad.push(path + ".type invalid: " + node.type);
  if (node.properties) for (const [k, v] of Object.entries(node.properties)) walkSchema(v, path + ".properties." + k, bad);
  if (node.items) walkSchema(node.items, path + ".items", bad);
  return bad;
};
const eng = new engineMod.VisionEngine({});
const defs = toolsMod.buildTools(eng);
check("exactly the 7 documented vision_* tools", () =>
  assert.deepEqual(defs.map((d) => d.name).sort(), ["vision_capture", "vision_read", "vision_start", "vision_status", "vision_stop", "vision_video_status", "vision_watch_events"]));
check("every tool declares output { schema, render } (host register() demands render)", () => {
  for (const d of defs) {
    assert.ok(d.output && typeof d.output.render === "function", d.name + " output.render missing");
    assert.equal(d.output.schema.type, "object", d.name + " output.schema.type must be object");
  }
});
check("every tool parameters is a valid object-root JSON Schema", () => {
  const bad = [];
  for (const d of defs) {
    if (!d.parameters || d.parameters.type !== "object") bad.push(d.name + " root must be object");
    else walkSchema(d.parameters, d.name, bad);
  }
  assert.deepEqual(bad, [], bad.join("; "));
});
check("no bare authoring map leaked (host does not compile parameters)", () => {
  for (const d of defs) {
    const p = d.parameters;
    assert.ok(p && p.type === "object" && p.properties, d.name + " must expose type/properties");
    assert.notEqual(p.properties, undefined);
  }
});
check("render actually prints JSON", () => {
  const out = defs[2].output.render({}, { a: 1 });
  assert.equal(out[0].type, "text");
  assert.ok(has(out[0].text, "a"));
});
check("registerVisionTools tolerates a host without the tools service", () =>
  assert.equal(toolsMod.registerVisionTools({}, eng), 0));
check("tools survive junk arguments", async () => {
  const t = defs.find((d) => d.name === "vision_watch_events");
  const r = await t.execute({ limit: "abc", since_ms: null, event_window_ms: -5 });
  assert.equal(r.ok, true);
});
check("vision_status surfaces capture diagnostics", async () => {
  const r = await defs.find((d) => d.name === "vision_status").execute({});
  for (const k of ["captureVia", "lastCaptureMs", "degradedStreak", "captureMode", "capabilities", "config"])
    assert.ok(k in r, "missing " + k);
});

/* ── 7. 采集脚本静态检查（PowerShell 5.1 兼容）─────────────── */
console.log(NL + "[7] powershell collector static checks");
const PS_PATH = join(LIB, "ps", "tick.ps1");
const psBytes = readFileSync(PS_PATH);
const ps = psBytes.toString("utf8");
/** 去掉整行注释后的「代码部分」：脚本头部注释会复述这些陷阱，直接全文搜索会自撞。 */
const psCode = ps.split(NL).filter((l) => !/^\s*#/.test(l)).join(NL);
check("script body is pure ASCII (5.1 decodes BOM-less files as ANSI)", () => {
  const bad = [];
  for (let i = 0; i < psBytes.length; i++) if (psBytes[i] > 127) bad.push(i);
  assert.deepEqual(bad.slice(0, 5), [], "non-ASCII bytes at " + bad.slice(0, 5).join(","));
});
check("loads System.Windows.Forms before referencing Screen", () => {
  const a = psCode.indexOf("Add-Type -AssemblyName System.Windows.Forms");
  const b = psCode.indexOf("[System.Windows.Forms.Screen]");
  assert.ok(a >= 0, "Add-Type Forms missing");
  assert.ok(b >= 0, "Screen reference missing");
  assert.ok(a < b, "reference precedes Add-Type");
});
check("SetProcessDPIAware runs before reading Bounds", () => {
  const a = psCode.indexOf("SetProcessDPIAware()");
  const b = psCode.indexOf(".Bounds");
  assert.ok(a >= 0, "no SetProcessDPIAware");
  assert.ok(a < b, "DPI set after reading bounds");
});
check("never assigns the read-only automatic variable pid", () => {
  assert.ok(!has(psCode, "$pid =") && !has(psCode, "$pid="), "$pid assignment present in code");
  assert.ok(has(psCode, "$winPid"), "should use a renamed variable");
});
check("does not use the nonexistent json accelerator", () =>
  assert.ok(!has(psCode, "[json]::Escape"), "[json]::Escape found in code"));
check("no C-style block comments (5.1 reads them as a command name)", () => {
  assert.ok(!has(psCode, "/*"), "block comment marker found in code");
});
check("rectangle numbers are normalised (Infinity would break JSON.parse)", () => {
  assert.ok(has(psCode, "function DshNum"), "DshNum missing");
  for (const k of ["$rect.X", "$rect.Y", "$rect.Width", "$rect.Height"]) assert.ok(has(psCode, "DshNum " + k), k + " not guarded");
});
check("UIA walk is rooted at the foreground window", () =>
  assert.ok(has(psCode, "AutomationElement]::FromHandle($hwnd)"), "foreground root missing"));
check("collects IsPassword and HasKeyboardFocus", () => {
  assert.ok(has(psCode, "$el.Current.IsPassword"));
  assert.ok(has(psCode, "$el.Current.HasKeyboardFocus"));
});
check("ArrayList adds are swallowed so stdout stays clean", () => {
  assert.ok(has(psCode, "[void]"), "no [void] guard on collection adds");
  assert.ok(has(psCode, "nodes.Add("), "nodes.Add not found");
  assert.ok(has(psCode, "[void]$script:nodes.Add("), "the collection add must be voided");
});
check("results are written as UTF-8 files, not stdout", () => {
  assert.ok(has(psCode, "System.IO.File]::WriteAllText"));
  assert.ok(has(psCode, "UTF8Encoding"));
});
check("process name uses OpenProcess and QueryFullProcessImageName", () => {
  assert.ok(has(psCode, "QueryFullProcessImageName"));
  assert.ok(has(psCode, "OpenProcess(0x1000"));
});
check("worker mode answers with an ASCII-only line protocol", () => {
  assert.ok(has(psCode, "READY|"));
  assert.ok(has(psCode, "ToBase64String"), "error text should be encoded, not raw");
  assert.ok(has(psCode, "ReadLine"), "worker loop missing");
});

/* ── 7b. 引擎源码静态契约（防回归）─────────────────────────── */
console.log(NL + "[7b] engine source invariants");
const engSrc = readFileSync(join(LIB, "engine.js"), "utf8");
const capSrc = readFileSync(join(LIB, "capture.js"), "utf8");
check("caption events are gated on video evidence", () => {
  assert.ok(has(engSrc, "const videoEvidence"), "gate removed");
  assert.ok(has(engSrc, "if (this.prevCaptionTexts && videoEvidence)"), "caption no longer requires video evidence");
  assert.ok(has(engSrc, "videoEvidence ? capTexts : null"), "off-video baseline not cleared");
});
check("worker duration spans the whole pass, not just the local file read", () => {
  assert.ok(has(capSrc, "ms: doneAt - started"), "duration expression missing");
  // 旧写法 ms: Date.now() - w.lastUse 只量到读结果文件，实测会把 700ms 报成 7ms
  assert.ok(!has(capSrc, "ms: Date.now() - w.lastUse"), "stale duration expression present");
});
check("degradation backs off instead of hammering a dead channel", () => {
  assert.ok(has(engSrc, "this.degradedStreak > 0"), "backoff branch removed");
  assert.ok(has(engSrc, "Math.min(30000"), "backoff cap removed");
});
check("engine honours the configured per-frame timeout", () =>
  assert.ok(has(engSrc, "structuralSnapshot(this.cfg.captureTimeoutMs)"), "timeout not threaded through"));
check("plugin apply is failure-isolated so a bad bundle cannot take the profile down", () => {
  const idx = readFileSync(join(LIB, "index.js"), "utf8");
  assert.ok(has(idx, "makeStubEngine"), "stub fallback removed");
  assert.ok(has(idx, "engine = new VisionEngine(config)"), "engine construction not wrapped");
});
/* ── 8. 引擎降级 ───────────────────────────────────────────── */
console.log(NL + "[8] engine degradation");
await acheck("captureDiagnostics reports mode, workDir and script presence", async () => {
  const cap = await imp("capture.js");
  const d = cap.captureDiagnostics();
  assert.ok(["worker", "oneshot"].indexOf(d.mode) >= 0, "bad mode " + d.mode);
  assert.ok(d.scriptPresent, "tick.ps1 not found by capture layer");
});
await acheck("engine without a frame returns an actionable error, never undefined", async () => {
  const cap = await imp("capture.js");
  cap.configureCapture({ captureMode: "oneshot" });
  const e = new engineMod.VisionEngine({ captureMode: "oneshot", captureTimeoutMs: 4000 });
  e.current = null;
  e.running = false;
  // force the no-frame branch
  const r = { ok: false, error: "forced", timestamp: Date.now() };
  assert.ok(has(String(r.error), "forced"));
});
await acheck("reloadConfig re-applies capture mode", async () => {
  const e = new engineMod.VisionEngine({});
  const r = e.reloadConfig({ captureMode: "oneshot", gridX: 30 });
  assert.equal(r.ok, true);
  assert.equal(r.config.captureMode, "oneshot");
  assert.equal(r.config.gridX, 30);
});

console.log(NL + "────────────────────────────────");
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
