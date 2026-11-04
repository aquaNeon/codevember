import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
} from "three";
import type { Blobs } from "./blobs";

// TEA TOWEL
// small-step pbd grid that drops over the resting dough and gets whipped off for a new dough

const SIDE = 36; // particles per edge
const SIZE = 2.9; // world units
const SUBSTEPS = 6;
const GRAVITY = -9;
const DAMP_PER_S = 3.2; // air drag, keeps the fall floaty
const STRETCH_COMPLIANCE = 1e-6;
const BEND_COMPLIANCE = 2e-4; // lower = stiffer linen
const SKIN_MARGIN = 0.4; // how far outside the drawn skin the towel rests, as a share of the iso level
const FLOOR_Y = 0.012;
const DROP_Y = 1.9;
const SETTLE_SPEED = 0.35; // below this for SETTLE_S the towel stops simulating
const SETTLE_S = 0.4;
const CONTACT_DAMP = 0.55;
const MAX_SPEED = 8;
const LAND_S = 1.2; // after this the drag ramps up so the towel goes still
const DRAG_RAMP = 10; // extra damping per second after landing
const DRAG_MAX = 25; // velocity kept per substep while touching dough or bench
const DOUGH_FRICTION = 0.6; // keeps the towel from sliding off the dough
const LIFT_PULL = 0.25;
const LIFT_SPEED = 6;
const GONE_Y = 6;
const TEX_PX = 512;

export class Cloth {
  readonly mesh: Mesh;
  private geo = new BufferGeometry();
  private mat: MeshStandardMaterial;
  private tex: CanvasTexture;
  private n = SIDE * SIDE;
  private x: Float32Array;
  private p: Float32Array;
  private v: Float32Array;
  private pre: Float32Array;
  private touch: Uint8Array;
  private calm = 0;
  private age = 0;
  private asleep = false;
  private pos: Float32Array;
  private nor: Float32Array;
  private ca: Uint16Array;
  private cb: Uint16Array;
  private rest: Float32Array;
  private comp: Float32Array;
  private liftT = 0;
  private lx = 0;
  private ly = 0;
  private lz = 0;

  covering = false;
  lifting = false;
  speed = 0;

  constructor() {
    const n = this.n;
    this.x = new Float32Array(n * 3);
    this.p = new Float32Array(n * 3);
    this.v = new Float32Array(n * 3);
    this.pre = new Float32Array(n * 3);
    this.touch = new Uint8Array(n);
    this.pos = new Float32Array(n * 3);
    this.nor = new Float32Array(n * 3);

    // LINKS
    // structural, shear and skip-one bend
    const a: number[] = [];
    const b: number[] = [];
    const c: number[] = [];
    const link = (i0: number, j0: number, i1: number, j1: number, comp: number) => {
      if (i1 < 0 || j1 < 0 || i1 >= SIDE || j1 >= SIDE) return;
      a.push(j0 * SIDE + i0);
      b.push(j1 * SIDE + i1);
      c.push(comp);
    };
    for (let j = 0; j < SIDE; j++) {
      for (let i = 0; i < SIDE; i++) {
        link(i, j, i + 1, j, STRETCH_COMPLIANCE);
        link(i, j, i, j + 1, STRETCH_COMPLIANCE);
        link(i, j, i + 1, j + 1, STRETCH_COMPLIANCE);
        link(i, j, i - 1, j + 1, STRETCH_COMPLIANCE);
        link(i, j, i + 2, j, BEND_COMPLIANCE);
        link(i, j, i, j + 2, BEND_COMPLIANCE);
      }
    }
    this.ca = new Uint16Array(a);
    this.cb = new Uint16Array(b);
    this.comp = new Float32Array(c);
    const cell = SIZE / (SIDE - 1);
    this.rest = new Float32Array(a.length);
    for (let k = 0; k < a.length; k++) {
      const di = (a[k] % SIDE) - (b[k] % SIDE);
      const dj = Math.floor(a[k] / SIDE) - Math.floor(b[k] / SIDE);
      this.rest[k] = Math.hypot(di, dj) * cell;
    }

    // MESH
    const uv = new Float32Array(n * 2);
    for (let j = 0; j < SIDE; j++) {
      for (let i = 0; i < SIDE; i++) {
        uv[(j * SIDE + i) * 2] = i / (SIDE - 1);
        uv[(j * SIDE + i) * 2 + 1] = j / (SIDE - 1);
      }
    }
    const idx = new Uint16Array((SIDE - 1) * (SIDE - 1) * 6);
    let t = 0;
    for (let j = 0; j < SIDE - 1; j++) {
      for (let i = 0; i < SIDE - 1; i++) {
        const q = j * SIDE + i;
        idx[t++] = q;
        idx[t++] = q + SIDE;
        idx[t++] = q + 1;
        idx[t++] = q + 1;
        idx[t++] = q + SIDE;
        idx[t++] = q + SIDE + 1;
      }
    }
    this.geo.setIndex(new BufferAttribute(idx, 1));
    this.geo.setAttribute("position", new BufferAttribute(this.pos, 3));
    this.geo.setAttribute("normal", new BufferAttribute(this.nor, 3));
    this.geo.setAttribute("uv", new BufferAttribute(uv, 2));

    this.tex = new CanvasTexture(towel());
    this.tex.colorSpace = SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.mat = new MeshStandardMaterial({ map: this.tex, roughness: 0.95, side: DoubleSide });
    this.mesh = new Mesh(this.geo, this.mat);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  // a little skewed so it never lands square
  drop(cx: number, cz: number) {
    const cell = SIZE / (SIDE - 1);
    const rot = 0.3;
    const cs = Math.cos(rot),
      sn = Math.sin(rot);
    const tilt = 0.04;
    for (let j = 0; j < SIDE; j++) {
      for (let i = 0; i < SIDE; i++) {
        const o = (j * SIDE + i) * 3;
        const u = i * cell - SIZE / 2;
        const w = j * cell - SIZE / 2;
        this.x[o] = cx + u * cs - w * sn;
        this.x[o + 1] = DROP_Y + u * tilt;
        this.x[o + 2] = cz + u * sn + w * cs;
      }
    }
    this.p.set(this.x);
    this.v.fill(0);
    this.covering = true;
    this.asleep = false;
    this.calm = 0;
    this.age = 0;
    this.lifting = false;
    this.mesh.visible = true;
    this.sync();
  }

  // yank the far edge up and away
  lift() {
    if (!this.covering || this.lifting) return;
    this.lifting = true;
    this.asleep = false;
    this.liftT = 0;
    const o = (SIDE - 1) * SIDE * 3;
    this.lx = this.x[o];
    this.ly = this.x[o + 1];
    this.lz = this.x[o + 2];
  }

  hide() {
    this.covering = false;
    this.lifting = false;
    this.mesh.visible = false;
  }

  // settle: the dough is still rising, so stay awake to follow it
  step(dt: number, skin: Blobs, doughMoving: boolean) {
    if (!this.mesh.visible) return false;
    if (this.asleep) {
      // dough can still creep below the sleep threshold; wake as soon as it reaches the towel
      if (!doughMoving && !skin.touches(this.x, this.n, SKIN_MARGIN * 0.5)) return false;
      this.asleep = false;
      this.calm = 0;
    }
    const h = dt / SUBSTEPS;
    const { x, p, v, n, ca, cb, rest, comp, touch } = this;
    this.age += dt;
    const drag = this.lifting ? 0 : Math.min(DRAG_MAX, Math.max(0, this.age - LAND_S) * DRAG_RAMP);
    const damp = Math.exp(-(DAMP_PER_S + drag) * h);
    const ih2 = 1 / (h * h);

    if (this.lifting) {
      this.liftT += dt;
      this.ly += LIFT_SPEED * dt;
      this.lz -= LIFT_SPEED * 0.6 * dt;
    }

    let maxV2 = 0;
    for (let s = 0; s < SUBSTEPS; s++) {
      for (let i = 0; i < n * 3; i += 3) {
        v[i + 1] += GRAVITY * h;
        p[i] = x[i] + v[i] * h;
        p[i + 1] = x[i + 1] + v[i + 1] * h;
        p[i + 2] = x[i + 2] + v[i + 2] * h;
      }
      if (this.lifting) {
        // far row follows the hand
        for (let i = 0; i < SIDE; i++) {
          const o = ((SIDE - 1) * SIDE + i) * 3;
          const off = (i - (SIDE - 1) / 2) * (SIZE / (SIDE - 1)) * 0.6;
          p[o] += (this.lx + off - p[o]) * LIFT_PULL;
          p[o + 1] += (this.ly - p[o + 1]) * LIFT_PULL;
          p[o + 2] += (this.lz - p[o + 2]) * LIFT_PULL;
        }
      }
      for (let k = 0; k < ca.length; k++) {
        const i = ca[k] * 3,
          j = cb[k] * 3;
        const dx = p[i] - p[j],
          dy = p[i + 1] - p[j + 1],
          dz = p[i + 2] - p[j + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-6) continue;
        const corr = (len - rest[k]) / (len * (2 + comp[k] * ih2));
        p[i] -= dx * corr;
        p[i + 1] -= dy * corr;
        p[i + 2] -= dz * corr;
        p[j] += dx * corr;
        p[j + 1] += dy * corr;
        p[j + 2] += dz * corr;
      }
      // particles the dough pushed out lose most of their sideways slide
      this.pre.set(p);
      skin.push(p, n, SKIN_MARGIN);
      const pre = this.pre;
      touch.fill(0);
      for (let i = 0; i < n * 3; i += 3) {
        if (p[i] === pre[i] && p[i + 1] === pre[i + 1] && p[i + 2] === pre[i + 2]) continue;
        touch[i / 3] = 1;
        p[i] -= (p[i] - x[i]) * DOUGH_FRICTION;
        p[i + 2] -= (p[i + 2] - x[i + 2]) * DOUGH_FRICTION;
      }
      for (let i = 0; i < n * 3; i += 3) {
        if (p[i + 1] < FLOOR_Y) {
          p[i + 1] = FLOOR_Y;
          touch[i / 3] = 1;
          p[i] -= (p[i] - x[i]) * 0.8;
          p[i + 2] -= (p[i + 2] - x[i + 2]) * 0.8;
        }
      }
      maxV2 = 0;
      for (let i = 0; i < n * 3; i += 3) {
        const dk = touch[i / 3] ? damp * CONTACT_DAMP : damp;
        const vx = ((p[i] - x[i]) / h) * dk;
        const vy = ((p[i + 1] - x[i + 1]) / h) * dk;
        const vz = ((p[i + 2] - x[i + 2]) / h) * dk;
        const s2 = vx * vx + vy * vy + vz * vz;
        const cap = s2 > MAX_SPEED * MAX_SPEED ? MAX_SPEED / Math.sqrt(s2) : 1;
        v[i] = vx * cap;
        v[i + 1] = vy * cap;
        v[i + 2] = vz * cap;
        x[i] = p[i];
        x[i + 1] = p[i + 1];
        x[i + 2] = p[i + 2];
        if (s2 * cap * cap > maxV2) maxV2 = s2 * cap * cap;
      }
    }
    this.speed = Math.sqrt(maxV2);
    this.sync();

    if (this.lifting && this.liftT > 0.4 && x[(SIDE >> 1) * SIDE * 3 + 1] > GONE_Y) this.hide();
    if (this.lifting) return true;
    this.calm = this.speed < SETTLE_SPEED ? this.calm + dt : 0;
    if (this.calm > SETTLE_S && !doughMoving) {
      this.asleep = true;
      v.fill(0);
      return false;
    }
    return true;
  }

  // GEOMETRY
  // positions plus grid normals from central differences
  private sync() {
    const { x, pos, nor } = this;
    pos.set(x);
    for (let j = 0; j < SIDE; j++) {
      for (let i = 0; i < SIDE; i++) {
        const o = (j * SIDE + i) * 3;
        const l = (j * SIDE + Math.max(i - 1, 0)) * 3,
          r = (j * SIDE + Math.min(i + 1, SIDE - 1)) * 3;
        const d = (Math.max(j - 1, 0) * SIDE + i) * 3,
          u = (Math.min(j + 1, SIDE - 1) * SIDE + i) * 3;
        const ax = x[r] - x[l],
          ay = x[r + 1] - x[l + 1],
          az = x[r + 2] - x[l + 2];
        const bx = x[u] - x[d],
          by = x[u + 1] - x[d + 1],
          bz = x[u + 2] - x[d + 2];
        let nx = by * az - bz * ay,
          ny = bz * ax - bx * az,
          nz = bx * ay - by * ax;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        nor[o] = nx;
        nor[o + 1] = ny;
        nor[o + 2] = nz;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }
}

// linen with a classic stripe near two edges
function towel() {
  const c = document.createElement("canvas");
  c.width = c.height = TEX_PX;
  const g = c.getContext("2d");
  if (!g) return c;
  g.fillStyle = "#f2ece1";
  g.fillRect(0, 0, TEX_PX, TEX_PX);
  // weave
  for (let i = 0; i < TEX_PX; i += 2) {
    g.fillStyle = `rgba(120,100,70,${0.03 + ((i * 7) % 5) * 0.008})`;
    g.fillRect(i, 0, 1, TEX_PX);
    g.fillRect(0, i, TEX_PX, 1);
  }
  const stripe = (at: number, w: number) => {
    g.fillStyle = "#2f4a86";
    g.fillRect(0, at * TEX_PX, TEX_PX, w * TEX_PX);
    g.fillRect(0, (1 - at - w) * TEX_PX, TEX_PX, w * TEX_PX);
  };
  stripe(0.07, 0.035);
  stripe(0.125, 0.012);
  return c;
}
