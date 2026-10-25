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
