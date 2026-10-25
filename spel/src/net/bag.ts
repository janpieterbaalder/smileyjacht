// The net's bag: a cone of netting hanging from the hoop, simulated as cloth (Verlet particles with distance
// constraints, no Babylon dependency, unit-tested). The rim ring is sewn to the hoop and follows it exactly; the rest
// hangs under gravity, trails behind a fast sweep through the air (netting has a lot of drag for its weight), lies
// against walls and furniture instead of going through them, and is pushed about by a smiley struggling inside. It
// never stretches: netting caught behind a door jamb or a wall's edge slides free instead of being held there.
// Babylon frame (x east, y up, z south), metres, seconds.
import type { TriBVH, RayHit } from '../physics/bvh';

export type V3 = { x: number; y: number; z: number };

/** Bag geometry and material (tuning values for a fine nylon butterfly net). */
export const BAG = {
  /** particles around the rim and rings from the rim down (the last ring closes in the bottom point) */
  around: 16, rings: 8,
  /** bag depth (m) along its axis */
  depth: 0.3,
  /** air drag on the netting (1/s on the velocity relative to still air): a fast sweep blows the bag out behind */
  drag: 7,
  /** constraint iterations per step; how stiff the bend (skip-one) links are */
  iterations: 8, bend: 0.12,
  /** mass of a caught smiley relative to one particle of netting (it weighs the bottom down a little) */
  load: 3,
};

const hit: RayHit = { t: 0, tri: 0, nx: 0, ny: 0, nz: 0 }, hit2: RayHit = { t: 0, tri: 0, nx: 0, ny: 0, nz: 0 };

/** Radius of ring k (0 = rim) for a hoop of radius R: a rounded bag, narrowing toward the closed bottom. */
export function ringRadius(k: number, R: number): number {
  const s = k / BAG.rings;
  return R * Math.sqrt(Math.max(0, 1 - s * s)) * (1 - 0.15 * s);
}

export class NetBag {
  /** particle positions and previous positions (Verlet), xyz interleaved; index = ring * around + i, bottom point last */
  pos: Float32Array; prev: Float32Array;
  /** inverse mass (0 = pinned to the hoop) */
  private w: Float32Array;
  private links: { a: number; b: number; L: number; k: number }[] = [];
  /** how far (m) each particle can be from the hoop's centre: the rim's radius and its way down the bag (a leash) */
  private reach: Float32Array;
  readonly count: number;
  /** caught smileys in the bag: where each one sits (filled by step) */
  private loads: { id: number; pos: V3; push: V3 }[] = [];
  private started = false;

  constructor(public R: number, private bvh: TriBVH | null = null) {
    const A = BAG.around, N = BAG.rings;
    this.count = A * N + 1;
    this.pos = new Float32Array(this.count * 3); this.prev = new Float32Array(this.count * 3); this.w = new Float32Array(this.count);
    // rest shape: a rounded cone along -z (local: hoop in the xy plane at z = 0, bag behind it)
    const rest: V3[] = [];
    for (let k = 0; k < N; k++) for (let i = 0; i < A; i++) {
      const a = i / A * Math.PI * 2, r = ringRadius(k, R);
      rest.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, z: -BAG.depth * k / N });
      this.w[k * A + i] = k === 0 ? 0 : 1;
    }
    rest.push({ x: 0, y: 0, z: -BAG.depth });
    this.w[this.count - 1] = 1;
    const link = (a: number, b: number, k = 1) => this.links.push({ a, b, L: Math.hypot(rest[a].x - rest[b].x, rest[a].y - rest[b].y, rest[a].z - rest[b].z), k });
    for (let k = 0; k < N; k++) for (let i = 0; i < A; i++) {
      const p = k * A + i;
      link(p, k * A + (i + 1) % A);                                   // around
      if (k + 1 < N) link(p, (k + 1) * A + i); else link(p, this.count - 1);   // down
      if (k + 1 < N) link(p, (k + 1) * A + (i + 1) % A, 0.5);        // shear
      if (k + 2 < N) link(p, (k + 2) * A + i, BAG.bend);              // bend (netting is limp)
    }
    // the leash: along the bag from the rim to each ring (and the bottom point), 5 % for the netting's give
    this.reach = new Float32Array(this.count);
    let path = 0;
    for (let k = 0; k < N; k++) {
      if (k > 0) path += Math.hypot(ringRadius(k, R) - ringRadius(k - 1, R), BAG.depth / N);
      for (let i = 0; i < A; i++) this.reach[k * A + i] = R + path * 1.05;
    }
    this.reach[this.count - 1] = R + (path + ringRadius(N - 1, R)) * 1.05;
  }

  /** world position of particle i */
  at(i: number): V3 { return { x: this.pos[i * 3], y: this.pos[i * 3 + 1], z: this.pos[i * 3 + 2] }; }

  /** rim point i on a hoop at centre h with in-plane axes r, u (unit) */
  private rim(h: V3, r: V3, u: V3, i: number): V3 {
    const a = i / BAG.around * Math.PI * 2, c = Math.cos(a) * this.R, s = Math.sin(a) * this.R;
    return { x: h.x + r.x * c + u.x * s, y: h.y + r.y * c + u.y * s, z: h.z + r.z * c + u.z * s };
  }

  /** Lay the whole bag out behind the hoop (opening along n), at rest. */
  place(h: V3, n: V3, r: V3, u: V3) {
    const A = BAG.around, N = BAG.rings;
    for (let k = 0; k < N; k++) for (let i = 0; i < A; i++) {
      const a = i / A * Math.PI * 2, rr = ringRadius(k, this.R), d = BAG.depth * k / N, p = (k * A + i) * 3;
      this.pos[p] = h.x + (r.x * Math.cos(a) + u.x * Math.sin(a)) * rr - n.x * d;
      this.pos[p + 1] = h.y + (r.y * Math.cos(a) + u.y * Math.sin(a)) * rr - n.y * d;
      this.pos[p + 2] = h.z + (r.z * Math.cos(a) + u.z * Math.sin(a)) * rr - n.z * d;
    }
    const b = (this.count - 1) * 3;
    this.pos[b] = h.x - n.x * BAG.depth; this.pos[b + 1] = h.y - n.y * BAG.depth; this.pos[b + 2] = h.z - n.z * BAG.depth;
    this.prev.set(this.pos);
    this.started = true;
  }

  /** A caught smiley in the bag (id) and how it pushes the netting now (m/s^2 on the particles around it). */
  setLoad(id: number, push: V3 | null) {
    const l = this.loads.find((q) => q.id === id);
    if (!push) { if (l) this.loads.splice(this.loads.indexOf(l), 1); return; }
    if (l) l.push = push; else this.loads.push({ id, pos: this.bottom(), push });
  }
  /** where the caught smiley id sits in the bag (inside, near the bottom) */
  loadPos(id: number): V3 | null { return this.loads.find((q) => q.id === id)?.pos ?? null; }

  /** a point inside the bag, a little above its lowest part: the average of the bottom point and the last ring */
  bottom(): V3 {
    const A = BAG.around, k = BAG.rings - 1;
    let x = this.pos[(this.count - 1) * 3], y = this.pos[(this.count - 1) * 3 + 1], z = this.pos[(this.count - 1) * 3 + 2];
    for (let i = 0; i < A; i++) { const p = (k * A + i) * 3; x += this.pos[p]; y += this.pos[p + 1]; z += this.pos[p + 2]; }
    return { x: x / (A + 1), y: y / (A + 1), z: z / (A + 1) };
  }

  /** Advance dt s with the hoop at centre h, opening normal n, in-plane axes r, u (the rim ring follows it). */
  step(dt: number, h: V3, n: V3, r: V3, u: V3) {
    if (!this.started) this.place(h, n, r, u);
    if (dt <= 0) return;
    const A = BAG.around, P = this.pos, Q = this.prev;
    const sub = Math.max(1, Math.ceil(dt / (1 / 120) - 1e-9)), hdt = dt / sub;
    // the hoop moves through the substeps linearly from where the rim is now
    const r0 = this.rim(h, r, u, 0);
    const from = { x: P[0] - r0.x, y: P[1] - r0.y, z: P[2] - r0.z };
    for (let s = 1; s <= sub; s++) {
      const f = 1 - s / sub;
      // pinned rim
      for (let i = 0; i < A; i++) {
        const q = this.rim(h, r, u, i), p = i * 3;
        Q[p] = P[p]; Q[p + 1] = P[p + 1]; Q[p + 2] = P[p + 2];
        P[p] = q.x + from.x * f; P[p + 1] = q.y + from.y * f; P[p + 2] = q.z + from.z * f;
      }
      // free particles: gravity, air drag, the smileys' push; Verlet
      const damp = Math.exp(-BAG.drag * hdt);
      for (let i = A; i < this.count; i++) {
        const p = i * 3;
        let ax = 0, ay = -9.81, az = 0;
        for (const l of this.loads) {
          const dx = P[p] - l.pos.x, dy = P[p + 1] - l.pos.y, dz = P[p + 2] - l.pos.z, d2 = dx * dx + dy * dy + dz * dz;
          const wgt = Math.exp(-d2 / 0.0025);
          ax += l.push.x * wgt; ay += l.push.y * wgt - 9.81 * (BAG.load - 1) * wgt * 0.3; az += l.push.z * wgt;
        }
        const vx = (P[p] - Q[p]) * damp, vy = (P[p + 1] - Q[p + 1]) * damp, vz = (P[p + 2] - Q[p + 2]) * damp;
        Q[p] = P[p]; Q[p + 1] = P[p + 1]; Q[p + 2] = P[p + 2];
        P[p] += vx + ax * hdt * hdt; P[p + 1] += vy + ay * hdt * hdt; P[p + 2] += vz + az * hdt * hdt;
      }
      this.solve();
      this.collide(h);
      this.leash(h);
    }
    // caught smileys ride in the bottom of the bag (pulled toward it, kept inside the netting)
    const b = this.bottom();
    for (const l of this.loads) {
      const k = 1 - Math.exp(-dt / 0.05);
      l.pos = { x: l.pos.x + (b.x - l.pos.x) * k, y: l.pos.y + (b.y - l.pos.y) * k, z: l.pos.z + (b.z - l.pos.z) * k };
    }
  }

  /** distance constraints (the netting hardly stretches) */
  private solve() {
    const P = this.pos, W = this.w;
    for (let it = 0; it < BAG.iterations; it++) {
      for (const l of this.links) {
        const a = l.a * 3, b = l.b * 3, wa = W[l.a], wb = W[l.b], ws = wa + wb;
        if (ws === 0) continue;
        const dx = P[b] - P[a], dy = P[b + 1] - P[a + 1], dz = P[b + 2] - P[a + 2];
        const d = Math.hypot(dx, dy, dz);
        if (d < 1e-9) continue;
        // netting resists stretching, but folds and bunches freely: compression is barely resisted
        const e = d - l.L;
        const k = e > 0 ? l.k : l.k * 0.1;
        const c = e / d * k / ws;
        P[a] += dx * c * wa; P[a + 1] += dy * c * wa; P[a + 2] += dz * c * wa;
        P[b] -= dx * c * wb; P[b + 1] -= dy * c * wb; P[b + 2] -= dz * c * wb;
      }
    }
  }

  /** No particle further from the hoop's centre than the bag reaches (the netting does not stretch): pulled back onto
   * its leash. Whatever held it (a jamb it was caught behind) does not count. */
  private leash(h: V3) {
    const P = this.pos;
    for (let i = BAG.around; i < this.count; i++) {
      const p = i * 3, dx = P[p] - h.x, dy = P[p + 1] - h.y, dz = P[p + 2] - h.z, d = Math.hypot(dx, dy, dz), m = this.reach[i];
      if (d <= m) continue;
      const k = m / d;
      P[p] = h.x + dx * k; P[p + 1] = h.y + dy * k; P[p + 2] = h.z + dz * k;
    }
  }

  /** the netting lies against the world instead of passing through it (moves are cut at the first face; a little
   * friction along it). Netting that is already on the far side of something from the hoop (caught behind a door jamb
   * when the hoop was pushed past its edge) is not held there: it comes back through, as the hoop pulls it. */
  private collide(h: V3) {
    const bvh = this.bvh; if (!bvh) return;
    const P = this.pos, Q = this.prev, A = BAG.around;
    for (let i = A; i < this.count; i++) {
      const p = i * 3;
      const dx = P[p] - Q[p], dy = P[p + 1] - Q[p + 1], dz = P[p + 2] - Q[p + 2], d = Math.hypot(dx, dy, dz);
      if (d < 1e-7) continue;
      if (bvh.raycast(Q[p], Q[p + 1], Q[p + 2], dx / d, dy / d, dz / d, d + 0.004, hit, 15)) {
        // (where it was, seen from the hoop's centre: behind a face = caught; let it go)
        const ex = Q[p] - h.x, ey = Q[p + 1] - h.y, ez = Q[p + 2] - h.z, el = Math.hypot(ex, ey, ez);
        if (el > 1e-6 && bvh.raycast(h.x, h.y, h.z, ex / el, ey / el, ez / el, el, hit2, 15)) continue;
        const t = Math.max(0, hit.t - 0.004);
        // stop at the face, keep what runs along it (with friction)
        const vn = dx * hit.nx + dy * hit.ny + dz * hit.nz;
        const tx = (dx - hit.nx * vn) * 0.6, ty = (dy - hit.ny * vn) * 0.6, tz = (dz - hit.nz * vn) * 0.6;
        P[p] = Q[p] + dx / d * t + tx; P[p + 1] = Q[p + 1] + dy / d * t + ty; P[p + 2] = Q[p + 2] + dz / d * t + tz;
        // (not pushed into another face by the slide: checked once)
        const sx = P[p] - (Q[p] + dx / d * t), sy = P[p + 1] - (Q[p + 1] + dy / d * t), sz = P[p + 2] - (Q[p + 2] + dz / d * t), sl = Math.hypot(sx, sy, sz);
        if (sl > 1e-7 && bvh.raycast(Q[p] + dx / d * t, Q[p + 1] + dy / d * t, Q[p + 2] + dz / d * t, sx / sl, sy / sl, sz / sl, sl + 0.003, hit, 15)) {
          P[p] = Q[p] + dx / d * t; P[p + 1] = Q[p + 1] + dy / d * t; P[p + 2] = Q[p + 2] + dz / d * t;
        }
      }
    }
  }
}
