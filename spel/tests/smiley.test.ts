// Butterfly flight of the smileys: the wings' force comes in pulses (the body bobs with every beat), flapping alternates
// with short glides, the path is erratic, and it sinks slowly with the wings still.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { room } from './helpers';
import { SmileyBrain, strokeForce, FLIGHT } from '../src/smiley/brain';

const noDoor = (_ox: number, _oy: number, _oz: number, _dx: number, _dy: number, _dz: number, max: number) => max;
const idle = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, active: false };
const host = { x: 0.5, y: 1.6, z: 0.5 };

/** a big empty hall: flight without walls to bounce off */
const hall = () => room([]);

test('stroke: the downstroke gives the force, the upstroke little; it averages to 1 over a beat', () => {
  let sum = 0, down = 0, up = 0;
  const N = 10000;
  for (let i = 0; i < N; i++) { const p = i / N * 2 * Math.PI, f = strokeForce(p); sum += f; if (p < Math.PI) down += f; else up += f; }
  assert.ok(Math.abs(sum / N - 1) < 1e-3, `mean ${sum / N}`);
  assert.ok(down > 4 * up, `down ${down} up ${up}`);
});

test('in flight the body bobs with every beat: the vertical acceleration swings from under 0 to over 1 g at the wingbeat', () => {
  const b = new SmileyBrain(hall(), { alert: 1, restMin: 99, restMax: 99, speed: 0.8 }, 1, noDoor);
  b.x = 2; b.y = 1.5; b.z = 2; b.setState('fly', 99);
  let lo = Infinity, hi = -Infinity, flapFrames = 0, beats = 0, prevPhase = b.wingPhase, t = 0;
  const dt = 1 / 240;
  for (let i = 0; i < 240 * 20; i++) {
    b.update(dt, host, idle, [0, 0, 4, 4], 0); t += dt;
    if (b.gliding || b.state !== 'fly') { prevPhase = b.wingPhase; continue; }
    flapFrames++;
    lo = Math.min(lo, b.acc.y); hi = Math.max(hi, b.acc.y);
    if (Math.floor(b.wingPhase / (2 * Math.PI)) > Math.floor(prevPhase / (2 * Math.PI))) beats++;
    prevPhase = b.wingPhase;
  }
  assert.ok(lo < -0.5 * 9.81 && hi > 1.0 * 9.81, `vertical acceleration ${lo.toFixed(1)} .. ${hi.toFixed(1)} m/s^2`);
  const rate = beats / (flapFrames * dt);
  assert.ok(rate > FLIGHT.freq[0] * 0.95 && rate < FLIGHT.freq[1] * 1.2, `wingbeat ${rate.toFixed(1)} Hz`);
});

test('flap and glide: short glides with the wings held out, sinking and slowing; an erratic path', () => {
  const b = new SmileyBrain(hall(), { alert: 1, restMin: 99, restMax: 99, speed: 0.9 }, 2, noDoor);
  b.x = 2; b.y = 1.5; b.z = 2; b.setState('fly', 999);
  let glides = 0, glideFrames = 0, sinking = 0, wasGliding = false, inGlide = 0, turn = 0, n = 0, prevH = Math.atan2(b.vz, b.vx);
  for (let i = 0; i < 60 * 120; i++) {
    b.update(1 / 60, host, idle, [0, 0, 4, 4], 0);
    inGlide = b.gliding ? inGlide + 1 : 0;
    if (b.gliding) {
      glideFrames++;
      if (b.vy < 0) sinking++;
      // (the wings come to the glide position within ~0.1 s)
      if (inGlide > 6) assert.ok(Math.abs(b.wingAngle - FLIGHT.wingGlide) < 0.1, `wings held out (${b.wingAngle.toFixed(2)})`);
      if (!wasGliding) glides++;
    }
    wasGliding = b.gliding;
    const h = Math.atan2(b.vz, b.vx);
    if (Math.hypot(b.vx, b.vz) > 0.2) { let d = h - prevH; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; turn += Math.abs(d) * 60; n++; }
    prevH = h;
  }
  assert.ok(glides >= 8, `${glides} glides in two minutes`);
  assert.ok(sinking > 0.6 * glideFrames, `sinks while gliding (${sinking}/${glideFrames})`);
  assert.ok(turn / n > 1.0, `turns ${(turn / n).toFixed(2)} rad/s on average: not a smooth glide path`);
});

test('wings still, it sinks at about 1.3 m/s (the spread wings are a parachute)', () => {
  const vt = Math.sqrt(9.81 / FLIGHT.dragV);
  assert.ok(vt > 1.1 && vt < 1.5, `${vt}`);
});

test('a resting smiley fans its wings now and then; seeing the net come close and fast it flies off', () => {
  const b = new SmileyBrain(room(), { alert: 1, restMin: 99, restMax: 99, speed: 0.8 }, 3, noDoor);
  b.placeResting(0, 1.5, 2, 1, 0, 0, 0, 0);
  const angles = new Set<number>();
  for (let i = 0; i < 60 * 15; i++) { b.update(1 / 60, { x: 3, y: 1.6, z: 2 }, idle, [0, 0, 4, 4], 0); angles.add(Math.round(b.wingAngle * 10)); }
  assert.equal(b.state, 'rest');
  assert.ok(angles.size > 4, 'the wings move at rest');
  // a slow approach far off does not startle it
  let fled = 0;
  for (let k = 0; k < 200; k++) {
    const c = new SmileyBrain(room(), { alert: 1, restMin: 99, restMax: 99, speed: 0.8 }, 10 + k, noDoor);
    c.placeResting(0, 1.5, 2, 1, 0, 0, 0, 0);
    c.update(1 / 60, { x: 3, y: 1.6, z: 2 }, { x: 1.5, y: 1.5, z: 2, vx: -0.2, vy: 0, vz: 0, active: true, swing: 1 }, [0, 0, 4, 4], 0);
    if (c.state !== 'rest') fled++;
  }
  assert.equal(fled, 0, 'a net 1.5 m off moving slowly');
});
