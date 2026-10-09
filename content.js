// Spider Crawler content script (v3).
// One big spider drawn on a canvas overlay. Legs use 2-bone inverse kinematics:
// feet stay planted on the page while the body moves, then step in an
// alternating tetrapod gait.
//
// Hunting: if `hunt` is set, each visible link is judged (by the Jev decision
// model through background.js when a key is configured, otherwise by keyword).
// Matches are bitten and ripped into the HUD; non-matches can be wrapped in a
// silk cocoon. With no hunt, every link is a find.
//
// Looks: skins (see shared.js), 'neon' or '8bit' render mode, size and speed.
(() => {
  if (window.__spiderCrawlerLoaded) return;
  window.__spiderCrawlerLoaded = true;

  const { DEFAULTS, resolveSkin } = self.SpiderShared;

  // ---- tuning -------------------------------------------------------------
  const BASE_SPEED = 230;     // px/s body speed at full stride
  const TURN_RATE = 5.5;      // rad/s
  const STEP_DUR = 0.12;      // s per leg step
  const BITE_MS = 1100;       // pause on a collected link
  const WRAP_MS = 1300;       // pause while cocooning a rejected link
  const IDLE_MIN = 600;
  const IDLE_MAX = 1600;
  const FLUSH_MS = 2000;
  const LOG_CAP = 500;
  const MAX_LINKS_SCAN = 2000;
  const NEAREST_POOL = 5;
  const JEV_BATCH = 16;
  const JEV_ERROR_COOLDOWN = 15000;
  const PIX = 4;              // 8-bit mode: screen pixels per art pixel

  const LEG_DEFS = [
    { hipX: 12, ang: 0.80, reach: 1.08 },
    { hipX: 7, ang: 1.35, reach: 0.94 },
    { hipX: 1, ang: 1.90, reach: 0.92 },
    { hipX: -4, ang: 2.50, reach: 1.06 },
  ];

  const HAS_STORAGE = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);
  const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ---- state --------------------------------------------------------------
  let cfg = Object.assign({}, DEFAULTS);
  let jevKeySet = false;
  let skin = resolveSkin(cfg);
  const visited = new Set();          // hrefs bitten or wrapped on this page
  const verdicts = new Map();         // href -> { kind: 'bite'|'wrap', p: number|null, by: 'jev'|'kw'|'all' }
  const judging = new Set();          // hrefs currently with Jev
  const pendingLog = [];
  let running = false;
  let rafId = 0;
  let lastTs = 0;
  let canvas = null;
  let ctx = null;
  let lo = null;                      // low-res canvas for 8-bit mode
  let lctx = null;
  let dpr = 1;
  let hud = null;
  let styleEl = null;
  let flushTimer = null;
  let finds = 0;
  let wrapped = 0;
  let frame = 0;
  let lastScrollX = 0;
  let lastScrollY = 0;
  let sp = null;
  const rings = [];                   // {x,y,t}
  const cocoons = [];                 // {x,y,w,h,t,dur}
  const jev = { busy: false, lastMs: null, perLink: null, error: null, errorAt: 0, calls: 0 };

  // ---- math ---------------------------------------------------------------
  const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => t * t * (3 - 2 * t);
  const clamp = (v, lo2, hi) => Math.max(lo2, Math.min(hi, v));
  const retro = () => cfg.mode === '8bit';

  function toWorld(lx, ly) {
    const c = Math.cos(sp.h);
    const s = Math.sin(sp.h);
    return { x: sp.x + lx * c - ly * s, y: sp.y + lx * s + ly * c };
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // 2-bone IK: the knee that bends away from the body axis.
  function solveKnee(hx, hy, fx, fy, l1, l2, side) {
    const dx = fx - hx;
    const dy = fy - hy;
    const d = Math.hypot(dx, dy) || 0.001;
    const dc = clamp(d, Math.abs(l1 - l2) + 0.5, l1 + l2 - 0.5);
    const base = Math.atan2(dy, dx);
    const a = Math.acos(clamp((l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc), -1, 1));
    const nx = -Math.sin(sp.h) * side;
    const ny = Math.cos(sp.h) * side;
    const k1 = { x: hx + Math.cos(base + a) * l1, y: hy + Math.sin(base + a) * l1 };
    const k2 = { x: hx + Math.cos(base - a) * l1, y: hy + Math.sin(base - a) * l1 };
    const o1 = (k1.x - sp.x) * nx + (k1.y - sp.y) * ny;
    const o2 = (k2.x - sp.x) * nx + (k2.y - sp.y) * ny;
    return o1 >= o2 ? k1 : k2;
  }

  // ---- spider construction -------------------------------------------------
  function buildSpider(x, y, h) {
    const scale = (window.innerWidth < 640 ? 0.7 : 1) * clamp(+cfg.size || 1, 0.5, 2);
    const R = 112 * scale;
    const legs = [];
    for (const side of [-1, 1]) {
      LEG_DEFS.forEach((def, i) => {
        const hip = { x: def.hipX * scale, y: side * 9 * scale };
        const len = R * def.reach;
        legs.push({
          i, side, hip,
          rest: { x: hip.x + Math.cos(def.ang) * len * 0.78, y: hip.y + side * Math.sin(def.ang) * len * 0.78 },
          l1: len * 0.66, l2: len * 0.66,
          group: (i + (side > 0 ? 1 : 0)) % 2,
          foot: null, from: null, to: null, t: 0, stepping: false, lift: 0,
        });
      });
    }
    const prev = sp;
    sp = {
      x, y, h: h == null ? Math.random() * Math.PI * 2 : h,
      vx: 0, vy: 0, speed: 0, scale, R, legs,
      tx: x, ty: y, target: null, kind: null,
      state: 'idle', waitUntil: performance.now() + 400,
      bob: 0, silk: null, stepsTaken: 0,
    };
    if (prev && prev.target) prev.target.el.classList.remove('__spider_hit');
    for (const leg of legs) {
      const w = toWorld(leg.rest.x, leg.rest.y);
      leg.foot = { x: w.x, y: w.y };
    }
  }

  // ---- DOM ----------------------------------------------------------------
  function css() {
    const k = skin;
    const r8 = retro();
    const font = r8 ? '700 12px/1.3 "Courier New",ui-monospace,monospace' : '600 12px/1.4 ui-monospace,Consolas,monospace';
    const radius = r8 ? '0' : '10px';
    const hudShadow = r8 ? `4px 4px 0 ${k.shell}` : `0 0 14px ${hexA(k.glow, 0.55)},inset 0 0 10px ${hexA(k.accent, 0.18)}`;
    return `
    #__spider_canvas{position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646}
    #__spider_canvas.r8{image-rendering:pixelated}
    .__spider_hit{outline:2px ${r8 ? 'dashed' : 'solid'} ${k.accent} !important;outline-offset:3px !important;${r8 ? '' : `box-shadow:0 0 14px ${k.glow} !important;`}border-radius:${r8 ? 0 : 3}px}
    .__spider_cocoon{opacity:.38 !important;filter:grayscale(1) !important;text-decoration:line-through ${k.legTip} 2px !important;outline:1px dotted ${hexA(k.legTip, 0.8)} !important;outline-offset:2px !important}
    .__spider_chip{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;max-width:260px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;
      font:${font};color:${k.legTip};background:${hexA(k.shell, 0.92)};border:${r8 ? 2 : 1}px solid ${k.leg};
      box-shadow:${r8 ? `3px 3px 0 ${k.shellMid}` : `0 0 12px ${hexA(k.accent, 0.55)}`};padding:4px 8px;border-radius:${r8 ? 0 : 6}px;
      transition:transform .85s ${r8 ? 'steps(8)' : 'cubic-bezier(.5,-0.3,.7,1)'},opacity .85s ease-in}
    #__spider_hud{position:fixed;right:12px;bottom:12px;z-index:2147483647;pointer-events:none;font:${font};letter-spacing:.04em;color:${k.legTip};
      background:${r8 ? k.shell : `linear-gradient(135deg,${hexA(k.shell, 0.94)},${hexA(k.shellMid, 0.94)})`};border:${r8 ? 3 : 1}px solid ${k.leg};
      box-shadow:${hudShadow};padding:6px 12px;border-radius:${radius};${r8 ? 'text-transform:uppercase;' : ''}}
    #__spider_hud b{color:${k.accent};${r8 ? '' : `text-shadow:0 0 8px ${k.accent}`}}
    #__spider_hud i{font-style:normal;opacity:.75}
  `;
  }

  function applyLook() {
    skin = resolveSkin(cfg);
    if (styleEl) styleEl.textContent = css();
    if (canvas) canvas.classList.toggle('r8', retro());
    if (hud) hud.style.display = cfg.showHud ? '' : 'none';
    updateHud();
  }

  function ensureDom() {
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = '__spider_style';
      (document.head || document.documentElement).appendChild(styleEl);
    }
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = '__spider_canvas';
      (document.body || document.documentElement).appendChild(canvas);
      ctx = canvas.getContext('2d');
      lo = document.createElement('canvas');
      lctx = lo.getContext('2d');
      resize();
    }
    if (!hud) {
      hud = document.createElement('div');
      hud.id = '__spider_hud';
      (document.body || document.documentElement).appendChild(hud);
    }
    applyLook();
  }

  function resize() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
  }

  function huntMode() {
    if (!String(cfg.hunt || '').trim()) return 'all';
    if (cfg.useJev && jevKeySet && !(jev.error && Date.now() - jev.errorAt < JEV_ERROR_COOLDOWN)) return 'jev';
    return 'kw';
  }

  function updateHud() {
    if (!hud) return;
    const mode = huntMode();
    let tail = '';
    if (mode === 'jev') {
      tail = jev.perLink != null ? ` <i>&middot; jev ${jev.perLink}ms/link</i>` : ' <i>&middot; jev&hellip;</i>';
    } else if (mode === 'kw' && cfg.useJev && jevKeySet && jev.error) {
      tail = ` <i>&middot; jev ${jev.error}, keyword</i>`;
    } else if (mode === 'kw') {
      tail = ' <i>&middot; keyword</i>';
    }
    const w = mode === 'all' ? '' : ` &middot; <b>${wrapped}</b> wrapped`;
    hud.innerHTML = `\u{1F577} CRAWLER &middot; <b>${finds}</b> ${finds === 1 ? 'find' : 'finds'}${w}${tail}`;
  }

  // ---- link discovery + judging -----------------------------------------------
  function visibleLinks() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const out = [];
    const anchors = document.querySelectorAll('a[href]');
    const limit = Math.min(anchors.length, MAX_LINKS_SCAN);
    for (let i = 0; i < limit; i++) {
      const a = anchors[i];
      const href = a.href;
      if (!href || !/^https?:/i.test(href) || visited.has(href)) continue;
      const r = a.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
      const text = ((a.innerText || a.getAttribute('aria-label') || a.title || href) + '')
        .replace(/\s+/g, ' ').trim().slice(0, 160);
      out.push({ el: a, href, text, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
    }
    return out;
  }

  function keywordVerdict(l) {
    const words = String(cfg.hunt).toLowerCase().split(/[\s,;|]+/).filter((w) => w.length >= 3);
    const hay = `${l.text} ${l.href}`.toLowerCase();
    const hit = !words.length || words.some((w) => hay.includes(w) || (w.endsWith('s') && hay.includes(w.slice(0, -1))));
    return { kind: hit ? 'bite' : 'wrap', p: null, by: 'kw' };
  }

  function requestJudge(links) {
    if (jev.busy || !HAS_STORAGE) return;
    const batch = links.filter((l) => !verdicts.has(l.href) && !judging.has(l.href)).slice(0, JEV_BATCH);
    if (!batch.length) return;
    jev.busy = true;
    batch.forEach((l) => judging.add(l.href));
    const done = (resp) => {
      jev.busy = false;
      batch.forEach((l) => judging.delete(l.href));
      if (!resp || !resp.ok) {
        jev.error = (resp && resp.error) || 'error';
        jev.errorAt = Date.now();
        updateHud();
        return;
      }
      jev.error = null;
      jev.calls++;
      jev.lastMs = resp.latency;
      jev.perLink = resp.perLink;
      const th = clamp(+cfg.jevThreshold || 0.5, 0.05, 0.95);
      batch.forEach((l, i) => {
        const p = resp.probs[i];
        if (p == null) return;
        verdicts.set(l.href, { kind: p >= th ? 'bite' : 'wrap', p, by: 'jev' });
      });
      updateHud();
    };
    try {
      chrome.runtime.sendMessage({
        type: 'jev-judge',
        hunt: String(cfg.hunt).slice(0, 300),
        page: { title: document.title, url: location.href },
        links: batch.map((l) => ({ text: l.text, href: l.href })),
      }, (resp) => {
        if (chrome.runtime.lastError) { done({ ok: false, error: 'bg_unavailable' }); return; }
        done(resp);
      });
    } catch (e) {
      done({ ok: false, error: 'bg_unavailable' });
    }
  }

  function verdictFor(l, mode) {
    if (mode === 'all') return { kind: 'bite', p: null, by: 'all' };
    const v = verdicts.get(l.href);
    if (v) return v;
    if (mode === 'kw') {
      const kv = keywordVerdict(l);
      verdicts.set(l.href, kv);
      return kv;
    }
    return null; // waiting on Jev
  }

  function nearestPick(list) {
    list.sort((p, q) => Math.hypot(p.cx - sp.x, p.cy - sp.y) - Math.hypot(q.cx - sp.x, q.cy - sp.y));
    return list[Math.floor(Math.random() * Math.min(NEAREST_POOL, list.length))];
  }

  function assignTarget() {
    const mode = huntMode();
    const links = visibleLinks();
    const bites = [];
    const wraps = [];
    const unknown = [];
    for (const l of links) {
      const v = verdictFor(l, mode);
      if (!v) unknown.push(l);
      else if (v.kind === 'bite') bites.push(Object.assign(l, { v }));
      else if (cfg.wrapRejects) wraps.push(Object.assign(l, { v }));
    }
    if (mode === 'jev' && unknown.length) requestJudge(unknown);

    let pick = null;
    let kind = null;
    if (bites.length && (!wraps.length || Math.random() > 0.3)) { pick = nearestPick(bites); kind = 'bite'; }
    else if (wraps.length) { pick = nearestPick(wraps); kind = 'wrap'; }

    if (pick) {
      sp.target = pick;
      sp.kind = kind;
      pick.el.classList.add('__spider_hit');
      sp.state = 'walk';
      return;
    }
    if (unknown.length) {             // Jev is thinking: patrol in place briefly
      sp.state = 'idle';
      sp.waitUntil = performance.now() + 250;
      return;
    }
    sp.target = null;
    sp.kind = null;
    const m = 80;
    sp.tx = m + Math.random() * Math.max(1, window.innerWidth - 2 * m);
    sp.ty = m + Math.random() * Math.max(1, window.innerHeight - 2 * m);
    sp.state = 'walk';
  }

  function releaseTarget() {
    if (sp && sp.target) {
      sp.target.el.classList.remove('__spider_hit');
      sp.target = null;
      sp.kind = null;
    }
  }

  function ripChip(t, x, y) {
    const chip = document.createElement('div');
    chip.className = '__spider_chip';
    chip.textContent = t.text || t.href;
    chip.style.transform = `translate(${x}px, ${y}px)`;
    document.documentElement.appendChild(chip);
    const hr = hud && cfg.showHud ? hud.getBoundingClientRect() : { left: window.innerWidth - 120, top: window.innerHeight - 30 };
    requestAnimationFrame(() => {
      chip.style.transform = `translate(${hr.left}px, ${hr.top}px) scale(.35) rotate(-8deg)`;
      chip.style.opacity = '0';
    });
    setTimeout(() => chip.remove(), 1000);
  }

  function arrive(now) {
    const t = sp.target;
    const kind = sp.kind;
    visited.add(t.href);
    const r = t.el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const el = t.el;
    const v = t.v || { p: null, by: 'all' };
    if (kind === 'wrap') {
      cocoons.push({ x: cx, y: cy, w: r.width, h: r.height, t: 0, dur: WRAP_MS / 1000 });
      sp.silk = { x: cx, y: cy, until: now + WRAP_MS };
      wrapped++;
      setTimeout(() => { el.classList.remove('__spider_hit'); el.classList.add('__spider_cocoon'); }, WRAP_MS * 0.6);
      sp.waitUntil = now + WRAP_MS;
    } else {
      rings.push({ x: cx, y: cy, t: 0 });
      sp.silk = { x: cx, y: cy, until: now + BITE_MS };
      ripChip(t, r.left, r.top);
      finds++;
      queueLog({ text: t.text, href: t.href, page: location.href, at: Date.now(), hunt: cfg.hunt || null, p: v.p, by: v.by });
      setTimeout(() => el.classList.remove('__spider_hit'), BITE_MS);
      sp.waitUntil = now + BITE_MS;
    }
    updateHud();
    sp.target = null;
    sp.kind = null;
    sp.state = 'collect';
  }

  // ---- simulation -----------------------------------------------------------
  function compensateScroll() {
    const dx = window.scrollX - lastScrollX;
    const dy = window.scrollY - lastScrollY;
    lastScrollX = window.scrollX;
    lastScrollY = window.scrollY;
    if (!dx && !dy) return;
    sp.x -= dx; sp.y -= dy; sp.tx -= dx; sp.ty -= dy;
    for (const leg of sp.legs) {
      for (const p of [leg.foot, leg.from, leg.to]) if (p) { p.x -= dx; p.y -= dy; }
    }
    for (const r of rings) { r.x -= dx; r.y -= dy; }
    for (const c of cocoons) { c.x -= dx; c.y -= dy; }
    if (sp.silk) { sp.silk.x -= dx; sp.silk.y -= dy; }
  }

  function moveBody(dt, now) {
    if (sp.state === 'collect' || sp.state === 'idle') {
      sp.speed = 0;
      if (now >= sp.waitUntil) assignTarget();
      return;
    }
    if (sp.target) {
      const el = sp.target.el;
      const r = el.getBoundingClientRect();
      const off = r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth;
      if (off || !el.isConnected) {
        releaseTarget();
        sp.state = 'idle';
        sp.waitUntil = now + IDLE_MIN;
        return;
      }
      sp.tx = r.left + r.width / 2;
      sp.ty = r.top + r.height / 2;
    }
    const dx = sp.tx - sp.x;
    const dy = sp.ty - sp.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 8) {
      sp.speed = 0;
      if (sp.target) arrive(now);
      else {
        sp.state = 'idle';
        sp.waitUntil = now + IDLE_MIN + Math.random() * (IDLE_MAX - IDLE_MIN);
      }
      return;
    }
    const desired = Math.atan2(dy, dx);
    const diff = wrapAngle(desired - sp.h);
    sp.h += clamp(diff, -TURN_RATE * dt, TURN_RATE * dt);
    const approach = clamp(dist / 70, 0.25, 1);
    const align = Math.max(0.3, Math.cos(diff));
    const speed = BASE_SPEED * clamp(+cfg.speed || 1, 0.5, 2) * (REDUCED ? 0.6 : 1);
    const stepLen = Math.min(speed * approach * align * dt, dist);
    let mx;
    let my;
    if (dist < 60) { mx = dx / dist; my = dy / dist; } else { mx = Math.cos(sp.h); my = Math.sin(sp.h); }
    sp.x += mx * stepLen;
    sp.y += my * stepLen;
    sp.speed = stepLen / Math.max(dt, 1e-4);
    sp.vx = mx * sp.speed;
    sp.vy = my * sp.speed;
    sp.bob += stepLen * 0.09;
  }

  function updateLegs(dt) {
    const moving = sp.speed > 5;
    const thresh = sp.R * (moving ? 0.30 : 0.09);
    const stepDur = STEP_DUR / Math.sqrt(clamp(+cfg.speed || 1, 0.5, 2));
    const lead = stepDur * 1.7;
    const steppingGroup = [false, false];
    for (const leg of sp.legs) if (leg.stepping) steppingGroup[leg.group] = true;

    for (const leg of sp.legs) {
      const rw = toWorld(leg.rest.x, leg.rest.y);
      const ideal = { x: rw.x + (moving ? sp.vx * lead : 0), y: rw.y + (moving ? sp.vy * lead : 0) };
      if (leg.stepping) {
        leg.t += dt / stepDur;
        leg.to.x = lerp(leg.to.x, ideal.x, 0.25);
        leg.to.y = lerp(leg.to.y, ideal.y, 0.25);
        const k = ease(Math.min(1, leg.t));
        leg.foot.x = lerp(leg.from.x, leg.to.x, k);
        leg.foot.y = lerp(leg.from.y, leg.to.y, k);
        leg.lift = Math.sin(Math.PI * Math.min(1, leg.t));
        if (leg.t >= 1) { leg.stepping = false; leg.lift = 0; sp.stepsTaken++; }
        continue;
      }
      const hip = toWorld(leg.hip.x, leg.hip.y);
      const reachMax = (leg.l1 + leg.l2) * 0.96;
      const dHip = Math.hypot(leg.foot.x - hip.x, leg.foot.y - hip.y);
      const dIdeal = Math.hypot(leg.foot.x - ideal.x, leg.foot.y - ideal.y);
      if ((dIdeal > thresh && !steppingGroup[1 - leg.group]) || dHip > reachMax) {
        leg.stepping = true;
        leg.t = 0;
        leg.from = { x: leg.foot.x, y: leg.foot.y };
        leg.to = ideal;
        steppingGroup[leg.group] = true;
      }
    }
  }

  // ---- rendering --------------------------------------------------------------
  function glow(g, color, blur, r8) {
    if (r8) { g.shadowBlur = 0; return; }
    g.shadowColor = color;
    g.shadowBlur = blur;
  }

  function drawLeg(g, leg, r8) {
    const k = skin;
    const hip = toWorld(leg.hip.x, leg.hip.y);
    const nx = -Math.sin(sp.h) * leg.side;
    const ny = Math.cos(sp.h) * leg.side;
    const lift = leg.lift * sp.R * 0.12;
    const fx = leg.foot.x + nx * lift;
    const fy = leg.foot.y + ny * lift;
    const knee = solveKnee(hip.x, hip.y, fx, fy, leg.l1, leg.l2 * (1 + leg.lift * 0.05), leg.side);
    const s = sp.scale;
    const mx = lerp(knee.x, fx, 0.55) + nx * 4 * s;
    const my = lerp(knee.y, fy, 0.55) + ny * 4 * s;

    g.lineCap = r8 ? 'square' : 'round';
    g.lineJoin = r8 ? 'miter' : 'round';
    if (r8) {
      g.strokeStyle = k.leg;
    } else {
      const grad = g.createLinearGradient(hip.x, hip.y, fx, fy);
      grad.addColorStop(0, k.leg);
      grad.addColorStop(0.55, k.shellHi);
      grad.addColorStop(1, k.legTip);
      g.strokeStyle = grad;
    }
    glow(g, k.glow, 10, r8);
    g.lineWidth = (r8 ? 11 : 7) * s;
    g.beginPath(); g.moveTo(hip.x, hip.y); g.lineTo(knee.x, knee.y); g.stroke();

    glow(g, k.accent, 10, r8);
    if (r8) g.strokeStyle = k.legTip;
    g.lineWidth = (r8 ? 8 : 4.2) * s;
    g.beginPath(); g.moveTo(knee.x, knee.y); g.lineTo(mx, my); g.lineTo(fx, fy); g.stroke();

    glow(g, k.accent, 14, r8);
    const dot = (x, y, rad, c) => {
      g.fillStyle = c;
      if (r8) { const q = Math.max(rad, PIX * 0.75); g.fillRect(x - q, y - q, q * 2, q * 2); }
      else { g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill(); }
    };
    dot(knee.x, knee.y, 4.2 * s, k.accent);
    dot(mx, my, 2.6 * s, k.leg);
    dot(fx, fy, (2.4 + leg.lift * 1.6) * s, leg.lift > 0.05 ? '#ffffff' : k.legTip);
  }

  function drawBody(g, now, r8) {
    const k = skin;
    const s = sp.scale;
    const breathe = 1 + Math.sin(now / 380) * 0.02 + Math.sin(sp.bob) * 0.025;

    if (!r8) {
      g.save();
      g.translate(sp.x + 7 * s, sp.y + 11 * s);
      g.rotate(sp.h);
      g.fillStyle = 'rgba(0,0,0,.30)';
      g.shadowColor = 'rgba(0,0,0,.55)';
      g.shadowBlur = 18;
      g.beginPath(); g.ellipse(-16 * s, 0, 50 * s, 24 * s, 0, 0, Math.PI * 2); g.fill();
      g.restore();
    }

    g.save();
    g.translate(sp.x, sp.y);
    g.rotate(sp.h);
    g.scale(s, s);

    // abdomen
    g.save();
    g.translate(-33, 0);
    g.scale(breathe, 1 / breathe);
    if (r8) g.fillStyle = k.shellMid;
    else {
      const ag = g.createRadialGradient(-6, -8, 4, 0, 0, 32);
      ag.addColorStop(0, k.shellHi);
      ag.addColorStop(0.6, k.shellMid);
      ag.addColorStop(1, k.shell);
      g.fillStyle = ag;
    }
    glow(g, k.glow, 22, r8);
    g.beginPath(); g.ellipse(0, 0, 29, 21, 0, 0, Math.PI * 2); g.fill();
    g.lineWidth = r8 ? 4 : 1.6;
    g.strokeStyle = r8 ? k.shell : k.glow;
    g.stroke();
    glow(g, k.accent, 12, r8);
    g.strokeStyle = k.accent;
    g.lineWidth = r8 ? 4 : 2.2;
    for (let j = 0; j < 3; j++) {
      const bx = 10 - j * 10;
      const w = 11 - j * 2;
      g.beginPath(); g.moveTo(bx, -w); g.lineTo(bx - 6, 0); g.lineTo(bx, w); g.stroke();
    }
    if (!r8) {
      g.shadowBlur = 0;
      g.fillStyle = 'rgba(255,255,255,.10)';
      g.beginPath(); g.ellipse(-4, -10, 14, 5, -0.2, 0, Math.PI * 2); g.fill();
    } else {
      g.fillStyle = k.shellHi;
      g.fillRect(-12, -14, 12, 4);
    }
    g.restore();

    // pedicel
    g.fillStyle = k.shellMid;
    g.beginPath(); g.ellipse(-7, 0, 5, 4, 0, 0, Math.PI * 2); g.fill();

    // cephalothorax
    if (r8) g.fillStyle = k.shell;
    else {
      const cg = g.createRadialGradient(8, -5, 2, 6, 0, 19);
      cg.addColorStop(0, k.shellHi);
      cg.addColorStop(1, k.shell);
      g.fillStyle = cg;
    }
    glow(g, k.accent, 14, r8);
    g.beginPath(); g.ellipse(6, 0, 17, 14, 0, 0, Math.PI * 2); g.fill();
    g.lineWidth = r8 ? 3 : 1.4;
    g.strokeStyle = k.accent;
    g.stroke();
    g.strokeStyle = hexA(k.accent, 0.45);
    g.beginPath(); g.moveTo(-6, 0); g.lineTo(14, 0); g.stroke();

    // fangs
    glow(g, k.glow, 8, r8);
    g.fillStyle = k.leg;
    for (const side of [-1, 1]) {
      g.beginPath();
      g.moveTo(20, side * 3);
      g.quadraticCurveTo(28, side * 6, 27, side * 1.5);
      g.lineTo(21, side * 1);
      g.fill();
    }

    // eyes
    const pulse = 0.75 + 0.25 * Math.sin(now / 160);
    glow(g, k.eye, 16 * pulse, r8);
    g.fillStyle = k.eye;
    for (const side of [-1, 1]) {
      if (r8) {
        g.fillRect(14, side * 4 - 3, 6, 6);
        g.fillRect(10, side * 9 - 2, 4, 4);
      } else {
        g.beginPath(); g.arc(17, side * 4, 2.8, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(13.5, side * 8, 1.6, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(11, side * 4.5, 1.3, 0, Math.PI * 2); g.fill();
      }
    }
    if (!r8) {
      g.shadowBlur = 0;
      g.fillStyle = '#ffffff';
      for (const side of [-1, 1]) { g.beginPath(); g.arc(17.6, side * 3.4, 0.9, 0, Math.PI * 2); g.fill(); }
    }
    g.restore();
  }

  function drawFx(g, now, dt, r8) {
    const k = skin;
    if (sp.silk && now < sp.silk.until) {
      const sw = toWorld(-62 * sp.scale, 0);
      g.save();
      g.strokeStyle = hexA(k.legTip, 0.85);
      glow(g, k.accent, 10, r8);
      g.lineWidth = r8 ? PIX : 1.4;
      g.setLineDash(r8 ? [PIX * 2, PIX * 2] : [6, 5]);
      g.lineDashOffset = -now / 25;
      g.beginPath();
      g.moveTo(sw.x, sw.y);
      g.quadraticCurveTo((sw.x + sp.silk.x) / 2, (sw.y + sp.silk.y) / 2 + 24, sp.silk.x, sp.silk.y);
      g.stroke();
      g.restore();
    } else if (sp.silk) {
      sp.silk = null;
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.t += dt;
      const q = r.t / 0.9;
      if (q >= 1) { rings.splice(i, 1); continue; }
      g.save();
      g.globalAlpha = 1 - q;
      g.strokeStyle = i % 2 ? k.glow : k.accent;
      glow(g, k.accent, 16, r8);
      g.lineWidth = r8 ? PIX : 3 * (1 - q) + 1;
      if (r8) {
        const a = 8 + q * 60;
        const b = 4 + q * 32;
        g.strokeRect(r.x - a, r.y - a, a * 2, a * 2);
        g.strokeRect(r.x - b, r.y - b, b * 2, b * 2);
      } else {
        g.beginPath(); g.arc(r.x, r.y, 8 + q * 60, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.arc(r.x, r.y, 4 + q * 32, 0, Math.PI * 2); g.stroke();
      }
      g.restore();
    }
    // cocoon: silk spiral wound around the link, tightening over time
    for (let i = cocoons.length - 1; i >= 0; i--) {
      const c = cocoons[i];
      c.t += dt;
      const q = c.t / c.dur;
      if (q >= 1.4) { cocoons.splice(i, 1); continue; }
      const prog = Math.min(1, q);
      const fade = q > 1 ? 1 - (q - 1) / 0.4 : 1;
      const rx = Math.max(18, c.w / 2 + 10) * (1.25 - 0.35 * prog);
      const ry = Math.max(12, c.h / 2 + 8) * (1.25 - 0.35 * prog);
      g.save();
      g.globalAlpha = 0.9 * fade;
      g.strokeStyle = k.legTip;
      glow(g, k.glow, 8, r8);
      g.lineWidth = r8 ? PIX / 2 : 1.2;
      g.beginPath();
      const turns = 6 * prog;
      const steps = Math.max(2, Math.floor(80 * prog));
      for (let j = 0; j <= steps; j++) {
        const a = (j / steps) * turns * Math.PI * 2;
        const shrink = 1 - 0.5 * (j / Math.max(1, steps));
        const x = c.x + Math.cos(a) * rx * shrink;
        const y = c.y + Math.sin(a) * ry * shrink;
        if (j === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      g.restore();
    }
  }

  function drawScene(g, now, dt, r8) {
    drawFx(g, now, dt, r8);
    const order = sp.legs.slice().sort((a, b) => b.i - a.i);
    for (const leg of order) drawLeg(g, leg, r8);
    drawBody(g, now, r8);
  }

  function render(now, dt) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (retro()) {
      const lw = Math.ceil(W / PIX);
      const lh = Math.ceil(H / PIX);
      if (lo.width !== lw || lo.height !== lh) { lo.width = lw; lo.height = lh; }
      lctx.setTransform(1 / PIX, 0, 0, 1 / PIX, 0, 0);
      lctx.clearRect(0, 0, W, H);
      drawScene(lctx, now, dt, true);
      // hard pixels: snap anti-aliased edges to fully on or off
      const img = lctx.getImageData(0, 0, lw, lh);
      const px = img.data;
      for (let i = 3; i < px.length; i += 4) px[i] = px[i] < 110 ? 0 : 255;
      lctx.putImageData(img, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(lo, 0, 0, lw * PIX * dpr, lh * PIX * dpr);
    } else {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      drawScene(ctx, now, dt, false);
    }
  }

  function exposeDebug() {
    // throttled state for tests / debugging (content scripts live in an isolated world)
    const d = canvas.dataset;
    d.x = sp.x.toFixed(1);
    d.y = sp.y.toFixed(1);
    d.state = sp.state;
    d.planted = String(sp.legs.filter((l) => !l.stepping).length);
    d.steps = String(sp.stepsTaken);
    d.feet = sp.legs.map((l) => `${l.foot.x.toFixed(0)},${l.foot.y.toFixed(0)},${l.stepping ? 1 : 0}`).join(';');
    d.finds = String(finds);
    d.wrapped = String(wrapped);
    d.mode = cfg.mode;
    d.skin = cfg.skin;
    d.hunt = huntMode();
    d.jevCalls = String(jev.calls);
    d.jevPerLink = jev.perLink == null ? '' : String(jev.perLink);
    d.jevError = jev.error || '';
    d.scale = sp.scale.toFixed(2);
  }

  function tick(ts) {
    rafId = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (ts - (lastTs || ts)) / 1000);
    lastTs = ts;
    const now = performance.now();
    compensateScroll();
    moveBody(dt, now);
    updateLegs(dt);
    render(now, dt);
    if (++frame % 6 === 0) exposeDebug();
  }

  // ---- storage --------------------------------------------------------------
  function queueLog(entry) {
    pendingLog.push(entry);
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!pendingLog.length) return;
    const batch = pendingLog.splice(0, pendingLog.length);
    if (!HAS_STORAGE) return;
    try {
      chrome.storage.local.get({ crawlLog: [] }, (v) => {
        const log = (v.crawlLog || []).concat(batch).slice(-LOG_CAP);
        chrome.storage.local.set({ crawlLog: log });
      });
    } catch (e) { /* extension reloaded; drop the batch */ }
  }

  // ---- lifecycle ------------------------------------------------------------
  function start() {
    if (running) return;
    running = true;
    ensureDom();
    lastScrollX = window.scrollX;
    lastScrollY = window.scrollY;
    buildSpider(window.innerWidth * (0.25 + Math.random() * 0.5), window.innerHeight * (0.25 + Math.random() * 0.5));
    lastTs = 0;
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(rafId);
    flush();
    releaseTarget();
    sp = null;
    rings.length = 0;
    cocoons.length = 0;
    document.querySelectorAll('.__spider_hit').forEach((el) => el.classList.remove('__spider_hit'));
    document.querySelectorAll('.__spider_chip').forEach((el) => el.remove());
    if (canvas) { canvas.remove(); canvas = null; ctx = null; lo = null; lctx = null; }
    if (hud) { hud.remove(); hud = null; }
    if (styleEl) { styleEl.remove(); styleEl = null; }
  }

  function applySettings(next, first) {
    const prevSize = cfg.size;
    const prevHunt = cfg.hunt;
    cfg = Object.assign({}, DEFAULTS, next);
    if (cfg.hunt !== prevHunt && !first) {
      verdicts.clear();
      document.querySelectorAll('.__spider_cocoon').forEach((el) => el.classList.remove('__spider_cocoon'));
      visited.clear();
    }
    if (!cfg.enabled) { stop(); return; }
    if (!running) { start(); return; }
    applyLook();
    if (sp && cfg.size !== prevSize) buildSpider(sp.x, sp.y, sp.h);
  }

  window.addEventListener('resize', () => {
    resize();
    if (sp) {
      const scale = (window.innerWidth < 640 ? 0.7 : 1) * clamp(+cfg.size || 1, 0.5, 2);
      if (Math.abs(scale - sp.scale) > 0.001) buildSpider(sp.x, sp.y, sp.h);
    }
  });
  window.addEventListener('pagehide', flush);

  if (HAS_STORAGE) {
    const keys = Object.assign({}, DEFAULTS, { jevKeySet: false });
    chrome.storage.local.get(keys, (v) => {
      jevKeySet = !!v.jevKeySet;
      applySettings(v, true);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.jevKeySet) { jevKeySet = !!changes.jevKeySet.newValue; jev.error = null; verdicts.clear(); }
      const touched = Object.keys(changes).some((k) => k in DEFAULTS);
      if (!touched) { if (changes.jevKeySet) updateHud(); return; }
      chrome.storage.local.get(DEFAULTS, (v) => applySettings(v, false));
    });
  } else {
    applySettings({}, true);
  }
})();
