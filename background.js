// Spider Crawler: background service worker.
// Calls the Jev decision model (TypeSafe or a compatible provider) on behalf of
// the content script, so the request is not subject to the page's CORS policy.
// The API key lives only in chrome.storage.local and is sent only to the
// provider endpoint the user picked.

const PROVIDERS = {
  typesafe: { url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' },
  openrouter: { url: 'https://openrouter.ai/api/alpha/decisions', model: '~typesafe/jev-latest' },
  venice: { url: 'https://api.venice.ai/api/v1/decisions', model: 'jev-latest' },
  zen: { url: 'https://opencode.ai/zen/v1/systemone', model: 'jev-1.13-free' },
};
const TIMEOUT_MS = 8000;
const MAX_LINKS = 24;

function buildRequest(hunt, page, links, model) {
  const state = {
    hunt,
    page_title: String(page.title || '').slice(0, 200),
    page_url: String(page.url || '').slice(0, 300),
    links: {},
  };
  const questions = {};
  links.slice(0, MAX_LINKS).forEach((l, i) => {
    const id = `l${i}`;
    state.links[id] = { text: String(l.text || '').slice(0, 160), url: String(l.href || '').slice(0, 300) };
    questions[id] = {
      type: 'noul',
      instructions: `The link \`links.${id}\` (its text and URL) leads to what the reader is hunting for, described in \`hunt\`.`,
      criteria: {
        true: 'The link text or URL is clearly about the hunted topic.',
        false: 'The link is about something else, is navigation, or is unrelated.',
      },
    };
  });
  return { state, model, questions };
}

async function judge({ hunt, page, links }) {
  const cfg = await chrome.storage.local.get({ jevKey: '', jevProvider: 'typesafe' });
  if (!cfg.jevKey) return { ok: false, error: 'no_key' };
  const prov = PROVIDERS[cfg.jevProvider] || PROVIDERS.typesafe;
  const body = buildRequest(hunt, page, links, prov.model);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${cfg.jevKey}`,
  };
  if (cfg.jevProvider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/AlungranPJ/spider-crawler-extension';
    headers['X-Title'] = 'Spider Crawler';
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetch(prov.url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    const latency = Math.round(performance.now() - t0);
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'auth_failed' };
    if (res.status === 429) return { ok: false, error: 'rate_limited' };
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const data = await res.json();
    const answers = data && data.answers;
    if (!answers || typeof answers !== 'object') return { ok: false, error: 'malformed' };
    const n = Math.min(links.length, MAX_LINKS);
    const probs = [];
    for (let i = 0; i < n; i++) {
      const a = answers[`l${i}`];
      const p = a && typeof a.noul === 'number' && isFinite(a.noul) ? Math.max(0, Math.min(1, a.noul)) : null;
      probs.push(p);
    }
    return { ok: true, probs, latency, perLink: n ? Math.round(latency / n) : latency, model: data.model || prov.model };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'jev-judge') {
    judge(msg).then(sendResponse);
    return true; // async response
  }
  if (msg && msg.type === 'jev-test') {
    judge({
      hunt: 'spiders',
      page: { title: 'Key test', url: 'about:test' },
      links: [{ text: 'Jumping spider anatomy', href: 'https://en.wikipedia.org/wiki/Jumping_spider' },
        { text: 'Privacy policy', href: 'https://example.com/privacy' }],
    }).then(sendResponse);
    return true;
  }
  return false;
});
