// SMEAR
// a word that melts down the screen. the letters are a texture; a ping-pong pass carries
// paint downward at a speed that differs per column, so it runs in streaks.
// the cursor is heat, not a hand: paint under it runs faster and heavier, letters near it
// droop and stay drooped. a last pass colours the paint by how far it has run

const MAX_DPR = 2;
const SIM_SCALE = 0.5; // the paint is soft, half resolution looks the same
const MAX_DT_S = 1 / 20;
const FLOW = 0.055; // screen heights per second for an average column, change for faster runs
const FADE_PER_S = 0.018; // how quickly old paint thins out
const SAG_S = 25; // letters droop to their resting sag over this long
const SAG = 0.045; // resting sag at the bottom of a letter, in screen heights
const HEAT_R = 0.09; // how far the cursor's warmth reaches, in screen heights
const HEAT_RUN = 5; // warm paint runs this many times faster, change for a heavier pour
const HEAT_KEEP_S = 1.8; // how long paint stays warm once the cursor has left
const DROOP_RATE = 0.03; // screen heights per second a letter right under the cursor droops
const DROOP_MAX = 0.2; // the most a letter can droop
const DROOP_REACH = 0.12; // how far above or below the letters the cursor still melts them
const COLS = 96; // droop is kept per column across the screen
const EASE_S = 0.03; // the warmth trails the cursor a little
const WARM_UP_S = 0.45; // a spot needs this long under the cursor before it really gets going
const COOL_S = 1.0; // and takes about this long to cool once the cursor has moved on
const SETTLE_STEPS = 420; // reduced motion: steps run before the one still frame

export const PALETTES = ["acid", "dusk", "tide", "chrome", "ember"] as const;
export type Palette = (typeof PALETTES)[number];

// five colours along the run: at the letter, just below, middle, late, last
const STOPS: Record<Palette, number[]> = {
  acid: [0.95, 1, 0.3, 0.6, 1, 0.35, 0.2, 1, 0.58, 0.1, 0.7, 1, 0.1, 0.1, 0.5],
  dusk: [1, 0.86, 0.62, 1, 0.48, 0.36, 0.95, 0.2, 0.55, 0.45, 0.12, 0.78, 0.12, 0.03, 0.26],
  tide: [0.88, 1, 1, 0.4, 0.95, 1, 0.15, 0.55, 1, 0.3, 0.15, 0.85, 0.06, 0.03, 0.26],
  chrome: [1, 0.95, 0.97, 1, 0.6, 0.82, 1, 0.4, 0.7, 0.75, 0.15, 0.5, 0.22, 0.04, 0.18],
  ember: [1, 0.86, 0.42, 1, 0.62, 0.16, 0.95, 0.3, 0.06, 0.7, 0.06, 0.08, 0.18, 0.02, 0.04],
};

const VS = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const NOISE = `
float hash(float x) { return fract(sin(x * 127.1) * 43758.5453); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash(i), hash(i + 1.0), f);
}`;

// LETTER SHAPE
// where to read the word from: a resting sag plus the droop the cursor has melted into
// each column. the droop stretches the letter from its top down, so it hangs, not slides
const LETTER = `
uniform float uSag;
uniform sampler2D uDroop; // one row, a column's droop over DROOP_MAX
uniform vec2  uBand; // top and bottom of the word, uv
float droopAt(float x) {
  return texture(uDroop, vec2(x, 0.5)).r * ${DROOP_MAX.toFixed(3)};
}
vec2 letterUv(vec2 uv, float aspect) {
  float rest = uSag * (0.4 + 0.6 * noise(uv.x * aspect * 9.0 + 7.0));
  float d = droopAt(uv.x);
  // the further down the letter, the more of the droop it carries
  float k = clamp((uBand.x - uv.y) / max(uBand.x - uBand.y + d, 1e-3), 0.0, 1.0);
  return uv + vec2(0.0, rest + d * k);
}`;

// PAINT
// state: r paint, g distance run (screen heights), b warmth
const FLOW_FS = `#version 300 es
precision highp float;
uniform sampler2D uPrev;
uniform sampler2D uText;
uniform vec2  uRes;
uniform float uAspect;
uniform float uDt;
uniform float uClear;
uniform vec3  uHeat; // cursor uv, strength
out vec4 outColor;
${NOISE}
${LETTER}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float c = uv.x * uAspect;

  // warmth: the cursor heats what is round it, and paint keeps that warmth as it runs
  vec2 d = (uv - uHeat.xy) * vec2(uAspect, 1.0);
  float heat = uHeat.z * exp(-dot(d, d) / ${(HEAT_R * HEAT_R).toFixed(5)});

  // a few fast runners among many slow columns
  float n = 0.7 * noise(c * 14.0 + 3.1) + 0.3 * noise(c * 33.0);
  float speed = ${FLOW.toFixed(4)} * (0.12 + 1.6 * pow(n, 2.4));
  vec4 here = texture(uPrev, uv);
  // warmth builds up where the cursor rests instead of switching on
  float warm = here.b;
  speed *= 1.0 + ${HEAT_RUN.toFixed(1)} * warm;

  vec4 prev = texture(uPrev, uv + vec2(0.0, speed * uDt));
  float paint = prev.r * (1.0 - ${FADE_PER_S.toFixed(4)} * uDt) * (1.0 - uClear);
  float run = prev.g + speed * uDt;
  float keep = exp(-uDt / ${HEAT_KEEP_S.toFixed(2)});
  float cooled = prev.b * keep;
  float carried = cooled + max(0.0, heat - cooled) * (1.0 - exp(-uDt / ${WARM_UP_S.toFixed(2)}));

  // fresh paint at the letters, it has not run yet
  float t = texture(uText, letterUv(uv, uAspect)).r;
  run = mix(run, 0.0, t);
  paint = max(paint, t);
  outColor = vec4(paint, run, carried * (1.0 - uClear), 1.0);
}`;

const SHOW_FS = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform sampler2D uText;
uniform vec2  uRes;
uniform vec2  uSimTexel;
uniform float uAspect;
uniform float uTime;
uniform vec3  uStops[5];
out vec4 outColor;
${NOISE}
${LETTER}
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  if (t < 0.08) return mix(uStops[0], uStops[1], t / 0.08);
  if (t < 0.3) return mix(uStops[1], uStops[2], (t - 0.08) / 0.22);
  if (t < 0.65) return mix(uStops[2], uStops[3], (t - 0.3) / 0.35);
  return mix(uStops[3], uStops[4], (t - 0.65) / 0.35);
}
vec3 paint(vec2 uv) {
  // the streaks waver as they run, more the further they have gone
  float far = texture(uState, uv).g;
  float ph = noise(uv.x * uAspect * 7.0) * 6.28;
  uv.x += 0.006 * far * sin(uv.y * 9.0 + ph + uTime * 0.35);
  vec4 s = texture(uState, uv);
  // a soft brushed grain across the streaks, wide enough not to read as lines
  float fibre = 0.86 + 0.14 * noise(uv.x * uAspect * 90.0);
  // warm paint glows toward the bright end of the ramp
  float run = s.g * 1.5 * (1.0 - 0.55 * s.b);
  float fade = smoothstep(1.2, 0.15, run);
  return ramp(run) * s.r * fade * fibre * (1.0 + 0.35 * s.b);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  // fringes: the warm and cool ends of the ramp slip apart a little
  vec2 shift = vec2(uSimTexel.x * 0.7, 0.0);
  vec3 col;
  col.r = paint(uv + shift).r;
  col.g = paint(uv).g;
  col.b = paint(uv - shift).b;

  // the letters themselves: dark faces with a bright rim, drooped like the paint source
  vec2 tuv = letterUv(uv, uAspect);
  float t = texture(uText, tuv).r;
  vec2 e = uSimTexel * 1.5;
  float gx = texture(uText, tuv + vec2(e.x, 0.0)).r - texture(uText, tuv - vec2(e.x, 0.0)).r;
  float gy = texture(uText, tuv + vec2(0.0, e.y)).r - texture(uText, tuv - vec2(0.0, e.y)).r;
  float rim = clamp(length(vec2(gx, gy)) * 1.6, 0.0, 1.0);
  vec3 face = vec3(0.02, 0.015, 0.02) + ramp(0.02) * rim * 1.1;
  // a soft sheen across the top of each face
  face += ramp(0.12) * smoothstep(0.0, -0.6, gy) * t * 0.35;
  col = mix(col, face, smoothstep(0.35, 0.9, t));

  // grain
  float g = hash2(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5;
  col += g * 0.06;
  outColor = vec4(max(col, 0.0), 1.0);
}`;

type Target = { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };
type Pass = {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
  shaders: WebGLShader[];
};

export class Smear {
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private text: WebGLTexture;
  private flow: Pass;
  private show: Pass;
  private parallel: boolean;
  private linked = false;
  private paint: Target[] = [];
  private floatTargets: boolean;
  private word: string;
  private textCanvas = document.createElement("canvas");
  private band = new Float32Array(2); // word top and bottom, uv
  private droop = new Float32Array(COLS);
  private droopBytes = new Uint8Array(COLS);
  private droopTex: WebGLTexture;
  private droopDirty = true;
  private colHeat = new Float32Array(COLS); // eased warmth per column, drives the droop

  private raf = 0;
  private last = 0;
  private time = 0;
  private visible = false;
  private sized = false;
  private clear = 0;
  private reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private cleanups: (() => void)[] = [];

  // CURSOR
  private px = 0.5; // eased warmth position
  private py = 0.5;
  private tx = 0.5; // raw pointer
  private ty = 0.5;
  private inside = false;
  private fresh = true;
  private heat = 0;
  private rect = { left: 0, top: 0, width: 1, height: 1 };

  palette: Palette = "acid";

  constructor(
    private canvas: HTMLCanvasElement,
    word: string,
  ) {
    this.word = word;
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("webgl2 unavailable");
    // SOFTWARE GL
    // cpu renderers get the still before any shader compiles; ?gl forces the live path
    if (!new URLSearchParams(location.search).has("gl") && software(gl)) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      throw new Error("software gl");
    }
    this.gl = gl;
    // half floats keep the run distance smooth; plain bytes still work, only coarser
    this.floatTargets =
      !!gl.getExtension("EXT_color_buffer_float") ||
      !!gl.getExtension("EXT_color_buffer_half_float");
    // compile in the background where the driver allows; the first frame waits for it
    this.parallel = !!gl.getExtension("KHR_parallel_shader_compile");
    this.flow = pass(gl, FLOW_FS);
    this.show = pass(gl, SHOW_FS);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("no vao");
    this.vao = vao;
    this.text = texture(gl);
    this.droopTex = texture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, COLS, 1, 0, gl.RED, gl.UNSIGNED_BYTE, this.droopBytes);

    // OBSERVERS
    const ro = new ResizeObserver(() => {
      this.sized = false;
      this.wake();
    });
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
    canvas.addEventListener("pointermove", this.move, opts);
    canvas.addEventListener("pointerdown", this.move, opts);
    canvas.addEventListener("pointerleave", this.leave, opts);
    canvas.addEventListener("pointercancel", this.leave, opts);
    this.cleanups.push(
      () => ro.disconnect(),
      () => io.disconnect(),
      () => document.removeEventListener("visibilitychange", onVisibility),
      () => canvas.removeEventListener("pointermove", this.move),
      () => canvas.removeEventListener("pointerdown", this.move),
      () => canvas.removeEventListener("pointerleave", this.leave),
      () => canvas.removeEventListener("pointercancel", this.leave),
    );
    document.fonts.ready.then(() => {
      this.sized = false;
      this.wake();
    });
  }

  // PUBLIC
  // a new word starts clean: old paint is washed off and every letter pours from scratch
  setWord(word: string) {
    this.word = word;
    this.reset();
    this.drawText();
    if (this.reducedMotion) this.settle();
    this.wake();
  }

  setPalette(p: Palette) {
    this.palette = p;
    this.wake();
  }

  // washes the screen and pours the word again
  pour() {
    this.reset();
    this.wake();
  }

  private reset() {
    this.clear = 1;
    this.droop.fill(0);
    this.colHeat.fill(0);
    this.droopDirty = true;
  }

  // INPUT
  // the cursor is a source of heat; it does not have to move to melt things
  private move = (e: PointerEvent) => {
    const r = this.rect;
    this.tx = (e.clientX - r.left) / r.width;
    this.ty = 1 - (e.clientY - r.top) / r.height;
    if (this.fresh) {
      this.px = this.tx;
      this.py = this.ty;
      this.fresh = false;
    }
    this.inside = true;
    this.wake();
  };

  private leave = () => {
    this.inside = false;
    this.fresh = true;
  };

  // TEXT
  private drawText() {
    const c = this.textCanvas;
    const t = this.paint[0];
    if (!t) return;
    c.width = t.w;
    c.height = t.h;
    const g = c.getContext("2d");
    if (!g) return;
    g.fillStyle = "#000";
    g.fillRect(0, 0, c.width, c.height);
    const word = this.word || " ";
    // fit the word to about three quarters of the width, never taller than a third of the screen
    let size = c.height * 0.34;
    g.font = `400 ${size}px "Instrument Serif", Georgia, serif`;
    const w = g.measureText(word).width;
    size = Math.min(size, (size * c.width * 0.78) / Math.max(1, w));
    g.font = `400 ${size}px "Instrument Serif", Georgia, serif`;
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    g.fillStyle = "#fff";
    g.strokeStyle = "#fff";
    // a stroke round the fill gives the hairlines enough body to run
    g.lineWidth = size * 0.035;
    g.lineJoin = "round";
    const y = c.height * 0.36 + size * 0.3;
    g.strokeText(word, c.width / 2, y);
    g.fillText(word, c.width / 2, y);
    // where the word sits, in uv with y up; the droop stretches between these
    const m = g.measureText(word);
    this.band[0] = 1 - (y - m.actualBoundingBoxAscent) / c.height;
    this.band[1] = 1 - (y + Math.max(m.actualBoundingBoxDescent, size * 0.02)) / c.height;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.text);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  // LOOP
  // the melt never stops, so the loop runs while the canvas is on screen
  private wake() {
    if (!this.raf && this.visible && !document.hidden) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible || document.hidden) return;
    if (!this.linked) {
      // COMPLETION_STATUS_KHR, polled so linking never blocks the main thread
      const busy = (p: Pass) => !this.gl.getProgramParameter(p.prog, 0x91b1);
      if (this.parallel && (busy(this.flow) || busy(this.show))) {
        this.wake();
        return;
      }
      finish(this.gl, this.flow);
      finish(this.gl, this.show);
      this.linked = true;
    }
    if (!this.sized) this.resize();
    const dt = this.last ? Math.min(MAX_DT_S, Math.max(0, now - this.last) / 1000) : 1 / 60;
    this.last = now;
    if (this.reducedMotion) {
      this.draw();
      return;
    }
    this.step(dt);
    this.draw();
    this.wake();
  };

  private step(dt: number) {
    this.time += dt;
    // warmth comes up gently and lingers a moment when the cursor leaves
    this.heat +=
      ((this.inside ? 1 : 0) - this.heat) * (1 - Math.exp(-dt / (this.inside ? 0.35 : 0.6)));
    const e = 1 - Math.exp(-dt / EASE_S);
    this.px += (this.tx - this.px) * e;
    this.py += (this.ty - this.py) * e;
    const aspect = this.canvas.width / this.canvas.height;

    // DROOP
    // letters within reach of the cursor soften column by column and stay that way
    const top = this.band[0];
    const bottom = this.band[1];
    const dy = this.py > top ? this.py - top : this.py < bottom ? bottom - this.py : 0;
    const near = this.heat * Math.exp(-(dy * dy) / (DROOP_REACH * DROOP_REACH));
    const up = 1 - Math.exp(-dt / WARM_UP_S);
    const down = 1 - Math.exp(-dt / COOL_S);
    for (let i = 0; i < COLS; i++) {
      const dx = (i / (COLS - 1) - this.px) * aspect;
      const target = near * Math.exp(-(dx * dx) / (HEAT_R * HEAT_R));
      // each column warms over a moment and cools slower, so a quick pass barely marks it
      const h = this.colHeat[i];
      this.colHeat[i] = h + (target - h) * (target > h ? up : down);
      if (this.colHeat[i] < 0.005) continue;
      // already soft wax gives way faster, so a held cursor ends in a long drip
      const d = this.droop[i];
      this.droop[i] = Math.min(DROOP_MAX, d + dt * DROOP_RATE * this.colHeat[i] * (1 + d * 6));
      this.droopDirty = true;
    }
    if (this.droopDirty) this.upload();

    // PAINT
    const gl = this.gl;
    const p = this.flow;
    const src = this.paint[0];
    const dst = this.paint[1];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.w, dst.h);
    gl.useProgram(p.prog);
    this.tex(p, "uPrev", 0, src.tex);
    this.tex(p, "uText", 1, this.text);
    gl.uniform2f(p.u.uRes, dst.w, dst.h);
    gl.uniform1f(p.u.uAspect, aspect);
    gl.uniform1f(p.u.uDt, dt);
    gl.uniform1f(p.u.uClear, this.clear);
    gl.uniform3f(p.u.uHeat, this.px, this.py, this.heat);
    this.letter(p);
    this.draw3();
    this.paint.reverse();
    if (this.clear) {
      this.clear = 0;
      this.time = 0;
    }
  }

  private upload() {
    for (let i = 0; i < COLS; i++)
      this.droopBytes[i] = Math.round((this.droop[i] / DROOP_MAX) * 255);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.droopTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, COLS, 1, gl.RED, gl.UNSIGNED_BYTE, this.droopBytes);
    this.droopDirty = false;
  }

  private letter(p: Pass) {
    const gl = this.gl;
    gl.uniform1f(p.u.uSag, SAG * (1 - Math.exp(-this.time / SAG_S)));
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.droopTex);
    gl.uniform1i(p.u.uDroop, 2);
    gl.uniform2f(p.u.uBand, this.band[0], this.band[1]);
  }

  private draw() {
    const gl = this.gl;
    const p = this.show;
    const t = this.paint[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(p.prog);
    this.tex(p, "uState", 0, t.tex);
    this.tex(p, "uText", 1, this.text);
    gl.uniform2f(p.u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform2f(p.u.uSimTexel, 1 / t.w, 1 / t.h);
    gl.uniform1f(p.u.uAspect, t.w / t.h);
    gl.uniform1f(p.u.uTime, this.time);
    gl.uniform3fv(p.u.uStops, STOPS[this.palette]);
    this.letter(p);
    this.draw3();
  }

  // reduced motion: let it run out of sight, then show one frame
  private settle() {
    if (!this.linked || !this.paint.length) return;
    for (let i = 0; i < SETTLE_STEPS; i++) this.step(1 / 30);
  }

  // GL HELPERS
  private tex(p: Pass, name: string, unit: number, t: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(p.u[name], unit);
  }

  private draw3() {
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  // RESIZE
  private resize() {
    const r = this.canvas.getBoundingClientRect();
    this.rect.left = r.left;
    this.rect.top = r.top;
    this.rect.width = r.width || 1;
    this.rect.height = r.height || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    this.canvas.width = w;
    this.canvas.height = h;
    const sw = Math.max(2, Math.round(w * SIM_SCALE));
    const sh = Math.max(2, Math.round(h * SIM_SCALE));
    if (!this.paint.length || this.paint[0].w !== sw || this.paint[0].h !== sh) {
      this.freeTargets();
      this.paint = [this.target(sw, sh), this.target(sw, sh)];
      this.time = 0;
    }
    this.drawText();
    if (this.reducedMotion) this.settle();
    this.sized = true;
  }

  private target(w: number, h: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) throw new Error("no target");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.floatTargets)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }

  private freeTargets() {
    for (const t of this.paint) {
      this.gl.deleteTexture(t.tex);
      this.gl.deleteFramebuffer(t.fbo);
    }
    this.paint = [];
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
    const gl = this.gl;
    this.freeTargets();
    gl.deleteTexture(this.text);
    gl.deleteTexture(this.droopTex);
    gl.deleteProgram(this.flow.prog);
    gl.deleteProgram(this.show.prog);
    gl.deleteVertexArray(this.vao);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function texture(gl: WebGL2RenderingContext) {
  const t = gl.createTexture();
  if (!t) throw new Error("no texture");
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

// starts compiling a fullscreen pass; nothing here waits on the driver
function pass(gl: WebGL2RenderingContext, fs: string): Pass {
  const prog = gl.createProgram();
  if (!prog) throw new Error("no program");
  const shaders: WebGLShader[] = [];
  for (const [type, src] of [
    [gl.VERTEX_SHADER, VS],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const sh = gl.createShader(type);
    if (!sh) throw new Error("no shader");
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    gl.attachShader(prog, sh);
    shaders.push(sh);
  }
  gl.linkProgram(prog);
  return { prog, u: {}, shaders };
}

// once linked: check it, free the shaders, look up every uniform it declares
function finish(gl: WebGL2RenderingContext, p: Pass) {
  if (!gl.getProgramParameter(p.prog, gl.LINK_STATUS)) {
    const log = p.shaders.map((sh) => gl.getShaderInfoLog(sh)).join("\n");
    throw new Error((gl.getProgramInfoLog(p.prog) ?? "link") + log);
  }
  for (const sh of p.shaders) gl.deleteShader(sh);
  p.shaders.length = 0;
  const n = gl.getProgramParameter(p.prog, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p.prog, i);
    if (!info) continue;
    const name = info.name.replace(/\[0\]$/, "");
    p.u[name] = gl.getUniformLocation(p.prog, name);
  }
}

function software(gl: WebGL2RenderingContext) {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
  return /swiftshader|llvmpipe|software|basic render/i.test(name);
}
