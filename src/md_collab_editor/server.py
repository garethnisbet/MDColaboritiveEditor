#!/usr/bin/env python3
"""MD Collaborative Editor: a local GitHub-style markdown editor with Claude in the loop.

Serves the editor UI, reads and writes .md files under a root folder, pushes
on-disk changes to the browser (so edits made by Claude Code in a terminal show
up live), and answers "ask Claude" requests by running `claude -p` headless.

    md-editor                     # edit the current folder
    md-editor ~/notes             # edit a folder
    md-editor ~/proj/README.md    # edit one file (its folder becomes the root)
"""

import argparse
import json
import mimetypes
import os
import shutil
import subprocess
import tempfile
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
SKILLS_DIR = Path.home() / ".claude" / "skills"
MD_EXT = (".md", ".markdown")
SKIP_DIRS = {"node_modules", "__pycache__", ".git", ".venv", "venv"}

ROOT: Path = Path.cwd()
CLAUDE_BIN = shutil.which("claude") or "claude"
CHROME_BIN = next((b for b in (os.environ.get("MDEDIT_CHROME"), "google-chrome", "google-chrome-stable",
                               "chromium", "chromium-browser") if b and shutil.which(b)), None)

PDF_TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{title}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.5.1/github-markdown-light.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<style>
@page {{ size: A4; margin: 16mm 15mm 18mm; }}
body {{ margin: 0; background: #fff; }}
.markdown-body {{ font-size: 11pt; max-width: none; padding: 0; }}
.markdown-body .math-block {{ margin-bottom: 16px; }}
.markdown-body .mermaid-box {{ text-align: center; margin-bottom: 16px; }}
.markdown-body .mermaid-box svg {{ max-width: 100%; height: auto; }}
.markdown-body .mermaid-src, .markdown-body .anchor {{ display: none; }}
.markdown-body .task-list-item {{ list-style: none; }}
.markdown-body .task-list-item input {{ margin: 0 0.2em 0.25em -1.4em; vertical-align: middle; }}
.markdown-body pre, .markdown-body table, .markdown-body img, .markdown-body .markdown-alert,
.markdown-body .math-block, .markdown-body .mermaid-box {{ break-inside: avoid; }}
.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 {{ break-after: avoid; }}
.markdown-body pre code {{ white-space: pre-wrap; word-break: break-word; }}
</style></head>
<body><article class="markdown-body">{body}</article></body></html>
"""

SYSTEM_PROMPT = """You are a writing assistant embedded in a markdown editor. The user has \
highlighted part of a markdown document and asked you to do something with it. \
The full document is supplied for context; the highlighted part is wrapped in \
⟦SELECTION⟧ … ⟦/SELECTION⟧ markers.

Rules:
- Reply with the result ONLY: no preamble, no explanation, no closing remarks, \
no surrounding quotes, no code fence around the whole reply.
- In "replace" mode your reply replaces the selection verbatim, so it must be \
valid markdown that fits seamlessly where the selection was. Keep the existing \
markdown structure (headings, lists, links, emphasis, math, code) unless asked \
to change it. Do not include text from outside the selection.
- In "comment" mode reply with concise feedback in markdown; the document is not changed.
- British English spelling unless the document clearly uses another convention.
- If asked to use a skill, invoke it with the Skill tool before writing."""


# ---------------------------------------------------------------- files

def safe_path(rel: str) -> Path:
    p = (ROOT / rel).resolve()
    if p != ROOT and ROOT not in p.parents:
        raise ValueError("path escapes the root folder")
    return p


def version_of(p: Path) -> str:
    return str(p.stat().st_mtime_ns) if p.exists() else "0"


def list_files():
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d not in SKIP_DIRS)
        for f in sorted(filenames):
            if f.lower().endswith(MD_EXT):
                p = Path(dirpath) / f
                out.append({"path": p.relative_to(ROOT).as_posix(), "version": version_of(p)})
    return out


def browse(dirpath: str):
    """Folders and markdown files in `dirpath`, for the in-app file browser."""
    d = Path(dirpath).expanduser().resolve() if dirpath else ROOT
    if not d.is_dir():
        raise ValueError(f"not a folder: {d}")
    entries = []
    try:
        for p in d.iterdir():
            if p.name.startswith(".") or p.name in SKIP_DIRS:
                continue
            try:
                if p.is_dir():
                    entries.append({"name": p.name, "dir": True})
                elif p.suffix.lower() in MD_EXT:
                    entries.append({"name": p.name, "dir": False})
            except OSError:
                pass
    except PermissionError:
        raise ValueError(f"permission denied: {d}")
    entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
    return {"dir": str(d), "parent": str(d.parent) if d.parent != d else None,
            "home": str(Path.home()), "entries": entries}


def set_root(target: str):
    """Point the editor at a folder, or at a file's folder; returns the file to open."""
    global ROOT
    t = Path(target).expanduser().resolve()
    if t.is_file() and t.suffix.lower() in MD_EXT:
        ROOT = t.parent
        return t.name
    if t.is_dir():
        ROOT = t
        return None
    raise ValueError(f"not a markdown file or folder: {t}")


def list_skills():
    skills = []
    if SKILLS_DIR.is_dir():
        for d in sorted(SKILLS_DIR.iterdir()):
            md = d / "SKILL.md"
            if not md.is_file():
                continue
            desc = ""
            try:
                head = md.read_text(encoding="utf-8").split("---")
                for line in head[1].splitlines() if len(head) > 2 else []:
                    if line.startswith("description:"):
                        desc = line.split(":", 1)[1].strip()
            except OSError:
                pass
            skills.append({"name": d.name, "description": desc})
    return skills


# ---------------------------------------------------------------- claude

def build_prompt(req):
    doc = req.get("doc", "")
    s, e = int(req.get("start", 0)), int(req.get("end", 0))
    whole = s == 0 and e >= len(doc)
    marked = doc if whole else doc[:s] + "⟦SELECTION⟧" + doc[s:e] + "⟦/SELECTION⟧" + doc[e:]
    mode = req.get("mode", "replace")
    parts = [
        f'<document path="{req.get("path", "")}">\n{marked}\n</document>',
        f"<selection>\n{doc[s:e]}\n</selection>" if not whole else
        "<selection>The whole document is selected.</selection>",
        f"<mode>{mode}</mode>",
        f"<instruction>\n{req.get('instruction', '').strip()}\n</instruction>",
    ]
    if req.get("previous"):
        parts.append(f"<previous_attempt>\n{req['previous']}\n</previous_attempt>\n"
                     "The user was not satisfied with the previous attempt; the instruction "
                     "above is their feedback on it.")
    parts.append("Reply with the replacement text only." if mode == "replace"
                 else "Reply with your comments only.")
    return "\n\n".join(parts)


def unfence(text: str, original: str) -> str:
    t = text.strip()
    if t.startswith("```") and t.endswith("```") and not original.lstrip().startswith("```"):
        lines = t.splitlines()
        if len(lines) >= 2:
            t = "\n".join(lines[1:-1])
    return t


def ask_claude(req):
    cmd = [CLAUDE_BIN, "-p", "--output-format", "json", "--no-session-persistence",
           "--append-system-prompt", SYSTEM_PROMPT]
    if req.get("model"):
        cmd += ["--model", req["model"]]
    cmd += ["--tools", "Skill,Read", "--allowedTools", "Skill,Read"]
    t0 = time.time()
    proc = subprocess.run(cmd, input=build_prompt(req), capture_output=True, text=True,
                          timeout=600, cwd=tempfile.gettempdir())
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise RuntimeError((proc.stderr or proc.stdout or "no output from claude").strip()[:2000])
    if data.get("is_error"):
        raise RuntimeError(str(data.get("result") or data)[:2000])
    doc = req.get("doc", "")
    original = doc[int(req.get("start", 0)):int(req.get("end", 0))]
    return {
        "result": unfence(data.get("result", ""), original),
        "seconds": round(time.time() - t0, 1),
        "cost": data.get("total_cost_usd"),
    }


# ---------------------------------------------------------------- pdf

def export_pdf(req):
    """Print the editor's rendered HTML to <name>.pdf beside the markdown file."""
    if not CHROME_BIN:
        raise RuntimeError("PDF export needs Google Chrome or Chromium (or set MDEDIT_CHROME)")
    md = safe_path(req["path"])
    pdf = md.with_suffix(".pdf")
    # images point at the /raw/ route; Chrome reads them straight from disk instead
    body = req["html"].replace('src="/raw/', f'src="{ROOT.as_uri()}/')
    page = PDF_TEMPLATE.format(title=md.stem.replace("<", "&lt;"), body=body)
    # the page sits beside the .md so relative image links resolve
    tmp_html = md.with_name(f".{md.stem}.print.html")
    tmp_html.write_text(page, encoding="utf-8")
    profile = tempfile.mkdtemp(prefix="mdedit-chrome-")
    try:
        proc = subprocess.run(
            [CHROME_BIN, "--headless=new", "--disable-gpu", "--no-first-run", "--no-pdf-header-footer",
             f"--user-data-dir={profile}", "--virtual-time-budget=15000", "--run-all-compositor-stages-before-draw",
             f"--print-to-pdf={pdf}", tmp_html.as_uri()],
            capture_output=True, text=True, timeout=120)
        if proc.returncode != 0 or not pdf.exists():
            raise RuntimeError(f"Chrome failed to print: {(proc.stderr or proc.stdout).strip()[-800:]}")
    finally:
        tmp_html.unlink(missing_ok=True)
        shutil.rmtree(profile, ignore_errors=True)
    return {"pdf": pdf.relative_to(ROOT).as_posix(), "bytes": pdf.stat().st_size}


# ---------------------------------------------------------------- http

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(STATIC), **kw)

    def log_message(self, fmt, *args):
        if "/api/events" not in str(args[0] if args else ""):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_raw(self, rel):
        """Serve a file from the document root (images referenced by the markdown)."""
        p = safe_path(rel)
        if not p.is_file():
            return self.send_json({"error": "not found"}, 404)
        data = p.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(p.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/api/config":
                return self.send_json({"root": str(ROOT), "initial": INITIAL,
                                       "skills": list_skills(), "files": list_files()})
            if u.path == "/api/download":
                p = safe_path(q["path"])
                if not p.is_file() or p.suffix.lower() != ".pdf":
                    return self.send_json({"error": "not found"}, 404)
                data = p.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/pdf")
                self.send_header("Content-Disposition", f'attachment; filename="{p.name}"')
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if u.path == "/api/browse":
                return self.send_json(browse(q.get("dir", "")))
            if u.path == "/api/files":
                return self.send_json(list_files())
            if u.path == "/api/file":
                p = safe_path(q["path"])
                if not p.is_file():
                    return self.send_json({"error": "not found"}, 404)
                return self.send_json({"path": q["path"], "text": p.read_text(encoding="utf-8"),
                                       "version": version_of(p)})
            if u.path == "/api/events":
                return self.events()
            if u.path.startswith("/raw/"):
                return self.send_raw(unquote(u.path[len("/raw/"):]))
        except (ValueError, KeyError) as exc:
            return self.send_json({"error": str(exc)}, 400)
        return super().do_GET()

    def do_PUT(self):
        if urlparse(self.path).path != "/api/file":
            return self.send_json({"error": "unknown endpoint"}, 404)
        try:
            req = self.read_json()
            p = safe_path(req["path"])
            base = req.get("base_version")
            if not req.get("force") and base is not None and version_of(p) != base:
                return self.send_json({"error": "conflict", "version": version_of(p),
                                       "text": p.read_text(encoding="utf-8") if p.exists() else ""}, 409)
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_name("." + p.name + ".tmp")
            tmp.write_text(req["text"], encoding="utf-8")
            os.replace(tmp, p)
            return self.send_json({"version": version_of(p)})
        except (ValueError, KeyError) as exc:
            return self.send_json({"error": str(exc)}, 400)

    def do_POST(self):
        u = urlparse(self.path)
        try:
            req = self.read_json()
            if u.path == "/api/pdf":
                return self.send_json(export_pdf(req))
            if u.path == "/api/root":
                initial = set_root(req["path"])
                print(f"[root] {ROOT}", flush=True)
                return self.send_json({"root": str(ROOT), "initial": initial, "files": list_files()})
            if u.path == "/api/new":
                rel = req["path"].strip()
                if not rel.lower().endswith(MD_EXT):
                    rel += ".md"
                p = safe_path(rel)
                if p.exists():
                    return self.send_json({"error": "file already exists"}, 409)
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(req.get("text", f"# {p.stem}\n\n"), encoding="utf-8")
                return self.send_json({"path": rel, "version": version_of(p)})
            if u.path == "/api/ask":
                print(f"[ask] {req.get('mode')}: {req.get('instruction', '')[:80]!r}", flush=True)
                return self.send_json(ask_claude(req))
        except subprocess.TimeoutExpired:
            return self.send_json({"error": "Claude timed out"}, 504)
        except RuntimeError as exc:
            return self.send_json({"error": str(exc)}, 502)
        except (ValueError, KeyError) as exc:
            return self.send_json({"error": str(exc)}, 400)
        return self.send_json({"error": "unknown endpoint"}, 404)

    def events(self):
        """Server-sent events: file list changes and per-file version changes."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        last = None
        try:
            while True:
                files = list_files()
                if files != last:
                    self.wfile.write(f"data: {json.dumps(files)}\n\n".encode())
                    self.wfile.flush()
                    last = files
                else:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                time.sleep(0.6)
        except (BrokenPipeError, ConnectionResetError):
            pass


INITIAL = None


def main():
    global ROOT, INITIAL
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", nargs="?", default=".", help="folder or .md file to edit (default: current folder)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    target = Path(args.path).expanduser().resolve()
    if target.suffix.lower() in MD_EXT:
        ROOT, INITIAL = target.parent, target.name
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"# {target.stem}\n\n", encoding="utf-8")
    else:
        ROOT = target
        ROOT.mkdir(parents=True, exist_ok=True)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    url = f"http://127.0.0.1:{args.port}/"
    print(f"MD editor on {url}  (root: {ROOT})", flush=True)
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
