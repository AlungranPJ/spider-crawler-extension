// Shared skin + settings definitions (loaded by content script, popup and options).
// Keep this file free of DOM/chrome calls so every context can import it.
(function (root) {
  const SKINS = {
    venom: {
      name: 'Venom (purple x green)',
      shell: '#10051c', shellMid: '#2a0b4a', shellHi: '#5a1a9a',
      leg: '#b04dff', legTip: '#39ff88', accent: '#39ff88', glow: '#b04dff', eye: '#39ff88',
    },
    laya: {
      name: 'Laya (ice blue)',
      shell: '#04121f', shellMid: '#0b3352', shellHi: '#1f6fa8',
      leg: '#3fb6ff', legTip: '#c9f1ff', accent: '#7fe3ff', glow: '#3fb6ff', eye: '#e6fbff',
    },
    ember: {
      name: 'Ember (lava)',
      shell: '#1a0503', shellMid: '#4a0f07', shellHi: '#a0260f',
      leg: '#ff5a1f', legTip: '#ffd23f', accent: '#ffb000', glow: '#ff3d00', eye: '#ffe066',
    },
    ghost: {
      name: 'Ghost (white)',
      shell: '#cfd6e0', shellMid: '#e9eef5', shellHi: '#ffffff',
      leg: '#9aa7b8', legTip: '#ffffff', accent: '#5b6b80', glow: '#a9c4ff', eye: '#ff4d6d',
    },
    gold: {
      name: 'Black Gold',
      shell: '#050505', shellMid: '#1a1a1a', shellHi: '#3a3a3a',
      leg: '#d4a017', legTip: '#fff1a8', accent: '#ffd700', glow: '#ffb300', eye: '#ff2d2d',
    },
    matrix: {
      name: 'Matrix',
      shell: '#000000', shellMid: '#021a07', shellHi: '#0a4d18',
      leg: '#00c83c', legTip: '#b6ffc8', accent: '#00ff41', glow: '#00ff41', eye: '#ffffff',
    },
  };

  const SKIN_KEYS = ['shell', 'shellMid', 'shellHi', 'leg', 'legTip', 'accent', 'glow', 'eye'];

  const DEFAULTS = {
    enabled: true,
    creature: 'spider',    // 'spider' | 'octopus' | 'slime'
    mode: 'neon',          // 'neon' | '8bit'
    skin: 'venom',         // built-in id or 'custom:<name>'
    customSkins: {},       // { name: {shell,...} }
    size: 1,               // 0.5 .. 2
    speed: 1,              // 0.5 .. 2
    hunt: '',              // what to hunt for; empty = every link
    useJev: true,          // use Jev when a key is set
    jevThreshold: 0.5,
    wrapRejects: true,     // walk over and cocoon links that are not a match
    showHud: true,
  };

  function isHex(v) { return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v); }

  function validSkin(s) {
    return !!s && typeof s === 'object' && SKIN_KEYS.every((k) => isHex(s[k]));
  }

  function resolveSkin(settings) {
    const id = settings.skin || 'venom';
    if (id.startsWith('custom:')) {
      const s = (settings.customSkins || {})[id.slice(7)];
      if (validSkin(s)) return s;
    }
    return SKINS[id] || SKINS.venom;
  }

  root.SpiderShared = { SKINS, SKIN_KEYS, DEFAULTS, validSkin, resolveSkin, isHex };
})(typeof self !== 'undefined' ? self : this);
