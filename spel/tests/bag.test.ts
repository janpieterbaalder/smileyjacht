// The net's bag as cloth: it hangs, trails behind a fast sweep, does not stretch, lies against walls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxesToBVH } from './helpers';
import { NetBag, BAG } from '../src/net/bag';

const R = 0.1;
const fwd = { x: 1, y: 0, z: 0 }, right = { x: 0, y: 0, z: 1 }, up = { x: 0, y: 1, z: 0 };

test('held still with the opening forward, the bag hangs down from the hoop', () => {
  const bag = new NetBag(R);
  const h = { x: 0, y: 1.5, z: 0 };
  for (let i = 0; i < 180; i++) bag.step(1 / 60, h, fwd, right, up);
  const b = bag.bottom();
  assert.ok(b.y < h.y - 0.15, `bottom ${b.y.toFixed(3)} below the hoop at ${h.y}`);
  // it does not stretch: every particle within the bag's length of the rim
  for (let i = 0; i < bag.count; i++) { const p = bag.at(i); assert.ok(Math.hypot(p.x - h.x, p.y - h.y, p.z - h.z) < R + BAG.depth * 1.12, `particle ${i}`); }
});

test('a fast sweep blows the bag out behind the hoop', () => {
  const bag = new NetBag(R);
  const h = { x: 0, y: 1.5, z: 0 };
  for (let i = 0; i < 120; i++) bag.step(1 / 60, h, fwd, right, up);
  // 0.2 s at 4 m/s along the opening's normal
  for (let i = 0; i < 12; i++) { h.x += 4 / 60; bag.step(1 / 60, h, fwd, right, up); }
  const b = bag.bottom();
  assert.ok(b.x < h.x - 0.15, `bottom ${(h.x - b.x).toFixed(3)} m behind the hoop`);
});

test('next to a wall the netting lies against it instead of passing through', () => {
  // wall face at z = 0.05 (the hoop's rim is 5 cm from it), the hoop swings toward it
  const bvh = boxesToBVH([{ min: [-2, 0, 0.05], max: [2, 3, 0.15] }]);
  const bag = new NetBag(R, bvh);
  const h = { x: 0, y: 1.5, z: -0.06 };
  for (let i = 0; i < 240; i++) {
    const a = Math.sin(i / 30) * 0.6;              // opening turning to and fro, toward the wall and away
    const n = { x: Math.cos(a), y: 0, z: Math.sin(a) }, r = { x: -Math.sin(a), y: 0, z: Math.cos(a) };
    bag.step(1 / 60, h, n, r, up);
    for (let k = BAG.around; k < bag.count; k++) assert.ok(bag.at(k).z < 0.05 + 1e-4, `particle ${k} at z ${bag.at(k).z.toFixed(4)}`);
  }
});

test('a caught smiley sits in the bottom of the bag and its beating moves the netting', () => {
  const bag = new NetBag(R);
  const h = { x: 0, y: 1.5, z: 0 };
  for (let i = 0; i < 120; i++) bag.step(1 / 60, h, fwd, right, up);
  const before = bag.bottom();
  bag.setLoad(7, { x: 0, y: 0, z: 0 });
  for (let i = 0; i < 30; i++) bag.step(1 / 60, h, fwd, right, up);
  const p = bag.loadPos(7)!, b = bag.bottom();
  assert.ok(Math.hypot(p.x - b.x, p.y - b.y, p.z - b.z) < 0.03, 'in the bottom');
  let moved = 0;
  for (let i = 0; i < 30; i++) { bag.setLoad(7, { x: (i % 2 ? 1 : -1) * 18, y: 8, z: 0 }); const q = bag.bottom(); bag.step(1 / 60, h, fwd, right, up); const r = bag.bottom(); moved += Math.hypot(r.x - q.x, r.y - q.y, r.z - q.z); }
  assert.ok(moved > 0.02, `the bag moves ${moved.toFixed(3)} m`);
  bag.setLoad(7, null);
  assert.equal(bag.loadPos(7), null);
  void before;
});

test('walking out through a doorway the bag catches on the jamb but never stretches: it comes free', () => {
  // a wall at x 1.0-1.1 with a doorway between z 0.5 and 1.4; the net is carried through it close to the jamb at
  // z 0.5 and then away to the side behind the wall, so the trailing bag drags round the jamb's edge
  const bvh = boxesToBVH([{ min: [1.0, 0, -3], max: [1.1, 2.4, 0.5] }, { min: [1.0, 0, 1.4], max: [1.1, 2.4, 4] }]);
  const bag = new NetBag(R, bvh);
  const h = { x: 0.4, y: 1.3, z: 0.65 };
  const maxReach = R + BAG.depth * 1.12;
  let worst = 0;
  const run = (steps: number, move: (i: number) => void) => {
    for (let i = 0; i < steps; i++) {
      move(i);
      bag.step(1 / 60, h, fwd, right, up);
      for (let k = 0; k < bag.count; k++) { const p = bag.at(k); worst = Math.max(worst, Math.hypot(p.x - h.x, p.y - h.y, p.z - h.z)); }
    }
  };
  run(60, () => {});                                        // hanging still before the doorway
  run(60, () => { h.x += 1.6 / 60; });                     // through it (1.6 m/s)
  run(60, () => { h.z -= 1.5 / 60; });                     // and away along the wall's far side
  run(120, () => {});                                       // standing still
  assert.ok(worst <= maxReach + 1e-6, `bag stretched to ${worst.toFixed(2)} m from the hoop (max ${maxReach.toFixed(2)})`);
  for (let k = 0; k < bag.count; k++) assert.ok(bag.at(k).x > 1.1, `particle ${k} still behind the wall at x ${bag.at(k).x.toFixed(2)}`);
});

test('a hoop that jumps past a wall edge in a frame or two does not leave the bag stretched behind it', () => {
  // the shown net can be pushed several cm per frame (out of a jamb, turning fast in a doorway): the netting's straight
  // way from where it was to where the hoop pulls it then runs through the wall
  const bvh = boxesToBVH([{ min: [1.0, 0, -3], max: [1.1, 2.4, 0.5] }]);
  const bag = new NetBag(R, bvh);
  const h = { x: 0.6, y: 1.3, z: 0.2 };
  const maxReach = R + BAG.depth * 1.12;
  let worst = 0;
  const step = () => { bag.step(1 / 60, h, fwd, right, up); for (let k = 0; k < bag.count; k++) { const p = bag.at(k); worst = Math.max(worst, Math.hypot(p.x - h.x, p.y - h.y, p.z - h.z)); } };
  for (let i = 0; i < 60; i++) step();
  // round the wall's end in three frames: out past its edge, then behind it
  h.z = 0.75; step(); h.x = 1.4; step(); h.z = 0.2; step();
  for (let i = 0; i < 120; i++) step();
  assert.ok(worst <= maxReach + 1e-6, `bag stretched to ${worst.toFixed(2)} m from the hoop (max ${maxReach.toFixed(2)})`);
  for (let k = 0; k < bag.count; k++) assert.ok(bag.at(k).x > 1.1, `particle ${k} left behind the wall at x ${bag.at(k).x.toFixed(2)}`);
});
