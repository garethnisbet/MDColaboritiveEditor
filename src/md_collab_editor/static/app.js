// MD Collaborative Editor — editor, preview, file sync and the Claude panel.

const $ = sel => document.querySelector(sel);
const esc = MD.esc;
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ------------------------------------------------------------------ state

const cur = { path: null, version: null, dirty: false, saving: false };
MD.setDocPath(() => cur.path || '');
let blocks = [];          // [{el, s, e}] from the last render
let blockLines = [];      // [{el, line}] for scroll sync
let cards = [];
let cardSeq = 0;
let skills = [];
let applyingRemote = false;

// ------------------------------------------------------------------ editor

const cm = CodeMirror($('#editor'), {
  mode: { name: 'gfm', highlightFormatting: true, fencedCodeBlockHighlighting: true },
  lineWrapping: true,
  inputStyle: 'contenteditable',   // the browser's spell checker only works on contenteditable input
  spellcheck: store.get('mdedit.spell', '1') === '1',
  indentUnit: 2,
  tabSize: 4,
  extraKeys: {
    Enter: 'newlineAndIndentContinueMarkdownList',
    'Ctrl-B': () => cmd('bold'), 'Cmd-B': () => cmd('bold'),
    'Ctrl-I': () => cmd('italic'), 'Cmd-I': () => cmd('italic'),
    'Ctrl-K': () => cmd('link'), 'Cmd-K': () => cmd('link'),
    'Ctrl-S': () => save(), 'Cmd-S': () => save(),
    'Ctrl-O': () => openBrowser(), 'Cmd-O': () => openBrowser(),
    'Ctrl-J': () => openAsk('editor', true), 'Cmd-J': () => openAsk('editor', true),
    Tab: c => c.somethingSelected() ? c.indentSelection('add') : c.execCommand('insertSoftTab'),
    'Shift-Tab': c => c.indentSelection('subtract'),
  },
});

function cmd(name) {
  const doc = cm.getDoc();
  const sel = doc.getSelection();
  const wrap = (a, b, ph) => {
    const text = sel || ph;
    doc.replaceSelection(a + text + b);
    if (!sel) {
      const c = doc.getCursor();
      doc.setSelection({ line: c.line, ch: c.ch - b.length - text.length }, { line: c.line, ch: c.ch - b.length });
    }
  };
  const eachLine = fn => {
    const { from, to } = { from: doc.getCursor('from'), to: doc.getCursor('to') };
    const last = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
    cm.operation(() => {
      for (let l = from.line, k = 0; l <= last; l++, k++) {
        const t = doc.getLine(l);
        doc.replaceRange(fn(t, k), { line: l, ch: 0 }, { line: l, ch: t.length });
      }
    });
  };
  const toggle = (re, prefix) => eachLine((t, k) => re.test(t) ? t.replace(re, '') : (typeof prefix === 'function' ? prefix(k) : prefix) + t);
  switch (name) {
    case 'bold': wrap('**', '**', 'bold text'); break;
    case 'italic': wrap('_', '_', 'italic text'); break;
    case 'strike': wrap('~~', '~~', 'struck text'); break;
    case 'code': wrap('`', '`', 'code'); break;
    case 'codeblock': wrap('```\n', '\n```', 'code'); break;
    case 'link': {
      doc.replaceSelection(`[${sel || 'link text'}](url)`);
      const c = doc.getCursor();
      doc.setSelection({ line: c.line, ch: c.ch - 4 }, { line: c.line, ch: c.ch - 1 });
      break;
    }
    case 'image': doc.replaceSelection(`![${sel || 'alt text'}](image.png)`); break;
    case 'h1': eachLine(t => {
      const m = /^(#{1,6}) /.exec(t);
      if (!m) return '# ' + t;
      return m[1].length >= 3 ? t.slice(m[0].length) : '#' + t;
    }); break;
    case 'quote': toggle(/^> ?/, '> '); break;
    case 'ul': toggle(/^\s*[-*+] (?!\[)/, '- '); break;
    case 'ol': toggle(/^\s*\d+[.)] /, k => `${k + 1}. `); break;
    case 'task': toggle(/^\s*[-*+] \[[ xX]\] /, '- [ ] '); break;
    case 'hr': doc.replaceSelection('\n\n---\n\n'); break;
    case 'table': doc.replaceSelection('\n| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| a | b | c |\n| d | e | f |\n'); break;
    case 'undo': cm.undo(); break;
    case 'redo': cm.redo(); break;
    case 'ask': openAsk(lastSelSource, true); return;
  }
  cm.focus();
}

// Spell checking: the browser's own checker underlines prose; code, URLs and HTML are excluded.
const NO_SPELL = '.cm-comment, .cm-url, .cm-string, .cm-tag, .cm-attribute, .cm-formatting-code-block';
cm.on('renderLine', (c, line, el) => {
  const st = c.getStateAfter(c.getLineNumber(line) - 1, true);
  const md = st && (st.base || st);   // gfm wraps the markdown state in an overlay
  if (md && (md.code || md.localMode || md.fencedEndRE) || el.querySelector('.cm-formatting-code-block')) {
    el.spellcheck = false;            // inside a fenced or indented code block
  } else {
    for (const s of el.querySelectorAll(NO_SPELL)) s.spellcheck = false;
  }
});
function setSpell(on) {
  cm.setOption('spellcheck', on);
  $('#spell').classList.toggle('on', on);
  store.set('mdedit.spell', on ? '1' : '0');
}
$('#spell').classList.toggle('on', cm.getOption('spellcheck'));
$('#spell').onclick = () => setSpell(!cm.getOption('spellcheck'));

$('#toolbar').addEventListener('mousedown', e => e.preventDefault());   // keep editor selection
$('#toolbar').addEventListener('click', e => {
  const b = e.target.closest('button[data-cmd]');
  if (b) cmd(b.dataset.cmd);
});

// ------------------------------------------------------------------ rendering

let renderT;
function scheduleRender() { clearTimeout(renderT); renderT = setTimeout(renderPreview, 120); }

function renderPreview() {
  const pane = $('#preview-pane');
  const top = pane.scrollTop;
  blocks = MD.render(cm.getValue(), $('#preview'));
  blockLines = blocks.filter(b => b.s >= 0).map(b => ({ el: b.el, line: cm.posFromIndex(b.s).line }));
  pane.scrollTop = top;
  highlightPreviewCards();
  updateStats();
}

function highlightPreviewCards() {
  for (const b of blocks) b.el.classList.remove('claude-hl', 'claude-hl-ready');
  for (const c of cards) {
    const r = c.marker?.find();
    if (!r || !['pending', 'ready'].includes(c.status)) continue;
    const s = cm.indexFromPos(r.from), e = cm.indexFromPos(r.to);
    for (const b of blocks) {
      if (b.s >= 0 && b.s < e && b.e > s) b.el.classList.add(c.status === 'pending' ? 'claude-hl' : 'claude-hl-ready');
    }
  }
}

function updateStats() {
  const text = cm.getValue();
  const words = (text.match(/[\p{L}\p{N}'’-]+/gu) || []).length;
  $('#stat-words').textContent = `${words.toLocaleString()} words · ${text.length.toLocaleString()} chars`;
}
cm.on('cursorActivity', () => {
  const c = cm.getCursor();
  $('#stat-cursor').textContent = `Ln ${c.line + 1}, Col ${c.ch + 1}`;
});

// task-list checkboxes toggle the source
$('#preview').addEventListener('change', e => {
  const b = e.target;
  if (b.type !== 'checkbox' || b.dataset.off === undefined) return;
  const p = cm.posFromIndex(+b.dataset.off);
  cm.replaceRange(b.checked ? 'x' : ' ', p, { line: p.line, ch: p.ch + 1 }, '+task');
});

// ------------------------------------------------------------------ scroll sync

let scrollLead = 'editor';
$('#editor-pane').addEventListener('mouseenter', () => { scrollLead = 'editor'; });
$('#preview-pane').addEventListener('mouseenter', () => { scrollLead = 'preview'; });

cm.on('scroll', () => {
  if (scrollLead !== 'editor' || !blockLines.length) return;
  const info = cm.getScrollInfo();
  const pane = $('#preview-pane');
  if (info.top + info.clientHeight >= info.height - 4) { pane.scrollTop = pane.scrollHeight; return; }
  const topLine = cm.lineAtHeight(info.top, 'local');
  let i = 0;
  while (i + 1 < blockLines.length && blockLines[i + 1].line <= topLine) i++;
  const a = blockLines[i], b = blockLines[i + 1];
  const ya = cm.heightAtLine(a.line, 'local');
  const yb = b ? cm.heightAtLine(b.line, 'local') : cm.getScrollInfo().height;
  const frac = Math.max(0, Math.min(1, (info.top - ya) / Math.max(1, yb - ya)));
  const pa = a.el.offsetTop, pb = b ? b.el.offsetTop : pane.scrollHeight;
  pane.scrollTop = pa + frac * (pb - pa) - 16;
});

$('#preview-pane').addEventListener('scroll', () => {
  if (scrollLead !== 'preview' || !blockLines.length) return;
  const pane = $('#preview-pane');
  const y = pane.scrollTop + 16;
  let i = 0;
  while (i + 1 < blockLines.length && blockLines[i + 1].el.offsetTop <= y) i++;
  const a = blockLines[i], b = blockLines[i + 1];
  const pa = a.el.offsetTop, pb = b ? b.el.offsetTop : pane.scrollHeight;
  const frac = Math.max(0, Math.min(1, (y - pa) / Math.max(1, pb - pa)));
  const ya = cm.heightAtLine(a.line, 'local');
  const yb = b ? cm.heightAtLine(b.line, 'local') : cm.getScrollInfo().height;
  cm.scrollTo(null, ya + frac * (yb - ya));
});

// ------------------------------------------------------------------ files & saving

async function api(method, url, body) {
  const r = await fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(data.error || r.statusText); err.status = r.status; err.data = data; throw err; }
  return data;
}

function setSaveState(text, cls = '') {
  const el = $('#save-state');
  el.textContent = text;
  el.className = cls || 'muted';
}

async function openFile(path) {
  if (cur.dirty) await save();
  let f;
  try { f = await api('GET', `/api/file?path=${encodeURIComponent(path)}`); }
  catch (e) { setSaveState(`Could not open ${path}: ${e.message}`, 'err'); return; }
  for (const c of cards) c.marker?.clear();
  cards = [];
  renderCards();
  Object.assign(cur, { path, version: f.version, dirty: false });
  applyingRemote = true;
  cm.setValue(f.text);
  cm.clearHistory();
  applyingRemote = false;
  $('#doc-name').textContent = path;
  document.title = `${path.split('/').pop()} — MD Editor`;
  history.replaceState(null, '', `#${encodeURIComponent(path)}`);
  store.set('mdedit.last', path);
  setSaveState('Saved');
  hideBanner();
  renderPreview();
  markActiveFile();
}

let saveT;
cm.on('change', (_, change) => {
  scheduleRender();
  if (applyingRemote || !cur.path) return;
  cur.dirty = true;
  setSaveState('Editing…');
  clearTimeout(saveT);
  saveT = setTimeout(save, 800);
});

async function save(force = false) {
  clearTimeout(saveT);
  if (!cur.path || cur.saving) { if (cur.saving) saveT = setTimeout(save, 300); return; }
  if (!cur.dirty && !force) return;
  const text = cm.getValue();
  cur.saving = true;
  setSaveState('Saving…');
  try {
    const r = await api('PUT', '/api/file', { path: cur.path, text, base_version: cur.version, force });
    cur.version = r.version;
    if (cm.getValue() === text) { cur.dirty = false; setSaveState('Saved'); }
    hideBanner();
  } catch (e) {
    if (e.status === 409) {
      setSaveState('Conflict', 'err');
      showBanner('This file was changed on disk while you were editing.',
        [['Load disk version', () => applyRemote(e.data.text, e.data.version)],
         ['Keep mine (overwrite)', () => save(true)]]);
    } else setSaveState(`Save failed: ${e.message}`, 'err');
  } finally {
    cur.saving = false;
  }
}

// Replace the editor text with `text` by editing only the changed middle, so the
// cursor, undo history and Claude markers elsewhere survive; flash what changed.
function applyRemote(text, version) {
  const old = cm.getValue();
  cur.version = version;
  cur.dirty = false;
  if (old !== text) {
    let a = 0;
    while (a < old.length && a < text.length && old[a] === text[a]) a++;
    let b = 0;
    while (b < old.length - a && b < text.length - a && old[old.length - 1 - b] === text[text.length - 1 - b]) b++;
    const from = cm.posFromIndex(a), to = cm.posFromIndex(old.length - b);
    const ins = text.slice(a, text.length - b);
    applyingRemote = true;
    cm.replaceRange(ins, from, to, 'remote');
    applyingRemote = false;
    if (ins) {
      const m = cm.markText(from, cm.posFromIndex(a + ins.length), { className: 'remote-flash' });
      setTimeout(() => m.clear(), 2500);
    }
  }
  setSaveState('Updated from disk', 'ok');
  hideBanner();
}

function showBanner(msg, actions) {
  const el = $('#banner');
  el.replaceChildren(Object.assign(document.createElement('span'), { textContent: msg }));
  for (const [label, fn] of actions) {
    const b = Object.assign(document.createElement('button'), { textContent: label });
    b.onclick = fn;
    el.appendChild(b);
  }
  el.hidden = false;
}
function hideBanner() { $('#banner').hidden = true; }

let fileList = [];
function renderFiles() {
  const ul = $('#file-list');
  ul.replaceChildren();
  for (const f of fileList) {
    const li = document.createElement('li');
    const parts = f.path.split('/');
    li.innerHTML = (parts.length > 1 ? `<span class="muted">${esc(parts.slice(0, -1).join('/'))}/</span>` : '') + esc(parts.at(-1));
    li.dataset.path = f.path;
    li.title = f.path;
    li.onclick = () => openFile(f.path);
    ul.appendChild(li);
  }
  markActiveFile();
}
function markActiveFile() {
  document.querySelectorAll('#file-list li').forEach(li => li.classList.toggle('active', li.dataset.path === cur.path));
}

$('#new-file').onclick = () => {
  if ($('#new-file-input')) return;
  const input = Object.assign(document.createElement('input'), { id: 'new-file-input', placeholder: 'name.md, then Enter' });
  $('#file-list').before(input);
  input.focus();
  input.onkeydown = async e => {
    if (e.key === 'Escape') input.remove();
    if (e.key !== 'Enter' || !input.value.trim()) return;
    try {
      const r = await api('POST', '/api/new', { path: input.value.trim() });
      input.remove();
      fileList = await api('GET', '/api/files');
      renderFiles();
      openFile(r.path);
    } catch (err) { input.classList.add('bad'); input.title = err.message; }
  };
  input.onblur = () => setTimeout(() => input.remove(), 150);
};

function listenForChanges() {
  const es = new EventSource('/api/events');
  es.onmessage = async ev => {
    fileList = JSON.parse(ev.data);
    renderFiles();
    const f = fileList.find(x => x.path === cur.path);
    if (!f || f.version === cur.version || cur.saving) return;
    const disk = await api('GET', `/api/file?path=${encodeURIComponent(cur.path)}`);
    if (disk.version === cur.version || cur.saving) return;
    if (disk.text === cm.getValue()) { cur.version = disk.version; return; }
    if (!cur.dirty) applyRemote(disk.text, disk.version);
    else showBanner('This file was changed on disk while you were editing.',
      [['Load disk version', () => applyRemote(disk.text, disk.version)],
       ['Keep mine (overwrite)', () => save(true)]]);
  };
}

// ------------------------------------------------------------------ selection → source range

let lastSelSource = 'editor';
let previewRange = null;   // {from, to} source indices from the last preview selection

function wordsOf(s) { return s.match(/[\p{L}\p{N}]+/gu) || []; }
function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Map the current DOM selection inside the preview to a source range.
function previewSelectionToSource() {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  if (!$('#preview').contains(r.commonAncestorContainer)) return null;
  const blockOf = n => (n.nodeType === 1 ? n : n.parentElement)?.closest('[data-s]');
  let a = blockOf(r.startContainer), b = blockOf(r.endContainer);
  if (!a || !b) return null;
  let s = +a.dataset.s, e = +b.dataset.e;
  if (s < 0 || e < 0 || e < s) return null;
  const src = cm.getValue();
  const chunk = src.slice(s, e);
  // Narrow the block range to the selected words, allowing markdown syntax between them.
  const words = wordsOf(sel.toString());
  if (words.length) {
    const tries = [words.map(reEsc).join('[^\\p{L}\\p{N}]+'), words.map(reEsc).join('[\\s\\S]*?')];
    for (const pat of tries) {
      const m = new RegExp(pat, 'u').exec(chunk);
      if (m) {
        let ms = s + m.index, me = ms + m[0].length;
        // pull in emphasis/code markers hugging the ends so markup stays balanced
        while (ms > s && /[*_~`]/.test(src[ms - 1])) ms--;
        while (me < e && /[*_~`.,;:!?)\]]/.test(src[me])) me++;
        return { from: ms, to: me };
      }
    }
  }
  while (e > s && /\s/.test(src[e - 1])) e--;
  return { from: s, to: e };
}

$('#preview-pane').addEventListener('mouseup', () => {
  setTimeout(() => {
    const r = previewSelectionToSource();
    if (!r || r.to <= r.from) return;
    previewRange = r;
    lastSelSource = 'preview';
    cm.getInputField().blur();   // a focused editor would re-read its input field as typing
    cm.setSelection(cm.posFromIndex(r.from), cm.posFromIndex(r.to));
    if (cm.getWrapperElement().offsetParent) cm.scrollIntoView({ from: cm.posFromIndex(r.from), to: cm.posFromIndex(r.to) }, 60);
    openAsk('preview', false);
  }, 0);
});

// Click (not drag) in the preview moves the editor cursor to that block.
$('#preview').addEventListener('click', e => {
  if (!window.getSelection().isCollapsed || e.target.closest('a,input')) return;
  const el = e.target.closest('[data-s]');
  if (!el || +el.dataset.s < 0 || !$('#main').classList.contains('split')) return;
  const p = cm.posFromIndex(+el.dataset.s);
  cm.setCursor(p);
  cm.scrollIntoView(p, 80);
});

// A small pill offers Claude when text is mouse-selected in the editor.
const pill = Object.assign(document.createElement('button'), { id: 'ask-pill', textContent: '✦ Ask Claude', hidden: true });
document.body.appendChild(pill);
pill.addEventListener('mousedown', e => e.preventDefault());
pill.onclick = () => { pill.hidden = true; openAsk('editor', true); };
cm.getWrapperElement().addEventListener('mouseup', () => setTimeout(() => {
  lastSelSource = 'editor';
  if (!cm.somethingSelected()) { pill.hidden = true; return; }
  const c = cm.cursorCoords(cm.getCursor('to'), 'window');
  placeFloating(pill, c.left, c.bottom + 6);
  pill.hidden = false;
}, 0));
cm.on('keydown', () => { pill.hidden = true; });
cm.on('blur', () => setTimeout(() => { if (document.activeElement !== pill) pill.hidden = true; }, 150));

function placeFloating(el, x, y) {
  el.style.left = '0px'; el.style.top = '0px';
  const w = el.offsetWidth || 300, h = el.offsetHeight || 40;
  el.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
  el.style.top = (y + h > innerHeight - 8 ? Math.max(8, y - h - 40) : y) + 'px';
}

// ------------------------------------------------------------------ ask bar

const PRESETS = [
  { label: 'Improve', instr: 'Rewrite this so it reads better: clearer and more fluent, with the same meaning and roughly the same length.' },
  { label: 'Tighten', instr: 'Make this more concise. Cut redundancy and filler without losing any meaning.' },
  { label: 'Expand', instr: 'Expand this with more detail and explanation, in the same style.' },
  { label: 'Simplify', instr: 'Rewrite this in plainer language for a non-specialist reader.' },
  { label: 'Fix grammar', instr: 'Fix spelling, grammar and punctuation only. Change nothing else.' },
  { label: 'More formal', instr: 'Rewrite this in a more formal, professional register.' },
  { label: 'More casual', instr: 'Rewrite this in a friendlier, more conversational tone.' },
  { label: 'To bullets', instr: 'Restructure this as a markdown bulleted list.' },
  { label: 'To prose', instr: 'Rewrite this as flowing prose paragraphs.' },
  { label: 'Critique', mode: 'comment', instr: 'Critique this passage: clarity, structure, argument and style. Be specific and brief.' },
];

let askTarget = null;   // {from, to} captured when the bar opened

function currentRange(source) {
  if (source === 'preview' && previewRange) return previewRange;
  if (cm.somethingSelected()) return { from: cm.indexFromPos(cm.getCursor('from')), to: cm.indexFromPos(cm.getCursor('to')) };
  return { from: 0, to: cm.getValue().length, whole: true };
}

function buildPresets() {
  const box = $('#ask-presets');
  box.replaceChildren();
  const all = [
    ...skills.map(s => ({
      label: /writing-style|voice/.test(s.name) ? '✎ My style' : `Skill: ${s.name}`,
      title: s.description,
      instr: `Rewrite this using the \`${s.name}\` skill.`,
      cls: 'skill',
    })),
    ...PRESETS,
  ];
  for (const p of all) {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: p.label, title: p.title || p.instr });
    if (p.cls) b.classList.add(p.cls);
    if (p.mode === 'comment') b.classList.add('comment');
    b.onclick = () => submitAsk(p.instr, p.mode || 'replace', p.label);
    box.appendChild(b);
  }
}

function openAsk(source, focus) {
  askTarget = currentRange(source);
  if (source !== 'preview') previewRange = null;
  const bar = $('#askbar');
  bar.hidden = false;
  bar.classList.toggle('whole', !!askTarget.whole);
  $('#ask-input').placeholder = askTarget.whole
    ? 'Nothing selected: ask Claude about the whole document… (Enter)'
    : 'Ask Claude to… (Enter to send · end with ? for a comment · Esc closes)';
  let x, y;
  const sel = window.getSelection();
  if (source === 'preview' && sel.rangeCount && !sel.isCollapsed) {
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    x = rect.left; y = rect.bottom + 8;
  } else if (!askTarget.whole) {
    const c = cm.cursorCoords(cm.posFromIndex(askTarget.to), 'window');
    x = c.left; y = c.bottom + 8;
  } else {
    const r = $('#editor-pane').getBoundingClientRect();
    x = r.left + 40; y = r.top + 60;
  }
  placeFloating(bar, x, y);
  pill.hidden = true;
  if (focus) $('#ask-input').focus();
}

function closeAsk() { $('#askbar').hidden = true; askTarget = null; }

$('#ask-form').onsubmit = e => {
  e.preventDefault();
  const v = $('#ask-input').value.trim();
  if (!v) return;
  submitAsk(v, v.endsWith('?') ? 'comment' : 'replace', v);
  $('#ask-input').value = '';
};
$('#ask-input').addEventListener('keydown', e => { if (e.key === 'Escape') closeAsk(); });
document.addEventListener('mousedown', e => {
  if (!$('#askbar').hidden && !e.target.closest('#askbar')) closeAsk();
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j' && !cm.hasFocus()) { e.preventDefault(); openAsk(lastSelSource, true); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !cm.hasFocus()) { e.preventDefault(); save(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o' && !cm.hasFocus()) { e.preventDefault(); openBrowser(); }
  if (e.key === 'Escape' && !$('#askbar').hidden) closeAsk();
});

function submitAsk(instr, mode, label) {
  if (!askTarget) return;
  const t = askTarget;
  closeAsk();
  if (!cm.hasFocus()) window.getSelection().removeAllRanges();
  createCard({ from: t.from, to: t.to, whole: !!t.whole, instruction: instr, mode, label });
}

// ------------------------------------------------------------------ Claude cards

function markCard(c, cls) {
  const r = c.marker?.find();
  c.marker?.clear();
  if (!r && c.marker) { c.marker = null; return; }
  const from = r ? r.from : cm.posFromIndex(c.from), to = r ? r.to : cm.posFromIndex(c.to);
  c.marker = cm.markText(from, to, { className: `claude-mark ${cls} card-${c.id}`, clearWhenEmpty: false, inclusiveLeft: false, inclusiveRight: false });
}

function createCard({ from, to, whole, instruction, mode, label }) {
  const c = { id: ++cardSeq, from, to, whole, instruction, mode, label, status: 'pending', original: cm.getValue().slice(from, to), result: '', view: 'diff' };
  markCard(c, 'pending');
  cards.unshift(c);
  document.body.classList.remove('no-claude');
  run(c);
}

async function run(c, feedback) {
  const r = c.marker?.find();
  if (!r) { c.status = 'error'; c.error = 'The highlighted text was deleted.'; renderCards(); return; }
  const doc = cm.getValue();
  const start = cm.indexFromPos(r.from), end = cm.indexFromPos(r.to);
  c.original = doc.slice(start, end);
  c.status = 'pending';
  c.started = Date.now();
  c.error = null;
  markCard(c, 'pending');
  renderCards();
  highlightPreviewCards();
  const body = {
    path: cur.path, doc, start, end, mode: c.mode, model: $('#model').value,
    instruction: feedback || c.instruction,
  };
  if (feedback && c.result) body.previous = c.result;
  if (feedback === null && c.result) {   // Retry
    body.instruction = c.instruction + '\n\n(Give a noticeably different version from the previous attempt.)';
    body.previous = c.result;
  }
  try {
    const res = await api('POST', '/api/ask', body);
    if (c.status === 'cancelled') return;
    if (c.mode === 'replace') {
      const lead = c.original.match(/^\s*/)[0], trail = c.original.match(/\s*$/)[0];
      c.result = lead + res.result.trim() + trail;
    } else c.result = res.result.trim();
    c.meta = `${res.seconds}s${res.cost ? ` · $${res.cost.toFixed(3)}` : ''}`;
    c.status = 'ready';
    c.view = 'diff';
    if (feedback) c.history = [...(c.history || []), feedback];
    markCard(c, 'ready');
  } catch (e) {
    if (c.status === 'cancelled') return;
    c.status = 'error';
    c.error = e.message;
    markCard(c, 'error');
  }
  renderCards();
  highlightPreviewCards();
}

function finish(c, status) {
  c.status = status;
  c.marker?.clear();
  c.marker = null;
  renderCards();
  highlightPreviewCards();
}

function accept(c) {
  const r = c.marker?.find();
  if (!r) { c.status = 'error'; c.error = 'The highlighted text was deleted, so there is nowhere to put the result.'; renderCards(); return; }
  const text = c.editing ?? c.result;
  cm.replaceRange(text, r.from, r.to, '+claude');
  const end = cm.posFromIndex(cm.indexFromPos(r.from) + text.length);
  const m = cm.markText(r.from, end, { className: 'accepted-flash' });
  setTimeout(() => m.clear(), 2000);
  c.editing = undefined;
  finish(c, 'accepted');
}

function renderCards() {
  const box = $('#cards');
  box.replaceChildren();
  if (!cards.length) {
    box.innerHTML = `<p class="muted hint">Highlight text in the editor or the preview, then pick an action from the pop-up (or press <kbd>Ctrl</kbd>+<kbd>J</kbd>). With nothing selected, the request applies to the whole document.</p>`;
    return;
  }
  for (const c of cards) box.appendChild(cardEl(c));
}

function cardEl(c) {
  const el = document.createElement('div');
  el.className = `card ${c.status} ${c.mode}`;
  const excerpt = c.whole ? 'Whole document' : c.original.trim().replace(/\s+/g, ' ');
  const statusText = { pending: 'Thinking…', ready: c.mode === 'comment' ? 'Comment' : 'Suggestion', accepted: 'Accepted', kept: 'Kept original', dismissed: 'Dismissed', error: 'Error', cancelled: 'Cancelled' }[c.status];
  el.innerHTML = `
    <div class="card-head">
      <span class="badge">${statusText}</span>
      <span class="card-label" title="${esc(c.instruction)}">${esc(c.label)}</span>
      <span class="muted card-meta">${c.status === 'pending' ? '<span class="spinner"></span>' : esc(c.meta || '')}</span>
    </div>
    <div class="card-excerpt muted" title="Click to show in the editor">“${esc(excerpt.length > 140 ? excerpt.slice(0, 140) + '…' : excerpt)}”</div>
    ${(c.history || []).length ? `<div class="card-history muted">↳ ${c.history.map(esc).join('<br>↳ ')}</div>` : ''}
    <div class="card-body"></div>
    <div class="card-actions"></div>`;
  const body = el.querySelector('.card-body');
  const actions = el.querySelector('.card-actions');
  const btn = (label, fn, cls = '') => {
    const b = Object.assign(document.createElement('button'), { textContent: label, className: cls });
    b.onclick = fn;
    actions.appendChild(b);
    return b;
  };

  if (c.status === 'error') body.innerHTML = `<div class="err">${esc(c.error)}</div>`;

  if (c.status === 'pending') {
    btn('Cancel', () => finish(c, 'cancelled'));
  } else if (c.status === 'ready' && c.mode === 'replace') {
    const tabs = document.createElement('div');
    tabs.className = 'seg small';
    for (const [v, t] of [['diff', 'Changes'], ['render', 'Preview'], ['edit', 'Edit']]) {
      const b = Object.assign(document.createElement('button'), { textContent: t, className: c.view === v ? 'on' : '' });
      b.onclick = () => { c.view = v; if (v === 'edit' && c.editing === undefined) c.editing = c.result; renderCards(); };
      tabs.appendChild(b);
    }
    body.appendChild(tabs);
    const view = document.createElement('div');
    view.className = 'card-view';
    if (c.view === 'diff') view.innerHTML = `<div class="diff">${wordDiff(c.original, c.editing ?? c.result)}</div>`;
    else if (c.view === 'render') { view.className += ' markdown-body'; MD.render(c.editing ?? c.result, view); }
    else {
      const ta = Object.assign(document.createElement('textarea'), { value: c.editing ?? c.result });
      ta.rows = Math.min(16, (c.editing ?? c.result).split('\n').length + 2);
      ta.oninput = () => { c.editing = ta.value; };
      view.appendChild(ta);
    }
    body.appendChild(view);
    const r = c.marker?.find();
    if (r && cm.getRange(r.from, r.to) !== c.original) {
      body.insertAdjacentHTML('beforeend', '<div class="warn">The highlighted text has been edited since this was requested; Accept will overwrite those edits.</div>');
    }
    btn('Accept', () => accept(c), 'primary');
    btn('Keep original', () => finish(c, 'kept'));
    btn('Retry', () => run(c, null));
  } else if (c.status === 'ready' && c.mode === 'comment') {
    const view = document.createElement('div');
    view.className = 'card-view markdown-body';
    MD.render(c.result, view);
    body.appendChild(view);
    btn('Apply this feedback', () => {
      const r = c.marker?.find();
      if (!r) return;
      finish(c, 'dismissed');
      createCard({ from: cm.indexFromPos(r.from), to: cm.indexFromPos(r.to), whole: c.whole, mode: 'replace', label: 'Apply feedback',
        instruction: `Revise this passage to address the following feedback:\n\n${c.result}` });
    }, 'primary');
    btn('Dismiss', () => finish(c, 'dismissed'));
  } else if (c.status === 'error') {
    btn('Retry', () => run(c));
    btn('Dismiss', () => finish(c, 'dismissed'));
  }

  if (c.status === 'ready') {
    const f = document.createElement('form');
    f.className = 'refine';
    f.innerHTML = `<input placeholder="${c.mode === 'comment' ? 'Follow-up question…' : 'Refine: e.g. shorter, keep the first sentence…'}">`;
    f.onsubmit = e => { e.preventDefault(); const v = f.firstChild.value.trim(); if (v) run(c, v); };
    el.appendChild(f);
  }

  el.querySelector('.card-excerpt').onclick = () => {
    const r = c.marker?.find();
    if (!r) return;
    cm.setSelection(r.from, r.to);
    cm.scrollIntoView({ from: r.from, to: r.to }, 80);
    cm.focus();
  };
  el.onmouseenter = () => document.querySelectorAll(`.card-${c.id}`).forEach(n => n.classList.add('focus'));
  el.onmouseleave = () => document.querySelectorAll(`.card-${c.id}`).forEach(n => n.classList.remove('focus'));
  return el;
}

$('#clear-cards').onclick = () => {
  cards = cards.filter(c => ['pending', 'ready'].includes(c.status));
  renderCards();
};

// Word-level diff (LCS) rendered as <del>/<ins>.
function wordDiff(a, b) {
  const tok = s => s.match(/\s+|[\p{L}\p{N}'’]+|[^\s\p{L}\p{N}]/gu) || [];
  const A = tok(a), B = tok(b), n = A.length, m = B.length;
  if (n * m > 4e6) return `<del>${esc(a)}</del><ins>${esc(b)}</ins>`;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * (m + 1) + j] = A[i] === B[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
  const out = [];
  let i = 0, j = 0;
  const push = (t, s) => { const l = out.at(-1); if (l && l[0] === t) l[1] += s; else out.push([t, s]); };
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('=', A[i]); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) push('-', A[i++]);
    else push('+', B[j++]);
  }
  while (i < n) push('-', A[i++]);
  while (j < m) push('+', B[j++]);
  return out.map(([t, s]) => t === '=' ? esc(s) : t === '-' ? `<del>${esc(s)}</del>` : `<ins>${esc(s)}</ins>`).join('');
}

// ------------------------------------------------------------------ file browser

let rootDir = '';
let browseState = null;   // last /api/browse result
let browseSel = -1;

async function openBrowser() {
  $('#browser').hidden = false;
  await browseTo(browseState?.dir || rootDir);
  $('#browser-path').focus();
  $('#browser-path').select();
}
function closeBrowser() { $('#browser').hidden = true; cm.focus(); }

async function browseTo(dir) {
  const msg = $('#browser-msg');
  try {
    browseState = await api('GET', `/api/browse?dir=${encodeURIComponent(dir)}`);
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'err';
    return;
  }
  msg.textContent = 'Click a folder to enter it; click a .md file to open it.';
  msg.className = 'muted';
  $('#browser-path').value = browseState.dir;
  $('#browser-up').disabled = !browseState.parent;
  browseSel = -1;
  const ul = $('#browser-list');
  ul.replaceChildren();
  if (!browseState.entries.length) {
    ul.innerHTML = '<li class="empty">No folders or markdown files here.</li>';
    return;
  }
  browseState.entries.forEach((en, i) => {
    const li = document.createElement('li');
    li.className = en.dir ? 'dir' : 'md';
    li.innerHTML = `<span class="ico">${en.dir ? '📁' : '📄'}</span>${esc(en.name)}`;
    li.title = en.name;
    li.onclick = () => chooseEntry(i);
    ul.appendChild(li);
  });
}

function joinPath(dir, name) { return dir.replace(/\/+$/, '') + '/' + name; }

function chooseEntry(i) {
  const en = browseState.entries[i];
  const full = joinPath(browseState.dir, en.name);
  if (en.dir) browseTo(full);
  else switchRoot(full);
}

function selectEntry(i) {
  const items = [...document.querySelectorAll('#browser-list li:not(.empty)')];
  if (!items.length) return;
  browseSel = Math.max(0, Math.min(items.length - 1, i));
  items.forEach((li, k) => li.classList.toggle('sel', k === browseSel));
  items[browseSel].scrollIntoView({ block: 'nearest' });
}

// Point the server at a folder, or at a file's folder, then open the file.
async function switchRoot(path) {
  if (cur.dirty) await save();
  let r;
  try { r = await api('POST', '/api/root', { path }); }
  catch (e) { $('#browser-msg').textContent = e.message; $('#browser-msg').className = 'err'; return; }
  $('#browser').hidden = true;
  setRoot(r.root);
  fileList = r.files;
  for (const c of cards) c.marker?.clear();
  cards = [];
  renderCards();
  cur.path = null;
  renderFiles();
  const want = r.initial || fileList[0]?.path;
  if (want) { await openFile(want); cm.focus(); return; }
  Object.assign(cur, { path: null, version: null, dirty: false });
  applyingRemote = true;
  cm.setValue('');
  applyingRemote = false;
  $('#doc-name').textContent = 'No markdown files in this folder';
  setSaveState('Use “+ New” to create one', 'muted');
  document.body.classList.remove('no-files');
  renderPreview();
}

function setRoot(root) {
  rootDir = root;
  $('#file-root').textContent = root;
  $('#stat-root').textContent = root;
}

$('#open-browse').onclick = openBrowser;
$('#browse-btn').onclick = openBrowser;
$('#browser-close').onclick = closeBrowser;
$('#browser').addEventListener('mousedown', e => { if (e.target.id === 'browser') closeBrowser(); });
$('#browser-up').onclick = () => browseState?.parent && browseTo(browseState.parent);
$('#browser-home').onclick = () => browseTo(browseState?.home || '~');
$('#browser-use-folder').onclick = () => browseState && switchRoot(browseState.dir);
$('#browser-path-form').onsubmit = e => {
  e.preventDefault();
  const v = $('#browser-path').value.trim();
  if (!v) return;
  if (/\.(md|markdown)$/i.test(v)) switchRoot(v);
  else browseTo(v);
};
$('#browser').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); closeBrowser(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); selectEntry(browseSel + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); selectEntry(browseSel - 1); }
  else if (e.key === 'Enter' && browseSel >= 0) { e.preventDefault(); chooseEntry(browseSel); }
  else if (e.key === 'Backspace' && e.altKey && browseState?.parent) { e.preventDefault(); browseTo(browseState.parent); }
});

// ------------------------------------------------------------------ PDF export

async function exportPdf() {
  if (!cur.path) return;
  if (cur.dirty) await save();
  const btn = $('#export-pdf');
  btn.disabled = true;
  setSaveState('Exporting PDF…');
  try {
    // render a clean light-theme copy so dark mode and Claude highlights stay out of the PDF
    const wasDark = document.documentElement.dataset.theme === 'dark';
    if (wasDark) MD.initMermaid(false);
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;left:-10000px;top:0;width:800px';
    box.className = 'markdown-body';
    document.body.appendChild(box);
    MD.render(cm.getValue(), box);
    await MD.mermaidDone();
    box.querySelectorAll('[data-s]').forEach(el => { delete el.dataset.s; delete el.dataset.e; });
    box.querySelectorAll('input[type=checkbox]').forEach(b => { b.setAttribute('disabled', ''); if (b.checked) b.setAttribute('checked', ''); });
    const html = box.innerHTML;
    box.remove();
    if (wasDark) { MD.initMermaid(true); renderPreview(); }
    const r = await api('POST', '/api/pdf', { path: cur.path, html });
    setSaveState(`Exported ${r.pdf} (${Math.round(r.bytes / 1024)} KB)`, 'ok');
    const a = Object.assign(document.createElement('a'), { href: `/api/download?path=${encodeURIComponent(r.pdf)}`, download: r.pdf.split('/').pop() });
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    setSaveState(`PDF export failed: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}
$('#export-pdf').onclick = exportPdf;

// ------------------------------------------------------------------ layout & theme

document.querySelectorAll('#view-mode button').forEach(b => b.onclick = () => setView(b.dataset.mode));
function setView(mode) {
  $('#main').classList.remove('edit', 'split', 'preview');
  $('#main').classList.add(mode);
  document.querySelectorAll('#view-mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  store.set('mdedit.view', mode);
  setTimeout(() => { cm.refresh(); renderPreview(); }, 0);
}
$('#toggle-files').onclick = () => { document.body.classList.toggle('no-files'); store.set('mdedit.files', document.body.classList.contains('no-files') ? '0' : '1'); cm.refresh(); };
$('#toggle-claude').onclick = () => { document.body.classList.toggle('no-claude'); cm.refresh(); };

function setTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#gh-css').href = `https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.5.1/github-markdown-${dark ? 'dark' : 'light'}.min.css`;
  $('#hl-css').href = `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github${dark ? '-dark' : ''}.min.css`;
  MD.initMermaid(dark);
  store.set('mdedit.theme', dark ? 'dark' : 'light');
  renderPreview();
}
$('#theme').onclick = () => setTheme(document.documentElement.dataset.theme !== 'dark');
$('#model').value = store.get('mdedit.model', '');
$('#model').onchange = () => store.set('mdedit.model', $('#model').value);

window.addEventListener('beforeunload', e => { if (cur.dirty) { save(); e.preventDefault(); } });

// ------------------------------------------------------------------ start

(async function init() {
  const saved = store.get('mdedit.theme', null);
  setTheme(saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
  setView(store.get('mdedit.view', innerWidth < 800 ? 'edit' : 'split'));
  if (store.get('mdedit.files', '1') === '0' || innerWidth < 800) document.body.classList.add('no-files');
  if (innerWidth < 1100) document.body.classList.add('no-claude');

  const conf = await api('GET', '/api/config');
  skills = conf.skills;
  fileList = conf.files;
  setRoot(conf.root);
  buildPresets();
  renderFiles();
  const fromHash = decodeURIComponent(location.hash.slice(1));
  const want = [conf.initial, fromHash, store.get('mdedit.last', null), fileList[0]?.path]
    .find(p => p && fileList.some(f => f.path === p));
  if (want) await openFile(want);
  else {
    const r = await api('POST', '/api/new', { path: 'untitled.md', text: '# Untitled\n\n' }).catch(() => null);
    fileList = await api('GET', '/api/files');
    renderFiles();
    if (r) await openFile(r.path);
  }
  listenForChanges();
  cm.focus();
})();
