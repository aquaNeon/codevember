import {
  CanvasTexture,
  CatmullRomCurve3,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Mesh,
  MeshPhysicalMaterial,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SphereGeometry,
  SRGBColorSpace,
  TubeGeometry,
  Vector2,
  Vector3,
  type Texture,
} from "three";

const FORK_SPAN_M = 0.2;
const FORK_RISE_M = 0.08;
const ARM_M = 0.3; // crotch up to the tips
const HANDLE_M = 0.5;
const ARM_ROOT_R = 0.034;
const ARM_TIP_R = 0.022;
const ARM_SEGS = 40;
const ARM_RADIAL = 14;
const WRAP_M = 0.04;
const BAND_R = 0.0075;
const BAND_SEGS = 10;
const BAND_SLACK = 1.12; // natural band length over the stretch of the hanging pouch
const POUCH_GAP = 1.12; // pouch radius over ball radius
const POUCH_TALL = 1.3; // pouch height as an angle around the ball, radians
const POUCH_HOLE = 0.5; // half the window in the pouch, radians
const HANG = new Vector3(0, -0.13, 0.03); // where the empty pouch comes to rest, from REST
const SWING_HZ = 2.4; // band recoil after the shot
const SWING_DAMP = 4.5;
const FLAT = 0.3; // empty pouch folds flat to this depth
const WALNUT = "#6a3a1f";
const BLOB_A = 0.55; // contact shadow darkness on the ground
const BLOB_FADE_M = 0.5; // gone by this height

const UP = new Vector3(0, 1, 0);
const a = new Vector3();
const l = new Vector3();
const r = new Vector3();
const c = new Vector3();
const p0 = new Vector3();
const p1 = new Vector3();
const rq = new Quaternion();

// SLING
// polished walnut fork, twine wraps, amber tubes, a leather pouch and a steel ball
export class Sling {
  readonly group = new Group();
  readonly ball: Mesh;
  private blob: Mesh;
  private blobMat: MeshBasicMaterial;
  private pouch: Mesh[] = [];
  private hole: Mesh;
  private pouchR: number;
  private anchors: Vector3[] = [];
  private bands: Mesh[][] = [[], []];
  private bandM = 0;
  private disposables: { dispose(): void }[] = [];

  constructor(
    readonly rest: Vector3,
    private ballR: number,
  ) {
    // lathe runs its uvs up the length, tubes run them along u, so the grain turns for the arms
    const grain = woodGrain();
    const armGrain = grain.clone();
    armGrain.center.set(0.5, 0.5);
    armGrain.rotation = Math.PI / 2;
    const wood = polished(grain);
    const armWood = polished(armGrain);
    const twine = new MeshStandardMaterial({ color: 0xe2d3b2, roughness: 0.9 });
    const latex = new MeshStandardMaterial({ color: 0xc98a3a, roughness: 0.38 });
    const leather = new MeshStandardMaterial({
      color: 0x24211e,
      roughness: 0.7,
      side: DoubleSide,
    });
    const steel = new MeshStandardMaterial({ color: 0xdadada, metalness: 1, roughness: 0.2 });
    this.disposables.push(grain, armGrain, wood, armWood, twine, latex, leather, steel);

    const x = rest.x;
    const z = rest.z;
    const tipY = rest.y + FORK_RISE_M;
    const crotchY = tipY - ARM_M;

    const add = <T extends { dispose(): void }>(geo: T, m: Mesh) => {
      this.disposables.push(geo);
      m.castShadow = true;
      this.group.add(m);
      return m;
    };

    // HANDLE
    // turned profile: end cap, a full grip, a waist, then the flare into the fork
    const profile = [
      [0.0, 0.0],
      [0.026, 0.0],
      [0.028, 0.02],
      [0.033, 0.06],
      [0.037, 0.16],
      [0.033, 0.27],
      [0.03, 0.34],
      [0.034, 0.42],
      [0.044, 0.5],
    ].map(([rad, h]) => new Vector2(rad, h * (HANDLE_M / 0.5)));
    const handleGeo = new LatheGeometry(profile, 24);
    const handle = add(handleGeo, new Mesh(handleGeo, wood));
    handle.position.set(x, crotchY - HANDLE_M, z);
    const capGeo = new CylinderGeometry(0.0265, 0.027, 0.022, 24);
    const cap = add(capGeo, new Mesh(capGeo, steel));
    cap.position.set(x, crotchY - HANDLE_M + 0.011, z);

    // ARMS
    // tapered tubes rising out of a rounded crotch
    const knob = new SphereGeometry(1, 20, 14);
    const crotch = add(knob, new Mesh(knob, wood));
    crotch.position.set(x, crotchY + 0.01, z);
    crotch.scale.set(0.05, 0.045, 0.04);
    const wrapR = ARM_TIP_R * 1.18;
    const wrapGeo = new CylinderGeometry(wrapR, wrapR, WRAP_M, 16);
    const tan = new Vector3();
    for (const side of [-1, 1]) {
      const tip = new Vector3(x + side * FORK_SPAN_M, tipY, z);
      const curve = new CatmullRomCurve3([
        new Vector3(x, crotchY - 0.01, z),
        new Vector3(x + side * 0.05, crotchY + 0.07, z),
        new Vector3(x + side * FORK_SPAN_M * 0.8, crotchY + ARM_M * 0.55, z),
        tip,
      ]);
      const armGeo = taper(new TubeGeometry(curve, ARM_SEGS, 1, ARM_RADIAL, false), curve);
      add(armGeo, new Mesh(armGeo, armWood));
      // a dome the same radius as the tube end, so the tip closes cleanly
      const cap = add(knob, new Mesh(knob, wood));
      cap.position.copy(tip);
      cap.scale.setScalar(ARM_TIP_R);
      // twine sits just under the tip, along the arm; the band leaves from its front
      curve.getTangentAt(1, tan);
      const wrap = add(wrapGeo, new Mesh(wrapGeo, twine));
      wrap.position.copy(tip).addScaledVector(tan, -WRAP_M * 0.75);
      wrap.quaternion.setFromUnitVectors(UP, tan);
      this.anchors.push(wrap.position.clone().setZ(wrap.position.z + wrapR * 0.55));
    }

    // BANDS
    const rod = new CylinderGeometry(1, 1, 1, 10, 1);
    for (const chain of this.bands) {
      for (let i = 0; i < BAND_SEGS; i++) {
        const seg = add(rod, new Mesh(rod, latex));
        seg.scale.set(BAND_R, 1, BAND_R);
        chain.push(seg);
      }
    }

    // POUCH
    // two leather cups hug the ball's sides, the hole between them leaves the steel in view;
    // once the ball is gone a middle piece closes it and the leather folds flat
    this.pouchR = ballR * POUCH_GAP;
    const band = POUCH_TALL / 2;
    const cup = (from: number, len: number) => {
      const geo = new SphereGeometry(this.pouchR, 12, 8, from, len, Math.PI / 2 - band, band * 2);
      return add(geo, new Mesh(geo, leather));
    };
    const side = Math.PI / 2 - POUCH_HOLE;
    this.pouch.push(cup(0, side), cup(Math.PI / 2 + POUCH_HOLE, side));
    this.hole = cup(side, POUCH_HOLE * 2);
    this.pouch.push(this.hole);

    c.copy(rest)
      .add(HANG)
      .setX(rest.x - this.pouchR);
    this.bandM = this.anchors[0].distanceTo(c) * BAND_SLACK;

    const steelBall = new SphereGeometry(ballR, 24, 16);
    this.ball = add(steelBall, new Mesh(steelBall, steel));

    // CONTACT SHADOW
    // the real shadow is too small and soft to read, a blob grounds the ball
    const blobTex = softDot();
    this.blobMat = new MeshBasicMaterial({
      map: blobTex,
      color: 0x1c2a26,
      transparent: true,
      depthWrite: false,
    });
    const blobGeo = new PlaneGeometry(1, 1);
    this.blob = new Mesh(blobGeo, this.blobMat);
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.renderOrder = -2;
    this.group.add(this.blob);
    this.disposables.push(blobTex, this.blobMat, blobGeo);
  }

  // bands run to the pouch; after the shot it recoils from where it was let go,
  // swings past the fork and drops to hang under it
  pose(ball: Vector3, loaded: boolean, from = this.rest, since = Infinity) {
    if (loaded) c.copy(ball);
    else {
      const k = Math.exp(-since * SWING_DAMP) * Math.cos(since * SWING_HZ * Math.PI * 2);
      c.copy(this.rest).add(HANG);
      c.addScaledVector(a.subVectors(from, c), Number.isFinite(k) ? k : 0);
    }
    l.copy(c).setX(c.x - this.pouchR);
    r.copy(c).setX(c.x + this.pouchR);
    this.drape(this.bands[0], this.anchors[0], l);
    this.drape(this.bands[1], this.anchors[1], r);
    // fold flat only once the ball is clear of the leather
    const clear = loaded
      ? 0
      : Math.min(1, Math.max(0, (ball.distanceTo(c) - this.pouchR) / this.pouchR));
    this.hole.visible = !loaded;
    for (const p of this.pouch) {
      p.position.copy(c);
      p.scale.set(1, 1, 1 + (FLAT - 1) * clear);
    }
    this.ball.position.copy(ball);
    const up = Math.max(0, ball.y - this.ballR);
    const k = Math.max(0, 1 - up / BLOB_FADE_M);
    this.blob.visible = k > 0;
    this.blob.position.set(ball.x, 0.003, ball.z);
    this.blob.scale.setScalar(this.ballR * (3 + up * 8));
    this.blobMat.opacity = BLOB_A * k * k;
  }

  // a band sags under its own weight until it is stretched past its natural length
  private drape(chain: Mesh[], from: Vector3, to: Vector3) {
    const d = from.distanceTo(to);
    const sag = d < this.bandM ? Math.sqrt((3 * d * (this.bandM - d)) / 8) : 0;
    p0.copy(from);
    for (let i = 0; i < BAND_SEGS; i++) {
      const u = (i + 1) / BAND_SEGS;
      p1.lerpVectors(from, to, u);
      p1.y -= sag * Math.sin(Math.PI * u);
      span(chain[i], p0, p1);
      chain[i].scale.y += BAND_R; // overlap the joints
      p0.copy(p1);
    }
  }

  dispose() {
    // shared geometries are listed once per mesh, disposing twice is harmless
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
  }
}

function polished(map: Texture) {
  return new MeshPhysicalMaterial({
    map,
    roughness: 0.42,
    clearcoat: 0.7,
    clearcoatRoughness: 0.2,
  });
}

// stretch a unit cylinder between two points
function span(m: Mesh, from: Vector3, to: Vector3) {
  a.subVectors(to, from);
  const len = a.length() || 1e-4;
  m.position.addVectors(from, to).multiplyScalar(0.5);
  m.quaternion.copy(rq.setFromUnitVectors(UP, a.divideScalar(len)));
  m.scale.y = len;
}

// unit-radius tube to a radius that thins from root to tip
function taper(geo: TubeGeometry, curve: CatmullRomCurve3) {
  const pos = geo.getAttribute("position");
  const p = new Vector3();
  for (let i = 0; i <= ARM_SEGS; i++) {
    const t = i / ARM_SEGS;
    curve.getPointAt(t, p);
    const rad = ARM_ROOT_R + (ARM_TIP_R - ARM_ROOT_R) * Math.pow(t, 0.7);
    for (let j = 0; j <= ARM_RADIAL; j++) {
      const v = i * (ARM_RADIAL + 1) + j;
      pos.setXYZ(
        v,
        p.x + (pos.getX(v) - p.x) * rad,
        p.y + (pos.getY(v) - p.y) * rad,
        p.z + (pos.getZ(v) - p.z) * rad,
      );
    }
  }
  pos.needsUpdate = true;
  geo.computeBoundingSphere();
  return geo;
}

// streaky walnut grain, runs along the length of every piece
function woodGrain() {
  const cv = document.createElement("canvas");
  cv.width = 128;
  cv.height = 256;
  const g = cv.getContext("2d");
  if (g) {
    g.fillStyle = WALNUT;
    g.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 70; i++) {
      const x = Math.random() * 128;
      const w = 0.5 + Math.random() * 2.5;
      g.fillStyle = Math.random() < 0.6 ? "rgba(40,18,8,0.35)" : "rgba(150,90,50,0.25)";
      g.fillRect(x, 0, w, 256);
    }
  }
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  return tex;
}

// radial falloff, white so the material colour tints it
function softDot() {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 64;
  const g = cv.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.4, "rgba(255,255,255,0.6)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  return new CanvasTexture(cv);
}
