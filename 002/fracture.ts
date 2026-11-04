import { BufferAttribute, BufferGeometry } from "three";

const SPOKES = 15;
const R0_M = 0.028; // first ring, sets how fine the powder at the impact is
const RING_GROWTH = 1.42;
const MIN_AREA_M2 = 2e-5;
const FACE_RGBA = [0.92, 0.94, 0.9, 0.16]; // clear glass under the paint
const EDGE_RGBA = [0.3, 0.56, 0.5, 0.95]; // float glass reads green through its edge // float glass reads green through its edge

export interface Shard {
  x: number;
  y: number;
  area: number;
  r2: number;
  poly: number[]; // ccw, relative to x, y
}

// FRACTURE
// voronoi cells of seeds on a jittered polar grid read as radial cracks plus rings
export function fracture(w: number, h: number, px: number, py: number): Shard[] {
  const hw = w / 2;
  const hh = h / 2;
  const seeds = [px, py];
  const step = (Math.PI * 2) / SPOKES;
  const turn = Math.random() * step;
  const spokes: number[] = [];
  for (let k = 0; k < SPOKES; k++)
    spokes.push(turn + k * step + (Math.random() - 0.5) * step * 0.6);

  const reach = Math.hypot(w, h);
  for (let r = R0_M; r < reach; r *= RING_GROWTH * (0.9 + Math.random() * 0.2)) {
    for (const a0 of spokes) {
      const a = a0 + (Math.random() - 0.5) * step * 0.3;
      const rr = r * (0.85 + Math.random() * 0.3);
      const x = px + Math.cos(a) * rr;
      const y = py + Math.sin(a) * rr;
      if (Math.abs(x) < hw && Math.abs(y) < hh) seeds.push(x, y);
    }
  }

  const n = seeds.length / 2;
  const order: number[] = [];
  const shards: Shard[] = [];
  for (let i = 0; i < n; i++) {
    const sx = seeds[i * 2];
    const sy = seeds[i * 2 + 1];
    order.length = 0;
    for (let j = 0; j < n; j++) if (j !== i) order.push(j);
    const d2 = (j: number) => (seeds[j * 2] - sx) ** 2 + (seeds[j * 2 + 1] - sy) ** 2;
    order.sort((a, b) => d2(a) - d2(b));

    let poly = [-hw, -hh, hw, -hh, hw, hh, -hw, hh];
    for (const j of order) {
      const ox = seeds[j * 2];
      const oy = seeds[j * 2 + 1];
      // a neighbour further than twice the cell radius cannot cut it
      if (d2(j) > 4 * reach2(poly, sx, sy)) break;
      const nx = ox - sx;
      const ny = oy - sy;
      poly = clip(poly, nx, ny, (nx * (sx + ox)) / 2 + (ny * (sy + oy)) / 2);
      if (poly.length < 6) break;
    }
    const shard = cell(poly);
    if (shard) shards.push(shard);
  }
  return shards;
}

function reach2(poly: number[], sx: number, sy: number) {
  let m = 0;
  for (let k = 0; k < poly.length; k += 2)
    m = Math.max(m, (poly[k] - sx) ** 2 + (poly[k + 1] - sy) ** 2);
  return m;
}

// keeps the side where nx * x + ny * y <= c
function clip(poly: number[], nx: number, ny: number, c: number) {
  const out: number[] = [];
  const k = poly.length;
  for (let a = 0; a < k; a += 2) {
    const b = (a + 2) % k;
    const ax = poly[a];
    const ay = poly[a + 1];
    const bx = poly[b];
    const by = poly[b + 1];
    const da = nx * ax + ny * ay - c;
    const db = nx * bx + ny * by - c;
    if (da <= 0) out.push(ax, ay);
    if (da <= 0 !== db <= 0) {
      const t = da / (da - db);
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
  return out;
}

function cell(poly: number[]): Shard | null {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const k = poly.length;
  for (let i = 0; i < k; i += 2) {
    const j = (i + 2) % k;
    const cr = poly[i] * poly[j + 1] - poly[j] * poly[i + 1];
    a += cr;
    cx += (poly[i] + poly[j]) * cr;
    cy += (poly[i + 1] + poly[j + 1]) * cr;
  }
  a /= 2;
  if (a < MIN_AREA_M2) return null;
  cx /= 6 * a;
  cy /= 6 * a;
  const local: number[] = [];
  let r2 = 0;
  for (let i = 0; i < k; i += 2) {
    const x = poly[i] - cx;
    const y = poly[i + 1] - cy;
    local.push(x, y);
    r2 += x * x + y * y;
  }
  return { x: cx, y: cy, area: a, r2: r2 / (k / 2), poly: local };
}

// PRISM
// flat faces front and back, hard-normal walls so the cut edges catch light
// ox, oy place the piece on the pane, w, h map it onto the paint
export function prism(poly: number[], thick: number, ox: number, oy: number, w: number, h: number) {
  const k = poly.length / 2;
  const t = thick / 2;
  const vn = k * 6;
  const pos = new Float32Array(vn * 3);
  const nor = new Float32Array(vn * 3);
  const col = new Float32Array(vn * 4);
  const uv = new Float32Array(vn * 2);
  const idx: number[] = [];

  let v = 0;
  const put = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    c: number[],
  ) => {
    pos.set([x, y, z], v * 3);
    nor.set([nx, ny, nz], v * 3);
    col.set(c, v * 4);
    uv[v * 2] = (x + ox) / w + 0.5;
    uv[v * 2 + 1] = (y + oy) / h + 0.5;
    return v++;
  };

  for (let i = 0; i < k; i++) put(poly[i * 2], poly[i * 2 + 1], t, 0, 0, 1, FACE_RGBA);
  for (let i = 0; i < k; i++) put(poly[i * 2], poly[i * 2 + 1], -t, 0, 0, -1, FACE_RGBA);
  for (let i = 1; i < k - 1; i++) idx.push(0, i, i + 1, k, k + i + 1, k + i);

  for (let i = 0; i < k; i++) {
    const j = (i + 1) % k;
    const ax = poly[i * 2];
    const ay = poly[i * 2 + 1];
    const bx = poly[j * 2];
    const by = poly[j * 2 + 1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = (by - ay) / len;
    const ny = -(bx - ax) / len;
    const s = put(ax, ay, t, nx, ny, 0, EDGE_RGBA);
    put(bx, by, t, nx, ny, 0, EDGE_RGBA);
    put(bx, by, -t, nx, ny, 0, EDGE_RGBA);
    put(ax, ay, -t, nx, ny, 0, EDGE_RGBA);
    idx.push(s, s + 3, s + 1, s + 1, s + 3, s + 2);
  }

  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("normal", new BufferAttribute(nor, 3));
  g.setAttribute("color", new BufferAttribute(col, 4));
  g.setAttribute("uv", new BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
