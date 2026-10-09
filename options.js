const { DEFAULTS, SKINS, SKIN_KEYS, validSkin, resolveSkin } = self.SpiderShared;
const $ = (id) => document.getElementById(id);
const LABELS = {
  shell: 'Shell dark', shellMid: 'Shell mid', shellHi: 'Shell highlight', leg: 'Leg',
  legTip: 'Leg tip / silk', accent: 'Accent', glow: 'Glow', eye: 'Eyes',
};
let state = null;

function flash(msg, cls) {
  const s = $('status');
  s.textContent = msg;
  s.className = `show ${cls || ''}`;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { s.className = ''; }, 2200);
}

function set(obj) { chrome.storage.local.set(obj); }

function fillSkins() {
  const sel = $('skin');
  sel.innerHTML = '';
  for (const [id, s] of Object.entries(SKINS)) sel.add(new Option(s.name, id));
  for (const name of Object.keys(state.customSkins || {})) sel.add(new Option(`★ ${name}`, `custom:${name}`));
  sel.value = state.skin;
  if (sel.value !== state.skin) sel.value = 'venom';
}

function currentColors() {
  const out = {};
  for (const k of SKIN_KEYS) out[k] = $(`c_${k}`).value;
  return out;
}

function loadColors() {
  const s = resolveSkin(state);
  for (const k of SKIN_KEYS) $(`c_${k}`).value = s[k];
  $('skinName').value = state.skin.startsWith('custom:') ? state.skin.slice(7) : '';
}

function buildColorInputs() {
  const box = $('colors');
  for (const k of SKIN_KEYS) {
    const l = document.createElement('label');
    l.innerHTML = `${LABELS[k]}<input type="color" id="c_${k}">`;
    box.appendChild(l);
  }
  // live preview while dragging: write to a temporary custom skin
  box.addEventListener('input', () => {
    const custom = Object.assign({}, state.customSkins, { '(editing)': currentColors() });
    state.customSkins = custom;
    state.skin = 'custom:(editing)';
    set({ customSkins: custom, skin: state.skin });
  });
}

function saveSkinAs(name, colors) {
  name = String(name || '').trim().slice(0, 40);
  if (!name || name === '(editing)') { flash('Give the skin a name first', 'bad'); return; }
  if (!validSkin(colors)) { flash('Skin needs 8 colors like #12ab34', 'bad'); return; }
  const custom = Object.assign({}, state.customSkins);
  delete custom['(editing)'];
  custom[name] = colors;
  state.customSkins = custom;
  state.skin = `custom:${name}`;
  set({ customSkins: custom, skin: state.skin });
  fillSkins();
  flash(`Saved skin "${name}"`, 'ok');
}

function renderKeyState(v) {
  $('keyState').textContent = v.jevKeySet ? '(saved in this browser)' : '(not set)';
  $('keyState').className = v.jevKeySet ? 'ok' : '';
}

chrome.storage.local.get(Object.assign({}, DEFAULTS, { jevKeySet: false, jevProvider: 'typesafe' }), (v) => {
  state = v;
  buildColorInputs();
  fillSkins();
  loadColors();
  $('mode').value = v.mode;
  $('creature').value = v.creature;
  $('size').value = v.size; $('sizeV').textContent = `${(+v.size).toFixed(2)}x`;
  $('speed').value = v.speed; $('speedV').textContent = `${(+v.speed).toFixed(2)}x`;
  $('showHud').checked = !!v.showHud;
  $('hunt').value = v.hunt || '';
  $('wrapRejects').checked = !!v.wrapRejects;
  $('useJev').checked = !!v.useJev;
  $('jevProvider').value = v.jevProvider;
  $('jevThreshold').value = v.jevThreshold; $('thV').textContent = (+v.jevThreshold).toFixed(2);
  renderKeyState(v);
});

$('mode').addEventListener('change', () => set({ mode: $('mode').value }));
$('creature').addEventListener('change', () => set({ creature: $('creature').value }));
$('skin').addEventListener('change', () => { state.skin = $('skin').value; set({ skin: state.skin }); loadColors(); });
$('size').addEventListener('input', () => { $('sizeV').textContent = `${(+$('size').value).toFixed(2)}x`; set({ size: +$('size').value }); });
$('speed').addEventListener('input', () => { $('speedV').textContent = `${(+$('speed').value).toFixed(2)}x`; set({ speed: +$('speed').value }); });
$('showHud').addEventListener('change', () => set({ showHud: $('showHud').checked }));
$('wrapRejects').addEventListener('change', () => set({ wrapRejects: $('wrapRejects').checked }));
$('useJev').addEventListener('change', () => set({ useJev: $('useJev').checked }));
$('jevProvider').addEventListener('change', () => set({ jevProvider: $('jevProvider').value }));
$('jevThreshold').addEventListener('input', () => { $('thV').textContent = (+$('jevThreshold').value).toFixed(2); set({ jevThreshold: +$('jevThreshold').value }); });
let huntTimer = null;
$('hunt').addEventListener('input', () => {
  clearTimeout(huntTimer);
  huntTimer = setTimeout(() => set({ hunt: $('hunt').value.trim() }), 400);
});

$('saveSkin').addEventListener('click', () => saveSkinAs($('skinName').value, currentColors()));
$('deleteSkin').addEventListener('click', () => {
  if (!state.skin.startsWith('custom:')) { flash('Built-in skins cannot be deleted', 'bad'); return; }
  const custom = Object.assign({}, state.customSkins);
  delete custom[state.skin.slice(7)];
  state.customSkins = custom;
  state.skin = 'venom';
  set({ customSkins: custom, skin: 'venom' });
  fillSkins();
  loadColors();
  flash('Skin deleted');
});
$('exportSkin').addEventListener('click', () => {
  const name = $('skinName').value.trim() || (SKINS[state.skin] ? SKINS[state.skin].name : 'my skin');
  $('skinJson').value = JSON.stringify(Object.assign({ name }, currentColors()), null, 2);
  $('skinJson').select();
});
$('importSkin').addEventListener('click', () => {
  let obj;
  try { obj = JSON.parse($('skinJson').value); } catch (e) { flash('That is not valid JSON', 'bad'); return; }
  const colors = {};
  for (const k of SKIN_KEYS) colors[k] = obj[k];
  saveSkinAs(obj.name || $('skinName').value || 'imported', colors);
  loadColors();
});

$('saveKey').addEventListener('click', () => {
  const key = $('jevKey').value.trim();
  if (key.length < 16) { flash('That key looks too short', 'bad'); return; }
  chrome.storage.local.set({ jevKey: key, jevKeySet: true }, () => {
    $('jevKey').value = '';
    renderKeyState({ jevKeySet: true });
    flash('Key saved in this browser', 'ok');
  });
});
$('clearKey').addEventListener('click', () => {
  chrome.storage.local.remove('jevKey', () => {
    chrome.storage.local.set({ jevKeySet: false });
    renderKeyState({ jevKeySet: false });
    flash('Key removed');
  });
});
$('testKey').addEventListener('click', () => {
  $('testOut').textContent = 'asking Jev…';
  $('testOut').className = 'note';
  chrome.runtime.sendMessage({ type: 'jev-test' }, (r) => {
    if (!r || !r.ok) {
      $('testOut').textContent = `failed: ${(r && r.error) || chrome.runtime.lastError?.message || 'no reply'}`;
      $('testOut').className = 'bad';
      return;
    }
    const [spider, privacy] = r.probs;
    $('testOut').textContent = `ok in ${r.latency} ms: "Jumping spider" yes=${spider?.toFixed(2)}, "Privacy policy" yes=${privacy?.toFixed(2)}`;
    $('testOut').className = 'ok';
  });
});
