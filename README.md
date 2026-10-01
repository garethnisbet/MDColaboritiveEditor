# MD Collaborative Editor

A local markdown editor that renders exactly like GitHub, with Claude built in. You can highlight any passage and ask Claude to rewrite, tighten, restyle or critique it, then accept the suggestion or keep the original.

## Install

[![PyPI](https://img.shields.io/pypi/v/md-collab-editor)](https://pypi.org/project/md-collab-editor/)

Install it from PyPI as a command with [uv](https://docs.astral.sh/uv/):

```bash
uv tool install md-collab-editor
```

Or run it once without installing:

```bash
uvx --from md-collab-editor md-editor
```

`pipx install md-collab-editor` works too. Upgrade later with `uv tool upgrade md-collab-editor`. For the latest unreleased code, install from GitHub instead: `uv tool install git+https://github.com/garethnisbet/MDCollaborativeEditor`.

## Run

```bash
md-editor                       # edit the .md files in the current folder
md-editor ~/notes               # edit any folder
md-editor ~/proj/README.md      # edit one file (its folder becomes the root)
md-editor --port 9000 --no-browser
```

It needs only Python 3.9+ (standard library, no dependencies) and the `claude` CLI on your PATH; uv can't install `claude`, because it isn't a Python package. Without it, everything except *Ask Claude* still works. The page loads its libraries from a CDN, so the browser needs internet access.

To work on the editor itself, clone the repo and run `uv run md-editor docs`, which uses the code in the checkout.

## Working with Claude

1. **Highlight** text in the editor or in the rendered preview. In the preview a pop-up opens straight away; in the editor click the small *✦ Ask Claude* pill or press <kbd>Ctrl</kbd>+<kbd>J</kbd>.
2. **Choose** a preset (*My style*, *Improve*, *Tighten*, *Expand*, *Simplify*, *Fix grammar*, *More formal/casual*, *To bullets/prose*, *Critique*) or type your own instruction. An instruction ending in `?` is treated as a question: Claude replies with a comment and leaves the text alone.
3. A **card** appears in the Claude panel, and the passage is highlighted in purple while Claude works and in amber when the suggestion is ready. Each card offers:
   - **Changes / Preview / Edit**: a word-level diff, the rendered result, or a text box for tweaking it by hand;
   - **Accept**: replace the passage (Ctrl+Z undoes it);
   - **Keep original**: discard the suggestion;
   - **Retry**: ask for a different version;
   - **Refine…**: give feedback such as "shorter" or "keep the first sentence" and get a revised version.
4. With nothing selected, the request applies to the whole document.

You can run several requests at once, and you can keep editing while Claude works, because each card tracks its passage as the text moves. *My style* uses the `nisbet-writing-style` skill; any skill in `~/.claude/skills` appears as a preset. The model menu in the top bar picks Opus, Sonnet or Haiku.

Requests run through `claude -p` (headless Claude Code), so they use your existing Claude login and no API key is needed.

## Working with Claude Code in a terminal

Documents are plain `.md` files on disk. When Claude Code, or anything else, edits a file, the open editor updates within about a second and briefly flashes the changed text. If you had unsaved edits at that moment, a banner asks which version to keep. The editor autosaves shortly after you stop typing (<kbd>Ctrl</kbd>+<kbd>S</kbd> saves at once).

## Rendering

Rendering covers GitHub-flavoured markdown: tables, task lists (click the boxes in the preview to tick them), strikethrough, autolinks, `> [!NOTE]`-style alerts, syntax-highlighted code, `$…$` and `$$…$$` maths (KaTeX), ```` ```math ```` blocks, ```` ```mermaid ```` diagrams, heading anchors and inline HTML (sanitised). The preview uses `github-markdown-css` in light or dark (◐ button).

## Editing

The toolbar covers headings, bold, italic, strikethrough, quotes, code, links, images, lists, task lists, tables and rules. Shortcuts: <kbd>Ctrl</kbd>+<kbd>B</kbd>/<kbd>I</kbd>/<kbd>K</kbd>, <kbd>Ctrl</kbd>+<kbd>F</kbd> to search, <kbd>Tab</kbd> to indent, and <kbd>Enter</kbd> to continue lists. Scrolling in the editor and the preview stays in sync, and clicking a preview block moves the cursor to it. Misspelt words get a wavy red underline as you type (British English; code, URLs and HTML are skipped). Right-click one for suggestions, to add it to your dictionary (kept in the browser) or to ignore it, and click **abc✓** in the toolbar to turn checking off or on.

## Opening files elsewhere

Click **📂** in the top bar (or *Open…* in the file list, or press <kbd>Ctrl</kbd>+<kbd>O</kbd>) to browse the disk. Click folders to move through them (↑ goes to the parent, ⌂ goes home), or type or paste a path and press Enter. Clicking a `.md` file opens it and makes its folder the working folder, so the sidebar lists its neighbours and live sync keeps working. *Use this folder* switches to the current folder without picking a file. The arrow keys and Enter also work in the list.

## Exporting to PDF

Click **⬇ PDF** in the top bar. The document is rendered in GitHub's light style (even in dark mode) on A4 pages, with maths and diagrams included and without Claude's highlights. It is saved as `<name>.pdf` beside the markdown file and downloaded by the browser. Relative image links resolve because the page is printed from the markdown file's folder. This uses headless Google Chrome or Chromium; set `MDEDIT_CHROME=/path/to/chrome` if it isn't found on the PATH. For the browser's own print dialog, press <kbd>Ctrl</kbd>+<kbd>P</kbd>; the print stylesheet prints only the rendered document.

## Files

All code lives in `src/md_collab_editor/`:

- `server.py`: HTTP server (file API, folder browsing and root switching, change events, `/api/ask` → `claude -p`, `/api/pdf` → headless Chrome)
- `static/index.html`, `static/app.css`: layout and GitHub-style theme
- `static/render.js`: markdown → HTML, with source offsets on every block so preview selections map back to the source
- `static/app.js`: editor, sync, selection mapping, ask bar, suggestion cards and word diff
