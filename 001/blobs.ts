import { BufferAttribute, BufferGeometry } from "three";
import { edgeTable, triTable } from "three/examples/jsm/objects/MarchingCubes.js";

// METABALL SURFACE
// every particle splats a soft blob into a grid, marching cubes draws the iso surface.
// touching layers melt into one skin, so folds merge instead of passing through each other.

export const BLOB = {
  radius: 0.3, // kernel reach in world units
  iso: 0.42, // threshold, higher pulls the skin in
  blur: 2, // smoothing passes over the density, hides the individual blobs
  bridge: 0.36, // links longer than this are stretched and get filler blobs
  fill: 0.18, // spacing of the filler blobs
  fillMax: 350, // filler budget per frame, caps the cost of a very stretched dough
  cell: 0.06, // grid spacing, smaller is smoother and slower
};

const SIZE = [6.6, 3.4, 6.6]; // grid extent, it follows the dough so nothing gets clipped
const MAX_TRIS = 40000;
const PICK_FAR = 40; // longest pick ray in world units

// cube corners as (x, y, z) offsets, three's corner order
const CORNER = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const EDGE = [0, 1, 1, 2, 3, 2, 0, 3, 4, 5, 5, 6, 7, 6, 4, 7, 0, 4, 1, 5, 2, 6, 3, 7];

export class Blobs {
  readonly geometry = new BufferGeometry();
  private nx: number;
  private ny: number;
  private nz: number;
  private field: Float32Array;
  private tmp: Float32Array;
  private pos = new Float32Array(MAX_TRIS * 9);
  private nor = new Float32Array(MAX_TRIS * 9);
  // per cube scratch: 12 edge vertices and normals
  private ev = new Float32Array(36);
  private en = new Float32Array(36);
  private cv = new Float32Array(8);
  private gx = new Float32Array(8);
  private gy = new Float32Array(8);
  private gz = new Float32Array(8);
  // last touched box, so clearing stays local
  private box = new Int32Array([0, 0, 0, 0, 0, 0]);
  private span = new Int32Array(6);
  private min = new Float64Array(3); // world position of grid cell 0, snapped to whole cells

  constructor() {
    const c = BLOB.cell;
    this.nx = Math.ceil(SIZE[0] / c) + 1;
    this.ny = Math.ceil(SIZE[1] / c) + 1;
    this.nz = Math.ceil(SIZE[2] / c) + 1;
    this.min[0] = -SIZE[0] / 2;
    this.min[2] = -SIZE[2] / 2;
    this.field = new Float32Array(this.nx * this.ny * this.nz);
    this.tmp = new Float32Array(this.field.length);
    this.geometry.setAttribute("position", new BufferAttribute(this.pos, 3));
    this.geometry.setAttribute("normal", new BufferAttribute(this.nor, 3));
    this.geometry.setDrawRange(0, 0);
  }

  // links are optional: long ones get extra blobs along them so stretched strands stay continuous
  update(x: Float32Array, count: number, la?: Uint16Array, lb?: Uint16Array) {
    const { nx, ny, field, box, span } = this;
    const sxy = nx * ny;

    // CLEAR last box
    for (let k = box[2]; k <= box[5]; k++)
      for (let j = box[1]; j <= box[4]; j++)
        field.fill(0, k * sxy + j * nx + box[0], k * sxy + j * nx + box[3] + 1);

    // FOLLOW
    // centre the grid on the dough footprint, snapped so the skin does not shimmer as it moves
    let lo0 = Infinity,
      hi0 = -Infinity,
      lo2 = Infinity,
      hi2 = -Infinity;
    for (let i = 0; i < count; i++) {
      const px = x[i * 3],
        pz = x[i * 3 + 2];
      if (px < lo0) lo0 = px;
      if (px > hi0) hi0 = px;
      if (pz < lo2) lo2 = pz;
      if (pz > hi2) hi2 = pz;
    }
    if (count) {
      const c = BLOB.cell;
      this.min[0] = Math.round(((lo0 + hi0) / 2 - SIZE[0] / 2) / c) * c;
      this.min[2] = Math.round(((lo2 + hi2) / 2 - SIZE[2] / 2) / c) * c;
    }

    // SPLAT
    span[0] = nx;
    span[1] = ny;
    span[2] = this.nz;
    span[3] = 0;
    span[4] = 0;
    span[5] = 0;
    for (let i = 0; i < count; i++) this.splat(x[i * 3], x[i * 3 + 1], x[i * 3 + 2]);

    // BRIDGE
    // every stretched link gets filled; when the budget is tight the fill gets sparser, never skipped
    if (la && lb) {
      let total = 0;
      for (let k = 0; k < la.length; k++) {
        const len = this.linkLen(x, la[k], lb[k]);
        if (len > BLOB.bridge) total += len;
      }
      const gap = Math.max(BLOB.fill, total / BLOB.fillMax);
      for (let k = 0; k < la.length; k++) {
        const len = this.linkLen(x, la[k], lb[k]);
        if (len <= BLOB.bridge) continue;
        const i = la[k] * 3,
          j = lb[k] * 3;
        const steps = Math.max(2, Math.ceil(len / gap));
        for (let s2 = 1; s2 < steps; s2++) {
          const t = s2 / steps;
          this.splat(
            x[i] + (x[j] - x[i]) * t,
            x[i + 1] + (x[j + 1] - x[i + 1]) * t,
            x[i + 2] + (x[j + 2] - x[i + 2]) * t,
          );
        }
      }
    }

    if (span[0] > span[3]) {
      this.geometry.setDrawRange(0, 0);
      box.fill(0);
      return;
    }
    box.set(span);

    for (let p = 0; p < BLOB.blur; p++) this.smooth();

    // MARCH
    const { pos, nor, ev, en, cv, gx, gy, gz } = this;
    const iso = BLOB.iso;
    const c = BLOB.cell;
    const x0 = box[0],
      y0 = box[1],
      z0 = box[2],
      x1 = box[3],
      y1 = box[4],
      z1 = box[5];
    let v = 0;
    const limit = MAX_TRIS * 9;
    for (let k = z0 - 1; k <= z1; k++) {
      for (let j = y0 - 1; j <= y1; j++) {
        for (let i = x0 - 1; i <= x1; i++) {
          let idx = 0;
          for (let n = 0; n < 8; n++) {
            const q =
              (k + CORNER[n * 3 + 2]) * sxy + (j + CORNER[n * 3 + 1]) * nx + i + CORNER[n * 3];
            const f = field[q];
            cv[n] = f;
            if (f < iso) idx |= 1 << n;
          }
          const bits = edgeTable[idx];
          if (!bits) continue;

          // corner gradients, outward = toward lower field
          for (let n = 0; n < 8; n++) {
            const ci = i + CORNER[n * 3],
              cj = j + CORNER[n * 3 + 1],
              ck = k + CORNER[n * 3 + 2];
            const q = ck * sxy + cj * nx + ci;
            gx[n] = field[q - 1] - field[q + 1];
            gy[n] = field[q - nx] - field[q + nx];
            gz[n] = field[q - sxy] - field[q + sxy];
          }
          for (let e = 0; e < 12; e++) {
            if (!(bits & (1 << e))) continue;
            const a = EDGE[e * 2],
              b = EDGE[e * 2 + 1];
            const fa = cv[a],
              fb = cv[b];
            const t = Math.abs(fb - fa) > 1e-6 ? (iso - fa) / (fb - fa) : 0.5;
            ev[e * 3] = this.min[0] + (i + CORNER[a * 3] + (CORNER[b * 3] - CORNER[a * 3]) * t) * c;
            ev[e * 3 + 1] =
              this.min[1] +
              (j + CORNER[a * 3 + 1] + (CORNER[b * 3 + 1] - CORNER[a * 3 + 1]) * t) * c;
            ev[e * 3 + 2] =
              this.min[2] +
              (k + CORNER[a * 3 + 2] + (CORNER[b * 3 + 2] - CORNER[a * 3 + 2]) * t) * c;
            const ngx = gx[a] + (gx[b] - gx[a]) * t;
            const ngy = gy[a] + (gy[b] - gy[a]) * t;
            const ngz = gz[a] + (gz[b] - gz[a]) * t;
            const l = Math.sqrt(ngx * ngx + ngy * ngy + ngz * ngz) || 1;
            en[e * 3] = ngx / l;
            en[e * 3 + 1] = ngy / l;
            en[e * 3 + 2] = ngz / l;
          }
          const base = idx * 16;
          for (let m = 0; triTable[base + m] !== -1 && v < limit; m++) {
            const e = triTable[base + m] * 3;
            pos[v] = ev[e];
            pos[v + 1] = ev[e + 1];
            pos[v + 2] = ev[e + 2];
            nor[v] = en[e];
            nor[v + 1] = en[e + 1];
            nor[v + 2] = en[e + 2];
            v += 3;
          }
        }
      }
    }
    this.geometry.setDrawRange(0, v / 3);
    const pa = this.geometry.attributes.position as BufferAttribute;
    const na = this.geometry.attributes.normal as BufferAttribute;
    pa.clearUpdateRanges();
    na.clearUpdateRanges();
    pa.addUpdateRange(0, v);
    na.addUpdateRange(0, v);
    pa.needsUpdate = true;
    na.needsUpdate = true;
  }

  private linkLen(x: Float32Array, a: number, b: number) {
    const i = a * 3,
      j = b * 3;
    const dx = x[j] - x[i],
      dy = x[j + 1] - x[i + 1],
      dz = x[j + 2] - x[i + 2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private splat(px: number, py: number, pz: number) {
    const { nx, ny, nz, field, span } = this;
    const c = BLOB.cell;
    const R = BLOB.radius;
    const R2 = R * R;
    const reach = Math.ceil(R / c);
    const sxy = nx * ny;
    const ci = Math.round((px - this.min[0]) / c),
      cj = Math.round((py - this.min[1]) / c),
      ck = Math.round((pz - this.min[2]) / c);
    // leave a one cell border empty so the skin always closes, the floor layer stays empty too
    const a0 = Math.max(1, ci - reach),
      a1 = Math.min(nx - 2, ci + reach);
    const b0 = Math.max(1, cj - reach),
      b1 = Math.min(ny - 2, cj + reach);
    const d0 = Math.max(1, ck - reach),
      d1 = Math.min(nz - 2, ck + reach);
    if (a0 > a1 || b0 > b1 || d0 > d1) return;
    if (a0 < span[0]) span[0] = a0;
    if (b0 < span[1]) span[1] = b0;
    if (d0 < span[2]) span[2] = d0;
    if (a1 > span[3]) span[3] = a1;
    if (b1 > span[4]) span[4] = b1;
    if (d1 > span[5]) span[5] = d1;
    for (let k = d0; k <= d1; k++) {
      const dz = this.min[2] + k * c - pz;
      const dz2 = dz * dz;
      if (dz2 >= R2) continue;
      for (let j = b0; j <= b1; j++) {
        const dy = this.min[1] + j * c - py;
        const dyz = dy * dy + dz2;
        if (dyz >= R2) continue;
        const row = k * sxy + j * nx;
        for (let i = a0; i <= a1; i++) {
          const dx = this.min[0] + i * c - px;
          const d2 = dx * dx + dyz;
          if (d2 >= R2) continue;
          const t = 1 - d2 / R2;
          field[row + i] += t * t * t;
        }
      }
    }
  }

  // PICK
  // marches a ray through the field so grabbing matches the skin you see
  readonly hit = new Float32Array(3);

  pick(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
    const step = BLOB.cell * 0.5;
    const iso = BLOB.iso;
    let prev = 0;
    for (let t = 0; t < PICK_FAR; t += step) {
      const f = this.sample(ox + dx * t, oy + dy * t, oz + dz * t);
      if (f >= iso) {
        // linear refine between the last two samples
        const back = f > prev ? (f - iso) / (f - prev) : 0;
        const th = t - step * back;
        this.hit[0] = ox + dx * th;
        this.hit[1] = oy + dy * th;
        this.hit[2] = oz + dz * th;
        return true;
      }
      prev = f;
    }
    return false;
  }

  private sample(x: number, y: number, z: number) {
    const { nx, ny, nz, field } = this;
    const c = BLOB.cell;
    const fx = (x - this.min[0]) / c,
      fy = (y - this.min[1]) / c,
      fz = (z - this.min[2]) / c;
    const i = Math.floor(fx),
      j = Math.floor(fy),
      k = Math.floor(fz);
    if (i < 0 || j < 0 || k < 0 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1) return 0;
    const tx = fx - i,
      ty = fy - j,
      tz = fz - k;
    const sxy = nx * ny;
    const b = k * sxy + j * nx + i;
    const x00 = field[b] + (field[b + 1] - field[b]) * tx;
    const x10 = field[b + nx] + (field[b + nx + 1] - field[b + nx]) * tx;
    const x01 = field[b + sxy] + (field[b + sxy + 1] - field[b + sxy]) * tx;
    const x11 = field[b + sxy + nx] + (field[b + sxy + nx + 1] - field[b + sxy + nx]) * tx;
    const y0 = x00 + (x10 - x00) * ty;
    const y1 = x01 + (x11 - x01) * ty;
    return y0 + (y1 - y0) * tz;
  }

  // OUTSIDE
  // pushes points (the towel) out of the drawn skin: trilinear field sample, newton steps along the gradient
  push(q: Float32Array, count: number, margin: number) {
    const { nx, ny, nz, field } = this;
    const c = BLOB.cell;
    const sxy = nx * ny;
    const target = BLOB.iso * (1 - margin);
    for (let p = 0; p < count; p++) {
      const o = p * 3;
      for (let it = 0; it < 2; it++) {
        const fx = (q[o] - this.min[0]) / c,
          fy = (q[o + 1] - this.min[1]) / c,
          fz = (q[o + 2] - this.min[2]) / c;
        const i = Math.floor(fx),
          j = Math.floor(fy),
          k = Math.floor(fz);
        if (i < 0 || j < 0 || k < 0 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1) break;
        const tx = fx - i,
          ty = fy - j,
          tz = fz - k;
        const b = k * sxy + j * nx + i;
        const f000 = field[b],
          f100 = field[b + 1],
          f010 = field[b + nx],
          f110 = field[b + nx + 1];
        const f001 = field[b + sxy],
          f101 = field[b + sxy + 1],
          f011 = field[b + sxy + nx],
          f111 = field[b + sxy + nx + 1];
        const x00 = f000 + (f100 - f000) * tx,
          x10 = f010 + (f110 - f010) * tx;
        const x01 = f001 + (f101 - f001) * tx,
          x11 = f011 + (f111 - f011) * tx;
        const y0 = x00 + (x10 - x00) * ty,
          y1 = x01 + (x11 - x01) * ty;
        const f = y0 + (y1 - y0) * tz;
        if (f <= target) break;
        // analytic gradient of the trilinear cell, per world unit
        const gx =
          ((f100 - f000) * (1 - ty) * (1 - tz) +
            (f110 - f010) * ty * (1 - tz) +
            (f101 - f001) * (1 - ty) * tz +
            (f111 - f011) * ty * tz) /
          c;
        const gy = ((x10 - x00) * (1 - tz) + (x11 - x01) * tz) / c;
        const gz = (y1 - y0) / c;
        const g2 = gx * gx + gy * gy + gz * gz;
        if (g2 < 1e-8) break;
        const k2 = (f - target) / g2;
        q[o] -= gx * k2;
        // never press down into the bench, that traps the towel between two pushes
        if (gy < 0) q[o + 1] -= gy * k2;
        q[o + 2] -= gz * k2;
      }
    }
  }

  // BLUR
  // separable 1-2-1 pass along each axis, only inside the touched box
  private smooth() {
    const { nx, ny, nz, field, tmp, box } = this;
    box[0] = Math.max(1, box[0] - 1);
    box[1] = Math.max(1, box[1] - 1);
    box[2] = Math.max(1, box[2] - 1);
    box[3] = Math.min(nx - 2, box[3] + 1);
    box[4] = Math.min(ny - 2, box[4] + 1);
    box[5] = Math.min(nz - 2, box[5] + 1);
    this.pass(field, tmp, 1);
    this.pass(tmp, field, nx);
    this.pass(field, tmp, nx * ny);
    this.pass(tmp, field, 0);
  }

  // step 0 is a plain copy back
  private pass(src: Float32Array, dst: Float32Array, step: number) {
    const { nx, ny, box } = this;
    const sxy = nx * ny;
    for (let k = box[2]; k <= box[5]; k++)
      for (let j = box[1]; j <= box[4]; j++) {
        const row = k * sxy + j * nx;
        for (let i = box[0]; i <= box[3]; i++) {
          const q = row + i;
          dst[q] = step ? (src[q - step] + 2 * src[q] + src[q + step]) * 0.25 : src[q];
        }
      }
  }

  dispose() {
    this.geometry.dispose();
  }
}
