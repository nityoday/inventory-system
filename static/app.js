/* Home Inventory - browser app. Plain JavaScript, no build step, no external requests. */
(function () {
  'use strict';

  const L = window.InvLogic;
  const WIDE = window.matchMedia('(min-width: 1000px)');
  const DEEP_INDENT_LIMIT = 12; // stop indenting after this many levels so phones never overflow

  const S = {
    data: null,       // latest state from the Pi: {entries, tags, revision}
    index: null,      // derived lookups (tree, effective tags, ...)
    route: { name: 'home', q: '', tags: [] },
    expanded: new Set(),
    flashId: null,
  };
  let importState = freshImport();

  // ---------------------------------------------------------------------
  // tiny DOM helpers (all text goes through text nodes, never innerHTML)
  // ---------------------------------------------------------------------
  const $ = (sel, root) => (root || document).querySelector(sel);

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'vars') for (const [n, val] of Object.entries(v)) el.style.setProperty(n, val);
        else if (k === 'value') el.value = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    for (const k of kids.flat(Infinity)) {
      if (k == null || k === false) continue;
      el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
  }
  const enc = encodeURIComponent;
  const entryHref = (id) => '#/entry/' + enc(id);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function chevronIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M9 5l7 7-7 7');
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2.4');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
    return svg;
  }

  // ---------------------------------------------------------------------
  // talking to the Pi
  // ---------------------------------------------------------------------
  class ApiError extends Error {
    constructor(code, message, status, field) {
      super(message);
      this.code = code;
      this.status = status;
      this.field = field;
    }
  }
  const errMsg = (e) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');

  async function api(method, path, body) {
    const opts = { method, cache: 'no-store', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch (_) {
      setOffline(true);
      throw new ApiError('network', 'Can’t reach the Raspberry Pi. Check your Wi‑Fi and try again.', 0);
    }
    setOffline(false);
    let payload = null;
    try {
      payload = await res.json();
    } catch (_) { /* not JSON */ }
    if (!res.ok) {
      const e = payload && payload.error;
      throw new ApiError((e && e.code) || 'error', (e && e.message) || `The server reported an error (${res.status}).`, res.status, e && e.field);
    }
    return payload;
  }

  function applyState(state) {
    S.data = state;
    S.index = L.buildIndex(state);
  }

  /** Send a change; on success adopt the Pi's new state (but do not render yet). */
  async function mutate(method, path, body) {
    const payload = await api(method, path, body);
    applyState(payload.state);
    return payload;
  }

  function setOffline(off) {
    $('#conn').hidden = !off;
  }

  // ---------------------------------------------------------------------
  // toasts and sheets
  // ---------------------------------------------------------------------
  function toast(message, opts) {
    const error = !!(opts && opts.error);
    const box = $('#toasts');
    while (box.children.length >= 3) box.firstChild.remove();
    const el = h('div', { class: 'toast' + (error ? ' error' : '') }, message);
    box.append(el);
    setTimeout(() => el.remove(), error ? 7000 : 3600);
  }

  let sheetSeq = 0;
  function openSheet({ title, body, footer, focus }) {
    const titleId = 'sheet-title-' + ++sheetSeq;
    const dlg = h('dialog', { class: 'sheet', 'aria-labelledby': titleId });
    dlg.append(
      h('div', { class: 'sheet-inner' },
        h('div', { class: 'sheet-head' },
          h('h2', { id: titleId }, title),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '×')),
        h('div', { class: 'sheet-body' }, body),
        footer ? h('div', { class: 'sheet-foot' }, footer) : null));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    if (focus) focus.focus();
    return dlg;
  }
  const closeAllSheets = () => document.querySelectorAll('dialog.sheet[open]').forEach((d) => d.close());

  /** Confirmation dialog with inline error handling. `run(dlg)` must close the dialog on success. */
  function confirmDialog({ title, body, confirmLabel, cancelLabel = 'Cancel', danger = true, run }) {
    const err = h('p', { class: 'form-error', role: 'alert' });
    let dlg;
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, cancelLabel);
    const ok = h('button', {
      class: 'btn ' + (danger ? 'danger-solid' : 'primary'), type: 'button',
      onclick: async () => {
        ok.disabled = cancel.disabled = true;
        err.textContent = '';
        try {
          await run(dlg);
        } catch (e) {
          err.textContent = errMsg(e);
          ok.disabled = cancel.disabled = false;
        }
      },
    }, confirmLabel);
    dlg = openSheet({ title, body: [body, err], footer: [cancel, ok], focus: cancel });
    return dlg;
  }

  // ---------------------------------------------------------------------
  // small UI pieces
  // ---------------------------------------------------------------------
  function tagChip(tag, opts) {
    const from = opts && opts.from;
    const el = h('span', {
      class: 'chip' + (from ? ' inherited' : '') + (opts && opts.small ? ' small' : ''),
      vars: { '--tag': tag.color, '--tag-text': L.textColorFor(tag.color) },
      title: from ? `Inherited from ${from.name}` : null,
    }, tag.name);
    if (from) el.append(h('span', { class: 'chip-note' }, `inherited from ${from.name}`));
    return el;
  }

  function highlight(text, terms) {
    return L.highlightParts(text, terms).map((p) => (p.hit ? h('mark', null, p.text) : p.text));
  }

  function breadcrumbs(entry) {
    const path = S.index.pathTo(entry.id);
    const ol = h('ol', { class: 'crumbs' }, h('li', null, h('a', { href: '#/' }, 'Home')));
    path.forEach((e, i) => {
      const last = i === path.length - 1;
      ol.append(h('li', null, last
        ? h('span', { 'aria-current': 'location' }, e.name)
        : h('a', { href: entryHref(e.id) }, e.name)));
    });
    return h('nav', { 'aria-label': 'Location of ' + entry.name }, ol);
  }

  function emptyState(title, text, action) {
    return h('div', { class: 'empty' }, h('h2', null, title), text ? h('p', null, text) : null, action);
  }

  // ---------------------------------------------------------------------
  // the selected-entry panel
  // ---------------------------------------------------------------------
  function entryPanel(entry) {
    const idx = S.index;
    const eff = idx.effectiveTags(entry.id);
    const parent = entry.parentId ? idx.byId.get(entry.parentId) : null;
    const direct = idx.childrenOf(entry.id).length;
    const total = idx.descendantCount(entry.id);
    const hasTags = eff.direct.length || eff.inherited.length;

    let stats = 'Nothing inside yet.';
    if (direct) {
      stats = `${plural(direct, 'entry', 'entries')} directly inside`;
      if (total > direct) stats += `, ${total} counting everything nested deeper`;
      stats += '.';
    }

    return h('section', { class: 'panel', 'aria-label': 'Details for ' + entry.name },
      h('div', { class: 'panel-loc' }, breadcrumbs(entry)),
      h('div', { class: 'panel-body' },
        h('h2', null, entry.name),
        h('p', { class: 'inside-line' }, parent ? ['Inside ', h('a', { href: entryHref(parent.id) }, parent.name)] : 'At the top level'),
        entry.description ? h('p', { class: 'desc' }, entry.description) : h('p', { class: 'desc muted' }, 'No description.'),
        h('div', { class: 'panel-section' },
          h('div', { class: 'panel-label' }, 'Tags'),
          hasTags
            ? h('div', { class: 'chips' }, eff.direct.map((t) => tagChip(t)), eff.inherited.map((x) => tagChip(x.tag, { from: x.from })))
            : h('p', { class: 'muted' }, 'No tags.'),
          eff.inherited.length ? h('p', { class: 'hint' }, 'Dashed tags are inherited from the places this entry is inside.') : null),
        h('p', { class: 'stats' }, stats),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => openEntryForm({ parentId: entry.id }) }, 'Add inside'),
          h('button', { class: 'btn', type: 'button', onclick: () => openEntryForm({ entry }) }, 'Edit'),
          h('button', { class: 'btn', type: 'button', onclick: () => openMoveDialog(entry) }, 'Move'),
          h('button', { class: 'btn danger', type: 'button', onclick: () => startDelete(entry) }, 'Delete'))));
  }

  // ---------------------------------------------------------------------
  // tree rendering (browse and search share the same row component)
  // ---------------------------------------------------------------------
  function treeList(parentId, ctx, depth) {
    const idx = S.index;
    let kids = idx.childrenOf(parentId);
    if (ctx.mode === 'search') kids = kids.filter((k) => ctx.visible.has(k.id));
    if (!kids.length) return null;
    const ul = h('ul', { class: 'tree' + (depth >= DEEP_INDENT_LIMIT ? ' capped' : '') });
    for (const e of kids) ul.append(treeNode(e, depth, ctx));
    return ul;
  }

  function treeNode(entry, depth, ctx) {
    const idx = S.index;
    const searching = ctx.mode === 'search';
    const isSel = ctx.selectedId === entry.id;
    const isParent = !searching && ctx.parentId === entry.id;
    const allKids = idx.childrenOf(entry.id);
    const open = searching ? true : S.expanded.has(entry.id);
    const match = searching ? ctx.matches.get(entry.id) : null;

    const cls = ['row'];
    if (isSel) cls.push('selected');
    if (isParent) cls.push('is-parent');
    if (searching) cls.push(match ? 'match' : 'context');
    if (S.flashId === entry.id) cls.push('flash');

    const top = h('div', { class: 'row-top' },
      h('a', { class: 'name', href: entryHref(entry.id), 'aria-current': isSel ? 'location' : null },
        searching && match ? highlight(entry.name, ctx.terms) : entry.name));
    if (!searching && allKids.length) {
      top.append(h('span', { class: 'count', title: plural(allKids.length, 'entry', 'entries') + ' directly inside' }, String(allKids.length)));
    }
    if (isSel) top.append(h('span', { class: 'pill' }, 'Here'));
    if (isParent) top.append(h('span', { class: 'pill soft' }, 'Parent'));
    if (searching && !match) top.append(h('span', { class: 'pill ctx', title: 'Shown only to give location' }, 'context'));
    if (searching && match) {
      top.append(h('a', { class: 'btn small row-open', href: entryHref(entry.id), 'aria-label': 'Open ' + entry.name }, 'Open'));
    }

    const main = h('div', { class: 'row-main' }, top);

    if (searching && match) {
      if (match.snippet || match.tags.length) {
        main.append(h('div', { class: 'reasons' },
          match.snippet ? h('div', { class: 'snippet' }, highlight(match.snippet, ctx.terms)) : null,
          match.tags.length ? h('div', { class: 'chips' }, match.tags.map((r) => tagChip(r.tag, { from: r.from, small: true }))) : null));
      }
    } else if (!searching) {
      const direct = idx.effectiveTags(entry.id).direct;
      if (direct.length) main.append(h('div', { class: 'row-tags' }, direct.map((t) => tagChip(t, { small: true }))));
    }

    const lead = !searching && allKids.length
      ? h('button', {
          class: 'chev', type: 'button', 'aria-expanded': String(open),
          'aria-label': (open ? 'Collapse ' : 'Expand ') + entry.name,
          onclick: () => toggleExpanded(entry.id),
        }, chevronIcon())
      : h('span', { class: 'chev-spacer' });

    const li = h('li', { class: 'node', 'data-id': entry.id }, h('div', { class: cls.join(' ') }, lead, main));
    if (isSel && ctx.inlinePanel) {
      li.append(entryPanel(entry));
      ctx.panelRendered = true;
    }
    if (open) {
      const sub = treeList(entry.id, ctx, depth + 1);
      if (sub) li.append(sub);
    }
    return li;
  }

  function toggleExpanded(id) {
    if (S.expanded.has(id)) S.expanded.delete(id);
    else S.expanded.add(id);
    render();
  }

  // ---------------------------------------------------------------------
  // screens
  // ---------------------------------------------------------------------
  function renderBrowse() {
    const idx = S.index;
    const sel = S.route.name === 'entry' ? idx.byId.get(S.route.id) : null;
    if (S.route.name === 'entry' && !sel) {
      return emptyState('That entry isn’t here',
        'It may have been deleted from another device, or the link is out of date.',
        h('a', { class: 'btn primary', href: '#/' }, 'Back to Home'));
    }

    const wide = WIDE.matches;
    const ctx = { mode: 'browse', selectedId: sel && sel.id, parentId: sel && sel.parentId, inlinePanel: !wide && !!sel };

    const baseline = sel ? idx.pathTo(sel.id).length : 0; // the path to the selection always stays open
    const head = h('div', { class: 'tree-head' },
      h('h2', null, 'Locations'),
      h('div', { class: 'grow' },
        S.expanded.size > baseline ? h('button', { class: 'btn quiet small', type: 'button', onclick: () => { resetExpansion(); render(); } }, 'Collapse all') : null,
        h('button', { class: 'btn primary', type: 'button', onclick: () => openEntryForm({ parentId: null }) }, '+ Add root entry')));

    if (!idx.roots.length) {
      return h('div', null, head, emptyState('Nothing here yet',
        'Start with a property, a room, or anything else you want to keep track of. You can put entries inside entries as deep as you like.',
        h('button', { class: 'btn primary', type: 'button', onclick: () => openEntryForm({ parentId: null }) }, 'Add your first entry')));
    }

    const tree = treeList(null, ctx, 0);
    // If the user collapsed a branch above the selection, still show its details (phones).
    const orphanPanel = ctx.inlinePanel && !ctx.panelRendered ? entryPanel(sel) : null;
    if (orphanPanel) orphanPanel.style.marginLeft = '0';
    const left = h('section', { class: 'tree-col', 'aria-label': 'Inventory' }, head, orphanPanel, tree);
    if (!wide) return h('div', { class: 'browse' }, left);

    const aside = h('aside', { class: 'aside', 'aria-label': 'Selected entry' },
      sel ? entryPanel(sel) : h('div', { class: 'aside-empty' },
        h('strong', null, 'Select an entry'),
        h('p', null, 'Pick anything in the list to see where it lives, what it holds, and its tags. Add, edit, move, and delete from here.')));
    return h('div', { class: 'browse has-aside' }, left, aside);
  }

  function renderSearch(result) {
    const idx = S.index;
    const { q, tags } = S.route;
    const tagNames = tags.filter((id) => idx.tagById.has(id)).map((id) => idx.tagById.get(id).name);
    const parts = [];
    if (result.terms.length) parts.push(`“${q.trim()}”`);
    if (tagNames.length) parts.push('tagged ' + tagNames.join(' or '));

    const status = result.count ? plural(result.count, 'match', 'matches') : 'No matches';
    $('#sr-status').textContent = `${status} for ${parts.join(' ')}`;

    if (!result.count) {
      return emptyState('No matches', `Nothing in the inventory matches ${parts.join(' ')}. Check the spelling, try fewer words, or clear a tag filter.`);
    }
    const ctx = { mode: 'search', matches: result.matches, visible: result.visible, terms: result.terms };
    return h('section', { 'aria-label': 'Search results' },
      h('p', { class: 'results-summary' },
        h('strong', null, status), ' for ', parts.join(' '), '. ',
        'Filled dots are matches; faded rows only show where a match is stored.'),
      treeList(null, ctx, 0));
  }

  function renderTags() {
    const idx = S.index;
    const counts = idx.tagUseCounts();

    const input = h('input', {
      class: 'input', id: 'new-tag', type: 'text', maxlength: '40', autocomplete: 'off',
      placeholder: 'New tag name, for example Gift', 'aria-label': 'New tag name', 'data-keep': '1',
    });
    const err = h('p', { class: 'field-error', role: 'alert' });
    const form = h('form', {
      class: 'add-tag', novalidate: true,
      onsubmit: async (ev) => {
        ev.preventDefault();
        err.textContent = '';
        const name = input.value.trim();
        if (!name) { err.textContent = 'Enter a name for the tag.'; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
        input.removeAttribute('aria-invalid');
        try {
          await mutate('POST', '/api/tags', { name });
          input.value = '';
          render();
          toast(`Created tag “${name}”.`);
        } catch (e) {
          err.textContent = errMsg(e);
          input.setAttribute('aria-invalid', 'true');
        }
      },
    }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Add tag'));

    const list = idx.tags.length
      ? h('ul', { class: 'tag-list' }, idx.tags.map((t) => {
          const n = counts.get(t.id) || 0;
          return h('li', { class: 'tag-row' },
            tagChip(t),
            h('span', { class: 'used' }, n ? `On ${plural(n, 'entry', 'entries')}` : 'Not used yet'),
            h('div', { class: 'row-actions' },
              h('button', { class: 'btn small', type: 'button', 'aria-label': 'Rename tag ' + t.name, onclick: () => openRenameTag(t) }, 'Rename'),
              h('button', { class: 'btn small danger', type: 'button', 'aria-label': 'Delete tag ' + t.name, onclick: () => startDeleteTag(t) }, 'Delete')));
        }))
      : emptyState('No tags yet', 'Tags are labels such as Gift, Winter, or Fragile. Add one above, then attach it to any entry.');

    return h('div', { class: 'screen' },
      h('h1', null, 'Tags'),
      h('p', { class: 'muted' }, 'A tag on an entry is also inherited by everything inside it, so tagging a cabinet Gift tags its boxes and items too.'),
      form, err, list);
  }

  function renderData() {
    const idx = S.index;
    const imp = importState;

    const exportBtn = h('button', { class: 'btn primary', type: 'button', onclick: (ev) => doExport(ev.currentTarget) }, 'Download export');

    const fileInput = h('input', {
      type: 'file', accept: 'application/json,.json', class: 'sr-only',
      onchange: (ev) => { const f = ev.target.files && ev.target.files[0]; if (f) onFileChosen(f); },
    });
    const picker = h('label', { class: 'btn' }, imp.fileName ? 'Choose a different file' : 'Choose JSON file', fileInput);

    return h('div', { class: 'screen' },
      h('h1', null, 'Import / Export'),
      h('div', { class: 'section' },
        h('h2', null, 'Export'),
        h('p', null, `Download everything (${plural(idx.entries.length, 'entry', 'entries')} and ${plural(idx.tags.length, 'tag', 'tags')}) as one JSON file. Keep it somewhere safe as a backup.`),
        exportBtn),
      h('div', { class: 'section' },
        h('h2', null, 'Import'),
        h('div', { class: 'notice' },
          h('strong', null, 'Importing replaces your whole inventory. '),
          'Nothing is merged, and no backup is made automatically. If you might want today’s inventory back, export it first.'),
        h('div', { class: 'file-line' }, picker,
          imp.fileName ? h('span', { class: 'file-name muted' }, imp.fileName) : h('span', { class: 'muted' }, 'No file chosen')),
        imp.checking ? h('p', { class: 'muted' }, 'Checking the file…') : null,
        imp.error ? h('div', { class: 'notice', role: 'alert' }, h('strong', null, 'This file can’t be imported. '), imp.error, h('p', { class: 'hint' }, 'Your current inventory has not been changed.')) : null,
        imp.summary
          ? h('div', null,
              h('div', { class: 'notice info' }, `The file looks good: ${plural(imp.summary.entries, 'entry', 'entries')} and ${plural(imp.summary.tags, 'tag', 'tags')}.`),
              h('button', { class: 'btn danger-solid', type: 'button', onclick: confirmImport }, 'Replace inventory…'))
          : null));
  }

  function freshImport() {
    return { text: null, fileName: '', summary: null, error: null, checking: false };
  }

  async function onFileChosen(file) {
    importState = freshImport();
    importState.fileName = file.name;
    importState.checking = true;
    render();
    try {
      if (file.size > 32 * 1024 * 1024) throw new ApiError('too_large', 'That file is larger than 32 MB, so it can’t be an inventory export.');
      const text = await file.text();
      importState.summary = await api('POST', '/api/import/validate', text);
      importState.text = text;
    } catch (e) {
      importState.error = errMsg(e);
    }
    importState.checking = false;
    render();
  }

  function confirmImport() {
    const s = importState.summary;
    confirmDialog({
      title: 'Replace your inventory?',
      body: h('div', null,
        h('p', null, `This will delete everything currently stored (${plural(S.index.entries.length, 'entry', 'entries')}, ${plural(S.index.tags.length, 'tag', 'tags')}) and replace it with the contents of “${importState.fileName}” (${plural(s.entries, 'entry', 'entries')}, ${plural(s.tags, 'tag', 'tags')}).`),
        h('p', null, h('strong', null, 'This can’t be undone, and no backup is made.'), ' Cancel and use Export first if you want a copy of what’s there now.')),
      confirmLabel: 'Replace inventory',
      run: async (dlg) => {
        const p = await mutate('POST', '/api/import', importState.text);
        importState = freshImport();
        dlg.close();
        S.expanded = new Set();
        go('#/');
        toast(`Imported ${plural(p.imported.entries, 'entry', 'entries')} and ${plural(p.imported.tags, 'tag', 'tags')}.`);
      },
    });
  }

  async function doExport(btn) {
    btn.disabled = true;
    try {
      let res;
      try {
        res = await fetch('/api/export', { cache: 'no-store' });
      } catch (_) {
        throw new ApiError('network', 'Can’t reach the Raspberry Pi. Check your Wi‑Fi and try again.', 0);
      }
      if (!res.ok) {
        let msg = `The export failed (${res.status}).`;
        try { msg = (await res.json()).error.message; } catch (_) { /* keep default */ }
        throw new ApiError('export_failed', msg, res.status);
      }
      const blob = await res.blob();
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const name = `home-inventory-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      toast(`Export ready. Your browser is saving ${name}.`);
    } catch (e) {
      toast(errMsg(e), { error: true });
    } finally {
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------
  // entry dialogs: add / edit
  // ---------------------------------------------------------------------
  function tagPicker(selected) {
    const tags = S.index.tags;
    if (!tags.length) {
      return h('p', { class: 'muted' }, 'No tags yet. ', h('a', { href: '#/tags', onclick: closeAllSheets }, 'Create some on the Tags screen'), '.');
    }
    const wrap = h('div', { class: 'tag-picker', role: 'group', 'aria-label': 'Tags' });
    for (const t of tags) {
      const input = h('input', { type: 'checkbox', value: t.id, checked: selected.has(t.id) });
      input.addEventListener('change', () => {
        if (input.checked) selected.add(t.id);
        else selected.delete(t.id);
        if (selected.onChange) selected.onChange();
      });
      wrap.append(h('label', { class: 'tag-toggle', vars: { '--tag': t.color, '--tag-text': L.textColorFor(t.color) } },
        input, h('span', { class: 'chip' }, t.name)));
    }
    return wrap;
  }

  function openEntryForm({ entry = null, parentId = null }) {
    const idx = S.index;
    const isEdit = !!entry;
    const selected = new Set(isEdit ? entry.tagIds : []);

    const nameInput = h('input', { class: 'input', id: 'f-name', type: 'text', maxlength: '200', autocomplete: 'off', 'aria-describedby': 'f-name-err', value: isEdit ? entry.name : '' });
    const nameErr = h('p', { class: 'field-error', id: 'f-name-err', role: 'alert' });
    const descInput = h('textarea', { class: 'input', id: 'f-desc', rows: '3', maxlength: '5000', value: isEdit ? entry.description : '' });
    const formErr = h('p', { class: 'form-error', role: 'alert' });

    let where;
    let inherits;
    if (isEdit) {
      inherits = idx.effectiveTags(entry.id).inherited;
      where = entry.parentId && idx.byId.has(entry.parentId)
        ? 'Inside ' + idx.pathTo(entry.parentId).map((e) => e.name).join(' › ')
        : 'At the top level';
    } else if (parentId && idx.byId.has(parentId)) {
      inherits = idx.tagsInheritedByChildOf(parentId);
      where = 'Adding inside ' + idx.pathTo(parentId).map((e) => e.name).join(' › ');
    } else {
      inherits = [];
      where = 'Adding at the top level';
    }

    const form = h('form', { id: 'entry-form', novalidate: true },
      h('p', { class: 'muted' }, where),
      h('div', { class: 'field' }, h('label', { class: 'lbl', for: 'f-name' }, 'Name'), nameInput, nameErr),
      h('div', { class: 'field' }, h('label', { class: 'lbl', for: 'f-desc' }, 'Description (optional)'), descInput),
      h('div', { class: 'field' },
        h('div', { class: 'lbl' }, 'Tags (optional)'),
        tagPicker(selected),
        inherits.length
          ? h('div', { class: 'hint' }, isEdit ? 'Also inherited from the places this is inside: ' : 'It will also inherit: ',
              h('span', { class: 'chips', style: 'display:inline-flex;vertical-align:middle' }, inherits.map((x) => tagChip(x.tag, { from: x.from, small: true }))))
          : null),
      formErr);

    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel');
    const save = h('button', { class: 'btn primary', type: 'submit', form: 'entry-form' }, isEdit ? 'Save changes' : 'Add entry');
    const dlg = openSheet({ title: isEdit ? 'Edit entry' : 'New entry', body: form, footer: [cancel, save], focus: nameInput });

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      nameErr.textContent = '';
      formErr.textContent = '';
      nameInput.removeAttribute('aria-invalid');
      const name = nameInput.value.trim();
      if (!name) {
        nameErr.textContent = 'Enter a name.';
        nameInput.setAttribute('aria-invalid', 'true');
        nameInput.focus();
        return;
      }
      const body = { name, description: descInput.value, tagIds: [...selected] };
      save.disabled = cancel.disabled = true;
      try {
        if (isEdit) {
          await mutate('PATCH', `/api/entries/${enc(entry.id)}`, body);
          dlg.close();
          render();
          toast(`Saved “${name}”.`);
        } else {
          body.parentId = parentId;
          const p = await mutate('POST', '/api/entries', body);
          if (parentId) S.expanded.add(parentId);
          flash(p.entryId);
          dlg.close();
          render();
          scrollToNode(p.entryId);
          toast(parentId ? `Added “${name}” to ${S.index.byId.get(parentId).name}.` : `Added “${name}”.`);
        }
      } catch (e) {
        save.disabled = cancel.disabled = false;
        if (e.field === 'name') { nameErr.textContent = e.message; nameInput.setAttribute('aria-invalid', 'true'); }
        else formErr.textContent = errMsg(e);
      }
    });
  }

  function flash(id) {
    S.flashId = id;
    setTimeout(() => { if (S.flashId === id) S.flashId = null; }, 2500);
  }

  function scrollToNode(id) {
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-id="${CSS.escape(id)}"] > .row`);
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  // ---------------------------------------------------------------------
  // move
  // ---------------------------------------------------------------------
  function openMoveDialog(entry) {
    let at = entry.parentId && S.index.byId.has(entry.parentId) ? entry.parentId : null;
    const body = h('div');
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel');
    const moveBtn = h('button', { class: 'btn primary', type: 'button' }, 'Move here');
    const dlg = openSheet({ title: 'Move entry', body, footer: [cancel, moveBtn] });

    function crumbButton(label, id) {
      return h('button', { class: 'crumb', type: 'button', onclick: () => { at = id; draw(); } }, label);
    }

    let destLabel = 'Top level';
    function draw() {
      const idx = S.index;
      if (!idx.byId.has(entry.id)) {
        body.replaceChildren(h('p', null, 'This entry no longer exists.'));
        moveBtn.disabled = true;
        return;
      }
      if (at && !idx.byId.has(at)) at = null;
      const here = at ? idx.pathTo(at) : [];
      const same = (at || null) === (entry.parentId || null);
      destLabel = here.length ? here.map((e) => e.name).join(' › ') : 'Top level';

      const crumbs = h('nav', { 'aria-label': 'Browsing location' },
        h('ol', { class: 'crumbs' },
          h('li', null, at ? crumbButton('Top level', null) : h('span', { 'aria-current': 'location' }, 'Top level')),
          here.map((e) => h('li', null, e.id === at ? h('span', { 'aria-current': 'location' }, e.name) : crumbButton(e.name, e.id)))));

      const kids = idx.childrenOf(at).filter((c) => c.id !== entry.id);
      const list = kids.length
        ? h('ul', { class: 'pick-list' }, kids.map((c) => h('li', null,
            h('button', { class: 'pick-row', type: 'button', 'aria-label': 'Browse inside ' + c.name, onclick: () => { at = c.id; draw(); } },
              h('span', { class: 'pname' }, c.name),
              h('span', { class: 'muted' }, idx.childrenOf(c.id).length ? plural(idx.childrenOf(c.id).length, 'entry', 'entries') + ' ' : '', chevronIcon())))))
        : h('p', { class: 'pick-empty' }, at ? 'No other entries inside here. You can still choose this place.' : 'No other entries yet.');

      body.replaceChildren(
        h('p', null, 'Choose where ', h('strong', null, entry.name), ' and everything inside it should go. Browse into an entry, then choose Move here.'),
        crumbs, list,
        h('div', { class: 'dest', 'aria-live': 'polite' }, 'Move to', h('strong', null, destLabel), same ? h('span', { class: 'muted' }, 'It is already here.') : null),
        h('p', { class: 'hint' }, `“${entry.name}” and what’s inside it aren’t listed, since it can’t be moved into itself.`),
        h('p', { class: 'form-error', id: 'move-err', role: 'alert' }));
      moveBtn.disabled = same;
    }

    moveBtn.addEventListener('click', async () => {
      moveBtn.disabled = cancel.disabled = true;
      const errEl = $('#move-err');
      if (errEl) errEl.textContent = '';
      try {
        await mutate('POST', `/api/entries/${enc(entry.id)}/move`, { parentId: at });
        const dest = destLabel;
        flash(entry.id);
        dlg.close();
        go(entryHref(entry.id));
        toast(`Moved “${entry.name}” to ${dest}.`);
      } catch (e) {
        cancel.disabled = false;
        moveBtn.disabled = false;
        if ($('#move-err')) $('#move-err').textContent = errMsg(e);
      }
    });
    draw();
  }

  // ---------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------
  async function startDelete(entry) {
    let info;
    try {
      info = await api('GET', `/api/entries/${enc(entry.id)}/subtree`);
    } catch (e) {
      toast(errMsg(e), { error: true });
      return;
    }
    const n = info.descendantCount;
    const body = n
      ? h('div', null,
          h('p', null, h('strong', null, entry.name), ` contains ${plural(n, 'entry', 'entries')} (counting every level inside it). Deleting it will also delete all of them.`),
          h('p', null, 'If you want to keep any of them, choose Cancel, move them somewhere else first, and then delete this entry.'))
      : h('p', null, 'This will permanently delete ', h('strong', null, entry.name), '. It can’t be undone.');

    confirmDialog({
      title: n ? 'Delete everything inside?' : 'Delete this entry?',
      body,
      confirmLabel: n ? 'Delete everything' : 'Delete',
      run: async (dlg) => {
        const p = await mutate('DELETE', `/api/entries/${enc(entry.id)}`);
        dlg.close();
        S.expanded.delete(entry.id);
        const count = p.deletedCount;
        go(entry.parentId && S.index.byId.has(entry.parentId) ? entryHref(entry.parentId) : '#/');
        toast(count > 1 ? `Deleted “${entry.name}” and ${plural(count - 1, 'entry', 'entries')} inside it.` : `Deleted “${entry.name}”.`);
      },
    });
  }

  // ---------------------------------------------------------------------
  // tags: rename / delete / filter
  // ---------------------------------------------------------------------
  function openRenameTag(tag) {
    const input = h('input', { class: 'input', id: 'rename-tag', type: 'text', maxlength: '40', autocomplete: 'off', value: tag.name });
    const err = h('p', { class: 'field-error', role: 'alert' });
    const form = h('form', { id: 'rename-form', novalidate: true },
      h('div', { class: 'field' }, h('label', { class: 'lbl', for: 'rename-tag' }, 'Tag name'), input, err),
      h('p', { class: 'hint' }, 'Renaming keeps the tag’s colour and everything it’s attached to.'));
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel');
    const save = h('button', { class: 'btn primary', type: 'submit', form: 'rename-form' }, 'Rename');
    const dlg = openSheet({ title: 'Rename tag', body: form, footer: [cancel, save], focus: input });
    input.select();
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      err.textContent = '';
      const name = input.value.trim();
      if (!name) { err.textContent = 'Enter a name for the tag.'; return; }
      save.disabled = cancel.disabled = true;
      try {
        await mutate('PATCH', `/api/tags/${enc(tag.id)}`, { name });
        dlg.close();
        render();
        toast(`Renamed to “${name}”.`);
      } catch (e) {
        save.disabled = cancel.disabled = false;
        err.textContent = errMsg(e);
      }
    });
  }

  async function startDeleteTag(tag) {
    let usage;
    try {
      usage = await api('GET', `/api/tags/${enc(tag.id)}/usage`);
    } catch (e) {
      toast(errMsg(e), { error: true });
      return;
    }
    const n = usage.entryCount;
    confirmDialog({
      title: 'Delete this tag?',
      body: h('div', null,
        h('p', null, n
          ? ['The tag ', h('strong', null, tag.name), ` will be removed from ${plural(n, 'entry', 'entries')}.`]
          : ['The tag ', h('strong', null, tag.name), ' isn’t attached to any entry.']),
        h('p', null, 'No entries are deleted. Anything that inherited this tag from an entry will stop matching it, unless another entry above it has the same tag.')),
      confirmLabel: 'Delete tag',
      run: async (dlg) => {
        await mutate('DELETE', `/api/tags/${enc(tag.id)}`);
        dlg.close();
        render();
        toast(`Deleted tag “${tag.name}”.`);
      },
    });
  }

  function openFilterSheet() {
    const idx = S.index;
    const selected = new Set(S.route.name === 'home' ? S.route.tags.filter((id) => idx.tagById.has(id)) : []);
    selected.onChange = () => applySearch($('#search').value, [...selected]);

    const clear = h('button', {
      class: 'btn', type: 'button',
      onclick: () => { selected.clear(); applySearch($('#search').value, []); closeAllSheets(); },
    }, 'Clear filters');
    const done = h('button', { class: 'btn primary', type: 'button', onclick: () => closeAllSheets() }, 'Done');

    openSheet({
      title: 'Filter by tag',
      body: [
        h('p', { class: 'muted' }, 'Show only entries that have any of the selected tags, either directly or inherited from something they’re inside.'),
        tagPicker(selected),
      ],
      footer: idx.tags.length ? [clear, done] : [done],
      focus: done,
    });
  }

  // ---------------------------------------------------------------------
  // routing and search wiring
  // ---------------------------------------------------------------------
  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const qi = raw.indexOf('?');
    const path = qi < 0 ? raw : raw.slice(0, qi);
    const params = new URLSearchParams(qi < 0 ? '' : raw.slice(qi + 1));
    const parts = path.split('/').filter(Boolean);
    try {
      if (parts[0] === 'entry' && parts[1]) return { name: 'entry', id: decodeURIComponent(parts[1]) };
    } catch (_) { /* bad escape: fall through to home */ }
    if (parts[0] === 'tags') return { name: 'tags' };
    if (parts[0] === 'data') return { name: 'data' };
    return { name: 'home', q: params.get('q') || '', tags: (params.get('tags') || '').split(',').filter(Boolean) };
  }

  function homeHash(q, tags) {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (tags.length) p.set('tags', tags.join(','));
    const s = p.toString();
    return '#/' + (s ? '?' + s : '');
  }

  /** Navigate. If the hash is unchanged, hashchange won't fire, so run the handler directly. */
  function go(hash) {
    const current = location.hash || '#/';
    if (current === hash || (hash === '#/' && (location.hash === '' || location.hash === '#'))) onRoute();
    else location.hash = hash;
  }

  function resetExpansion() {
    // Navigating somewhere new resets the tree: only the path to the destination stays open.
    S.expanded = new Set();
    if (S.index && S.route.name === 'entry' && S.index.byId.has(S.route.id)) {
      for (const e of S.index.pathTo(S.route.id)) S.expanded.add(e.id);
    }
  }

  function syncSearchInput() {
    const el = $('#search');
    const want = S.route.name === 'home' ? S.route.q : '';
    if (el.value !== want) el.value = want;
  }

  function onRoute() {
    const prev = S.route;
    S.route = parseHash();
    if (prev.name === 'data' && S.route.name !== 'data') importState = freshImport();
    syncSearchInput();
    resetExpansion();
    render();
    requestAnimationFrame(() => {
      const sel = document.querySelector('.row.selected');
      if (sel) sel.scrollIntoView({ block: WIDE.matches ? 'center' : 'start' });
      else window.scrollTo(0, 0);
    });
  }

  /** Update the search (stored in the URL so Back returns to the same results). */
  function applySearch(q, tags) {
    const hash = homeHash(q, tags);
    if (S.route.name === 'home') {
      history.replaceState(null, '', hash);
      S.route = parseHash();
      render();
    } else {
      location.hash = hash; // leaving an entry/screen counts as navigation
    }
  }

  function renderFilters() {
    const box = $('#active-filters');
    box.replaceChildren();
    const ids = S.route.name === 'home' ? S.route.tags.filter((id) => S.index.tagById.has(id)) : [];
    const count = $('#filter-count');
    count.hidden = !ids.length;
    count.textContent = String(ids.length);
    if (!ids.length) return;
    box.append(h('span', { class: 'lead' }, 'Tagged'));
    ids.forEach((id, i) => {
      const t = S.index.tagById.get(id);
      if (i) box.append(h('span', { class: 'lead' }, 'or'));
      box.append(h('button', {
        class: 'chip', type: 'button', 'aria-label': `Remove filter ${t.name}`,
        vars: { '--tag': t.color, '--tag-text': L.textColorFor(t.color) },
        onclick: () => applySearch($('#search').value, ids.filter((x) => x !== id)),
      }, t.name, h('span', { class: 'x', 'aria-hidden': 'true' }, '×')));
    });
  }

  // ---------------------------------------------------------------------
  // render
  // ---------------------------------------------------------------------
  function render() {
    if (!S.data) return;
    const route = S.route;
    document.body.dataset.view = route.name;
    document.querySelectorAll('[data-nav]').forEach((a) => {
      if (a.dataset.nav === route.name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    renderFilters();

    // Keep scroll position and any half-typed text in marked inputs across re-renders.
    const y = window.scrollY;
    const ae = document.activeElement;
    const keep = ae && ae.dataset && ae.dataset.keep && ae.id
      ? { id: ae.id, value: ae.value, start: ae.selectionStart, end: ae.selectionEnd } : null;

    let node;
    $('#sr-status').textContent = '';
    if (route.name === 'tags') node = renderTags();
    else if (route.name === 'data') node = renderData();
    else {
      const result = route.name === 'home' ? L.search(S.index, { query: route.q, tagIds: route.tags }) : null;
      node = result ? renderSearch(result) : renderBrowse();
    }
    $('#view').replaceChildren(node);

    const sel = route.name === 'entry' ? S.index.byId.get(route.id) : null;
    document.title = (sel ? sel.name + ' - ' : route.name === 'tags' ? 'Tags - ' : route.name === 'data' ? 'Import / Export - ' : '') + 'Home Inventory';

    window.scrollTo(0, y);
    if (keep) {
      const el = document.getElementById(keep.id);
      if (el) {
        el.value = keep.value;
        el.focus();
        try { el.setSelectionRange(keep.start, keep.end); } catch (_) { /* not supported */ }
      }
    }
  }

  // ---------------------------------------------------------------------
  // keeping devices in sync
  // ---------------------------------------------------------------------
  let pollFailures = 0;
  async function poll() {
    if (document.hidden || !S.data) return;
    try {
      const res = await fetch('/api/revision', { cache: 'no-store' });
      const { revision } = await res.json();
      pollFailures = 0;
      setOffline(false);
      if (revision !== S.data.revision) {
        applyState(await api('GET', '/api/state'));
        render();
      }
    } catch (_) {
      if (++pollFailures >= 2) setOffline(true);
    }
  }

  // ---------------------------------------------------------------------
  // start
  // ---------------------------------------------------------------------
  async function init() {
    S.route = parseHash();
    $('#view').append(h('div', { class: 'loading' }, 'Loading your inventory…'));

    const search = $('#search');
    search.addEventListener('input', () => applySearch(search.value, S.route.name === 'home' ? S.route.tags : []));
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') search.blur();
      if (e.key === 'Escape' && search.value) { search.value = ''; applySearch('', S.route.name === 'home' ? S.route.tags : []); }
    });
    $('#filter-btn').addEventListener('click', openFilterSheet);
    window.addEventListener('hashchange', onRoute);
    WIDE.addEventListener('change', () => render());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

    try {
      applyState(await api('GET', '/api/state'));
    } catch (e) {
      $('#view').replaceChildren(emptyState('Can’t load the inventory', errMsg(e),
        h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, 'Try again')));
      return;
    }
    resetExpansion();
    syncSearchInput();
    render();
    requestAnimationFrame(() => {
      const sel = document.querySelector('.row.selected');
      if (sel) sel.scrollIntoView({ block: WIDE.matches ? 'center' : 'start' });
    });
    setInterval(poll, 5000);
  }

  init();
})();
