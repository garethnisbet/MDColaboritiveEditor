// Spell checking: Typo.js with a British English Hunspell dictionary from the CDN.
// Words are checked on the page; suggestions, which can take seconds, come from spell-worker.js.

const SPELL = (() => {
  const TYPO = 'https://cdn.jsdelivr.net/npm/typo-js@1.2.4/typo.js';
  const DICT = 'https://cdn.jsdelivr.net/npm/dictionary-en-gb@3/index';
  const WORD = /^[\p{L}\p{N}_]+(?:['’]\p{L}+)*/u;
  const WORDS = new RegExp(WORD.source.slice(1), 'gu');
  const KEY = 'mdedit.words';

  let dict = null;
  const cache = new Map();
  const ignored = new Set();
  let personal;
  try { personal = new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { personal = new Set(); }

  const ready = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = TYPO; s.onload = res; s.onerror = () => rej(new Error('could not load Typo.js'));
    document.head.append(s);
  })
    .then(() => Promise.all(['aff', 'dic'].map(x => fetch(`${DICT}.${x}`).then(r => {
      if (!r.ok) throw new Error(`dictionary ${x}: HTTP ${r.status}`);
      return r.text();
    }))))
    .then(([aff, dic]) => { dict = new Typo('en_GB', aff, dic); });

  // Acronyms, identifiers, camelCase and words with digits are not prose.
  const skip = w => w.length < 2 || /[\d_]/.test(w) || w === w.toUpperCase() || /\p{Ll}\p{Lu}/u.test(w);

  function ok(word) {
    if (!dict) return true;
    const w = word.replace(/’/g, "'");
    if (skip(w) || personal.has(w.toLowerCase()) || ignored.has(w)) return true;
    let r = cache.get(w);
    if (r === undefined) { r = dict.check(w) || dict.check(w.toLowerCase()); cache.set(w, r); }
    return r;
  }

  // CodeMirror overlay: tags misspelt words 'spell-error'; URLs, emails, inline HTML tags
  // and TeX commands are passed over.
  const SKIP = /^(?:(?:[a-z][\w+.-]*:\/\/|www\.)\S+|\S+@\S+\.\w+|<!--.*?(?:-->|$)|<\/?[A-Za-z][^>]*>|\\[A-Za-z]+)/i;
  const overlay = {
    name: 'spell',
    token(stream) {
      if (stream.match(SKIP)) return null;
      if (stream.match(WORD)) return ok(stream.current()) ? null : 'spell-error';
      stream.next();
      while (!stream.eol() && !/[\p{L}\p{N}_\\<]/u.test(stream.peek())) stream.next();
      return null;
    },
  };

  function wordAt(text, ch) {
    for (const m of text.matchAll(WORDS)) {
      if (m.index <= ch && ch <= m.index + m[0].length) return { text: m[0], from: m.index, to: m.index + m[0].length };
      if (m.index > ch) break;
    }
    return null;
  }

  let worker = null, seq = 0;
  const waiting = new Map();
  function suggest(word) {
    if (!worker) {
      worker = new Worker('spell-worker.js');
      worker.postMessage({ init: { typo: TYPO, dict: DICT } });
      worker.onmessage = ({ data }) => { waiting.get(data.id)?.(data.list); waiting.delete(data.id); };
    }
    const id = ++seq;
    worker.postMessage({ id, word: word.replace(/’/g, "'") });
    const cap = /^\p{Lu}/u.test(word);
    return new Promise(res => waiting.set(id, res)).then(list => {
      const seen = new Set(), out = [];
      for (let s of list) {
        if (/\d/.test(s)) continue;
        if (cap) s = s[0].toUpperCase() + s.slice(1);
        if (!seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
      }
      return out.slice(0, 6);
    });
  }

  function add(word) {
    personal.add(word.replace(/’/g, "'").toLowerCase());
    try { localStorage.setItem(KEY, JSON.stringify([...personal])); } catch {}
  }
  const ignore = word => ignored.add(word.replace(/’/g, "'"));

  return { ready, ok, overlay, wordAt, suggest, add, ignore };
})();
