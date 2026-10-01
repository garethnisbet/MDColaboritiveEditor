# MD Collaborative Editor

Local GitHub-style markdown editor shared between the user (browser) and Claude (terminal). See README.md.

- Package layout: code in `src/md_collab_editor/` (`server.py`, `static/`), installed as the `md-editor` command via `pyproject.toml` (hatchling, no dependencies). `docs/` is just a sample folder, not packaged.
- Run: `uv run md-editor [folder-or-file]` (or `md-editor` once installed with `uv tool install`), serves http://127.0.0.1:8765. Default document root is the current folder; the user can switch the root at runtime with the in-app file browser (`/api/root`), so check the status bar or `/api/config` for the folder currently open.
- **Collaborating on a document:** edit the `.md` file on disk directly with Edit/Write. The open editor reloads it live and flashes the change, so there is no need to go through the browser. Avoid rewriting the whole file while the user is typing; prefer targeted edits.
- In-browser "Ask Claude" requests run `claude -p` from `src/md_collab_editor/server.py` (`ask_claude`, `SYSTEM_PROMPT`), with tools restricted to Skill and Read.
- Front end: no build step; libraries come from CDNs (marked 12, CodeMirror 5, DOMPurify, highlight.js, KaTeX, mermaid 10, github-markdown-css).
- Gotchas: DOMPurify strips attributes containing `-->` (so mermaid source is kept as element text); mermaid.render is not re-entrant (renders are queued); blur CodeMirror before calling setSelection from preview code, or its input poll re-types the selection and wipes markers.
