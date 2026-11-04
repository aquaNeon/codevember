import {
  CanvasTexture,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShadowMaterial,
  Vector3,
  WebGLRenderer,
} from "three";
import { Cloth } from "./cloth";
import { DoughSim, icosphere } from "./sim";
import { Blobs } from "./blobs";

const MAX_DPR = 2;
const MAX_DT_S = 1 / 20;
const STEP_S = 1 / 60;
const MAX_STEPS = 2;
const SHELL_LEVEL = 3;
const FOV_DEG = 26;
const CAM_PITCH_RAD = 0.44;
const CAM_FIT = 3.9; // world width that must stay in frame
const TARGET_Y = 0.25;
const SETTLE_FRAMES = 30;
const FOLD_LIFT = 0.35;
const FOLD_TRAVEL = 0.45;
const FOLDS_TO_REST = 4;
const RISE = 1.12;
const TAP_MS = 220;
const TAP_PX = 6;
const SHADOW_PX = 1024;
const ROUGH = 0.72;
const DROP_Y = 3.4; // fresh dough falls in from above the frame
const OFFSCREEN_S = 0.45;
const EDGE_NDC = 1.0;
const LOST_SHARE = 0.3; // share of the dough outside the frame that counts as thrown away
const LOST_STRIDE = 6;
const FOLD_REACH = 2.2; // a fold only counts when released over the dough, not flung away
const DOUGH_COLOR = "#ecdcbf";
const CLOTH_DELAY_S = 1.1; // let the last fold slump before the towel lands

export type Phase = "fold" | "rest" | "covered";

// scratch, reused by input handlers
const ray = new Vector3();
const fwd = new Vector3();
const scratch = new Vector3();

export class Dough {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(FOV_DEG, 1, 0.1, 40);
  private sim: DoughSim;
  private surface = new Blobs();
  private material: MeshStandardMaterial;
  private blob: Mesh;
  private contact: Mesh;
  private contactTex: CanvasTexture;
  private cloth = new Cloth();
  private clothIn = 0;
  private disposables: { dispose(): void }[] = [];

  private raf = 0;
  private last = 0;
  private acc = 0;
  private offscreen = 0;
  private mid = new Float32Array(3);
  private visible = false;
  private sized = false;
  private ready = false;
  // the first frames only draw the spawn shape; physics wakes on the first touch, so load stays cheap
  private dormant = true;
  private quiet = 0;
  private reducedMotion: boolean;
  private cleanups: (() => void)[] = [];
  private rect = { left: 0, top: 0, width: 1, height: 1 };

  // GESTURE
  private pointer = -1;
  private downX = 0;
  private downY = 0;
  private downT = 0;
  private hx = 0;
  private hy = 0;
  private hz = 0;
  private maxLift = 0;
  private maxTravel = 0;
  private tx = 0;
  private tz = 0;
  private planeN = new Vector3();
  private planeD = 0;

  folds = 0;
  onState: (folds: number, phase: Phase) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const r = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    r.setClearColor(0x000000, 0);
    r.toneMapping = NeutralToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    this.renderer = r;

    // LIGHT
    const key = new DirectionalLight(0xfff2e2, 2.6);
    key.position.set(-4.2, 3.6, 2.2);
    key.castShadow = true;
    key.shadow.mapSize.set(SHADOW_PX, SHADOW_PX);
    key.shadow.radius = 6;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.04;
    const sc = key.shadow.camera;
    sc.left = -3;
    sc.right = 3;
    sc.top = 3;
    sc.bottom = -3;
    sc.near = 1;
    sc.far = 14;
    // no env map: hemisphere plus a cool fill reads the same on matte clay and skips the cube render
    const fill = new DirectionalLight(0xe6eeff, 0.7);
    fill.position.set(3.5, 2, 3);
    this.scene.add(key, fill, new HemisphereLight(0xfff8ee, 0xb8a58c, 1.6));

    // FLOOR
    // shadow only, the css backdrop shows through
    const floorGeo = new PlaneGeometry(30, 30);
    const floorMat = new ShadowMaterial({ color: 0x3a2c1c, opacity: 0.2 });
    const floor = new Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.disposables.push(floorGeo, floorMat);

    // contact shadow, a soft blob that tracks the dough footprint
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    if (g) {
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grad.addColorStop(0, "rgba(40,28,16,0.55)");
      grad.addColorStop(0.55, "rgba(40,28,16,0.18)");
      grad.addColorStop(1, "rgba(40,28,16,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
    }
    this.contactTex = new CanvasTexture(c);
    const contactGeo = new PlaneGeometry(1, 1);
    const contactMat = new MeshBasicMaterial({
      map: this.contactTex,
      transparent: true,
      depthWrite: false,
    });
    this.contact = new Mesh(contactGeo, contactMat);
    this.contact.rotation.x = -Math.PI / 2;
    this.contact.position.y = 0.002;
    this.contact.renderOrder = -1;
    this.scene.add(this.contact);
    this.disposables.push(this.contactTex, contactGeo, contactMat);

    // DOUGH
    const shell = icosphere(SHELL_LEVEL);
    this.sim = new DoughSim(shell);
    if (this.reducedMotion) this.sim.damp = 6;
    this.material = new MeshStandardMaterial({
      color: DOUGH_COLOR,
      roughness: ROUGH,
      vertexColors: true,
    });
    this.blob = new Mesh(this.surface.geometry, this.material);
    this.blob.castShadow = true;
    this.blob.receiveShadow = true;
    this.blob.frustumCulled = false;
    this.scene.add(this.blob, this.cloth.mesh);
    this.surface.update(this.sim.x, this.sim.n, this.sim.ca, this.sim.cb);
    this.disposables.push(this.surface, this.material, this.cloth);

    // compile off the main thread where the driver allows, first frame waits for it
    r.compileAsync(this.scene, this.camera)
      .catch(() => {})
      .then(() => {
        this.ready = true;
        this.wake();
      });

    // OBSERVERS
    const ro = new ResizeObserver(() => this.queueResize());
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      this.wake();
    });
    io.observe(canvas);
    const onVisibility = () => {
      this.last = 0;
      this.wake();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const opts = { passive: true };
    canvas.addEventListener("pointerdown", this.down, opts);
    canvas.addEventListener("pointermove", this.move, opts);
    canvas.addEventListener("pointerup", this.up, opts);
    canvas.addEventListener("pointercancel", this.up, opts);

    this.cleanups.push(
      () => ro.disconnect(),
      () => io.disconnect(),
      () => document.removeEventListener("visibilitychange", onVisibility),
      () => canvas.removeEventListener("pointerdown", this.down),
      () => canvas.removeEventListener("pointermove", this.move),
      () => canvas.removeEventListener("pointerup", this.up),
      () => canvas.removeEventListener("pointercancel", this.up),
    );
  }

  // PUBLIC
  reset() {
    this.dormant = false;
    this.sim.reset(DROP_Y);
    this.cloth.hide();
    this.clothIn = 0;
    this.offscreen = 0;
    this.restart();
  }

  private restart() {
    this.folds = 0;
    this.material.roughness = ROUGH;
    this.onState(0, "fold");
    this.quiet = 0;
    this.wake();
  }

  // INPUT
  private ray(cx: number, cy: number) {
    const r = this.rect;
    ray.set(((cx - r.left) / r.width) * 2 - 1, 1 - ((cy - r.top) / r.height) * 2, 0.5);
    ray.unproject(this.camera).sub(this.camera.position).normalize();
    return ray;
  }

  private down = (e: PointerEvent) => {
    if (this.pointer !== -1) return;
    // first touch on a covered dough whips the towel off and starts a new round
    if (this.cloth.covering) {
      if (!this.cloth.lifting) {
        this.cloth.lift();
        this.restart();
      }
      return;
    }
    const d = this.ray(e.clientX, e.clientY);
    const o = this.camera.position;
    if (!this.surface.pick(o.x, o.y, o.z, d.x, d.y, d.z)) return;
    const h = this.surface.hit;
    this.hx = h[0];
    this.hy = h[1];
    this.hz = h[2];
    this.pointer = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = "grabbing";
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.downT = performance.now();
    this.maxLift = 0;
    this.maxTravel = 0;

    // drag plane faces the camera, flattened so lifting reads as up
    this.camera.getWorldDirection(fwd);
    fwd.y *= 0.35;
    fwd.normalize();
    this.planeN.copy(fwd);
    this.planeD = -(fwd.x * this.hx + fwd.y * this.hy + fwd.z * this.hz);
    this.dormant = false;
    this.sim.grab(this.hx, this.hy, this.hz);
    this.quiet = 0;
    this.wake();
  };

  private move = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) {
      if (this.pointer === -1) this.hover(e);
      return;
    }
    const d = this.ray(e.clientX, e.clientY);
    const o = this.camera.position;
    const n = this.planeN;
    const den = n.x * d.x + n.y * d.y + n.z * d.z;
    if (Math.abs(den) < 1e-5) return;
    const t = -(n.x * o.x + n.y * o.y + n.z * o.z + this.planeD) / den;
    const tx = o.x + d.x * t;
    const ty = o.y + d.y * t;
    const tz = o.z + d.z * t;
    this.sim.drag(tx, ty, tz);
    this.tx = tx;
    this.tz = tz;
    this.maxLift = Math.max(this.maxLift, ty - this.hy);
    this.maxTravel = Math.max(this.maxTravel, Math.hypot(tx - this.hx, tz - this.hz));
    this.quiet = 0;
    this.wake();
  };

  private hover(e: PointerEvent) {
    const d = this.ray(e.clientX, e.clientY);
    const o = this.camera.position;
    this.canvas.style.cursor = this.surface.pick(o.x, o.y, o.z, d.x, d.y, d.z) ? "grab" : "";
  }

  private up = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    this.pointer = -1;
    this.canvas.style.cursor = "grab";
    this.sim.release();
    const tap =
      performance.now() - this.downT < TAP_MS &&
      Math.hypot(e.clientX - this.downX, e.clientY - this.downY) < TAP_PX;
    if (tap) {
      // squish toward where the camera looks
      this.camera.getWorldDirection(fwd);
      this.sim.poke(this.hx, this.hy, this.hz, fwd.x, fwd.y, fwd.z);
    } else if (
      this.maxLift > FOLD_LIFT &&
      this.maxTravel > FOLD_TRAVEL &&
      this.overDough() &&
      this.folds < FOLDS_TO_REST
    ) {
      this.folds++;
      this.material.roughness = ROUGH - (this.folds / FOLDS_TO_REST) * 0.22; // smoother with each fold
      const resting = this.folds === FOLDS_TO_REST;
      if (resting) {
        this.sim.rise(RISE);
        this.clothIn = CLOTH_DELAY_S;
      }
      this.onState(this.folds, resting ? "rest" : "fold");
    }
    this.quiet = 0;
    this.wake();
  };

  private overDough() {
    this.sim.centroid(this.mid);
    return Math.hypot(this.tx - this.mid[0], this.tz - this.mid[2]) < FOLD_REACH;
  }

  // LOOP
  private wake() {
    if (!this.raf && this.ready && this.visible && !document.hidden)
      this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible || document.hidden) return;
    const dt = this.last ? Math.min(MAX_DT_S, Math.max(0, now - this.last) / 1000) : STEP_S;
    this.last = now;
    if (!this.sized) this.resize();

    // fixed step keeps the sim identical at 60, 120 or throttled frame rates
    this.acc = this.dormant ? 0 : this.acc + dt;
    let active = false;
    let steps = 0;
    while (!this.dormant && this.acc >= STEP_S && steps < MAX_STEPS) {
      const moving = this.sim.step(STEP_S);
      active = this.cloth.step(STEP_S, this.surface, moving) || moving || active;
      this.acc -= STEP_S;
      steps++;
    }
    if (steps === MAX_STEPS) this.acc = 0;
    if (!steps && !this.dormant) active = true;
    if (!this.dormant && this.lost(dt)) active = true;

    // TOWEL
    if (this.clothIn > 0) {
      this.clothIn -= dt;
      active = true;
      if (this.clothIn <= 0) {
        this.sim.centroid(this.mid);
        this.cloth.drop(this.mid[0], this.mid[2]);
        this.onState(this.folds, "covered");
      }
    }

    this.surface.update(this.sim.x, this.sim.n, this.sim.ca, this.sim.cb);
    this.track();
    this.renderer.render(this.scene, this.camera);
    this.quiet = active ? 0 : this.quiet + 1;
    if (this.quiet < SETTLE_FRAMES) this.wake();
    else this.last = 0;
  };

  // THROWN OUT
  // a lump that stays outside the frame is replaced by a fresh one
  private lost(dt: number) {
    if (this.pointer !== -1) return false;
    const x = this.sim.x;
    let seen = 0;
    let gone = 0;
    for (let i = 0; i < this.sim.n * 3; i += 3 * LOST_STRIDE) {
      seen++;
      if (x[i + 1] > 1.5) continue; // still in the air, it will come back down
      scratch.set(x[i], x[i + 1], x[i + 2]).project(this.camera);
      if (Math.abs(scratch.x) > EDGE_NDC || Math.abs(scratch.y) > EDGE_NDC) gone++;
    }
    const out = gone > seen * LOST_SHARE;
    this.offscreen = out ? this.offscreen + dt : 0;
    if (this.offscreen > OFFSCREEN_S) this.reset();
    return out;
  }

  // contact blob follows the footprint of the bottom layer
  private track() {
    const x = this.sim.x;
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity,
      low = 0;
    for (let i = 0; i < this.sim.shellN * 3; i += 3) {
      if (x[i + 1] > 0.25) continue;
      low++;
      if (x[i] < minX) minX = x[i];
      if (x[i] > maxX) maxX = x[i];
      if (x[i + 2] < minZ) minZ = x[i + 2];
      if (x[i + 2] > maxZ) maxZ = x[i + 2];
    }
    const c = this.contact;
    c.visible = low > 0;
    if (!low) return;
    c.position.x = (minX + maxX) / 2;
    c.position.z = (minZ + maxZ) / 2;
    c.scale.set((maxX - minX) * 1.35 + 0.3, (maxZ - minZ) * 1.35 + 0.3, 1);
  }

  // RESIZE
  private queueResize() {
    this.sized = false;
    this.quiet = 0;
    this.wake();
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    this.rect.left = r.left;
    this.rect.top = r.top;
    this.rect.width = r.width || 1;
    this.rect.height = r.height || 1;
    const aspect = this.rect.width / this.rect.height;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
    this.renderer.setSize(this.rect.width, this.rect.height, false);

    // keep CAM_FIT world units across the narrow side
    const halfV = (FOV_DEG * Math.PI) / 360;
    const halfH = Math.atan(Math.tan(halfV) * aspect);
    const dist = CAM_FIT / 2 / Math.tan(Math.min(halfV, halfH));
    const cam = this.camera;
    cam.aspect = aspect;
    cam.position.set(0, TARGET_Y + Math.sin(CAM_PITCH_RAD) * dist, Math.cos(CAM_PITCH_RAD) * dist);
    cam.lookAt(0, TARGET_Y, 0);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.sized = true;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
