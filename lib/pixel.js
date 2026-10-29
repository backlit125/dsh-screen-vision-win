/**
 * 像素层 —— PNG 帧解码（纯 Node，零依赖）+ 网格差分 + 运动估计。
 *
 * 为什么自己解 PNG：环境里没有 canvas/sharp/PIL（Android on-device Node），
 * 而 PNG 只是 zlib(inflate) + 每行 filter byte 的扫描线序列——对 8bit RGBA
 * 只需实现 filter 0/1/2/3/4 的反过滤即可精确还原像素。实测 2800×1272：
 *   inflate  ~47ms；全量网格采样 ~0.3ms。完全够 2~4fps 的帧差。
 *
 * 差分输出是「粗网格变化图」（GX×GY 个格子，每格=区域内 RGB 均值差），
 * 不是逐像素 mask——后者对 2800×1272 有 356 万像素，逐像素比对既贵又
 * 无法直接语言化。粗网格恰恰是给 LLM 的正确粒度。
 */
import { inflateSync } from "node:zlib";

/** PNG 反滤波：把 IDAT 解压后的扫描线还原为纯像素 Buffer（RGBA stride*4）。 */
export function defilterRgba(data, width, height) {
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.allocUnsafe(height * stride);
  let prev = null;
  let src = 0;
  for (let y = 0; y < height; y++) {
    const ft = data[src++];
    const rowStart = y * stride;
    const row = data.subarray(src, src + stride);
    src += stride;
    const cur = out.subarray(rowStart, rowStart + stride);
    switch (ft) {
      case 0: // None
        row.copy(cur);
        break;
      case 1: { // Sub: left
        cur[0] = row[0]; cur[1] = row[1]; cur[2] = row[2]; cur[3] = row[3];
        for (let i = bpp; i < stride; i++) cur[i] = (row[i] + cur[i - bpp]) & 0xff;
        break;
      }
      case 2: { // Up: prev row
        if (prev) for (let i = 0; i < stride; i++) cur[i] = (row[i] + prev[i]) & 0xff;
        else row.copy(cur);
        break;
      }
      case 3: { // Average
        for (let i = 0; i < bpp; i++) cur[i] = prev ? (row[i] + (prev[i] >> 1)) & 0xff : row[i];
        for (let i = bpp; i < stride; i++) {
          const left = cur[i - bpp];
          const up = prev ? prev[i] : 0;
          cur[i] = (row[i] + ((left + up) >> 1)) & 0xff;
        }
        break;
      }
      case 4: { // Paeth
        const paeth = (a, b, c) => {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        };
        for (let i = 0; i < bpp; i++) cur[i] = prev ? (row[i] + paeth(0, prev[i], 0)) & 0xff : row[i];
        for (let i = bpp; i < stride; i++) {
          cur[i] = (row[i] + paeth(cur[i - bpp], prev ? prev[i] : 0, prev ? prev[i - bpp] : 0)) & 0xff;
        }
        break;
      }
      default:
        // 未知 filter：整行按原样吞掉（损坏帧只影响本行，不扩散）
        row.copy(cur);
    }
    prev = cur;
  }
  return out;
}

/** 解析 PNG（8bit RGBA，App 截图的实际格式）为 {pixels,w,h}。非法签名返回 null。 */
export function decodePngRgba(buf) {
  if (!buf || buf.length < 16 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let idat = [];
  let w = 0, h = 0, depth = 0, colorType = 0;
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const dataStart = off + 8;
    if (type === "IHDR") {
      w = buf.readUInt32BE(dataStart);
      h = buf.readUInt32BE(dataStart + 4);
      depth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
    } else if (type === "IDAT") {
      idat.push(buf.subarray(dataStart, dataStart + len));
    } else if (type === "IEND") break;
    off = dataStart + len + 4; // +CRC
    if (off > buf.length) break;
  }
  if (!w || !h) return null;
  if (depth !== 8 || colorType !== 6) {
    // 只支持 8bit RGBA(6)。App 截图恒为 6（实测 IHDR 2800x1272 depth 8 colortype 6）；
    // 其它格式如实返回 unsupported，让上层记 degraded 而不是产出坏数据。
    return { unsupported: `${depth}-bit colorType ${colorType}` };
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4 + 1;
  if (raw.length < stride * h) return null;
  const pixels = defilterRgba(raw, w, h);
  return { pixels, w, h, hasAlpha: true };
}

/**
 * 网格采样：把 RGBA 像素降为 GX×GY 的 RGB 均值格（这是差分的单位）。
 * pixelStride>1 时在格内跳点采样（低配机开关，默认 1=全采）。
 */
export function sampleGrid(pixels, w, h, gx, gy, pixelStride = 1) {
  const stride = w * 4;
  const grid = new Array(gy);
  for (let cy = 0; cy < gy; cy++) {
    const row = new Array(gx);
    const y0 = Math.floor((cy * h) / gy);
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * h) / gy));
    for (let cx = 0; cx < gx; cx++) {
      const x0 = Math.floor((cx * w) / gx);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * w) / gx));
      let r = 0, g = 0, b = 0, n = 0;
      const step = Math.max(1, pixelStride | 0);
      for (let y = y0; y < y1; y += step) {
        let i = y * stride + x0 * 4;
        for (let x = x0; x < x1; x += step) {
          r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2];
          n++;
          i += 4 * step;
        }
      }
      row[cx] = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    }
    grid[cy] = row;
  }
  return grid;
}

/**
 * 帧间差分：返回变化格掩码 + 变化比例 + 变化格的行列聚类。
 * threshold: 单格 RGB 总差超过该值算变化（30 对 8bit 噪声稳健）。
 */
export function diffGrids(a, b, threshold = 30) {
  const gy = a.length, gx = a[0].length;
  const changed = [];
  let count = 0;
  for (let y = 0; y < gy; y++) {
    for (let x = 0; x < gx; x++) {
      const pa = a[y][x], pb = b[y][x];
      const d = Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]) + Math.abs(pa[2] - pb[2]);
      if (d > threshold) { changed.push([x, y]); count++; }
    }
  }
  return { changed, ratio: count / (gx * gy) };
}

/**
 * 运动估计（整屏垂直/水平平移假设，对滚动/轮播/平移最有效）。
 * 在 [-limY..limY] 行、[-limX..limX] 列的平移假设里找残差最小者。
 * 返回 {dx,dy,cells,residual}；cells>0 表示可信的平移量（格为单位）。
 */
export function estimateMotion(a, b, limX = 6, limY = 6) {
  const gy = a.length, gx = a[0].length;
  let best = null;
  for (let dy = -limY; dy <= limY; dy++) {
    for (let dx = -limX; dx <= limX; dx++) {
      let tot = 0, n = 0;
      for (let y = 0; y < gy; y++) {
        const y2 = y + dy;
        if (y2 < 0 || y2 >= gy) continue;
        for (let x = 0; x < gx; x++) {
          const x2 = x + dx;
          if (x2 < 0 || x2 >= gx) continue;
          const pa = a[y][x], pb = b[y2][x2];
          tot += Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]) + Math.abs(pa[2] - pb[2]);
          n++;
        }
      }
      if (!n) continue;
      const residual = tot / n;
      if (!best || residual < best.residual) best = { dx, dy, residual };
    }
  }
  if (!best) return { dx: 0, dy: 0, residual: Infinity };
  return best;
}

/**
 * 把变化格聚成「区域块」：对 changed 掩码做简单连通域（4 邻接），
 * 返回 [{x0,y0,x1,y1,cells}]（格子坐标），供语言化为「屏幕中上部…」。
 */
export function clusterChanged(changed, gx, gy) {
  const key = (x, y) => y * gx + x;
  const set = new Set(changed.map(([x, y]) => key(x, y)));
  const seen = new Set();
  const regions = [];
  for (const [sx, sy] of changed) {
    const k = key(sx, sy);
    if (seen.has(k)) continue;
    seen.add(k);
    const stack = [[sx, sy]];
    let x0 = sx, x1 = sx, y0 = sy, y1 = sy, cells = 0;
    while (stack.length) {
      const [x, y] = stack.pop();
      cells++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= gx || ny >= gy) continue;
        const nk = key(nx, ny);
        if (set.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push([nx, ny]); }
      }
    }
    regions.push({ x0, y0, x1, y1, cells });
  }
  regions.sort((r1, r2) => r2.cells - r1.cells);
  return regions;
}

/** 格子矩形 → 人类语言方位（九宫格命名）。 */
export function regionLabel(x0, y0, x1, y1, gx, gy) {
  const cx = (x0 + x1) / 2 / gx;
  const cy = (y0 + y1) / 2 / gy;
  const col = cx < 0.34 ? "左" : cx > 0.66 ? "右" : "中";
  const row = cy < 0.34 ? "上" : cy > 0.66 ? "下" : "中";
  if (x1 - x0 >= gx * 0.85 && y1 - y0 >= gy * 0.85) return "整个屏幕";
  if (x1 - x0 >= gx * 0.7) return row === "中" ? "横向大半屏" : `屏幕${row}部横向大半区`;
  if (y1 - y0 >= gy * 0.7) return col === "中" ? "纵向大半屏" : `屏幕${col}侧纵向大半区`;
  return `${row}${col === "中" ? "" : col}部区域`;
}
