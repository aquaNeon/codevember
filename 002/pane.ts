import {
  BatchedMesh,
  Color,
  DirectionalLight,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShadowMaterial,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  RingGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
  DoubleSide,
  type BufferGeometry,
  type Texture,
  type Material,
} from "three";
import { fracture, prism } from "./fracture";
import { Burst, DURATION_S, simulate } from "./burst";
import { Sling } from "./sling";
import { PANE_H, PANE_W } from "./art";
import { paint } from "./paint";

const MAX_DPR = 2;
const MAX_DT_S = 1 / 20;
const FOV_DEG = 30;
const CAM_PITCH_RAD = 0.22;
const CAM_FIT = 4.4; // world width that must stay in frame
const TARGET_Y = 0.95;
const PANE_T = 0.02;
const PANE_Y = 1.38;
const WALL_Z = -40; // no wall, pieces fly free
const BALL_R = 0.045;
const REST = new Vector3(0, 1.08, 3.6); // empty pouch, between camera and glass
const MAX_PULL_M = 0.42;
const MIN_PULL_M = 0.05;
const PULL_BACK = 0.8; // pouch comes toward you as you draw
const AIM_GAIN = 2.6;
const AIM_MARGIN_M = 0.08;
const TAP_MS = 260;
const TAP_PX = 6;
const HOLD_MS = 160; // press longer than this and time runs backward
const HOLD_RATE = 1.6;
const REWIND_RATE = 2.4;
const KEY_STEP_S = 0.1;
const SHADOW_PX = 1024;
const FLOOR_LIFT_M = "0.002";
const LIGHT_STRENGTH = "0.24"; // how strongly the glass colours the floor
const PRISM_UV = "0.004"; // how far the floor light splits into red, green and blue
const DISPERSION = "0.7"; // how much reflections break into a spectrum
const SHEEN = "0.6"; // window streak strength
const SHEEN_AT = ["-0.02", "0.08"]; // where the wide and thin streak sit across the pane
const LIGHT_CLEAR = "0.02";
const LIGHT_DARKEN = "0.85";
const GLOW = 0.3; // how much the coloured glass glows
const SIM_BUDGET_MS = 3; // simulation work allowed per frame

export type Phase = "whole" | "aiming" | "flying" | "held" | "mending";
const PHASES: Phase[] = ["whole", "aiming", "flying", "held", "mending"];

// scratch, reused by input and the loop
const ray = new Vector3();
const p = new Vector3();
const q = new Quaternion();
const ONE = new Vector3(1, 1, 1);
const m4 = new Matrix4();

export class Pane {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(FOV_DEG, 1, 0.1, 40);
  private material: MeshStandardMaterial;
  private light: MeshBasicMaterial;
  private whole: Batch;
  private shards: Batch | null = null;
  private burst: Burst | null = null;
  private sling: Sling;
  private reticle: Mesh;
  private disposables: { dispose(): void }[] = [];

  private raf = 0;
  private last = 0;
  private visible = false;
  private sized = false;
  private ready = false;
  private dead = false;
  private reducedMotion: boolean;
  private cleanups: (() => void)[] = [];
  private rect = { left: 0, top: 0, width: 1, height: 1 };

  // TIME
  private t = 0;
  private rate = 0;
  private reported = -1;

  // GESTURE
  private pointer = -1;
  private downX = 0;
  private downY = 0;
  private downT = 0;
  private holding = false;
  private aiming = false;
  private grab = new Vector3();
  private pouch = REST.clone();
  private launch = REST.clone();
  private aimX = 0;
  private aimY = 0;
  private power = 0;

  onState: (t: number, shards: number, phase: Phase) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion = mq.matches;
    const onMotion = () => (this.reducedMotion = mq.matches);
    mq.addEventListener("change", onMotion);

    const r = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    // SOFTWARE GL
    // cpu renderers get the still before any shader compiles; ?gl forces the live path
    if (!new URLSearchParams(location.search).has("gl") && software(r.getContext())) {
      mq.removeEventListener("change", onMotion);
      r.dispose();
      r.forceContextLoss();
      throw new Error("software gl");
    }
    r.debug.checkShaderErrors = import.meta.env.DEV; // reading every shader log stalls the first frame
    r.setClearColor(0x000000, 0);
    r.toneMapping = NeutralToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    this.renderer = r;

    // LIGHT
    const key = new DirectionalLight(0xfff4e6, 2.2);
    key.position.set(-2.6, 6, 4.4);
    key.castShadow = true;
    key.shadow.mapSize.set(SHADOW_PX, SHADOW_PX);
    key.shadow.radius = 3;
    key.shadow.blurSamples = 12;
    key.shadow.intensity = 0.3;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.01;
    const sc = key.shadow.camera;
    sc.left = -4;
    sc.right = 4;
    sc.top = 4;
    sc.bottom = -4;
    sc.near = 1;
    sc.far = 18;
    this.scene.add(key, new HemisphereLight(0xfff8ee, 0xb8a58c, 0.9));

    // FLOOR
    // shadow only, the css backdrop shows through
    const floorGeo = new PlaneGeometry(30, 30);
    const floorMat = new ShadowMaterial({ color: 0x1c2a26, opacity: 0.22 });
    const floor = new Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.disposables.push(floorGeo, floorMat);

    // GLASS
    // tinted clear glass with paint on it; paint mixes over the tint and is opaque
    const art = paint(PANE_W, PANE_H);
    this.material = new MeshStandardMaterial({
      map: art,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      roughness: 0.05,
      metalness: 0,
      envMapIntensity: 1.4,
    });
    this.material.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <map_fragment>", "")
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          vec4 paint = texture2D(map, vMapUv);
          diffuseColor.rgb = mix(diffuseColor.rgb, paint.rgb, paint.a);
          diffuseColor.a = max(diffuseColor.a, paint.a);
          vec3 glow = paint.rgb * paint.a * ${GLOW.toFixed(2)};`,
        )
        // coloured glass looks lit from within, not painted on
        .replace(
          "#include <emissivemap_fragment>",
          "#include <emissivemap_fragment>\ntotalEmissiveRadiance += glow;",
        )
        // reflections stay bright where the glass itself is see-through
        .replace(
          "#include <opaque_fragment>",
          `// FLARE
          // reflections and edge glints split into a spectrum that drifts across the glass
          float hue = dot(gl_FragCoord.xy, vec2(0.0011, 0.0007)) + normal.x * 0.9 + normal.y * 0.6;
          vec3 spectrum = 0.5 + 0.5 * cos(6.2831 * (hue + vec3(0.0, 0.33, 0.67)));
          outgoingLight += totalSpecular * (spectrum * 1.8 - 1.0) * ${DISPERSION};
          // SHEEN
          // two window streaks seen in reflection, they slide and flash as the glass turns
          vec3 rw = inverseTransformDirection(reflect(-geometryViewDir, normal), viewMatrix);
          vec3 sv = dot(rw, vec3(0.86, 0.5, 0.0)) + vec3(-0.006, 0.0, 0.006);
          vec3 d1 = (sv - ${SHEEN_AT[0]}) / 0.022;
          vec3 d2 = (sv - ${SHEEN_AT[1]}) / 0.006;
          vec3 sheen = (exp(-d1 * d1) * 0.35 + exp(-d2 * d2)) * step(0.0, rw.z) * ${SHEEN};
          outgoingLight += sheen;
          gl_FragColor = vec4(outgoingLight, clamp(diffuseColor.a + dot(totalSpecular, vec3(0.4)) + dot(sheen, vec3(0.3)), 0.0, 1.0));`,
        );
    };
    // the floor light falls the way the key light points
    const lightDir = new Vector3().copy(key.position).negate().normalize();
    this.light = glassLight(art, lightDir);
    this.disposables.push(art, this.material, this.light);

    // whole pane is a one-piece batch so it shares the shard program
    const hw = PANE_W / 2;
    const hh = PANE_H / 2;
    this.whole = batch(
      [prism([-hw, -hh, hw, -hh, hw, hh, -hw, hh], PANE_T, 0, 0, PANE_W, PANE_H)],
      this.material,
      this.light,
    );
    this.whole.position.y = PANE_Y;
    this.scene.add(this.whole);
    const whole = this.whole;
    this.disposables.push({ dispose: () => release(whole) });

    // SLING
    this.sling = new Sling(REST, BALL_R);
    this.sling.pose(REST, true);
    this.scene.add(this.sling.group);
    this.disposables.push(this.sling);

    const ringGeo = new RingGeometry(0.03, 0.042, 32);
    const ringMat = new MeshBasicMaterial({ color: 0x1c1a17, transparent: true, opacity: 0.75 });
    this.reticle = new Mesh(ringGeo, ringMat);
    this.reticle.visible = false;
    this.scene.add(this.reticle);
    this.disposables.push(ringGeo, ringMat);

    void this.boot();

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
    canvas.addEventListener("keydown", this.key);

    this.cleanups.push(
      () => mq.removeEventListener("change", onMotion),
      () => ro.disconnect(),
      () => io.disconnect(),
      () => document.removeEventListener("visibilitychange", onVisibility),
      () => canvas.removeEventListener("pointerdown", this.down),
      () => canvas.removeEventListener("pointermove", this.move),
      () => canvas.removeEventListener("pointerup", this.up),
      () => canvas.removeEventListener("pointercancel", this.up),
      () => canvas.removeEventListener("keydown", this.key),
    );
  }

  // BOOT
  // gpu setup in separate tasks so none blocks input for long:
  // bake the room light, then compile in the background, then draw
  private async boot() {
    await nextTask();
    if (this.dead) return;
    const env = studio(this.renderer);
    this.scene.environment = env;
    this.disposables.push(env);
    await nextTask();
    if (this.dead) return;
    await this.renderer.compileAsync(this.scene, this.camera).catch(() => {});
    if (this.dead) return;
    this.ready = true;
    this.wake();
  }

  // PUBLIC
  fire(x: number, y: number, power: number, from: Vector3) {
    this.launch.copy(from);
    const shards = fracture(PANE_W, PANE_H, x, y);
    this.burst = simulate(
      shards,
      { x, y, power, from },
      { paneY: PANE_Y, thick: PANE_T, wallZ: WALL_Z, ballR: BALL_R },
    );
    this.burst.advance(0, 0);
    this.drop();
    this.shards = batch(
      shards.map((s) => prism(s.poly, PANE_T, s.x, s.y, PANE_W, PANE_H)),
      this.material,
      this.light,
    );
    this.scene.add(this.shards);
    this.t = 0;
    this.play(1);
  }

  // tap after a shot: pause, or play on from where it is held
  toggle() {
    if (!this.fired) return;
    if (this.rate !== 0) this.play(0);
    else if (this.t < DURATION_S) this.play(1);
  }

  seek(t: number) {
    this.scrub(t);
  }

  get shot() {
    return !!this.burst;
  }

  get duration() {
    return DURATION_S;
  }

  rewind() {
    if (this.fired) this.play(-REWIND_RATE);
  }

  private play(rate: number) {
    this.rate = rate;
    if (this.reducedMotion && rate !== 0) {
      if (rate > 0) this.burst?.advance(DURATION_S, 0);
      this.t = rate > 0 ? DURATION_S : 0;
      this.rate = 0;
    }
    this.wake();
  }

  private scrub(t: number) {
    if (!this.burst) return;
    this.t = Math.min(Math.max(t, 0), this.burst.reach);
    this.rate = 0;
    this.wake();
  }

  private drop() {
    if (!this.shards) return;
    this.scene.remove(this.shards);
    release(this.shards);
    this.shards = null;
  }

  private get fired() {
    return !!this.burst && this.t > 0;
  }

  private get cracked() {
    return !!this.burst && this.t >= this.burst.hitT;
  }

  // INPUT
  private ray(cx: number, cy: number) {
    const r = this.rect;
    ray.set(((cx - r.left) / r.width) * 2 - 1, 1 - ((cy - r.top) / r.height) * 2, 0.5);
    ray.unproject(this.camera).sub(this.camera.position).normalize();
    return ray;
  }

  // pointer on the sling plane, into out
  private onSling(cx: number, cy: number, out: Vector3) {
    const d = this.ray(cx, cy);
    const o = this.camera.position;
    const s = (REST.z - o.z) / (d.z || -1e-5);
    out.set(o.x + d.x * s, o.y + d.y * s, REST.z);
  }

  private down = (e: PointerEvent) => {
    if (this.pointer !== -1) return;
    this.pointer = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.downT = performance.now();
    this.holding = this.fired;
    this.aiming = !this.fired;
    if (this.holding) this.wake();
    if (this.aiming) {
      this.onSling(e.clientX, e.clientY, this.grab);
      this.aim(e.clientX, e.clientY);
    }
  };

  private move = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) {
      if (this.pointer === -1) this.canvas.style.cursor = this.fired ? "pointer" : "grab";
      return;
    }
    if (this.aiming) this.aim(e.clientX, e.clientY);
  };

  // AIM
  // drag back from anywhere, the shot goes the opposite way
  private aim(cx: number, cy: number) {
    this.onSling(cx, cy, p);
    let px = p.x - this.grab.x;
    let py = p.y - this.grab.y;
    const len = Math.hypot(px, py);
    if (len > MAX_PULL_M) {
      px *= MAX_PULL_M / len;
      py *= MAX_PULL_M / len;
    }
    const pull = Math.min(len, MAX_PULL_M);
    this.power = pull / MAX_PULL_M;
    this.pouch.set(REST.x + px, REST.y + py, REST.z + pull * PULL_BACK);
    const lx = PANE_W / 2 - AIM_MARGIN_M;
    const ly = PANE_H / 2 - AIM_MARGIN_M;
    this.aimX = Math.min(Math.max(-px * AIM_GAIN, -lx), lx);
    this.aimY = Math.min(Math.max(REST.y - PANE_Y - py * AIM_GAIN, -ly), ly);
    this.reticle.position.set(this.aimX, PANE_Y + this.aimY, PANE_T / 2 + 0.004);
    this.reticle.visible = pull > MIN_PULL_M;
    this.canvas.style.cursor = "grabbing";
    this.wake();
  }

  private up = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    this.pointer = -1;
    if (this.aiming) {
      this.aiming = false;
      this.reticle.visible = false;
      this.canvas.style.cursor = "grab";
      if (this.power * MAX_PULL_M > MIN_PULL_M)
        this.fire(this.aimX, this.aimY, this.power, this.pouch);
      this.pouch.copy(REST);
      this.wake();
      return;
    }
    if (!this.holding) return;
    this.holding = false;
    // a long press was rewinding, letting go stops it where it is
    if (this.rate < 0) {
      this.play(0);
      return;
    }
    const tap =
      performance.now() - this.downT < TAP_MS &&
      Math.hypot(e.clientX - this.downX, e.clientY - this.downY) < TAP_PX;
    if (tap) this.toggle();
  };

  private key = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (this.fired) this.toggle();
      else {
        p.set(REST.x, REST.y - 0.2, REST.z + 0.25);
        this.fire(
          (Math.random() - 0.5) * PANE_W * 0.4,
          (Math.random() - 0.5) * PANE_H * 0.4,
          0.8,
          p,
        );
      }
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      this.scrub(this.t + (e.key === "ArrowLeft" ? -KEY_STEP_S : KEY_STEP_S));
    }
  };

  // LOOP
  private wake() {
    if (!this.raf && this.ready && this.visible && !document.hidden)
      this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible || document.hidden) return;
    const dt = this.last ? Math.min(MAX_DT_S, Math.max(0, now - this.last) / 1000) : 1 / 60;
    this.last = now;
    if (!this.sized) this.resize();

    let active = this.holding;
    // HOLD
    if (this.holding && this.rate >= 0 && now - this.downT > HOLD_MS && this.t > 0)
      this.play(-HOLD_RATE);
    const b = this.burst;
    if (b && !b.done) {
      b.advance(this.t + dt * Math.max(this.rate, 0), SIM_BUDGET_MS);
      active = true;
    }
    if (this.rate !== 0) {
      this.t += dt * this.rate;
      active = true;
      if (this.t >= DURATION_S) {
        this.t = DURATION_S;
        this.rate = 0;
      } else if (this.t <= 0) {
        this.t = 0;
        this.rate = 0;
      }
    }

    this.pose();
    this.renderer.render(this.scene, this.camera);
    this.report();
    if (active) this.wake();
    else this.last = 0;
  };

  private pose() {
    const fired = this.fired;
    const cracked = this.cracked;
    this.whole.visible = !cracked;
    if (fired && this.burst) this.burst.sampleBall(this.t, p);
    else p.copy(this.aiming ? this.pouch : REST);
    this.sling.pose(p, !fired, this.launch, this.t);

    const s = this.shards;
    const b = this.burst;
    if (!s || !b) return;
    s.visible = cracked;
    if (!cracked) return;
    for (let i = 0; i < b.n; i++) {
      b.sample(i, this.t, p, q);
      place(s, i, m4.compose(p, q, ONE));
    }
  }

  // hud only hears about changes it can show
  private report() {
    const phase: Phase =
      this.rate > 0
        ? "flying"
        : this.rate < 0
          ? "mending"
          : this.fired
            ? "held"
            : this.aiming
              ? "aiming"
              : "whole";
    const key = PHASES.indexOf(phase) * 1e5 + Math.round(this.t * 100);
    if (key === this.reported) return;
    this.reported = key;
    this.onState(this.t, this.cracked ? (this.burst?.n ?? 1) : 1, phase);
  }

  // RESIZE
  private queueResize() {
    this.sized = false;
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
    this.dead = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
    this.drop();
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
    this.renderer.dispose();
    if (!this.renderer.getContext().isContextLost()) this.renderer.forceContextLoss();
  }
}

// one draw for every piece, each with its own matrix
// a glass piece plus its coloured light on the floor, sharing one matrix per piece
interface Batch extends BatchedMesh {
  light: BatchedMesh;
}

// one draw for every piece, each with its own matrix
function batch(geos: BufferGeometry[], material: Material, light: Material) {
  let verts = 0;
  let index = 0;
  for (const g of geos) {
    verts += g.getAttribute("position").count;
    index += g.index?.count ?? 0;
  }
  const b = new BatchedMesh(geos.length, verts, index, material) as Batch;
  const l = new BatchedMesh(geos.length, verts, index, light);
  for (const g of geos) {
    b.addInstance(b.addGeometry(g));
    l.addInstance(l.addGeometry(g));
    g.dispose();
  }
  b.frustumCulled = false; // pieces fly, the per-instance cull still runs
  // the light lands far from the piece, so its bounds say nothing
  l.frustumCulled = false;
  l.perObjectFrustumCulled = false;
  l.sortObjects = false;
  l.renderOrder = -1;
  b.add(l);
  b.light = l;
  return b;
}

function place(b: Batch, i: number, m: Matrix4) {
  b.setMatrixAt(i, m);
  b.light.setMatrixAt(i, m);
}

function release(b: Batch) {
  b.light.dispose();
  b.dispose();
}

// LIGHT THROUGH GLASS
// every piece flattened onto the floor along the key light, tinted by its paint
function glassLight(map: Texture, dir: Vector3) {
  const m = new MeshBasicMaterial({
    map,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLight = { value: dir };
    sh.vertexShader = sh.vertexShader
      .replace(
        "void main() {",
        `uniform vec3 uLight;
      varying float vFront;
      void main() {`,
      )
      .replace(
        "#include <project_vertex>",
        `vFront = normal.z;
        vec4 world = vec4(transformed, 1.0);
        #ifdef USE_BATCHING
          world = batchingMatrix * world;
        #endif
        world = modelMatrix * world;
        world.xyz -= uLight * ((world.y - ${FLOOR_LIFT_M}) / uLight.y);
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "void main() {",
        `varying float vFront;
      void main() {`,
      )
      .replace(
        "#include <opaque_fragment>",
        `if (vFront < 0.5) discard; // one layer per piece, the front face
        // PRISM
        // each channel lands a little apart, so every edge gets a rainbow fringe
        vec2 split = vec2(${PRISM_UV}, ${PRISM_UV} * 0.5);
        vec4 pr = texture2D(map, vMapUv + split);
        vec4 pg = texture2D(map, vMapUv);
        vec4 pb = texture2D(map, vMapUv - split);
        vec3 col = pg.rgb + (vec3(pr.r, pg.g, pb.b) - pg.rgb) * 2.2;
        float a = (pr.a + pg.a + pb.a) / 3.0;
        gl_FragColor = vec4(col * ${LIGHT_DARKEN}, ${LIGHT_CLEAR} + a * ${LIGHT_STRENGTH});`,
      );
  };
  return m;
}

const nextTask = () => new Promise<void>((done) => setTimeout(done, 0));

function software(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
  return /swiftshader|llvmpipe|software|basic render/i.test(name);
}

// STUDIO
// a dim room with softboxes, baked once into a prefiltered env map
function studio(renderer: WebGLRenderer) {
  const room = new Scene();
  room.background = new Color(0x4a4640);
  const geo = new PlaneGeometry(1, 1);
  const box = (w: number, h: number, x: number, y: number, z: number, gain: number) => {
    const mat = new MeshBasicMaterial({ color: new Color(1, 0.97, 0.92).multiplyScalar(gain) });
    const m = new Mesh(geo, mat);
    m.scale.set(w, h, 1);
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    room.add(m);
    return mat;
  };
  const mats = [
    box(4, 2, 0, 6, 1, 1.2), // change softbox gains here
    box(1.2, 6, -6, 1.5, 2, 6),
    box(2, 4, 5, 2, -4, 4),
    box(8, 1, 0, 1, 7, 2.5),
    box(0.7, 8, 0.8, -0.5, 7, 5), // the streak that reads as glass
  ];
  const pmrem = new PMREMGenerator(renderer);
  const env = pmrem.fromScene(room).texture; // no blur pass, one less shader to compile
  pmrem.dispose();
  geo.dispose();
  mats.forEach((m) => m.dispose());
  return env;
}
