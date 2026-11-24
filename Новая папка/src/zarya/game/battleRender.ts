import { TH, TW } from './data';
import type { Game, Unit } from './game';
import type { March } from './towns';
import { allArmies, isRival, projectiles, teamColor, type Campaign } from './battle';
import { drawFlag } from './fx';
import { itemCount } from './life';

type Ctx = CanvasRenderingContext2D;

/* ───────────── Отрисовка реальных походов и сражений ───────────── */

/** полоска здоровья бойца (рисуется поверх спрайта) */
export function drawCombatBar(ctx: Ctx, u: Unit, fx: number, fy: number) {
  const cb = u.cb;
  if (!cb) return;
  if (cb.mode === 'march' && cb.hp >= cb.max && !u.sel) return;
  if (cb.side === 'c' && cb.hp >= cb.max) return;
  const w = 12;
  const x = Math.round(fx - w / 2);
  const y = Math.round(fy) - 27;
  const f = Math.max(0, Math.min(1, cb.hp / cb.max));
  ctx.fillStyle = '#12121a';
  ctx.fillRect(x - 1, y - 1, w + 2, 4);
  ctx.fillStyle = f > 0.6 ? '#5bd86a' : f > 0.3 ? '#e8c43a' : '#e0503a';
  ctx.fillRect(x, y, Math.max(1, Math.round(w * f)), 2);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(x, y, Math.max(1, Math.round(w * f)), 1);
  if (cb.side !== 'c') {
    ctx.fillStyle = teamColor(cb.team);
    ctx.fillRect(x - 4, y - 1, 2, 4);
  }
}

function inView(x: number, y: number, left: number, top: number, vw: number, vh: number, m = 60) {
  const px = x * TW;
  const py = y * TH;
  return px > left - m && px < left + vw + m && py > top - m && py < top + vh + m;
}

function drawFires(ctx: Ctx, g: Game, left: number, top: number, vw: number, vh: number) {
  const t = g.waterT;
  for (const town of g.towns) {
    if (!town.fires?.length) continue;
    for (const f of town.fires) {
      const b = town.bld.find((q) => q.id === f.id);
      if (!b || !inView(b.x + b.w / 2, b.y + b.h / 2, left, top, vw, vh, 80)) continue;
      const k = Math.min(1, f.t / 3);
      const x0 = b.x * TW;
      const bw = b.w * TW;
      const base = (b.y + b.h) * TH;
      const hh = b.h * TH + 14;
      // закопчённые стены
      ctx.globalAlpha = 0.34 * k;
      ctx.fillStyle = '#120a06';
      ctx.fillRect(x0, base - hh, bw, hh);
      ctx.globalAlpha = 1;
      const n = Math.max(3, Math.round(bw / 4));
      for (let i = 0; i < n; i++) {
        const fx = x0 + 2 + (i * (bw - 4)) / Math.max(1, n - 1);
        const ph = i * 1.7 + b.id;
        const h = (5 + Math.sin(t * 11 + ph) * 3 + (i % 3) * 2) * (0.4 + 0.6 * k);
        const y = base - 2 - Math.abs(Math.sin(i * 2.1 + b.id)) * (hh - 12);
        ctx.fillStyle = '#e83a14';
        ctx.fillRect(Math.round(fx - 2), Math.round(y - h), 4, Math.round(h));
        ctx.fillStyle = '#ff9a2a';
        ctx.fillRect(Math.round(fx - 1), Math.round(y - h * 0.8), 2, Math.round(h * 0.8));
        ctx.fillStyle = '#ffe680';
        ctx.fillRect(Math.round(fx), Math.round(y - h * 0.5), 1, Math.max(1, Math.round(h * 0.4)));
      }
    }
  }
}

function drawShip(ctx: Ctx, g: Game, c: Campaign, col: string) {
  const sh = c.ship;
  if (!sh) return;
  const bx = Math.round(sh.x * TW - 13);
  const by = Math.round(sh.y * TH - 12 + Math.sin(g.waterT * 3 + sh.x) * 1);
  ctx.fillStyle = 'rgba(8,24,48,0.28)';
  ctx.fillRect(bx + 1, by + 12, 24, 2);
  ctx.fillStyle = '#4a2e18';
  ctx.fillRect(bx, by + 7, 26, 4);
  ctx.fillRect(bx + 3, by + 11, 20, 1);
  ctx.fillStyle = '#8a5e36';
  ctx.fillRect(bx, by + 7, 26, 1);
  ctx.fillStyle = '#6a4524';
  ctx.fillRect(bx + 24, by + 5, 3, 2);
  ctx.fillRect(bx + 12, by - 9, 1, 17);
  ctx.fillStyle = '#f4ecd8';
  ctx.fillRect(bx + 13, by - 8, 9, 11);
  ctx.fillStyle = '#d8ccae';
  ctx.fillRect(bx + 13, by + 1, 9, 2);
  ctx.fillStyle = col;
  ctx.fillRect(bx + 14, by - 6, 7, 2);
  ctx.fillStyle = col;
  ctx.fillRect(bx + 12, by - 11, 5, 2);
  // воины на палубе
  const n = Math.min(8, c.squad?.length ?? 0);
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = i % 2 ? '#c8d0e0' : '#9aa6bc';
    ctx.fillRect(bx + 2 + i * 3, by + 3 + (i % 2), 2, 4);
    ctx.fillStyle = '#e8c8a0';
    ctx.fillRect(bx + 2 + i * 3, by + 2 + (i % 2), 2, 1);
  }
}

function drawCatapult(ctx: Ctx, g: Game, x: number, y: number, ph: number) {
  const px = Math.round(x);
  const py = Math.round(y);
  ctx.fillStyle = 'rgba(10,10,24,0.28)';
  ctx.fillRect(px - 6, py, 14, 2);
  ctx.fillStyle = '#5a3a1c';
  ctx.fillRect(px - 6, py - 5, 14, 3);
  ctx.fillStyle = '#8a5e36';
  ctx.fillRect(px - 6, py - 5, 14, 1);
  ctx.fillStyle = '#222';
  ctx.fillRect(px - 5, py - 2, 3, 3);
  ctx.fillRect(px + 3, py - 2, 3, 3);
  const swing = Math.sin(Math.min(1, ph) * Math.PI);
  ctx.fillStyle = '#7a5230';
  for (let i = 0; i < 9; i++) ctx.fillRect(px - 2 + Math.round(i * (0.7 + swing * 0.4)), py - 6 - Math.round(i * (1.0 - swing * 1.2)), 2, 1);
  void g;
}

function drawCapture(ctx: Ctx, g: Game, c: Campaign, x: number, y: number, col: string) {
  const k = Math.max(0, Math.min(1, c.capT ?? 0));
  const px = Math.round(x * TW);
  const py = Math.round(y * TH);
  // шест и поднимающееся знамя
  const ph = 26;
  ctx.fillStyle = '#2a1c10';
  ctx.fillRect(px - 1, py - ph - 1, 3, ph + 1);
  ctx.fillStyle = '#9a7448';
  ctx.fillRect(px, py - ph, 1, ph);
  ctx.fillStyle = '#ffe27a';
  ctx.fillRect(px - 1, py - ph - 2, 3, 2);
  const fy = py - 5 - Math.round(k * (ph - 12));
  const len = 11;
  for (let i = 0; i < len; i++) {
    const yo = Math.round(Math.sin(g.waterT * 6 - i * 0.8) * (0.4 + i * 0.12));
    ctx.fillStyle = col;
    ctx.fillRect(px + 1 + i, fy + yo, 1, 6 - (i > len - 3 ? 1 : 0));
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fillRect(px + 1 + i, fy + yo, 1, 1);
  }
  // шкала захвата
  const w = 30;
  const bx = px - w / 2;
  const by = py - ph - 12;
  ctx.fillStyle = '#12121a';
  ctx.fillRect(bx - 1, by - 1, w + 2, 6);
  ctx.fillStyle = '#3a3a48';
  ctx.fillRect(bx, by, w, 4);
  ctx.fillStyle = col;
  ctx.fillRect(bx, by, Math.round(w * k), 4);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillRect(bx, by, Math.round(w * k), 1);
  ctx.font = '5px "Press Start 2P", monospace';
  ctx.textAlign = 'center';
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#1a1018';
  const txt = 'ЗАХВАТ';
  ctx.strokeText(txt, px, by - 3);
  ctx.fillStyle = '#ffe9a8';
  ctx.fillText(txt, px, by - 3);
}

function drawRazeBar(ctx: Ctx, c: Campaign, x: number, y: number, max: number) {
  const k = Math.max(0, Math.min(1, (c.razeT ?? 0) / max));
  const px = Math.round(x * TW);
  const py = Math.round(y * TH);
  const w = 30;
  const by = py - 36;
  ctx.fillStyle = '#12121a';
  ctx.fillRect(px - w / 2 - 1, by - 1, w + 2, 6);
  ctx.fillStyle = '#3a2a22';
  ctx.fillRect(px - w / 2, by, w, 4);
  ctx.fillStyle = '#ff7a2a';
  ctx.fillRect(px - w / 2, by, Math.round(w * k), 4);
  ctx.font = '5px "Press Start 2P", monospace';
  ctx.textAlign = 'center';
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#1a1018';
  ctx.strokeText('ПОДЖОГ', px, by - 3);
  ctx.fillStyle = '#ffd0a0';
  ctx.fillText('ПОДЖОГ', px, by - 3);
}

export function drawBattleFx(ctx: Ctx, g: Game, left: number, top: number, vw: number, vh: number) {
  drawFires(ctx, g, left, top, vw, vh);
  const cats = Math.min(4, itemCount(g, 'catapult'));
  for (const c of allArmies(g)) {
    const rival = isRival(c);
    const m = c as March;
    const incoming = !rival && m.incoming;
    const player = !rival && !m.incoming;
    const team = rival ? (c as { from: number }).from : player ? 0 : m.townId;
    const col = teamColor(team);
    const ph = c.phase ?? 'go';
    const squad = c.squad ?? [];
    // линия маршрута: ваш поход и набег на вас
    if (!rival && c.legs && ph !== 'fight' && ph !== 'capture' && ph !== 'raze') {
      ctx.globalAlpha = 0.5;
      for (let li = c.li ?? 0; li < c.legs.length; li++) {
        const leg = c.legs[li];
        ctx.fillStyle = leg.k === 'sail' ? '#bfe4ff' : incoming ? '#ff6a5a' : ph === 'back' ? '#c8d8ff' : '#ffe27a';
        for (let i = 0; i < leg.p.length; i += 3) {
          const p = leg.p[i];
          const x = p.x * TW + TW / 2;
          const y = p.y * TH + TH * 0.7;
          if (x < left - 4 || x > left + vw + 4 || y < top - 4 || y > top + vh + 4) continue;
          ctx.fillRect(Math.round(x), Math.round(y), 2, 1);
        }
      }
      ctx.globalAlpha = 1;
    }
    drawShip(ctx, g, c, col);
    if (!squad.length) continue;
    let cx = 0;
    let cy = 0;
    let n = 0;
    for (const u of squad) {
      cx += u.x;
      cy += u.y;
      n++;
    }
    cx /= n;
    cy /= n;
    if (!inView(cx, cy, left, top, vw, vh, 120)) continue;
    // знамя и счётчик над походным отрядом
    if (ph === 'go' || ph === 'back') {
      const sx = Math.round(cx * TW);
      const sy = Math.round(cy * TH) - 22;
      drawFlag(ctx, g, sx, sy, col, 1.0);
      ctx.font = '5px "Press Start 2P", monospace';
      ctx.textAlign = 'center';
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#1a1018';
      const label = `×${n}`;
      ctx.strokeText(label, sx, sy - 18);
      ctx.fillStyle = incoming ? '#ff9a8a' : '#ffe9a8';
      ctx.fillText(label, sx, sy - 18);
    }
    // катапульты осаждающих
    if (player && ph === 'fight' && cats > 0) {
      const tg = squad[0];
      const vx = tg.x - cx;
      const vy = tg.y - cy;
      const d = Math.hypot(vx, vy) || 1;
      for (let i = 0; i < cats; i++) drawCatapult(ctx, g, (cx - (vx / d) * 3.5 + (i - cats / 2) * 0.9) * TW, (cy - (vy / d) * 3.5 + (i % 2) * 0.5) * TH, 1 - Math.max(0, (c.catT ?? 0) / 4.2) * cats);
    }
  }
  // захват центра и поджог
  for (const c of allArmies(g)) {
    const ph = c.phase ?? 'go';
    if (ph !== 'capture' && ph !== 'raze') continue;
    const rival = isRival(c);
    const m = c as March;
    if (!rival && m.incoming) continue;
    const t = g.towns.find((q) => q.id === (rival ? (c as { to: number }).to : m.townId));
    if (!t) continue;
    const x = t.x + 0.5;
    const y = t.y + 1.5;
    if (!inView(x, y, left, top, vw, vh, 80)) continue;
    const team = rival ? (c as { from: number }).from : 0;
    if (ph === 'capture') drawCapture(ctx, g, c, x, y, teamColor(team));
    else drawRazeBar(ctx, c, x, y, 16);
  }
  // снаряды
  for (const p of projectiles()) {
    const k = Math.min(1, p.t / p.dur);
    const gx = (p.x + (p.tx - p.x) * k) * TW;
    const gy = (p.y + (p.ty - p.y) * k) * TH;
    const z = (p.kind === 'bullet' ? 9 : 9) + p.arc * 4 * k * (1 - k) + (p.kind === 'rock' ? 4 : 0);
    const px = Math.round(gx);
    const py = Math.round(gy - z);
    if (px < left - 10 || px > left + vw + 10 || py < top - 40 || py > top + vh + 10) continue;
    // направление полёта на экране
    const k2 = Math.min(1, k + 0.04);
    const z2 = 9 + p.arc * 4 * k2 * (1 - k2) + (p.kind === 'rock' ? 4 : 0);
    let ux = (p.x + (p.tx - p.x) * k2) * TW - gx;
    let uy = (p.y + (p.ty - p.y) * k2) * TH - z2 - (gy - z);
    const ul = Math.hypot(ux, uy) || 1;
    ux /= ul;
    uy /= ul;
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#000';
    ctx.fillRect(px, Math.round(gy), p.kind === 'rock' ? 4 : 2, 1);
    ctx.globalAlpha = 1;
    if (p.kind === 'rock') {
      ctx.fillStyle = '#4a4034';
      ctx.fillRect(px - 2, py - 2, 5, 5);
      ctx.fillStyle = '#8a7e6a';
      ctx.fillRect(px - 2, py - 2, 3, 3);
    } else if (p.kind === 'bullet') {
      ctx.fillStyle = 'rgba(255,176,64,0.7)';
      for (let i = 1; i <= 4; i++) ctx.fillRect(Math.round(px - ux * i * 2), Math.round(py - uy * i * 2), 1, 1);
      ctx.fillStyle = '#fff6c0';
      ctx.fillRect(px, py, 2, 2);
    } else {
      const len = p.kind === 'bolt' ? 3 : 4;
      ctx.fillStyle = p.kind === 'bolt' ? '#8a92a4' : '#c8b088';
      for (let i = 1; i < len; i++) ctx.fillRect(Math.round(px - ux * i), Math.round(py - uy * i), 1, 1);
      ctx.fillStyle = '#eef2fa';
      ctx.fillRect(px, py, 1, 1);
      ctx.fillStyle = '#d8503a';
      ctx.fillRect(Math.round(px - ux * len), Math.round(py - uy * len), 1, 1);
    }
  }
}
