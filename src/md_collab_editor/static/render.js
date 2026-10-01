// GitHub-flavoured markdown rendering with source mapping.
// Every top-level element in the output carries data-s / data-e: the character
// offsets of the markdown that produced it, so a selection in the preview can be
// mapped back to the source.

const MD = (() => {
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function tex(src, display) {
    try {
      return katex.renderToString(src, { displayMode: display, throwOnError: false, output: 'htmlAndMathml' });
    } catch (e) {
      return `<code>${esc(src)}</code>`;
    }
  }

  // $$…$$ blocks and $…$ inline maths, as GitHub renders them
  const blockMath = {
    name: 'blockMath', level: 'block',
    start(src) { const i = src.indexOf('$$'); return i < 0 ? undefined : i; },
    tokenizer(src) {
      const m = /^\$\$([\s\S]+?)\$\$[^\S\n]*(?:\n|$)/.exec(src);
      if (m) return { type: 'blockMath', raw: m[0], text: m[1].trim() };
    },
    renderer(t) { return `<div class="math-block">${tex(t.text, true)}</div>`; },
  };
  const inlineMath = {
    name: 'inlineMath', level: 'inline',
    start(src) { const i = src.indexOf('$'); return i < 0 ? undefined : i; },
    tokenizer(src) {
      let m = /^\$`([^`]+)`\$/.exec(src) ||
              /^\$(?![\s$])((?:\\.|[^\\\n$])+?)(?<!\s)\$(?![\w$])/.exec(src);
      if (m) return { type: 'inlineMath', raw: m[0], text: m[1] };
    },
    renderer(t) { return tex(t.text, false); },
  };

  const slugCounts = new Map();
  function slug(text) {
    let s = text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
    const n = slugCounts.get(s) || 0;
    slugCounts.set(s, n + 1);
    return n ? `${s}-${n}` : s;
  }

  marked.use({
    gfm: true,
    extensions: [blockMath, inlineMath],
    renderer: {
      code(code, info) {
        const lang = (info || '').trim().split(/\s+/)[0].toLowerCase();
        if (lang === 'math') return `<div class="math-block">${tex(code, true)}</div>`;
        // source kept as text: DOMPurify strips attributes containing "-->"
        if (lang === 'mermaid') return `<div class="mermaid-box"><pre class="mermaid-src">${esc(code)}</pre></div>`;
        let html;
        if (lang && hljs.getLanguage(lang)) html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        else html = esc(code);
        return `<div class="highlight"><pre><code class="hljs${lang ? ' language-' + esc(lang) : ''}">${html}</code></pre></div>`;
      },
      heading(text, level, raw) {
        const id = slug(raw);
        return `<h${level} id="${esc(id)}"><a class="anchor" href="#${esc(id)}" aria-hidden="true"></a>${text}</h${level}>\n`;
      },
    },
  });

  const OCTICONS = {
    note: 'M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z',
    tip: 'M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z',
    important: 'M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
    warning: 'M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
    caution: 'M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z',
  };

  // > [!NOTE] … blockquotes become GitHub alert boxes
  function alerts(root) {
    root.querySelectorAll('blockquote').forEach(bq => {
      const p = bq.firstElementChild;
      if (!p || p.tagName !== 'P') return;
      const m = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][^\S\n]*\n?/i.exec(p.innerHTML);
      if (!m) return;
      const kind = m[1].toLowerCase();
      p.innerHTML = p.innerHTML.slice(m[0].length);
      if (!p.innerHTML.trim()) p.remove();
      const box = document.createElement('div');
      box.className = `markdown-alert markdown-alert-${kind}`;
      for (const a of bq.attributes) box.setAttribute(a.name, a.value);
      box.innerHTML = `<p class="markdown-alert-title"><svg class="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="${OCTICONS[kind]}"></path></svg>${kind[0].toUpperCase() + kind.slice(1)}</p>`;
      while (bq.firstChild) box.appendChild(bq.firstChild);
      bq.replaceWith(box);
    });
  }

  const TASK_RE = /^[ \t>]*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\]/gm;

  // Render `src` into `target`; returns [{el, s, e}] for each top-level block.
  function render(src, target) {
    slugCounts.clear();
    const tokens = marked.lexer(src);
    const frag = document.createDocumentFragment();
    const blocks = [];
    let pos = 0;
    for (const tok of tokens) {
      let s = -1, e = -1;
      const i = tok.raw ? src.indexOf(tok.raw, pos) : -1;
      if (i >= 0) { s = i; e = i + tok.raw.length; pos = e; }
      if (tok.type === 'space' || tok.type === 'def') continue;
      const list = Object.assign([tok], { links: tokens.links });
      const tpl = document.createElement('template');
      tpl.innerHTML = DOMPurify.sanitize(marked.parser(list));
      for (const el of [...tpl.content.children]) {
        el.dataset.s = s;
        el.dataset.e = e;
        blocks.push({ el, s, e });
      }
      if (s >= 0) {
        // clickable task-list boxes: remember where each [ ] lives in the source
        const boxes = tpl.content.querySelectorAll('input[type=checkbox]');
        if (boxes.length) {
          const offs = [];
          const chunk = src.slice(s, e);
          let m;
          TASK_RE.lastIndex = 0;
          while ((m = TASK_RE.exec(chunk))) offs.push(s + m.index + m[0].length - 2);
          boxes.forEach((b, k) => {
            if (offs[k] === undefined) return;
            b.removeAttribute('disabled');
            b.dataset.off = offs[k];
            b.closest('li')?.classList.add('task-list-item');
            b.closest('ul,ol')?.classList.add('contains-task-list');
          });
        }
      }
      frag.appendChild(tpl.content);
    }
    alerts(frag);
    frag.querySelectorAll('a[href^="http"]').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
    target.replaceChildren(frag);
    renderMermaid(target);
    return blocks;
  }

  const mermaidCache = new Map();
  let mermaidN = 0;
  let mermaidQueue = Promise.resolve();
  // mermaid.render is not re-entrant, so renders run one at a time
  function renderMermaid(root) {
    mermaidQueue = mermaidQueue.then(() => renderMermaidNow(root)).catch(() => {});
  }
  async function renderMermaidNow(root) {
    for (const box of root.querySelectorAll('.mermaid-box')) {
      if (!box.isConnected) return;
      const code = box.querySelector('.mermaid-src')?.textContent;
      if (code === undefined) continue;
      if (mermaidCache.has(code)) { box.innerHTML = mermaidCache.get(code); continue; }
      try {
        const { svg } = await mermaid.render(`mmd-${++mermaidN}`, code);
        mermaidCache.set(code, svg);
        box.innerHTML = svg;
      } catch (e) {
        box.innerHTML = `<pre class="mermaid-error">${esc(String(e.message || e))}</pre>`;
      }
    }
  }

  function initMermaid(dark) {
    mermaidCache.clear();
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
  }

  const mermaidDone = () => mermaidQueue;

  return { render, esc, initMermaid, mermaidDone };
})();
