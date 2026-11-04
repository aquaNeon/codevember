// SOFT BODY
// small-step xpbd: shell particles from an icosphere plus an interior lattice,
// distance links that yield plastically, one volume constraint over the shell,
// floor friction and particle self-collision so folded flaps land on top

export const SHAPE = { rx: 1.4, ry: 0.26, rz: 1.18, drop: 0.03 }; // a slack round, folds read better than on a thick lump

const SUBSTEPS = 8;
const GRAVITY = -16;
const DAMP_PER_S = 2.5; // lower = more wobble
const SHELL_COMPLIANCE = 6e-5;
const CORE_COMPLIANCE = 2e-4;
const VOLUME_COMPLIANCE = 0;
const YIELD = 0.04; // strain before the dough keeps its new shape
const PLASTIC_TAU_S = 0.05;
const REST_MIN = 0.45;
const REST_MAX = 1.6; // longest a link may plastically grow
const LIFT_MAX = 2.6; // highest a grab can lift, keeps the dough inside the surface grid
const CEIL_Y = 3.0; // a fling stops here instead of leaving the grid
const BACK_Z = -1.45; // invisible wall just behind the dough, it never drifts up the frame
const TEAR_MAX = 2.8; // longest a link may stretch at any moment, relative to its rest length
const LINK_SHELL_CORE = 0.32;
const LINK_CORE = 0.34;
const CORE_STEP = 0.2;
const RADIUS = 0.055;
const SKIP_COLLIDE = 0.4;
const STICK = 0.6; // how hard the bench holds a touching particle down, per substep
export const GRIP = { fold: 0.85, throw: 0.3, rest: 0.6 }; // sideways drag on the bench, per substep
const BREAK = 0.06;
const PIN_SLIP = 0.22; // how far a pinned base particle stretches sideways before it slips
const PIN_GIVE = 0.15; // share of the pull a pinned particle follows each substep // how far a stuck particle stretches before it lets go
const GRAB = { along: 0.85, deep: 0.38, tall: 0.6 }; // half sizes of the grabbed strip
const GRAB_PULL = 0.45;
const SLEEP_SPEED = 0.06;
const HASH_SIZE = 4096;
const TENSION = 0.02; // surface tension per substep, irons out spikes and creases
const SLUMP_TENSION = 0.024; // stronger while slumping, pulls thin strands back into the body
const FUSE_TAU_S = 4; // folded layers melt into each other once things slow down
const FUSE_SPEED = 0.6;
const SLUMP_S = 1.2; // after a release the dough flows a little and sinks into itself
const SLUMP_TAU_S = 2.5;
const COLLIDE_EVERY = 1; // less often is cheaper but layers jitter

export type Mesh = { pos: Float32Array; faces: Uint16Array };

export function icosphere(level: number): Mesh {
  const t = (1 + Math.sqrt(5)) / 2;
  const v: number[] = [
    -1,
    t,
    0,
    1,
    t,
    0,
    -1,
    -t,
    0,
    1,
    -t,
    0,
    0,
    -1,
    t,
    0,
    1,
    t,
    0,
    -1,
    -t,
    0,
    1,
    -t,
    t,
    0,
    -1,
    t,
    0,
    1,
    -t,
    0,
    -1,
    -t,
    0,
    1,
  ];
  let f: number[] = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1,
    8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];
  for (let i = 0; i < v.length; i += 3) {
    const l = Math.hypot(v[i], v[i + 1], v[i + 2]);
    v[i] /= l;
    v[i + 1] /= l;
    v[i + 2] /= l;
  }
  for (let s = 0; s < level; s++) {
    const cache = new Map<number, number>();
    const mid = (a: number, b: number) => {
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const x = v[a * 3] + v[b * 3],
        y = v[a * 3 + 1] + v[b * 3 + 1],
        z = v[a * 3 + 2] + v[b * 3 + 2];
      const l = Math.hypot(x, y, z);
      v.push(x / l, y / l, z / l);
      const i = v.length / 3 - 1;
      cache.set(key, i);
      return i;
    };
    const next: number[] = [];
    for (let i = 0; i < f.length; i += 3) {
      const a = f[i],
        b = f[i + 1],
        c = f[i + 2];
      const ab = mid(a, b),
        bc = mid(b, c),
        ca = mid(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    f = next;
  }
  return { pos: new Float32Array(v), faces: new Uint16Array(f) };
}

export class DoughSim {
  readonly n: number;
  readonly shellN: number;
  readonly faces: Uint16Array;
  readonly x: Float32Array;
  private p: Float32Array;
  private v: Float32Array;
  private spawn: Float32Array;
  private stuck: Uint8Array;
  private pin: Float32Array;
  private mem: Float32Array;
  private adjStart: Int32Array;
  private adj: Uint16Array;
  private avg: Float32Array;

  readonly ca: Uint16Array;
  readonly cb: Uint16Array;
  private rest: Float32Array;
  private rest0: Float32Array;
  private comp: Float32Array;

  private grad: Float32Array;
  private volume0 = 0;

  private cellStart = new Int32Array(HASH_SIZE + 1);
  private cellItems: Int32Array;
  private cellOf: Int32Array;

  private grabIdx: Int32Array;
  private grabW: Float32Array;
  private grabOff: Float32Array;
  private grabN = 0;
  private gx = 0;
  private gy = 0;
  private gz = 0;

  damp = DAMP_PER_S;
  speed = 0;
  // set by the gesture: heavy while folding, loose while throwing
  grip = GRIP.rest;
  // true while folding: the part on the bench is pinned instead of only dragged
  pinned = false;
  private slump = 0;

  constructor(shell: Mesh) {
    const { rx, ry, rz, drop } = SHAPE;
    const lift = ry + drop;
    const sN = shell.pos.length / 3;

    const pts: number[] = [];
    for (let i = 0; i < sN; i++) {
      // hand-rolled, not a perfect disc
      const sx = shell.pos[i * 3],
        sy = shell.pos[i * 3 + 1],
        sz = shell.pos[i * 3 + 2];
      const lump =
        1 +
        0.06 * Math.sin(3 * sx + 1.3) * Math.cos(2.4 * sz + 0.4) +
        0.035 * Math.sin(5 * sz - 2 * sx);
      pts.push(sx * rx * lump, sy * ry * lump + lift, sz * rz * lump);
    }
    for (let x = -rx; x <= rx; x += CORE_STEP) {
      for (let y = -ry; y <= ry; y += CORE_STEP) {
        for (let z = -rz; z <= rz; z += CORE_STEP) {
          const e = (x / (rx * 0.84)) ** 2 + (y / (ry * 0.78)) ** 2 + (z / (rz * 0.84)) ** 2;
          if (e < 1) pts.push(x, y + lift, z);
        }
      }
    }

    this.n = pts.length / 3;
    this.shellN = sN;
    this.faces = shell.faces;
    this.x = new Float32Array(pts);
    this.p = new Float32Array(pts);
    this.v = new Float32Array(this.n * 3);
    this.spawn = new Float32Array(pts);
    this.stuck = new Uint8Array(this.n);
    this.pin = new Float32Array(this.n * 3);
    this.mem = new Float32Array(pts);
    this.avg = new Float32Array(sN * 3);
    this.grad = new Float32Array(sN * 3);
    this.cellItems = new Int32Array(this.n);
    this.cellOf = new Int32Array(this.n);
    this.grabIdx = new Int32Array(this.n);
    this.grabW = new Float32Array(this.n);
    this.grabOff = new Float32Array(this.n * 3);

    // LINKS
    const a: number[] = [];
    const b: number[] = [];
    const c: number[] = [];
    const seen = new Set<number>();
    const f = shell.faces;
    for (let i = 0; i < f.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const i0 = f[i + k],
          i1 = f[i + ((k + 1) % 3)];
        const key = i0 < i1 ? i0 * 65536 + i1 : i1 * 65536 + i0;
        if (seen.has(key)) continue;
        seen.add(key);
        a.push(i0);
        b.push(i1);
        c.push(SHELL_COMPLIANCE);
      }
    }
    const deg = new Int32Array(sN + 1);
    for (let k = 0; k < a.length; k++) {
      deg[a[k]]++;
      deg[b[k]]++;
    }
    this.adjStart = new Int32Array(sN + 1);
    for (let i = 0; i < sN; i++) this.adjStart[i + 1] = this.adjStart[i] + deg[i];
    this.adj = new Uint16Array(this.adjStart[sN]);
    const fill = this.adjStart.slice(0, sN);
    for (let k = 0; k < a.length; k++) {
      this.adj[fill[a[k]]++] = b[k];
      this.adj[fill[b[k]]++] = a[k];
    }

    const d2 = (i: number, j: number) =>
      (pts[i * 3] - pts[j * 3]) ** 2 +
      (pts[i * 3 + 1] - pts[j * 3 + 1]) ** 2 +
      (pts[i * 3 + 2] - pts[j * 3 + 2]) ** 2;
    for (let i = 0; i < this.n; i++) {
      for (let j = Math.max(i + 1, sN); j < this.n; j++) {
        const lim = i < sN ? LINK_SHELL_CORE : LINK_CORE;
        if (d2(i, j) < lim * lim) {
          a.push(i);
          b.push(j);
          c.push(CORE_COMPLIANCE);
        }
      }
    }
    this.ca = new Uint16Array(a);
    this.cb = new Uint16Array(b);
    this.comp = new Float32Array(c);
    this.rest0 = new Float32Array(a.length);
    for (let k = 0; k < a.length; k++) this.rest0[k] = Math.sqrt(d2(a[k], b[k]));
    this.rest = this.rest0.slice();
    this.volume0 = this.volume(this.x);
  }

  get links() {
    return this.ca.length;
  }

  // STEP
  step(dt: number) {
    const h = dt / SUBSTEPS;
    const n = this.n;
    const { x, p, v } = this;
    const damp = Math.exp(-this.damp * h);

    let maxV2 = 0;
    for (let s = 0; s < SUBSTEPS; s++) {
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        v[o + 1] += GRAVITY * h;
        p[o] = x[o] + v[o] * h;
        p[o + 1] = x[o + 1] + v[o + 1] * h;
        p[o + 2] = x[o + 2] + v[o + 2] * h;
      }
      this.pull();
      this.links_(h);
      this.tension();
      this.keepVolume(h);
      if (s % COLLIDE_EVERY === COLLIDE_EVERY - 1) this.collide();
      this.floor();

      maxV2 = 0;
      for (let i = 0; i < n * 3; i += 3) {
        const vx = ((p[i] - x[i]) / h) * damp;
        const vy = ((p[i + 1] - x[i + 1]) / h) * damp;
        const vz = ((p[i + 2] - x[i + 2]) / h) * damp;
        v[i] = vx;
        v[i + 1] = vy;
        v[i + 2] = vz;
        x[i] = p[i];
        x[i + 1] = p[i + 1];
        x[i + 2] = p[i + 2];
        const s2 = vx * vx + vy * vy + vz * vz;
        if (s2 > maxV2) maxV2 = s2;
      }
    }
    this.yieldRest(dt);
    this.fuse(dt);
    if (this.slump > 0) this.slump -= dt;
    this.speed = Math.sqrt(maxV2);
    return this.grabN > 0 || this.slump > 0 || this.speed > SLEEP_SPEED;
  }

  private links_(h: number) {
    const { p, ca, cb, rest, comp } = this;
    const ih2 = 1 / (h * h);
    for (let k = 0; k < ca.length; k++) {
      const i = ca[k] * 3,
        j = cb[k] * 3;
      const dx = p[i] - p[j],
        dy = p[i + 1] - p[j + 1],
        dz = p[i + 2] - p[j + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-6) continue;
      // past the hard limit the link stops being soft, so a fast yank can't tear bits off
      const hard = len > rest[k] * TEAR_MAX;
      const corr = hard
        ? (len - rest[k] * TEAR_MAX) / (len * 2)
        : (len - rest[k]) / (len * (2 + comp[k] * ih2));
      p[i] -= dx * corr;
      p[i + 1] -= dy * corr;
      p[i + 2] -= dz * corr;
      p[j] += dx * corr;
      p[j + 1] += dy * corr;
      p[j + 2] += dz * corr;
    }
  }

  private volume(q: Float32Array) {
    const f = this.faces;
    let vol = 0;
    for (let t = 0; t < f.length; t += 3) {
      const a = f[t] * 3,
        b = f[t + 1] * 3,
        c = f[t + 2] * 3;
      vol +=
        q[a] * (q[b + 1] * q[c + 2] - q[b + 2] * q[c + 1]) +
        q[a + 1] * (q[b + 2] * q[c] - q[b] * q[c + 2]) +
        q[a + 2] * (q[b] * q[c + 1] - q[b + 1] * q[c]);
    }
    return vol / 6;
  }

  private keepVolume(h: number) {
    const { p, grad, faces: f } = this;
    grad.fill(0);
    let vol = 0;
    for (let t = 0; t < f.length; t += 3) {
      const a = f[t] * 3,
        b = f[t + 1] * 3,
        c = f[t + 2] * 3;
      const ax = p[a],
        ay = p[a + 1],
        az = p[a + 2];
      const bx = p[b],
        by = p[b + 1],
        bz = p[b + 2];
      const cx = p[c],
        cy = p[c + 1],
        cz = p[c + 2];
      const x1 = by * cz - bz * cy,
        y1 = bz * cx - bx * cz,
        z1 = bx * cy - by * cx;
      vol += ax * x1 + ay * y1 + az * z1;
      grad[a] += x1;
      grad[a + 1] += y1;
      grad[a + 2] += z1;
      grad[b] += cy * az - cz * ay;
      grad[b + 1] += cz * ax - cx * az;
      grad[b + 2] += cx * ay - cy * ax;
      grad[c] += ay * bz - az * by;
      grad[c + 1] += az * bx - ax * bz;
      grad[c + 2] += ax * by - ay * bx;
    }
    vol /= 6;
    let sum = 0;
    for (let i = 0; i < grad.length; i++) {
      grad[i] /= 6;
      sum += grad[i] * grad[i];
    }
    const lambda = -(vol - this.volume0) / (sum + VOLUME_COMPLIANCE / (h * h));
    for (let i = 0; i < grad.length; i++) p[i] += lambda * grad[i];
  }

  // SELF COLLISION
  // spatial hash, skips pairs that started close since links already hold those
  private cell(ix: number, iy: number, iz: number) {
    return (
      (Math.imul(ix, 92837111) ^ Math.imul(iy, 689287499) ^ Math.imul(iz, 283923481)) &
      (HASH_SIZE - 1)
    );
  }

  private collide() {
    const { p, mem, cellStart, cellItems, cellOf, n } = this;
    const size = RADIUS * 2;
    cellStart.fill(0);
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const c = this.cell(
        Math.floor(p[o] / size),
        Math.floor(p[o + 1] / size),
        Math.floor(p[o + 2] / size),
      );
      cellOf[i] = c;
      cellStart[c]++;
    }
    let acc = 0;
    for (let c = 0; c < HASH_SIZE; c++) {
      acc += cellStart[c];
      cellStart[c] = acc;
    }
    cellStart[HASH_SIZE] = acc;
    for (let i = 0; i < n; i++) cellItems[--cellStart[cellOf[i]]] = i;

    const min2 = size * size;
    const skip2 = SKIP_COLLIDE * SKIP_COLLIDE;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const ix = Math.floor(p[o] / size),
        iy = Math.floor(p[o + 1] / size),
        iz = Math.floor(p[o + 2] / size);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const c = this.cell(ix + dx, iy + dy, iz + dz);
            for (let e = cellStart[c]; e < cellStart[c + 1]; e++) {
              const j = cellItems[e];
              if (j <= i) continue;
              const q = j * 3;
              const ex = p[o] - p[q],
                ey = p[o + 1] - p[q + 1],
                ez = p[o + 2] - p[q + 2];
              const d2 = ex * ex + ey * ey + ez * ez;
              if (d2 >= min2 || d2 < 1e-12) continue;
              const ox = mem[o] - mem[q],
                oy = mem[o + 1] - mem[q + 1],
                oz = mem[o + 2] - mem[q + 2];
              if (ox * ox + oy * oy + oz * oz < skip2) continue;
              const d = Math.sqrt(d2);
              const push = ((size - d) / d) * 0.5;
              p[o] += ex * push;
              p[o + 1] += ey * push;
              p[o + 2] += ez * push;
              p[q] -= ex * push;
              p[q + 1] -= ey * push;
              p[q + 2] -= ez * push;
            }
          }
        }
      }
    }
  }

  // STICKY BENCH
  // a particle that touches the bench is pinned to that spot until pulled past BREAK, so lifting peels
  private floor() {
    const { p, x, n, stuck, pin } = this;
    const keep = 1 - STICK;
    const holding = this.pinned;
    const slip2 = PIN_SLIP * PIN_SLIP;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      if (p[o + 1] > CEIL_Y) p[o + 1] = CEIL_Y;
      if (p[o + 2] < BACK_Z) p[o + 2] = BACK_Z;
      if (p[o + 1] < RADIUS) {
        p[o + 1] = RADIUS;
        if (!stuck[i]) {
          stuck[i] = 1;
          pin[o] = p[o];
          pin[o + 2] = p[o + 2];
        }
      }
      if (!stuck[i]) continue;
      if (holding) {
        // pinned to where it landed; pulled past PIN_SLIP it slips and grips again further on
        const dx = p[o] - pin[o],
          dz = p[o + 2] - pin[o + 2];
        if (dx * dx + dz * dz > slip2) {
          pin[o] = p[o];
          pin[o + 2] = p[o + 2];
        } else {
          p[o] = pin[o] + dx * PIN_GIVE;
          p[o + 2] = pin[o + 2] + dz * PIN_GIVE;
        }
      } else {
        p[o] -= (p[o] - x[o]) * this.grip;
        p[o + 2] -= (p[o + 2] - x[o + 2]) * this.grip;
        pin[o] = p[o];
        pin[o + 2] = p[o + 2];
      }
      // upward: held until pulled past BREAK
      const dy = p[o + 1] - RADIUS;
      if (dy > BREAK) {
        stuck[i] = 0;
        continue;
      }
      p[o + 1] = RADIUS + dy * keep;
    }
  }

  // SURFACE TENSION
  // each shell particle eases toward the mean of its neighbours
  private tension() {
    const { p, adjStart, adj, avg, shellN } = this;
    for (let i = 0; i < shellN; i++) {
      let sx = 0,
        sy = 0,
        sz = 0;
      const a0 = adjStart[i],
        a1 = adjStart[i + 1];
      for (let e = a0; e < a1; e++) {
        const j = adj[e] * 3;
        sx += p[j];
        sy += p[j + 1];
        sz += p[j + 2];
      }
      const inv = 1 / (a1 - a0);
      avg[i * 3] = sx * inv;
      avg[i * 3 + 1] = sy * inv;
      avg[i * 3 + 2] = sz * inv;
    }
    const k = this.slump > 0 ? SLUMP_TENSION : TENSION;
    for (let i = 0; i < shellN * 3; i++) p[i] += (avg[i] - p[i]) * k;
  }

  // FUSE
  // collision memory drifts to the current shape, so layers that touch stop repelling and merge
  private fuse(dt: number) {
    if (this.grabN > 0 || this.speed > FUSE_SPEED) return;
    const k = 1 - Math.exp(-dt / FUSE_TAU_S);
    const { mem, x } = this;
    for (let i = 0; i < mem.length; i++) mem[i] += (x[i] - mem[i]) * k;
  }

  // PLASTICITY
  // links stretched past the yield point move their rest length toward the current one
  private yieldRest(dt: number) {
    const { x, ca, cb, rest, rest0 } = this;
    const k = 1 - Math.exp(-dt / PLASTIC_TAU_S);
    const creep = this.slump > 0 ? (1 - Math.exp(-dt / SLUMP_TAU_S)) / k : 0;
    for (let c = 0; c < ca.length; c++) {
      const i = ca[c] * 3,
        j = cb[c] * 3;
      const dx = x[i] - x[j],
        dy = x[i + 1] - x[j + 1],
        dz = x[i + 2] - x[j + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const r = rest[c];
      const hi = r * (1 + YIELD);
      const lo = r * (1 - YIELD);
      let t: number;
      if (len > hi) t = len / (1 + YIELD);
      else if (len < lo) t = len / (1 - YIELD);
      else if (creep > 0) t = r + (len - r) * creep;
      else continue;
      const base = rest0[c];
      const next = r + (t - r) * k;
      rest[c] = Math.min(base * REST_MAX, Math.max(base * REST_MIN, next));
    }
  }

  // INPUT
  // grabs a strip of the rim like a hand would: wide along the edge, shallow toward the middle
  grab(hx: number, hy: number, hz: number) {
    const { x, n } = this;
    let cx = 0,
      cz = 0;
    for (let i = 0; i < n * 3; i += 3) {
      cx += x[i];
      cz += x[i + 2];
    }
    cx /= n;
    cz /= n;
    let ux = hx - cx,
      uz = hz - cz;
    const ul = Math.hypot(ux, uz);
    // grabbed near the middle, fall back to a round patch
    const strip = ul > 0.3;
    if (strip) {
      ux /= ul;
      uz /= ul;
    }
    const { along, deep, tall } = GRAB;
    let g = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const dx = x[o] - hx,
        dy = x[o + 1] - hy,
        dz = x[o + 2] - hz;
      let e: number;
      if (strip) {
        const inward = dx * ux + dz * uz;
        const side = dx * -uz + dz * ux;
        e = (side / along) ** 2 + (inward / deep) ** 2 + (dy / tall) ** 2;
      } else e = (dx * dx + dy * dy + dz * dz) / (deep * deep * 2);
      if (e >= 1) continue;
      const f = 1 - e;
      this.grabIdx[g] = i;
      this.grabW[g] = f * f;
      this.grabOff[g * 3] = dx;
      this.grabOff[g * 3 + 1] = dy;
      this.grabOff[g * 3 + 2] = dz;
      g++;
    }
    this.grabN = g;
    this.gx = hx;
    this.gy = hy;
    this.gz = hz;
  }

  drag(tx: number, ty: number, tz: number) {
    this.gx = tx;
    this.gy = Math.min(LIFT_MAX, Math.max(ty, RADIUS * 2));
    this.gz = Math.max(tz, BACK_Z + 0.25);
  }

  release() {
    this.grabN = 0;
    this.grip = GRIP.rest;
    this.pinned = false;
    this.slump = SLUMP_S;
  }

  private pull() {
    const { p, grabIdx, grabW, grabOff } = this;
    for (let g = 0; g < this.grabN; g++) {
      const o = grabIdx[g] * 3;
      const k = grabW[g] * GRAB_PULL;
      p[o] += (this.gx + grabOff[g * 3] - p[o]) * k;
      p[o + 1] += (this.gy + grabOff[g * 3 + 1] - p[o + 1]) * k;
      p[o + 2] += (this.gz + grabOff[g * 3 + 2] - p[o + 2]) * k;
    }
  }

  reset(lift = 0) {
    const { x, p, spawn } = this;
    for (let i = 0; i < x.length; i += 3) {
      x[i] = p[i] = spawn[i];
      x[i + 1] = p[i + 1] = spawn[i + 1] + lift;
      x[i + 2] = p[i + 2] = spawn[i + 2];
    }
    this.mem.set(x);
    this.stuck.fill(0);
    this.v.fill(0);
    this.rest.set(this.rest0);
    this.grabN = 0;
    this.slump = SLUMP_S;
  }

  // push external points (the towel) out of the dough, using the hash from the last substep
  // mean particle position, written into out
  centroid(out: Float32Array) {
    const { x, n } = this;
    let cx = 0,
      cy = 0,
      cz = 0;
    for (let i = 0; i < n * 3; i += 3) {
      cx += x[i];
      cy += x[i + 1];
      cz += x[i + 2];
    }
    out[0] = cx / n;
    out[1] = cy / n;
    out[2] = cz / n;
  }
}
