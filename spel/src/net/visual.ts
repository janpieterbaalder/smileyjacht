// First-person arm: MakeHuman-based hand (arm.glb 'hand'), one continuous knitted sleeve from the cuff over the bent
// elbow into a torso (armgeom.ts, two-bone IK from a body-fixed shoulder socket to the wrist, rebuilt per frame), and
// the butterfly net following the physical swing pose: hoop with its sewn band, ferrule, straight wooden handle, and
// the netting bag as simulated cloth (bag.ts). (arm.glb also holds the swatter of the smiley game: not shown.)
import { Scene } from '@babylonjs/core/scene';
import { Vector3, Matrix, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import { ImportMeshAsync } from '@babylonjs/core/Loading/sceneLoader';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { ARM_CLEAR, HAND, allocSleeve, armPole, bodyFrame, buildSleeve, buildTorso, clearArmPole, handOnHandle, knitTextures, shoulderAt, shoulderLift, solveArm, type TubeBuffers, type ArmJoints, type P3 } from './armgeom';
import { NET, WIRE, type Pose, type CamFrame } from './swing';
import { NetBag, BAG } from './bag';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { TriBVH } from '../physics/bvh';
import { ProbeDiffusePlugin } from '../engine/lightmap';

/** beech handle, white cotton band and netting (plausible choices, not from a photo) */
const WOOD = new Color3(0.72, 0.55, 0.34), BAND = new Color3(0.86, 0.85, 0.80), NETTING = new Color3(0.93, 0.93, 0.90);

/** knitted jumper: heather blue-grey (a plausible choice, not from a photo) */
const JUMPER = new Color3(0.20, 0.215, 0.235);

function basisToQuat(x: Vector3, y: Vector3, z: Vector3): Quaternion {
  const m = Matrix.FromValues(x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, z.x, z.y, z.z, 0, 0, 0, 0, 1);
  return Quaternion.FromRotationMatrix(m);
}
const V = (a: { x: number; y: number; z: number }) => new Vector3(a.x, a.y, a.z);

export class ArmVisual {
  head!: TransformNode; hand!: TransformNode;
  sleeve!: Mesh; torso!: Mesh;
  /** last solved arm joints (diagnostics) */
  joints: ArmJoints | null = null;
  private sleeveBuf: TubeBuffers = allocSleeve();
  meshes: AbstractMesh[] = [];
  private diffuse: { material: PBRMaterial; plugin: ProbeDiffusePlugin }[] = [];
  ready = false;
  /** capsule penetration test against the world (set by the session): the elbow swings away from walls */
  armDepth: ((a: P3, b: P3, r: number) => number) | null = null;
  /** smoothed elbow direction (a new clear pose is eased in, no pop) */
  private pole: Vector3 | null = null;
  /** the handle (a unit cylinder placed every frame from the ferrule to past the hand) and its end cap */
  private handle!: Mesh; private cap!: Mesh;
  /** the netting bag: cloth simulation and its mesh */
  bag: NetBag | null = null; private bagMesh!: Mesh;
  private bagBuf!: { positions: Float32Array; normals: Float32Array; indices: number[] };
  /** collision world for the bag (set by the session) */
  bvh: TriBVH | null = null;
  /** the torso as built (standing) and how far its belly is shortened now (1 = standing) */
  private torsoRest!: Float32Array; private torsoK = 1;

  async load(scene: Scene) {
    const res = await ImportMeshAsync(import.meta.env.BASE_URL + 'assets/arm.glb', scene);
    // multi-primitive glTF meshes arrive as a node with primitive children: search transform nodes as well
    const byName = (n: string) => (res.meshes.find((m) => m.name === n) ?? res.transformNodes.find((t) => t.name === n)) as TransformNode | undefined;
    const mk = (n: string) => {
      const t = new TransformNode(n + '_pivot', scene);
      const m = byName(n);
      if (!m) throw new Error('arm.glb mist ' + n);
      m.parent = t; m.position.setAll(0); m.rotationQuaternion = Quaternion.Identity(); m.scaling.setAll(1);
      return t;
    };
    this.hand = mk('hand');
    // the swatter in arm.glb is not used: hidden
    const hidden: AbstractMesh[] = [];
    for (const n of ['mepper_kop', 'mepper_steel']) {
      const m = byName(n) as AbstractMesh | undefined;
      if (!m) continue;
      for (const x of [m, ...(m.getChildMeshes?.() ?? [])]) { x.setEnabled(false); hidden.push(x); }
    }
    this.buildNet(scene);
    // the rigid forearm sleeve of arm.glb is replaced by the continuous sleeve below
    const oldSleeve = byName('onderarm') as AbstractMesh | undefined;
    if (oldSleeve) { oldSleeve.setEnabled(false); for (const c of oldSleeve.getChildMeshes()) c.setEnabled(false); }
    this.buildCloth(scene);
    const ex = ((byName('hand') as AbstractMesh | undefined)?.metadata?.gltf?.extras ?? {}) as Record<string, unknown>;
    try {
      const lm = JSON.parse(String(ex.landmarks ?? '{}')) as { wrist?: number[]; forearm_dir?: number[] };
      if (lm.wrist) HAND.wrist = { x: lm.wrist[0], y: lm.wrist[1], z: lm.wrist[2] };
      if (lm.forearm_dir) HAND.forearm = { x: lm.forearm_dir[0], y: lm.forearm_dir[1], z: lm.forearm_dir[2] };
    } catch { /* keep default */ }
    for (const m of res.meshes) {
      m.isPickable = false; m.renderingGroupId = 1;       // drawn after world: never hidden behind near geometry
      if (m.getTotalVertices() > 0 && m.isEnabled(false) && !hidden.includes(m) && (!oldSleeve || (m !== oldSleeve && m.parent !== oldSleeve))) this.meshes.push(m);
      const mat = m.material as PBRMaterial | null;
      if (mat instanceof PBRMaterial) {
        mat.environmentIntensity = 1;
        if (!this.diffuse.some((d) => d.material === mat)) this.diffuse.push({ material: mat, plugin: new ProbeDiffusePlugin(mat) });
        if (m.name === 'hand') { mat.roughness = 0.5; mat.metallic = 0; mat.sheen.isEnabled = true; mat.sheen.intensity = 0.25; mat.sheen.color = new Color3(1, 0.85, 0.8); }
        if (mat.name.includes('gaas')) { mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST; mat.alphaCutOff = 0.5; mat.backFaceCulling = false; if (mat.albedoTexture) mat.albedoTexture.hasAlpha = true; }
      }
    }
    for (const m of this.meshes) m.renderingGroupId = 1;
    scene.setRenderingAutoClearDepthStencil(1, false, false, false);
    this.ready = true;
  }

  /** probe diffuse scale of the room the camera is in (World.diffuseGainAt) */
  setDiffuseGain(g: number) { for (const d of this.diffuse) d.plugin.gain = g; }

  setReflection(tex: BaseTexture | undefined) {
    if (!tex) return;
    for (const m of this.meshes) { const mat = m.material as PBRMaterial | null; if (mat instanceof PBRMaterial) mat.reflectionTexture = tex; }
  }

  /** Place swatter/hand from the physical pose; forearm/upper arm by two-bone IK from the shoulder. bodyHeight: the eye
   * above the feet (m): bent down low, the torso is shorter (its belly would reach through the floor). */
  sync(p: Pose, c: CamFrame, hand: number, bodyHeight = 1.62, dt = 1 / 60) {
    if (!this.ready) return;
    this.fitTorso(bodyHeight);
    const r = V(p.r), n = V(p.n), u = V(p.u);
    // hoop frame: X -> r, Y (normal of the opening) -> n, Z -> -u (the ferrule and handle lie toward local -Z)
    const q = basisToQuat(r, n, u.scale(-1));
    this.head.position.copyFrom(V(p.h)); this.head.rotationQuaternion = q;
    // the handle from the ferrule to the hand and on; grip and hand follow the handle frame at the hand
    const hu = V(p.hu), hn = V(p.hn);
    this.updateHandle(p);
    this.updateBag(p, dt);
    // hand (hammer grip, armgeom.handAxes): model X -> face normal, model Y (palm) -> -r, model Z -> -handle;
    // the left-handed option mirrors the palm axis
    const grip = V(p.grip);
    this.hand.position.copyFrom(grip); this.hand.rotationQuaternion = basisToQuat(hn, r.scale(-1), hu.scale(-1));
    this.hand.scaling.set(1, hand, 1);
    const hw = handOnHandle(p.grip, p.r, p.hu, p.hn, hand);
    const wrist = V(hw.wrist), fdir = V(hw.fdir);
    // body frame: follows the view yaw (and the lean/crouch through the eye), not the head pitch
    const bf = bodyFrame(c.f, c.r);
    const fwdFlat = V(bf.fwd), rightFlat = V(bf.right);
    const eye = V(c.eye);
    // standing with the shoulder against a wall (the body keeps 0.20 m, the shoulder sits 0.19 m out): the shoulder is
    // pressed in rather than drawn inside the wall
    const s0 = shoulderAt(c.eye, bf.fwd, bf.right, hand);
    const inDepth = this.armDepth ? this.armDepth(s0, s0, ARM_CLEAR.shoulder) : 0;
    const pressed = inDepth > 0 ? { x: s0.x - bf.right.x * hand * inDepth, y: s0.y, z: s0.z - bf.right.z * hand * inDepth } : s0;
    // reaching up lifts the shoulder with the shoulder blade (as the strike planner assumes)
    const sock = { x: pressed.x, y: pressed.y + shoulderLift(pressed, hw.wrist), z: pressed.z };
    const socket = V(sock);
    const pref = armPole(bf.right, hand);
    const want = V(this.armDepth ? clearArmPole(hw.wrist, hw.fdir, sock, pref, this.armDepth) : pref).normalize();
    this.pole = this.pole ? Vector3.Lerp(this.pole, want, 0.35).normalize() : want;
    const pole = this.pole;
    const j = solveArm(wrist, fdir, socket, pole);
    this.joints = j;
    buildSleeve(this.sleeveBuf, j, fdir, n);
    this.sleeve.updateVerticesData(VertexBuffer.PositionKind, this.sleeveBuf.positions);
    this.sleeve.updateVerticesData(VertexBuffer.NormalKind, this.sleeveBuf.normals);
    this.sleeve.updateVerticesData(VertexBuffer.UVKind, this.sleeveBuf.uvs);
    // the bounds follow the rebuilt sleeve: the mirror selects what it draws by bounds, and a box stuck at the origin
    // left the sleeve out of the reflection (REVIEW-01 G-01)
    this.sleeve.refreshBoundingInfo();
    this.torso.position.copyFrom(eye);
    this.torso.rotationQuaternion = basisToQuat(rightFlat, new Vector3(0, 1, 0), fwdFlat.scale(-1));
  }

  /** Continuous sleeve (updated per frame) and torso in one knitted jumper material. */
  private buildCloth(scene: Scene) {
    const tx = knitTextures(128);
    const mk = (data: Uint8Array, gamma: boolean) => {
      const t = RawTexture.CreateRGBATexture(data, 128, 128, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
      t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE; t.gammaSpace = gamma; t.anisotropicFilteringLevel = 4;
      return t;
    };
    const m = new PBRMaterial('trui_breisel', scene);
    m.albedoColor = JUMPER; m.albedoTexture = mk(tx.albedo, true);
    m.bumpTexture = mk(tx.normal, false); m.bumpTexture.level = 0.55;
    m.metallic = 0; m.roughness = 0.92;
    m.sheen.isEnabled = true; m.sheen.intensity = 0.35; m.sheen.color = new Color3(0.75, 0.78, 0.82); m.sheen.roughness = 0.6;
    m.backFaceCulling = false; m.twoSidedLighting = true;
    this.diffuse.push({ material: m, plugin: new ProbeDiffusePlugin(m) });
    const sl = new Mesh('mouw', scene);
    const vd = new VertexData();
    vd.positions = this.sleeveBuf.positions; vd.normals = this.sleeveBuf.normals; vd.uvs = this.sleeveBuf.uvs; vd.indices = this.sleeveBuf.indices;
    vd.applyToMesh(sl, true);
    sl.material = m; sl.alwaysSelectAsActiveMesh = true; sl.isPickable = false;
    const tb = buildTorso();
    const to = new Mesh('romp', scene);
    const vt = new VertexData();
    vt.positions = tb.positions; vt.normals = tb.normals; vt.uvs = tb.uvs; vt.indices = tb.indices;
    vt.applyToMesh(to, true);
    this.torsoRest = Float32Array.from(tb.positions);
    to.material = m; to.alwaysSelectAsActiveMesh = true; to.isPickable = false;
    this.sleeve = sl; this.torso = to;
    this.meshes.push(sl, to);
  }

  /** Squatting or on hands and knees the body below the chest folds up: the torso's belly (below CHEST m under the eye)
   * is shortened so that it ends 8 cm above the floor; the chest and shoulders keep their shape (the arm hangs there). */
  private fitTorso(bodyHeight: number) {
    const CHEST = 0.32, FULL = 1.0;
    const k = Math.min(1, Math.max(0.15, (bodyHeight - 0.08 - CHEST) / (FULL - CHEST)));
    if (Math.abs(k - this.torsoK) < 0.01 && (k < 1 || this.torsoK === 1)) return;
    this.torsoK = k;
    const P = Float32Array.from(this.torsoRest);
    for (let i = 1; i < P.length; i += 3) if (P[i] < -CHEST) P[i] = -CHEST + (P[i] + CHEST) * k;
    this.torso.updateVerticesData(VertexBuffer.PositionKind, P);
  }

  /** Hoop (wire inside a sewn cotton band), ferrule, handle, end cap and the netting bag. */
  private buildNet(scene: Scene) {
    const R = NET.R;
    this.head = new TransformNode('net_beugel_pivot', scene);
    const metal = new PBRMaterial('net_metaal', scene);
    metal.albedoColor = new Color3(0.62, 0.63, 0.64); metal.metallic = 1; metal.roughness = 0.38;
    const band = new PBRMaterial('net_band', scene);
    band.albedoColor = BAND; band.metallic = 0; band.roughness = 0.9;
    band.sheen.isEnabled = true; band.sheen.intensity = 0.3; band.sheen.color = new Color3(0.9, 0.9, 0.88);
    const wood = new PBRMaterial('net_steel_hout', scene);
    wood.albedoColor = WOOD; wood.metallic = 0; wood.roughness = 0.5; wood.albedoTexture = woodTexture(scene);
    const rubber = new PBRMaterial('net_dop', scene);
    rubber.albedoColor = new Color3(0.06, 0.06, 0.06); rubber.metallic = 0; rubber.roughness = 0.7;
    // the band the netting is sewn into: a torus round the 7 mm wire (Babylon's torus lies in its XZ plane)
    const hoop = MeshBuilder.CreateTorus('net_beugel', { diameter: 2 * R, thickness: 2 * (NET.tube + 0.0022), tessellation: 64 }, scene);
    hoop.material = band; hoop.parent = this.head;
    // ferrule: where the wire's ends go into the handle, from the rim to the handle's end (along u = local -Z)
    const ferL = HAND.neck - R + 0.012;
    const fer = MeshBuilder.CreateCylinder('net_huls', { height: ferL, diameter: 0.014, tessellation: 16 }, scene);
    fer.material = metal; fer.parent = this.head; fer.rotation.x = Math.PI / 2; fer.position.set(0, 0, -(R + ferL / 2));
    this.handle = MeshBuilder.CreateCylinder('net_steel', { height: 1, diameter: 2 * NET.handle, tessellation: 18 }, scene);
    this.handle.material = wood;
    this.cap = MeshBuilder.CreateSphere('net_dop', { diameter: 2 * NET.handle + 0.003, segments: 10 }, scene);
    this.cap.material = rubber; this.cap.scaling.set(1, 0.6, 1);
    // netting: rings x around particles (bag.ts) as one mesh; uv: around and down, the mesh texture tiles
    const A = BAG.around, Nr = BAG.rings, cnt = A * Nr + 1;
    const pos = new Float32Array(cnt * 3), nrm = new Float32Array(cnt * 3), uv = new Float32Array(cnt * 2), idx: number[] = [];
    // (~1 cm meshes: a ring is ~63 cm round at the rim, the bag ~30 cm deep)
    for (let k = 0; k < Nr; k++) for (let i = 0; i < A; i++) { const o = (k * A + i) * 2; uv[o] = i / A * 40; uv[o + 1] = k / Nr * 20; }
    uv[(cnt - 1) * 2] = 20; uv[(cnt - 1) * 2 + 1] = 20;
    for (let k = 0; k < Nr; k++) for (let i = 0; i < A; i++) {
      const a = k * A + i, b = k * A + (i + 1) % A;
      if (k + 1 < Nr) { const c2 = a + A, d = b + A; idx.push(a, c2, b, b, c2, d); } else idx.push(a, cnt - 1, b);
    }
    const net = new PBRMaterial('net_gaas', scene);
    net.albedoColor = NETTING; net.metallic = 0; net.roughness = 0.85;
    net.albedoTexture = nettingTexture(scene); net.albedoTexture.hasAlpha = true; net.useAlphaFromAlbedoTexture = true;
    net.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND; net.alpha = 1;
    net.backFaceCulling = false; net.twoSidedLighting = true;
    const bm = new Mesh('net_zak', scene);
    const vd = new VertexData();
    vd.positions = pos; vd.normals = nrm; vd.uvs = uv; vd.indices = idx;
    vd.applyToMesh(bm, true);
    bm.material = net; bm.isPickable = false; bm.alwaysSelectAsActiveMesh = true;
    this.bagMesh = bm; this.bagBuf = { positions: pos, normals: nrm, indices: idx };
    for (const m of [hoop, fer, this.handle, this.cap, bm]) { m.isPickable = false; m.renderingGroupId = 1; this.meshes.push(m); }
    for (const mat of [metal, band, wood, rubber, net]) this.diffuse.push({ material: mat, plugin: new ProbeDiffusePlugin(mat) });
  }

  /** The handle: straight from the ferrule along the handle direction through the grip, WIRE.pastGrip beyond it. */
  private updateHandle(p: Pose) {
    const a = V(p.h).add(V(p.u).scale(HAND.neck)), b = V(p.grip).add(V(p.hu).scale(WIRE.pastGrip));
    const d = b.subtract(a), L = d.length();
    this.handle.position.copyFrom(a.add(b).scale(0.5));
    this.handle.scaling.set(1, L, 1);
    const y = d.scale(1 / (L || 1)), x = Math.abs(y.y) < 0.9 ? Vector3.Cross(y, new Vector3(0, 1, 0)).normalize() : Vector3.Cross(y, new Vector3(1, 0, 0)).normalize();
    const qq = basisToQuat(x, y, Vector3.Cross(x, y));
    this.handle.rotationQuaternion = qq;
    this.cap.position.copyFrom(b); this.cap.rotationQuaternion = qq;
  }

  /** Steps the netting bag with the hoop where it is now and writes it into the mesh. */
  private updateBag(p: Pose, dt: number) {
    if (!this.bag) this.bag = new NetBag(NET.R, this.bvh);
    this.bag.step(Math.min(dt, 0.05), p.h, p.n, p.r, p.u);
    const P = this.bagBuf.positions;
    P.set(this.bag.pos);
    VertexData.ComputeNormals(P, this.bagBuf.indices, this.bagBuf.normals);
    this.bagMesh.updateVerticesData(VertexBuffer.PositionKind, P);
    this.bagMesh.updateVerticesData(VertexBuffer.NormalKind, this.bagBuf.normals);
    this.bagMesh.refreshBoundingInfo();
  }

  setVisible(v: boolean) { for (const m of this.meshes) m.setEnabled(v); }
}

/** Fine netting: a diamond mesh of thin threads with knots and a faint haze between them (tiled over the bag; seen
 * from further off the threads blend into the haze, as a real net reads as a pale veil). */
function nettingTexture(scene: Scene): DynamicTexture {
  const S = 64, t = new DynamicTexture('net_gaastex', { width: S, height: S }, scene, true);
  const c = t.getContext() as CanvasRenderingContext2D;
  c.clearRect(0, 0, S, S);
  c.fillStyle = 'rgba(240,240,235,0.10)'; c.fillRect(0, 0, S, S);
  c.strokeStyle = 'rgba(248,248,244,0.95)'; c.lineWidth = 2.2;
  // two diagonal families that wrap seamlessly
  for (const o of [-S, 0, S]) {
    c.beginPath(); c.moveTo(o, 0); c.lineTo(o + S, S); c.stroke();
    c.beginPath(); c.moveTo(o + S, 0); c.lineTo(o, S); c.stroke();
  }
  c.fillStyle = 'rgba(250,250,246,1)';
  for (const [x, y] of [[0, 0], [S, 0], [0, S], [S, S], [S / 2, S / 2]]) { c.beginPath(); c.arc(x, y, 2.4, 0, Math.PI * 2); c.fill(); }
  t.update(); t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE; t.anisotropicFilteringLevel = 8;
  return t;
}

/** Beech: light wood with fine streaks along the handle (texture v along the cylinder's axis). */
function woodTexture(scene: Scene): DynamicTexture {
  const t = new DynamicTexture('net_houttex', { width: 64, height: 256 }, scene, true);
  const c = t.getContext() as CanvasRenderingContext2D;
  c.fillStyle = '#d9c3a0'; c.fillRect(0, 0, 64, 256);
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * 64, w = 0.5 + Math.random() * 1.5;
    c.fillStyle = `rgba(120,80,40,${0.08 + Math.random() * 0.12})`; c.fillRect(x, 0, w, 256);
  }
  t.update(); t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE;
  return t;
}
