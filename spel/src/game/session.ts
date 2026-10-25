// Round runtime: smileys (brain + visual + flutter), net swing & contacts, catching (into the bag, then into the jar),
// doors, hints, eye adaptation between rooms and outdoors, completion and saving.
import type { Core } from './core';
import { PLAYER, POSTURE } from '../physics/player';
import type { AudioEngine } from '../audio/audio';
import { SURFACE_CLASSES, type Surface } from '../audio/audio';
import type { Save } from './save';
import { ROUNDS, PRACTICE, type RoundDef, type Spawn } from './rounds';
import { settleLeaves } from './doors';
import { SmileyBrain, type Threat } from '../smiley/brain';
import { SmileyVisual } from '../smiley/visual';
import { SwingSystem, restPose, type CamFrame, type ContactInfo, type SmileyTarget, type V3 } from '../net/swing';
import { ArmVisual } from '../net/visual';
import { TIPTOE, lookTiptoe } from '../net/armgeom';
import { ROOM_BOXES, roomAt } from '../engine/world';
import type { RayHit } from '../physics/bvh';
import { adaptTemperatureTint } from '../engine/whitebalance';
import { setImageProcessingQuiet } from '../engine/imageprocessing';

export interface SessionUI {
  onRoundEnd(res: { title: string; text: string; next: number | null; eyebrow: string }): void;
  onToast(msg: string, ms?: number): void;
  onObjective(label: string, text: string): void;
  onHint(text: string): void;
  /** caught so far and how many the round has */
  onCaught(n: number, total: number): void;
  onDoorCtx(label: string | null): void;
}

interface Smiley { brain: SmileyBrain; vis: SmileyVisual; prev: V3; deadAt: number; caughtAt: number; }
/** seconds a caught smiley flutters in the net before it goes into the jar */
export const IN_NET = 1.8;

const hit: RayHit = { t: 0, tri: 0, nx: 0, ny: 0, nz: 0 };
/** Eye adaptation (REVIEW-01 G-05). exposure = KEY * (L/L0)^g / L with L = baked log-average luminance (probes / sky,
 * world.luminanceAt; Cycles units), metered mostly over the view. Adapting fully (it used to be relative to the living
 * room of the same light state) showed every scene equally bright: the master bedroom by one reading lamp at x64, the
 * garden at night at x600-7200 - evening and night looked like day. Scenes brighter than L0 (daylight interiors) adapt
 * to within (L/L0)^0.1, so a sunlit garden still reads brighter than a room; darker scenes adapt only partly, (L/L0)^0.3:
 * a lamp-lit room at night reads a little dimmer than by day, the dusk bedroom and the garden at night read dark (in low
 * light the eye does not adapt completely). KEY 0.44 (was 0.36): between the user's own photos R12/R13 and the brighter
 * listing photos R01-R09 (REVIEW-01: daytime interiors L* 59-64 against 73-74 on neutral surfaces).
 * White balance: the photos are white-balanced by the camera on what they show, mostly walls and ceiling: 0.97 of the
 * warm-cool and 0.6 of the green-magenta cast of the light on walls and ceiling (lm/wb.json), metered 80 % over the view
 * (was 0.85 of the room average / 70 %: the living room stayed yellow, b* +9..+13 against +1..+4 on the photos). */
export const ADAPTATION = { key: 0.44, L0: 0.06, bright: 0.1, dim: 0.3, tau: 0.7, wb: 0.97, wbTint: 0.6, view: 0.8 };

/** Metering from indoors: the garden seen through a window counts within this factor of the room's luminance (the bright
 * garden by day, the black one at night: dark windows at night otherwise opened the exposure up to x29 in the living
 * room and x44 in the toilet). */
const OUTSIDE_CAP = 3;
/** The eyes adapt to a dark scene only so far in a few minutes: below this metered luminance the exposure stops rising
 * (outside at night the black sky and garden put the log-average at 0.00003-0.0004 and the lamp-lit facade was blown
 * out at x260-980). */
const L_MIN = 0.003;

/** Exposure for a (metered) scene luminance. */
export function exposureFor(L: number): number {
  const A = ADAPTATION, l = Math.max(L, L_MIN);
  return A.key * Math.pow(l / A.L0, l >= A.L0 ? A.bright : A.dim) / l;
}

const SOFT: Surface[] = ['fabric', 'leaves', 'plant', 'grass'];
/** A resting smiley whose curtain moves more than this (m) under it flies off. */
const CURTAIN_STARTLE = 0.01;
/** Room of a smiley. A resting one counts by the air side of its surface: a window pane lies a few cm outside the
 * room boxes, and one sitting on the inside of the glass counts for the room (REVIEW-01 G-09). */
export function smileyRoom(b: { state: string; x: number; z: number; nx: number; nz: number }): string {
  return b.state === 'rest' ? roomAt(b.x + b.nx * 0.15, b.z + b.nz * 0.15) : roomAt(b.x, b.z);
}
/** More than 20 cm outside every room (a smiley at the inside of a window or door pane is not). */
function clearlyOutside(x: number, z: number): boolean {
  for (const [id, [x0, z0, x1, z1]] of Object.entries(ROOM_BOXES)) {
    if (id !== 'buiten' && x > x0 - 0.2 && x < x1 + 0.2 && z > z0 - 0.2 && z < z1 + 0.2) return false;
  }
  return true;
}
const ROOM_NAMES: Record<string, string> = {
  woon: 'de woonkamer', kind1: 'de kinderkamer aan de verandakant', kind2: 'de kinderkamer aan de achterkant',
  ouder: 'de ouderslaapkamer', bad: 'de badkamer', wc: 'het toilet', buiten: 'buiten',
};

export class Session {
  active = false; paused = false; practice = false; roundIndex = 0;
  round: RoundDef = ROUNDS[0];
  smileys: Smiley[] = [];
  swing: SwingSystem;
  arm = new ArmVisual();
  t = 0; caught = 0; lastProgress = 0;
  helpLevel: 'uit' | 'licht' | 'veel' = 'licht';
  exposure = 1;
  private wbMired = 1e6 / 6500; private wbTint = 0;
  private lean = 0; private leanTarget = 0; private crouch = 0; private crouchTarget = 0;
  /** rise onto the toes (m): looking up, or a high swing */
  private tiptoe = 0; private toesTarget = 0;
  private incomingLeft = 0; private incomingTimer = 0;
  private stepPhase = 0; private endTimer = -1;
  private idCounter = 1; private whooshed = false;
  /** practice: room the last smiley came from (the next one comes from another) */
  private lastPracticeRoom = '';
  private armLoaded: Promise<void>;
  private threat: Threat = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, active: false };
  private offTmp = { x: 0, y: 0, z: 0 };

  constructor(public core: Core, public audio: AudioEngine, public save: Save, public ui: SessionUI) {
    this.swing = new SwingSystem(core.world.bvh, (o, d, max) => this.doorRay(o.x, o.y, o.z, d.x, d.y, d.z, max));
    this.arm.bvh = core.world.bvh;
    core.onUpdate((dt) => this.update(dt));
    // the drawn arm keeps out of walls and furniture (the net's chain itself is resolved in SwingSystem)
    const tmp = new Float32Array(3), bvh = core.world.bvh;
    this.arm.armDepth = (a, b, r) => {
      let worst = 0;
      for (let k = 0; k <= 4; k++) {
        const t = k / 4, px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t, pz = a.z + (b.z - a.z) * t;
        bvh.querySphere(px, py, pz, r, (tri) => {
          bvh.closestOnTri(tri, px, py, pz, tmp);
          const d = r - Math.hypot(px - tmp[0], py - tmp[1], pz - tmp[2]);
          if (d > worst) worst = d;
        }, 1 | 2 | 4 | 8);             // incl. walkable tops (a sideboard or bench counts as 'floor' for the feet)
        for (const o of core.world.doorObstacles()) {
          if (py < o.y0 || py > o.y1) continue;
          const ex = o.bx - o.ax, ez = o.bz - o.az, L2 = ex * ex + ez * ez || 1e-9;
          const u = Math.max(0, Math.min(1, ((px - o.ax) * ex + (pz - o.az) * ez) / L2));
          const d = r + o.half - Math.hypot(px - o.ax - ex * u, pz - o.az - ez * u);
          if (d > worst) worst = d;
        }
      }
      return worst;
    };
    // once the arm is in, warm the mirror again: the arm and the net show in it too
    this.armLoaded = this.arm.load(core.scene).then(() => core.world.warmUp()).catch((e) => { console.error('arm', e); });
  }

  setHelp(h: 'uit' | 'licht' | 'veel') { this.helpLevel = h; }

  async start(index: number, practice = false) {
    await this.armLoaded;
    this.stop();
    this.roundIndex = index; this.practice = practice;
    const r = this.round = ROUNDS[index];
    await this.core.world.prepareState(r.light);      // lightmaps + start-room probes of this light state are in
    this.t = 0; this.caught = 0; this.lastProgress = 0; this.endTimer = -1; this.swing.swings = 0;
    this.core.world.setState(r.light);
    this.core.placePlayer(r.player.x, r.player.z, r.player.yaw);
    // the round's door angles; two leaves set against or through each other are settled (the wc and kids-room-1 doors
    // share a corner: both set wide open, rounds 9 and 10 locked both)
    const doors = this.core.world.doors, start = practice ? PRACTICE.doors : r.doors;
    for (const d of doors) { d.angle = d.target = start?.[d.id] ?? 0; d.moving = false; }
    settleLeaves(doors);
    for (const d of doors) d.node.rotation.y = d.closedYaw + d.angle * d.openSign;
    this.smileys = [];
    // practice: one smiley at a time, somewhere in the chalet (respawn)
    const spawns: Spawn[] = practice ? [this.practiceSpawn()] : r.smileys;
    for (const s of spawns) this.spawn(s, r);
    this.incomingLeft = practice ? 0 : r.incoming?.count ?? 0; this.incomingTimer = 2;
    this.adaptNow(this.core.player.x, this.core.player.z);
    this.audio.startAmbience(r.light);
    this.ui.onObjective(practice ? 'Oefenen' : `Ronde ${index + 1} · ${r.place}`, practice ? 'Vrij oefenen in het hele chalet' : r.objective);
    this.ui.onToast(practice ? 'Oefenen: steeds één smiley, ergens in het chalet.' : r.intro, 2600);
    this.ui.onCaught(0, this.total()); this.ui.onHint('');
    this.active = true; this.paused = false;
    this.core.running = true; this.core.input.enabled = true;
    this.core.metrics.event('round-start', { round: r.id, practice, light: this.core.world.shownState });
  }

  private spawn(s: Spawn, r: RoundDef, from?: [number, number, number]) {
    const id = this.idCounter++;
    const bvh = this.core.world.bvh;
    const b = new SmileyBrain(bvh, { alert: r.alert, restMin: r.rest[0], restMax: r.rest[1], speed: r.speed,
      roomBias: r.limitRoom ? ROOM_BOXES[r.limitRoom] : null }, id, (ox, oy, oz, dx, dy, dz, max) => this.doorRay(ox, oy, oz, dx, dy, dz, max));
    const box = ROOM_BOXES[s.room] ?? ROOM_BOXES.woon;
    if (from) {
      // flutters in through the open terrace door, toward the room
      b.x = from[0]; b.y = from[1]; b.z = from[2]; b.setState('fly', 6 + Math.random() * 4);
      b.tx = 4.5; b.ty = 1.5; b.tz = -1.2; b.vz = -0.5;
    } else if (s.near && s.resting) {
      // snap to the nearest real surface around the requested point (rounds name the spot, the mesh decides)
      const [px, py, pz] = s.near;
      let best = Infinity, bx = 0, by = 0, bz = 0, bn: [number, number, number] = [0, 1, 0], bt = -1;
      for (const [dx, dy, dz] of [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]) {
        if (bvh.raycast(px, py, pz, dx, dy, dz, 0.45, hit, 1 | 2 | 4 | 8) && hit.t < best) {      // incl. window glass
          best = hit.t; bx = px + dx * hit.t; by = py + dy * hit.t; bz = pz + dz * hit.t; bn = [hit.nx, hit.ny, hit.nz]; bt = hit.tri;
        }
      }
      if (bt >= 0) b.placeResting(bx, by, bz, bn[0], bn[1], bn[2], bt, bvh.cls[bt]);
      else { b.x = px; b.y = py; b.z = pz; b.setState('fly', 5); b.tx = px; b.ty = py; b.tz = pz; }
    } else {
      b.x = (box[0] + box[2]) / 2 + (Math.random() - 0.5) * (box[2] - box[0]) * 0.5;
      b.z = (box[1] + box[3]) / 2 + (Math.random() - 0.5) * (box[3] - box[1]) * 0.5;
      b.y = 1.3 + Math.random() * 0.6;
      b.tx = b.x; b.ty = b.y; b.tz = b.z;
      b.setState('fly', 3 + Math.random() * 5);
      if (s.resting) b.beginLanding({ x: 99, y: 99, z: 99 });
    }
    const vis = new SmileyVisual(this.core.scene, id);
    this.smileys.push({ brain: b, vis, prev: { x: b.x, y: b.y, z: b.z }, deadAt: -1, caughtAt: -1 });
  }

  pause() {
    if (!this.active) return;
    this.paused = true; this.core.running = false; this.core.input.enabled = false; this.core.input.reset();
    this.audio.stopAllSmileys(); this.audio.suspend();
  }
  resume() { if (!this.active) return; this.paused = false; this.audio.resume(); this.core.running = true; this.core.input.enabled = true; }
  stop() {
    for (const m of this.smileys) { m.vis.dispose(); this.arm.bag?.setLoad(m.brain.id, null); }
    this.smileys = []; this.audio.stopAllSmileys(); this.audio.stopAmbience();
    this.swing.swing = null;
    this.active = false; this.paused = false; this.core.running = false; this.core.input.enabled = false;
  }

  /** Door leaves as vertical segments (height 0..2.2): distance along the ray or max. */
  private doorRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number {
    let best = max;
    for (const ob of this.core.world.doorObstacles()) {
      const ex = ob.bx - ob.ax, ez = ob.bz - ob.az;
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-9) continue;
      const wx = ob.ax - ox, wz = ob.az - oz;
      const t = (wx * ez - wz * ex) / den, s = (wx * dz - wz * dx) / den;
      if (t < 0 || t > best || s < 0 || s > 1) continue;
      const y = oy + dy * t;
      if (y < ob.y0 || y > ob.y1) continue;
      best = t;
    }
    return best;
  }

  /** Camera basis from the simulation's yaw/pitch (same as Core sets the camera; no roll). */
  private camFrame(): CamFrame {
    const c = this.core, cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    const f = { x: Math.cos(c.yaw) * cp, y: sp, z: -Math.sin(c.yaw) * cp };
    const r = { x: Math.sin(c.yaw), y: 0, z: Math.cos(c.yaw) };
    const up = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x };
    const p = c.camera.position;
    return { eye: { x: p.x, y: p.y, z: p.z }, f, r, up, tiptoe: this.tiptoe };
  }

  /** Aim direction through a screen point (CSS px) or the crosshair; limited to the arm's reachable cone. */
  private aimDir(cf: CamFrame, screen: { x: number; y: number } | null): V3 {
    if (!screen) return cf.f;
    const w = this.core.canvas.clientWidth || 1, h = this.core.canvas.clientHeight || 1;
    const tanH = Math.tan(this.core.camera.fov / 2), tanV = tanH * h / w;   // horizontal-fixed FOV
    const nx = (screen.x / w) * 2 - 1, ny = 1 - (screen.y / h) * 2;
    let d = { x: cf.f.x + cf.r.x * nx * tanH + cf.up.x * ny * tanV, y: cf.f.y + cf.r.y * nx * tanH + cf.up.y * ny * tanV, z: cf.f.z + cf.r.z * nx * tanH + cf.up.z * ny * tanV };
    let l = Math.hypot(d.x, d.y, d.z); d = { x: d.x / l, y: d.y / l, z: d.z / l };
    const cos = d.x * cf.f.x + d.y * cf.f.y + d.z * cf.f.z, lim = Math.cos(38 * Math.PI / 180);
    if (cos < lim) {
      const px = d.x - cf.f.x * cos, py = d.y - cf.f.y * cos, pz = d.z - cf.f.z * cos;
      l = Math.hypot(px, py, pz) || 1;
      const s = Math.sqrt(1 - lim * lim);
      d = { x: cf.f.x * lim + px / l * s, y: cf.f.y * lim + py / l * s, z: cf.f.z * lim + pz / l * s };
    }
    return d;
  }

  /** Exposure and white balance jump straight to the values for a position (round start) or for a camera frame (photo
   * views: metered like the game does it, so photo comparisons show what a player standing there would see). */
  adaptNow(x: number, z: number, cf?: CamFrame) {
    const view = cf ? this.meter(cf) : undefined;
    this.exposure = this.targetExposure(x, z, view?.L);
    this.core.world.setExposure(this.exposure);
    const wb = this.wbTarget(x, z, view);
    this.wbMired = 1e6 / wb.temperature; this.wbTint = wb.tint;
    this.applyWhiteBalance();
  }

  /** Camera-like white balance: the illuminant where you stand mixed with that of what you look at, partly adapted. */
  private wbTarget(x: number, z: number, view?: { mired: number; tint: number }) {
    const here = this.core.world.whiteBalanceAt(x, z);
    const vw = view ? ADAPTATION.view : 0;
    const mixed = { temperature: 1e6 / ((1e6 / here.temperature) * (1 - vw) + (view?.mired ?? 0) * vw), tint: here.tint * (1 - vw) + (view?.tint ?? 0) * vw };
    return adaptTemperatureTint(mixed, ADAPTATION.wb, ADAPTATION.wbTint);
  }

  /** Babylon's built-in camera white balance (Bradford adaptation before exposure/tone mapping); written without
   * notifying the materials every frame (imageprocessing.ts, G-03). */
  private applyWhiteBalance() {
    setImageProcessingQuiet(this.core.scene.imageProcessingConfiguration, this.exposure, 1e6 / this.wbMired, this.wbTint);
  }

  /** View metering: 15 rays over the view (centre-weighted, windows see-through) sample the baked luminance and
   * light colour of what you look at - an open door into a dim bedroom lets the eyes open up, as eyes and cameras do.
   * Seen from indoors, the bright garden behind a window is treated as a camera treats blown-out highlights (REVIEW-01
   * G-05): its luminance counts within OUTSIDE_CAP of the room's, and it hardly steers the white balance - with it at
   * full weight the cool daylight outside left the room's warm light uncorrected (walls b* +10) and the windows in R01
   * halved the exposure. */
  meter(cf: CamFrame): { L: number; mired: number; tint: number } {
    const w = this.core.world, bvh = w.bvh;
    const tanH = Math.tan(this.core.camera.fov / 2), tanV = tanH * (this.core.canvas.clientHeight || 1) / (this.core.canvas.clientWidth || 1);
    const inside = roomAt(cf.eye.x, cf.eye.z) !== 'buiten', Lhere = w.luminanceAt(cf.eye.x, cf.eye.z);
    let sw = 0, sl = 0, sm = 0, st = 0, swb = 0;
    for (let j = -1; j <= 1; j++) for (let i = -2; i <= 2; i++) {
      const nx = (i / 2) * 0.7, ny = j * 0.6;
      let dx = cf.f.x + cf.r.x * nx * tanH + cf.up.x * ny * tanV, dy = cf.f.y + cf.r.y * nx * tanH + cf.up.y * ny * tanV, dz = cf.f.z + cf.r.z * nx * tanH + cf.up.z * ny * tanV;
      const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
      const t = bvh.raycast(cf.eye.x, cf.eye.y, cf.eye.z, dx, dy, dz, 30, hit, 1 | 2 | 8) ? Math.max(0, hit.t - 0.05) : 30;
      const door = this.doorRay(cf.eye.x, cf.eye.y, cf.eye.z, dx, dy, dz, t);
      const tt = Math.min(t, Math.max(0, door - 0.05));
      const px = cf.eye.x + dx * tt, pz = cf.eye.z + dz * tt;
      const wgt = Math.exp(-(nx * nx + ny * ny) / 0.35);
      const out = inside && roomAt(px, pz) === 'buiten';
      const L = w.luminanceAt(px, pz);
      sl += wgt * Math.log(out ? Math.min(Math.max(L, Lhere / OUTSIDE_CAP), Lhere * OUTSIDE_CAP) : L); sw += wgt;
      const wb = w.whiteBalanceAt(px, pz), ww = wgt * (out ? 0.1 : 1);
      sm += ww * 1e6 / wb.temperature; st += ww * wb.tint; swb += ww;
    }
    return { L: Math.exp(sl / sw), mired: sm / swb, tint: st / swb };
  }

  targetExposure(x = this.core.player.x, z = this.core.player.z, Lview?: number): number {
    const Lpos = this.core.world.luminanceAt(x, z);
    // mostly what you look at (eyes and the photos' auto exposure meter the view): from the living room a look into the
    // master bedroom (9x darker bake) opened up too little and the room read far darker than R07 (D51)
    const L = Lview ? Math.pow(Lpos, 1 - ADAPTATION.view) * Math.pow(Lview, ADAPTATION.view) : Lpos;
    return exposureFor(L);
  }

  private targets(): SmileyTarget[] {
    const kind = this.core.world.bvh.kind;
    return this.smileys.map((m, i) => ({ idx: i, pos: { x: m.brain.x, y: m.brain.y, z: m.brain.z }, prev: m.prev, alive: m.brain.alive,
      resting: m.brain.state === 'rest', nrm: { x: m.brain.nx, y: m.brain.ny, z: m.brain.nz },
      soft: m.brain.state === 'rest' && m.brain.tri >= 0 && kind[m.brain.tri] === 3 }));
  }

  /** How far (m) the player's own posture lowers the body (Core.stance below standing). */
  private manualDrop() { return Math.max(0, -this.core.stance) * POSTURE.low; }

  private update(dt: number) {
    if (!this.active || this.paused) return;
    this.t += dt;
    const core = this.core, inp = core.input.state;
    const cf = this.camFrame();
    const hand = core.input.opts.leftHanded ? -1 : 1;
    // --- swing request (tap point or crosshair)
    if (inp.swatQueued) {
      inp.swatQueued = false;
      const d = this.aimDir(cf, inp.swatScreen); inp.swatScreen = null;
      // room to lean the upper body toward the target: what is in front of the chest; and to step back from a target
      // too close in front for the net's length: what is behind the chest and the head (door leaves included)
      const fx = Math.cos(core.yaw), fz = -Math.sin(core.yaw);
      const leanMax = core.world.bvh.raycast(cf.eye.x, cf.eye.y - 0.35, cf.eye.z, fx, 0, fz, 0.8, hit, 1 | 4 | 8) ? Math.min(0.32, Math.max(0, hit.t - 0.3)) : 0.32;
      let behind = 0.6;
      for (const y of [cf.eye.y - 0.35, cf.eye.y]) {
        if (core.world.bvh.raycast(cf.eye.x, y, cf.eye.z, -fx, 0, -fz, behind, hit, 1 | 4 | 8)) behind = hit.t;
        behind = this.doorRay(cf.eye.x, y, cf.eye.z, -fx, 0, -fz, behind);
      }
      const leanBack = Math.min(0.25, Math.max(0, behind - 0.3));
      if (this.swing.begin(cf, d, hand, this.t, this.targets(), leanMax, leanBack)) {
        core.metrics.event('swing', { t: Math.round(this.t * 100) / 100 }); this.whooshed = false;
        // the body moves first (D48): lean in and bend the knees as far as the planned arm needs
        const sw = this.swing.swing!;
        this.leanTarget = sw.lean;
        // low targets or targets under an overhang (upper cupboards, table edge): bend the knees further if the
        // straight line from the shoulder to the target is blocked
        const P = sw.target.h;
        let crouch = sw.crouch;
        const sh = { x: cf.eye.x + cf.r.x * 0.2 * hand, y: cf.eye.y - 0.25, z: cf.eye.z + cf.r.z * 0.2 * hand };
        const clear = (drop: number) => {
          const dx = P.x - sh.x, dy = P.y - (sh.y - drop), dz = P.z - sh.z, l = Math.hypot(dx, dy, dz);
          return !core.world.bvh.raycast(sh.x, sh.y - drop, sh.z, dx / l, dy / l, dz / l, Math.max(0, l - 0.15), hit, 1 | 4 | 8);
        };
        if (!clear(crouch)) for (const extra of [0.15, 0.3, 0.45]) if (clear(crouch + extra)) { crouch += extra; break; }
        // a negative crouch is a rise onto the toes, on top of what looking up already gives
        // (bent down already, the knees bend only as far as the lowest posture allows)
        this.crouchTarget = Math.min(0.6, Math.max(0, crouch), Math.max(0, PLAYER.eye - POSTURE.minEye - this.manualDrop()));
        this.toesTarget = Math.min(TIPTOE, this.tiptoe + Math.max(0, -crouch));
      }
    }
    // --- doors
    const door = core.doorInFront();
    this.ui.onDoorCtx(door ? (door.target > 0.05 ? 'Deur dicht' : 'Deur open') : null);
    if (inp.interactQueued) {
      inp.interactQueued = false;
      if (door) {
        core.toggleDoor(door);
        this.audio.door(door.target > 0.05, door.hinge.x, 1.0, door.hinge.z);
        core.metrics.event('door', { id: door.id, open: door.target > 0.05 });
      }
    }
    // --- smileys (threat = the net's hoop while a swing is under way)
    const host = { x: cf.eye.x, y: cf.eye.y, z: cf.eye.z };
    const th = this.threat, sp = this.swing.pose;
    th.active = !!this.swing.swing && !!sp; th.swing = this.swing.swings;
    if (sp) { th.x = sp.h.x; th.y = sp.h.y; th.z = sp.h.z; }
    th.vx = this.swing.velocity.x; th.vy = this.swing.velocity.y; th.vz = this.swing.velocity.z;
    const hostSpeed = Math.hypot(core.player.vx, core.player.vz);
    for (const m of this.smileys) {
      m.prev = { x: m.brain.x, y: m.brain.y, z: m.brain.z };
      const bounds = ROOM_BOXES[smileyRoom(m.brain)] ?? ROOM_BOXES.woon;
      m.brain.update(dt, host, th, bounds, hostSpeed);
      for (const ev of m.brain.events.splice(0)) {
        if (ev === 'landed') core.metrics.event('landed', { id: m.brain.id, cls: SURFACE_CLASSES[m.brain.surfaceClass] });
      }
      // on a curtain that moves the smiley goes along with the fabric; one that rests on it flies off once the fabric
      // really moves under it
      const b = m.brain;
      let off: { x: number; y: number; z: number } | undefined;
      if (b.state === 'rest' && b.tri >= 0 && core.world.bvh.kind[b.tri] === 3) {
        off = core.world.curtains.displacementAt(b, this.offTmp) ?? undefined;
        if (off && Math.hypot(off.x, off.y, off.z) > CURTAIN_STARTLE) b.takeoff();
      }
      // caught: it beats about in the bag (and pushes the netting), then goes into the jar
      let inNet: V3 | null = null;
      if (b.state === 'caught') {
        const bag = this.arm.bag;
        if (bag) {
          const k = b.struggling ? 18 : 0;
          bag.setLoad(b.id, { x: (Math.random() - 0.5) * k, y: (Math.random() - 0.2) * k, z: (Math.random() - 0.5) * k });
          inNet = bag.loadPos(b.id);
        }
        if (this.t - m.caughtAt > IN_NET) {
          b.setState('jarred'); bag?.setLoad(b.id, null); m.deadAt = this.t;
          this.audio.jar();
          const left = this.smileys.filter((o) => o.brain.alive).length + this.incomingLeft;
          this.ui.onToast(this.practice ? 'In de pot.' : left ? `In de pot. Nog ${left}.` : 'In de pot. Dat was de laatste.', 1600);
        }
      }
      m.vis.sync(b, this.t, cf.eye, off, inNet);
    }
    // --- swing physics & contacts (same time step as the smiley motion)
    // lean follows the swing: in (or back) during wind-up/strike, hold briefly after contact, then straighten up
    const sw = this.swing.swing;
    const inSwing = !!sw && (sw.phase === 'windup' || sw.phase === 'strike' || sw.t < sw.tContact + 0.12);
    const leanGoal = inSwing ? this.leanTarget : 0;
    this.lean += (leanGoal - this.lean) * (1 - Math.exp(-dt / (Math.abs(leanGoal) > Math.abs(this.lean) ? 0.06 : 0.22)));
    // knees: during low swings, and when looking steeply down (to look under a bed or table)
    // (only really steep: aiming at a door handle or a low smiley from close by must not move the view)
    const lookCrouch = Math.max(0, Math.min(1, (-core.pitch - 1.0) / 0.3)) * 0.35;
    const crouchGoal = Math.max(inSwing ? this.crouchTarget : 0, lookCrouch);
    this.crouch += (crouchGoal - this.crouch) * (1 - Math.exp(-dt / (crouchGoal > this.crouch ? 0.09 : 0.25)));
    // toes: looking up (a smiley on the ceiling) raises the view as standing on tiptoe does (standing, not bent down);
    // the player's own posture can put you on the toes too; a high swing may rise the rest of the way
    const low = this.manualDrop(), standing = Math.max(0, 1 - low / 0.1);
    const toesGoal = Math.max(lookTiptoe(core.pitch) * standing, Math.max(0, core.stance) * TIPTOE, inSwing ? this.toesTarget : 0);
    this.tiptoe += (toesGoal - this.tiptoe) * (1 - Math.exp(-dt / (toesGoal > this.tiptoe ? 0.12 : 0.25)));
    // (leaning in lowers the eye; a step back does not); the player's posture lowers it as far as it is set, the eye never
    // below POSTURE.minEye above the feet
    core.lean.f = this.lean;
    core.lean.d = Math.min(Math.max(0, this.lean) * 0.35 + low + this.crouch, PLAYER.eye - POSTURE.minEye) - this.tiptoe;
    const rest = this.swing.restFor(cf, hand, this.t);
    const contact = this.swing.update(dt, rest, this.targets(), cf, hand);
    const s = this.swing.swing;
    if (s && !this.whooshed && s.phase === 'strike') {
      const p = this.swing.pose.h, v = this.swing.velocity;
      this.audio.whoosh(Math.hypot(v.x, v.y, v.z) * 1.15, p.x, p.y, p.z); this.whooshed = true;
    }
    if (contact) this.onContact(contact);
    this.arm.sync(this.swing.pose ?? rest, cf, hand, cf.eye.y - core.player.y, dt);
    // --- smileys fluttering in through the open terrace door (round 4)
    const inc = this.round.incoming;
    if (inc && this.incomingLeft > 0) {
      const doorOpen = (core.world.doors.find((d) => d.id === inc.untilDoorClosed)?.angle ?? 0) > 0.25;
      this.incomingTimer -= dt;
      if (!doorOpen) { this.incomingLeft = 0; this.ui.onToast('Deur dicht. Er komen er geen meer bij.'); core.metrics.event('incoming-stopped'); }
      else if (this.incomingTimer <= 0) { this.spawn({ room: 'woon' }, this.round, inc.from); this.incomingLeft--; this.incomingTimer = inc.every; core.metrics.event('incoming'); }
    }
    // --- a smiley that flew out through the terrace door is out of play once the door is shut (REVIEW-01 G-13: round 4
    // could otherwise only end by chasing it around the garden)
    const terras = core.world.doors.find((d) => d.id === 'terras');
    if (terras && terras.angle < 0.05) {
      for (const m of this.smileys) {
        if (!m.brain.alive || !clearlyOutside(m.brain.x, m.brain.z)) continue;   // not one at the inside of a pane
        m.brain.setState('gone'); this.audio.stopSmiley(m.brain.id); m.vis.root.setEnabled(false); m.deadAt = this.t;
        this.ui.onToast('Eén vloog naar buiten. Die telt niet meer mee.', 2200);
        core.metrics.event('gone-outside', { id: m.brain.id });
      }
    }
    // --- audio: listener + the wings' soft flutter, with occlusion (a caught one beats against the netting)
    this.audio.listener(cf.eye.x, cf.eye.y, cf.eye.z, cf.f.x, cf.f.y, cf.f.z);
    for (const m of this.smileys) {
      const b = m.brain;
      const on = (b.audible && !b.gliding) || b.struggling;
      if (!on) { this.audio.smiley(b.id, false, b.x, b.y, b.z, b.freq, 0, 0); continue; }
      const occ = b.state === 'caught' ? 0 : this.occlusion(cf.eye, b);
      this.audio.smiley(b.id, true, b.x, b.y, b.z, b.freq * (1 + 0.18 * b.effort), b.state === 'caught' ? 0.6 : b.effort, occ);
    }
    this.audio.setRoomAcoustics(core.room);
    this.audio.setInside(core.room === 'buiten' ? 0 : 1, core.room === 'woon' ? 0 : 0.7);
    // --- reflections follow the player; eye adaptation
    const probe = core.world.probeFor(cf.eye.x, cf.eye.z);
    this.arm.setReflection(probe);
    if (this.smileys.length) this.smileys[0].vis.setReflection(probe);    // materials are shared
    const dg = core.world.diffuseGainAt(cf.eye.x, cf.eye.z);
    this.arm.setDiffuseGain(dg);
    if (this.smileys.length) this.smileys[0].vis.setDiffuseGain(dg);
    const view = this.meter(cf);
    const target = this.targetExposure(core.player.x, core.player.z, view.L);
    const ka = 1 - Math.exp(-dt / ADAPTATION.tau);
    this.exposure = Math.exp(Math.log(this.exposure) + (Math.log(target) - Math.log(this.exposure)) * ka);
    core.world.setExposure(this.exposure);
    const wb = this.wbTarget(cf.eye.x, cf.eye.z, view);
    this.wbMired += (1e6 / wb.temperature - this.wbMired) * ka; this.wbTint += (wb.tint - this.wbTint) * ka;
    this.applyWhiteBalance();
    // --- footsteps
    const spd = Math.hypot(core.player.vx, core.player.vz);
    this.stepPhase += spd * dt / 0.62;
    if (this.stepPhase > 1) {
      this.stepPhase -= 1;
      const surf = core.room !== 'buiten' ? 'vinyl' : core.player.y > -0.2 ? 'deck' : 'grass';
      this.audio.footstep(surf, core.player.x, core.player.y + 0.05, core.player.z);
    }
    this.hints();
    // --- practice: a caught smiley (or one gone outside) is followed by the next one; round end once all are in the jar
    if (this.practice) {
      for (const m of [...this.smileys]) if ((m.brain.state === 'jarred' || m.brain.state === 'gone') && m.deadAt >= 0 && this.t - m.deadAt > 3) this.respawn(m);
      return;
    }
    const alive = this.smileys.filter((m) => m.brain.state !== 'jarred' && m.brain.state !== 'gone').length + this.incomingLeft;
    if (alive === 0 && this.endTimer < 0) this.endTimer = this.round.silenceEnd ? 3.5 : 1.4;
    if (this.endTimer >= 0) { this.endTimer -= dt; if (this.endTimer < 0) this.finish(); }
  }

  private respawn(m: Smiley) {
    const i = this.smileys.indexOf(m); m.vis.dispose(); this.smileys.splice(i, 1);
    this.audio.stopSmiley(m.brain.id);
    this.spawn(this.practiceSpawn(), this.round);
  }

  /** Practice: the next smiley in a random room of the chalet, not the one the last one came from; flying or already
   * settling on a surface there. */
  private practiceSpawn(): Spawn {
    const rooms = PRACTICE.rooms.filter((q) => q !== this.lastPracticeRoom);
    const room = rooms[Math.floor(Math.random() * rooms.length)];
    this.lastPracticeRoom = room;
    return { room, resting: Math.random() < 0.5 };
  }

  /** how many smileys the round has in all (the ones still to come in included) */
  private total() { return this.practice ? 0 : this.round.smileys.length + (this.round.incoming?.count ?? 0); }

  /** Walls and door leaves between listener and smiley: 0 clear .. 1 behind two or more obstacles. */
  private occlusion(eye: V3, b: SmileyBrain): number {
    const dx = b.x - eye.x, dy = b.y - eye.y, dz = b.z - eye.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.05) return 0;
    let occ = 0, ox = eye.x, oy = eye.y, oz = eye.z, rem = d;
    const ux = dx / d, uy = dy / d, uz = dz / d;
    for (let k = 0; k < 3 && rem > 0.02; k++) {
      const dd = this.doorRay(ox, oy, oz, ux, uy, uz, rem);
      const tw = this.core.world.bvh.raycast(ox, oy, oz, ux, uy, uz, rem, hit, 1 | 4) ? hit.t : Infinity;
      const tt = Math.min(tw, dd);
      if (!isFinite(tt) || tt >= rem) break;
      occ += 0.5; ox += ux * (tt + 0.05); oy += uy * (tt + 0.05); oz += uz * (tt + 0.05); rem -= tt + 0.05;
    }
    return Math.min(1, occ);
  }

  private onContact(c: ContactInfo) {
    const surf: Surface = c.cls >= 0 ? SURFACE_CLASSES[c.cls] ?? 'panel' : '';
    const m = c.smiley >= 0 ? this.smileys[c.smiley] : null;
    let caught = false;
    if (m && m.brain.alive) {
      // on soft, yielding surfaces (curtain, bedding, cushions, leaves) the rim does not close on the fabric: it may
      // creep out under the rim
      const rest = SURFACE_CLASSES[m.brain.surfaceClass] ?? '';
      if (m.brain.state === 'rest' && SOFT.includes(rest) && Math.random() < 0.3) {
        m.brain.escape({ x: c.point.x, y: c.point.y, z: c.point.z, vx: this.swing.velocity.x, vy: this.swing.velocity.y, vz: this.swing.velocity.z, active: true });
        this.ui.onToast('De stof geeft mee — hij kruipt onder de rand door.');
      } else {
        m.brain.catch();
        caught = true; m.caughtAt = this.t; this.caught++; this.lastProgress = this.t;
        this.ui.onCaught(this.caught, this.total());
      }
    }
    // the rim's band touching a surface: a soft tap (no slap); a catch: the netting rustles
    if (!c.air) this.audio.netTap(surf || (m ? SURFACE_CLASSES[m.brain.surfaceClass] ?? 'panel' : 'panel'), c.speed, c.point.x, c.point.y, c.point.z);
    if (caught) this.audio.netCatch(c.point.x, c.point.y, c.point.z);
    // a curtain gives way a little where the hoop presses it
    if (!c.air && (c.kind === 3 || c.smiley >= 0)) this.core.world.curtains.hit(c.point, { x: -c.normal.x * c.speed * 0.35, y: -c.normal.y * c.speed * 0.35, z: -c.normal.z * c.speed * 0.35 });
    // the knock and the moving net may disturb other resting smileys nearby
    for (const o of this.smileys) {
      if (o === m || o.brain.state !== 'rest') continue;
      const dd = Math.hypot(o.brain.x - c.point.x, o.brain.y - c.point.y, o.brain.z - c.point.z);
      if (dd < 0.7 && Math.random() < (0.7 - dd) * 1.3 * this.round.alert) o.brain.takeoff();
    }
    if (caught) this.ui.onToast('Iedereen blij op de Vechtvallei', 1800);   // gebruikerswens (25-10-2026): tekst bij elke vangst
    this.core.metrics.event('contact', { air: c.air, cls: surf, door: c.door, caught, speed: Math.round(c.speed * 10) / 10 });
  }

  private hints() {
    // (practice too: the smiley can be in any room of the chalet)
    if (this.helpLevel === 'uit') { this.ui.onHint(''); return; }
    const idle = this.t - this.lastProgress;
    if (idle < (this.helpLevel === 'veel' ? 25 : 45)) { this.ui.onHint(''); return; }
    const alive = this.smileys.filter((m) => m.brain.alive);
    if (!alive.length) { this.ui.onHint(''); return; }
    const b = alive[0].brain;
    const room = smileyRoom(b);
    // never reveals a position through walls: only the room, as one would guess it
    this.ui.onHint(room === this.core.room ? (b.audible ? 'Hij fladdert hier in de kamer. Kijk omhoog.' : 'Hij zit ergens stil in deze kamer. Kijk ook bij de ramen.') : `Er fladdert er een in ${ROOM_NAMES[room] ?? 'een andere kamer'}.`);
  }

  private finish() {
    const r = this.round;
    this.active = false; this.core.running = false; this.core.input.enabled = false;
    this.audio.stopAllSmileys();
    const time = Math.round(this.t);
    this.save.complete(r.id, time, this.swing.swings, 0);
    this.save.data.progress.lastRound = Math.min(9, this.roundIndex + 1); this.save.write();
    const mm = Math.floor(time / 60), ss = String(time % 60).padStart(2, '0');
    const next = this.roundIndex < ROUNDS.length - 1 ? this.roundIndex + 1 : null;
    this.ui.onRoundEnd({
      eyebrow: next === null ? 'ALLE SMILEYS IN DE POT' : 'RONDE KLAAR',
      title: next === null ? 'Een pot vol smileys.' : r.silenceEnd ? 'Gevangen.' : 'Allemaal binnen.',
      text: `${r.title}: ${mm}:${ss} · ${this.caught} gevangen · ${this.swing.swings} ${this.swing.swings === 1 ? 'zwaai' : 'zwaaien'} met het net.`,
      next,
    });
    this.core.metrics.event('round-end', { round: r.id, time, swings: this.swing.swings, caught: this.caught });
  }

  diag() {
    const lc = this.swing.lastContact;
    return {
      round: this.round.id, active: this.active, practice: this.practice, t: Math.round(this.t * 10) / 10, caught: this.caught, swings: this.swing.swings,
      light: { requested: this.core.world.state, shown: this.core.world.shownState }, exposure: Math.round(this.exposure * 100) / 100,
      whiteBalance: { kelvin: Math.round(1e6 / this.wbMired), tint: Math.round(this.wbTint * 10) / 10 },
      smileys: this.smileys.map((m) => ({ id: m.brain.id, state: m.brain.state, pos: [m.brain.x, m.brain.y, m.brain.z].map((v) => Math.round(v * 1000) / 1000), room: smileyRoom(m.brain) })),
      lastContact: lc ? { air: lc.air, cls: lc.cls >= 0 ? SURFACE_CLASSES[lc.cls] : null, smiley: lc.smiley, door: lc.door, point: [lc.point.x, lc.point.y, lc.point.z].map((v) => Math.round(v * 1000) / 1000) } : null,
    };
  }
}
