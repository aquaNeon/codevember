import type { Quaternion, Vector3 } from "three";
import type { Shard } from "./fracture";

export const DURATION_S = 3.6;
const REC_HZ = 60;
const SUB = 4;
const G_MPS2 = 7; // a touch under real gravity, reads better in slow scrubs
const WAVE_MPS = 4.5; // how fast the break travels out from the impact
const CRACK_MPS = 16;
const GAP_M = 0.004;
const BURST_MPS = 3.2;
const BASE_MPS = 0.2;
const FALLOFF_M = 0.34;
const SPIN_RAD_S = 2.5;
const SPIN_PER_MPS = 5;
const RESTITUTION = 0.22;
const FRICTION = 0.45;
const GROUND_DRAG = 1.4;
const GROUND_SPIN_DRAG = 3.5;
const FLATTEN = 5; // pulls slow, grounded shards onto a face
const SLEEP_MPS = 0.12;
const SLEEP_RAD_S = 0.3;
const SLEEP_STEPS = 24;
const FLIGHT_S = 0.2; // sling to glass at full power
const BALL_MPS = 9;
const BALL_KEEP = 0.35; // share of speed the ball keeps through the glass
const BALL_BOUNCE = 0.45;
const INTACT = 0;
const CRACKED = 1;
const FLYING = 2;

export interface Shot {
  x: number; // impact, pane coords
  y: number;
  power: number; // 0..1
  from: Vector3; // ball at release, world
}

export interface World {
  paneY: number;
  thick: number;
  wallZ: number;
  ballR: number;
}

// RECORDING
// simulated once, a few frames ahead of playback, then scrubbed freely
export class Burst {
  recorded = 0;
  private run: Iterator<void> | null = null;

  constructor(
    readonly n: number,
    readonly frames: number,
    readonly hitT: number,
    readonly pos: Float32Array,
    readonly rot: Float32Array,
    readonly ball: Float32Array,
  ) {}

  attach(run: Iterator<void>) {
    this.run = run;
  }

  get done() {
    return !this.run;
  }

  // seconds of the burst that can be shown yet
  get reach() {
    return this.run ? Math.max(0, this.recorded - 1) / REC_HZ : DURATION_S;
  }

  // records at least up to time t, then keeps going until the budget runs out
  advance(t: number, budgetMs: number) {
    const need = Math.ceil(t * REC_HZ) + 2;
    const end = performance.now() + budgetMs;
    while (this.run && (this.recorded < need || performance.now() < end))
      if (this.run.next().done) this.run = null;
  }

  sample(i: number, t: number, p: Vector3, q: Quaternion) {
    const last = Math.max(this.recorded - 1, 0);
    const f = Math.min(Math.max(t * REC_HZ, 0), last);
    const f0 = Math.floor(f);
    const f1 = Math.min(f0 + 1, last);
    const a = f - f0;
    const b = 1 - a;
    const n = this.n;
    const P = this.pos;
    const R = this.rot;
    const p0 = (f0 * n + i) * 3;
    const p1 = (f1 * n + i) * 3;
    p.set(P[p0] * b + P[p1] * a, P[p0 + 1] * b + P[p1 + 1] * a, P[p0 + 2] * b + P[p1 + 2] * a);
    const r0 = (f0 * n + i) * 4;
    const r1 = (f1 * n + i) * 4;
    const s =
      R[r0] * R[r1] + R[r0 + 1] * R[r1 + 1] + R[r0 + 2] * R[r1 + 2] + R[r0 + 3] * R[r1 + 3] < 0
        ? -a
        : a;
    q.set(
      R[r0] * b + R[r1] * s,
      R[r0 + 1] * b + R[r1 + 1] * s,
      R[r0 + 2] * b + R[r1 + 2] * s,
      R[r0 + 3] * b + R[r1 + 3] * s,
    ).normalize();
  }

  sampleBall(t: number, p: Vector3) {
    const last = Math.max(this.recorded - 1, 0);
    const f = Math.min(Math.max(t * REC_HZ, 0), last);
    const f0 = Math.floor(f);
    const f1 = Math.min(f0 + 1, last);
    const a = f - f0;
    const B = this.ball;
    p.set(
      B[f0 * 3] * (1 - a) + B[f1 * 3] * a,
      B[f0 * 3 + 1] * (1 - a) + B[f1 * 3 + 1] * a,
      B[f0 * 3 + 2] * (1 - a) + B[f1 * 3 + 2] * a,
    );
  }
}

export function simulate(shards: Shard[], shot: Shot, world: World) {
  const n = shards.length;
  const frames = Math.round(DURATION_S * REC_HZ) + 1;
  const { paneY, thick, wallZ, ballR } = world;
  const power = shot.power;
  const hitT = FLIGHT_S * (1.6 - 0.6 * power);
  const burst = new Burst(
    n,
    frames,
    hitT,
    new Float32Array(frames * n * 3),
    new Float32Array(frames * n * 4),
    new Float32Array(frames * 3),
  );

  const P = new Float32Array(n * 3);
  const V = new Float32Array(n * 3);
  const Q = new Float32Array(n * 4);
  const W = new Float32Array(n * 3);
  const M = new Float32Array(n);
  const I = new Float32Array(n);
  const TC = new Float32Array(n);
  const TL = new Float32Array(n);
  const DX = new Float32Array(n);
  const DY = new Float32Array(n);
  const S = new Float32Array(n);
  const state = new Uint8Array(n);
  const sleep = new Uint16Array(n);
  const cv = new Float32Array(3);
  const rn = new Float32Array(3);
  const h = thick / 2;

  for (let i = 0; i < n; i++) {
    const s = shards[i];
    P.set([s.x, paneY + s.y, 0], i * 3);
    Q[i * 4 + 3] = 1;
    M[i] = s.area;
    I[i] = s.area * (s.r2 * 0.5 + thick * thick);
    const dx = s.x - shot.x;
    const dy = s.y - shot.y;
    const d = Math.hypot(dx, dy);
    const a = Math.random() * Math.PI * 2;
    DX[i] = d > 1e-4 ? dx / d : Math.cos(a);
    DY[i] = d > 1e-4 ? dy / d : Math.sin(a);
    TC[i] = hitT + d / CRACK_MPS;
    TL[i] = hitT + d / WAVE_MPS + Math.random() * 0.04;
    S[i] = BASE_MPS + BURST_MPS * (0.35 + 0.65 * power) * Math.exp(-d / FALLOFF_M);
  }

  // BALL
  const fx = shot.from.x;
  const fy = shot.from.y;
  const fz = shot.from.z;
  const hx = shot.x;
  const hy = paneY + shot.y;
  const bp = new Float32Array([fx, fy, fz]);
  const dl = Math.hypot(hx - fx, hy - fy, fz) || 1;
  const keep = BALL_MPS * (0.5 + 0.5 * power) * BALL_KEEP;
  const bv = new Float32Array([
    ((hx - fx) / dl) * keep,
    ((hy - fy) / dl) * keep,
    (-fz / dl) * keep,
  ]);

  // contact against an axis plane with n = +axis, impulse at corner r
  function collide(i: number, axis: 1 | 2, depth: number, rx: number, ry: number, rz: number) {
    const i3 = i * 3;
    P[i3 + axis] += depth;
    const m = M[i];
    const inertia = I[i];
    const wx = W[i3];
    const wy = W[i3 + 1];
    const wz = W[i3 + 2];
    cv[0] = V[i3] + wy * rz - wz * ry;
    cv[1] = V[i3 + 1] + wz * rx - wx * rz;
    cv[2] = V[i3 + 2] + wx * ry - wy * rx;
    const vn = cv[axis];
    if (vn >= 0) return;
    // r x n
    rn[0] = axis === 1 ? -rz : ry;
    rn[1] = axis === 1 ? 0 : -rx;
    rn[2] = axis === 1 ? rx : 0;
    const rr = rn[0] * rn[0] + rn[1] * rn[1] + rn[2] * rn[2];
    const j = (-(1 + RESTITUTION) * vn) / (1 / m + rr / inertia);
    V[i3 + axis] += j / m;
    W[i3] += (rn[0] * j) / inertia;
    W[i3 + 1] += (rn[1] * j) / inertia;
    W[i3 + 2] += (rn[2] * j) / inertia;

    // FRICTION
    cv[axis] = 0;
    const st = Math.hypot(cv[0], cv[1], cv[2]);
    if (st < 1e-6) return;
    const jt = Math.min(FRICTION * j, st / (1 / m + (rx * rx + ry * ry + rz * rz) / inertia));
    const jx = (-cv[0] / st) * jt;
    const jy = (-cv[1] / st) * jt;
    const jz = (-cv[2] / st) * jt;
    V[i3] += jx / m;
    V[i3 + 1] += jy / m;
    V[i3 + 2] += jz / m;
    W[i3] += (ry * jz - rz * jy) / inertia;
    W[i3 + 1] += (rz * jx - rx * jz) / inertia;
    W[i3 + 2] += (rx * jy - ry * jx) / inertia;
  }

  const dt = 1 / (REC_HZ * SUB);

  function stepBall(t: number) {
    if (t < hitT) {
      // straight in with a slight lob
      const u = t / hitT;
      bp[0] = fx + (hx - fx) * u;
      bp[1] = fy + (hy - fy) * u + Math.sin(Math.PI * u) * 0.06;
      bp[2] = fz * (1 - u);
      return;
    }
    bv[1] -= G_MPS2 * dt;
    bp[0] += bv[0] * dt;
    bp[1] += bv[1] * dt;
    bp[2] += bv[2] * dt;
    if (bp[1] < ballR) {
      bp[1] = ballR;
      if (bv[1] < 0) bv[1] *= -BALL_BOUNCE;
      bv[0] *= 0.995;
      bv[2] *= 0.995;
    }
    if (bp[2] < wallZ + ballR) {
      bp[2] = wallZ + ballR;
      if (bv[2] < 0) bv[2] *= -BALL_BOUNCE;
    }
  }

  function stepShard(i: number, t: number) {
    if (sleep[i] >= SLEEP_STEPS) return;
    const i3 = i * 3;
    const i4 = i * 4;

    // CRACK
    // pieces shift apart a hair before they let go, so the break shows first
    if (state[i] < FLYING) {
      if (state[i] === INTACT && t >= TC[i]) {
        state[i] = CRACKED;
        P[i3] += DX[i] * GAP_M;
        P[i3 + 1] += DY[i] * GAP_M;
        P[i3 + 2] = (Math.random() - 0.5) * 0.004;
      }
      if (t < TL[i]) return;
      state[i] = FLYING;
      const s = S[i];
      V[i3] = DX[i] * s * 0.5 + (Math.random() - 0.5) * 0.2;
      V[i3 + 1] = DY[i] * s * 0.5 + s * 0.1 + (Math.random() - 0.5) * 0.2;
      V[i3 + 2] = -s * (0.5 + Math.random() * 0.6);
      const ax = Math.random() - 0.5;
      const ay = Math.random() - 0.5;
      const az = Math.random() - 0.5;
      const spin = (SPIN_RAD_S + s * SPIN_PER_MPS) / (Math.hypot(ax, ay, az) || 1);
      W[i3] = ax * spin;
      W[i3 + 1] = ay * spin;
      W[i3 + 2] = az * spin;
    }

    // FLIGHT
    V[i3 + 1] -= G_MPS2 * dt;
    P[i3] += V[i3] * dt;
    P[i3 + 1] += V[i3 + 1] * dt;
    P[i3 + 2] += V[i3 + 2] * dt;
    spinBy(Q, i4, W[i3] * dt, W[i3 + 1] * dt, W[i3 + 2] * dt);

    // CONTACT
    // deepest corner against floor and wall takes an impulse, a rough rigid body is plenty
    const poly = shards[i].poly;
    const qx = Q[i4];
    const qy = Q[i4 + 1];
    const qz = Q[i4 + 2];
    const qw = Q[i4 + 3];
    let lowY = Infinity;
    let lowZ = Infinity;
    let yx = 0;
    let yz = 0;
    let zx = 0;
    let zy = 0;
    for (let c = 0; c < poly.length; c += 2) {
      for (let side = -1; side <= 1; side += 2) {
        const vx = poly[c];
        const vy = poly[c + 1];
        const vz = side * h;
        // rotate (vx, vy, vz) by q
        const tx = 2 * (qy * vz - qz * vy);
        const ty = 2 * (qz * vx - qx * vz);
        const tz = 2 * (qx * vy - qy * vx);
        const wx = vx + qw * tx + (qy * tz - qz * ty);
        const wy = vy + qw * ty + (qz * tx - qx * tz);
        const wz = vz + qw * tz + (qx * ty - qy * tx);
        if (wy < lowY) {
          lowY = wy;
          yx = wx;
          yz = wz;
        }
        if (wz < lowZ) {
          lowZ = wz;
          zx = wx;
          zy = wy;
        }
      }
    }
    const wallDepth = wallZ - (P[i3 + 2] + lowZ);
    if (wallDepth > 0) collide(i, 2, wallDepth, zx, zy, lowZ);
    const floorDepth = -(P[i3 + 1] + lowY);
    if (floorDepth <= 0) {
      sleep[i] = 0;
      return;
    }
    collide(i, 1, floorDepth, yx, lowY, yz);

    const drag = Math.exp(-GROUND_DRAG * dt);
    const spinDrag = Math.exp(-GROUND_SPIN_DRAG * dt);
    V[i3] *= drag;
    V[i3 + 2] *= drag;
    W[i3] *= spinDrag;
    W[i3 + 1] *= spinDrag;
    W[i3 + 2] *= spinDrag;

    const speed = Math.hypot(V[i3], V[i3 + 1], V[i3 + 2]);
    if (speed < 0.5) flatten(Q, i4, 1 - Math.exp(-FLATTEN * dt));
    const turn = Math.hypot(W[i3], W[i3 + 1], W[i3 + 2]);
    if (speed < SLEEP_MPS && turn < SLEEP_RAD_S) sleep[i]++;
    else sleep[i] = 0;
    if (sleep[i] >= SLEEP_STEPS) {
      V.fill(0, i3, i3 + 3);
      W.fill(0, i3, i3 + 3);
    }
  }

  function* run() {
    let t = 0;
    for (let f = 0; f < frames; f++) {
      burst.pos.set(P, f * n * 3);
      burst.rot.set(Q, f * n * 4);
      burst.ball.set(bp, f * 3);
      burst.recorded = f + 1;
      yield;
      for (let k = 0; k < SUB; k++, t += dt) {
        stepBall(t);
        for (let i = 0; i < n; i++) stepShard(i, t);
      }
    }
  }

  burst.attach(run());
  return burst;
}

// q = rotation(w * dt) * q, first order
function spinBy(Q: Float32Array, o: number, wx: number, wy: number, wz: number) {
  const x = Q[o];
  const y = Q[o + 1];
  const z = Q[o + 2];
  const w = Q[o + 3];
  const nx = x + 0.5 * (wx * w + wy * z - wz * y);
  const ny = y + 0.5 * (-wx * z + wy * w + wz * x);
  const nz = z + 0.5 * (wx * y - wy * x + wz * w);
  const nw = w + 0.5 * (-wx * x - wy * y - wz * z);
  const l = Math.hypot(nx, ny, nz, nw);
  Q[o] = nx / l;
  Q[o + 1] = ny / l;
  Q[o + 2] = nz / l;
  Q[o + 3] = nw / l;
}

// turn the face normal a step toward straight up or straight down
function flatten(Q: Float32Array, o: number, k: number) {
  const x = Q[o];
  const y = Q[o + 1];
  const z = Q[o + 2];
  const w = Q[o + 3];
  // local +z in world
  const nx = 2 * (x * z + w * y);
  const ny = 2 * (y * z - w * x);
  const nz = 1 - 2 * (x * x + y * y);
  const up = ny >= 0 ? 1 : -1;
  // axis = n x (0, up, 0)
  const ax = -nz * up;
  const az = nx * up;
  const s = Math.hypot(ax, az);
  if (s < 1e-5) return;
  const angle = Math.atan2(s, ny * up) * k;
  spinBy(Q, o, (ax / s) * angle, 0, (az / s) * angle);
}
