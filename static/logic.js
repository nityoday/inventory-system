/*
 * Home Inventory - pure logic (no DOM). Works in the browser and in Node tests.
 *
 * Effective tags are NEVER stored on entries. They are derived from the
 * hierarchy every time the data changes, so they cannot drift out of sync.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InvLogic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Case-insensitive, accent-aware, and "Drawer 2" sorts before "Drawer 10".
  const collator = new Intl.Collator(undefined, { sensitivity: 'accent', numeric: true });

  function compareEntries(a, b) {
    return (
      collator.compare(a.name, b.name) ||
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  }

  function compareTags(a, b) {
    return collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1);
  }

  /**
   * Build all lookups from a state snapshot {entries, tags}.
   * Every traversal here is iterative, so deep nesting cannot overflow the stack.
   */
  function buildIndex(state) {
    const tags = state.tags.slice().sort(compareTags);
    const tagById = new Map(tags.map((t) => [t.id, t]));
    const byId = new Map();
    for (const e of state.entries) byId.set(e.id, e);

    const kidsByParent = new Map(); // parentId | null -> entries
    for (const e of state.entries) {
      const key = e.parentId && byId.has(e.parentId) ? e.parentId : null;
      let list = kidsByParent.get(key);
      if (!list) kidsByParent.set(key, (list = []));
      list.push(e);
    }
    for (const list of kidsByParent.values()) list.sort(compareEntries);
    const EMPTY_LIST = Object.freeze([]);

    // Top-down pass: for each entry, Map(tagId -> nearest ancestor entry id that has it directly).
    const inheritedMap = new Map();
    const EMPTY_MAP = new Map();
    const order = []; // parents always before children
    const stack = [];
    for (const r of kidsByParent.get(null) || []) {
      inheritedMap.set(r.id, EMPTY_MAP);
      stack.push(r);
    }
    while (stack.length) {
      const e = stack.pop();
      order.push(e);
      const kids = kidsByParent.get(e.id);
      if (!kids) continue;
      let childInherited = inheritedMap.get(e.id);
      const own = e.tagIds.filter((id) => tagById.has(id));
      if (own.length) {
        childInherited = new Map(childInherited);
        for (const id of own) childInherited.set(id, e.id);
      }
      for (const k of kids) {
        inheritedMap.set(k.id, childInherited);
        stack.push(k);
      }
    }

    // Bottom-up pass: number of descendants.
    const descCounts = new Map();
    for (let i = order.length - 1; i >= 0; i--) {
      const e = order[i];
      let n = 0;
      for (const k of kidsByParent.get(e.id) || []) n += 1 + descCounts.get(k.id);
      descCounts.set(e.id, n);
    }

    const index = {
      entries: state.entries,
      tags,
      tagById,
      byId,
      get roots() {
        return kidsByParent.get(null) || EMPTY_LIST;
      },
      childrenOf(id) {
        return kidsByParent.get(id == null ? null : id) || EMPTY_LIST;
      },
      descendantCount(id) {
        return descCounts.get(id) || 0;
      },
      /** Entries from the top down to (and including) `id`. */
      pathTo(id) {
        const path = [];
        const seen = new Set();
        let cur = byId.get(id);
        while (cur && !seen.has(cur.id)) {
          seen.add(cur.id);
          path.push(cur);
          cur = cur.parentId ? byId.get(cur.parentId) : null;
        }
        return path.reverse();
      },
      /** True if `id` is `ancestorId` or lives somewhere inside it. */
      isInside(id, ancestorId) {
        const seen = new Set();
        let cur = byId.get(id);
        while (cur && !seen.has(cur.id)) {
          if (cur.id === ancestorId) return true;
          seen.add(cur.id);
          cur = cur.parentId ? byId.get(cur.parentId) : null;
        }
        return false;
      },
      /**
       * direct:    tags assigned to the entry itself
       * inherited: tags that only come from an ancestor, with the nearest ancestor that holds them
       */
      effectiveTags(id) {
        const e = byId.get(id);
        if (!e) return { direct: [], inherited: [] };
        const directIds = new Set(e.tagIds);
        const direct = [];
        for (const tid of e.tagIds) if (tagById.has(tid)) direct.push(tagById.get(tid));
        direct.sort(compareTags);
        const inherited = [];
        for (const [tid, fromId] of inheritedMap.get(id) || EMPTY_MAP) {
          if (directIds.has(tid)) continue; // a direct assignment wins
          inherited.push({ tag: tagById.get(tid), from: byId.get(fromId) });
        }
        inherited.sort((a, b) => compareTags(a.tag, b.tag));
        return { direct, inherited };
      },
      /** Tags a NEW child of `parentId` would inherit (parent's own + parent's inherited). */
      tagsInheritedByChildOf(parentId) {
        if (!parentId || !byId.has(parentId)) return [];
        const p = byId.get(parentId);
        const eff = index.effectiveTags(parentId);
        const out = eff.direct.map((tag) => ({ tag, from: p }));
        return out.concat(eff.inherited).sort((a, b) => compareTags(a.tag, b.tag));
      },
      tagUseCounts() {
        const counts = new Map();
        for (const e of state.entries) for (const t of e.tagIds) counts.set(t, (counts.get(t) || 0) + 1);
        return counts;
      },
    };
    return index;
  }

  function parseQuery(query) {
    return (query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  /**
   * Search the whole inventory.
   *   - text: every word must appear in the name, description, or an effective tag name
   *   - tag filter: entry must have ANY selected tag (directly or inherited)
   *   - both given: both must hold
   * Returns null when there is nothing to search for, otherwise
   *   { terms, matches: Map(id -> reason), visible: Set(id), count }
   * where `visible` = matches plus their ancestors (shown as context).
   */
  function search(index, { query, tagIds }) {
    const terms = parseQuery(query);
    const filter = new Set((tagIds || []).filter((id) => index.tagById.has(id)));
    if (!terms.length && !filter.size) return null;

    const matches = new Map();
    for (const e of index.entries) {
      const eff = index.effectiveTags(e.id);
      const nameL = e.name.toLowerCase();
      const descL = e.description.toLowerCase();

      const tagRows = eff.direct
        .map((tag) => ({ tag, from: null }))
        .concat(eff.inherited.map((x) => ({ tag: x.tag, from: x.from })));

      if (terms.length) {
        const ok = terms.every(
          (t) => nameL.includes(t) || descL.includes(t) || tagRows.some((r) => r.tag.name.toLowerCase().includes(t))
        );
        if (!ok) continue;
      }
      if (filter.size && !tagRows.some((r) => filter.has(r.tag.id))) continue;

      const hitTags = tagRows.filter(
        (r) => filter.has(r.tag.id) || terms.some((t) => r.tag.name.toLowerCase().includes(t))
      );
      // Show where in the description the text matched (only when it did).
      let snippet = null;
      const pos = terms.map((t) => descL.indexOf(t)).filter((p) => p >= 0);
      if (pos.length) snippet = makeSnippet(e.description, Math.min(...pos));
      matches.set(e.id, { tags: hitTags, snippet });
    }

    const visible = new Set(matches.keys());
    for (const id of matches.keys()) {
      let cur = index.byId.get(id);
      while (cur && cur.parentId && !visible.has(cur.parentId)) {
        visible.add(cur.parentId);
        cur = index.byId.get(cur.parentId);
      }
    }
    return { terms, matches, visible, count: matches.size };
  }

  function makeSnippet(text, pos) {
    const clean = text.replace(/\s+/g, ' ');
    const start = Math.max(0, Math.min(pos, clean.length) - 30);
    const end = Math.min(clean.length, start + 90);
    return (start > 0 ? '…' : '') + clean.slice(start, end) + (end < clean.length ? '…' : '');
  }

  /** Split text into [{text, hit}] so the UI can wrap hits in <mark>. */
  function highlightParts(text, terms) {
    if (!terms || !terms.length) return [{ text, hit: false }];
    const lower = text.toLowerCase();
    if (lower.length !== text.length) return [{ text, hit: false }]; // odd Unicode: skip highlighting
    const marks = new Array(text.length).fill(false);
    for (const t of terms) {
      let from = 0;
      for (;;) {
        const i = lower.indexOf(t, from);
        if (i < 0) break;
        for (let k = i; k < i + t.length; k++) marks[k] = true;
        from = i + Math.max(1, t.length);
      }
    }
    const parts = [];
    let start = 0;
    for (let i = 1; i <= text.length; i++) {
      if (i === text.length || marks[i] !== marks[start]) {
        parts.push({ text: text.slice(start, i), hit: marks[start] });
        start = i;
      }
    }
    return parts.length ? parts : [{ text, hit: false }];
  }

  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  /** White or near-black, whichever reads better on the tag colour. */
  function textColorFor(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return '#ffffff';
    const L = luminance(hex);
    const white = 1.05 / (L + 0.05);
    const dark = (L + 0.05) / (luminance('#111827') + 0.05);
    return white >= dark ? '#ffffff' : '#111827';
  }

  return { buildIndex, search, parseQuery, highlightParts, textColorFor, compareEntries, compareTags };
});
