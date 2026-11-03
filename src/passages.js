/* Per-paper cache of selected passages, newest first. */
(function (root) {
  'use strict';

  const MAX_TEXT = 20000;
  const VERSION = 3;
  let nextID = 0;

  const pageOf = selection => selection.pageIndex ?? selection.position?.pageIndex ?? 0;
  const rectsOf = (selection, key) => selection[key] ?? selection.position?.[key] ?? [];
  const validRect = rect => Array.isArray(rect) && rect.length === 4 &&
    rect.every(Number.isFinite) && rect[2] >= rect[0] && rect[3] >= rect[1];

  function sameRects(first, second) {
    return Array.isArray(first) && Array.isArray(second) && first.length === second.length &&
      first.every((rect, i) => validRect(rect) && validRect(second[i]) &&
        rect.every((coordinate, j) => Math.abs(coordinate - second[i][j]) < 0.01));
  }

  function same(a, b) {
    if (!a || !b || pageOf(a) !== pageOf(b)) return false;
    const first = rectsOf(a, 'rects'), second = rectsOf(b, 'rects');
    const firstNext = rectsOf(a, 'nextPageRects'), secondNext = rectsOf(b, 'nextPageRects');
    if (first.length || second.length || firstNext.length || secondNext.length) {
      return sameRects(first, second) && sameRects(firstNext, secondNext);
    }
    return typeof a.text === 'string' && typeof b.text === 'string' && a.text.trim() === b.text.trim();
  }

  function find(session, selection) {
    return session.passages?.find(passage => same(passage, selection)) ?? null;
  }

  // Copy only the data needed to reopen this selection. Keep geometry detached
  // from the reader's annotation objects and from edits in other windows.
  function copySelection(selection) {
    if (!selection || typeof selection.text !== 'string') return null;
    const text = selection.text.trim();
    const pageIndex = pageOf(selection);
    if (!text || !Number.isSafeInteger(pageIndex) || pageIndex < 0) return null;
    const copy = {text, pageIndex};
    for (const key of ['rects', 'nextPageRects']) {
      const rects = rectsOf(selection, key);
      if (!Array.isArray(rects) || !rects.every(validRect)) return null;
      if (rects.length) copy[key] = rects.map(rect => [...rect]);
    }
    if (copy.rects && typeof selection.sourceText === 'string') {
      const sourceText = selection.sourceText.trim();
      if (sourceText && sourceText.length <= MAX_TEXT && sourceText !== text) copy.sourceText = sourceText;
    }
    return copy;
  }

  function add(session, selection) {
    const passages = session.passages ??= [];
    const index = passages.findIndex(passage => same(passage, selection));
    let id;
    if (index >= 0) {
      const previous = passages[index];
      id = previous.id;
      // Zotero returns the original glyph string each time the same area is
      // selected. Reuse the repair only while that original still matches.
      if (!selection.sourceText && previous.sourceText === selection.text) {
        selection = {...selection, text: previous.text, sourceText: previous.sourceText};
      }
      passages.splice(index, 1);
    } else {
      do {
        id = `p-${Date.now().toString(36)}-${(++nextID).toString(36)}`;
      } while (passages.some(passage => passage.id === id));
    }
    const entry = {id, ...selection};
    passages.unshift(entry);
    return entry;
  }

  function remember(session, selection) {
    const copy = copySelection(selection);
    if (!copy || copy.text.length > MAX_TEXT) return null;
    return add(session, copy);
  }

  function remove(session, id) {
    const index = session.passages?.findIndex(passage => passage.id === id) ?? -1;
    if (index < 0) return false;
    session.passages.splice(index, 1);
    return true;
  }

  function restore(saved) {
    if (saved.version > VERSION) throw new Error('Unsupported session version');
    if (Object.prototype.hasOwnProperty.call(saved, 'passages') || saved.version >= VERSION) {
      if (!Array.isArray(saved.passages)) throw new Error('Invalid passage cache');
      const ids = new Set();
      return saved.passages.map(entry => {
        const copy = copySelection(entry);
        if (!copy || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) {
          throw new Error('Invalid cached passage');
        }
        ids.add(entry.id);
        return {id: entry.id, ...copy};
      });
    }
    const migrated = {passages: []};
    // An existing draft may exceed the new-entry limit. Preserve its full text
    // on migration. An explicitly saved empty cache is handled above.
    for (const legacy of [saved.pinned, saved.selection]) {
      const passage = copySelection(legacy);
      if (passage) add(migrated, passage);
    }
    return migrated.passages;
  }

  const api = {MAX_TEXT, VERSION, same, find, remember, remove, restore};
  root.PaperLensPassages = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
