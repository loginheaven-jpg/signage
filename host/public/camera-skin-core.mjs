// 피부 확률과 실제 사진의 경계를 함께 사용한다. 얼굴 윤곽에서 효과를 잘라내지 않는다.
export const OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
const FEATURES = [
  [33,160,158,133,153,144], [362,385,387,263,373,380],
  [70,63,105,66,107,55,65,52,53,46], [336,296,334,293,300,276,283,282,295,285],
  [61,40,37,0,267,270,291,321,314,17,84,91]
];
export function ramp(a, b, value) {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function inside(x, y, polygon) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

// 얼굴과 연결되지 않은 손·팔 등은 보정하지 않는다. 어두운 턱의 낮은 확률도 연결에 사용한다.
export function connectedSkin(probability, width, height, face, bounds) {
  const kept = new Uint8Array(probability.length), queue = new Int32Array(probability.length);
  const outline = OVAL.map(i => ({ x: (face[i].x - bounds.x) / bounds.width * width, y: (face[i].y - bounds.y) / bounds.height * height }));
  let end = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x;
    if (probability[p] >= 90 && inside(x + 0.5, y + 0.5, outline)) { kept[p] = 1; queue[end++] = p; }
  }
  for (let start = 0; start < end; start++) {
    const p = queue[start], x = p % width, y = Math.floor(p / width);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy, n = ny * width + nx;
      if (nx >= 0 && nx < width && ny >= 0 && ny < height && !kept[n] && probability[n] >= 64) {
        kept[n] = 1; queue[end++] = n;
      }
    }
  }
  for (let p = 0; p < probability.length; p++) if (!kept[p]) probability[p] = 0;
  return probability;
}

function protectFeatures(alpha, tone, face, w, h) {
  const faceWidth = Math.hypot((face[454].x - face[234].x) * w, (face[454].y - face[234].y) * h);
  const feather = Math.max(2, faceWidth * 0.018);
  for (const indices of FEATURES) {
    const points = indices.map(i => ({ x: face[i].x * w, y: face[i].y * h }));
    const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length, cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    for (const p of points) { p.x = cx + (p.x - cx) * 1.1; p.y = cy + (p.y - cy) * 1.1; }
    const left = Math.max(0, Math.floor(Math.min(...points.map(p => p.x)) - feather)), right = Math.min(w, Math.ceil(Math.max(...points.map(p => p.x)) + feather));
    const top = Math.max(0, Math.floor(Math.min(...points.map(p => p.y)) - feather)), bottom = Math.min(h, Math.ceil(Math.max(...points.map(p => p.y)) + feather));
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const p = y * w + x;
      if (!alpha[p] && !tone[p]) continue;
      let distance = Infinity;
      if (inside(x + 0.5, y + 0.5, points)) distance = 0;
      else for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length], dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((x + 0.5 - a.x) * dx + (y + 0.5 - a.y) * dy) / (dx * dx + dy * dy || 1)));
        distance = Math.min(distance, Math.hypot(x + 0.5 - a.x - t * dx, y + 0.5 - a.y - t * dy));
      }
      const weight = ramp(0, feather, distance);
      alpha[p] *= weight; tone[p] *= weight;
    }
  }
}

export function skinMasks(regions, faces, source, w, h) {
  const alpha = new Uint8ClampedArray(w * h), tone = new Uint8ClampedArray(w * h);
  const range = new Float32Array(766);
  for (let d = 0; d < range.length; d++) range[d] = Math.exp(-d * d / (2 * 48 * 48));
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f], region = regions[f], { width: mw, height: mh, bounds, probability, guide } = region;
    const forehead = { x: face[10].x * w, y: face[10].y * h }, chin = { x: face[152].x * w, y: face[152].y * h };
    const fh = Math.max(1, Math.hypot(chin.x - forehead.x, chin.y - forehead.y)), ux = (chin.x - forehead.x) / fh, uy = (chin.y - forehead.y) / fh;
    const fw = Math.max(1, Math.hypot((face[454].x - face[234].x) * w, (face[454].y - face[234].y) * h));
    const cx = (face[454].x + face[234].x) / 2 * w, cy = (face[454].y + face[234].y) / 2 * h;
    const left = Math.max(0, Math.floor(bounds.x * w)), top = Math.max(0, Math.floor(bounds.y * h));
    const right = Math.min(w, Math.ceil((bounds.x + bounds.width) * w)), bottom = Math.min(h, Math.ceil((bounds.y + bounds.height) * h));
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const down = ((x - forehead.x) * ux + (y - forehead.y) * uy) / fh;
      const side = Math.abs((x - cx) * uy - (y - cy) * ux) / fw;
      // 턱(1.0)을 지나 목까지 유지하고, 옷에 닿기 전의 피부에서 완만하게 끝낸다.
      const area = (1 - ramp(1.3, 2.0, down)) * (1 - ramp(0.56, 0.82, side));
      if (!area) continue;
      const rx = Math.max(0, Math.min(mw - 1, ((x + 0.5) / w - bounds.x) / bounds.width * mw - 0.5));
      const ry = Math.max(0, Math.min(mh - 1, ((y + 0.5) / h - bounds.y) / bounds.height * mh - 0.5));
      const x0 = Math.floor(rx), y0 = Math.floor(ry), tx = rx - x0, ty = ry - y0, p = y * w + x, i = p * 4;
      let sum = 0, weights = 0, nearestColor = 765;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const n = (Math.min(mh - 1, y0 + dy) * mw + Math.min(mw - 1, x0 + dx)), j = n * 4;
        const diff = Math.abs(source[i] - guide[j]) + Math.abs(source[i + 1] - guide[j + 1]) + Math.abs(source[i + 2] - guide[j + 2]);
        nearestColor = Math.min(nearestColor, diff);
        const weight = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * Math.max(0.00001, range[diff]);
        sum += probability[n] / 255 * weight; weights += weight;
      }
      // 축소 지도에 사라진 가는 머리카락도 원본과 안내 영상의 색 차이로 보호한다.
      const affinity = Math.exp(-(Math.max(0, nearestColor - 30) ** 2) / (2 * 50 * 50));
      const skin = ramp(0.35, 0.88, sum / Math.max(0.00001, weights)) * affinity;
      tone[p] = Math.max(tone[p], 255 * skin * area);
      alpha[p] = Math.max(alpha[p], 255 * skin * area * (1 - ramp(1.12, 1.75, down)));
    }
  }
  // 사람이 겹쳐도 각 얼굴의 눈과 입을 보호한다.
  for (const face of faces) protectFeatures(alpha, tone, face, w, h);
  return { alpha, tone };
}

export function smoothSkin(source, alpha, w, h, faceWidth) {
  const radius = Math.max(3, Math.min(12, Math.round(faceWidth * 0.025))), spatial = [], range = new Float32Array(766);
  for (let d = -radius; d <= radius; d++) spatial.push(Math.exp(-d * d / (2 * (radius * 0.55) ** 2)));
  for (let d = 0; d < range.length; d++) range[d] = Math.exp(-d * d / (2 * 55 * 55));
  const horizontal = new Uint8ClampedArray(source), output = new Uint8ClampedArray(source);
  for (const across of [true, false]) {
    const input = across ? source : horizontal, target = across ? horizontal : output;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x, i = p * 4;
      if (!alpha[p]) continue;
      let weights = 0, r = 0, g = 0, b = 0;
      for (let d = -radius; d <= radius; d++) {
        const nx = across ? x + d : x, ny = across ? y : y + d;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const q = ny * w + nx, j = q * 4;
        const diff = Math.abs(input[i] - input[j]) + Math.abs(input[i + 1] - input[j + 1]) + Math.abs(input[i + 2] - input[j + 2]);
        // 머리카락·입술·배경 색을 피부의 평활화에 끌어오지 않는다.
        const weight = spatial[d + radius] * range[diff] * alpha[q] / 255;
        weights += weight; r += input[j] * weight; g += input[j + 1] * weight; b += input[j + 2] * weight;
      }
      if (weights) { target[i] = r / weights; target[i + 1] = g / weights; target[i + 2] = b / weights; }
    }
  }
  return output;
}

export function paintSkin(source, retouched, alpha, tone, strength, output) {
  const amount = Math.max(0, Math.min(100, Number(strength) || 0)) / 100;
  if (!amount) { output.set(source); return; }
  for (let p = 0, i = 0; i < source.length; p++, i += 4) {
    output[i + 3] = source[i + 3];
    const a = alpha[p] / 255 * amount, t = tone[p] / 255 * amount;
    if (!a && !t) { output[i] = source[i]; output[i + 1] = source[i + 1]; output[i + 2] = source[i + 2]; continue; }
    const r = source[i] + a * (retouched[i] - source[i]), g = source[i + 1] + a * (retouched[i + 1] - source[i + 1]), b = source[i + 2] + a * (retouched[i + 2] - source[i + 2]);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const lift = Math.min(16, 72 * (luma / 255) * (1 - luma / 255));
    // 흰색을 더하는 대신 색 비율을 유지한다. 얼굴과 목의 그늘에도 같은 톤 곡선을 쓴다.
    const gain = Math.min(1 + t * lift / Math.max(32, luma), 255 / Math.max(1, r, g, b));
    output[i] = r * gain; output[i + 1] = g * gain; output[i + 2] = b * gain;
  }
}
