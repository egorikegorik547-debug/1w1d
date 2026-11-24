import { BUILDINGS, TH, TW } from './data';
import type { Game, Unit } from './game';
import type { March, Town } from './towns';
import type { RivalMarch } from './extstate';
import { DIFFS } from './social';
import { armyMorale, fighterStats, itemCount, killPerson, restoreGuards, type CombatStats, type Gear } from './life';
import { marchSpeedK } from './seasons';
import { addAsh, addShields } from './history';
import { footFx } from './fx';
import { pickDefenders, releaseTown, spawnMilitia } from './folk';
import { atkMult, outcomeConquer, outcomeFail, outcomeRaidPlunder, outcomeRaidRepelled, outcomeRaze } from './towns';
import { defBonus, rivalDefeat, rivalVictory } from './rivals';
import { navPath, nearestNode, planRoute, reverseLegs, stepUnit, tileOk, type Pt } from './battleRoute';

/* ═══════════════════════════════════════════════════════════════════════════
   Реальные походы и сражения: отряды идут по карте (по суше, по льду или на
   корабле), у города защитники выбегают навстречу, бойцы рубятся и стреляют,
   затем победители захватывают центр (или поджигают дома) и возвращаются домой.
   Состояние хранится в обычных объектах (March, RivalMarch, Town.siege) — оно
   сериализуется общим сериализатором из saves.ts.
   ═══════════════════════════════════════════════════════════════════════════ */

export type Phase = 'go' | 'fight' | 'capture' | 'raze' | 'back';
export interface Leg {
  k: 'walk' | 'sail';
  p: Pt[];
}
export interface Loot {
  food: number;
  wood: number;
  stone: number;
  gold: number;
}

/** боевое состояние одного бойца (лежит в Unit.cb) */
export interface Cb {
  team: number; // 0 — вы, иначе id города-владельца
  side: 'a' | 'd' | 'c'; // нападающий / защитник / мирный житель
  fr: number; // фронт: id осаждаемого города, 0 — ваше селение
  mode: 'march' | 'fight' | 'cap' | 'burn' | 'flee' | 'idle';
  hp: number;
  max: number;
  dmg: number;
  kind: 'melee' | 'bow' | 'xbow' | 'gun';
  reach: number;
  cd: number;
  sw: number;
  hit: boolean;
  tgt: number;
  rt: number;
  kx: number;
  ky: number;
  hurt: number;
  pi: number;
  arr: boolean;
  turn: 1 | -1;
  stuck: number;
  src: 'army' | 'home' | 'civmil' | 'civ' | 'guard' | 'folk' | 'extra';
  px: number;
  py: number;
  burn: number;
  burnT: number;
  aboard: boolean;
  last: number; // team последнего нанёсшего удар
  sepx: number;
  sepy: number;
  nav?: Pt[]; // обход препятствия (A*)
  navT: number;
  pd: number; // лучшая дистанция до цели (для обнаружения застревания)
  pdT: number;
  cow: number; // сколько секунд трус уже отступал
}

export interface Siege {
  on: boolean;
  n0: number;
  broken: boolean;
  t: number;
}

/** общие поля настоящего похода (у March и RivalMarch) */
export interface Campaign {
  id: number;
  n: number;
  squad?: Unit[];
  legs?: Leg[];
  li?: number;
  ship?: { x: number; y: number; pi: number } | null;
  phase?: Phase;
  startN?: number;
  capT?: number;
  razeT?: number;
  fightT?: number;
  wait?: number;
  catT?: number;
  kd?: number;
  kl?: number;
  fled?: boolean;
  resolved?: boolean;
  loot?: Loot;
  stock0?: Loot;
  prog?: number;
  q?: number;
}

/* ───────────── Вспомогательное ───────────── */

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const BANNERS = ['#e5484d', '#e8a33a', '#a96bff', '#4aa8ff', '#5fd0a0', '#e86ab0'];
export const teamColor = (team: number) => (team === 0 ? '#6ab8ff' : BANNERS[team % BANNERS.length]);

const TRIG = 10; // радиус, с которого защитники выбегают навстречу
const LEASH = 17; // дальше этого защитники врага не преследуют
const WALK = 1.9;
const SAIL = 2.9;
const FIGHT_SPD = 2.6;
const RAZE_MAX = 16;

export const isRival = (c: Campaign): c is RivalMarch => 'from' in c;
const asMarch = (c: Campaign) => c as March;
const townById = (g: Game, id: number) => g.towns.find((t) => t.id === id);

export function allArmies(g: Game): Campaign[] {
  return [...g.marches, ...(g.ext?.rivalMarches ?? [])];
}

function kindOf(c: Campaign): 'player' | 'raid' | 'rival' {
  if (isRival(c)) return 'rival';
  return asMarch(c).incoming ? 'raid' : 'player';
}

interface Tg {
  home: boolean;
  t?: Town;
  id: number;
  x: number;
  y: number;
}

const campGate = (g: Game) => {
  const b = g.buildings[0];
  return b ? { x: b.x + b.w / 2, y: b.y + b.h + 0.5 } : { x: g.world.startX + 1, y: g.world.startY + 3 };
};
const townGate = (t: Town) => ({ x: t.x + 0.5, y: t.y + 1.5 });

function targetOf(g: Game, c: Campaign): Tg | null {
  if (isRival(c)) {
    const t = townById(g, c.to);
    return t && t.owner === 'free' ? { home: false, t, id: t.id, ...townGate(t) } : null;
  }
  const m = asMarch(c);
  if (m.incoming) return g.buildings[0] ? { home: true, id: 0, ...campGate(g) } : null;
  const t = townById(g, m.townId);
  return t && t.owner === 'free' ? { home: false, t, id: t.id, ...townGate(t) } : null;
}

function iceOf(g: Game, c: Campaign): boolean {
  if (isRival(c)) {
    const a = townById(g, c.from);
    const b = townById(g, c.to);
    return !!a && !!b && a.land !== b.land;
  }
  const m = asMarch(c);
  return !!m.ice;
}

function armySpeed(g: Game, c: Campaign): number {
  return WALK * marchSpeedK(g) * (kindOf(c) === 'player' ? g.mods.march : 1);
}

function newCb(st: CombatStats, o: { team: number; side: Cb['side']; fr: number; src: Cb['src']; px?: number; py?: number }): Cb {
  return {
    team: o.team,
    side: o.side,
    fr: o.fr,
    mode: 'march',
    hp: st.max,
    max: st.max,
    dmg: st.dmg,
    kind: st.kind,
    reach: st.reach,
    cd: st.cd,
    sw: 0,
    hit: false,
    tgt: 0,
    rt: Math.random() * 0.4,
    kx: 0,
    ky: 0,
    hurt: 0,
    pi: 0,
    arr: false,
    turn: Math.random() < 0.5 ? 1 : -1,
    stuck: 0,
    src: o.src,
    px: o.px ?? 0,
    py: o.py ?? 0,
    burn: 0,
    burnT: 0,
    aboard: false,
    last: -1,
    sepx: 0,
    sepy: 0,
    navT: 0,
    pd: 1e9,
    pdT: 0,
    cow: 0,
  };
}

/** оружие и броня воинов чужого селения зависят от его ранга */
function enemyGear(t: Town, k: number): Gear {
  const r = Math.random();
  const tier = t.tier;
  let weapon: string;
  if (tier <= 1) weapon = r < 0.55 ? 'club' : 'spear';
  else if (tier <= 3) weapon = r < 0.3 ? 'spear' : r < 0.5 ? 'bow' : r < 0.75 ? 'waraxe' : 'bronze_sword';
  else if (tier <= 5) weapon = r < 0.3 ? 'iron_sword' : r < 0.5 ? 'crossbow' : r < 0.62 ? 'bow' : r < 0.82 ? 'waraxe' : 'pike';
  else weapon = r < 0.3 ? 'steel_sword' : r < 0.5 ? 'crossbow' : r < 0.65 ? 'musket' : r < 0.85 ? 'iron_sword' : 'pike';
  const armor = tier >= 6 ? (r < 0.5 ? 'chainmail' : 'leather') : tier >= 4 ? (r < 0.4 ? 'chainmail' : 'leather') : tier >= 2 && r < 0.4 ? 'leather' : null;
  const ranged = weapon === 'bow' || weapon === 'crossbow' || weapon === 'musket';
  return { weapon, armor, shield: !ranged && tier >= 1 && k % 2 === 0, horse: false };
}

function mkEnemy(g: Game, t: Town, x: number, y: number, k: number): Unit {
  const u = g.newUnit(x, y, false);
  u.role = 'soldier';
  u.look.female = false;
  u.look.cloth = [0, 1, 2][t.id % 3];
  u.look.acc = 0;
  u.gear = enemyGear(t, k);
  u.accent = teamColor(t.id);
  u.sleeping = false;
  return u;
}

function scatter(g: Game, x: number, y: number, ice: boolean): { x: number; y: number } {
  for (let k = 0; k < 8; k++) {
    const a = Math.random() * Math.PI * 2;
    const r = 1.2 + Math.random() * 2.6;
    const nx = x + Math.cos(a) * r;
    const ny = y + Math.sin(a) * r * 0.8;
    if (tileOk(g, nx, ny, ice)) return { x: nx, y: ny };
  }
  return { x, y };
}

/* ───────────── Создание походов ───────────── */

/** общая часть: превращает отряд в настоящий поход */
function initArmy(g: Game, c: Campaign, squad: Unit[], legs: Leg[]) {
  c.squad = squad;
  c.legs = legs;
  c.li = 0;
  c.phase = 'go';
  c.startN = squad.length;
  c.n = squad.length;
  c.capT = 0;
  c.razeT = 0;
  c.fightT = 0;
  c.wait = 0;
  c.ship = null;
  c.resolved = false;
  c.prog = 0;
  c.loot = { food: 0, wood: 0, stone: 0, gold: 0 };
  for (const u of squad) {
    u.path = [];
    u.sleeping = false;
    u.sel = false;
    if (u.cb) {
      u.cb.mode = 'march';
      u.cb.pi = nearestNode(legs[0].p, u.x, u.y);
      u.cb.arr = false;
    }
  }
  void g;
}

/** план маршрута; null — пути нет */
export function planArmyRoute(g: Game, t: Town, sea: boolean, ice: boolean): Leg[] | null {
  const o = campGate(g);
  const d = townGate(t);
  return planRoute(g, o.x, o.y, d.x, d.y, sea, ice);
}

/** поход игрока: воины из гарнизона реально идут к городу */
export function launchPlayerArmy(g: Game, m: March, legs: Leg[]) {
  const squad = m.members ?? [];
  const god = g.dev.godArmy ? Math.sqrt(20) : 1;
  const morale = armyMorale(g);
  for (const u of squad) {
    const st = fighterStats(g, u, { morale, off: atkMult(g) * god, def: god });
    u.cb = newCb(st, { team: 0, side: 'a', fr: m.townId, src: 'army' });
    u.hp = 10;
  }
  initArmy(g, m, squad, legs);
  m.survivors = squad.length;
}

/** набег ИИ на ваше селение: из города выходит отряд настоящих воинов */
export function spawnRaid(g: Game, t: Town, n: number): March | null {
  const camp = g.buildings[0];
  if (!camp) return null;
  n = clamp(Math.floor(n), 1, 36);
  const ice = t.land !== g.world.landId[(g.world.startY + 1) * g.world.w + g.world.startX + 1];
  const o = townGate(t);
  const d = campGate(g);
  const legs = planRoute(g, o.x, o.y, d.x, d.y, false, ice) ?? [{ k: 'walk' as const, p: [{ x: Math.floor(d.x), y: Math.floor(d.y) }] }];
  const q = (1 + 0.1 * t.tier) * DIFFS[g.diff].enemy;
  const sq = Math.sqrt(q);
  const squad: Unit[] = [];
  for (let i = 0; i < n; i++) {
    const p = scatter(g, o.x, o.y, ice);
    const u = mkEnemy(g, t, p.x, p.y, i);
    u.cb = newCb(fighterStats(g, u, { off: sq, def: sq }), { team: t.id, side: 'a', fr: 0, src: 'army' });
    squad.push(u);
  }
  const m: March = { id: g.nextId++, townId: t.id, mode: 'raze', n, t: 0, dur: 1, phase: 'go', sea: false, survivors: 0, incoming: true, ice, sx: t.x, sy: t.y, tx: camp.x + 1, ty: camp.y + 1 };
  initArmy(g, m, squad, legs);
  g.marches.push(m);
  return m;
}

/** война между ИИ-городами: отряд A идёт на D */
export function spawnRivalArmy(g: Game, A: Town, D: Town, n: number, q: number): RivalMarch | null {
  n = clamp(Math.floor(n), 1, 30);
  const ice = A.land !== D.land;
  const o = townGate(A);
  const d = townGate(D);
  const legs = planRoute(g, o.x, o.y, d.x, d.y, false, ice) ?? [{ k: 'walk' as const, p: [{ x: Math.floor(d.x), y: Math.floor(d.y) }] }];
  const sq = Math.sqrt(q);
  const squad: Unit[] = [];
  for (let i = 0; i < n; i++) {
    const p = scatter(g, o.x, o.y, ice);
    const u = mkEnemy(g, A, p.x, p.y, i);
    u.cb = newCb(fighterStats(g, u, { off: sq, def: sq }), { team: A.id, side: 'a', fr: D.id, src: 'army' });
    squad.push(u);
  }
  const m: RivalMarch = { id: g.nextId++, from: A.id, to: D.id, n, t: 0, dur: 1, sx: A.x, sy: A.y, tx: D.x, ty: D.y, q };
  initArmy(g, m, squad, legs);
  g.ext.rivalMarches.push(m);
  return m;
}

/** старые сохранения: поход без отряда превращается в настоящий */
function upgradeLegacy(g: Game, c: Campaign): boolean {
  const kind = kindOf(c);
  if (kind === 'player') {
    const m = asMarch(c);
    const t = townById(g, m.townId);
    const mem = m.members ?? [];
    if (!t || t.owner !== 'free' || m.phase === 'back' || !mem.length) {
      // уже возвращались или цель потеряна — отряд сразу дома
      const n = m.phase === 'back' ? m.survivors : m.n;
      g.army += n;
      restoreHome(m);
      return false;
    }
    const reach = m.sea ? true : false;
    const legs = planRoute(g, campGate(g).x, campGate(g).y, townGate(t).x, townGate(t).y, reach, !!m.ice);
    if (!legs) {
      g.army += m.n;
      restoreHome(m);
      return false;
    }
    launchPlayerArmy(g, m, legs);
    return true;
  }
  if (kind === 'raid') {
    const m = asMarch(c);
    const t = townById(g, m.townId);
    if (!t) return false;
    const fresh = spawnRaid(g, t, m.n);
    if (!fresh) return false;
    // подменяем содержимое старого похода новым
    Object.assign(m, fresh);
    g.marches.pop();
    return true;
  }
  const r = c as RivalMarch;
  const A = townById(g, r.from);
  const D = townById(g, r.to);
  if (!A || !D) return false;
  const fresh = spawnRivalArmy(g, A, D, r.n, r.q ?? 1);
  if (!fresh) return false;
  Object.assign(r, fresh);
  g.ext.rivalMarches.pop();
  return true;
}

/* ───────────── Осада: мобилизация защитников ───────────── */

function ensureSiege(g: Game, tg: Tg): Siege {
  if (tg.home) {
    const X = g.ext;
    if (!X.homeSiege?.on) {
      X.homeSiege = { on: true, n0: 0, broken: false, t: 0 };
      X.homeSiege.n0 = mobilizeHome(g);
    }
    return X.homeSiege;
  }
  const t = tg.t!;
  if (!t.siege?.on) {
    t.siege = { on: true, n0: 0, broken: false, t: 0 };
    t.siege.n0 = mobilizeTown(g, t);
  }
  return t.siege;
}

function mobilizeTown(g: Game, t: Town): number {
  const vsPlayer = g.marches.some((m) => !m.incoming && m.townId === t.id);
  const mult = vsPlayer ? DIFFS[g.diff].enemy : 1;
  const need = clamp(Math.round(t.soldiers + t.pop * 0.12), 3, 28);
  const q = (1 + 0.1 * t.tier) * (t.spec === 'warrior' ? 1.25 : 1) * (t.spec === 'smith' ? 1.1 : 1) * mult;
  const sq = Math.sqrt(q);
  const picks = pickDefenders(g, t, need);
  const list = picks.map((p) => ({ u: p.u, src: p.src as Cb['src'] }));
  for (const u of spawnMilitia(g, t, need - picks.length)) list.push({ u, src: 'extra' });
  // подкрепление от державы и союзников подбегает с края карты города
  const reinf = Math.min(8, Math.round((defBonus(g, t) * mult) / 2.5));
  if (reinf > 0) {
    let ax = 0;
    let ay = 0;
    let an = 0;
    for (const c of allArmies(g)) {
      const tg = targetOf(g, c);
      if (!tg || tg.id !== t.id || !c.squad) continue;
      for (const u of c.squad) {
        ax += u.x;
        ay += u.y;
        an++;
      }
    }
    const ang = an ? Math.atan2(t.y - ay / an, t.x - ax / an) : Math.random() * Math.PI * 2;
    const around = { x: t.x + 0.5 + Math.cos(ang) * 12, y: t.y + 1.5 + Math.sin(ang) * 9 };
    for (const u of spawnMilitia(g, t, reinf, around)) list.push({ u, src: 'extra' });
  }
  list.forEach(({ u, src }, i) => {
    u.gear = src === 'guard' || src === 'extra' ? enemyGear(t, i) : { weapon: 'club', armor: null, shield: false, horse: false };
    u.look.cloth = [0, 1, 2][t.id % 3];
    const st = fighterStats(g, u, { off: sq, def: sq, militia: src === 'folk' });
    u.cb = newCb(st, { team: t.id, side: 'd', fr: t.id, src, px: u.x, py: u.y });
    u.cb.mode = 'fight';
    u.accent = teamColor(t.id);
    u.sleeping = false;
  });
  return list.length;
}

function mobilizeHome(g: Game): number {
  let towers = 1;
  for (const b of g.buildings) if (b.done) towers += BUILDINGS[b.type].def ?? 0;
  const god = g.dev.godArmy ? Math.sqrt(20) : 1;
  const k = Math.sqrt(g.mods.def * towers) * god;
  const morale = armyMorale(g);
  let n = 0;
  for (const u of g.guards) {
    u.sleeping = false;
    u.path = [];
    u.cb = newCb(fighterStats(g, u, { morale, off: k, def: k }), { team: 0, side: 'd', fr: 0, src: 'home', px: u.x, py: u.y });
    u.cb.mode = 'fight';
    n++;
  }
  // часть взрослых жителей хватается за дубины
  const adults = g.units.filter((u) => !u.child && u.spawn <= 0 && u.role === 'none' && !u.cb);
  const mil = Math.min(6, Math.floor(adults.length * 0.15));
  for (let i = 0; i < mil; i++) {
    const u = adults[i];
    u.sleeping = false;
    u.path = [];
    u.carry = { type: null, n: 0 };
    u.gear = { weapon: 'club', armor: null, shield: false, horse: false };
    u.cb = newCb(fighterStats(g, u, { morale, off: k, def: k, militia: true }), { team: 0, side: 'd', fr: 0, src: 'civmil', px: u.x, py: u.y });
    u.cb.mode = 'fight';
    n++;
  }
  g.life.battleT = 6;
  return n;
}

function releaseSiege(g: Game, tg: { home: boolean; t?: Town }) {
  if (tg.home) {
    const X = g.ext;
    X.homeSiege = undefined;
    for (const u of g.guards) if (u.cb) { u.cb = undefined; u.swing = 0; u.moving = false; u.phase = 'goto'; }
    for (const u of g.units) {
      if (!u.cb) continue;
      u.cb = undefined;
      u.gear = undefined;
      u.swing = 0;
      g.setIdle(u);
    }
    return;
  }
  const t = tg.t!;
  releaseTown(g, t);
  t.siege = undefined;
}

/* ───────────── Реестр бойцов на кадр ───────────── */

interface Reg {
  all: Unit[];
  byId: Map<number, Unit>;
  atk: Map<number, Unit[]>;
  def: Map<number, Unit[]>;
  civ: Unit[];
}

function push<K>(m: Map<K, Unit[]>, k: K, u: Unit) {
  const a = m.get(k);
  if (a) a.push(u);
  else m.set(k, [u]);
}

function collect(g: Game): Reg {
  const r: Reg = { all: [], byId: new Map(), atk: new Map(), def: new Map(), civ: [] };
  const add = (u: Unit) => {
    const cb = u.cb;
    if (!cb || cb.hp <= 0) return;
    r.all.push(u);
    r.byId.set(u.id, u);
    if (cb.side === 'c') r.civ.push(u);
    else if (cb.side === 'a') {
      if (cb.mode !== 'march' && !cb.aboard) push(r.atk, cb.fr, u);
    } else if (cb.mode !== 'idle' && cb.mode !== 'flee') push(r.def, cb.fr, u);
  };
  for (const c of allArmies(g)) for (const u of c.squad ?? []) add(u);
  for (const t of g.towns) for (const u of t.folk) if (u.cb) add(u);
  for (const u of g.guards) if (u.cb) add(u);
  for (const u of g.units) if (u.cb) add(u);
  return r;
}

/** видимые на карте воины походов (для отрисовки и выбора) */
export function battleUnits(g: Game): Unit[] {
  const out: Unit[] = [];
  for (const c of allArmies(g)) for (const u of c.squad ?? []) if (!u.sleeping) out.push(u);
  return out;
}

/** ваши воины в походах (их можно выделять и вести в бой) */
export function playerSquad(g: Game): Unit[] {
  const out: Unit[] = [];
  for (const m of g.marches) if (!m.incoming) for (const u of m.members ?? []) if (!u.sleeping && u.cb) out.push(u);
  return out;
}

function enemyUnits(g: Game): Unit[] {
  const out: Unit[] = [];
  for (const c of allArmies(g)) for (const u of c.squad ?? []) if (u.cb && u.cb.team !== 0 && u.cb.hp > 0 && !u.sleeping) out.push(u);
  for (const t of g.towns) for (const u of t.folk) if (u.cb && u.cb.team !== 0 && u.cb.hp > 0 && u.cb.side === 'd' && u.cb.mode !== 'idle') out.push(u);
  return out;
}

export function battleFoeAt(g: Game, x: number, y: number): { id: number; d: number } | null {
  let best: { id: number; d: number } | null = null;
  for (const u of enemyUnits(g)) {
    const d = Math.hypot(u.x - x, u.y - 0.5 - y);
    if (d < 1.3 && (!best || d < best.d)) best = { id: u.id, d };
  }
  return best;
}

export function foeById(g: Game, id: number): { x: number; y: number; hit: (d: number) => void } | null {
  const u = enemyUnits(g).find((q) => q.id === id);
  return u ? { x: u.x, y: u.y, hit: (dm) => hurt(g, u, dm, 0, null) } : null;
}

/* ───────────── Урон, снаряды, смерти ───────────── */

interface Proj {
  x: number;
  y: number;
  tx: number;
  ty: number;
  t: number;
  dur: number;
  kind: 'arrow' | 'bolt' | 'bullet' | 'rock';
  side: 'a' | 'd';
  team: number;
  fr: number;
  dmg: number;
  tid: number;
  arc: number;
}
let PROJ: Proj[] = [];
let projFor: Game | null = null;
let projT = 0;
let sfxT = 0;
export const projectiles = () => PROJ;

function hurt(g: Game, v: Unit, dmg: number, kb: number, from: Unit | null, byTeam = -1) {
  const cb = v.cb;
  if (!cb || cb.hp <= 0) return;
  cb.hp -= dmg;
  cb.hurt = 0.18;
  cb.last = from?.cb ? from.cb.team : byTeam;
  if (from && kb) {
    const dx = v.x - from.x;
    const dy = v.y - from.y;
    const d = Math.hypot(dx, dy) || 1;
    cb.kx += (dx / d) * kb;
    cb.ky += (dy / d) * kb;
  }
  const px = v.x * TW;
  const py = v.y * TH;
  g.spark(px, py - 10, '#ffe9a8', 2);
  g.spark(px, py - 9, cb.team === 0 ? '#d83a3a' : '#c8503a', 2);
  g.floatText(px + rnd(-4, 4), py - 18, `-${Math.max(1, Math.round(dmg))}`, cb.team === 0 ? '#ff8a7a' : '#fff0b0');
  if (g.time - sfxT > 0.28) {
    sfxT = g.time;
    g.sfx('battle', px, py);
  }
}

function fireProj(g: Game, u: Unit, tgt: Unit) {
  const cb = u.cb!;
  const dist = Math.hypot(tgt.x - u.x, tgt.y - u.y);
  const speed = cb.kind === 'gun' ? 38 : cb.kind === 'xbow' ? 22 : 15;
  const err = dist * (cb.kind === 'gun' ? 0.035 : 0.06);
  const tx = tgt.x + rnd(-err, err);
  const ty = tgt.y + rnd(-err, err) * 0.7;
  const dir = tgt.x >= u.x ? 1 : -1;
  const sx = u.x + dir * 0.35;
  const sy = u.y;
  PROJ.push({
    x: sx,
    y: sy,
    tx,
    ty,
    t: 0,
    dur: Math.max(0.08, dist / speed),
    kind: cb.kind === 'gun' ? 'bullet' : cb.kind === 'xbow' ? 'bolt' : 'arrow',
    side: cb.side === 'd' ? 'd' : 'a',
    team: cb.team,
    fr: cb.fr,
    dmg: cb.dmg * rnd(0.85, 1.15),
    tid: tgt.id,
    arc: cb.kind === 'gun' ? 0 : cb.kind === 'xbow' ? 5 : 12,
  });
  if (cb.kind === 'gun') {
    // вспышка и дым выстрела
    const px = sx * TW + dir * 4;
    const py = sy * TH - 9;
    for (let i = 0; i < 4; i++) g.particles.push({ x: px, y: py, vx: dir * (10 + Math.random() * 18), vy: (Math.random() - 0.5) * 8, life: 0.12, max: 0.12, color: i % 2 ? '#fff6c0' : '#ffb040', size: 2, grav: 0 });
    for (let i = 0; i < 3; i++) g.particles.push({ x: px, y: py, vx: dir * (2 + Math.random() * 6), vy: -3 - Math.random() * 4, life: 0.9, max: 0.9, color: 'rgba(200,200,210,0.7)', size: 2, grav: 0, grow: 4 });
    g.sfx('battle', px, py);
  }
}

function fireRock(g: Game, from: { x: number; y: number }, to: Unit, dmg: number, team: number, fr: number) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  PROJ.push({ x: from.x, y: from.y, tx: to.x + rnd(-1, 1), ty: to.y + rnd(-1, 1), t: 0, dur: Math.max(0.5, dist / 9), kind: 'rock', side: 'a', team, fr, dmg, tid: to.id, arc: 38 });
  g.particles.push({ x: from.x * TW, y: from.y * TH - 6, vx: 0, vy: -6, life: 0.7, max: 0.7, color: 'rgba(210,200,180,0.7)', size: 2, grav: 0, grow: 5 });
  g.sfx('battle', from.x * TW, from.y * TH);
}

function updateProj(g: Game, reg: Reg, dt: number) {
  for (let i = PROJ.length - 1; i >= 0; i--) {
    const p = PROJ[i];
    p.t += dt;
    if (p.t < p.dur) continue;
    PROJ.splice(i, 1);
    if (p.kind === 'rock') {
      const px = p.tx * TW;
      const py = p.ty * TH;
      for (const v of reg.all) {
        const cb = v.cb!;
        if (cb.hp <= 0 || cb.side === 'c' || cb.side === p.side || cb.fr !== p.fr) continue;
        const d = Math.hypot(v.x - p.tx, v.y - p.ty);
        if (d < 2.3) hurt(g, v, p.dmg * (1 - d / 3), 5, null, p.team);
      }
      for (let k = 0; k < 14; k++) g.particles.push({ x: px + rnd(-5, 5), y: py, vx: rnd(-18, 18), vy: rnd(-22, -6), life: 0.8, max: 0.8, color: k % 3 ? '#8a7a62' : '#c8b898', size: 2, grav: 50 });
      for (let k = 0; k < 4; k++) g.particles.push({ x: px + rnd(-6, 6), y: py - 2, vx: rnd(-4, 4), vy: -3 - Math.random() * 5, life: 1.2, max: 1.2, color: 'rgba(200,190,170,0.65)', size: 3, grav: 0, grow: 6 });
      g.sfx('battle', px, py);
      continue;
    }
    let victim: Unit | null = null;
    const hostile = (v: Unit) => !!v.cb && v.cb.hp > 0 && v.cb.side !== 'c' && v.cb.side !== p.side && v.cb.fr === p.fr;
    const tv = reg.byId.get(p.tid);
    if (tv && hostile(tv) && Math.hypot(tv.x - p.tx, tv.y - p.ty) < 0.9) victim = tv;
    else {
      let bd = 0.65;
      for (const v of reg.all) {
        if (!hostile(v)) continue;
        const d = Math.hypot(v.x - p.tx, v.y - p.ty);
        if (d < bd) {
          bd = d;
          victim = v;
        }
      }
    }
    if (victim) hurt(g, victim, p.dmg, p.kind === 'bullet' ? 2.5 : 1.5, null, p.team);
    else g.particles.push({ x: p.tx * TW, y: p.ty * TH, vx: 0, vy: -2, life: 0.4, max: 0.4, color: 'rgba(200,180,140,0.7)', size: 1, grav: 0 });
  }
}

let civDead = 0;

function kill(g: Game, u: Unit) {
  const cb = u.cb!;
  const px = u.x * TW;
  const py = u.y * TH;
  for (let k = 0; k < 6; k++) g.spark(px, py - 8, k % 2 ? '#c8c8d8' : '#c83a3a');
  g.particles.push({ x: px, y: py - 6, vx: 0, vy: -5, life: 0.9, max: 0.9, color: 'rgba(190,190,200,0.6)', size: 3, grav: 0, grow: 5 });
  if (Math.random() < 0.35) addShields(g, u.x, u.y, 1, 0.5);
  for (const c of allArmies(g)) {
    const i = c.squad?.indexOf(u) ?? -1;
    if (i >= 0) c.squad!.splice(i, 1);
  }
  if (cb.side !== 'a' && cb.src !== 'home' && cb.src !== 'civmil' && cb.src !== 'civ') {
    const t = townById(g, cb.fr);
    if (t) {
      const i = t.folk.indexOf(u);
      if (i >= 0) t.folk.splice(i, 1);
      if (t.soldiers >= 1) t.soldiers -= 1;
      else t.pop = Math.max(2, t.pop - 0.6);
    }
  }
  if (cb.last === 0 && cb.team !== 0) g.life.kills++;
  if (cb.team === 0) {
    if (cb.src === 'home') {
      g.army = Math.max(0, g.army - 1);
      killPerson(g, u, 'пал, защищая деревню', true);
    } else if (cb.src === 'civmil') killPerson(g, u, 'пал, защищая деревню', true);
    else if (cb.src === 'civ') {
      civDead++;
      killPerson(g, u, 'убит налётчиками');
    } else killPerson(g, u, 'пал героем в бою', true);
  }
  u.cb = undefined;
}

/* ───────────── Поведение бойца ───────────── */

function nearest(u: Unit, list: Unit[]): Unit | null {
  let best: Unit | null = null;
  let bd = 1e9;
  for (const v of list) {
    if (v === u || !v.cb || v.cb.hp <= 0) continue;
    const d = Math.hypot(v.x - u.x, v.y - u.y);
    if (d < bd) {
      bd = d;
      best = v;
    }
  }
  return best;
}

function enemiesOf(reg: Reg, u: Unit): Unit[] {
  const cb = u.cb!;
  if (cb.side === 'a') {
    const d = reg.def.get(cb.fr) ?? [];
    if (d.length || cb.fr !== 0) return d;
    return reg.civ;
  }
  return reg.atk.get(cb.fr) ?? [];
}

/** подход к точке: прямо, а если упёрлись в препятствие — в обход по найденному пути */
function moveTo(g: Game, u: Unit, tx: number, ty: number, speed: number, dt: number, ice: boolean): boolean {
  const cb = u.cb!;
  if (cb.nav && cb.nav.length) {
    cb.navT -= dt;
    const n = cb.nav[0];
    if (stepUnit(g, u, n.x + 0.5, n.y + 0.5, speed, dt, ice)) cb.nav.shift();
    if (!cb.nav.length || cb.navT <= 0) {
      cb.nav = undefined;
      cb.pd = 1e9;
      cb.pdT = 0;
    }
    return false;
  }
  if (stepUnit(g, u, tx, ty, speed, dt, ice)) return true;
  const d = Math.hypot(tx - u.x, ty - u.y);
  if (d < cb.pd - 0.12) {
    cb.pd = d;
    cb.pdT = 0;
  } else cb.pdT += dt;
  if (cb.pdT > 0.7) {
    cb.pdT = 0;
    cb.pd = 1e9;
    const p = navPath(g, u.x, u.y, tx, ty);
    if (p) {
      cb.nav = p.slice(0, 60);
      cb.navT = 7;
    }
  }
  return false;
}

/** атака: сближение, замах и удар (или выстрел) */
function engage(g: Game, u: Unit, tgt: Unit, chase: boolean, dt: number, ice: boolean) {
  const cb = u.cb!;
  const d = Math.hypot(tgt.x - u.x, tgt.y - u.y);
  if (d > cb.reach) {
    cb.sw = 0;
    cb.hit = false;
    u.swing = 0;
    if (chase) moveTo(g, u, tgt.x, tgt.y + 0.02, FIGHT_SPD, dt, ice);
    else {
      u.moving = false;
      u.phase = 'goto';
    }
    return;
  }
  u.moving = false;
  u.phase = 'work';
  u.fx = tgt.x >= u.x ? 2 : 3;
  u.dir = u.fx;
  cb.sw += dt / cb.cd;
  u.swing = cb.sw;
  if (!cb.hit && cb.sw >= 0.8) {
    cb.hit = true;
    if (cb.kind === 'melee') hurt(g, tgt, cb.dmg * rnd(0.85, 1.15) * (Math.random() < 0.08 ? 1.6 : 1), 3.2, u);
    else fireProj(g, u, tgt);
  }
  if (cb.sw >= 1) {
    cb.sw = 0;
    cb.hit = false;
    u.swing = 0;
  }
}

/** приказы игрока своим воинам в бою */
function orderAI(g: Game, u: Unit, reg: Reg, dt: number, ice: boolean): boolean {
  const o = u.order;
  if (!o) return false;
  const cb = u.cb!;
  if (o.kind === 'move') {
    u.phase = 'goto';
    if (stepUnit(g, u, o.x, o.y, 3.0, dt, ice)) u.order = { kind: 'hold', x: o.x, y: o.y };
    cb.sw = 0;
    return true;
  }
  const foes = enemiesOf(reg, u);
  let tgt: Unit | null = null;
  let chase = false;
  if (o.kind === 'attack' && o.tk === 'foe') {
    tgt = reg.byId.get(o.tid ?? -1) ?? null;
    if (!tgt || !tgt.cb || tgt.cb.hp <= 0 || tgt.cb.team === 0) {
      u.order = { kind: 'hold', x: u.x, y: u.y };
      return true;
    }
    chase = true;
  } else {
    // держим позицию: бьём тех, кто подошёл
    const n = nearest(u, foes);
    if (n && Math.hypot(n.x - u.x, n.y - u.y) <= cb.reach + (cb.kind === 'melee' ? 1.2 : 0)) tgt = n;
  }
  if (!tgt) {
    u.moving = false;
    u.phase = 'goto';
    cb.sw = 0;
    return true;
  }
  engage(g, u, tgt, chase || cb.kind === 'melee', dt, ice);
  return true;
}

function fightAI(g: Game, u: Unit, reg: Reg, dt: number, ice: boolean) {
  const cb = u.cb!;
  if (u.order && cb.team === 0 && orderAI(g, u, reg, dt, ice)) return;
  const foes = enemiesOf(reg, u);
  // трусы с малым здоровьем отступают
  if (u.trait === 'coward' && cb.hp < cb.max * 0.4 && cb.cow < 4) {
    const f = nearest(u, foes);
    if (f && Math.hypot(f.x - u.x, f.y - u.y) < 4) {
      cb.cow += dt;
      stepUnit(g, u, u.x + (u.x - f.x) * 3, u.y + (u.y - f.y) * 3, FIGHT_SPD * 0.85, dt, ice);
      cb.sw = 0;
      return;
    }
  }
  let tgt = cb.tgt ? reg.byId.get(cb.tgt) ?? null : null;
  if (tgt && (!tgt.cb || tgt.cb.hp <= 0 || tgt.cb.side === cb.side)) tgt = null;
  cb.rt -= dt;
  if (!tgt || cb.rt <= 0) {
    tgt = nearest(u, foes);
    cb.rt = 0.4 + Math.random() * 0.35;
    cb.tgt = tgt?.id ?? 0;
  }
  if (cb.side === 'd') {
    // защитники не гонятся за врагом далеко от селения
    const c = fronts.get(cb.fr);
    if (!tgt || (c && Math.hypot(tgt.x - c.x, tgt.y - c.y) > LEASH)) {
      const home = { x: cb.px, y: cb.py };
      if (Math.hypot(home.x - u.x, home.y - u.y) > 0.8) moveTo(g, u, home.x, home.y, FIGHT_SPD * 0.8, dt, ice);
      else {
        u.moving = false;
        u.phase = 'goto';
      }
      cb.sw = 0;
      return;
    }
  }
  if (!tgt) {
    // нападающие идут к центру города
    const c = fronts.get(cb.fr);
    u.moving = false;
    cb.sw = 0;
    if (c && Math.hypot(c.x - u.x, c.y - u.y) > 3) moveTo(g, u, c.x, c.y, FIGHT_SPD * 0.7, dt, ice);
    return;
  }
  engage(g, u, tgt, true, dt, ice);
}

/** центры фронтов на кадр: id города → точка */
let fronts = new Map<number, { x: number; y: number }>();

function fleeAI(g: Game, u: Unit, from: { x: number; y: number }, dt: number, ice: boolean) {
  const cb = u.cb!;
  const dx = u.x - from.x;
  const dy = u.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  if (d > 15 && cb.side === 'd') {
    cb.mode = 'idle';
    u.moving = false;
    return;
  }
  u.phase = 'goto';
  stepUnit(g, u, u.x + (dx / d) * 4, u.y + (dy / d) * 4, FIGHT_SPD * 1.25, dt, ice);
  cb.sw = 0;
}

/* ───────────── Движение по маршруту ───────────── */

function beginLeg(g: Game, c: Campaign, prevSail: boolean) {
  const leg = c.legs![c.li!];
  const squad = c.squad!;
  if (leg.k === 'sail') {
    const p0 = leg.p[0];
    c.ship = { x: p0.x + 0.5, y: p0.y + 0.5, pi: 0 };
    for (const u of squad) {
      if (u.order) continue;
      u.cb!.aboard = true;
      u.cb!.arr = false;
      u.sleeping = true;
      u.moving = false;
    }
    g.sfx('horn', p0.x * TW, p0.y * TH);
    return;
  }
  const p0 = leg.p[0];
  for (const u of squad) {
    const cb = u.cb!;
    if (u.order) continue;
    cb.arr = false;
    cb.stuck = 0;
    if (prevSail || cb.aboard) {
      cb.aboard = false;
      u.sleeping = false;
      u.x = p0.x + 0.5 + rnd(-1.4, 1.4);
      u.y = p0.y + 0.5 + rnd(-1.0, 1.0);
      if (!tileOk(g, u.x, u.y, true)) {
        u.x = p0.x + 0.5;
        u.y = p0.y + 0.5;
      }
      cb.pi = 0;
    } else cb.pi = nearestNode(leg.p, u.x, u.y);
  }
}

/** ведёт отряд по этапам маршрута; true — маршрут пройден */
function advanceLegs(g: Game, c: Campaign, dt: number): boolean {
  const legs = c.legs!;
  const squad = c.squad!;
  const ice = iceOf(g, c);
  const li = c.li ?? 0;
  if (li >= legs.length) return true;
  const leg = legs[li];
  if (leg.k === 'sail') {
    const sh = c.ship;
    if (!sh) {
      beginLeg(g, c, false);
      return false;
    }
    const node = leg.p[sh.pi];
    if (!node) {
      c.li = li + 1;
      c.wait = 0;
      if (c.li < legs.length) beginLeg(g, c, true);
      return c.li >= legs.length;
    }
    const tx = node.x + 0.5;
    const ty = node.y + 0.5;
    const d = Math.hypot(tx - sh.x, ty - sh.y);
    const step = SAIL * marchSpeedK(g) * dt;
    if (d <= step) {
      sh.x = tx;
      sh.y = ty;
      sh.pi++;
    } else {
      sh.x += ((tx - sh.x) / d) * step;
      sh.y += ((ty - sh.y) / d) * step;
    }
    for (const u of squad) if (u.cb!.aboard) {
      u.x = sh.x;
      u.y = sh.y;
    }
    if (Math.random() < dt * 6) g.particles.push({ x: sh.x * TW + rnd(-6, 6), y: sh.y * TH + 3, vx: rnd(-3, 3), vy: -1, life: 0.9, max: 0.9, color: 'rgba(240,248,255,0.8)', size: 2, grav: 0, grow: 3 });
    return false;
  }
  const sp = armySpeed(g, c);
  let free = 0;
  let arrived = 0;
  for (const u of squad) {
    const cb = u.cb!;
    if (cb.aboard || u.order) continue;
    free++;
    if (cb.arr) {
      arrived++;
      u.moving = false;
      continue;
    }
    const node = leg.p[cb.pi];
    if (!node) {
      cb.arr = true;
      arrived++;
      continue;
    }
    const jx = (((u.id * 37) % 7) - 3) * 0.09;
    const jy = (((u.id * 53) % 7) - 3) * 0.09;
    const px = u.x;
    const py = u.y;
    if (stepUnit(g, u, node.x + 0.5 + jx, node.y + 0.5 + jy, sp, dt, ice)) {
      cb.pi++;
      if (cb.pi >= leg.p.length) cb.arr = true;
    }
    if (Math.hypot(u.x - px, u.y - py) < sp * dt * 0.2) {
      cb.stuck += dt;
      if (cb.stuck > 2) {
        u.x = node.x + 0.5;
        u.y = node.y + 0.5;
        cb.stuck = 0;
        cb.pi++;
      }
    } else cb.stuck = 0;
  }
  if (arrived > 0) c.wait = (c.wait ?? 0) + dt;
  if (free === 0) return false;
  if (arrived >= free || (arrived >= free * 0.75 && (c.wait ?? 0) > 2.5) || (c.wait ?? 0) > 6) {
    c.li = li + 1;
    c.wait = 0;
    if (c.li < legs.length) beginLeg(g, c, false);
    else return true;
  }
  return false;
}

/** поворот домой: идут по пройденному маршруту обратно */
function startBack(g: Game, c: Campaign, fled: boolean) {
  const legs = c.legs ?? [];
  const li = Math.min(c.li ?? 0, legs.length - 1);
  const rev = reverseLegs(legs.slice(0, Math.max(0, li) + 1));
  c.legs = rev.length ? rev : legs;
  c.li = 0;
  c.phase = 'back';
  c.fled = fled;
  c.wait = 0;
  const first = c.legs[0];
  const k = kindOf(c);
  const loot = c.loot;
  const lt = loot ? loot.food + loot.wood + loot.stone + loot.gold : 0;
  const big: 'wood' | 'stone' | 'food' = loot && loot.wood > loot.food && loot.wood >= loot.stone ? 'wood' : loot && loot.stone > loot.food ? 'stone' : 'food';
  for (const u of c.squad ?? []) {
    const cb = u.cb!;
    cb.mode = 'march';
    cb.arr = false;
    cb.tgt = 0;
    cb.burn = 0;
    u.order = undefined;
    u.sel = false;
    u.swing = 0;
    cb.sw = 0;
    if (first.k === 'walk') cb.pi = nearestNode(first.p, u.x, u.y);
    if (lt > 0 && k !== 'rival') u.carry = { type: big, n: 1 };
  }
  if (first.k === 'sail' && c.ship) c.ship.pi = Math.max(0, nearestNode(first.p, c.ship.x, c.ship.y));
  if (first.k === 'sail') for (const u of c.squad ?? []) if (!u.cb!.aboard) { u.cb!.aboard = true; u.sleeping = true; }
  void g;
}

/** возвращение отряда игрока домой */
function restoreHome(m: March) {
  for (const u of m.members ?? []) {
    u.cb = undefined;
    u.carry = { type: null, n: 0 };
    u.order = undefined;
    u.sleeping = false;
    u.swing = 0;
    u.hp = 10;
  }
}

/* ───────────── Состояния похода ───────────── */

function enterFight(g: Game, c: Campaign, tg: Tg) {
  ensureSiege(g, tg);
  c.phase = 'fight';
  c.fightT = 0;
  for (const u of c.squad ?? []) {
    const cb = u.cb!;
    cb.fr = tg.id;
    cb.tgt = 0;
    cb.arr = false;
    cb.nav = undefined;
    if (!cb.aboard) cb.mode = 'fight';
  }
  const k = kindOf(c);
  if (k === 'player') {
    g.msg(`Армия подошла к «${tg.t!.name}» — защитники выбегают навстречу! Бой идёт на карте`, 'info');
    g.sfx('horn');
  } else if (k === 'raid') {
    g.msg('Враги у ваших ворот! Стража вступает в бой', 'warn');
    g.sfx('alarm');
    g.life.battleT = 6;
  } else {
    g.sfx('horn', tg.x * TW, tg.y * TH);
  }
}

const aliveDef = (reg: Reg, tg: Tg) => (reg.def.get(tg.id) ?? []).length;

function freeSquad(c: Campaign): Unit[] {
  return (c.squad ?? []).filter((u) => !u.order && !u.cb!.aboard);
}

function ringPos(cx: number, cy: number, i: number, n: number, r: number) {
  const a = (i / Math.max(1, n)) * Math.PI * 2;
  return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * 0.8 };
}

/** взятие центра: бойцы стоят вокруг костра, шкала заполняется 3–5 секунд */
function tickCapture(g: Game, c: Campaign, tg: Tg, dt: number, ice: boolean): boolean {
  const free = freeSquad(c);
  let near = 0;
  free.forEach((u, i) => {
    u.cb!.mode = 'cap';
    const p = ringPos(tg.x, tg.y, i, free.length, 1.5);
    if (moveTo(g, u, p.x, p.y, FIGHT_SPD, dt, ice)) {
      u.moving = false;
      u.phase = 'work';
      u.swing += dt * 0.7; // машут оружием, празднуя
      u.fx = u.x < tg.x ? 2 : 3;
    }
    if (Math.hypot(u.x - tg.x, u.y - tg.y) < 3.2) near++;
  });
  const capTime = 3 + 2 * (1 - Math.min(1, near / 5));
  if (free.length && near >= Math.max(1, Math.ceil(free.length * 0.5))) c.capT = (c.capT ?? 0) + dt / capTime;
  else c.capT = Math.max(0, (c.capT ?? 0) - dt * 0.3);
  if (Math.random() < dt * 5) g.particles.push({ x: tg.x * TW + rnd(-5, 5), y: tg.y * TH - 4, vx: rnd(-2, 2), vy: -8, life: 0.8, max: 0.8, color: teamColor(kindOf(c) === 'player' ? 0 : isRival(c) ? c.from : asMarch(c).townId), size: 1, grav: 0 });
  return (c.capT ?? 0) >= 1;
}

function ignite(g: Game, c: Campaign, t: Town, bid: number, nB: number, u: Unit) {
  const fires = t.fires ?? (t.fires = []);
  if (fires.some((f) => f.id === bid)) return;
  fires.push({ id: bid, t: 16 });
  const s0 = c.stock0 ?? { food: 0, wood: 0, stone: 0, gold: 0 };
  const f = 0.6 / Math.max(1, nB);
  const loot = c.loot!;
  for (const r of ['food', 'wood', 'stone', 'gold'] as const) {
    const take = Math.min(t.stock[r], s0[r] * f);
    t.stock[r] -= take;
    loot[r] += take;
  }
  const b = t.bld.find((q) => q.id === bid);
  if (b) {
    g.floatText((b.x + b.w / 2) * TW, b.y * TH - 4, `🪙+${Math.round(s0.gold * f)}`, '#ffe27a');
    g.floatText((b.x + b.w / 2) * TW + 8, b.y * TH + 4, `🍖+${Math.round(s0.food * f)}`, '#ffd0a0');
  }
  g.sfx('battle', u.x * TW, u.y * TH);
}

/** поджог: каждый воин берёт дом, идёт к двери и поджигает, из горящего дома вылетает добыча */
function tickRaze(g: Game, c: Campaign, t: Town, dt: number, ice: boolean): boolean {
  if (!c.stock0) c.stock0 = { ...t.stock };
  c.razeT = (c.razeT ?? 0) + dt;
  const blds = t.bld.filter((b) => b.type !== 'campfire');
  const burning = new Set((t.fires ?? []).map((f) => f.id));
  const claimed = new Set<number>();
  const free = freeSquad(c);
  for (const u of free) if (u.cb!.burn) claimed.add(u.cb!.burn);
  for (const u of free) {
    const cb = u.cb!;
    cb.mode = 'burn';
    if (!cb.burn) {
      let best: (typeof blds)[number] | null = null;
      let bd = 1e9;
      for (const b of blds) {
        if (burning.has(b.id) || claimed.has(b.id)) continue;
        const d = Math.hypot(b.x + b.w / 2 - u.x, b.y + b.h - u.y);
        if (d < bd) {
          bd = d;
          best = b;
        }
      }
      if (best) {
        cb.burn = best.id;
        cb.burnT = 0;
        claimed.add(best.id);
      }
    }
    const b = cb.burn ? blds.find((q) => q.id === cb.burn) : undefined;
    if (!b) {
      cb.burn = 0;
      const p = ringPos(t.x + 0.5, t.y + 1.5, u.id % 8, 8, 2.2);
      moveTo(g, u, p.x, p.y, FIGHT_SPD, dt, ice);
      continue;
    }
    const dx = b.x + b.w / 2;
    const dy = b.y + b.h + 0.55;
    if (Math.hypot(dx - u.x, dy - u.y) > 0.9) moveTo(g, u, dx, dy, FIGHT_SPD, dt, ice);
    else {
      u.moving = false;
      u.phase = 'work';
      u.fx = dx >= u.x ? 2 : 3;
      cb.burnT += dt;
      u.swing = 0.8 + ((cb.burnT * 1.4) % 0.2);
      if (Math.random() < dt * 10) g.spark(u.x * TW + (u.fx === 2 ? 8 : -8), u.y * TH - 8, '#ffb040');
      if (cb.burnT > 1.1) {
        ignite(g, c, t, b.id, c.stock0 ? blds.length : 1, u);
        cb.burn = 0;
        u.swing = 0;
      }
    }
  }
  const allBurning = blds.every((b) => burning.has(b.id) || (t.fires ?? []).some((f) => f.id === b.id));
  return !blds.length || allBurning || c.razeT > RAZE_MAX;
}

/** налётчики в вашем селении: грабят склад и гоняются за жителями */
function tickRansack(g: Game, c: Campaign, tg: Tg, dt: number): boolean {
  const m = asMarch(c);
  if (c.kl === undefined) {
    const adults = g.units.filter((u) => !u.child && u.spawn <= 0);
    c.kl = Math.min(Math.max(0, adults.length - 2), Math.round((c.startN ?? m.n) * 0.3));
    c.kd = 0;
    const k = 0.25;
    const lost = { food: Math.floor(g.res.food * k), wood: Math.floor(g.res.wood * k), stone: Math.floor(g.res.stone * k), gold: Math.floor(g.res.gold * k) };
    g.res.food -= lost.food;
    g.res.wood -= lost.wood;
    g.res.stone -= lost.stone;
    g.res.gold -= lost.gold;
    c.loot = lost;
    g.msg(`Налётчики грабят селение! Унесено: 🍖${lost.food} 🪵${lost.wood} 🪨${lost.stone} 🪙${lost.gold}`, 'warn');
    for (let i = 0; i < 6; i++) g.floatText(tg.x * TW + rnd(-18, 18), tg.y * TH - rnd(4, 20), i % 2 ? '🪙' : '🍖', '#ffe27a');
    g.sfx('defeat');
  }
  c.razeT = (c.razeT ?? 0) + dt;
  c.kd = (c.kd ?? 0) + civDead;
  civDead = 0;
  // выбираем жертв среди жителей рядом с налётчиками
  const victims = g.units.filter((u) => u.cb?.side === 'c');
  const free = freeSquad(c);
  if (victims.length + (c.kd ?? 0) < (c.kl ?? 0)) {
    for (const r of free) {
      const cand = g.units.filter((u) => !u.child && u.spawn <= 0 && !u.cb && Math.hypot(u.x - r.x, u.y - r.y) < 9).sort((a, b) => Math.hypot(a.x - r.x, a.y - r.y) - Math.hypot(b.x - r.x, b.y - r.y))[0];
      if (cand) {
        cand.cb = newCb({ max: 8, dmg: 0, kind: 'melee', reach: 1, cd: 1 }, { team: 0, side: 'c', fr: 0, src: 'civ' });
        cand.cb.mode = 'flee';
        cand.path = [];
        cand.sleeping = false;
        cand.carry = { type: null, n: 0 };
        victims.push(cand);
        break;
      }
    }
  }
  for (const r of free) r.cb!.mode = 'fight';
  const done = c.razeT > 10 || ((c.kd ?? 0) >= (c.kl ?? 0) && !victims.length && c.razeT > 4);
  return done;
}

/** армия потеряна целиком или сломлена: итоги боя */
function resolveLoss(g: Game, c: Campaign, tg: Tg | null, remain: number) {
  if (c.resolved) return;
  c.resolved = true;
  const k = kindOf(c);
  if (k === 'player') {
    const m = asMarch(c);
    if (tg?.t) outcomeFail(g, m, tg.t, remain);
  } else if (k === 'raid') {
    outcomeRaidRepelled(g, asMarch(c), townById(g, asMarch(c).townId));
  } else {
    const r = c as RivalMarch;
    const A = townById(g, r.from);
    const D = townById(g, r.to);
    if (A && D) rivalDefeat(g, r, A, D);
  }
}

/** отряд пришёл домой / вышел с карты: возвращаем воинов и добычу */
function arrive(g: Game, c: Campaign) {
  const k = kindOf(c);
  const alive = (c.squad ?? []).length;
  if (k === 'player') {
    const m = asMarch(c);
    m.survivors = alive;
    g.army += alive;
    const loot = c.loot!;
    g.res.food += loot.food;
    g.res.wood += loot.wood;
    g.res.stone += loot.stone;
    g.res.gold += loot.gold;
    for (const u of m.members ?? []) {
      u.cb = undefined;
      u.carry = { type: null, n: 0 };
      u.sleeping = false;
      u.order = undefined;
      u.swing = 0;
      u.hp = 10;
    }
    return;
  }
  if (k === 'raid') {
    const t = townById(g, asMarch(c).townId);
    if (t) {
      t.soldiers += alive;
      t.stock.gold += (c.loot?.gold ?? 0) * 0.5;
    }
    return;
  }
  const A = townById(g, (c as RivalMarch).from);
  if (A && A.owner === 'free') A.soldiers += alive;
}

/* ───────────── Главный цикл ───────────── */

function tickArmy(g: Game, c: Campaign, reg: Reg, dt: number): boolean {
  if (!c.squad && !upgradeLegacy(g, c)) return true;
  const squad = c.squad!;
  const k = kindOf(c);
  const tg = targetOf(g, c);
  let ph = c.phase ?? 'go';
  const ice = iceOf(g, c);
  c.n = squad.length;
  if (k !== 'raid' && !isRival(c)) asMarch(c).survivors = squad.length;

  if (ph !== 'back') {
    if (!squad.length) {
      resolveLoss(g, c, tg, 0);
      return true;
    }
    if (!tg) {
      // цель пала или стала вашей — отряд возвращается
      startBack(g, c, false);
      ph = 'back';
    }
  }

  if (ph === 'go' && tg) {
    const done = advanceLegs(g, c, dt);
    const legs = c.legs!;
    const li = c.li ?? 0;
    let near = false;
    if (li >= legs.length - 1 && legs[Math.min(li, legs.length - 1)].k === 'walk') near = squad.some((u) => !u.cb!.aboard && Math.hypot(u.x - tg.x, u.y - tg.y) < TRIG);
    if (done || near) enterFight(g, c, tg);
  } else if (ph === 'fight' && tg) {
    c.fightT = (c.fightT ?? 0) + dt;
    const s = ensureSiege(g, tg);
    s.t += dt;
    const defN = aliveDef(reg, tg);
    // затянувшийся бой: слабейшая сторона не выдерживает
    const stale = (c.fightT ?? 0) > 100;
    if (!s.broken && s.n0 > 0 && (defN / s.n0 < 0.15 || (stale && defN < squad.length))) {
      s.broken = true;
      s.t = 0;
      if (!tg.home) for (const u of tg.t!.folk) if (u.cb && u.cb.side === 'd' && u.cb.mode === 'fight') u.cb.mode = 'flee';
      g.msg(tg.home ? 'Стража обессилела — налётчики прорываются в селение!' : `Защитники «${tg.t!.name}» бегут с поля боя!`, tg.home ? 'warn' : 'good');
    }
    const won = s.broken || defN === 0;
    // армию сломили: меньше 15% бойцов — бегство
    if (!won && (squad.length / (c.startN || 1) < 0.15 || (stale && defN >= squad.length))) {
      resolveLoss(g, c, tg, squad.length);
      if (k === 'player') g.msg(`Отряд разбит и бежит от «${tg.t?.name ?? '?'}» (${squad.length} уцелело)`, 'warn');
      startBack(g, c, true);
    } else if (won) {
      if (k === 'player' && asMarch(c).mode === 'raze') {
        c.phase = 'raze';
        g.msg(`Защитники «${tg.t!.name}» разбиты — воины поджигают дома!`, 'good');
      } else if (k === 'raid') {
        c.phase = 'raze';
        c.razeT = 0;
        c.kl = undefined;
      } else {
        c.phase = 'capture';
        c.capT = 0;
        g.sfx('horn', tg.x * TW, tg.y * TH);
        if (k === 'player') g.msg(`Защитники «${tg.t!.name}» разбиты — захватываем центр!`, 'good');
      }
      for (const u of squad) {
        u.cb!.tgt = 0;
        u.cb!.sw = 0;
      }
    }
  } else if (ph === 'capture' && tg) {
    if (tickCapture(g, c, tg, dt, ice)) {
      c.resolved = true;
      if (k === 'player') outcomeConquer(g, asMarch(c), tg.t!, squad.length);
      else {
        const r = c as RivalMarch;
        const A = townById(g, r.from);
        if (A) rivalVictory(g, r, A, tg.t!, squad.length);
      }
      if (tg.t?.siege) tg.t.siege.broken = true;
      startBack(g, c, false);
    }
  } else if (ph === 'raze' && tg) {
    const fin = k === 'raid' ? tickRansack(g, c, tg, dt) : tickRaze(g, c, tg.t!, dt, ice);
    if (fin) {
      c.resolved = true;
      if (k === 'raid') outcomeRaidPlunder(g, asMarch(c), townById(g, asMarch(c).townId), c.kd ?? 0);
      else {
        c.loot!.gold += 10 + tg.t!.pop;
        outcomeRaze(g, asMarch(c), tg.t!, squad.length, c.loot!);
      }
      startBack(g, c, false);
    }
  } else if (ph === 'back') {
    if (advanceLegs(g, c, dt)) {
      arrive(g, c);
      return true;
    }
  }

  // прогресс для интерфейса
  const legs = c.legs ?? [];
  const total = legs.reduce((s, l) => s + l.p.length, 0) || 1;
  const li = Math.min(c.li ?? 0, legs.length - 1);
  let done = 0;
  for (let i = 0; i < li; i++) done += legs[i].p.length;
  const cur = legs[li];
  if (cur) {
    const idx = cur.k === 'sail' ? c.ship?.pi ?? 0 : Math.max(0, ...squad.filter((u) => !u.order).map((u) => u.cb!.pi), 0);
    done += Math.min(cur.p.length, idx);
  }
  const route = clamp(done / total, 0, 1);
  const phase = c.phase ?? 'go';
  c.prog = phase === 'go' ? route : phase === 'back' ? route : phase === 'capture' ? clamp(c.capT ?? 0, 0, 1) : phase === 'raze' ? clamp((c.razeT ?? 0) / (k === 'raid' ? 10 : RAZE_MAX), 0, 1) : 1;
  return false;
}

function sepPass(reg: Reg) {
  const list = reg.all.filter((u) => u.cb!.mode === 'fight' || u.cb!.mode === 'cap' || u.cb!.mode === 'burn');
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) continue;
      const d = Math.hypot(dx, dy);
      if (d >= 0.5) continue;
      const push = (0.5 - d) * 0.35;
      const nx = d > 0.01 ? dx / d : Math.random() - 0.5;
      const ny = d > 0.01 ? dy / d : Math.random() - 0.5;
      a.cb!.sepx -= nx * push;
      a.cb!.sepy -= ny * push;
      b.cb!.sepx += nx * push;
      b.cb!.sepy += ny * push;
    }
  }
}

function applySep(g: Game, reg: Reg) {
  for (const u of reg.all) {
    const cb = u.cb;
    if (!cb || (!cb.sepx && !cb.sepy)) continue;
    const nx = u.x + cb.sepx;
    const ny = u.y + cb.sepy;
    if (tileOk(g, nx, ny, false)) {
      u.x = nx;
      u.y = ny;
    }
    cb.sepx = 0;
    cb.sepy = 0;
  }
}

function step(g: Game, dt: number) {
  const reg = collect(g);
  // центры фронтов
  fronts = new Map();
  fronts.set(0, campGate(g));
  for (const t of g.towns) fronts.set(t.id, townGate(t));

  // осадное орудие игрока: катапульты швыряют камни в защитников
  const cats = Math.min(4, itemCount(g, 'catapult'));

  for (const m of [...g.marches]) {
    if (!g.marches.includes(m)) continue;
    if (tickArmy(g, m, reg, dt)) {
      if (!m.incoming) restoreGuardsFor(g, m);
      const i = g.marches.indexOf(m);
      if (i >= 0) g.marches.splice(i, 1);
    } else if (!m.incoming && cats > 0 && m.phase === 'fight') {
      m.catT = (m.catT ?? 0) - dt;
      if (m.catT <= 0) {
        m.catT = 4.2 / cats;
        const foes = reg.def.get(m.townId) ?? [];
        if (foes.length && m.squad?.length) {
          const t = foes[Math.floor(Math.random() * foes.length)];
          const sx = m.squad.reduce((s, u) => s + u.x, 0) / m.squad.length;
          const sy = m.squad.reduce((s, u) => s + u.y, 0) / m.squad.length;
          const d = Math.hypot(t.x - sx, t.y - sy) || 1;
          fireRock(g, { x: sx - ((t.x - sx) / d) * 3, y: sy - ((t.y - sy) / d) * 3 }, t, 5.5 * atkMult(g), 0, m.townId);
        }
      }
    }
  }
  const X = g.ext;
  if (X) {
    for (const r of [...X.rivalMarches]) {
      if (!X.rivalMarches.includes(r)) continue;
      if (tickArmy(g, r, reg, dt)) {
        const i = X.rivalMarches.indexOf(r);
        if (i >= 0) X.rivalMarches.splice(i, 1);
      }
    }
  }

  // бойцы (те, кто вернулся домой в этом кадре, уже без боевого состояния)
  reg.all = reg.all.filter((u) => !!u.cb);
  const reg2 = reg;
  for (const u of reg2.all) {
    const cb = u.cb;
    if (!cb || cb.hp <= 0) continue;
    cb.hurt = Math.max(0, cb.hurt - dt);
    // отбрасывание
    if (Math.abs(cb.kx) + Math.abs(cb.ky) > 0.05) {
      const nx = u.x + cb.kx * dt;
      const ny = u.y + cb.ky * dt;
      if (tileOk(g, nx, ny, true)) {
        u.x = nx;
        u.y = ny;
      }
      const f = Math.exp(-9 * dt);
      cb.kx *= f;
      cb.ky *= f;
    }
    const ice = !tileOk(g, u.x, u.y, false);
    if (cb.side === 'c') {
      // мирные бегут от налётчиков
      const foe = nearest(u, reg2.atk.get(0) ?? []);
      if (foe && Math.hypot(foe.x - u.x, foe.y - u.y) < 8) stepUnit(g, u, u.x + (u.x - foe.x) * 2, u.y + (u.y - foe.y) * 2, 2.9, dt, false);
      else u.moving = false;
      continue;
    }
    if (cb.mode === 'march' && u.order && cb.team === 0) orderAI(g, u, reg2, dt, ice);
    else if (cb.mode === 'fight') fightAI(g, u, reg2, dt, ice);
    else if (cb.mode === 'flee') {
      const c = fronts.get(cb.fr) ?? { x: u.x, y: u.y };
      fleeAI(g, u, c, dt, false);
    }
  }

  sepPass(reg2);
  applySep(g, reg2);
  for (const u of reg2.all) if (u.moving) footFx(g, u, dt);

  updateProj(g, reg2, dt);

  // смерти
  for (const u of reg2.all) if (u.cb && u.cb.hp <= 0) kill(g, u);

  // завершённые осады
  const engaged = new Set<number>();
  for (const c of allArmies(g)) {
    const ph = c.phase ?? 'go';
    if (ph === 'fight' || ph === 'capture' || ph === 'raze') {
      const tg = targetOf(g, c);
      if (tg) engaged.add(tg.id);
    }
  }
  if (g.ext.homeSiege?.on && !engaged.has(0)) releaseSiege(g, { home: true });
  for (const t of g.towns) if (t.siege?.on && !engaged.has(t.id)) releaseSiege(g, { home: false, t });
  if (engaged.has(0)) g.life.battleT = Math.max(g.life.battleT, 2);
}

function restoreGuardsFor(g: Game, m: March) {
  const n = (m.members ?? []).length;
  if (n > 0) {
    restoreGuards(g, m, n);
    const loot = m.loot;
    const gold = loot ? Math.round(loot.gold) : 0;
    g.msg(`Армия вернулась домой (${n})${loot && loot.food + loot.wood + loot.stone + loot.gold > 0 ? ` с добычей: 🍖${Math.round(loot.food)} 🪵${Math.round(loot.wood)} 🪨${Math.round(loot.stone)} 🪙${gold}` : ''}`, 'info');
  }
}

/** горящие дома: огонь, дым и угли, потом пепелище */
function tickFires(g: Game, dt: number) {
  for (const t of g.towns) {
    if (!t.fires?.length) continue;
    for (let i = t.fires.length - 1; i >= 0; i--) {
      const f = t.fires[i];
      f.t -= dt;
      const b = t.bld.find((q) => q.id === f.id);
      if (f.t <= 0 || !b) {
        t.fires.splice(i, 1);
        if (b) addAsh(g, b.x + b.w / 2, b.y + b.h, 2, 1);
        continue;
      }
      const x = (b.x + b.w / 2) * TW;
      const y = (b.y + b.h) * TH;
      if (Math.random() < dt * 14) g.particles.push({ x: x + rnd(-b.w * 6, b.w * 6), y: y - rnd(4, 18), vx: rnd(-2, 2), vy: -14 - Math.random() * 8, life: 0.8, max: 0.8, color: Math.random() < 0.5 ? '#ff7a2a' : '#ffd060', size: 2, grav: 0 });
      if (Math.random() < dt * 6) g.particles.push({ x: x + rnd(-b.w * 5, b.w * 5), y: y - 22, vx: 2 + Math.random() * 3, vy: -9 - Math.random() * 5, life: 2.4, max: 2.4, color: 'rgba(60,58,66,0.7)', size: 3, grav: 0, grow: 5 });
    }
  }
}

export function battleUpdate(g: Game, dt: number) {
  if (g.mode !== 'play') return;
  tickFires(g, dt);
  if (projFor !== g || g.time < projT) {
    PROJ = [];
    projFor = g;
  }
  projT = g.time;
  if (!g.marches.length && !(g.ext?.rivalMarches.length) && !PROJ.length) {
    return;
  }
  const n = clamp(Math.ceil(dt / 0.05), 1, 6);
  for (let i = 0; i < n; i++) step(g, dt / n);
}

/* ───────────── Для интерфейса и других систем ───────────── */

export function campaignPos(c: Campaign): { x: number; y: number } | null {
  const s = c.squad;
  if (!s || !s.length) return null;
  let x = 0;
  let y = 0;
  for (const u of s) {
    x += u.x;
    y += u.y;
  }
  return { x: x / s.length, y: y / s.length };
}

/** отвод армии игрока: бойцы поворачивают домой (приказы сбрасываются) */
export function recallArmy(g: Game, id: number): string | null {
  const m = g.marches.find((q) => q.id === id && !q.incoming);
  if (!m || !m.squad) return 'Поход не найден';
  if (m.phase === 'back') return 'Армия уже возвращается';
  m.resolved = true;
  startBack(g, m, true);
  m.phase = 'back';
  g.msg(`Армия отходит от «${townById(g, m.townId)?.name ?? '?'}» (${m.squad.length})`, 'info');
  g.sfx('horn');
  return null;
}

export function marchInfo(g: Game, c: Campaign): { x: number; y: number; foes: number } {
  const p = campaignPos(c) ?? { x: 0, y: 0 };
  const tg = targetOf(g, c);
  let foes = 0;
  if (tg) {
    if (tg.home) foes = 0;
    else foes = tg.t!.folk.filter((u) => u.cb?.side === 'd' && u.cb.hp > 0).length;
  }
  return { x: p.x, y: p.y, foes };
}
