# Welcome

This editor renders markdown the way GitHub does, and it has Claude built in. Highlight any passage, in the source or in the preview, and ask Claude to rewrite it, tighten it, change its style or just comment on it. Every suggestion arrives as a card with a word-level diff that you can **accept**, **keep the original**, retry or refine.

## Things to try

- [x] Open this file
- [ ] Highlight the paragraph above in the preview and choose *Tighten*
- [ ] Select some text and press <kbd>Ctrl</kbd>+<kbd>J</kbd> to type your own instruction
- [ ] Edit this file from a terminal and watch the change appear here

> [!NOTE]
> Files live on disk, so Claude Code in a terminal can edit them too. The editor picks up changes within a second.

> [!WARNING]
> If both of you edit at once, the editor asks which version to keep.

## Formatting

| Feature | Syntax | Shown as |
| --- | --- | --- |
| Emphasis | `**bold**`, `_italic_`, `~~strike~~` | **bold**, _italic_, ~~strike~~ |
| Inline maths | `$E = mc^2$` | $E = mc^2$ |
| Link | `[GitHub](https://github.com)` | [GitHub](https://github.com) |

Display maths:

$$
\mathbf{Q} = \mathbf{k}_f - \mathbf{k}_i, \qquad |\mathbf{Q}| = \frac{4\pi}{\lambda}\sin\theta
$$

```python
def bragg(d, wavelength):
    """Return the Bragg angle in degrees."""
    return math.degrees(math.asin(wavelength / (2 * d)))
```

```mermaid
flowchart LR
    A[Highlight text] --> B[Ask Claude]
    B --> C{Suggestion}
    C -->|Accept| D[Document updated]
    C -->|Keep original| E[No change]
    C -->|Refine| B
```

Footnote-style asides and HTML such as <sup>superscript</sup> also work.
