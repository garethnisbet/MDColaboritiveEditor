// Spelling suggestions for spell.js, off the main thread: Typo.js's suggest() can take seconds.

let dict;

self.onmessage = async ({ data }) => {
  if (data.init) {
    importScripts(data.init.typo);
    dict = Promise.all(['aff', 'dic'].map(x => fetch(`${data.init.dict}.${x}`).then(r => r.text())))
      .then(([aff, dic]) => new Typo('en_GB', aff, dic));
    return;
  }
  let list = [];
  try { list = (await dict).suggest(data.word, 10); } catch {}
  self.postMessage({ id: data.id, list });
};
