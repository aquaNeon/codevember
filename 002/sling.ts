import {
  CanvasTexture,
  CatmullRomCurve3,
  CylinderGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
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
const POUCH_HALF_M = 0.05; // bands meet the pouch either side of the ball
const STRAP_R = 0.016;
const SLACK_M = 0.05; // empty pouch hangs back a little
const WALNUT = "#6a3a1f";

const UP = new Vector3(0, 1, 0);
const a = new Vector3();
const l = new Vector3();
const r = new Vector3();
const c = new Vector3();
const rq = new Quaternion();

// SLING
// polished walnut fork, twine wraps, amber tubes, a leather pouch and a steel ball
export class Sling {
  readonly group = new Group();
  readonly ball: Mesh;
  private pouch: Mesh;
  private tips: Vector3[];
  private bands: Mesh[];
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
    const leather = new MeshStandardMaterial({ color: 0x24211e, roughness: 0.7 });
    const steel = new MeshStandardMaterial({ color: 0xdadada, metalness: 1, roughness: 0.2 });
    this.disposables.push(grain, armGrain, wood, armWood, twine, latex, leather, steel);

    const x = rest.x;
    const z = rest.z;
    const tipY = rest.y + FORK_RISE_M;
    const crotchY = tipY - ARM_M;
    this.tips = [new Vector3(x - FORK_SPAN_M, tipY, z), new Vector3(x + FORK_SPAN_M, tipY, z)];

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
    for (const side of [-1, 1]) {
      const curve = new CatmullRomCurve3([
        new Vector3(x, crotchY - 0.01, z),
        new Vector3(x + side * 0.05, crotchY + 0.07, z),
        new Vector3(x + side * FORK_SPAN_M * 0.8, crotchY + ARM_M * 0.55, z),
        new Vector3(x + side * FORK_SPAN_M, tipY, z),
      ]);
      const armGeo = taper(new TubeGeometry(curve, ARM_SEGS, 1, ARM_RADIAL, false), curve);
      add(armGeo, new Mesh(armGeo, armWood));
      const tip = add(knob, new Mesh(knob, wood));
      tip.position.set(x + side * FORK_SPAN_M, tipY, z);
      tip.scale.set(ARM_TIP_R, ARM_TIP_R * 0.6, ARM_TIP_R);
    }
    const wrapGeo = new CylinderGeometry(ARM_TIP_R * 1.18, ARM_TIP_R * 1.18, WRAP_M, 16);
    for (const tip of this.tips) {
      const wrap = add(wrapGeo, new Mesh(wrapGeo, twine));
      wrap.position.copy(tip).setY(tip.y - WRAP_M * 0.7);
      wrap.rotation.z = Math.sign(tip.x - x) * -0.18; // follows the lean of the arm
    }

    // BANDS
    const rod = new CylinderGeometry(1, 1, 1, 10, 1);
    this.bands = [add(rod, new Mesh(rod, latex)), add(rod, new Mesh(rod, latex))];
    for (const b of this.bands) b.scale.set(BAND_R, 1, BAND_R);
    this.pouch = add(rod, new Mesh(rod, leather));

    const steelBall = new SphereGeometry(ballR, 24, 16);
    this.ball = add(steelBall, new Mesh(steelBall, steel));
  }

  // bands run to the pouch, which cradles the ball while it is loaded
  pose(ball: Vector3, loaded: boolean) {
    if (loaded) c.copy(ball).setZ(ball.z + this.ballR * 0.75);
    else c.copy(this.rest).setZ(this.rest.z + SLACK_M);
    l.copy(c).setX(c.x - POUCH_HALF_M);
    r.copy(c).setX(c.x + POUCH_HALF_M);
    span(this.bands[0], this.tips[0], l);
    span(this.bands[1], this.tips[1], r);
    // a thin strap behind the ball, so the steel still shows
    span(this.pouch, l, r);
    this.pouch.scale.x = STRAP_R;
    this.pouch.scale.z = STRAP_R * 0.45;
    this.ball.position.copy(ball);
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
