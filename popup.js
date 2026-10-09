const { DEFAULTS, SKINS } = self.SpiderShared;
const $ = (id) => document.getElementById(id);

function fillSkins(sel, settings) {
  sel.innerHTML = '';
  for (const [id, s] of Object.entries(SKINS)) sel.add(new Option(s.name, id));
  for (const name of Object.keys(settings.customSkins || {})) sel.add(new Option(`★ ${name}`, `custom:${name}`));
  sel.value = settings.skin;
  if (sel.value !== settings.skin) sel.value = 'venom';
}

function jevLine(v) {
  if (!v.hunt.trim()) return 'Jev: idle (no hunt set, every link is a find)';
  if (!v.jevKeySet) return 'Jev: no key, using keyword match';
  if (!v.useJev) return 'Jev: off, using keyword match';
  return `Jev: on (${v.jevProvider}), judging links`;
}

chrome.storage.local.get(Object.assign({}, DEFAULTS, { crawlLog: [], jevKeySet: false, jevProvider: 'typesafe' }), (v) => {
  $('enabled').checked = !!v.enabled;
  $('hunt').value = v.hunt || '';
  $('mode').value = v.mode;
  $('creature').value = v.creature;
  fillSkins($('skin'), v);
  $('count').textContent = String((v.crawlLog || []).length);
  $('jevState').textContent = jevLine(v);
});

$('enabled').addEventListener('change', () => chrome.storage.local.set({ enabled: $('enabled').checked }));
$('mode').addEventListener('change', () => chrome.storage.local.set({ mode: $('mode').value }));
$('creature').addEventListener('change', () => chrome.storage.local.set({ creature: $('creature').value }));
$('skin').addEventListener('change', () => chrome.storage.local.set({ skin: $('skin').value }));
let huntTimer = null;
$('hunt').addEventListener('input', () => {
  clearTimeout(huntTimer);
  huntTimer = setTimeout(() => chrome.storage.local.set({ hunt: $('hunt').value.trim() }), 400);
});

$('export').addEventListener('click', () => {
  chrome.storage.local.get({ crawlLog: [] }, (v) => {
    const blob = new Blob([JSON.stringify(v.crawlLog, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'spider-crawl-log.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
});
$('clear').addEventListener('click', () => chrome.storage.local.set({ crawlLog: [] }, () => { $('count').textContent = '0'; }));
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.crawlLog) $('count').textContent = String((changes.crawlLog.newValue || []).length);
  if (changes.jevKeySet || changes.hunt || changes.useJev) {
    chrome.storage.local.get(Object.assign({}, DEFAULTS, { jevKeySet: false, jevProvider: 'typesafe' }), (v) => {
      $('jevState').textContent = jevLine(v);
    });
  }
});
