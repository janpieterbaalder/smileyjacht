// Smiley behaviour: butterfly flight physics, wandering (drawn to windows), obstacle avoidance, landing on real
// surfaces, resting with slow wing fanning, escape reactions and being caught in the net. Pure logic (no rendering);
// Babylon frame x east, y up, z south.
//
// A smiley is a flat round yellow disc (60 mm) with a face, folded down the middle: its two halves are its wings
// (spread flat it is a whole smiley, closed over its back a half disc). It flies the way a butterfly does - the values
// are tuning values in the range of a cabbage white or a small tortoiseshell (wingbeat 6.5-9 Hz, cruise 0.6-1.1 m/s,
// wings large for the body), not a measured model:
// - the wings make the force: each downstroke gives a pulse of ~3 g along the stroke's force direction, the upstroke
//   little. The body therefore bobs and pitches with every beat instead of sliding along a smooth path;
// - the force is aimed (the body tilts) toward the acceleration it wants; it cannot exceed ~2 g on average;
// - flapping comes in bouts of a few beats with short glides in between (wings held out, slowly sinking and slowing);
// - the path is erratic: a random (Ornstein-Uhlenbeck) wish on top of the course, and now and then a sharp jink;
// - drag is strong for its weight: it sinks at ~1.3 m/s with the wings still, and stops quickly.
import type { TriBVH, RayHit } from '../physics/bvh';

export type SState = 'rest' | 'takeoff' | 'fly' | 'land' | 'evade' | 'caught' | 'jarred' | 'gone';

/** net hoop (world) with velocity; swing = number of the swing it belongs to (one escape decision per swing) */
export interface Threat { x: number; y: number; z: number; vx: number; vy: number; vz: number; active: boolean; swing?: number; }
export interface Host { x: number; y: number; z: number; }   // player's head
export interface SmileyParams { alert: number; restMin: number; restMax: number; speed: number; roomBias?: [number, number, number, number] | null; }

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const hit: RayHit = { t: 0, tri: 0, nx: 0, ny: 0, nz: 0 };
const G = 9.81;

/** Flight physics (SI units, accelerations in m/s^2). */
export const FLIGHT = {
  /** wingbeat frequency range (Hz); effort raises it up to +18 % */
  freq: [6.5, 9] as [number, number],
  /** quadratic drag (1/m): horizontal, and vertical (the spread wings act as a parachute) */
  dragH: 1.5, dragV: 5.5,
  /** glide lift (1/m) on the horizontal speed while the wings are held out; capped at 0.9 g */
  glideLift: 4.0,
  /** average aerodynamic force the wings can give (m/s^2): cruising, fleeing or taking off */
  maxForce: 2.0 * G, maxForceEvade: 3.2 * G,
  /** wing angle (rad, + = up over the back): mean and amplitude in flapping; held during a glide */
  wingMean: 0.48, wingAmp: 1.0, wingGlide: 0.18,
};

/** Share of the force produced over the stroke: sin^2 on the downstroke (phase 0..pi, wings from up to down), a fifth of
 * it on the upstroke. Normalised to an average of 1 over a beat. */
export function strokeForce(phase: number): number {
  const p = ((phase % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const s = Math.sin(p) ** 2;
  return (p < Math.PI ? s : 0.2 * s) / 0.3;
}

/** Chance per swing that a resting smiley sees the net coming and flies off, times the round's alertness: butterflies
 * see well (game tuning, to confirm in play). */
export const ESCAPE_PER_SWING = 0.35;
/** Landing: the approach flies to `approach` m off the chosen surface (the disc is 60 mm across), slowing down over
 * the last 25 cm; within `reached` m of that point it settles flat onto the surface over `touchdown` s. A landing
 * that does not get there in time is given up and it flies on. */
export const LANDING = { approach: 0.04, reached: 0.04, touchdown: 0.35, speed: 0.35 };
/** Seconds it needs to turn from its flight pose into its resting pose, and back when it takes off. */
export const TAKEOFF = 0.22;
/** gap the brain keeps between a resting smiley's centre and its surface (half the disc's thickness and a little) */
export const REST_GAP = 0.003;
/** how far (m) from its centre the surface must be flat and clear for it to land: the disc's radius and a little */
export const FOOTPRINT = 0.04;
/** wing angle at rest: spread flat on the surface (a whole disc), or closed upright over the back (a half disc; the
 * halves' own thickness keeps them just short of pi/2) */
export const WING_OPEN = 0.02, WING_CLOSED = 1.53;

/** Tangent basis of a surface with normal n (the resting smiley's heading is an angle in it; visual.ts draws with it). */
export function surfaceBasis(nx: number, ny: number, nz: number): { t1: [number, number, number]; t2: [number, number, number] } {
  // t1 = n x ref, t2 = t1 x n (ref = up, or x on floors and ceilings)
  const [rx, ry, rz] = Math.abs(ny) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ax = ny * rz - nz * ry, ay = nz * rx - nx * rz, az = nx * ry - ny * rx;
  const al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
  return { t1: [ax, ay, az], t2: [ay * nz - az * ny, az * nx - ax * nz, ax * ny - ay * nx] };
}

export class SmileyBrain {
  // kinematics
  x = 0; y = 1.5; z = 0; vx = 0; vy = 0; vz = 0;
  // surface contact when resting
  nx = 0; ny = 0; nz = 1; tri = -1; surfaceClass = 0; headAngle = 0;
  state: SState = 'fly';
  timer = 0; stateTime = 0;
  // wander target
  tx = 0; ty = 1.4; tz = 0;
  /** random wish on top of the course (OU process, m/s^2) and a sharp jink (m/s, decays) */
  jx = 0; jy = 0; jz = 0; private kx = 0; private ky = 0; private kz = 0;
  /** wingbeat: phase (0 = wings up), frequency (Hz), the wing angle drawn now (rad, + = up), effort 0..1 */
  wingPhase = 0; freq: number; wingAngle = FLIGHT.wingMean; effort = 0.3;
  /** gliding (wings held out, no beat) and the beats left in the current flapping bout */
  gliding = false; private glideLeft = 0; private beatsLeft = 4;
  /** direction of the wings' force (unit, smoothed): the body is tilted to it (visual.ts) */
  ax = 0; ay = 1; az = 0;
  /** last acceleration applied (m/s^2, diagnostics/tests) */
  acc = { x: 0, y: 0, z: 0 };
  /** how far the body has turned from its flight pose into its resting pose on the surface (0 flying .. 1 resting) */
  settle = 0;
  /** resting: wings closed upright over the back (true) or spread flat (false); a slow fan now and then */
  closedRest = false; private fanT = -1; private fanNext = 2;
  /** caught: beating in bursts (> 0: s of beating left, < 0: s of pause left) */
  private burst = 0.4;
  /** the swing whose approach has been judged (escape or not); -1 = none */
  private judgedSwing = -1;
  /** landing: the chosen surface point and, once the approach point is reached, the touchdown (time and start point) */
  private sx = 0; private sy = 0; private sz = 0;
  private td = -1; private fx = 0; private fy = 0; private fz = 0;
  id: number;
  events: string[] = [];
  constructor(public bvh: TriBVH, public p: SmileyParams, id: number, public obstacleRay: (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number) => number) {
    this.id = id;
    this.freq = rnd(FLIGHT.freq[0], FLIGHT.freq[1]);
    this.wingPhase = Math.random() * Math.PI * 2;
  }

  /** in the air under its own power (flutters, can be heard faintly) */
  get audible() { return this.state === 'fly' || this.state === 'takeoff' || this.state === 'land' || this.state === 'evade'; }
  get alive() { return this.state !== 'caught' && this.state !== 'jarred' && this.state !== 'gone'; }

  /** Put the smiley at rest on a surface point (x, y, z) with normal n. heading: its angle in the surface's tangent
   * basis (surfaceBasis); on a wall mostly head up when not given (start positions). */
  placeResting(x: number, y: number, z: number, nx: number, ny: number, nz: number, tri: number, cls: number, heading?: number) {
    this.x = x + nx * REST_GAP; this.y = y + ny * REST_GAP; this.z = z + nz * REST_GAP;
    this.nx = nx; this.ny = ny; this.nz = nz; this.tri = tri; this.surfaceClass = cls;
    this.vx = this.vy = this.vz = 0;
    this.setState('rest', rnd(this.p.restMin, this.p.restMax));
    this.headAngle = heading ?? (Math.abs(ny) < 0.7 ? Math.PI / 2 + rnd(-0.5, 0.5) : rnd(0, Math.PI * 2));
    this.settle = 1; this.td = -1;
    this.closedRest = Math.random() < 0.3; this.fanT = -1; this.fanNext = rnd(1.5, 5);
    this.wingAngle = this.closedRest ? WING_CLOSED : WING_OPEN;
  }

  setState(s: SState, timer = 0) { this.state = s; this.timer = timer; this.stateTime = 0; this.events.push(s); }

  private pickWanderTarget(host: Host, bounds: [number, number, number, number]) {
    const [x0, z0, x1, z1] = this.p.roomBias ?? bounds;
    // butterflies indoors are drawn to the light: now and then a window pane within a few metres
    if (Math.random() < 0.3) {
      for (let i = 0; i < 6; i++) {
        const a = rnd(0, Math.PI * 2), dx = Math.cos(a), dz = Math.sin(a), dy = rnd(-0.15, 0.25);
        if (this.bvh.raycast(this.x, this.y, this.z, dx, dy, dz, 3.5, hit, 1 | 4) && this.bvh.kind[hit.tri] === 2 && this.obstacleRay(this.x, this.y, this.z, dx, dy, dz, hit.t) >= hit.t) {
          const t = Math.max(0, hit.t - 0.2);
          this.tx = this.x + dx * t; this.ty = Math.max(0.6, Math.min(2.1, this.y + dy * t)); this.tz = this.z + dz * t;
          return;
        }
      }
    }
    // keeps a little away from the person (it is not after you, unlike a mosquito)
    for (let i = 0; i < 4; i++) {
      this.tx = rnd(x0 + 0.3, x1 - 0.3); this.ty = rnd(0.8, 2.05); this.tz = rnd(z0 + 0.3, z1 - 0.3);
      if (Math.hypot(this.tx - host.x, this.tz - host.z) > 0.6) break;
    }
  }

  /** threat = net hoop (world) with velocity; hostSpeed = player's walking speed. */
  update(dt: number, host: Host, threat: Threat, bounds: [number, number, number, number], hostSpeed: number) {
    this.stateTime += dt; this.timer -= dt;
    if (this.state !== 'rest' && this.state !== 'land' && this.settle > 0) this.settle = Math.max(0, this.settle - dt / TAKEOFF);
    switch (this.state) {
      case 'rest': this.rest(dt, host, threat, hostSpeed); break;
      case 'takeoff': case 'fly': case 'evade': case 'land': {
        // the stroke is resolved finely (a 9 Hz beat at 60 fps is ~7 frames)
        const n = Math.max(1, Math.ceil(dt / (1 / 240) - 1e-9));
        for (let i = 0; i < n && this.audible; i++) this.fly(dt / n, host, threat, bounds);
        break;
      }
      case 'caught': this.struggle(dt); break;
      default: break;
    }
  }

  private rest(dt: number, host: Host, threat: Threat, hostSpeed: number) {
    // the net coming at it: ONE decision per swing (looming - a butterfly sees a net from further away than a mosquito
    // feels a swatter's air)
    const dx = threat.x - this.x, dy = threat.y - this.y, dz = threat.z - this.z;
    const d = Math.hypot(dx, dy, dz);
    const sw = threat.swing ?? 0;
    if (!threat.active || d > 0.8) { if (threat.swing === undefined) this.judgedSwing = -1; }
    else if (this.judgedSwing !== sw) {
      const closing = -(dx * threat.vx + dy * threat.vy + dz * threat.vz) / (d || 1);
      if (d < 0.6 && closing > 0.4) {
        this.judgedSwing = sw;
        // time-to-contact against its reaction time: a fast, close sweep beats it
        const ttc = d / closing, reaction = 0.07 / this.p.alert;
        if (ttc > reaction && Math.random() < ESCAPE_PER_SWING * this.p.alert) { this.escape(threat); return; }
      }
    }
    // a person walking right up to it disturbs it
    const dh = Math.hypot(host.x - this.x, host.y - this.y, host.z - this.z);
    if (dh < 0.5 && hostSpeed > 0.5 && Math.random() < dt * 1.2 * this.p.alert) { this.takeoff(); return; }
    // wings: basking spread flat or held closed; now and then slowly opened and closed (fanning)
    this.fanNext -= dt;
    if (this.fanT < 0 && this.fanNext <= 0) { this.fanT = 0; this.fanNext = rnd(2, 6); }
    const base = this.closedRest ? WING_CLOSED : WING_OPEN;
    if (this.fanT >= 0) {
      this.fanT += dt;
      const k = this.fanT / 0.9;                        // one slow fan in 0.9 s
      if (k >= 1) this.fanT = -1;
      const s = Math.sin(Math.PI * Math.min(1, k));
      this.wingAngle = this.closedRest ? base - 1.0 * s : base + 1.05 * s * s;
    } else this.wingAngle = base;
    if (this.timer <= 0) this.takeoff();
  }

  takeoff() {
    this.setState('takeoff', 0.3);
    // pushes off and beats hard, away from the surface and up
    const s = 0.6;
    this.vx = this.nx * s + rnd(-0.1, 0.1); this.vy = this.ny * s + rnd(0.1, 0.3); this.vz = this.nz * s + rnd(-0.1, 0.1);
    this.wingPhase = 0; this.gliding = false; this.beatsLeft = 6; this.effort = 1;
    this.ax = this.nx; this.ay = Math.max(0.3, this.ny); this.az = this.nz;
  }

  escape(threat: Threat) {
    // darts off sideways to the sweep, away from the surface, mostly up (erratic: either side)
    const resting = this.state === 'rest';
    let ex = resting ? this.nx : 0, ey = resting ? this.ny : 0, ez = resting ? this.nz : 0;
    const tl = Math.hypot(threat.vx, threat.vy, threat.vz) || 1;
    const px = -threat.vz / tl, pz = threat.vx / tl;
    const side = Math.random() < 0.5 ? -1 : 1;
    ex += px * side * 1.3; ez += pz * side * 1.3; ey += rnd(0.2, 0.9);
    const l = Math.hypot(ex, ey, ez) || 1;
    const sp = rnd(1.0, 1.6);
    this.vx = ex / l * sp; this.vy = ey / l * sp; this.vz = ez / l * sp;
    this.kx = this.vx; this.ky = this.vy; this.kz = this.vz;
    this.gliding = false; this.beatsLeft = 10; this.effort = 1;
    if (resting) { this.wingPhase = 0; this.ax = this.nx; this.ay = Math.max(0.3, this.ny); this.az = this.nz; }
    this.setState('evade', rnd(0.45, 0.8));
  }

  private fly(dt: number, host: Host, threat: Threat, bounds: [number, number, number, number]) {
    if (this.state === 'land') {
      if (threat.active && this.near(threat, 0.35) && Math.random() < dt * 20 * this.p.alert) { this.escape(threat); return; }
      if (this.td >= 0) { this.touchdown(dt); return; }
      // not there in time (bounced off something, a door leaf in the way): the landing is given up, it flies on
      if (this.timer <= 0) { this.setState('fly', rnd(1, 3)); this.pickWanderTarget(host, bounds); }
    }
    const st = this.state;
    if (st === 'takeoff' && this.timer <= 0) { this.setState('fly', rnd(5, 12)); this.pickWanderTarget(host, bounds); }
    if (st === 'evade' && this.timer <= 0) { this.setState('fly', rnd(3, 8)); this.pickWanderTarget(host, bounds); }
    if (this.state === 'fly') {
      // the net close by and coming: a sharp evasive jink (one decision per swing)
      if (threat.active && this.near(threat, 0.4)) {
        const sw = threat.swing ?? 0;
        if (this.judgedSwing !== sw) { this.judgedSwing = sw; if (Math.random() < 0.55 * this.p.alert) { this.escape(threat); return; } }
      }
      const dtt = Math.hypot(this.tx - this.x, this.ty - this.y, this.tz - this.z);
      if (dtt < 0.2 || Math.random() < dt * 0.3) this.pickWanderTarget(host, bounds);
      if (this.timer <= 0) this.beginLanding(host);
    }
    const cur = this.state;
    // --- the course it wants: toward the target at cruise, with an erratic wish and an occasional jink
    const cruise = cur === 'evade' ? 1.7 : cur === 'land' ? this.landSpeed : this.p.speed;
    let gx = this.tx - this.x, gy = this.ty - this.y, gz = this.tz - this.z;
    const gl = Math.hypot(gx, gy, gz) || 1;
    gx /= gl; gy /= gl; gz /= gl;
    const arrive = cur === 'land' ? Math.min(1, 0.2 + gl / 0.25) : 1;
    const sq = Math.sqrt(dt), sig = cur === 'land' ? 1.2 : 5.0;
    this.jx += -2.5 * this.jx * dt + sig * sq * gauss(); this.jy += -2.5 * this.jy * dt + sig * 0.8 * sq * gauss(); this.jz += -2.5 * this.jz * dt + sig * sq * gauss();
    if (cur === 'fly' && Math.random() < dt * 0.9) {
      // jink: a sudden turn to one side (and up or down)
      const hl = Math.hypot(this.vx, this.vz) || 1, side = Math.random() < 0.5 ? -1 : 1, s = rnd(0.35, 0.7);
      this.kx = -this.vz / hl * side * s; this.kz = this.vx / hl * side * s; this.ky = rnd(-0.4, 0.5);
    }
    if (cur !== 'evade') { const kd = Math.exp(-dt / 0.18); this.kx *= kd; this.ky *= kd; this.kz *= kd; }
    let dax: number, day: number, daz: number;
    if (cur === 'evade') {
      // fleeing: straight for the escape direction, flat out
      dax = (this.kx - this.vx) * 6; day = (this.ky - this.vy) * 6; daz = (this.kz - this.vz) * 6;
    } else {
      const wx = gx * cruise * arrive + this.kx, wy = gy * cruise * arrive + this.ky, wz = gz * cruise * arrive + this.kz;
      dax = (wx - this.vx) * 3.0 + this.jx; day = (wy - this.vy) * 3.0 + this.jy * 0.8; daz = (wz - this.vz) * 3.0 + this.jz;
    }
    // obstacle avoidance: look ahead along the velocity against the world and the door leaves
    const vl = Math.hypot(this.vx, this.vy, this.vz);
    if (vl > 0.02 && cur !== 'land') {
      const look = Math.min(0.6, 0.15 + vl * 0.4);
      const dx = this.vx / vl, dy = this.vy / vl, dz = this.vz / vl;
      const d = this.castAll(this.x, this.y, this.z, dx, dy, dz, look);
      if (d < look) {
        const k = (1 - d / look) * 10;
        const vn = this.vx * hit.nx + this.vy * hit.ny + this.vz * hit.nz;
        dax += (hit.nx * (Math.abs(vn) + 0.4) - dx * 0.3) * k; day += hit.ny * (Math.abs(vn) + 0.4) * k; daz += (hit.nz * (Math.abs(vn) + 0.4) - dz * 0.3) * k;
      }
    }
    // keeps off the floor; it lets itself sink rather than dive (a wish down is met by beating less, below)
    if (this.y < 0.45 && cur !== 'land') day += (0.45 - this.y) * 10;
    if (day < -0.5 * G) day = -0.5 * G;
    // --- physics: gravity, drag, and what the wings give
    const vh = Math.hypot(this.vx, this.vz);
    const drx = -FLIGHT.dragH * vh * this.vx, drz = -FLIGHT.dragH * vh * this.vz, dry = -FLIGHT.dragV * Math.abs(this.vy) * this.vy;
    // the wing force the wish needs: what is left after gravity and drag
    let fx = dax - drx, fy = day + G - dry, fz = daz - drz;
    let fl = Math.hypot(fx, fy, fz);
    // the wings push mainly up and forward: a wish to go down is met by beating less (it sinks), not by force downward
    if (fy < 0.25 * fl) { fy = 0.25 * fl; fl = Math.hypot(fx, fy, fz); }
    const fmax = cur === 'evade' || cur === 'takeoff' ? FLIGHT.maxForceEvade : FLIGHT.maxForce;
    const mag = Math.min(fl, fmax);
    // force direction: the body tilts toward it over ~40 ms
    const kt = 1 - Math.exp(-dt / 0.04);
    this.ax += (fx / (fl || 1) - this.ax) * kt; this.ay += (fy / (fl || 1) - this.ay) * kt; this.az += (fz / (fl || 1) - this.az) * kt;
    const al = Math.hypot(this.ax, this.ay, this.az) || 1; this.ax /= al; this.ay /= al; this.az /= al;
    // effort (beat frequency and amplitude follow it)
    this.effort += (Math.min(1, mag / FLIGHT.maxForce) - this.effort) * (1 - Math.exp(-dt / 0.15));
    // flap-glide: after a bout of beats a short glide, when it is fast enough, not low, not landing or fleeing
    if (this.gliding) {
      this.glideLeft -= dt;
      if (this.glideLeft <= 0 || vh < 0.35 || this.y < 0.7 || cur !== 'fly') { this.gliding = false; this.wingPhase = 0; this.beatsLeft = 2 + Math.floor(Math.random() * 8); }
    }
    let awx = 0, awy = 0, awz = 0;
    if (!this.gliding) {
      const f = this.freq * (1 + 0.18 * this.effort);
      const before = this.wingPhase;
      this.wingPhase += 2 * Math.PI * f * dt;
      if (Math.floor(this.wingPhase / (2 * Math.PI)) > Math.floor(before / (2 * Math.PI))) {
        this.beatsLeft--;
        if (this.beatsLeft <= 0) {
          if (cur === 'fly' && vh > 0.5 && this.y > 0.8 && Math.random() < 0.7) { this.gliding = true; this.glideLeft = rnd(0.12, 0.45); }
          else this.beatsLeft = 2 + Math.floor(Math.random() * 8);
        }
      }
      if (!this.gliding) {
        const P = strokeForce(this.wingPhase);
        awx = this.ax * mag * P; awy = this.ay * mag * P; awz = this.az * mag * P;
        this.wingAngle = FLIGHT.wingMean + FLIGHT.wingAmp * (0.75 + 0.25 * this.effort) * Math.cos(this.wingPhase);
      }
    }
    if (this.gliding) {
      // wings held out: lift on the horizontal speed (it sinks slowly while it slows down)
      awy = Math.min(0.9 * G, FLIGHT.glideLift * vh * vh);
      this.wingAngle += (FLIGHT.wingGlide - this.wingAngle) * (1 - Math.exp(-dt / 0.025));
    }
    const ax = awx + drx, ay = awy - G + dry, az = awz + drz;
    this.acc.x = ax; this.acc.y = ay; this.acc.z = az;
    this.vx += ax * dt; this.vy += ay * dt; this.vz += az * dt;
    // top speed: fleeing or taking off 2.6 m/s, otherwise 1.8 m/s (fluttering about a room it is far slower)
    const sp = Math.hypot(this.vx, this.vy, this.vz), vmax = cur === 'evade' || cur === 'takeoff' ? 2.6 : 1.8;
    if (sp > vmax) { this.vx *= vmax / sp; this.vy *= vmax / sp; this.vz *= vmax / sp; }
    this.integrate(dt);
    // at the approach point: touch down from where it is (the resting pose turns in on the way)
    if (cur === 'land' && Math.hypot(this.tx - this.x, this.ty - this.y, this.tz - this.z) < LANDING.reached) {
      this.td = 0; this.fx = this.x; this.fy = this.y; this.fz = this.z;
      this.headAngle = this.landingHeading();
    }
  }

  /** the net within r m and coming closer */
  private near(t: Threat, r: number) {
    const dx = t.x - this.x, dy = t.y - this.y, dz = t.z - this.z, d = Math.hypot(dx, dy, dz);
    return d < r && -(dx * t.vx + dy * t.vy + dz * t.vz) / (d || 1) > 0.3;
  }

  /** Heading on the surface: on a wall mostly head up (a little askew), on a ceiling or a table any way. */
  private landingHeading(): number {
    if (Math.abs(this.ny) < 0.7) return Math.PI / 2 + rnd(-0.6, 0.6);       // t2 points up along a wall
    return rnd(0, Math.PI * 2);
  }

  /** The last few cm onto the surface, eased, over LANDING.touchdown s, beating ever slower; then it rests there. */
  private touchdown(dt: number) {
    this.td += dt;
    const k = Math.min(1, this.td / LANDING.touchdown), e = k * k * (3 - 2 * k);
    const rx = this.sx + this.nx * REST_GAP, ry = this.sy + this.ny * REST_GAP, rz = this.sz + this.nz * REST_GAP;
    this.x = this.fx + (rx - this.fx) * e; this.y = this.fy + (ry - this.fy) * e; this.z = this.fz + (rz - this.fz) * e;
    this.vx *= Math.exp(-dt * 10); this.vy *= Math.exp(-dt * 10); this.vz *= Math.exp(-dt * 10);
    this.wingPhase += 2 * Math.PI * this.freq * 0.7 * dt * (1 - e);
    this.wingAngle = (FLIGHT.wingMean + FLIGHT.wingAmp * 0.6 * Math.cos(this.wingPhase)) * (1 - e) + WING_OPEN * e;
    this.settle = e;
    if (k >= 1) {
      this.placeResting(this.sx, this.sy, this.sz, this.nx, this.ny, this.nz, this.tri, this.surfaceClass, this.headAngle);
      this.closedRest = false; this.wingAngle = WING_OPEN;      // lands with its wings spread; may close them later
      this.events.push('landed');
    }
  }

  /** Continuous move with collision against the static world and door leaves: it bumps and bounces off softly. */
  private integrate(dt: number) {
    const mx = this.vx * dt, my = this.vy * dt, mz = this.vz * dt;
    const ml = Math.hypot(mx, my, mz);
    if (ml < 1e-8) return;
    const d = this.castAll(this.x, this.y, this.z, mx / ml, my / ml, mz / ml, ml + 0.006);
    if (d < ml + 0.006) {
      const t = Math.max(0, d - 0.006);
      this.x += mx / ml * t; this.y += my / ml * t; this.z += mz / ml * t;
      const vn = this.vx * hit.nx + this.vy * hit.ny + this.vz * hit.nz;
      if (vn < 0) { this.vx -= 1.4 * vn * hit.nx; this.vy -= 1.4 * vn * hit.ny; this.vz -= 1.4 * vn * hit.nz; }
      this.vx *= 0.55; this.vy *= 0.55; this.vz *= 0.55;
    } else { this.x += mx; this.y += my; this.z += mz; }
  }

  castAll(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number {
    let best = max;
    if (this.bvh.raycast(ox, oy, oz, dx, dy, dz, max, hit, 15)) best = hit.t;
    const dd = this.obstacleRay(ox, oy, oz, dx, dy, dz, best);
    if (dd < best) { best = dd; hit.nx = -dx; hit.ny = -dy; hit.nz = -dz; }
    return best;
  }

  /** Find a real surface (wall, curtain, window pane, furniture, now and then the ceiling) nearby and fly to
   * LANDING.approach m off it. */
  beginLanding(host: Host) {
    let found = false, dist = 0;
    for (let i = 0; i < 16 && !found; i++) {
      let dx = gauss(), dy = gauss() * 0.6 + 0.05, dz = gauss();
      // prefer surfaces away from the person
      dx -= (host.x - this.x) * 0.3; dz -= (host.z - this.z) * 0.3;
      const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
      if (this.bvh.raycast(this.x, this.y, this.z, dx, dy, dz, 1.8, hit, 1 | 2 | 4 | 8)) {
        const kind = this.bvh.kind[hit.tri];
        if (hit.ny > 0.75 && kind === 1) continue;                                  // not on the floor
        if (hit.ny < -0.75 && Math.random() < 0.7) continue;                         // seldom on the ceiling
        if (hit.t < 0.12) continue;
        if (this.obstacleRay(this.x, this.y, this.z, dx, dy, dz, hit.t) < hit.t) continue;   // not on or behind a door leaf
        const px = this.x + dx * hit.t, py = this.y + dy * hit.t, pz = this.z + dz * hit.t;
        if (py < 0.3 || py > 2.35) continue;
        const nx = hit.nx, ny = hit.ny, nz = hit.nz, tri = hit.tri;
        // room for the spread disc: no edge or corner close by along the surface
        if (!this.flatAround(px, py, pz, nx, ny, nz)) continue;
        this.nx = nx; this.ny = ny; this.nz = nz; this.tri = tri; this.surfaceClass = this.bvh.cls[tri];
        this.sx = px; this.sy = py; this.sz = pz;
        const a = LANDING.approach;
        this.tx = px + nx * a; this.ty = py + ny * a; this.tz = pz + nz * a;
        dist = Math.hypot(px - this.x, py - this.y, pz - this.z);
        found = true;
      }
    }
    this.td = -1;
    if (found) this.setState('land', 2.5 + dist / (0.5 * this.landSpeed)); else this.setState('fly', rnd(1, 3));
  }

  /** The surface is there under the whole disc (4 probes FOOTPRINT out, same orientation) and nothing stands up from it
   * within that (a wall beside it). Fabric folds count as flat enough. */
  flatAround(px: number, py: number, pz: number, nx: number, ny: number, nz: number): boolean {
    const { t1, t2 } = surfaceBasis(nx, ny, nz), h: RayHit = { t: 0, tri: 0, nx: 0, ny: 0, nz: 0 };
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ex = t1[0] * a + t2[0] * b, ey = t1[1] * a + t2[1] * b, ez = t1[2] * a + t2[2] * b;
      const qx = px + nx * 0.02 + ex * FOOTPRINT, qy = py + ny * 0.02 + ey * FOOTPRINT, qz = pz + nz * 0.02 + ez * FOOTPRINT;
      if (!this.bvh.raycast(qx, qy, qz, -nx, -ny, -nz, 0.04, h, 15)) return false;                 // over an edge
      if (this.bvh.kind[h.tri] !== 3 && h.nx * nx + h.ny * ny + h.nz * nz < 0.9) return false;     // a bevel or a corner
      if (this.bvh.raycast(px + nx * 0.012, py + ny * 0.012, pz + nz * 0.012, ex, ey, ez, FOOTPRINT, h, 15)) return false;   // a wall beside it
    }
    return true;
  }

  /** approach speed: a little under its cruising speed, at least LANDING.speed */
  private get landSpeed() { return Math.max(LANDING.speed, this.p.speed * 0.8); }

  /** Caught in the net: it beats hard and in fits; where it is, is up to the net bag (net/bag.ts via the session). */
  catch() {
    this.vx = this.vy = this.vz = 0;
    this.setState('caught');
    this.events.push('caught');
    this.effort = 1; this.gliding = false; this.burst = 0.4; this.settle = 0;
  }

  private struggle(dt: number) {
    if (this.burst > 0) {
      this.burst -= dt;
      this.wingPhase += 2 * Math.PI * this.freq * 1.25 * dt;
      this.wingAngle = FLIGHT.wingMean + FLIGHT.wingAmp * 0.7 * Math.cos(this.wingPhase);
      if (this.burst <= 0) this.burst = Math.random() < 0.35 ? -rnd(0.12, 0.4) : rnd(0.2, 0.6);
    } else {
      // a pause: wings closed over the back
      this.burst += dt;
      this.wingAngle += (WING_CLOSED - this.wingAngle) * (1 - Math.exp(-dt / 0.06));
      if (this.burst >= 0) this.burst = rnd(0.2, 0.6);
    }
  }

  /** beating its wings in the net right now (pushes the bag about) */
  get struggling() { return this.state === 'caught' && this.burst > 0; }
}

function gauss() { let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
