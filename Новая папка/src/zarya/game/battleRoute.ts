import { B } from './data';
import type { Game, Unit } from './game';
import { frozenTile } from './seasons';
import type { Leg } from './battle';

/* ───────────── Маршруты армий: суша, лёд и море ───────────── */

export interface Pt {
  x: number;
  y: number;
}

/** клетка проходима для воина (вода — только как лёд) */
export function tileOk(g: Game, x: number, y: number, ice: boolean): boolean {
  const w = g.world;
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 1 || ty < 1 || tx >= w.w - 1 || ty >= w.h - 1) return false;
  const i = ty * w.w + tx;
  if (w.blocked[i]) return false;
  if (w.biome[i] <= B.WATER) return ice && frozenTile(g, i);
  return true;
}

/** сетка препятствий для поиска пути: 1 — не пройти */
function walkGrid(g: Game, ice: boolean): Uint8Array {
  const w = g.world;
  const gr = new Uint8Array(w.w * w.h);
  for (let i = 0; i < gr.length; i++) {
    const x = i % w.w;
    const y = (i / w.w) | 0;
    let b = w.blocked[i] ? 1 : 0;
    if (!b && w.biome[i] <= B.WATER && !(ice && frozenTile(g, i))) b = 1;
    if (x < 1 || y < 1 || x >= w.w - 1 || y >= w.h - 1) b = 1;
    gr[i] = b;
  }
  return gr;
}

/** сетка для кораблей: 1 — суша */
function waterGrid(g: Game): Uint8Array {
  const w = g.world;
  const gr = new Uint8Array(w.w * w.h);
  for (let i = 0; i < gr.length; i++) {
    const x = i % w.w;
    const y = (i / w.w) | 0;
    gr[i] = w.biome[i] > B.WATER || x < 1 || y < 1 || x >= w.w - 1 || y >= w.h - 1 ? 1 : 0;
  }
  return gr;
}

function nearestFree(g: Game, grid: Uint8Array, x: number, y: number, r: number): Pt | null {
  const w = g.world;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (cx >= 0 && cy >= 0 && cx < w.w && cy < w.h && !grid[cy * w.w + cx]) return { x: cx, y: cy };
  for (let k = 1; k <= r; k++)
    for (let dy = -k; dy <= k; dy++)
      for (let dx = -k; dx <= k; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== k) continue;
        const xx = cx + dx;
        const yy = cy + dy;
        if (xx < 0 || yy < 0 || xx >= w.w || yy >= w.h) continue;
        if (!grid[yy * w.w + xx]) return { x: xx, y: yy };
      }
  return null;
}

function findPath(g: Game, grid: Uint8Array, sx: number, sy: number, gx: number, gy: number, goalR: number): Pt[] | null {
  const w = g.world;
  const s = nearestFree(g, grid, sx, sy, 8);
  if (!s) return null;
  const goal = (x: number, y: number) => Math.hypot(x - gx, y - gy) <= goalR && !grid[y * w.w + x];
  if (goal(s.x, s.y)) return [s];
  return g.pf.find(grid, s.x, s.y, goal, Math.floor(gx), Math.floor(gy), true, w.w * w.h);
}

const dist2 = (a: Pt, x: number, y: number) => Math.hypot(a.x - x, a.y - y);

/** прибрежные клетки суши выбранного острова, ближайшие к цели и не слишком скученные */
function coastSpots(g: Game, landId: number, tx: number, ty: number, k: number): { land: Pt; water: Pt }[] {
  const w = g.world;
  const grid = walkGrid(g, false);
  const cands: { land: Pt; water: Pt; d: number }[] = [];
  for (let y = 2; y < w.h - 2; y++)
    for (let x = 2; x < w.w - 2; x++) {
      const i = y * w.w + x;
      if (grid[i] || w.landId[i] !== landId) continue;
      let wt: Pt | null = null;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (w.biome[(y + dy) * w.w + x + dx] <= B.WATER) {
          wt = { x: x + dx, y: y + dy };
          break;
        }
      }
      if (wt) cands.push({ land: { x, y }, water: wt, d: Math.hypot(x - tx, y - ty) });
    }
  cands.sort((a, b) => a.d - b.d);
  const out: { land: Pt; water: Pt }[] = [];
  for (const c of cands) {
    if (out.every((o) => Math.hypot(o.land.x - c.land.x, o.land.y - c.land.y) > 7)) out.push({ land: c.land, water: c.water });
    if (out.length >= k) break;
  }
  return out;
}

/**
 * Маршрут армии. Суша — один пеший этап; через пролив (sea) — пеший путь к берегу,
 * плавание на корабле и высадка на пляже у врага; ice — пешком по замёрзшему проливу.
 */
export function planRoute(g: Game, fx: number, fy: number, tx: number, ty: number, sea: boolean, ice: boolean): Leg[] | null {
  const w = g.world;
  if (!sea) {
    const p = findPath(g, walkGrid(g, ice), fx, fy, tx, ty, 3.5);
    return p ? [{ k: 'walk', p }] : null;
  }
  const land = walkGrid(g, false);
  const s = nearestFree(g, land, fx, fy, 8);
  const d = nearestFree(g, land, tx, ty, 8);
  if (!s || !d) return null;
  const srcLand = w.landId[s.y * w.w + s.x];
  const dstLand = w.landId[d.y * w.w + d.x];
  const embarks = coastSpots(g, srcLand, tx, ty, 4);
  const landings = coastSpots(g, dstLand, fx, fy, 4).concat(coastSpots(g, dstLand, tx, ty, 3));
  const wg = waterGrid(g);
  let best: { e: { land: Pt; water: Pt }; l: { land: Pt; water: Pt }; sail: Pt[]; cost: number } | null = null;
  for (const e of embarks) {
    for (const l of landings) {
      const sail = g.pf.find(wg, e.water.x, e.water.y, (x, y) => x === l.water.x && y === l.water.y, l.water.x, l.water.y, false, w.w * w.h);
      if (!sail) continue;
      const cost = sail.length + dist2(e.land, fx, fy) * 0.8 + dist2(l.land, tx, ty) * 1.2;
      if (!best || cost < best.cost) best = { e, l, sail: [e.water, ...sail], cost };
    }
  }
  if (!best) return null;
  const p1 = findPath(g, land, fx, fy, best.e.land.x, best.e.land.y, 0.8);
  const p3 = findPath(g, land, best.l.land.x, best.l.land.y, tx, ty, 3.5);
  if (!p1 || !p3) return null;
  return [
    { k: 'walk', p: p1 },
    { k: 'sail', p: best.sail },
    { k: 'walk', p: [best.l.land, ...p3] },
  ];
}

const TURNS = [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9];

/** шаг бойца к точке с обходом препятствий; true — дошёл */
export function stepUnit(g: Game, u: Unit, tx: number, ty: number, speed: number, dt: number, ice: boolean): boolean {
  const cb = u.cb;
  const dx = tx - u.x;
  const dy = ty - u.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.22) {
    u.moving = false;
    return true;
  }
  const step = Math.min(dist, speed * dt);
  const base = Math.atan2(dy, dx);
  const sgn = cb ? cb.turn : 1;
  let moved = false;
  for (const da of TURNS) {
    const a = base + da * sgn;
    const nx = u.x + Math.cos(a) * step;
    const ny = u.y + Math.sin(a) * step;
    if (tileOk(g, nx, ny, ice)) {
      u.x = nx;
      u.y = ny;
      moved = true;
      break;
    }
  }
  if (!moved && cb) cb.turn = cb.turn === 1 ? -1 : 1;
  if (Math.abs(dx) > Math.abs(dy) * 0.9) {
    u.dir = dx > 0 ? 2 : 3;
    u.fx = u.dir;
  } else u.dir = dy > 0 ? 0 : 1;
  u.anim += dt * speed * 1.7;
  u.moving = moved;
  u.phase = 'goto';
  return false;
}

/** ближайшая к точке клетка пути */
export function nearestNode(p: Pt[], x: number, y: number): number {
  let bi = 0;
  let bd = 1e9;
  for (let i = 0; i < p.length; i++) {
    const d = Math.hypot(p[i].x + 0.5 - x, p[i].y + 0.5 - y);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  return bi;
}

export function reverseLegs(legs: Leg[]): Leg[] {
  return legs
    .slice()
    .reverse()
    .map((l) => ({ k: l.k, p: l.p.slice().reverse() }));
}


let navFor: Game | null = null;
let navT = -99;
let navGrid: Uint8Array | null = null;

/** короткий обход препятствия для бойца в бою (сетка кэшируется на несколько секунд) */
export function navPath(g: Game, sx: number, sy: number, tx: number, ty: number): Pt[] | null {
  if (navFor !== g || !navGrid || g.time - navT > 4 || g.time < navT) {
    navGrid = walkGrid(g, false);
    navFor = g;
    navT = g.time;
  }
  const p = findPathLocal(g, navGrid, sx, sy, tx, ty);
  return p && p.length > 1 ? p : null;
}

function findPathLocal(g: Game, grid: Uint8Array, sx: number, sy: number, gx: number, gy: number): Pt[] | null {
  const w = g.world;
  const s = nearestFree(g, grid, sx, sy, 3);
  if (!s) return null;
  const goal = (x: number, y: number) => Math.hypot(x - gx, y - gy) <= 1.2 && !grid[y * w.w + x];
  if (goal(s.x, s.y)) return null;
  return g.pf.find(grid, s.x, s.y, goal, Math.floor(gx), Math.floor(gy), true, 6000);
}
