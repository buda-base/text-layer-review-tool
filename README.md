# Text Format Review Tool

A small web page for checking span annotations (Tsawa, Yigchung, Quotation,
Chapter, Sabche) in OPF books.
Reviewers open a book, see every annotated span highlighted, accept, fix or drop
each one, add any that were missed, and export the result as a yaml file.

Everything runs in the browser. Files never leave the reviewer's computer, and
there is no server and no login.

## Using it

1. Open the page.
2. **Choose annotation**: Tsawa, Yigchung, Quotation, Chapter or Sabche.
3. **Add OPF folder**: pick the book folder, either `P000123` (the repo) or
   `P000123.opf`. The page finds the two files it needs inside:
   - `P000123.opf/base/v001.txt`
   - `P000123.opf/layers/v001/Tsawa.yml` (or `Yigchung.yml`, `Quotation.yml`,
     `Chapter.yml`, `Sabche.yml`; for Quotation, newer books use `Citation.yml`,
     which is picked up too)
4. If you're continuing an earlier review, also add the file you exported last
   time (for example `P000123-tsawa.yaml`) in the second box.
5. Press **Open book** and review.
6. Press **Export yaml file**. You get `P000123-tsawa.yaml` (or
   `P000123-yigchung.yaml`).

### Checks before a book opens

The page refuses to open a book, and says why, when:

- the folder isn't an OPF book (no `*.opf` folder inside);
- the folder holds more than one book;
- the repo folder name doesn't match the `.opf` inside it (`P000999/P000123.opf`);
- there's no layer for the chosen annotation, or more than one;
- the layer's folder (`layers/v001/`) has no matching base text (`base/v001.txt`);
- the layer file says it is a different annotation type;
- an exported file is for a different book or annotation
  (`P000124-tsawa.yaml` added to book `P000123`);
- more than 20% of the spans fall outside the base text.

### Reviewing

| Action | How |
|---|---|
| Select a span | Click it |
| Accept | `A` or the Accept button under the span, then it jumps to the next unchecked span |
| Drop / restore | `D` |
| Fix the edges | `E`, the Edit button, or double-click the span. Drag the blue handles at its start and end. Edges snap to whole syllables; hold Alt (Option) to move by single letters. The arrow buttons move an edge one syllable at a time. |
| Replace a span's text | While editing, select the right text and press "Set as this span's text" |
| Add a missed span | Select the text with the mouse, then press "+ Add as new span" next to it (or `N`) |
| Next unchecked / previous | `J` / `K` |
| Undo | `Ctrl+Z` / `Cmd+Z` (one drag = one undo) |

Span status is shown by text colour: blue = not checked, green = accepted,
orange = edited, red struck through = dropped, purple = added. The selected span
is underlined. A wavy red underline means two spans overlap.

The whole book is one long scrolling text. The panel on the right lists every
span you've reviewed so far (accepted, edited, added, dropped); click one to jump
to it.

### Reviewing a file again

The book always opens at a span: the first one not checked yet, or the very first
span if everything was already reviewed. Re-opening an exported file keeps every
span's colour (accepted, edited, added, dropped), and you can go through them again
with `J` / `K`; Accept, Drop and Edit work as before. To start the review from
scratch, press **Mark all as not checked** in the yellow bar. That turns accepted
spans back to not checked but keeps edits, additions and drops. Undo reverses it.

### Overlapping spans

Two spans of the same annotation shouldn't overlap. When you add a span or
change one so that it overlaps another, **the one you just touched wins** and the
other is fitted around it:

- it partly overlaps → the other span is shortened;
- the other span is completely inside it → the other span is dropped;
- it sits inside a bigger span → the bigger span is split into two parts around it.

A yellow warning bar says exactly what changed, with an Undo button.

Overlaps that are already in the original file are shown with a wavy red
underline, and a warning appears when the book opens. Edit or drop one of the two
spans and the same rule fixes the other.

Work is also backed up in the browser as you go. If the tab closes, reopening the
same book offers to bring it back. Export often anyway, because the export file is
the real record.

## The exported file

The export keeps the OPF layer format exactly. `end` still **includes** the last
character, as in OPF. On top of that:

- dropped spans are removed;
- edited and added spans have their new offsets (added spans get a new id);
- each span that was checked gets a `review:` field (`accepted`, `edited` or
  `added`);
- a top-level `review:` block records the book, annotation, source files, the
  counts, and the list of dropped spans.

```yaml
id: 644ae7d9a46e48089331b2f0105e475f
annotation_type: Yigchung
revision: '00001'
annotations:
  0387440f14444d47a5725d559ef394cf:
    span:
      start: 18100
      end: 18264
    review: accepted
  ...
review:
  opf: P000123
  annotation: Yigchung
  base_file: P000123.opf/base/v001.txt
  layer_file: P000123.opf/layers/v001/Yigchung.yml
  updated: '2026-09-29T06:13:51.647Z'
  checked: 3
  total: 166
  accepted: 1
  edited: 1
  added: 1
  dropped:
    - id: 6ce5961b7ee94b499a5fbf5d2336482d
      start: 23757
      end: 24445
```

If you edit or add a span and then accept it, it turns green, and the file
marks it with `review: edited` (or `added`) plus `confirmed: true`. Opening that
file again shows it green, and "Mark all as not checked" turns it back to orange
(or purple).

Before copying a finished file back into an OPF repo, remove the `review` fields
and the top-level `review` block.

## Running it

It's plain HTML, CSS and JavaScript with no build step.

- **Locally:** double-click `index.html`.
- **GitHub Pages:** push this repo to GitHub, then go to Settings → Pages →
  "Deploy from a branch" → `main` / root. The page will be at
  `https://<user>.github.io/text-format-review-tool/`.

To add another annotation type, add its name to `ANNOTATIONS` at the top of
`app.js`. The name must match the layer file name (`Sabche` → `Sabche.yml`).

## Releasing a change

`index.html` loads `style.css?v=…` and `app.js?v=…`. When you change either
file, change that `v=` date in **both** links in `index.html`. Otherwise browsers
can keep using the old files for a while after a push, which breaks the layout
(new page with old styles).

## Files

```
index.html               the two screens
style.css                layout and colours (light and dark)
app.js                   everything else
vendor/js-yaml.min.js    yaml reader and writer (js-yaml 4.1.0, MIT)
```
