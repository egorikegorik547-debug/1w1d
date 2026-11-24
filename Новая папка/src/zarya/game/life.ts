import { B, BUILDINGS, DAY_LENGTH, FOOD, TH, TW, isEatSpotType, mealSlotAt, type BuildingId } from './data';
import type { Obj } from './worldgen';
import type { Building, Game, Unit } from './game';
import type { Mods } from './techs';
import type { March } from './towns';
import { battleFoeAt, foeById } from './battle';
import { DIFFS, isStateOwner } from './social';
import { chron, generationOf } from './extstate';
import { randomLook } from './sprites';
import { addShields } from './history';
import { isWinter } from './seasons';
import { CRAFT_BUILDINGS, FAMILY_NAMES, ITEMS, KNIGHT_NAMES, RECIPES, RECIPE_BY_ID, SMITH_NAMES, TRAITS, WITCH_NAMES, randomTrait, type Recipe, type Trait, type VisitorKind, VISITORS } from './lifeData';

/* ───────────── Типы состояния ───────────── */

export interface Gear {
  weapon: string | null;
  armor: string | null;
  shield: boolean;
  horse: boolean;
}

export interface Person {
  id: number;
  name: string;
  fam: number;
  trait: Trait;
  female: boolean;
  born: number;
  alive: boolean;
  role: 'child' | 'worker' | 'soldier' | 'hunter';
  parents: number[];
  log: { t: number; text: string }[];
  died?: number;
  cause?: string;
  hero?: boolean;
  buried?: boolean;
}
export interface Family {
  id: number;
  name: string;
  founded: number;
}
export interface Grave {
  id: number;
  pid: number;
  name: string;
  fam: number;
  hero: boolean;
  cause: string;
  cem: number;
  slot: number;
  t: number;
}
export interface Animal {
  id: number;
  kind: 'wolf' | 'bear' | 'deer';
  x: number;
  y: number;
  hx: number;
  hy: number;
  hp: number;
  maxhp: number;
  dir: number;
  anim: number;
  state: 'roam' | 'chase' | 'flee' | 'rest';
  tx: number;
  ty: number;
  wait: number;
  target: number;
  atkT: number;
  moving: boolean;
  /** голод хищника 0..1 — только голодные выходят к окраинам ночью/зимой */
  hun?: number;
  /** хищник вышел на ночной/зимний «промысел» к окраине деревни */
  raid?: boolean;
  /** секунд страха: зверь убегает в лес (рычит) */
  scare?: number;
  /** пауза, пока зверь не вернётся к окраине после испуга */
  cool?: number;
  /** тревога: хищник ближе 8 клеток к зданию (оставшееся время) */
  alarm?: number;
  /** точка набега и здание-цель */
  rx?: number;
  ry?: number;
  rb?: number;
  rT?: number;
  rSteal?: number;
  /** маршрут обхода препятствий (центры клеток) */
  pth?: { x: number; y: number }[];
  pk?: number;
  stuck?: number;
}
export interface Raider {
  unit: Unit;
  kind: 'thief' | 'bandit';
  hp: number;
  state: 'sneak' | 'steal' | 'flee';
  bid: number;
  t: number;
  loot: { k: 'gold' | 'goods' | 'food' | 'wood' | 'stone'; n: number } | null;
  sx: number;
  sy: number;
}
export type Need = Record<string, number>;
export interface Reward {
  gold?: number;
  goods?: number;
  food?: number;
  wood?: number;
  stone?: number;
  atk?: number;
  work?: number;
  birth?: number;
  craft?: number;
  child?: number;
  memory?: number;
}
export interface QuestDef {
  id: string;
  title: string;
  text: string;
  kind: 'bring' | 'kill';
  need: Need;
  kill: number;
  reward: Reward;
  rewardText: string;
}
export interface Offer {
  id: string;
  label: string;
  desc: string;
  cost: Need;
}
export interface Visitor {
  id: number;
  kind: VisitorKind;
  name: string;
  unit: Unit;
  state: 'arrive' | 'wait' | 'leave';
  timer: number;
  quest: { def: QuestDef; accepted: boolean; killBase: number; done: boolean } | null;
  used: Record<string, boolean>;
  tx: number;
  ty: number;
}
export interface Claim {
  id: number;
  x: number;
  y: number;
  r: number;
  owner: number;
  t: number;
}
export interface ProdState {
  queue: { recipe: string; n: number }[];
  progress: number;
  started: boolean;
  staff: number[];
  status: string;
}
export interface LifeEvent {
  t: number;
  text: string;
  kind: 'info' | 'good' | 'warn';
}

export interface LifeState {
  items: Record<string, number>;
  people: Map<number, Person>;
  families: Map<number, Family>;
  follow: number | null;
  graves: Grave[];
  fallen: number[];
  memory: number;
  animals: Animal[];
  raiders: Raider[];
  visitors: Visitor[];
  claims: Claim[];
  prod: Record<number, ProdState>;
  buffs: { atk: number; work: number; birth: number; craft: number };
  kills: number;
  thefts: number;
  caught: number;
  events: LifeEvent[];
  sleepTime: boolean;
  evening: boolean;
  wasNight: boolean;
  visitT: number;
  animalT: number;
  botT: Record<number, number>;
  battleT: number;
  modsT: number;
  gearT: number;
  slowT: number;
  heroes: string[];
  idc: number;
  moraleBonus: number;
}

export function createLife(): LifeState {
  return {
    items: {},
    people: new Map(),
    families: new Map(),
    follow: null,
    graves: [],
    fallen: [],
    memory: 0,
    animals: [],
    raiders: [],
    visitors: [],
    claims: [],
    prod: {},
    buffs: { atk: 0, work: 0, birth: 0, craft: 0 },
    kills: 0,
    thefts: 0,
    caught: 0,
    events: [],
    sleepTime: false,
    evening: false,
    wasNight: false,
    visitT: 150,
    animalT: 60,
    botT: {},
    battleT: 0,
    modsT: 0,
    gearT: 0,
    slowT: 0,
    heroes: [],
    idc: 1,
    moraleBonus: 0,
  };
}

/* ───────────── Утилиты ───────────── */

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const dayNo = (g: Game) => Math.floor(g.time / DAY_LENGTH) + 1;
const hourOf = (g: Game) => g.dayT * 24;

function validTile(g: Game, x: number, y: number) {
  const w = g.world;
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 1 || ty < 1 || tx >= w.w - 1 || ty >= w.h - 1) return false;
  const i = ty * w.w + tx;
  return !w.blocked[i] && w.biome[i] > B.WATER;
}

interface Mover {
  x: number;
  y: number;
  dir: number;
  fx?: number;
  anim: number;
  moving: boolean;
}

/** шаг к точке по прямой с обходом препятствий по осям; true — дошёл */
function stepTo(g: Game, m: Mover, tx: number, ty: number, speed: number, dt: number): boolean {
  const dx = tx - m.x;
  const dy = ty - m.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.25) {
    m.moving = false;
    return true;
  }
  const step = Math.min(dist, speed * dt);
  const nx = m.x + (dx / dist) * step;
  const ny = m.y + (dy / dist) * step;
  let moved = false;
  if (validTile(g, nx, ny)) {
    m.x = nx;
    m.y = ny;
    moved = true;
  } else if (validTile(g, nx, m.y)) {
    m.x = nx;
    moved = true;
  } else if (validTile(g, m.x, ny)) {
    m.y = ny;
    moved = true;
  }
  if (Math.abs(dx) > Math.abs(dy) * 0.9) {
    m.dir = dx > 0 ? 2 : 3;
    if (m.fx !== undefined) m.fx = m.dir;
  } else m.dir = dy > 0 ? 0 : 1;
  m.anim += dt * speed * 1.7;
  m.moving = moved;
  return false;
}

export function lifeEvent(g: Game, text: string, kind: LifeEvent['kind'] = 'info') {
  const L = g.life;
  L.events.unshift({ t: g.time, text, kind });
  if (L.events.length > 40) L.events.pop();
}

function homesOf(g: Game): Building[] {
  return g.buildings.filter((b) => b.done && BUILDINGS[b.type].housing > 0);
}

function doorOf(b: Building) {
  return { x: b.x + b.w / 2, y: b.y + b.h + 0.4 };
}

function nearestBuilding(list: Building[], x: number, y: number): Building | null {
  let best: Building | null = null;
  let bd = 1e9;
  for (const b of list) {
    const d = Math.hypot(b.x + b.w / 2 - x, b.y + b.h / 2 - y);
    if (d < bd) {
      bd = d;
      best = b;
    }
  }
  return best;
}

function campPos(g: Game) {
  const c = g.buildings[0];
  return c ? { x: c.x + c.w / 2, y: c.y + c.h + 0.5 } : { x: g.world.startX + 1, y: g.world.startY + 3 };
}

/* ───────────── Династии ───────────── */

export function personName(g: Game, id: number): string {
  const p = g.life.people.get(id);
  if (!p) return '—';
  const f = g.life.families.get(p.fam);
  return `${p.name}${f ? ' ' + f.name : ''}`;
}

export function personLog(g: Game, id: number, text: string) {
  const p = g.life.people.get(id);
  if (!p) return;
  p.log.push({ t: g.time, text });
  if (p.log.length > 30) p.log.shift();
}

function newFamily(g: Game): Family {
  const L = g.life;
  const used = new Set([...L.families.values()].map((f) => f.name));
  const free = FAMILY_NAMES.filter((n) => !used.has(n));
  const name = (free.length ? free : FAMILY_NAMES)[Math.floor(Math.random() * (free.length || FAMILY_NAMES.length))];
  const f: Family = { id: L.idc++, name, founded: g.time };
  L.families.set(f.id, f);
  return f;
}

/** регистрирует жителя в книге родов */
export function registerPerson(g: Game, u: Unit, parents: number[], famId?: number) {
  const L = g.life;
  let fam = famId;
  if (!fam) {
    const fs = [...L.families.values()];
    if (fs.length === 0 || (fs.length === 1 && L.people.size >= 3)) fam = newFamily(g).id;
    else fam = fs[Math.floor(Math.random() * fs.length)].id;
  }
  u.fam = fam;
  const p: Person = { id: u.id, name: u.name, fam, trait: u.trait, female: u.look.female, born: g.time, alive: true, role: u.child ? 'child' : 'worker', parents, log: [], };
  L.people.set(u.id, p);
  personLog(g, u.id, u.child ? `Родился${u.look.female ? 'ась' : ''} в поселении` : `Пришёл${u.look.female ? 'а' : ''} с племенем на новые земли`);
}

export function lifeStart(g: Game) {
  for (const u of g.units) registerPerson(g, u, []);
}

export function lifeBirth(g: Game, u: Unit) {
  const adults = g.units.filter((q) => !q.child && q.spawn <= 0 && g.life.people.has(q.id));
  if (!adults.length) {
    registerPerson(g, u, []);
    return;
  }
  // добряки чаще становятся родителями
  const pool = adults.flatMap((a) => (a.trait === 'kind' ? [a, a] : [a]));
  const p1 = pool[Math.floor(Math.random() * pool.length)];
  const mates = adults.filter((a) => a.look.female !== p1.look.female && a.fam === p1.fam);
  const p2 = mates.length ? mates[Math.floor(Math.random() * mates.length)] : null;
  registerPerson(g, u, p2 ? [p1.id, p2.id] : [p1.id], p1.fam);
  if (Math.random() < 0.55 && p1.trait !== 'kind') u.trait = p1.trait;
  const person = g.life.people.get(u.id);
  if (person) person.trait = u.trait;
  const gen = generationOf(g, u.id);
  const fam = g.life.families.get(p1.fam);
  const seen = g.ext.genSeen;
  if (gen >= 2 && gen > seen) {
    g.ext.genSeen = gen;
    chron(g, `В роду ${fam?.name ?? ''} родилось ${gen}-е поколение: ${u.name}`, 'good');
  }
}

/** смерть жителя (или воина) — записывается в судьбу семьи */
export function killPerson(g: Game, u: Unit, cause: string, hero = false) {
  const L = g.life;
  const i = g.units.indexOf(u);
  if (i >= 0) g.units.splice(i, 1);
  const gi = g.guards.indexOf(u);
  if (gi >= 0) g.guards.splice(gi, 1);
  const p = L.people.get(u.id);
  g.msg(`${u.name}${p ? ' ' + (L.families.get(p.fam)?.name ?? '') : ''} ${cause}`, 'warn');
  if (hero || (p && p.hero)) chron(g, `${u.name}${p ? ' ' + (L.families.get(p.fam)?.name ?? '') : ''} ${cause}`, 'death');
  if (p) {
    p.alive = false;
    p.died = g.time;
    p.cause = cause;
    p.hero = hero || p.role === 'soldier';
    personLog(g, p.id, `Погиб${p.female ? 'ла' : ''}: ${cause}`);
    L.fallen.push(p.id);
    lifeEvent(g, `${personName(g, p.id)} — ${cause}`, 'warn');
  }
  for (let k = 0; k < 6; k++) g.spark(u.x * TW, u.y * TH - 8, '#c8c8d8');
}

export function cemeteries(g: Game): Building[] {
  return g.buildings.filter((b) => b.done && b.type === 'cemetery');
}
export const GRAVES_PER_CEMETERY = 12;

export function buryFallen(g: Game, pid: number): string | null {
  const L = g.life;
  const p = L.people.get(pid);
  if (!p || p.buried || p.alive) return 'Некого хоронить';
  const cems = cemeteries(g);
  if (!cems.length) return 'Постройте кладбище';
  const cem = cems.find((c) => L.graves.filter((q) => q.cem === c.id).length < GRAVES_PER_CEMETERY);
  if (!cem) return 'На кладбищах нет мест — стройте новое';
  if (g.res.wood < 4 || g.res.gold < 3) return 'Нужно 4 дерева и 3 золота';
  g.spend('wood', 4);
  g.spend('gold', 3);
  const slot = L.graves.filter((q) => q.cem === cem.id).length;
  L.graves.push({ id: L.idc++, pid, name: p.name, fam: p.fam, hero: !!p.hero, cause: p.cause ?? '', cem: cem.id, slot, t: g.time });
  p.buried = true;
  L.fallen = L.fallen.filter((x) => x !== pid);
  L.memory = Math.min(60, L.memory + (p.hero ? 6 : 3));
  personLog(g, pid, 'Похоронен на кладбище со всеми почестями');
  for (let k = 0; k < 10; k++) g.spark(cem.x * TW + cem.w * 8, (cem.y + cem.h) * TH - 6, '#e8e0ff');
  g.msg(`${personName(g, pid)} похоронен${p.female ? 'а' : ''} на кладбище. Память о героях крепит боевой дух`, 'good');
  lifeEvent(g, `Похороны: ${personName(g, pid)}`, 'good');
  g.sfx('built');
  return null;
}

/* ───────────── Предметы, производство ───────────── */

export function itemCount(g: Game, id: string) {
  return Math.floor(g.life.items[id] ?? 0);
}

function stockOf(g: Game, k: string): number {
  if (k in ITEMS) return g.life.items[k] ?? 0;
  return (g.res as Record<string, number>)[k] ?? 0;
}

export function canPayRecipe(g: Game, r: Recipe) {
  for (const k of Object.keys(r.in)) if (stockOf(g, k) < r.in[k]) return false;
  return true;
}
function payRecipe(g: Game, r: Recipe) {
  for (const k of Object.keys(r.in)) {
    if (k in ITEMS) g.life.items[k] = (g.life.items[k] ?? 0) - r.in[k];
    else g.spend(k as 'wood', r.in[k]);
  }
}

export function recipeOpen(g: Game, r: Recipe) {
  return g.done.has(r.tech);
}

export function prodOf(g: Game, bid: number): ProdState {
  let p = g.life.prod[bid];
  if (!p) {
    p = { queue: [], progress: 0, started: false, staff: [], status: 'Нет заказов' };
    g.life.prod[bid] = p;
  }
  return p;
}

export function queueCraft(g: Game, bid: number, recipe: string, n: number): string | null {
  const b = g.buildings.find((q) => q.id === bid);
  const r = RECIPE_BY_ID[recipe];
  if (!b || !b.done || !r || r.bld !== b.type) return 'Здесь это не делают';
  if (!recipeOpen(g, r)) return 'Рецепт ещё не открыт технологией';
  const P = prodOf(g, bid);
  const ex = P.queue.find((q) => q.recipe === recipe);
  if (ex) ex.n = Math.min(99, ex.n + n);
  else P.queue.push({ recipe, n });
  return null;
}

export function clearQueue(g: Game, bid: number, recipe?: string) {
  const P = g.life.prod[bid];
  if (!P) return;
  if (recipe) {
    const i = P.queue.findIndex((q) => q.recipe === recipe);
    if (i === 0 && P.started) {
      // сырьё уже потрачено — доделаем текущую вещь
      P.queue[0].n = 1;
    } else if (i >= 0) P.queue.splice(i, 1);
  } else {
    P.queue = P.started && P.queue.length ? [{ ...P.queue[0], n: 1 }] : [];
  }
}

function staffBuildings(g: Game) {
  const L = g.life;
  for (const b of g.buildings) {
    if (!b.done || !CRAFT_BUILDINGS.includes(b.type)) continue;
    const P = prodOf(g, b.id);
    P.staff = P.staff.filter((id) => {
      const u = g.units.find((q) => q.id === id);
      return !!u && u.task.type === 'craft' && u.task.site === b.id;
    });
    const slots = BUILDINGS[b.type].jobs ?? 2;
    if (P.queue.length && !L.sleepTime) {
      while (P.staff.length < slots) {
        let best: Unit | null = null;
        let bd = 1e9;
        for (const u of g.units) {
          if (u.child || u.spawn > 0 || u.sleeping || u.status !== 'free' || u.role !== 'none' || u.task.type !== 'idle' || u.visit || (u.flee ?? 0) > 0) continue;
          const d = Math.hypot(u.x - b.x, u.y - b.y);
          if (d < bd) {
            bd = d;
            best = u;
          }
        }
        if (!best) break;
        g.setTask(best, { type: 'craft', tx: 0, ty: 0, site: b.id, auto: true });
        P.staff.push(best.id);
      }
      if (!P.staff.length) P.status = 'Нет свободных работников';
    } else if (!P.queue.length) {
      for (const id of P.staff) {
        const u = g.units.find((q) => q.id === id);
        if (u && u.task.type === 'craft') g.setIdle(u);
      }
      P.staff = [];
      P.status = 'Нет заказов';
      P.started = false;
      P.progress = 0;
    }
  }
  // уничтоженные здания
  for (const k of Object.keys(L.prod)) if (!g.buildings.some((b) => b.id === Number(k))) delete L.prod[Number(k)];
}

export function traitWork(g: Game, u: Unit): number {
  let k = 1;
  if (u.trait === 'worker') k *= 1.25;
  else if (u.trait === 'drunkard') k *= 0.8;
  if (g.life.buffs.work > 0) k *= 1.2;
  // голодный (сытость < 25%) работает на 20% медленнее
  k *= g.hungerK(u);
  return k;
}

export function lifeCraft(g: Game, u: Unit, dt: number) {
  const b = g.buildings.find((x) => x.id === u.task.site);
  const P = b ? g.life.prod[b.id] : undefined;
  if (!b || !b.done || !P || !P.queue.length) {
    g.setIdle(u);
    return;
  }
  if (!g.adjRect(u, b)) {
    u.phase = 'goto';
    if (!g.pathToRect(u, b)) {
      g.setIdle(u);
      u.wander = 4;
    }
    return;
  }
  u.phase = 'work';
  g.faceTo(u, b.x + b.w / 2, 0);
  u.swing += dt * 1.7;
  const job = P.queue[0];
  const rec = RECIPE_BY_ID[job.recipe];
  if (!rec) {
    P.queue.shift();
    return;
  }
  if (!P.started) {
    if (!canPayRecipe(g, rec)) {
      P.status = 'Не хватает сырья';
      return;
    }
    payRecipe(g, rec);
    P.started = true;
    P.progress = 0;
  }
  P.status = 'Работают';
  P.progress += dt * traitWork(g, u) * (g.life.buffs.craft > 0 ? 1.6 : 1) * (g.mods.prod > 1 ? 1 + (g.mods.prod - 1) * 0.5 : 1);
  if (Math.random() < dt * 3) g.spark(b.x * TW + b.w * 8 + rnd(-6, 6), (b.y + b.h) * TH - 6, rec.bld === 'forge' ? '#ffb040' : '#e8d8b0');
  if (P.progress >= rec.time) {
    P.progress = 0;
    P.started = false;
    g.life.items[rec.item] = (g.life.items[rec.item] ?? 0) + rec.out;
    g.stats.goods += 0;
    job.n--;
    g.floatText(b.x * TW + b.w * 8, b.y * TH, `+${ITEMS[rec.item].icon}`, '#ffe9a8');
    g.sfx('hammer', u.x * TW, u.y * TH);
    if (job.n <= 0) {
      P.queue.shift();
      g.msg(`Готово: ${ITEMS[rec.item].name} (в запасе ${itemCount(g, rec.item)})`, 'good');
    }
    g.refreshMods();
  }
}

/* ───────────── Воины: стража в деревне ───────────── */

export const WEAPON_ORDER = ['musket', 'steel_sword', 'iron_sword', 'crossbow', 'bronze_sword', 'bow', 'spear', 'club'];
const ARMOR_ORDER = ['chainmail', 'leather'];

export function bestWeaponInStock(g: Game): string | null {
  for (const w of WEAPON_ORDER) if ((g.life.items[w] ?? 0) >= 1) return w;
  return null;
}

/** оружие, которого нет в мастерских, но которым вооружены чужие воины (секира) */
const FOREIGN_POW: Record<string, number> = { waraxe: 0.5 };

export function weaponPow(id: string | null) {
  return id ? ITEMS[id]?.pow ?? FOREIGN_POW[id] ?? 0 : 0;
}

export function gearPow(u: Unit): number {
  const gr = u.gear;
  let p = 1;
  if (gr) p += weaponPow(gr.weapon) + (gr.armor ? (ITEMS[gr.armor].pow ?? 0) * 0.8 : 0) + (gr.shield ? 0.12 : 0) + (gr.horse ? 0.5 : 0);
  if (u.hero) p += 1.2;
  if (u.trait === 'brave') p *= 1.25;
  else if (u.trait === 'coward') p *= 0.7;
  return p;
}

function emptyGear(): Gear {
  return { weapon: null, armor: null, shield: false, horse: false };
}

/** выдаёт воину лучшее снаряжение из запасов; true — что-то изменилось */
function equip(g: Game, u: Unit): boolean {
  const L = g.life;
  if (!u.gear) u.gear = emptyGear();
  const gr = u.gear;
  let changed = false;
  const cur = gr.weapon ? WEAPON_ORDER.indexOf(gr.weapon) : 99;
  for (const w of WEAPON_ORDER) {
    const idx = WEAPON_ORDER.indexOf(w);
    if (idx >= cur) break;
    if ((L.items[w] ?? 0) >= 1) {
      if (gr.weapon) L.items[gr.weapon] = (L.items[gr.weapon] ?? 0) + 1;
      L.items[w]--;
      gr.weapon = w;
      changed = true;
      break;
    }
  }
  const curA = gr.armor ? ARMOR_ORDER.indexOf(gr.armor) : 99;
  for (const a of ARMOR_ORDER) {
    const idx = ARMOR_ORDER.indexOf(a);
    if (idx >= curA) break;
    if ((L.items[a] ?? 0) >= 1) {
      if (gr.armor) L.items[gr.armor] = (L.items[gr.armor] ?? 0) + 1;
      L.items[a]--;
      gr.armor = a;
      changed = true;
      break;
    }
  }
  if (!gr.shield && (L.items.shield ?? 0) >= 1) {
    L.items.shield--;
    gr.shield = true;
    changed = true;
  }
  if (!gr.horse && (L.items.horse ?? 0) >= 1) {
    L.items.horse--;
    gr.horse = true;
    changed = true;
  }
  return changed;
}

/** обычный житель становится воином — и остаётся ходить по деревне */
export function enlist(g: Game, u: Unit): boolean {
  const L = g.life;
  const w = bestWeaponInStock(g);
  if (!w) return false;
  const i = g.units.indexOf(u);
  if (i >= 0) g.units.splice(i, 1);
  u.role = 'soldier';
  u.task = { type: 'idle', tx: 0, ty: 0, site: 0, auto: false };
  u.path = [];
  u.sel = false;
  u.sleeping = false;
  u.gear = emptyGear();
  u.wander = rnd(0, 3);
  u.carry = { type: null, n: 0 };
  g.guards.push(u);
  equip(g, u);
  const p = L.people.get(u.id);
  if (p) {
    p.role = 'soldier';
    personLog(g, u.id, `Вступил${p.female ? 'а' : ''} в войско (${u.gear?.weapon ? ITEMS[u.gear.weapon].name : 'без оружия'})`);
  }
  return true;
}

function newGuardUnit(g: Game): Unit {
  const c = campPos(g);
  const a = Math.random() * Math.PI * 2;
  const u = g.newUnit(c.x + Math.cos(a) * 3, c.y + 1 + Math.sin(a) * 2, false);
  u.look = randomLook(Math.random);
  u.look.female = Math.random() < 0.2;
  u.look.cloth = 3;
  u.look.acc = 0;
  u.role = 'soldier';
  u.gear = emptyGear();
  if (!validTile(g, u.x, u.y)) {
    u.x = c.x;
    u.y = c.y;
  }
  const hero = L_heroName(g);
  if (hero) {
    u.name = hero;
    u.hero = true;
    u.trait = 'brave';
    u.look.female = false;
    u.look.beard = true;
  }
  return u;
}
function L_heroName(g: Game): string | null {
  return g.life.heroes.shift() ?? null;
}

/** держит число видимых воинов равным числу воинов в гарнизоне */
function syncGuards(g: Game) {
  const L = g.life;
  while (g.guards.length < g.army) {
    const u = newGuardUnit(g);
    g.guards.push(u);
    equip(g, u);
  }
  while (g.guards.length > g.army) {
    // слабейшие уходят первыми
    let wi = 0;
    for (let i = 1; i < g.guards.length; i++) if (gearPow(g.guards[i]) < gearPow(g.guards[wi])) wi = i;
    const u = g.guards[wi];
    if (L.battleT > 0 && L.people.has(u.id)) killPerson(g, u, 'пал в бою, защищая деревню', true);
    else {
      g.guards.splice(wi, 1);
      const gr = u.gear;
      if (gr?.weapon) L.items[gr.weapon] = (L.items[gr.weapon] ?? 0) + 1;
    }
  }
}

export function takeGuards(g: Game, n: number): Unit[] {
  const out: Unit[] = [];
  // сильнейшие идут в поход
  g.guards.sort((a, b) => gearPow(b) - gearPow(a));
  for (let i = 0; i < n && g.guards.length; i++) {
    const u = g.guards.shift()!;
    u.sleeping = false;
    u.sel = false;
    u.order = undefined;
    out.push(u);
  }
  return out;
}

export function restoreGuards(g: Game, m: March, survivors: number) {
  const mem = m.members ?? [];
  const keep = mem.slice(0, survivors);
  const c = campPos(g);
  for (const u of keep) {
    u.x = c.x + rnd(-2, 2);
    u.y = c.y + rnd(0, 2);
    if (!validTile(g, u.x, u.y)) {
      u.x = c.x;
      u.y = c.y;
    }
    u.path = [];
    g.guards.push(u);
  }
  m.members = [];
}

/** потери похода: погибшие воины идут в книгу павших (для кладбища) */
export function battleLosses(g: Game, m: March) {
  const mem = m.members ?? [];
  const dead = Math.max(0, m.n - m.survivors);
  if (!mem.length || !dead) return;
  // трусы гибнут первыми
  mem.sort((a, b) => (a.trait === 'coward' ? -1 : 0) - (b.trait === 'coward' ? -1 : 0) || Math.random() - 0.5);
  for (let i = 0; i < dead && mem.length; i++) {
    const u = mem.shift()!;
    killPerson(g, u, 'пал героем в бою', true);
  }
}

export function lifeArmyPower(g: Game, n: number): number {
  let sum = 0;
  let cnt = 0;
  for (const u of g.guards) {
    sum += gearPow(u);
    cnt++;
  }
  for (const m of g.marches) {
    if (m.incoming || !m.members) continue;
    for (const u of m.members) {
      sum += gearPow(u);
      cnt++;
    }
  }
  const avg = cnt ? sum / cnt : 1;
  const siege = n > 0 ? Math.min(4, itemCount(g, 'catapult')) * 3 : 0;
  return (n * avg + siege) * armyMorale(g);
}

/** мораль войска: память о павших, кладбища и бафф атаки — множитель к урону каждого бойца */
export function armyMorale(g: Game): number {
  return 1 + g.life.moraleBonus + (g.life.buffs.atk > 0 ? 0.12 : 0);
}

/* ───────────── Бойцы в реальной битве: урон и здоровье из снаряжения ───────────── */

export interface CombatStats {
  max: number;
  dmg: number;
  kind: 'melee' | 'bow' | 'xbow' | 'gun';
  reach: number;
  cd: number;
}

export const BASE_HP = 12;
export const BASE_DMG = 1.7;

const WEAPON_KINDS: Record<string, { kind: CombatStats['kind']; reach: number; cd: number }> = {
  musket: { kind: 'gun', reach: 9.5, cd: 2.1 },
  crossbow: { kind: 'xbow', reach: 8.5, cd: 1.7 },
  bow: { kind: 'bow', reach: 8.5, cd: 1.3 },
  spear: { kind: 'melee', reach: 1.55, cd: 0.95 },
  pike: { kind: 'melee', reach: 1.9, cd: 1.1 },
  club: { kind: 'melee', reach: 1.1, cd: 0.9 },
  waraxe: { kind: 'melee', reach: 1.2, cd: 1.0 },
};

/**
 * Урон и здоровье конкретного бойца. Составляющие те же, что в gearPow / lifeArmyPower:
 * оружие, броня, щит, конь, герой, черта характера и мораль войска. Сила gearPow делится на
 * «нападение» (оружие, конь, герой × мораль) и «живучесть» (броня, щит), поэтому
 * суммарная сила отряда в бою сходится с прежней оценкой armyPower.
 */
export function fighterStats(_g: Game, u: Unit, o: { morale?: number; off?: number; def?: number; militia?: boolean } = {}): CombatStats {
  const gr = u.gear;
  const wid = gr?.weapon ?? null;
  const wp = weaponPow(wid);
  const ap = gr?.armor ? (ITEMS[gr.armor].pow ?? 0) : 0;
  let off = 1 + wp + (gr?.horse ? 0.3 : 0) + (u.hero ? 0.7 : 0);
  let dfn = 1 + ap * 0.8 + (gr?.shield ? 0.12 : 0) + (gr?.horse ? 0.2 : 0) + (u.hero ? 0.5 : 0);
  if (u.trait === 'brave') {
    off *= 1.12;
    dfn *= 1.12;
  } else if (u.trait === 'coward') {
    off *= 0.84;
    dfn *= 0.84;
  }
  const wk = (wid && WEAPON_KINDS[wid]) || { kind: 'melee' as const, reach: 1.25, cd: 0.9 };
  const ranged = wk.kind !== 'melee';
  const k = o.militia ? 0.75 : 1;
  return {
    kind: wk.kind,
    reach: wk.reach,
    cd: wk.cd,
    dmg: BASE_DMG * off * (o.morale ?? 1) * (o.off ?? 1) * (ranged ? 1.35 : 1) * k,
    max: BASE_HP * dfn * (o.def ?? 1) * k,
  };
}

export function moraleOf(g: Game) {
  return g.life.moraleBonus;
}

function updateMorale(g: Game) {
  const L = g.life;
  const heroes = L.graves.filter((q) => q.hero).length;
  L.moraleBonus = Math.min(0.4, L.graves.length * 0.012 + heroes * 0.02 + L.memory * 0.004);
}

export function lifeApplyMods(g: Game, m: Mods) {
  const L = g.life;
  const adults = Math.max(1, g.units.filter((u) => !u.child && u.role === 'none').length);
  const f = (id: string, per = adults) => Math.min(1, (L.items[id] ?? 0) / Math.max(1, per));
  const farms = Math.max(1, g.buildings.filter((b) => b.done && b.type === 'farm').length);
  m.carry += 2 * f('basket') + 1 * f('pickaxe');
  m.gather *= 1 + 0.3 * f('basket');
  m.chop *= 1 + 0.25 * f('axe');
  m.mine *= 1 + 0.3 * f('pickaxe');
  m.farm *= 1 + 0.2 * f('plow', farms);
  m.speed *= 1 + 0.25 * f('cart', Math.max(1, adults / 3));
  m.march *= 1 + 0.35 * Math.min(1, (L.items.horse ?? 0) / Math.max(1, g.army));
  if (L.buffs.birth > 0) m.birth *= 0.67;
  if (L.buffs.work > 0) {
    m.chop *= 1.15;
    m.mine *= 1.15;
    m.gather *= 1.15;
  }
}


/* ───────────── Приказы воинам ───────────── */

interface Foe {
  x: number;
  y: number;
  hit: (d: number) => void;
}

export function findFoeById(g: Game, tk: 'raider' | 'animal' | 'foe', id: number): Foe | null {
  const L = g.life;
  if (tk === 'foe') return foeById(g, id);
  if (tk === 'raider') {
    const r = L.raiders.find((q) => q.unit.id === id);
    return r && r.hp > 0 ? { x: r.unit.x, y: r.unit.y, hit: (dm) => (r.hp -= dm) } : null;
  }
  const a = L.animals.find((q) => q.id === id);
  return a && a.hp > 0 ? { x: a.x, y: a.y, hit: (dm) => (a.hp -= dm) } : null;
}

/** ближайший враг (вор, разбойник, хищник) возле точки */
export function foeNear(g: Game, x: number, y: number, rad: number): { tk: 'raider' | 'animal'; id: number; d: number } | null {
  let best: { tk: 'raider' | 'animal'; id: number; d: number } | null = null;
  for (const r of g.life.raiders) {
    const d = Math.hypot(r.unit.x - x, r.unit.y - y);
    if (d < rad && (!best || d < best.d)) best = { tk: 'raider', id: r.unit.id, d };
  }
  for (const a of g.life.animals) {
    if (a.kind === 'deer') continue;
    const d = Math.hypot(a.x - x, a.y - y);
    if (d < rad && (!best || d < best.d)) best = { tk: 'animal', id: a.id, d };
  }
  return best;
}

/** любое существо под курсором (для приказа «атаковать», включая оленей) */
export function targetAt(g: Game, x: number, y: number): { tk: 'raider' | 'animal' | 'foe'; id: number } | null {
  let best: { tk: 'raider' | 'animal' | 'foe'; id: number; d: number } | null = null;
  const bf = battleFoeAt(g, x, y);
  if (bf) best = { tk: 'foe', id: bf.id, d: bf.d };
  for (const r of g.life.raiders) {
    const d = Math.hypot(r.unit.x - x, r.unit.y - 0.4 - y);
    if (d < 1.3 && (!best || d < best.d)) best = { tk: 'raider', id: r.unit.id, d };
  }
  for (const a of g.life.animals) {
    const d = Math.hypot(a.x - x, a.y - 0.3 - y);
    if (d < 1.3 && (!best || d < best.d)) best = { tk: 'animal', id: a.id, d };
  }
  return best;
}

function guardOrder(g: Game, u: Unit, dt: number): boolean {
  const o = u.order!;
  if (o.kind === 'move') {
    u.phase = 'goto';
    if (stepTo(g, u, o.x, o.y, 3.2, dt)) {
      u.order = { kind: 'hold', x: o.x, y: o.y };
      u.moving = false;
    }
    return true;
  }
  let foe: Foe | null = null;
  if (o.kind === 'attack' && o.tk && o.tid) {
    foe = findFoeById(g, o.tk, o.tid);
    if (!foe) {
      u.order = { kind: 'hold', x: u.x, y: u.y };
      return true;
    }
  } else {
    const n = foeNear(g, o.x, o.y, 5.5);
    if (n) foe = findFoeById(g, n.tk, n.id);
  }
  if (foe) {
    const d = Math.hypot(foe.x - u.x, foe.y - u.y);
    if (d > 1.1) {
      u.phase = 'goto';
      stepTo(g, u, foe.x, foe.y, 3.2, dt);
    } else {
      u.moving = false;
      u.phase = 'work';
      u.swing += dt * 2.2;
      foe.hit(dt * 2.2 * gearPow(u));
      u.fx = foe.x >= u.x ? 2 : 3;
      u.dir = u.fx;
    }
    return true;
  }
  u.phase = 'goto';
  if (Math.hypot(u.x - o.x, u.y - o.y) > 0.45) stepTo(g, u, o.x, o.y, 2.8, dt);
  else u.moving = false;
  return true;
}

/** патрули и посты стражи */
function guardsAI(g: Game, dt: number) {
  const L = g.life;
  const camp = campPos(g);
  const cems = cemeteries(g);
  for (const u of g.guards) {
    if (u.cb) continue; // в бою командует battle.ts
    if (u.spawn > 0) u.spawn = 0;
    if (alarmRespond(g, u, dt)) continue; // тревога: зверь у деревни
    // ночью половина стражи спит в казарме/домах
    const watch = u.id % 2 === 0;
    if (L.sleepTime && !watch && !u.order) {
      u.sleeping = true;
      continue;
    }
    u.sleeping = false;
    if (u.hp < 10) u.hp = Math.min(10, u.hp + dt * 0.2);
    if (u.order && guardOrder(g, u, dt)) continue;
    // угроза рядом — в бой
    let foe: { x: number; y: number; hit: (d: number) => void } | null = null;
    let fd = 11;
    for (const r of L.raiders) {
      const d = Math.hypot(r.unit.x - u.x, r.unit.y - u.y);
      if (d < fd) {
        fd = d;
        foe = { x: r.unit.x, y: r.unit.y, hit: (dm) => (r.hp -= dm) };
      }
    }
    for (const a of L.animals) {
      if (a.kind === 'deer') continue;
      const d = Math.hypot(a.x - u.x, a.y - u.y);
      if (d < Math.min(fd, 9) && Math.hypot(a.x - camp.x, a.y - camp.y) < 22) {
        fd = d;
        foe = { x: a.x, y: a.y, hit: (dm) => (a.hp -= dm) };
      }
    }
    if (foe && !(u.trait === 'coward' && Math.random() < 0.3)) {
      u.phase = 'goto';
      if (fd > 1.1) stepTo(g, u, foe.x, foe.y, 3.1, dt);
      else {
        u.moving = false;
        u.phase = 'work';
        u.swing += dt * 2.2;
        foe.hit(dt * 2.2 * gearPow(u));
        u.fx = foe.x >= u.x ? 2 : 3;
        u.dir = u.fx;
      }
      continue;
    }
    // патруль
    if (u.visit) {
      const b = g.buildings.find((q) => q.id === u.visit!.bid);
      if (!b) u.visit = undefined;
      else {
        const d = doorOf(b);
        if (!stepTo(g, u, d.x, d.y, 1.2, dt)) continue;
        u.moving = false;
        u.phase = 'goto';
        u.visit.t += dt;
        if (Math.random() < dt * 0.6) g.particles.push({ x: u.x * TW, y: u.y * TH - 20, vx: 0, vy: -8, life: 1, max: 1, color: '#ff8aa8', size: 0, grav: 0, text: '♥' });
        if (u.visit.t > 5) {
          L.memory = Math.min(60, L.memory + 1.2);
          u.visit = undefined;
        }
        continue;
      }
    }
    if (u.path.length === 0 && u.wander > 0) {
      u.wander -= dt;
      u.moving = false;
      u.phase = 'goto';
      continue;
    }
    if (!u.gTarget || u.wander <= 0) {
      if (cems.length && !L.sleepTime && Math.random() < 0.12 && L.graves.length) {
        u.visit = { bid: cems[0].id, t: 0 };
        u.wander = 4;
        continue;
      }
      // пост у ворот: вокруг центра, шире ночью
      const ang = Math.random() * Math.PI * 2;
      const rad = 2 + Math.random() * (L.sleepTime ? 9 : 7);
      const tx = camp.x + Math.cos(ang) * rad;
      const ty = camp.y + Math.sin(ang) * rad * 0.75;
      if (validTile(g, tx, ty)) u.gTarget = { x: tx, y: ty };
      u.wander = 2 + Math.random() * 5;
      continue;
    }
    const arrived = stepTo(g, u, u.gTarget.x, u.gTarget.y, 1.15, dt);
    if (arrived) {
      u.gTarget = undefined;
      u.moving = false;
    }
  }
  void dt;
}

/* ───────────── Ночь: сон, воры, разбойники ───────────── */

function lightOf(g: Game) {
  return Math.max(0, Math.min(1, 0.5 + 0.55 * Math.sin((g.dayT - 0.25) * Math.PI * 2)));
}

function goSleep(g: Game, u: Unit): boolean {
  const homes = homesOf(g);
  const home = nearestBuilding(homes.length ? homes : g.buildings.slice(0, 1), u.x, u.y);
  if (!home) {
    u.sleeping = true;
    return true;
  }
  if (g.adjRect(u, home)) {
    u.sleeping = true;
    u.path = [];
    u.moving = false;
    u.home = home.id;
    return true;
  }
  if (!u.goHome || u.path.length === 0) {
    u.path = [];
    if (!g.pathToRect(u, home)) {
      u.sleeping = true;
      return true;
    }
    u.goHome = true;
  }
  return false;
}

function huntersLimit(g: Game) {
  return g.buildings.filter((b) => b.done && b.type === 'lodge').length * 2;
}
export function hunters(g: Game) {
  return g.units.filter((u) => u.role === 'hunter');
}

export function hireHunter(g: Game): string | null {
  if (hunters(g).length >= huntersLimit(g)) return huntersLimit(g) ? 'Лимит: 2 охотника на каждый дом охотника' : 'Постройте дом охотника';
  if (g.res.wood < 6 || g.res.gold < 6) return 'Нужно 6 дерева и 6 золота';
  const cand = g.units.filter((u) => !u.child && u.spawn <= 0 && u.role === 'none' && u.status === 'free').sort((a, b) => (a.task.type === 'idle' ? 0 : 1) - (b.task.type === 'idle' ? 0 : 1) + (b.trait === 'brave' ? 0.5 : 0) - (a.trait === 'brave' ? 0.5 : 0));
  if (cand.length <= 2) return 'Нужно оставить хотя бы двух работников';
  const u = cand[0];
  g.spend('wood', 6);
  g.spend('gold', 6);
  g.setIdle(u);
  u.role = 'hunter';
  u.gear = emptyGear();
  for (const w of ['bow', 'spear', 'club']) {
    if ((g.life.items[w] ?? 0) >= 1) {
      g.life.items[w]--;
      u.gear.weapon = w;
      break;
    }
  }
  u.sel = false;
  const p = g.life.people.get(u.id);
  if (p) {
    p.role = 'hunter';
    personLog(g, u.id, 'Стал охотником');
  }
  g.msg(`${u.name} нанят охотником${u.gear.weapon ? ' (' + ITEMS[u.gear.weapon].name + ')' : ''}`, 'good');
  return null;
}

export function dismissHunter(g: Game, id: number) {
  const u = g.units.find((q) => q.id === id);
  if (!u || u.role !== 'hunter') return;
  u.role = 'none';
  if (u.gear?.weapon) g.life.items[u.gear.weapon] = (g.life.items[u.gear.weapon] ?? 0) + 1;
  u.gear = undefined;
  const p = g.life.people.get(u.id);
  if (p) p.role = 'worker';
  g.setIdle(u);
}

function hunterAI(g: Game, u: Unit, dt: number): boolean {
  const L = g.life;
  const camp = campPos(g);
  if (u.hp < 10) u.hp = Math.min(10, u.hp + dt * 0.3);
  const pow = 2.2 * (1 + weaponPow(u.gear?.weapon ?? null) * 1.2) * (u.trait === 'brave' ? 1.2 : 1);
  // хищники — главная цель
  let best: Animal | null = null;
  let bd = 16;
  for (const a of L.animals) {
    if (a.kind === 'deer') continue;
    const d = Math.hypot(a.x - u.x, a.y - u.y);
    if (d < bd) {
      bd = d;
      best = a;
    }
  }
  let prey: Animal | null = best;
  if (!prey) {
    let pd = 14;
    for (const a of L.animals) {
      if (a.kind !== 'deer') continue;
      const d = Math.hypot(a.x - u.x, a.y - u.y);
      if (d < pd) {
        pd = d;
        prey = a;
      }
    }
    bd = pd;
  }
  if (prey) {
    u.phase = 'goto';
    if (bd > 1.2) {
      stepTo(g, u, prey.x, prey.y, 3, dt);
    } else {
      u.moving = false;
      u.phase = 'work';
      u.swing += dt * 2;
      u.fx = prey.x >= u.x ? 2 : 3;
      u.dir = u.fx;
      prey.hp -= dt * pow;
      if (prey.kind !== 'deer') {
        prey.state = 'chase';
        prey.target = u.id;
      }
    }
    return true;
  }
  // патруль рядом с лесорубами
  u.phase = 'goto';
  if (u.path.length === 0 && u.wander > 0) {
    u.wander -= dt;
    u.moving = false;
    return true;
  }
  if (!u.gTarget || u.wander <= 0) {
    const cutters = g.units.filter((q) => q.task.type === 'chop' && !q.sleeping && q.spawn <= 0);
    const c = cutters.length ? cutters[Math.floor(Math.random() * cutters.length)] : null;
    const lodge = nearestBuilding(g.buildings.filter((b) => b.done && b.type === 'lodge'), camp.x, camp.y);
    const bx = c ? c.x : lodge ? lodge.x + lodge.w / 2 : camp.x;
    const by = c ? c.y : lodge ? lodge.y + lodge.h + 1 : camp.y;
    const a = Math.random() * Math.PI * 2;
    const r = 1.5 + Math.random() * 3;
    const tx = bx + Math.cos(a) * r;
    const ty = by + Math.sin(a) * r * 0.7;
    if (validTile(g, tx, ty)) u.gTarget = { x: tx, y: ty };
    u.wander = 3 + Math.random() * 5;
    return true;
  }
  if (stepTo(g, u, u.gTarget.x, u.gTarget.y, 1.5, dt)) {
    u.gTarget = undefined;
    u.moving = false;
  }
  return true;
}

/** вызывается для каждого жителя до обычной логики; true — житель занят сам */
/* ───────────── Приёмы пищи ───────────── */

function nearestBush(g: Game, u: Unit, r = 14): Obj | null {
  let best: Obj | null = null;
  let bd = 1e9;
  g.scanFor(Math.floor(u.x), Math.floor(u.y), r, (o) => o.kind === 'bush' && o.amount > 0 && !g.bad.has(o.ty * g.world.w + o.tx), (o) => {
    const d = (o.tx + 0.5 - u.x) ** 2 + (o.ty + 0.5 - u.y) ** 2;
    if (d < bd) {
      bd = d;
      best = o;
    }
  });
  return best as Obj | null;
}

function cancelMeal(u: Unit, cd: number, badSpot?: number) {
  u.meal = undefined;
  u.path = [];
  u.eatCd = cd;
  if (badSpot !== undefined) u.eatBad = badSpot;
}

/**
 * Личная сытость: утром (06:00–08:30) и вечером (18:00–20:30) жители сами идут к Стоянке,
 * Костру, ближайшему Дому или Трактиру и берут еду со склада. Голодный (<25%) свободный
 * житель идёт к ближайшему кусту или складу. true — юнит занят едой.
 */
function foodAI(g: Game, u: Unit, dt: number): boolean {
  if (u.role === 'lord' || u.spawn > 0 || g.dev.noHunger) {
    u.meal = undefined;
    return false;
  }
  if (u.hunger === undefined) u.hunger = FOOD.START;
  u.eatCd = Math.max(0, (u.eatCd ?? 0) - dt);
  const hunger = u.hunger;

  // охотники и особые роли едят «сухим пайком» прямо со склада, без дороги
  if (u.role !== 'none') {
    u.meal = undefined;
    if (hunger < 55 && u.eatCd <= 0 && g.res.food >= 0.3) {
      if (g.eatMeal(u).pts <= 0) u.eatCd = 10;
    } else if (hunger < 55 && u.eatCd <= 0) u.eatCd = 10;
    return false;
  }

  let m = u.meal;
  if (!m) {
    if (u.eatCd > 0) return false;
    const slot = mealSlotAt(g.mealHour());
    const fed = g.time - (u.lastMealT ?? -1e9) < DAY_LENGTH * 0.3;
    const busy = u.task.type !== 'idle' && u.task.type !== 'move';
    // не перебиваем приказ «идти», пока человек не дошёл (если он не при смерти от голода)
    if (u.task.type === 'move' && u.path.length > 0 && hunger >= FOOD.URGENT) return false;
    let kind: 'meal' | 'snack' | null = null;
    if (slot >= 0 && !fed) {
      if (hunger >= 97) u.lastMealT = g.time;
      else kind = 'meal';
    } else if (hunger < FOOD.URGENT) kind = 'snack';
    else if (hunger < FOOD.LOW && !busy) kind = 'snack';
    if (!kind) return false;

    // место: Стоянка, Костёр, Трактир/Пекарня, ближайший Дом или Склад
    if (g.res.food >= 0.3) {
      const spots = g.buildings.filter((b) => b.done && isEatSpotType(b.type) && b.id !== u.eatBad);
      const b = nearestBuilding(spots, u.x, u.y);
      if (b) m = { kind, bid: b.id, tx: 0, ty: 0, t: 0, age: 0 };
    }
    // склад пуст — голодный бежит к ближайшему кусту
    if (!m && hunger < FOOD.LOW) {
      const bush = nearestBush(g, u);
      if (bush) m = { kind: 'bush', bid: 0, tx: bush.tx, ty: bush.ty, t: 0, age: 0 };
    }
    if (!m) {
      u.eatCd = 10;
      if (hunger < FOOD.LOW && Math.random() < 0.5) g.floatText(u.x * TW, u.y * TH - 26, 'нет еды', '#ff9a8a');
      return false;
    }
    u.meal = m;
    u.path = [];
    u.goHome = false;
  }

  m.age += dt;
  if (m.age > 50) {
    cancelMeal(u, 15, m.kind === 'bush' ? undefined : m.bid);
    return false;
  }

  if (m.kind === 'bush') {
    let o = g.objAt(m.tx, m.ty);
    if (!o || o.kind !== 'bush' || o.amount <= 0) {
      const nb = nearestBush(g, u);
      if (!nb) {
        cancelMeal(u, 10);
        return false;
      }
      m.tx = nb.tx;
      m.ty = nb.ty;
      u.path = [];
      o = nb;
    }
    if (!g.adjObj(u, m.tx, m.ty)) {
      if (u.path.length === 0 && !g.pathToObj(u, m.tx, m.ty)) {
        g.bad.add(m.ty * g.world.w + m.tx);
        cancelMeal(u, 6);
        return false;
      }
      g.stepPath(u, dt);
      return true;
    }
    u.moving = false;
    u.path = [];
    g.faceTo(u, m.tx + 0.5, m.ty + 0.5);
    m.t += dt;
    if (m.t >= 1.3) {
      m.t = 0;
      o.amount -= 1;
      o.shake = 0.25;
      u.hunger = Math.min(FOOD.MAX, u.hunger + FOOD.BERRY_PTS);
      g.floatText(u.x * TW, u.y * TH - 24, '+🍓', '#ffffff');
      for (let i = 0; i < 3; i++) g.spark((o.tx + 0.5) * TW, (o.ty + 0.3) * TH, i % 2 ? '#ff5a78' : '#7ac04a');
      if (o.amount <= 0) g.depleteObj(o, u.x * TW);
      if (u.hunger >= 45 || o.amount <= 0) cancelMeal(u, 3);
    }
    return true;
  }

  const b = g.buildings.find((q) => q.id === m!.bid);
  if (!b || !b.done) {
    cancelMeal(u, 3);
    return false;
  }
  if (!g.adjRect(u, b)) {
    if (u.path.length === 0 && !g.pathToRect(u, b)) {
      cancelMeal(u, 8, b.id);
      return false;
    }
    g.stepPath(u, dt);
    return true;
  }
  // у места еды: садится и ест
  u.moving = false;
  u.path = [];
  g.faceTo(u, b.x + b.w / 2, b.y + b.h / 2);
  m.t += dt;
  if (m.t > 0.4 && Math.random() < dt * 1.2) g.particles.push({ x: u.x * TW + (Math.random() - 0.5) * 8, y: u.y * TH - 18, vx: 0, vy: -9, life: 0.9, max: 0.9, color: '#ffe9a8', size: 0, grav: 0, text: g.canCook() ? '♨' : '🍖' });
  if (m.t >= 2.4) {
    u.meal = undefined;
    const r = g.eatMeal(u);
    if (r.pts > 0.5) {
      u.lastMealT = g.time;
      u.eatBad = undefined;
      g.floatText(u.x * TW, u.y * TH - 26, r.hot ? `🍲 +${Math.round(r.pts)}` : `🍖 +${Math.round(r.pts)}`, r.hot ? '#ffd27a' : '#ff9a9a');
      g.sfx('drop', u.x * TW, u.y * TH);
    } else {
      u.eatCd = 10;
      g.floatText(u.x * TW, u.y * TH - 26, 'нет еды', '#ff9a8a');
    }
  }
  return true;
}

export function lifeUnit(g: Game, u: Unit, dt: number): boolean {
  const L = g.life;
  if (u.role === 'lord') return false;
  if (alarmRespond(g, u, dt)) return true; // тревога: охотники и храбрецы бегут на зверя
  if (u.hp < 10 && !(u.flee && u.flee > 0)) u.hp = Math.min(10, u.hp + dt * 0.08);
  // бегство от хищников и воров
  if (u.flee && u.flee > 0) {
    u.flee -= dt;
    u.sleeping = false;
    const c = campPos(g);
    stepTo(g, u, c.x, c.y, 2.5, dt);
    u.path = [];
    return true;
  }
  if (L.sleepTime) {
    if (u.sleeping) return true;
    u.visit = undefined;
    return goSleep(g, u);
  }
  if (u.sleeping) {
    u.sleeping = false;
    u.goHome = false;
    u.path = [];
    u.meal = undefined;
  }
  if (foodAI(g, u, dt)) return true; // приём пищи: идём к кухне, дому или кусту
  if (u.role === 'hunter') return hunterAI(g, u, dt);
  // вечер: пьяницы тянутся к костру
  if (L.evening && u.trait === 'drunkard' && u.role === 'none' && !u.child) {
    const fires = g.buildings.filter((b) => b.done && (b.type === 'campfire' || b.type === 'camp'));
    const f = nearestBuilding(fires, u.x, u.y);
    if (f) {
      if (!g.adjRect(u, f)) {
        if (u.path.length === 0) g.pathToRect(u, f);
        return false;
      }
      u.moving = false;
      u.phase = 'goto';
      if (Math.random() < dt * 0.5) g.particles.push({ x: u.x * TW, y: u.y * TH - 22, vx: 0, vy: -7, life: 1.2, max: 1.2, color: '#ffd27a', size: 0, grav: 0, text: '🍺' });
      return true;
    }
  }
  // навестить кладбище
  if (u.visit) {
    if (u.task.type !== 'idle') {
      u.visit = undefined;
      return false;
    }
    const b = g.buildings.find((q) => q.id === u.visit!.bid);
    if (!b) {
      u.visit = undefined;
      return false;
    }
    if (!g.adjRect(u, b)) {
      if (u.path.length === 0 && !g.pathToRect(u, b)) u.visit = undefined;
      return false;
    }
    u.moving = false;
    u.visit.t += dt;
    if (Math.random() < dt * 0.7) g.particles.push({ x: u.x * TW, y: u.y * TH - 22, vx: 0, vy: -7, life: 1.2, max: 1.2, color: '#ff8aa8', size: 0, grav: 0, text: '♥' });
    if (u.visit.t > 7) {
      L.memory = Math.min(60, L.memory + 2.5);
      u.visit = undefined;
      g.setIdle(u);
    }
    return true;
  }
  if (u.task.type === 'idle' && !u.child && L.graves.length && u.role === 'none' && Math.random() < dt * 0.012) {
    const cems = cemeteries(g);
    if (cems.length) u.visit = { bid: cems[Math.floor(Math.random() * cems.length)].id, t: 0 };
  }
  return false;
}

function spawnPoint(g: Game, rmin: number, rmax: number, pred?: (x: number, y: number) => boolean) {
  const c = campPos(g);
  for (let k = 0; k < 40; k++) {
    const a = Math.random() * Math.PI * 2;
    const r = rnd(rmin, rmax);
    const x = c.x + Math.cos(a) * r;
    const y = c.y + Math.sin(a) * r * 0.8;
    if (validTile(g, x, y) && (!pred || pred(x, y))) return { x, y };
  }
  return null;
}

function mkRaider(g: Game, kind: 'thief' | 'bandit', x: number, y: number): Raider {
  const u = g.newUnit(x, y, false);
  u.role = kind;
  u.look = { skin: 1, hair: 0, cloth: 0, female: false, style: 0, outfit: 0, beard: kind === 'bandit', acc: 1 };
  u.name = kind === 'thief' ? 'Вор' : 'Разбойник';
  return { unit: u, kind, hp: kind === 'thief' ? 4 : 9 + Math.floor(g.time / 600), state: 'sneak', bid: 0, t: 0, loot: null, sx: x, sy: y };
}

function nightRaids(g: Game) {
  const L = g.life;
  if (g.dev.noRaids || g.time < 150) return;
  const D = DIFFS[g.diff];
  const chance = Math.min(0.9, (0.35 + g.time / 2400) / Math.max(0.6, D.raid));
  if (Math.random() > chance) return;
  const pop = g.units.length;
  const n = 1 + Math.floor(pop / 14) + (g.time > 1500 ? 1 : 0);
  let thieves = 0;
  let bandits = 0;
  for (let i = 0; i < n; i++) {
    const kind: 'thief' | 'bandit' = g.time > 700 && Math.random() < 0.38 ? 'bandit' : 'thief';
    const sp = spawnPoint(g, 22, 30);
    if (!sp) continue;
    L.raiders.push(mkRaider(g, kind, sp.x, sp.y));
    if (kind === 'thief') thieves++;
    else bandits++;
  }
  if (thieves + bandits > 0) {
    const txt = `Ночью в деревню пробрались ${bandits ? 'разбойники' : 'воры'} (${thieves + bandits})! Стража, к оружию!`;
    g.msg(txt, 'warn');
    lifeEvent(g, txt, 'warn');
    g.sfx('alarm');
  }
}

function raidersAI(g: Game, dt: number) {
  const L = g.life;
  const light = lightOf(g);
  for (let i = L.raiders.length - 1; i >= 0; i--) {
    const r = L.raiders[i];
    const u = r.unit;
    u.sleeping = false;
    // убит
    if (r.hp <= 0) {
      if (r.loot) g.gain(r.loot.k, r.loot.n);
      L.caught++;
      L.kills++;
      g.msg(`Стража победила: ${r.kind === 'thief' ? 'вор пойман' : 'разбойник повержен'}${r.loot ? ', добыча возвращена' : ''}`, 'good');
      lifeEvent(g, r.kind === 'thief' ? 'Стража поймала вора' : 'Разбойник повержен стражей', 'good');
      g.gain('gold', r.kind === 'bandit' ? 8 : 3);
      g.sfx('battle', u.x * TW, u.y * TH);
      addShields(g, u.x, u.y, r.kind === 'bandit' ? 2 : 1, 0.9);
      L.raiders.splice(i, 1);
      continue;
    }
    // рассвет: расходятся
    if (light > 0.45 && r.state !== 'flee') {
      r.state = 'flee';
      u.flee = 0;
    }
    // стража рядом — вор пугается
    let guardNear = false;
    for (const gd of g.guards) if (!gd.sleeping && Math.hypot(gd.x - u.x, gd.y - u.y) < 4.5) guardNear = true;
    for (const h of g.units) if (h.role === 'hunter' && !h.sleeping && Math.hypot(h.x - u.x, h.y - u.y) < 3) guardNear = true;
    if (guardNear && r.kind === 'thief' && r.state !== 'flee') r.state = 'flee';
    if (r.state === 'sneak') {
      let b = g.buildings.find((q) => q.id === r.bid);
      if (!b) {
        const ts = g.buildings.filter((q) => q.done && q.type !== 'camp' || (q.type === 'camp'));
        b = ts[Math.floor(Math.random() * ts.length)];
        r.bid = b?.id ?? 0;
      }
      if (!b) {
        r.state = 'flee';
        continue;
      }
      const d = doorOf(b);
      u.phase = 'goto';
      if (stepTo(g, u, d.x, d.y, r.kind === 'thief' ? 1.9 : 1.6, dt)) {
        r.state = 'steal';
        r.t = 0;
      }
      // разбойник нападает на тех, кто не спит
      if (r.kind === 'bandit') {
        for (const v of g.units) {
          if (v.sleeping || v.spawn > 0 || v.role === 'lord') continue;
          const dd = Math.hypot(v.x - u.x, v.y - u.y);
          if (dd < 5 && !(v.flee && v.flee > 0)) v.flee = 4;
          if (dd < 1 && Math.random() < dt * 0.5) {
            v.hp -= 3 * dt * 2;
            if (v.hp <= 0) killPerson(g, v, 'убит разбойником', false);
          }
        }
      }
    } else if (r.state === 'steal') {
      r.t += dt;
      u.moving = false;
      u.phase = 'work';
      u.swing += dt * 2;
      if (r.t > 2.5) {
        const pick = (['gold', 'goods', 'food', 'wood', 'stone'] as const)[Math.floor(Math.random() * 5)];
        const have = g.res[pick];
        const n = Math.min(Math.floor(have * (r.kind === 'bandit' ? 0.12 : 0.06)) + (r.kind === 'bandit' ? 6 : 2), Math.floor(have), r.kind === 'bandit' ? 90 : 40);
        if (n > 0) {
          g.spend(pick, n);
          r.loot = { k: pick, n };
          L.thefts++;
          g.msg(`Воры украли: ${n} ${pick === 'gold' ? 'золота' : pick === 'goods' ? 'товаров' : pick === 'food' ? 'еды' : pick === 'wood' ? 'дерева' : 'камня'}!`, 'warn');
        }
        r.state = 'flee';
      }
    } else {
      // бегство к месту появления
      u.phase = 'goto';
      const ok = stepTo(g, u, r.sx, r.sy, 2.4, dt);
      const far = Math.hypot(u.x - campPos(g).x, u.y - campPos(g).y) > 21;
      if (ok || far) {
        if (r.loot) lifeEvent(g, `Вор скрылся с добычей (${r.loot.n})`, 'warn');
        L.raiders.splice(i, 1);
      }
    }
  }
}

/* ───────────── Дикие звери ───────────── */

/** радиус запретной зоны вокруг каждого здания и селения */
const ZONE_R = 10;
/** ближе этого расстояния до здания — тревога */
const ALARM_R = 8;
const ZONE_MAX = 20;

const isWallB = (b: Building) => /palisade|stonewall|stonegate|gate|wall/.test(b.type);

interface Zone {
  world: unknown;
  key: string;
  t: number;
  w: number;
  h: number;
  dist: Float32Array;
  src: Int32Array;
  pts: { x: number; y: number }[];
}
const zoneCache = new WeakMap<Game, Zone>();

function zoneKey(g: Game) {
  let done = 0;
  let walls = 0;
  for (const b of g.buildings)
    if (b.done) {
      done++;
      if (isWallB(b)) walls++;
    }
  let tb = 0;
  for (const t of g.towns) tb += t.bld.length + 1;
  return `${g.buildings.length}|${done}|${walls}|${g.towns.length}|${tb}`;
}

/** сетка расстояний до ближайшего здания/селения; внутри частокола и стен — 0 */
function buildZone(g: Game, key: string): Zone {
  const w = g.world.w;
  const h = g.world.h;
  const dist = new Float32Array(w * h).fill(99);
  const src = new Int32Array(w * h).fill(-1);
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  for (const b of g.buildings) if (b.done) rects.push(b);
  for (const t of g.towns) {
    rects.push({ x: t.x, y: t.y, w: 0, h: 0 });
    for (const b of t.bld) rects.push(b);
  }
  const c = campPos(g);
  rects.push({ x: c.x, y: c.y, w: 0, h: 0 });
  const pts: { x: number; y: number }[] = [];
  rects.forEach((r, i) => {
    pts.push({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    const x0 = Math.max(0, Math.floor(r.x - ZONE_MAX));
    const x1 = Math.min(w - 1, Math.ceil(r.x + r.w + ZONE_MAX));
    const y0 = Math.max(0, Math.floor(r.y - ZONE_MAX));
    const y1 = Math.min(h - 1, Math.ceil(r.y + r.h + ZONE_MAX));
    for (let ty = y0; ty <= y1; ty++) {
      const py = ty + 0.5;
      const dy = Math.max(r.y - py, 0, py - (r.y + r.h));
      for (let tx = x0; tx <= x1; tx++) {
        const px = tx + 0.5;
        const dx = Math.max(r.x - px, 0, px - (r.x + r.w));
        const d = Math.hypot(dx, dy);
        const k = ty * w + tx;
        if (d < dist[k]) {
          dist[k] = d;
          src[k] = i;
        }
      }
    }
  });
  // территория внутри частокола/стен — тоже деревня (заливка снаружи)
  const walls = g.buildings.filter((b) => b.done && isWallB(b));
  if (walls.length >= 6) {
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    for (const b of walls) {
      minX = Math.min(minX, Math.floor(b.x));
      minY = Math.min(minY, Math.floor(b.y));
      maxX = Math.max(maxX, Math.ceil(b.x + b.w));
      maxY = Math.max(maxY, Math.ceil(b.y + b.h));
    }
    minX = Math.max(0, minX - 1);
    minY = Math.max(0, minY - 1);
    maxX = Math.min(w - 1, maxX + 1);
    maxY = Math.min(h - 1, maxY + 1);
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw * bh <= 60000) {
      const wall = new Uint8Array(bw * bh);
      for (const b of walls)
        for (let ty = Math.floor(b.y); ty < Math.ceil(b.y + b.h); ty++)
          for (let tx = Math.floor(b.x); tx < Math.ceil(b.x + b.w); tx++) {
            const lx = tx - minX;
            const ly = ty - minY;
            if (lx >= 0 && ly >= 0 && lx < bw && ly < bh) wall[ly * bw + lx] = 1;
          }
      const seen = new Uint8Array(bw * bh);
      const stack: number[] = [];
      const push = (lx: number, ly: number) => {
        const k = ly * bw + lx;
        if (!wall[k] && !seen[k]) {
          seen[k] = 1;
          stack.push(k);
        }
      };
      for (let lx = 0; lx < bw; lx++) {
        push(lx, 0);
        push(lx, bh - 1);
      }
      for (let ly = 0; ly < bh; ly++) {
        push(0, ly);
        push(bw - 1, ly);
      }
      while (stack.length) {
        const k = stack.pop()!;
        const lx = k % bw;
        const ly = (k - lx) / bw;
        if (lx > 0) push(lx - 1, ly);
        if (lx < bw - 1) push(lx + 1, ly);
        if (ly > 0) push(lx, ly - 1);
        if (ly < bh - 1) push(lx, ly + 1);
      }
      for (let ly = 0; ly < bh; ly++)
        for (let lx = 0; lx < bw; lx++) {
          const k = ly * bw + lx;
          if (!seen[k] && !wall[k]) dist[(ly + minY) * w + lx + minX] = 0;
        }
    }
  }
  return { world: g.world, key, t: g.time, w, h, dist, src, pts };
}

function zoneOf(g: Game): Zone {
  let z = zoneCache.get(g);
  if (!z || z.world !== g.world || g.time < z.t) {
    z = buildZone(g, zoneKey(g));
    zoneCache.set(g, z);
  } else if (g.time - z.t > 0.4) {
    const key = zoneKey(g);
    if (key !== z.key || g.time - z.t > 4) {
      z = buildZone(g, key);
      zoneCache.set(g, z);
    } else z.t = g.time;
  }
  return z;
}

/** расстояние до ближайшего здания игрока/чужого поселения (0 — внутри стен) */
function zoneDist(g: Game, x: number, y: number): number {
  const z = zoneOf(g);
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= z.w || ty >= z.h) return 99;
  return z.dist[ty * z.w + tx];
}

/**
 * Реальные границы деревни: радиус 10 клеток вокруг КАЖДОГО построенного здания игрока и всех чужих
 * поселений + вся территория внутри частокола/стен. Возвращает ближайшую точку селения.
 */
function settleZone(g: Game, x: number, y: number, pad = 0): { x: number; y: number } | null {
  const z = zoneOf(g);
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= z.w || ty >= z.h) return null;
  const k = ty * z.w + tx;
  if (z.dist[k] >= ZONE_R + pad) return null;
  const p = z.src[k] >= 0 ? z.pts[z.src[k]] : campPos(g);
  return { x: p.x, y: p.y };
}

function forestAt(g: Game, x: number, y: number) {
  const w = g.world;
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= w.w || ty >= w.h) return false;
  const b = w.biome[ty * w.w + tx];
  return b >= B.OAK && b <= B.DARK;
}
const OFF4: [number, number][] = [
  [3, 0],
  [-3, 0],
  [0, 3],
  [0, -3],
];
/** глубина леса: вокруг тоже лес */
function deepForest(g: Game, x: number, y: number) {
  if (!forestAt(g, x, y)) return false;
  return OFF4.every(([dx, dy]) => forestAt(g, x + dx, y + dy) || !validTile(g, x + dx, y + dy));
}
/** опушка: лес, рядом открытое место */
function forestEdge(g: Game, x: number, y: number) {
  if (!forestAt(g, x, y)) return false;
  return OFF4.some(([dx, dy]) => validTile(g, x + dx * 1.4, y + dy * 1.4) && !forestAt(g, x + dx * 1.4, y + dy * 1.4));
}

function spawnAnimal(g: Game, kind: Animal['kind']) {
  const hostile = kind !== 'deer';
  let sp: { x: number; y: number } | null = null;
  if (hostile) {
    // хищники рождаются в глубине леса, далеко за пределами деревни
    const far = (x: number, y: number) => zoneDist(g, x, y) >= ZONE_R + 6;
    sp =
      spawnPoint(g, 15, 44, (x, y) => far(x, y) && deepForest(g, x, y)) ??
      spawnPoint(g, 15, 44, (x, y) => far(x, y) && forestAt(g, x, y)) ??
      spawnPoint(g, 28, 70, (x, y) => far(x, y) && forestAt(g, x, y)) ??
      spawnPoint(g, 15, 70, (x, y) => zoneDist(g, x, y) >= ZONE_R + 2 && forestAt(g, x, y));
  } else {
    // олени пасутся на лесных опушках, не у домов
    sp =
      spawnPoint(g, 15, 44, (x, y) => zoneDist(g, x, y) >= ZONE_R - 1 && forestEdge(g, x, y)) ??
      spawnPoint(g, 15, 44, (x, y) => zoneDist(g, x, y) >= ZONE_R - 2 && forestAt(g, x, y)) ??
      spawnPoint(g, 25, 64, (x, y) => zoneDist(g, x, y) >= ZONE_R - 2 && forestAt(g, x, y));
  }
  if (!sp) return;
  const hp = kind === 'wolf' ? 6 : kind === 'bear' ? 16 : 3;
  g.life.animals.push({ id: g.nextId++, kind, x: sp.x, y: sp.y, hx: sp.x, hy: sp.y, hp, maxhp: hp, dir: 2, anim: 0, state: 'roam', tx: sp.x, ty: sp.y, wait: rnd(0, 4), target: 0, atkT: 0, moving: false, hun: rnd(0.1, 0.5), alarm: 0 });
}

function initAnimals(g: Game) {
  const n = Math.max(2, Math.round(g.world.w / 24));
  for (let i = 0; i < n + 1; i++) spawnAnimal(g, 'wolf');
  for (let i = 0; i < Math.max(1, n - 2); i++) spawnAnimal(g, 'bear');
  for (let i = 0; i < n + 2; i++) spawnAnimal(g, 'deer');
}

/** новый «дом» зверя, если деревня разрослась и накрыла старое логово */
function rehome(g: Game, a: Animal) {
  const hostile = a.kind !== 'deer';
  for (let k = 0; k < 18; k++) {
    const ang = Math.random() * Math.PI * 2;
    const r = rnd(8, 26);
    const x = a.x + Math.cos(ang) * r;
    const y = a.y + Math.sin(ang) * r * 0.85;
    if (!validTile(g, x, y)) continue;
    const zd = zoneDist(g, x, y);
    if (hostile ? zd >= ZONE_R + 5 && forestAt(g, x, y) : zd >= ZONE_R - 1 && forestAt(g, x, y)) {
      a.hx = x;
      a.hy = y;
      return true;
    }
  }
  return false;
}

/** длинный переход зверя с обходом воды и преград (A*); true — дошёл */
function animalGo(g: Game, a: Animal, tx: number, ty: number, speed: number, dt: number): boolean {
  if (Math.hypot(tx - a.x, ty - a.y) < 0.6) {
    a.moving = false;
    a.pth = undefined;
    return true;
  }
  const gx = Math.floor(tx);
  const gy = Math.floor(ty);
  const key = gy * g.world.w + gx;
  if (!a.pth || a.pk !== key) {
    const p = g.pf.find(g.world.blocked, Math.floor(a.x), Math.floor(a.y), (x, y) => x === gx && y === gy, gx, gy, true, 4000);
    a.pth = p ? p.map((q) => ({ x: q.x + 0.5, y: q.y + 0.5 })) : [];
    a.pk = key;
    a.stuck = 0;
  }
  const n = a.pth[0];
  const px = a.x;
  const py = a.y;
  if (n) {
    if (stepTo(g, a, n.x, n.y, speed, dt)) a.pth.shift();
  } else stepTo(g, a, tx, ty, speed, dt);
  if (Math.hypot(a.x - px, a.y - py) < speed * dt * 0.25) {
    a.stuck = (a.stuck ?? 0) + dt;
    if (a.stuck > 1.2) {
      a.pth = undefined;
      a.stuck = 0;
    }
  } else a.stuck = 0;
  return false;
}

/* ───── тревога: стража, охотники и храбрецы бегут на зверя ───── */

interface AlarmSt {
  resp: Map<number, number>;
  msgT: number;
  raidT: number;
}
const alarmSt = new WeakMap<Game, AlarmSt>();
function AS(g: Game): AlarmSt {
  let s = alarmSt.get(g);
  if (!s) {
    s = { resp: new Map(), msgT: -999, raidT: -999 };
    alarmSt.set(g, s);
  }
  return s;
}

const ALARM_RADIUS = 18;

function callResponders(g: Game, a: Animal) {
  const st = AS(g);
  const take = (u: Unit) => {
    if (u.cb || u.spawn > 0 || u.role === 'lord') return;
    if (Math.hypot(u.x - a.x, u.y - a.y) > ALARM_RADIUS) return;
    const cur = st.resp.get(u.id);
    if (cur === undefined || cur === a.id) {
      st.resp.set(u.id, a.id);
      return;
    }
    const ca = g.life.animals.find((q) => q.id === cur);
    if (!ca || ca.hp <= 0 || !(ca.alarm && ca.alarm > 0)) st.resp.set(u.id, a.id);
  };
  for (const u of g.guards) if (!(u.order && u.order.kind === 'move')) take(u);
  for (const u of g.units) if (!u.child && (u.role === 'hunter' || (u.trait === 'brave' && u.role === 'none'))) take(u);
}

/** житель/стражник на тревоге: бежит на зверя и бьёт, пока не убьёт или не прогонит; true — занят */
function alarmRespond(g: Game, u: Unit, dt: number): boolean {
  const st = AS(g);
  const aid = st.resp.get(u.id);
  if (aid === undefined) return false;
  if (u.order && u.order.kind === 'move') return false;
  const a = g.life.animals.find((q) => q.id === aid);
  if (!a || a.hp <= 0 || !(a.alarm && a.alarm > 0) || u.cb) {
    st.resp.delete(u.id);
    u.path = [];
    u.gTarget = undefined;
    u.moving = false;
    return false;
  }
  u.sleeping = false;
  u.goHome = false;
  u.visit = undefined;
  u.flee = 0;
  const d = Math.hypot(a.x - u.x, a.y - u.y);
  if (d > 1.15) {
    u.phase = 'goto';
    u.path = [];
    stepTo(g, u, a.x, a.y, 3.3, dt);
  } else {
    u.moving = false;
    u.phase = 'work';
    u.swing += dt * 2.2;
    const hunterK = u.role === 'hunter' ? 1.3 : 1;
    a.hp -= dt * 2.2 * gearPow(u) * hunterK;
    u.fx = a.x >= u.x ? 2 : 3;
    u.dir = u.fx;
    if (u.role !== 'guard' && g.units.includes(u)) {
      a.target = u.id;
      if (a.kind !== 'deer') a.state = 'chase';
    }
  }
  return true;
}

/* ───── ИИ зверей ───── */

function animalsAI(g: Game, dt: number) {
  const L = g.life;
  const st = AS(g);
  const winter = isWinter(g);
  const night = L.sleepTime;
  // бодрствующие люди (жители и стража)
  const ppl: { x: number; y: number; id: number }[] = [];
  for (const u of g.units) if (!u.sleeping && u.spawn <= 0) ppl.push({ x: u.x, y: u.y, id: u.id });
  for (const u of g.guards) if (!u.sleeping) ppl.push({ x: u.x, y: u.y, id: u.id });
  const countPeople = (x: number, y: number, r: number, ex = -1) => {
    let n = 0;
    for (const p of ppl) if (p.id !== ex && Math.hypot(p.x - x, p.y - y) < r) n++;
    return n;
  };
  // горящие костры (днём — костры, ночью — ещё и факелы у освещённых зданий)
  const fires: { x: number; y: number; r: number }[] = [];
  for (const b of g.buildings) {
    if (!b.done) continue;
    if (b.type === 'campfire' || b.type === 'camp') fires.push({ x: b.x + b.w / 2, y: b.y + b.h / 2, r: 6.5 });
    else if (night && BUILDINGS[b.type]?.light) fires.push({ x: b.x + b.w / 2, y: b.y + b.h / 2, r: 3.5 });
  }
  const deerN = L.animals.filter((q) => q.kind === 'deer' && q.hp > 0).length;

  for (let i = L.animals.length - 1; i >= 0; i--) {
    const a = L.animals[i];
    if (a.hp <= 0) {
      L.kills += a.kind === 'deer' ? 0 : 1;
      const meat = a.kind === 'deer' ? 9 : a.kind === 'bear' ? 14 : 6;
      g.gain('food', meat);
      g.floatText(a.x * TW, a.y * TH - 8, `+${meat}🍖`, '#ffb0b8');
      if (a.kind !== 'deer') lifeEvent(g, `${a.kind === 'wolf' ? 'Волк' : 'Медведь'} убит. Лес стал безопаснее`, 'good');
      L.animals.splice(i, 1);
      continue;
    }
    a.atkT -= dt;
    a.moving = false;
    if (a.hun === undefined) a.hun = rnd(0.1, 0.5);
    if (a.cool && a.cool > 0) a.cool = Math.max(0, a.cool - dt);
    const speed = a.kind === 'wolf' ? 2.7 : a.kind === 'bear' ? 2.2 : 2.5;
    const dz = zoneDist(g, a.x, a.y);

    /* ───── олени: опушки, подальше от людей и домов ───── */
    if (a.kind === 'deer') {
      if (zoneDist(g, a.hx, a.hy) < ZONE_R - 2 || !forestAt(g, a.hx, a.hy)) rehome(g, a);
      let near: { x: number; y: number } | null = null;
      let nd = 7;
      for (const p of ppl) {
        const d = Math.hypot(p.x - a.x, p.y - a.y);
        if (d < nd) {
          nd = d;
          near = p;
        }
      }
      if (near) {
        a.state = 'flee';
        const px = a.x;
        const py = a.y;
        stepTo(g, a, a.x + (a.x - near.x) * 3, a.y + (a.y - near.y) * 3, speed * 1.25, dt);
        // не бежим к домам
        if (dz > ZONE_R - 4 && zoneDist(g, a.x, a.y) < ZONE_R - 4) {
          a.x = px;
          a.y = py;
          stepTo(g, a, a.hx, a.hy, speed * 1.2, dt);
        }
        continue;
      }
      a.state = 'roam';
      if (dz < ZONE_R - 3) {
        animalGo(g, a, a.hx, a.hy, speed * 0.9, dt);
        continue;
      }
      if (a.wait > 0) {
        a.wait -= dt;
        continue;
      }
      if (Math.hypot(a.x - a.tx, a.y - a.ty) < 0.5 || Math.random() < dt * 0.05) {
        const ang = Math.random() * Math.PI * 2;
        const r = rnd(2, 8);
        const tx = a.hx + Math.cos(ang) * r;
        const ty = a.hy + Math.sin(ang) * r * 0.8;
        if (validTile(g, tx, ty) && zoneDist(g, tx, ty) >= ZONE_R - 3) {
          a.tx = tx;
          a.ty = ty;
        }
        a.wait = rnd(1, 6);
        continue;
      }
      const px = a.x;
      const py = a.y;
      stepTo(g, a, a.tx, a.ty, speed * 0.45, dt);
      if (zoneDist(g, a.x, a.y) < ZONE_R - 3 && dz >= ZONE_R - 3) {
        a.x = px;
        a.y = py;
        a.tx = a.hx;
        a.ty = a.hy;
        a.wait = rnd(1, 3);
      }
      continue;
    }

    /* ───── хищники ───── */
    // голод: растёт всегда (зимой быстрее), днём в лесу зверь кормится дичью, пока в лесу есть олени
    a.hun = Math.min(1, a.hun + dt * (winter ? 1 / 100 : 1 / 330));
    if (!winter && !night && !a.raid && deerN >= 2 && dz >= ZONE_R + 2) a.hun = Math.max(0, a.hun - dt / 220);
    // логово накрыто деревней — ищем новое
    if (zoneDist(g, a.hx, a.hy) < ZONE_R + 3 || !forestAt(g, a.hx, a.hy)) rehome(g, a);

    // выход к окраине — только ночью или зимой и только от голода
    const season = night || winter;
    if (!a.raid && season && a.hun > 0.4 && !(a.cool && a.cool > 0)) {
      a.raid = true;
      a.rT = 0;
      if (a.kind === 'wolf') {
        for (const w of L.animals) {
          if (w !== a && w.kind === 'wolf' && !w.raid && (w.hun ?? 0) > 0.25 && !(w.cool && w.cool > 0) && Math.hypot(w.x - a.x, w.y - a.y) < 18) {
            w.raid = true;
            w.rT = 0;
          }
        }
      }
      if (g.time - st.raidT > 40) {
        st.raidT = g.time;
        lifeEvent(g, winter ? 'Зимой голодные хищники подбираются к окраинам' : 'Голодные хищники выходят из леса к окраинам', 'warn');
      }
    } else if (a.raid && (!season || a.hun < 0.12 || (a.cool && a.cool > 0))) {
      a.raid = false;
    }

    // сколько волков в стае (выходят на промысел рядом)
    let pack = 1;
    if (a.kind === 'wolf' && a.raid) for (const w of L.animals) if (w !== a && w.kind === 'wolf' && w.raid && Math.hypot(w.x - a.x, w.y - a.y) < 16) pack++;

    // тревога: хищник подошёл ближе 8 клеток к зданию
    if (dz < ALARM_R) {
      if (!(a.alarm && a.alarm > 0)) {
        if (g.time - st.msgT > 15) {
          st.msgT = g.time;
          g.msg(`🚨 Тревога! ${a.kind === 'wolf' ? 'Волк' : 'Медведь'} у деревни — стража и охотники бегут на зверя`, 'warn');
          g.sfx('horn');
        }
        lifeEvent(g, `Тревога: ${a.kind === 'wolf' ? 'волк' : 'медведь'} у границы деревни`, 'warn');
        g.floatText(a.x * TW, a.y * TH - 22, '🚨', '#ff6a6a');
      }
      a.alarm = 30;
    } else if (dz >= ZONE_R + 2) a.alarm = 0;
    else if (a.alarm && a.alarm > 0) a.alarm = Math.max(0, a.alarm - dt);
    if (a.alarm && a.alarm > 0) callResponders(g, a);

    // испуг: рычит и убегает в лес
    if (a.scare && a.scare > 0) {
      a.scare -= dt;
      a.target = 0;
      a.state = 'flee';
      animalGo(g, a, a.hx, a.hy, speed * 1.25, dt);
      continue;
    }
    {
      const crowd = countPeople(a.x, a.y, 7);
      const limit = a.kind === 'wolf' ? (pack >= 2 ? 5 : 3) : 6;
      const fireK = a.kind === 'wolf' ? 1 : 0.7;
      const fire = fires.some((f) => Math.hypot(f.x - a.x, f.y - a.y) < f.r * fireK);
      if (crowd >= limit || fire) {
        a.scare = rnd(5, 9);
        a.cool = rnd(40, 80);
        a.raid = false;
        a.target = 0;
        a.state = 'flee';
        g.floatText(a.x * TW, a.y * TH - 16, a.kind === 'wolf' ? 'Р-р-р!' : 'Гр-р-р!', '#ffb070');
        animalGo(g, a, a.hx, a.hy, speed * 1.25, dt);
        continue;
      }
    }

    // хищник в деревне вне набега — уходит в лес
    if (settleZone(g, a.x, a.y) && !a.raid) {
      a.target = 0;
      a.state = 'roam';
      animalGo(g, a, a.hx, a.hy, speed * 1.1, dt);
      a.tx = a.x;
      a.ty = a.y;
      a.wait = rnd(0.5, 2);
      continue;
    }

    // выбор добычи
    const preyOk = (u: Unit) => {
      if (u.sleeping || u.spawn > 0 || u.role === 'lord' || u.cb) return false;
      const zd = zoneDist(g, u.x, u.y);
      const others = countPeople(u.x, u.y, 5, u.id);
      if (a.kind === 'wolf' && a.raid && pack >= 2) return zd >= 0.4 && others <= 2; // стая — на крайние дома и пастбища
      if (others > 0) return false; // одиночка нападает только на одиноких
      if (zd < (a.raid ? 3 : ZONE_R + 1)) return false;
      return u.task.type === 'chop' || u.task.type === 'gather' || u.task.type === 'mine' || forestAt(g, u.x, u.y);
    };
    let prey: Unit | null = a.target ? g.units.find((q) => q.id === a.target) ?? null : null;
    const rad = (a.kind === 'bear' ? 5 : 6.5) + (a.raid ? 2 : 0);
    if (prey && (!preyOk(prey) || Math.hypot(prey.x - a.x, prey.y - a.y) > 11 || (!a.raid && Math.hypot(prey.x - a.hx, prey.y - a.hy) > 16))) prey = null;
    if (!prey && a.state !== 'flee') {
      let bd = rad;
      for (const u of g.units) {
        const d = Math.hypot(u.x - a.x, u.y - a.y);
        if (d < bd && preyOk(u)) {
          bd = d;
          prey = u;
        }
      }
      a.target = prey ? prey.id : 0;
    }
    if (a.hp < a.maxhp * 0.3) a.state = 'flee';
    if (a.state === 'flee') {
      animalGo(g, a, a.hx, a.hy, speed * 1.1, dt);
      if (Math.hypot(a.x - a.hx, a.y - a.hy) < 2 && a.hp < a.maxhp) a.hp = Math.min(a.maxhp, a.hp + dt * 0.4);
      if (a.hp >= a.maxhp * 0.7) a.state = 'roam';
      continue;
    }
    if (prey) {
      a.state = 'chase';
      const d = Math.hypot(prey.x - a.x, prey.y - a.y);
      if (d > 0.9) {
        stepTo(g, a, prey.x, prey.y, speed, dt);
        // жертва пугается
        if (prey.role !== 'hunter' && prey.trait !== 'brave' && !(prey.flee && prey.flee > 0)) {
          prey.flee = 3.5;
          if (Math.random() < 0.5) g.floatText(prey.x * TW, prey.y * TH - 22, '!', '#ff6a6a');
        }
      } else if (a.atkT <= 0) {
        a.atkT = 0.9;
        prey.hp -= a.kind === 'bear' ? 3.2 : 1.8;
        a.hun = Math.max(0, (a.hun ?? 0) - 0.12);
        g.spark(prey.x * TW, prey.y * TH - 8, '#d83a3a', 3);
        g.sfx('chop', prey.x * TW, prey.y * TH);
        if (prey.hp <= 0) {
          killPerson(g, prey, a.kind === 'wolf' ? 'растерзан волком в лесу' : 'задран медведем в лесу');
          a.hun = 0;
          a.target = 0;
          a.state = 'roam';
        } else if (prey.trait === 'brave' || prey.role === 'hunter') a.hp -= 1.2;
      }
      continue;
    }
    a.state = 'roam';

    // набег на окраину: стая — к крайним домам/пастбищам, одиночка — крадётся у границы
    if (a.raid) {
      a.rT = (a.rT ?? 0) - dt;
      const reached = a.rx !== undefined && a.ry !== undefined && Math.hypot(a.x - a.rx, a.y - a.ry) < 1.2;
      if (a.rx === undefined || a.ry === undefined || a.rT <= 0) {
        // ближайшее к зверю здание — крайнее со стороны леса
        let best: Building | null = null;
        let bd = 1e9;
        for (const b of g.buildings) {
          if (!b.done || isWallB(b)) continue;
          const d = Math.hypot(b.x + b.w / 2 - a.x, b.y + b.h / 2 - a.y);
          if (d < bd) {
            bd = d;
            best = b;
          }
        }
        if (!best) {
          a.raid = false;
        } else {
          const cx = best.x + best.w / 2;
          const cy = best.y + best.h / 2;
          const base = Math.atan2(a.y - cy, a.x - cx);
          const stand = pack >= 2 ? 2.8 : ZONE_R - 0.8;
          let ok = false;
          for (const da of [0, 0.5, -0.5, 1, -1, 1.6, -1.6]) {
            const ang = base + da + rnd(-0.2, 0.2);
            const r = Math.max(best.w, best.h) / 2 + stand;
            const x = cx + Math.cos(ang) * r;
            const y = cy + Math.sin(ang) * r;
            if (validTile(g, x, y) && (pack >= 2 || zoneDist(g, x, y) >= ALARM_R + 0.8)) {
              a.rx = x;
              a.ry = y;
              a.rb = best.id;
              ok = true;
              break;
            }
          }
          if (!ok) {
            a.rx = a.hx;
            a.ry = a.hy;
          }
          a.rT = rnd(12, 25);
          a.rSteal = 0;
        }
      }
      if (a.raid && a.rx !== undefined && a.ry !== undefined) {
        if (!reached) animalGo(g, a, a.rx, a.ry, speed * 0.75, dt);
        else {
          a.moving = false;
          // стая на пастбище: задирает скот
          const rb = g.buildings.find((q) => q.id === a.rb);
          if (pack >= 2 && rb && (/pasture|farm|field|barn|cattle/.test(rb.type) || BUILDINGS[rb.type]?.food)) {
            a.rSteal = (a.rSteal ?? 0) + dt;
            if (a.rSteal > 7) {
              a.rSteal = 0;
              const lost = Math.min(g.res.food, 6);
              if (lost >= 1) {
                g.spend('food', lost);
                a.hun = Math.max(0, (a.hun ?? 0) - 0.3);
                g.floatText(a.x * TW, a.y * TH - 14, `−${Math.round(lost)}🍖`, '#ff9a8a');
                lifeEvent(g, `Волки задрали скот у «${BUILDINGS[rb.type]?.name ?? 'пастбища'}» (−${Math.round(lost)} еды)`, 'warn');
              }
            }
          }
        }
        continue;
      }
    }

    // блуждание в глубине леса
    if (a.wait > 0) {
      a.wait -= dt;
      continue;
    }
    if (Math.hypot(a.x - a.tx, a.y - a.ty) < 0.5 || Math.random() < dt * 0.05) {
      const ang = Math.random() * Math.PI * 2;
      const r = rnd(2, 8);
      const tx = a.hx + Math.cos(ang) * r;
      const ty = a.hy + Math.sin(ang) * r * 0.8;
      if (validTile(g, tx, ty) && forestAt(g, tx, ty) && !settleZone(g, tx, ty, 2)) {
        a.tx = tx;
        a.ty = ty;
      }
      a.wait = rnd(1, 6);
      continue;
    }
    const ox = a.x;
    const oy = a.y;
    stepTo(g, a, a.tx, a.ty, speed * 0.45, dt);
    if (settleZone(g, a.x, a.y, 1)) {
      a.x = ox;
      a.y = oy;
      a.tx = a.hx;
      a.ty = a.hy;
      a.wait = rnd(1, 3);
    }
  }
  L.animalT -= dt;
  if (L.animalT <= 0) {
    L.animalT = 100;
    const cnt = (k: string) => L.animals.filter((q) => q.kind === k).length;
    const n = Math.max(2, Math.round(g.world.w / 24));
    if (cnt('wolf') < n) spawnAnimal(g, 'wolf');
    if (cnt('bear') < Math.max(1, n - 2) && Math.random() < 0.5) spawnAnimal(g, 'bear');
    if (cnt('deer') < n + 1) spawnAnimal(g, 'deer');
  }
}

/* ───────────── Странники ───────────── */

function questFor(kind: VisitorKind): QuestDef {
  if (kind === 'smith')
    return { id: 'coal', title: 'Уголь для горна', text: 'Кузнецу нужно 20 камня и 10 дерева — он выкует вам партию товаров и поможет мастерским.', kind: 'bring', need: { stone: 20, wood: 10 }, kill: 0, reward: { goods: 10, craft: 300 }, rewardText: '+10 товаров, мастера работают на 60% быстрее 5 минут' };
  if (kind === 'witch')
    return { id: 'berries', title: 'Ягоды для зелья', text: 'Ведьма варит зелье и просит 25 еды. Взамен — эликсир жизни.', kind: 'bring', need: { food: 25 }, kill: 0, reward: { child: 2, birth: 180, memory: 4 }, rewardText: 'Рождаются дети, рождаемость выше 3 минуты' };
  return { id: 'wolfhunt', title: 'Охота на хищников', text: 'Рыцарь просит убить 3 хищника в окрестностях (волки, медведи). Стража и охотники помогут.', kind: 'kill', need: {}, kill: 3, reward: { gold: 45, memory: 8, atk: 240 }, rewardText: '+45 золота, воины воодушевлены (+12% силы 4 минуты)' };
}

export function offersFor(kind: VisitorKind): Offer[] {
  if (kind === 'smith') return [{ id: 'sharpen', label: 'Заточить оружие', desc: 'Армия сильнее на 12% на 4 минуты', cost: { gold: 25 } }];
  if (kind === 'witch') return [{ id: 'potion', label: 'Зелье бодрости', desc: 'Работа быстрее на 15–20% три минуты', cost: { gold: 20 } }];
  return [{ id: 'hire', label: 'Нанять рыцаря', desc: 'Рыцарь вступает в войско героем (сила ×2.2)', cost: { gold: 30, food: 25 } }];
}

function spawnVisitor(g: Game) {
  const L = g.life;
  const kinds: VisitorKind[] = ['smith', 'witch', 'knight'];
  const kind = kinds[Math.floor(Math.random() * kinds.length)];
  const sp = spawnPoint(g, 24, 32);
  if (!sp) return;
  const u = g.newUnit(sp.x, sp.y, false);
  u.role = 'visitor';
  u.look = randomLook(Math.random);
  if (kind === 'smith') {
    u.look = { ...u.look, female: false, beard: true, outfit: 1, cloth: 0, acc: 0 };
    u.name = SMITH_NAMES[Math.floor(Math.random() * SMITH_NAMES.length)];
  } else if (kind === 'witch') {
    u.look = { ...u.look, female: true, outfit: 2, cloth: 2, hair: 4, style: 1, acc: 2 };
    u.name = WITCH_NAMES[Math.floor(Math.random() * WITCH_NAMES.length)];
  } else {
    u.look = { ...u.look, female: false, outfit: 0, cloth: 3, beard: Math.random() < 0.5, acc: 0 };
    u.name = KNIGHT_NAMES[Math.floor(Math.random() * KNIGHT_NAMES.length)];
  }
  const c = campPos(g);
  const v: Visitor = { id: L.idc++, kind, name: u.name, unit: u, state: 'arrive', timer: 260, quest: { def: questFor(kind), accepted: false, killBase: 0, done: false }, used: {}, tx: c.x + rnd(-2.5, 2.5), ty: c.y + rnd(0.5, 2.5) };
  L.visitors.push(v);
  const txt = `${VISITORS[kind].greet}: ${u.name}. Откройте «Жизнь» [N]`;
  g.msg(txt, 'good');
  lifeEvent(g, txt, 'good');
}

function visitorsAI(g: Game, dt: number) {
  const L = g.life;
  for (let i = L.visitors.length - 1; i >= 0; i--) {
    const v = L.visitors[i];
    const u = v.unit;
    if (v.state === 'arrive') {
      u.phase = 'goto';
      if (stepTo(g, u, v.tx, v.ty, 1.5, dt)) {
        v.state = 'wait';
        u.moving = false;
      }
    } else if (v.state === 'wait') {
      v.timer -= dt;
      u.moving = false;
      if (Math.random() < dt * 0.05) {
        v.tx += rnd(-1.5, 1.5);
        v.ty += rnd(-1, 1);
        if (!validTile(g, v.tx, v.ty)) {
          const c = campPos(g);
          v.tx = c.x;
          v.ty = c.y + 1;
        }
      }
      if (Math.hypot(u.x - v.tx, u.y - v.ty) > 0.4) stepTo(g, u, v.tx, v.ty, 0.9, dt);
      if (v.timer <= 0) {
        v.state = 'leave';
        g.msg(`${v.name} уходит дальше по дорогам`, 'info');
      }
    } else {
      const sp = spawnPoint(g, 25, 32) ?? { x: u.x + 30, y: u.y };
      if (!u.gTarget) u.gTarget = sp;
      const done = stepTo(g, u, u.gTarget.x, u.gTarget.y, 1.6, dt);
      const far = Math.hypot(u.x - campPos(g).x, u.y - campPos(g).y) > 22;
      if (done || far) L.visitors.splice(i, 1);
    }
  }
  L.visitT -= dt;
  if (L.visitT <= 0) {
    L.visitT = rnd(220, 380);
    if (L.visitors.length < 2 && g.time > 90) spawnVisitor(g);
  }
}

export function canAfford(g: Game, need: Need) {
  return Object.keys(need).every((k) => stockOf(g, k) >= need[k]);
}
function spendNeed(g: Game, need: Need) {
  for (const k of Object.keys(need)) {
    if (k in ITEMS) g.life.items[k] -= need[k];
    else g.spend(k as 'wood', need[k]);
  }
}
function applyReward(g: Game, r: Reward) {
  const L = g.life;
  if (r.gold) g.gain('gold', r.gold);
  if (r.goods) g.gain('goods', r.goods);
  if (r.food) g.gain('food', r.food);
  if (r.wood) g.gain('wood', r.wood);
  if (r.stone) g.gain('stone', r.stone);
  if (r.atk) L.buffs.atk = Math.max(L.buffs.atk, r.atk);
  if (r.work) L.buffs.work = Math.max(L.buffs.work, r.work);
  if (r.birth) L.buffs.birth = Math.max(L.buffs.birth, r.birth);
  if (r.craft) L.buffs.craft = Math.max(L.buffs.craft, r.craft);
  if (r.memory) L.memory = Math.min(60, L.memory + r.memory);
  if (r.child) for (let i = 0; i < r.child; i++) if (g.totalPop() < g.housingCap()) g.spawnChild();
  g.refreshMods();
}

export function acceptQuest(g: Game, vid: number) {
  const v = g.life.visitors.find((q) => q.id === vid);
  if (!v || !v.quest || v.quest.accepted) return;
  v.quest.accepted = true;
  v.quest.killBase = g.life.kills;
  g.msg(`Задание принято: «${v.quest.def.title}»`, 'info');
}

export function questProgress(g: Game, v: Visitor): { have: number; need: number; ok: boolean } {
  const q = v.quest;
  if (!q) return { have: 0, need: 1, ok: false };
  if (q.def.kind === 'kill') {
    const have = Math.min(q.def.kill, g.life.kills - q.killBase);
    return { have, need: q.def.kill, ok: have >= q.def.kill };
  }
  return { have: 0, need: 1, ok: canAfford(g, q.def.need) };
}

export function turnInQuest(g: Game, vid: number): string | null {
  const v = g.life.visitors.find((q) => q.id === vid);
  if (!v || !v.quest || !v.quest.accepted || v.quest.done) return 'Нет задания';
  const pr = questProgress(g, v);
  if (!pr.ok) return 'Условия не выполнены';
  spendNeed(g, v.quest.def.need);
  applyReward(g, v.quest.def.reward);
  v.quest.done = true;
  g.msg(`Задание «${v.quest.def.title}» выполнено! ${v.quest.def.rewardText}`, 'good');
  lifeEvent(g, `Задание выполнено: ${v.quest.def.title}`, 'good');
  g.sfx('fanfare');
  return null;
}

export function buyOffer(g: Game, vid: number, offerId: string): string | null {
  const v = g.life.visitors.find((q) => q.id === vid);
  if (!v) return 'Странник ушёл';
  const o = offersFor(v.kind).find((q) => q.id === offerId);
  if (!o || v.used[offerId]) return 'Недоступно';
  if (!canAfford(g, o.cost)) return 'Не хватает ресурсов';
  spendNeed(g, o.cost);
  v.used[offerId] = true;
  if (offerId === 'sharpen') applyReward(g, { atk: 240 });
  else if (offerId === 'potion') applyReward(g, { work: 180 });
  else if (offerId === 'hire') {
    g.life.heroes.push(`Сэр ${v.name}`);
    g.army++;
    v.state = 'leave';
  }
  g.msg(`${v.name}: «${o.label}» — сделка заключена`, 'good');
  g.sfx('coin');
  return null;
}

/* ───────────── Захват пустых земель ───────────── */

export function ownerAt(g: Game, tx: number, ty: number): number {
  const T = g.terr;
  if (!T || tx < 0 || ty < 0 || tx >= T.w || ty >= T.h) return 0;
  return T.owner[ty * T.w + tx];
}

export function claimCost(g: Game) {
  const n = g.life.claims.filter((c) => c.owner === 0).length;
  return { gold: 8 + n * 3, wood: 12 + n * 2, food: 6 };
}

export function claimWhy(g: Game, tx: number, ty: number): string | null {
  const w = g.world;
  if (tx < 2 || ty < 2 || tx >= w.w - 2 || ty >= w.h - 2) return 'Слишком близко к краю карты';
  if (w.biome[ty * w.w + tx] <= B.WATER) return 'Нельзя занять воду';
  if (ownerAt(g, tx, ty) !== 0) return 'Земля уже занята';
  let near = false;
  for (let dy = -9; dy <= 9 && !near; dy++)
    for (let dx = -9; dx <= 9; dx++) {
      if (Math.hypot(dx, dy) > 9) continue;
      const o = ownerAt(g, tx + dx, ty + dy);
      if (o && isStateOwner(g, o)) {
        near = true;
        break;
      }
    }
  if (!near) return 'Земля слишком далеко от ваших границ (до 9 клеток)';
  const c = claimCost(g);
  if (g.res.gold < c.gold || g.res.wood < c.wood || g.res.food < c.food) return `Нужно: ${c.gold} золота, ${c.wood} дерева, ${c.food} еды`;
  return null;
}

export function claimLand(g: Game, tx: number, ty: number): string | null {
  const why = claimWhy(g, tx, ty);
  if (why) {
    g.msg(why, 'warn');
    return why;
  }
  const c = claimCost(g);
  g.spend('gold', c.gold);
  g.spend('wood', c.wood);
  g.spend('food', c.food);
  g.life.claims.push({ id: g.life.idc++, x: tx, y: ty, r: 5, owner: 0, t: g.time });
  g.msg('Пустая земля занята! Новые угодья приносят еду и золото', 'good');
  g.sfx('fanfare');
  g.particles.push({ x: tx * TW + 8, y: ty * TH, vx: 0, vy: -10, life: 1.2, max: 1.2, color: '#ffe27a', size: 0, grav: 0, text: '⚑' });
  return null;
}

export function claimStamps(g: Game): { x: number; y: number; r: number; code: number }[] {
  const out: { x: number; y: number; r: number; code: number }[] = [];
  for (const c of g.life.claims) {
    if (c.owner === 0) out.push({ x: c.x + 0.5, y: c.y + 0.5, r: c.r, code: 1 });
    else {
      const ti = g.towns.findIndex((t) => t.id === c.owner);
      if (ti >= 0) out.push({ x: c.x + 0.5, y: c.y + 0.5, r: c.r, code: 2 + ti });
    }
  }
  return out;
}

function botClaims(g: Game, dt: number) {
  const L = g.life;
  g.towns.forEach((t, idx) => {
    if (t.owner !== 'free') return;
    L.botT[t.id] = (L.botT[t.id] ?? rnd(40, 120)) - dt;
    if (L.botT[t.id] > 0) return;
    L.botT[t.id] = rnd(150, 280) * (t.aggr > 0.5 ? 0.8 : 1.1);
    const mine = L.claims.filter((c) => c.owner === t.id).length;
    const vas = g.towns.filter((q) => q.overlord === t.id).length;
    if (t.overlord != null || t.pop < 9 || mine >= Math.min(4 + vas * 2, 1 + Math.floor(t.pop / 10) + vas)) return;
    for (let k = 0; k < 24; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = rnd(6, 11);
      const tx = Math.round(t.x + Math.cos(a) * r);
      const ty = Math.round(t.y + Math.sin(a) * r);
      if (tx < 3 || ty < 3 || tx >= g.world.w - 3 || ty >= g.world.h - 3) continue;
      if (g.world.biome[ty * g.world.w + tx] <= B.WATER || ownerAt(g, tx, ty) !== 0) continue;
      // клетка должна примыкать к их землям
      let touch = false;
      for (let dy = -7; dy <= 7 && !touch; dy++) for (let dx = -7; dx <= 7; dx++) if (Math.hypot(dx, dy) <= 7 && ownerAt(g, tx + dx, ty + dy) === 2 + idx) { touch = true; break; }
      if (!touch) continue;
      L.claims.push({ id: L.idc++, x: tx, y: ty, r: 5, owner: t.id, t: g.time });
      const camp = campPos(g);
      if (Math.hypot(tx - camp.x, ty - camp.y) < 34) {
        const txt = `«${t.name}» занимает пустые земли неподалёку от вас`;
        g.msg(txt, 'info');
        lifeEvent(g, txt, 'info');
      }
      break;
    }
  });
}

/* ───────────── Главный цикл ───────────── */

export function lifeInit(g: Game) {
  g.life = createLife();
  g.guards = [];
}

export function lifeAfterStart(g: Game) {
  lifeStart(g);
  initAnimals(g);
}

export function lifeUpdate(g: Game, dt: number) {
  const L = g.life;
  const hour = hourOf(g);
  const nightNow = g.dayT >= 0.84 || g.dayT < 0.2;
  L.evening = hour >= 18 && hour < 21;
  if (nightNow !== L.sleepTime) {
    L.sleepTime = nightNow;
    if (nightNow) {
      g.msg('Наступила ночь: жители расходятся по домам, на улицах загораются факелы', 'info');
      nightRaids(g);
    } else {
      g.msg('Рассвет! Жители просыпаются и идут за работу', 'info');
    }
  }
  if (g.dev.alwaysDay) L.sleepTime = false;
  // бафф-таймеры
  for (const k of Object.keys(L.buffs) as (keyof LifeState['buffs'])[]) if (L.buffs[k] > 0) L.buffs[k] = Math.max(0, L.buffs[k] - dt);
  L.battleT = Math.max(0, L.battleT - dt);
  L.memory = Math.max(0, L.memory - dt * 0.04);
  syncGuards(g);
  guardsAI(g, dt);
  raidersAI(g, dt);
  animalsAI(g, dt);
  visitorsAI(g, dt);
  botClaims(g, dt);
  // медленные задачи
  L.slowT -= dt;
  if (L.slowT <= 0) {
    L.slowT = 1;
    staffBuildings(g);
    updateMorale(g);
    // дети взрослеют
    for (const u of g.units) {
      const p = L.people.get(u.id);
      if (p && p.role === 'child' && !u.child) {
        p.role = 'worker';
        personLog(g, u.id, `Вырос${p.female ? 'ла' : ''} и стал${p.female ? 'а' : ''} помогать семье`);
      }
    }
    // угодья дают понемногу
    const mine = L.claims.filter((c) => c.owner === 0).length;
    if (mine) {
      g.gain('food', mine * 0.05);
      g.gain('gold', mine * 0.03);
    }
    // сон: «z» над домами
    if (L.sleepTime) {
      const sl = g.units.filter((u) => u.sleeping);
      if (sl.length && Math.random() < 0.7) {
        const u = sl[Math.floor(Math.random() * sl.length)];
        const h = g.buildings.find((b) => b.id === u.home);
        if (h) g.floatText(h.x * TW + h.w * 8 + rnd(-4, 4), h.y * TH + 4, 'z', '#cfe0ff');
      }
    }
  }
  L.gearT -= dt;
  if (L.gearT <= 0) {
    L.gearT = 4;
    let ch = false;
    for (const u of g.guards) if (equip(g, u)) ch = true;
    for (const u of g.units) if (u.role === 'hunter' && u.gear) {
      const cur = u.gear.weapon;
      for (const w of ['bow', 'spear', 'club']) {
        if (cur === w) break;
        if ((L.items[w] ?? 0) >= 1 && weaponPow(w) > weaponPow(cur)) {
          if (cur) L.items[cur]++;
          L.items[w]--;
          u.gear.weapon = w;
          ch = true;
          break;
        }
      }
    }
    if (ch) g.refreshMods();
  }
  L.modsT -= dt;
  if (L.modsT <= 0) {
    L.modsT = 10;
    g.refreshMods();
  }
  void RECIPES;
  void TRAITS;
  void TH;
  void (null as unknown as BuildingId);
  void randomTrait;
}

export function lifeBrief(g: Game) {
  const L = g.life;
  return {
    night: L.sleepTime,
    visitors: L.visitors.filter((v) => v.state !== 'leave').length,
    fallen: L.fallen.length,
    morale: Math.round(L.moraleBonus * 100),
    guards: g.guards.length,
    predators: L.animals.filter((a) => a.kind !== 'deer').length,
    raiders: L.raiders.length,
    claims: L.claims.filter((c) => c.owner === 0).length,
    hunters: hunters(g).length,
    graves: L.graves.length,
  };
}
export type LifeBrief = ReturnType<typeof lifeBrief>;
