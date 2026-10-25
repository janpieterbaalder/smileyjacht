// Procedural smiley: a flat round yellow disc (60 mm, 2.5 mm thick) with a face, folded down the middle: the two
// halves ARE its wings. Spread flat it is a whole smiley; with the wings closed over its back it is a half disc. Flight
// pose from the brain (the fold tilts with the wings' force and pitches with every beat), each half at the brain's wing
// angle; resting flat on its surface (wings spread or closed); in the net it tumbles with the bag. Local frame: +z = the
// top of the face (along the fold: head, forward in flight), +y = the back (up in flight, away from the surface at
// rest), +x = right.
import { Scene } from '@babylonjs/core/scene';
import { Vector3, Quaternion, Matrix } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { surfaceBasis, REST_GAP, type SmileyBrain } from './brain';
import { ProbeDiffusePlugin } from '../engine/lightmap';

/** disc radius and thickness (m): 60 mm across, about a cabbage white's wingspan */
export const DISC = { r: 0.03, t: 0.0025 };
let shared: { face: PBRMaterial; shade: StandardMaterial; diffuse: ProbeDiffusePlugin[] } | null = null;

/** Readability: a 60 mm disc is a clear yellow dot up close; far off on a phone it shrinks to a few pixels, so the
 * drawn model grows a little with distance (at most 1.5x from ~3.4 m). Flight, landing and the catch test keep the
 * true size. */
export const READABILITY = { base: 1, from: 1.5, power: 0.5, max: 1.5 };
export function readabilityScale(dist: number): number {
  const r = READABILITY;
  return Math.min(r.max, r.base * Math.pow(Math.max(dist, r.from) / r.from, r.power));
}

function materials(scene: Scene) {
  if (shared && shared.face.getScene() === scene) return shared;
  // card-like painted disc: the face on both sides, the edge darker yellow (the texture's rim colour)
  const face = new PBRMaterial('smiley_gezicht', scene);
  face.albedoTexture = faceTexture(scene); face.albedoColor = new Color3(1, 1, 1);
  // matt painted card (no translucency: light from the wall side behind it washed the yellow out to cream)
  face.roughness = 0.7; face.metallic = 0; face.environmentIntensity = 1;
  face.backFaceCulling = false; face.twoSidedLighting = true;
  // soft contact shadow under a resting smiley (diffuse room light)
  const shade = new StandardMaterial('smiley_schaduw', scene);
  shade.diffuseTexture = shadowTexture(scene); shade.diffuseTexture.hasAlpha = true; shade.useAlphaFromDiffuseTexture = true;
  shade.disableLighting = true; shade.emissiveColor = new Color3(0, 0, 0); shade.specularColor = new Color3(0, 0, 0); shade.zOffset = -1; shade.backFaceCulling = false;
  shared = { face, shade, diffuse: [new ProbeDiffusePlugin(face)] };
  return shared;
}

/** The face: yellow with a slight dome shading, two oval eyes with a glint, a broad smile. Top of the face = +v. */
function faceTexture(scene: Scene) {
  const S = 256, t = new DynamicTexture('smiley_gezichttex', { width: S, height: S }, scene, true);
  const c = t.getContext() as CanvasRenderingContext2D;
  const g = c.createRadialGradient(S * 0.42, S * 0.38, S * 0.05, S / 2, S / 2, S * 0.52);
  g.addColorStop(0, '#ffe45c'); g.addColorStop(0.7, '#ffcf1f'); g.addColorStop(1, '#f2b10d');
  c.fillStyle = g; c.fillRect(0, 0, S, S);
  c.fillStyle = '#2b1a08';
  for (const x of [0.36, 0.64]) { c.beginPath(); c.ellipse(S * x, S * 0.38, S * 0.045, S * 0.085, 0, 0, Math.PI * 2); c.fill(); }
  c.fillStyle = 'rgba(255,255,255,0.85)';
  for (const x of [0.345, 0.625]) { c.beginPath(); c.arc(S * x, S * 0.34, S * 0.014, 0, Math.PI * 2); c.fill(); }
  c.strokeStyle = '#2b1a08'; c.lineWidth = S * 0.045; c.lineCap = 'round';
  c.beginPath(); c.arc(S / 2, S * 0.5, S * 0.26, Math.PI * 0.18, Math.PI * 0.82); c.stroke();
  // the fold down the middle: a faint crease
  const fold = c.createLinearGradient(S / 2 - 3, 0, S / 2 + 3, 0);
  fold.addColorStop(0, 'rgba(120,70,0,0)'); fold.addColorStop(0.5, 'rgba(120,70,0,0.35)'); fold.addColorStop(1, 'rgba(120,70,0,0)');
  c.fillStyle = fold; c.fillRect(S / 2 - 3, 0, 6, S);
  t.update(); return t;
}

/** One half of the disc (a wing), hinged along the fold (local x = 0, along z): side +1 = right half (x >= 0), -1 =
 * left. Upper and lower face carry the face texture where that half lies in the whole disc (u = 0.5 + x / 2r, v =
 * 0.5 + z / 2r: the top of the face at +z); the edge takes the rim's colour. */
function halfDisc(scene: Scene, name: string, side: number): Mesh {
  const N = 24, r = DISC.r, h = DISC.t / 2, pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const ring: [number, number][] = [];
  for (let i = 0; i <= N; i++) { const th = -Math.PI / 2 + Math.PI * i / N; ring.push([side * r * Math.cos(th), r * Math.sin(th)]); }
  const U = (x: number) => 0.5 + x / (2 * r), Vv = (z: number) => 0.5 + z / (2 * r);
  // upper and lower faces: a fan from the fold's middle
  for (const [y, up] of [[h, true], [-h, false]] as const) {
    const c0 = pos.length / 3;
    pos.push(0, y, 0); uv.push(0.5, 0.5);
    for (const [x, z] of ring) { pos.push(x, y, z); uv.push(U(x), Vv(z)); }
    for (let i = 0; i < N; i++) {
      const a = c0 + 1 + i, b = c0 + 2 + i;
      // wound (Babylon's convention, VertexData.ComputeNormals) so that the normal points to +y on top, -y below
      if (up === (side > 0)) idx.push(c0, a, b); else idx.push(c0, b, a);
    }
  }
  // the edge: round rim and the flat side along the fold
  const e0 = pos.length / 3;
  for (const [x, z] of ring) { pos.push(x, h, z, x, -h, z); uv.push(U(x * 0.99), Vv(z * 0.99), U(x * 0.99), Vv(z * 0.99)); }
  for (let i = 0; i < N; i++) {
    const a = e0 + 2 * i, b = a + 1, c = a + 2, d = a + 3;
    if (side > 0) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
  }
  const vd = new VertexData();
  vd.positions = pos; vd.uvs = uv; vd.indices = idx;
  const nrm: number[] = []; VertexData.ComputeNormals(pos, idx, nrm); vd.normals = nrm;
  const m = new Mesh(name, scene); vd.applyToMesh(m);
  return m;
}

function shadowTexture(scene: Scene) {
  const t = new DynamicTexture('smiley_schaduwtex', { width: 64, height: 64 }, scene, true);
  const c = t.getContext() as CanvasRenderingContext2D;
  c.clearRect(0, 0, 64, 64);
  const g = c.createRadialGradient(32, 32, 4, 32, 32, 31); g.addColorStop(0, 'rgba(0,0,0,0.36)'); g.addColorStop(0.55, 'rgba(0,0,0,0.16)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fillRect(0, 0, 64, 64);
  t.update(); return t;
}

export class SmileyVisual {
  root: TransformNode; wingL: Mesh; wingR: Mesh; shadow: Mesh;
  /** current readability scale (for tests/diagnostics) */
  scale = 1;
  private tmpQ = new Quaternion(); private tmpR = new Quaternion();
  constructor(scene: Scene, id: number) {
    const m = materials(scene);
    this.root = new TransformNode('smiley_' + id, scene);
    // the two halves of the disc, each turning about the fold (local z axis through the centre)
    this.wingR = halfDisc(scene, 'smiley_rechts_' + id, 1); this.wingL = halfDisc(scene, 'smiley_links_' + id, -1);
    for (const w of [this.wingR, this.wingL]) { w.material = m.face; w.parent = this.root; w.isPickable = false; }
    // contact shadow: in the surface plane under the disc (local xz plane = surface, just under it)
    this.shadow = MeshBuilder.CreateGround('smiley_schaduw', { width: 0.085, height: 0.085 }, scene);
    this.shadow.material = m.shade; this.shadow.parent = this.root; this.shadow.position.set(0, -DISC.t / 2 - 0.0004, 0);
    this.shadow.isPickable = false;
  }

  setDiffuseGain(g: number) { for (const p of materials(this.root.getScene()).diffuse) p.gain = g; }

  setReflection(tex: import('@babylonjs/core/Materials/Textures/baseTexture').BaseTexture | undefined) {
    const m = materials(this.root.getScene());
    if (tex) m.face.reflectionTexture = tex;
  }

  /** Orientation resting on its surface: the disc flat on it, its back away from it, heading headAngle in surfaceBasis. */
  private restQuat(b: SmileyBrain, out: Quaternion) {
    const n = new Vector3(b.nx, b.ny, b.nz);
    const { t1, t2 } = surfaceBasis(b.nx, b.ny, b.nz), c = Math.cos(b.headAngle), s = Math.sin(b.headAngle);
    const fwd = new Vector3(t1[0] * c + t2[0] * s, t1[1] * c + t2[1] * s, t1[2] * c + t2[2] * s).normalize();
    const right = Vector3.Cross(n, fwd).normalize();
    Quaternion.FromRotationMatrixToRef(Matrix.FromValues(right.x, right.y, right.z, 0, n.x, n.y, n.z, 0, fwd.x, fwd.y, fwd.z, 0, 0, 0, 0, 1), out);
  }

  /** last heading in flight (kept while it hovers almost still) */
  private flightFwd = new Vector3(0, 0, 1);
  /** the curtain's displacement it was drawn with; let go over ~0.1 s once it leaves the fabric (no jump) */
  private carry = new Vector3(); private lastT = -1;
  /** caught: a tumbling orientation and its spin (rad/s) */
  private tumble = Quaternion.Identity(); private spin = new Vector3();

  /** Babylon frame pose from the brain. eye: camera position (readability scale by distance). off: where the surface
   * under a resting smiley has moved to (a curtain that sways). inNet: where it sits in the net's bag when caught. */
  sync(b: SmileyBrain, t: number, eye?: { x: number; y: number; z: number }, off?: { x: number; y: number; z: number }, inNet?: { x: number; y: number; z: number } | null) {
    const r = this.root;
    if (b.state === 'jarred' || b.state === 'gone') { r.setEnabled(false); return; }
    r.setEnabled(true);
    const k = this.scale = b.state === 'caught' ? 1 : eye ? readabilityScale(Math.hypot(b.x - eye.x, b.y - eye.y, b.z - eye.z)) : READABILITY.base;
    r.scaling.setAll(k);
    this.shadow.setEnabled(b.state === 'rest');
    const dt = this.lastT < 0 ? 0 : Math.min(0.1, Math.max(0, t - this.lastT));
    this.lastT = t;
    if (off) this.carry.set(off.x, off.y, off.z);
    else if (this.carry.lengthSquared() > 1e-12) this.carry.scaleInPlace(Math.exp(-dt / 0.04));
    const ox = this.carry.x, oy = this.carry.y, oz = this.carry.z;
    this.setWings(b.wingAngle);
    if (b.state === 'caught') {
      // in the bag: it tumbles about as it beats (the bag carries it)
      const p = inNet ?? { x: b.x, y: b.y, z: b.z };
      b.x = p.x; b.y = p.y; b.z = p.z;
      const kick = b.struggling ? 40 : 4;
      this.spin.x += (Math.random() - 0.5) * kick * dt * 10; this.spin.y += (Math.random() - 0.5) * kick * dt * 10; this.spin.z += (Math.random() - 0.5) * kick * dt * 10;
      this.spin.scaleInPlace(Math.exp(-dt * 5));
      const dq = Quaternion.RotationYawPitchRoll(this.spin.y * dt, this.spin.x * dt, this.spin.z * dt);
      this.tumble = dq.multiply(this.tumble).normalize();
      r.rotationQuaternion = this.tumble.clone();
      const jig = b.struggling ? 0.004 : 0.001;
      r.position.set(p.x + (Math.random() - 0.5) * jig, p.y + (Math.random() - 0.5) * jig, p.z + (Math.random() - 0.5) * jig);
      return;
    }
    const n = new Vector3(b.nx, b.ny, b.nz);
    if (b.state === 'rest') {
      this.restQuat(b, this.tmpQ);
      r.rotationQuaternion = this.tmpQ.clone();
      // the brain keeps it REST_GAP off its surface; the disc lies ON the surface (its lower face touching)
      const lift = DISC.t / 2 * k - REST_GAP;
      r.position.set(b.x + n.x * lift + ox, b.y + n.y * lift + oy, b.z + n.z * lift + oz);
      return;
    }
    // flight: forward = the horizontal heading, the back tilted toward the wings' force, pitching with the beat
    const sp = Math.hypot(b.vx, b.vz);
    if (sp > 0.05) this.flightFwd.set(b.vx / sp, 0, b.vz / sp);
    const up = new Vector3(b.ax, b.ay, b.az);
    if (up.y < 0.2) up.y = 0.2;
    up.normalize();
    // nose up: steep in slow flight (~55 deg hovering), flatter when fast (~25 deg at 1.2 m/s), as butterflies fly;
    // rocking +-14 deg over a beat (the body pitches as the wings go down and up)
    const beat = b.gliding ? 0 : Math.sin(b.wingPhase + 0.6);
    const pitch = 0.95 - 0.5 * Math.min(1, Math.hypot(b.vx, b.vy, b.vz) / 1.2) + 0.25 * beat;
    let fwd = this.flightFwd.subtract(up.scale(Vector3.Dot(this.flightFwd, up)));
    if (fwd.lengthSquared() < 1e-6) fwd = new Vector3(0, 0, 1);
    fwd.normalize();
    const right = Vector3.Cross(up, fwd).normalize();
    const cp = Math.cos(pitch), spn = Math.sin(pitch);
    const f2 = fwd.scale(cp).add(up.scale(spn)), u2 = up.scale(cp).subtract(fwd.scale(spn));
    Quaternion.FromRotationMatrixToRef(Matrix.FromValues(right.x, right.y, right.z, 0, u2.x, u2.y, u2.z, 0, f2.x, f2.y, f2.z, 0, 0, 0, 0, 1), this.tmpQ);
    // touching down or taking off: turned part of the way into (or out of) the resting pose
    const s = b.settle;
    if (s > 0) {
      this.restQuat(b, this.tmpR);
      Quaternion.SlerpToRef(this.tmpQ, this.tmpR, s * s * (3 - 2 * s), this.tmpQ);
      const lift = (DISC.t / 2 * k - REST_GAP) * s;
      r.position.set(b.x + n.x * lift + ox, b.y + n.y * lift + oy, b.z + n.z * lift + oz);
    } else r.position.set(b.x + ox, b.y + oy, b.z + oz);
    r.rotationQuaternion = this.tmpQ.clone();
  }

  /** both halves at angle a (rad, + = up over the back; 0 = flat, a whole disc; pi/2 = closed, a half disc) */
  private setWings(a: number) {
    this.wingR.rotation.set(0, 0, a);
    this.wingL.rotation.set(0, 0, -a);
    // closed over the back the shadow is that of a half disc seen edge-on: narrower
    this.shadow.scaling.x = 0.35 + 0.65 * Math.max(0, Math.cos(a));
  }

  dispose() { this.root.dispose(false, false); }
}
