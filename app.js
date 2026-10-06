/* Text Format Review Tool
 * ------------------------------------------------------------------
 * Review span annotations (Tsawa, Yigchung, ...) in an OPF book.
 *
 * How offsets work
 *   OPF layer files store spans as {start, end} where `end` INCLUDES the
 *   last character. Inside this file every span is kept as [s, e) where
 *   e is one past the last character, so e = end + 1 on load and
 *   end = e - 1 on export.
 *
 * Everything runs in the browser. Files never leave the computer.
 */
"use strict";

// Annotation types offered in the "Choose annotation" list.
// The name must match the layer file name: <opf>/layers/<base>/<Name>.yml
const ANNOTATIONS = ["Tsawa", "Yigchung", "Quotation", "Chapter", "Sabche"];
// Other names the same layer goes by in some OPF books (file name and annotation_type).
// Newer books store quotations as Citation.yml.
const ALIASES = {Quotation: ["Citation"]};
const namesFor = ann => [ann, ...(ALIASES[ann] || [])].map(n => n.toLowerCase());

const PAGE_SIZE = 6000;                       // the book is drawn in blocks of about this many characters (cut at a line break), all in one long scroll
const BREAKS = new Set(["་","༌","།","༎","༑","༔"," ","\n","\r","\t"]);
const isBreak = ch => BREAKS.has(ch);
const isSpace = ch => /\s/.test(ch);
const $ = id => document.getElementById(id);
// Attach an event only if the element exists, so one missing element can't stop the rest of the page
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); else console.warn("Missing element #" + id + " — is index.html up to date?"); };

const S = {
  // upload
  folderFiles: null, found: null, resumeFile: null,
  // book
  opfId: "", annotation: "", basePath: "", layerPath: "",
  text: "", layer: null,
  spans: [], byId: new Map(), sel: null, editing: false,
  pages: [], page: 0, hist: [], dirty: false, key: "", saveTimer: null
};

/* =================================================================
   SCREEN 1 · UPLOAD AND CHECKS
   ================================================================= */
for (const a of ANNOTATIONS){ const o = document.createElement("option"); o.textContent = a; $("annotation").append(o); }
$("annotation").onchange = verify;

// --- OPF folder: click to pick, or drag a folder onto the box
$("dropFolder").onclick = () => $("folderInput").click();
$("dropFolder").onkeydown = e => { if (e.key === "Enter" || e.key === " "){ e.preventDefault(); $("folderInput").click(); } };
$("folderInput").onchange = e => {
  S.folderFiles = [...e.target.files].map(f => ({path: f.webkitRelativePath || f.name, file: f}));
  verify();
};
setupDrop($("dropFolder"), async dt => {
  const files = await filesFromDrop(dt);
  S.folderFiles = files;
  verify();
});

// --- optional exported yaml to continue a review
$("dropYaml").onclick = () => $("yamlInput").click();
$("dropYaml").onkeydown = e => { if (e.key === "Enter" || e.key === " "){ e.preventDefault(); $("yamlInput").click(); } };
$("yamlInput").onchange = e => { S.resumeFile = e.target.files[0] || null; verify(); };
setupDrop($("dropYaml"), async dt => {
  const f = [...dt.files].find(f => /\.ya?ml$/i.test(f.name));
  S.resumeFile = f || null; verify();
});

function setupDrop(el, onDrop){
  ["dragenter","dragover"].forEach(t => el.addEventListener(t, e => { e.preventDefault(); el.classList.add("over"); }));
  ["dragleave","drop"].forEach(t => el.addEventListener(t, e => { e.preventDefault(); el.classList.remove("over"); }));
  el.addEventListener("drop", e => onDrop(e.dataTransfer));
}

// Walk a dropped folder and return [{path, file}] with paths like "P000123/P000123.opf/base/v001.txt"
async function filesFromDrop(dt){
  const out = [];
  const entries = [...dt.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  async function walk(entry){
    if (entry.isFile){
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({path: entry.fullPath.replace(/^\//, ""), file});
    } else if (entry.isDirectory){
      if (entry.name === ".git" || entry.name === "assets") return;   // nothing we need in there
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child);
      } while (batch.length);
    }
  }
  for (const e of entries) await walk(e);
  return out;
}

// Look inside the chosen folder for <ID>.opf/base/<v>.txt and <ID>.opf/layers/<v>/<Annotation>.yml
function analyzeFolder(files, annotation){
  const norm = files.map(x => ({...x, parts: x.path.replace(/\\/g, "/").split("/").filter(Boolean)}));
  const opfNames = new Set();
  for (const f of norm) for (const p of f.parts) if (/\.opf$/i.test(p)) opfNames.add(p);

  if (opfNames.size === 0) return {error: "This isn't an OPF book folder. Choose the folder whose name ends in .opf, or the repo folder that holds it."};
  if (opfNames.size > 1) return {error: `This folder holds more than one book (${[...opfNames].slice(0,4).join(", ")}${opfNames.size > 4 ? ", …" : ""}). Choose just one book folder.`};

  const opfName = [...opfNames][0];
  const id = opfName.replace(/\.opf$/i, "");

  // If the repo folder was picked, its name must match the OPF inside it
  const sample = norm.find(f => f.parts.includes(opfName));
  const idx = sample.parts.indexOf(opfName);
  const repoName = idx > 0 ? sample.parts[idx - 1] : null;
  if (repoName && repoName !== id) return {id, error: `The repo folder is "${repoName}" but the book inside it is "${opfName}". These should match.`};

  const inOpf = f => { const i = f.parts.indexOf(opfName); return i === -1 ? null : f.parts.slice(i + 1); };
  const bases = [], layers = [];
  for (const f of norm){
    const rel = inOpf(f); if (!rel) continue;
    if (rel.length === 2 && rel[0] === "base" && /\.txt$/i.test(rel[1])) bases.push({...f, rel});
    if (rel.length === 3 && rel[0] === "layers" && /\.ya?ml$/i.test(rel[2])) layers.push({...f, rel});
  }
  if (!bases.length) return {id, error: `No base .txt file in ${opfName}/base/.`};

  const wants = namesFor(annotation);
  const matches = layers.filter(l => {
    const n = l.rel[2].replace(/\.ya?ml$/i, "").toLowerCase();
    return wants.some(want => n === want || n.startsWith(want + "-"));
  });
  if (!matches.length){
    const have = [...new Set(layers.map(l => l.rel[2].replace(/(-[^.]*)?\.ya?ml$/i, "")))];
    return {id, error: `${opfName} has no ${annotation} layer.${have.length ? " It has: " + have.join(", ") + "." : ""}`};
  }
  if (matches.length > 1) return {id, error: `${opfName} has more than one ${annotation} layer: ${matches.map(m => m.rel.join("/")).join(", ")}.`};

  const layer = matches[0];
  const baseName = layer.rel[1];                              // layers/<baseName>/...
  const base = bases.find(b => b.rel[1].replace(/\.txt$/i, "") === baseName);
  if (!base) return {id, error: `The ${annotation} layer is in layers/${baseName}/ but there is no base/${baseName}.txt to match it.`};

  return {id, opfName,
    base: {path: `${opfName}/${base.rel.join("/")}`, file: base.file},
    layer: {path: `${opfName}/${layer.rel.join("/")}`, file: layer.file}};
}

// Exported files are named <ID>-<annotation>.yaml
function parseExportName(name){
  const m = name.match(/^(.+)-([A-Za-z]+)\.ya?ml$/);
  return m ? {id: m[1], annotation: m[2]} : null;
}

function verify(){
  const ann = $("annotation").value;
  const list = [];
  const add = (state, html) => list.push(`<li class="${state}"><span class="icon">${state === "ok" ? "✓" : state === "bad" ? "✗" : "•"}</span><span>${html}</span></li>`);
  S.found = null;

  if (!S.folderFiles){
    add("muted", "Add the OPF folder");
  } else {
    const r = analyzeFolder(S.folderFiles, ann);
    if (r.error) add("bad", esc(r.error));
    else {
      S.found = r;
      add("ok", `Book <b>${esc(r.id)}</b>`);
      add("ok", `Base text: ${esc(r.base.path)}`);
      add("ok", `${esc(ann)} layer: ${esc(r.layer.path)}`);
    }
  }

  if (S.resumeFile){
    const p = parseExportName(S.resumeFile.name);
    if (!p) { add("bad", `"${esc(S.resumeFile.name)}" isn't an exported review file. Its name should look like P000123-${ann.toLowerCase()}.yaml.`); S.found && (S.found.resumeBad = true); }
    else {
      const idOk = !S.found || p.id === S.found.id;
      const annOk = p.annotation.toLowerCase() === ann.toLowerCase();
      if (!idOk) add("bad", `"${esc(S.resumeFile.name)}" is for book ${esc(p.id)}, but the folder is ${esc(S.found.id)}.`);
      else if (!annOk) add("bad", `"${esc(S.resumeFile.name)}" is a ${esc(p.annotation)} file, but you chose ${esc(ann)}.`);
      else add("ok", `Continue from: ${esc(S.resumeFile.name)}`);
      if (S.found && (!idOk || !annOk)) S.found.resumeBad = true;
    }
  }
  $("checks").innerHTML = list.join("");
}

$("openBtn").onclick = async () => {
  const ann = $("annotation").value;
  verify();
  const fail = t => { $("checks").insertAdjacentHTML("beforeend", `<li class="bad"><span class="icon">✗</span><span>${esc(t)}</span></li>`); };
  if (!S.found){ if (!S.folderFiles) fail("Add the OPF folder first."); return; }
  if (S.found.resumeBad) return;

  const useResume = !!S.resumeFile;
  let text, layer;
  try {
    text = await S.found.base.file.text();
    const yfile = useResume ? S.resumeFile : S.found.layer.file;
    layer = jsyaml.load(await yfile.text(), {schema: jsyaml.CORE_SCHEMA});
  } catch (e){ fail("Couldn't read the files. Is the .yml file valid?"); return; }

  if (!layer || typeof layer !== "object" || !layer.annotations){ fail("The annotation file has no annotations in it."); return; }
  const type = String(layer.annotation_type || "");
  if (type && !namesFor(ann).includes(type.toLowerCase())){ fail(`The annotation file says it is "${type}", not ${ann}.`); return; }
  if (useResume && layer.review && layer.review.opf && String(layer.review.opf) !== S.found.id){ fail(`The review file was made for book ${layer.review.opf}, not ${S.found.id}.`); return; }

  S.opfId = S.found.id; S.annotation = ann;
  S.basePath = S.found.base.path; S.layerPath = S.found.layer.path;
  S.text = text; S.layer = layer;
  const bad = parseSpans(layer);
  if (S.spans.length && bad / S.spans.length > 0.2){ fail(`${bad} of ${S.spans.length} spans fall outside the base text. This annotation file doesn't belong to this base text.`); return; }
  startReview();
};

/* =================================================================
   LOADING SPANS
   ================================================================= */
function annEntries(layer){
  const a = layer.annotations, out = [];
  if (Array.isArray(a)) a.forEach((ann, i) => out.push({id: String(ann && ann.id != null ? ann.id : "row" + i), ann}));
  else for (const [k, ann] of Object.entries(a)) out.push({id: String(k), ann});
  return out;
}
function readSE(ann){
  if (!ann || typeof ann !== "object") return null;
  const sp = (ann.span && typeof ann.span === "object") ? ann.span : ann;
  const s = Number(sp.start), e = Number(sp.end);
  return (Number.isFinite(s) && Number.isFinite(e)) ? [s, e] : null;
}
function parseSpans(layer){
  const L = S.text.length; let bad = 0;
  S.spans = [];
  for (const {id, ann} of annEntries(layer)){
    const se = readSE(ann); if (!se) continue;
    const s = se[0], e = se[1] + 1;
    const rv = ann.review;
    let status = (rv === "accepted" || rv === "edited" || rv === "added") ? rv : "todo";
    if ((rv === "edited" || rv === "added") && ann.confirmed === true) status = "accepted";
    if (s < 0 || e > L || e <= s) bad++;
    S.spans.push({id, s, e, os: s, oe: e, status, isNew: rv === "added", edited: rv === "edited", editedBefore: rv === "edited"});
  }
  const rev = (layer.review && typeof layer.review === "object") ? layer.review : null;
  if (rev && Array.isArray(rev.dropped)){
    for (const d of rev.dropped){
      const s = Number(d.start), e = Number(d.end) + 1;
      if (Number.isFinite(s) && Number.isFinite(e)) S.spans.push({id: String(d.id), s, e, os: s, oe: e, status: "dropped", prev: "todo", isNew: false});
    }
  }
  return bad;
}

function buildPages(){
  const T = S.text, L = T.length, P = [];
  let s = 0;
  while (s < L){
    let e = Math.min(L, s + PAGE_SIZE);
    if (e < L){ const nl = T.indexOf("\n", e); if (nl !== -1 && nl - e < 2000) e = nl + 1; }
    P.push({s, e}); s = e;
  }
  if (!P.length) P.push({s: 0, e: 0});
  S.pages = P;
}
function pageOf(pos){
  let lo = 0, hi = S.pages.length - 1;
  while (lo < hi){ const m = (lo + hi + 1) >> 1; if (S.pages[m].s <= pos) lo = m; else hi = m - 1; }
  return lo;
}

function startReview(){
  S.key = `tfr:${S.opfId}:${S.annotation}:${S.text.length}:${S.spans.length}`;
  S.hist = []; S.sel = null; S.editing = false; S.dirty = false;
  rebuildIndex(); buildPages();
  $("bookTitle").textContent = `${S.opfId} · ${S.annotation}`;
  $("upload").classList.add("hidden"); $("review").classList.remove("hidden");
  const saved = loadLocal(S.key);
  if (saved && Array.isArray(saved.spans) && saved.spans.length){
    $("bannerText").textContent = `This browser has unsaved work on this book from ${new Date(saved.t).toLocaleString()} (${saved.checked || 0} spans checked).`;
    $("banner").classList.remove("hidden");
  } else $("banner").classList.add("hidden");
  $("saveState").textContent = "";
  refreshAll();
  // Always open at a span: the first unchecked one, or the very first span if all were reviewed before
  const list = sorted();
  const first = list.find(x => x.status === "todo") || list.find(x => x.status !== "dropped") || list[0];
  if (first) select(first.id, true);
  const orig = S.spans.filter(x => !x.isNew);
  if (orig.length && orig.every(x => x.status !== "todo")){
    toast(`All ${orig.length} spans in this file were already reviewed. They keep their colours, and you can go through them again: <b>J</b> / <b>K</b> move span by span, and Accept, Drop or Edit work as before.`,
      [{label: "Mark all as not checked", fn: restartReview}]);
  }
  const ov = overlapPairs();
  if (ov.n) toast(`⚠ ${ov.n} span${ov.n > 1 ? "s overlap" : " overlaps"} another span in this file (wavy red underline). Edit or drop one of them: the one you change wins and the other is fitted around it.`, [{label: "Show first", fn: () => select(ov.first.id, true)}]);
}
$("resumeBtn").onclick = () => {
  const saved = loadLocal(S.key);
  if (saved){ S.spans = saved.spans; rebuildIndex(); S.dirty = true; refreshAll(); }
  $("banner").classList.add("hidden"); msg("Your earlier work is back.");
};
$("ignoreBtn").onclick = () => $("banner").classList.add("hidden");
$("closeBtn").onclick = () => {
  if (S.dirty && !window.confirm("You haven't exported your latest changes. They're kept in this browser, but export the yaml file to be safe. Close anyway?")) return;
  $("review").classList.add("hidden"); $("upload").classList.remove("hidden");
};

/* =================================================================
   SCREEN 2 · RENDERING
   ================================================================= */
function rebuildIndex(){ S.byId = new Map(S.spans.map(x => [x.id, x])); }
function sorted(){ return [...S.spans].sort((a, b) => a.s - b.s || a.e - b.e); }
function current(){ return S.sel != null ? S.byId.get(S.sel) : null; }
function msg(t){ $("msg").textContent = t || ""; }
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

// The whole book is one long scrolling text. Internally it is drawn in blocks (S.pages) so that a
// change only redraws the few blocks it touches instead of the whole book.
function renderChunk(i){
  const box = $("text").children[i]; if (!box) return;
  const {s: ps, e: pe} = S.pages[i];
  const vis = S.spans.filter(x => x.s < pe && x.e > ps);
  const pts = new Set([ps, pe]);
  for (const x of vis){ if (x.s > ps && x.s < pe) pts.add(x.s); if (x.e > ps && x.e < pe) pts.add(x.e); }
  const arr = [...pts].sort((a, b) => a - b);
  const frag = document.createDocumentFragment();
  for (let k = 0; k < arr.length - 1; k++){
    const a = arr[k], b = arr[k + 1];
    const el = document.createElement("span");
    el.dataset.s = a;
    el.textContent = S.text.slice(a, b);
    const cov = vis.filter(x => x.s <= a && x.e >= b);
    if (cov.length){
      const d = cov.find(x => x.id === S.sel) || cov.find(x => x.status !== "dropped") || cov[0];
      let cls = "ann st-" + d.status;
      if (d.id === S.sel) cls += " sel";
      if (cov.filter(x => x.status !== "dropped").length > 1){ cls += " ov"; el.title = "Two spans overlap here"; }
      el.className = cls; el.dataset.id = d.id;
    }
    frag.append(el);
  }
  box.replaceChildren(frag);
}
function renderAll(){
  const root = $("text"), frag = document.createDocumentFragment();
  S.pages.forEach((p, i) => { const d = document.createElement("div"); d.className = "chunk"; d.dataset.c = i; frag.append(d); });
  root.replaceChildren(frag);
  for (let i = 0; i < S.pages.length; i++) renderChunk(i);
  renderPop();
}
// Redraw only the blocks that cover the given character ranges [[s, e], ...]
function renderRanges(ranges){
  const done = new Set();
  for (const [a, b] of ranges){
    if (a == null) continue;
    const i0 = pageOf(Math.max(0, a)), i1 = pageOf(Math.max(a, b - 1));
    for (let i = i0; i <= i1; i++) if (!done.has(i)){ done.add(i); renderChunk(i); }
  }
  renderPop();
}
const rangeOf = x => x ? [x.s, x.e] : [null, null];

function renderProgress(){
  const orig = S.spans.filter(x => !x.isNew);
  const checked = orig.filter(x => x.status !== "todo").length;
  $("progressText").textContent = `${checked} / ${orig.length} checked`;
}

function statusLabel(sp){ return sp.status === "accepted" && (sp.isNew || sp.edited) ? (sp.isNew ? "added" : "edited") + " · accepted" : LABEL[sp.status]; }
const LABEL = {todo: "not checked", accepted: "accepted", edited: "edited", added: "added", dropped: "dropped"};
function renderChanges(){
  const ch = sorted().filter(x => x.status !== "todo" || x.isNew || x.edited);
  $("changeCount").textContent = `(${ch.length})`;
  const c = $("changes"); c.replaceChildren();
  if (!ch.length){ c.innerHTML = `<span class="muted">Nothing reviewed yet.</span>`; return; }
  for (const x of ch){
    const d = document.createElement("div");
    const kind = x.status === "dropped" ? "dropped" : x.isNew ? "added" : x.edited ? "edited" : "accepted";
    const ok = x.status === "accepted" && kind !== "accepted";
    d.innerHTML = `<span class="tag st-${x.status === "accepted" ? "accepted" : kind}">${kind}${ok ? " ✓" : ""}</span><span class="tib"></span>`;
    if (x.id === S.sel) d.classList.add("cur");
    d.lastChild.textContent = S.text.slice(x.s, Math.min(x.e, x.s + 30)) + (x.e - x.s > 30 ? "…" : "");
    d.onclick = () => select(x.id, true);
    c.append(d);
  }
}

// Floating Accept / Drop / Edit buttons right under the selected span
function renderPop(){
  const pop = $("pop");
  const sp = current();
  const els = sp ? $("text").querySelectorAll(`[data-id="${CSS.escape(sp.id)}"]`) : [];
  $("text").classList.toggle("editing", !!(sp && S.editing));
  if (!sp || !els.length){ pop.classList.add("hidden"); positionHandles(); return; }
  const dropped = sp.status === "dropped";
  pop.innerHTML = `
    <div class="row">
      ${dropped ? "" : `<button class="accept" data-act="accept">✓ Accept <kbd>A</kbd></button>`}
      <button class="drop-btn" data-act="drop">${dropped ? "Restore" : "Drop"} <kbd>D</kbd></button>
      ${dropped ? "" : `<button data-act="edit">${S.editing ? "✓ Done editing" : "Edit"} <kbd>E</kbd></button>`}
      <span class="tag st-${sp.status}">${statusLabel(sp)}</span>
    </div>
    ${S.editing && !dropped ? `
    <div class="hint">Drag the blue handles at the start and end of the span. Hold Alt (Option) while dragging to move by single letters.</div>
    <div class="row">
      <span class="muted">Fine-tune</span>
      <button data-n="s,-1" title="Start one syllable earlier">&larr; start</button><button data-n="s,1" title="Start one syllable later">start &rarr;</button>
      <button data-n="e,-1" title="End one syllable earlier">&larr; end</button><button data-n="e,1" title="End one syllable later">end &rarr;</button>
      ${sp.s !== sp.os || sp.e !== sp.oe ? `<button data-act="reset" title="Put the edges back where they started">Reset</button>` : ""}
    </div>` : ""}`;
  pop.querySelectorAll("[data-act]").forEach(b => b.onclick = () => ({accept, drop, edit: toggleEdit, reset: resetEdges})[b.dataset.act]());
  pop.querySelectorAll("[data-n]").forEach(b => b.onclick = () => { const [w, d] = b.dataset.n.split(","); nudge(w, +d); });
  pop.classList.remove("hidden");

  const last = els[els.length - 1].getClientRects();
  const r = last[last.length - 1];
  const box = $("textInner").getBoundingClientRect();
  const maxLeft = box.width - pop.offsetWidth;
  pop.style.top = (r.bottom - box.top + 14) + "px";
  pop.style.left = Math.max(0, Math.min(r.left - box.left, maxLeft)) + "px";
  positionHandles();
}

/* ---------- drag handles ---------- */
// DOM position of a character offset
function domPoint(off){
  if (off < 0 || off >= S.text.length) return null;
  const chunk = $("text").children[pageOf(off)]; if (!chunk) return null;
  const kids = chunk.childNodes;
  let lo = 0, hi = kids.length - 1;
  while (lo < hi){ const m = (lo + hi + 1) >> 1; if (Number(kids[m].dataset.s) <= off) lo = m; else hi = m - 1; }
  const el = kids[lo]; if (!el || !el.firstChild) return null;
  return {node: el.firstChild, offset: Math.min(off - Number(el.dataset.s), el.firstChild.length)};
}
function charRect(off, which){
  const p = domPoint(off); if (!p || p.offset >= p.node.length) return null;
  const r = document.createRange(); r.setStart(p.node, p.offset); r.setEnd(p.node, p.offset + 1);
  const rs = r.getClientRects(); if (!rs.length) return null;
  return which === "first" ? rs[0] : rs[rs.length - 1];
}
function positionHandles(){
  const hs = $("hStart"), he = $("hEnd"), sp = current();
  if (!hs || !he) return;
  hs.classList.add("hidden"); he.classList.add("hidden");
  if (!sp || !S.editing || sp.status === "dropped") return;
  const box = $("textInner").getBoundingClientRect();
  const place = (el, r, x) => {
    const pad = r.height * 0.15;
    el.style.left = (x - box.left) + "px";
    el.style.top = (r.top - box.top - pad) + "px";
    el.style.height = (r.height + 2 * pad) + "px";
    el.classList.remove("hidden");
  };
  { const r = charRect(sp.s, "first"); if (r) place(hs, r, r.left); }
  { const r = charRect(sp.e - 1, "last"); if (r) place(he, r, r.right); }
}

// Character offset under the mouse
function offsetFromPoint(x, y){
  let node = null, off = 0;
  if (document.caretPositionFromPoint){ const c = document.caretPositionFromPoint(x, y); if (c){ node = c.offsetNode; off = c.offset; } }
  else if (document.caretRangeFromPoint){ const c = document.caretRangeFromPoint(x, y); if (c){ node = c.startContainer; off = c.startOffset; } }
  return node ? pointOffset(node, off) : null;
}
// Snap to whole syllables unless Alt is held
function snapStart(p){
  const T = S.text, L = T.length;
  while (p > 0 && !isBreak(T[p - 1])) p--;
  while (p < L && isBreak(T[p])) p++;
  return p;
}
function snapEnd(p){
  const T = S.text, L = T.length;
  if (!(p > 0 && isBreak(T[p - 1]))) while (p < L && !isBreak(T[p])) p++;
  while (p < L && isBreak(T[p]) && !isSpace(T[p])) p++;      // keep the tsheg / shad
  while (p > 0 && isSpace(T[p - 1])) p--;
  return p;
}

let drag = null;
function startDrag(which, e){
  const sp = current(); if (!sp) return;
  e.preventDefault();
  window.getSelection().removeAllRanges();
  drag = {which, sp, before: {spans: S.spans.map(o => ({...o})), sel: S.sel}, s0: sp.s, e0: sp.e, raf: 0};
  document.body.classList.add("dragging");
  $(which === "s" ? "hStart" : "hEnd").classList.add("active");
}
function moveDrag(e){
  if (!drag) return;
  const off = offsetFromPoint(e.clientX, e.clientY);
  if (off == null) return;
  const sp = drag.sp, s0 = sp.s, e0 = sp.e;
  if (drag.which === "s"){
    const p = e.altKey ? off : snapStart(off);
    if (p < sp.e && p !== sp.s) sp.s = p; else return;
  } else {
    const p = e.altKey ? off : snapEnd(off);
    if (p > sp.s && p !== sp.e) sp.e = p; else return;
  }
  drag.lo = Math.min(drag.lo ?? s0, s0, sp.s); drag.hi = Math.max(drag.hi ?? e0, e0, sp.e);
  if (!drag.raf) drag.raf = requestAnimationFrame(() => { if (!drag) return; drag.raf = 0; renderRanges([[drag.lo, drag.hi]]); drag.lo = sp.s; drag.hi = sp.e; });
}
function endDrag(){
  if (!drag) return;
  const d = drag; drag = null;
  document.body.classList.remove("dragging");
  $("hStart").classList.remove("active"); $("hEnd").classList.remove("active");
  if (d.sp.s !== d.s0 || d.sp.e !== d.e0){
    S.hist.push(d.before); if (S.hist.length > 200) S.hist.shift();
    markChanged(d.sp);
    const notes = resolveOverlaps(d.sp);
    S.dirty = true; rebuildIndex(); refreshAll(); scheduleSave(); warnOverlap(notes);
  } else renderPop();
}
on("hStart", "pointerdown", e => startDrag("s", e));
on("hEnd", "pointerdown", e => startDrag("e", e));
document.addEventListener("pointermove", moveDrag);
document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", endDrag);

/* ---------- "+ Add" button next to selected text ---------- */
function renderAddPop(){
  const ap = $("addPop");
  if (!ap) return;
  const o = drag ? null : selectionOffsets();
  if (!o){ ap.classList.add("hidden"); return; }
  const sp = current();
  const editingSpan = sp && S.editing && sp.status !== "dropped";
  ap.innerHTML = `<div class="row">${editingSpan ? `<button data-act="use">Set as this span's text</button>` : ""}<button class="add-btn" data-act="add">+ Add as new span <kbd>N</kbd></button></div>`;
  ap.querySelector('[data-act="add"]').onclick = addFromSelection;
  const u = ap.querySelector('[data-act="use"]'); if (u) u.onclick = useSelection;
  const rs = window.getSelection().getRangeAt(0).getClientRects();
  const r = rs[rs.length - 1];
  const box = $("textInner").getBoundingClientRect();
  ap.classList.remove("hidden");
  ap.style.top = (r.bottom - box.top + 10) + "px";
  ap.style.left = Math.max(0, Math.min(r.right - box.left - ap.offsetWidth / 2, box.width - ap.offsetWidth)) + "px";
}
on("textWrap", "mouseup", () => setTimeout(renderAddPop, 0));
on("textWrap", "keyup", () => setTimeout(renderAddPop, 0));
on("addPop", "mousedown", e => e.preventDefault());   // keep the text selection when clicking the button

function refreshAll(){ renderAll(); renderProgress(); renderChanges(); }

function select(id, scroll){
  const old = current();
  S.sel = id; S.editing = false;
  const sp = S.byId.get(id);
  renderRanges([rangeOf(old), rangeOf(sp)]);
  if (scroll && sp){
    const el = $("text").querySelector(`[data-id="${CSS.escape(String(id))}"]`);
    if (el) el.scrollIntoView({block: "center", behavior: "smooth"});
  }
}

/* =================================================================
   EDITING
   ================================================================= */
function change(fn){
  const before = {spans: S.spans.map(o => ({...o})), sel: S.sel};
  S.hist.push(before);
  if (S.hist.length > 200) S.hist.shift();
  fn(); rebuildIndex(); S.dirty = true;
  // redraw the blocks around every span that moved, changed colour, appeared or disappeared
  const ranges = [], prev = new Map(before.spans.map(o => [o.id, o]));
  for (const x of S.spans){ const o = prev.get(x.id); if (!o || o.s !== x.s || o.e !== x.e || o.status !== x.status){ ranges.push([x.s, x.e]); if (o) ranges.push([o.s, o.e]); } prev.delete(x.id); }
  for (const o of prev.values()) ranges.push([o.s, o.e]);
  ranges.push(rangeOf(before.sel != null ? S.byId.get(before.sel) || prev.get(before.sel) : null), rangeOf(current()));
  renderRanges(ranges); renderProgress(); renderChanges(); scheduleSave();
}
function undo(){
  const h = S.hist.pop(); if (!h){ msg("Nothing to undo."); return; }
  S.spans = h.spans; S.sel = h.sel; rebuildIndex(); S.dirty = true;
  refreshAll(); scheduleSave(); msg("Undone.");
}

// A span keeps two things apart:
//   status  -> its colour: todo, accepted, edited, added, dropped
//   edited / isNew -> what was changed, so the export still says "edited" or "added" after you accept it
function markChanged(sp){ if (!sp.isNew) sp.edited = true; sp.status = sp.isNew ? "added" : "edited"; }
function changedStatus(sp){ return sp.isNew ? "added" : sp.edited ? "edited" : "todo"; }

function accept(){
  const sp = current(); if (!sp){ msg("Click a span first."); return; }
  if (sp.status === "dropped") return;
  S.editing = false;
  if (sp.status !== "accepted") change(() => { sp.status = "accepted"; });
  nextUnchecked(true);
}
function drop(){
  const sp = current(); if (!sp){ msg("Click a span first."); return; }
  if (sp.status === "dropped"){ let notes = []; change(() => { sp.status = sp.prev || "todo"; notes = resolveOverlaps(sp); }); msg("Span restored."); warnOverlap(notes); return; }
  if (sp.isNew){ change(() => { S.spans = S.spans.filter(x => x !== sp); S.sel = null; }); msg("Added span removed."); nextUnchecked(true); return; }
  change(() => { sp.prev = sp.status; sp.status = "dropped"; });
  nextUnchecked(true);
}
function toggleEdit(){ const sp = current(); if (!sp || sp.status === "dropped") return; S.editing = !S.editing; renderPop(); }

/* ---------- overlaps: the span you just made or changed wins ----------
 * Any other (not dropped) span that overlaps it is changed to fit:
 *   - partly overlapping      -> the older span is shortened
 *   - completely inside it    -> the older span is dropped
 *   - it sits inside an older span -> the older span is split into two parts around it
 */
function trimSpace(x){ const T = S.text; while (x.s < x.e && isSpace(T[x.s])) x.s++; while (x.e > x.s && isSpace(T[x.e - 1])) x.e--; }
function snip(x){ const t = S.text.slice(x.s, x.e); return t.length > 14 ? t.slice(0, 14) + "…" : t; }
function resolveOverlaps(w){
  const notes = [];
  if (!w || w.status === "dropped") return notes;
  for (const o of [...S.spans]){
    if (o === w || o.status === "dropped" || o.e <= w.s || o.s >= w.e) continue;
    const label = snip(o);
    const dropIt = () => { if (o.isNew) S.spans = S.spans.filter(x => x !== o); else { o.prev = o.status; o.status = "dropped"; } };
    if (o.s >= w.s && o.e <= w.e){ dropIt(); notes.push(`dropped “${label}” because it was completely inside`); continue; }
    if (o.s < w.s && o.e > w.e){
      const right = {id: newId(), s: w.e, e: o.e, status: "added", isNew: true};
      o.e = w.s; trimSpace(o); trimSpace(right);
      right.os = right.s; right.oe = right.e;
      if (right.e > right.s) S.spans.push(right);
      if (o.e > o.s) markChanged(o); else dropIt();
      notes.push(`split “${label}” into two parts around it`); continue;
    }
    if (o.s < w.s) o.e = w.s; else o.s = w.e;
    trimSpace(o);
    if (o.e > o.s){ markChanged(o); notes.push(`shortened “${label}” so they no longer overlap`); }
    else { dropIt(); notes.push(`dropped “${label}” because nothing was left of it`); }
  }
  return notes;
}
let toastTimer = null;
function toast(html, buttons){
  const t = $("toast"); if (!t){ msg(html.replace(/<[^>]+>/g, "")); return; }
  t.innerHTML = `<span class="grow">${html}</span>` + (buttons || []).map((b, i) => `<button class="small" data-i="${i}">${b.label}</button>`).join("") + `<button class="small" data-close>✕</button>`;
  (buttons || []).forEach((b, i) => t.querySelector(`[data-i="${i}"]`).onclick = () => { t.classList.add("hidden"); b.fn(); });
  t.querySelector("[data-close]").onclick = () => t.classList.add("hidden");
  t.classList.remove("hidden");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), 12000);
}
function warnOverlap(notes){
  if (!notes.length) return;
  toast(`⚠ This span overlapped ${notes.length === 1 ? "another span" : notes.length + " other spans"}. The newest one wins: ${esc(notes.join("; "))}.`, [{label: "Undo", fn: undo}]);
}
function overlapPairs(){
  const list = sorted().filter(x => x.status !== "dropped"); let n = 0, first = null, maxEnd = -1, maxSpan = null;
  for (const x of list){ if (x.s < maxEnd){ n++; if (!first) first = x; } if (x.e > maxEnd){ maxEnd = x.e; maxSpan = x; } }
  return {n, first};
}

function setBounds(sp, s, e){
  if (!(s >= 0 && e <= S.text.length && e > s)){ msg("A span can't be empty."); return false; }
  const keep = S.editing;
  let notes = [];
  change(() => { sp.s = s; sp.e = e; markChanged(sp); notes = resolveOverlaps(sp); });
  S.editing = keep; renderPop();
  msg(""); warnOverlap(notes); return true;
}
function resetEdges(){ const sp = current(); if (!sp) return; const keep = S.editing; let notes = []; change(() => { sp.s = sp.os; sp.e = sp.oe; if (!sp.isNew){ sp.edited = !!sp.editedBefore; } sp.status = sp.isNew ? "added" : (sp.edited ? "edited" : "accepted"); notes = resolveOverlaps(sp); }); S.editing = keep; renderPop(); warnOverlap(notes); }

// Move a span edge by one syllable (tsheg / shad / space aware)
function nudge(which, dir){
  const sp = current(); if (!sp || sp.status === "dropped") return;
  const T = S.text, L = T.length;
  let p;
  if (which === "s"){
    p = sp.s;
    if (dir > 0){ while (p < L && !isBreak(T[p])) p++; while (p < L && isBreak(T[p])) p++; }
    else { while (p > 0 && isBreak(T[p - 1])) p--; while (p > 0 && !isBreak(T[p - 1])) p--; }
    if (p >= sp.e){ msg("The start can't go past the end."); return; }
    setBounds(sp, p, sp.e);
  } else {
    p = sp.e;
    if (dir > 0){
      while (p < L && isBreak(T[p])) p++;
      while (p < L && !isBreak(T[p])) p++;
      while (p < L && isBreak(T[p]) && !isSpace(T[p])) p++;   // keep the tsheg / shad
    } else {
      while (p > sp.s && isBreak(T[p - 1])) p--;
      while (p > sp.s && !isBreak(T[p - 1])) p--;
      while (p > sp.s && isSpace(T[p - 1])) p--;
    }
    if (p <= sp.s){ msg("The end can't go before the start."); return; }
    setBounds(sp, sp.s, p);
  }
}

// Turn the browser's text selection into character offsets in the base text
function pointOffset(node, off){
  const root = $("text");
  if (!root.contains(node)) return null;
  if (node.nodeType === 3) return Number(node.parentElement.dataset.s) + off;
  if (node === root){
    if (off < root.children.length) return S.pages[off].s;
    return S.text.length;
  }
  if (node.classList && node.classList.contains("chunk")){
    const i = Number(node.dataset.c);
    if (off < node.childNodes.length) return Number(node.childNodes[off].dataset.s);
    return S.pages[i].e;
  }
  if (node.dataset && node.dataset.s != null) return Number(node.dataset.s) + (off > 0 ? node.textContent.length : 0);
  return null;
}
function selectionOffsets(){
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  let s = pointOffset(r.startContainer, r.startOffset), e = pointOffset(r.endContainer, r.endOffset);
  if (s == null || e == null) return null;
  if (s > e) [s, e] = [e, s];
  while (s < e && isSpace(S.text[s])) s++;
  while (e > s && isSpace(S.text[e - 1])) e--;
  return e > s ? {s, e} : null;
}
function newId(){
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}
function addFromSelection(){
  const o = selectionOffsets();
  if (!o){ msg("Select some text in the book first."); return; }
  const id = newId();
  let notes = [];
  change(() => { const sp = {id, s: o.s, e: o.e, os: o.s, oe: o.e, status: "added", isNew: true}; S.spans.push(sp); S.sel = id; notes = resolveOverlaps(sp); });
  warnOverlap(notes);
  window.getSelection().removeAllRanges(); updateSelInfo(); renderAddPop(); S.editing = false; renderPop(); msg("New span added. Press E to adjust its edges.");
}
function useSelection(){
  const sp = current(); const o = selectionOffsets();
  if (!sp) return;
  if (!o){ msg("Select the right text in the book, then click this again."); return; }
  if (setBounds(sp, o.s, o.e)){ window.getSelection().removeAllRanges(); updateSelInfo(); renderAddPop(); }
}

// Put every accepted span back to "not checked" (edits, additions and drops stay). One undo reverses it.
function restartReview(){
  change(() => { for (const x of S.spans) if (x.status === "accepted") x.status = changedStatus(x); });
  const first = sorted().find(x => x.status === "todo"); if (first) select(first.id, true);
  msg("Accepted spans are marked as not checked again.");
}
function nextSpan(){
  const list = sorted(); if (!list.length) return;
  const cur = current(); const i = cur ? list.indexOf(cur) : -1;
  if (i >= list.length - 1){ msg("That was the last span in the book."); return; }
  select(list[i + 1].id, true);
}
function nextUnchecked(quiet){
  const list = sorted(), cur = current();
  const from = cur ? cur.s : -1;
  let n = list.find(x => x.status === "todo" && (x.s > from || (cur && x.s === from && x.e > cur.e)));
  if (!n) n = list.find(x => x.status === "todo");
  if (n){ select(n.id, true); if (!quiet) msg(""); }
  else { msg("Every span is checked. Moving span by span — export the yaml file when you're done."); nextSpan(); }
}
function prevSpan(){
  const list = sorted(); if (!list.length) return;
  const cur = current(); const i = cur ? list.indexOf(cur) : 0;
  select(list[Math.max(0, i - 1)].id, true);
}

/* =================================================================
   SAVING (browser backup) AND EXPORT
   ================================================================= */
function storeLocal(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e){ return false; } }
function loadLocal(k){ try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e){ return null; } }
function scheduleSave(){
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(() => {
    const orig = S.spans.filter(x => !x.isNew);
    const ok = storeLocal(S.key, {t: Date.now(), spans: S.spans, checked: orig.filter(x => x.status !== "todo").length});
    $("saveState").textContent = ok ? `Backed up in this browser · ${new Date().toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})}` : "Export often — this browser can't keep a backup";
  }, 400);
}

function exportName(){ return `${S.opfId}-${S.annotation.toLowerCase()}.yaml`; }

function buildExport(){
  const L = structuredClone(S.layer);
  const setAnn = (ann, sp) => {
    const t = (ann.span && typeof ann.span === "object") ? ann.span : ann;
    t.start = sp.s; t.end = sp.e - 1;
    delete ann.review; delete ann.confirmed;
    Object.assign(ann, reviewFields(sp));
  };
  // review: what happened to the span. confirmed: an edited or added span that was then accepted.
  const reviewFields = sp => {
    const r = sp.isNew ? "added" : sp.edited ? "edited" : sp.status === "accepted" ? "accepted" : null;
    if (!r) return {};
    return (r !== "accepted" && sp.status === "accepted") ? {review: r, confirmed: true} : {review: r};
  };
  const fresh = sp => Object.assign({span: {start: sp.s, end: sp.e - 1}}, reviewFields(sp));
  const kept = new Set();
  if (Array.isArray(L.annotations)){
    const out = [];
    L.annotations.forEach((ann, i) => {
      const id = String(ann && ann.id != null ? ann.id : "row" + i);
      const sp = S.byId.get(id);
      if (sp && sp.status === "dropped") return;
      if (sp){ setAnn(ann, sp); kept.add(id); }
      else if (readSE(ann)) return;                 // an added span that was later removed
      out.push(ann);
    });
    for (const sp of S.spans) if (!kept.has(sp.id) && sp.status !== "dropped") out.push(Object.assign({id: sp.id}, fresh(sp)));
    L.annotations = out;
  } else {
    const out = {};
    for (const [k, ann] of Object.entries(L.annotations)){
      const sp = S.byId.get(String(k));
      if (sp && sp.status === "dropped") continue;
      if (sp){ setAnn(ann, sp); kept.add(String(k)); }
      else if (readSE(ann)) continue;
      out[k] = ann;
    }
    for (const sp of S.spans) if (!kept.has(sp.id) && sp.status !== "dropped") out[sp.id] = fresh(sp);
    L.annotations = out;
  }
  const orig = S.spans.filter(x => !x.isNew);
  L.review = {
    opf: S.opfId,
    annotation: S.annotation,
    base_file: S.basePath,
    layer_file: S.layerPath,
    updated: new Date().toISOString(),
    checked: orig.filter(x => x.status !== "todo").length,
    total: orig.length,
    accepted: orig.filter(x => x.status === "accepted" && !x.edited).length,
    edited: orig.filter(x => x.edited && x.status !== "dropped").length,
    added: S.spans.filter(x => x.isNew).length,
    dropped: sorted().filter(x => x.status === "dropped").map(x => ({id: x.id, start: x.s, end: x.e - 1}))
  };
  return jsyaml.dump(L, {schema: jsyaml.CORE_SCHEMA, lineWidth: -1, noRefs: true, sortKeys: false});
}
function exportYaml(){
  const blob = new Blob([buildExport()], {type: "text/yaml;charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = exportName();
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  S.dirty = false; msg(`Exported ${exportName()}`);
}

/* =================================================================
   WIRING
   ================================================================= */
$("exportBtn").onclick = exportYaml;
$("nextBtn").onclick = () => nextUnchecked(false);
$("prevBtn").onclick = prevSpan;
$("undoBtn").onclick = undo;

$("text").addEventListener("click", e => {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  const el = e.target.closest("[data-id]");
  if (el) select(el.dataset.id, false);
});
$("text").addEventListener("dblclick", e => {
  const el = e.target.closest("[data-id]");
  if (!el) return;
  window.getSelection().removeAllRanges();
  select(el.dataset.id, false);
  const sp = current(); if (sp && sp.status !== "dropped"){ S.editing = true; renderPop(); }
});
function updateSelInfo(){
  const o = selectionOffsets();
  $("selInfo").textContent = o ? `${o.e - o.s} characters selected (${o.s}–${o.e - 1}). Use the "+ Add" button next to it.` : 'Select text in the book with the mouse. A "+ Add" button appears next to it.';
  if (!o && $("addPop")) $("addPop").classList.add("hidden");
}
document.addEventListener("selectionchange", () => { if (!$("review").classList.contains("hidden")) updateSelInfo(); });
window.addEventListener("resize", () => { if (!$("review").classList.contains("hidden")){ renderPop(); renderAddPop(); } });

document.addEventListener("keydown", e => {
  if ($("review").classList.contains("hidden")) return;
  if (e.target.matches("input,textarea,select")) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z"){ e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const map = {a: accept, d: drop, e: toggleEdit, j: () => nextUnchecked(false), k: prevSpan, n: addFromSelection};
  if (map[k]){ e.preventDefault(); map[k](); }
  else if (k === "escape"){ const old = current(); S.sel = null; S.editing = false; renderRanges([rangeOf(old)]); }
});
window.addEventListener("beforeunload", e => { if (S.dirty){ e.preventDefault(); e.returnValue = ""; } });

verify();
