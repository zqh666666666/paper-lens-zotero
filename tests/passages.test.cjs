const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Passages = require('../src/passages.js');
const Core = require('../src/core.js');

test('one PDF location retains its ID when its extracted text is corrected and selected again', () => {
  const session = {};
  const source = {pageIndex: 2, text: '10 4', rects: [[2, 5, 25, 15]], apiKey: 'irrelevant'};
  const first = Passages.remember(session, source);
  const other = Passages.remember(session, {pageIndex: 3, text: source.text});
  const corrected = Passages.remember(session, {...source, text: '10^{−4}', sourceText: source.text});
  assert.equal(corrected.id, first.id);
  assert.deepEqual(session.passages.map(entry => entry.id), [first.id, other.id]);
  assert.equal(Passages.find(session, source).text, '10^{−4}');
  const reopened = {passages: Passages.restore(JSON.parse(JSON.stringify({version: 3, passages: session.passages})))};
  const selectedAgain = Passages.remember(reopened, source);
  assert.equal(selectedAgain.text, '10^{−4}');
  assert.equal(selectedAgain.sourceText, source.text);
  assert.equal(selectedAgain.id, first.id);
  const changed = Passages.remember(reopened, {...source, text: '10 5'});
  assert.equal(changed.text, '10 5');
  assert.equal(changed.id, first.id);
  assert.ok(!('sourceText' in changed));
  const manual = Passages.remember(reopened, {text: 'manually corrected', pageIndex: 2, sourceText: source.text});
  assert.ok(!('sourceText' in manual));
  source.rects[0][0] = 12;
  assert.equal(corrected.rects[0][0], 2);
  assert.ok(!('apiKey' in corrected));
});

test('separate locations on either page and a manually entered copy remain distinct', () => {
  const session = {};
  const text = 'A repeated line.';
  const a = {text, pageIndex: 5, rects: [[1, 2, 8, 4]]};
  const b = {...a, rects: [[10, 10, 30, 15]]};
  const cross = {...a, nextPageRects: [[1, 20, 10, 25]]};
  const manual = {text, pageIndex: 5};
  for (const selection of [a, b, cross, manual]) Passages.remember(session, selection);
  assert.equal(session.passages.length, 4);
  assert.equal(Passages.find(session, {text, position: {pageIndex: 5, rects: a.rects}}).id, session.passages[3].id);
  assert.equal(Passages.remember(session, {...manual, id: 'unrelated'}).id, session.passages[0].id);
  assert.equal(session.passages.length, 4);
});

test('new selections have a text limit and existing cached passages are never evicted', () => {
  const session = {passages: []};
  const original = Passages.remember(session, {text: 'x'.repeat(Passages.MAX_TEXT), pageIndex: 0});
  for (let i = 1; i <= 50; i++) Passages.remember(session, {text: String(i), pageIndex: i});
  assert.equal(Passages.remember(session, {text: 'x'.repeat(Passages.MAX_TEXT + 1), pageIndex: 0}), null);
  assert.equal(Passages.remember(session, {text: '  ', pageIndex: 1}), null);
  assert.equal(session.passages.length, 51);
  assert.equal(session.passages.at(-1).id, original.id);
});

test('legacy migration preserves pinned and current passages, including already saved long drafts', () => {
  const draft = 'x'.repeat(Passages.MAX_TEXT + 1);
  const saved = {version: 2, pinned: {text: 'pin', position: {pageIndex: 2, rects: [[1, 2, 3, 4]]}}, selection: {text: draft, pageIndex: 3}};
  const passages = Passages.restore(saved);
  assert.equal(passages[0].text, draft);
  assert.deepEqual(passages[1].rects, [[1, 2, 3, 4]]);
  assert.equal(passages[1].pageIndex, 2);
  assert.deepEqual(Passages.restore({...saved, passages: []}), []);
  assert.throws(() => Passages.restore({version: 3}), /cache/);
  assert.throws(() => Passages.restore({version: 99, passages: []}), /version/);
});

function createPlugin(read, write, config = () => ({remember: true})) {
  const context = {PaperLensCore: Core, PaperLensPassages: Passages, PathUtils: {join: (...parts) => parts.join('/')},
    Zotero: {Items: {get: () => ({libraryID: 1, key: 'ATTACH'})}, Libraries: {userLibraryID: 1}},
    IOUtils: {readJSON: read, writeUTF8: write}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('src/plugin.js', 'utf8'), context);
  const plugin = vm.runInContext('new PaperLensPlugin("")', context);
  plugin.storage = '/fixture';
  plugin.config = config;
  return plugin;
}

test('removing the last migrated passage persists an empty cache even when the old selection remains', async () => {
  const reader = {itemID: 1};
  let file = {version: 2, selection: {pageIndex: 7, text: 'legacy paragraph'}, turns: []};
  const open = () => createPlugin(async () => structuredClone(file), async (_, snapshot) => { file = JSON.parse(snapshot); });
  const first = open();
  const session = await first.session(reader);
  assert.equal(session.selection.id, session.passages[0].id);
  assert.ok(Passages.remove(session, session.passages[0].id));
  assert.equal(Passages.remove(session, 'missing'), false);
  await first.persist(reader);
  assert.equal(file.version, Passages.VERSION);
  assert.deepEqual(file.passages, []);
  const reopened = await open().session(reader);
  assert.equal(reopened.passages.length, 0);
  assert.equal(reopened.selection.text, 'legacy paragraph');
  assert.ok(!reopened.selection.id);
});

test('explicit and queued saves respect the current local-saving preference', async () => {
  let remember = true, writes = 0, release;
  const plugin = createPlugin(async () => ({version: 2, turns: []}), async () => { writes++; }, () => ({remember}));
  const reader = {itemID: 1};
  const session = await plugin.session(reader);
  Passages.remember(session, {text: 'memory only', pageIndex: 3});
  plugin.writes.set('1-ATTACH', new Promise(resolve => { release = resolve; }));
  const queued = plugin.persist(reader);
  remember = false;
  release();
  await queued;
  await plugin.persist(reader, true);
  assert.equal(writes, 0);
  assert.equal(session.passages.length, 1);
  session.passages = [];
  await plugin.persist(reader, true);
  assert.equal(writes, 1, 'an explicitly confirmed clear also erases the previous on-disk cache');
});

test('JSON retains both pages of coordinates and Markdown exports full cached text without requiring an answer', async () => {
  const plugin = createPlugin(async () => ({turns: []}), async () => {});
  const reader = {itemID: 1};
  const session = await plugin.session(reader);
  const entry = Passages.remember(session, {text: 'line one\nline two', pageIndex: 5, rects: [[1, 2, 3, 4]], nextPageRects: [[5, 6, 7, 8]]});
  const json = JSON.parse(plugin.exportData({reader, session}, 'json'));
  assert.equal(json.version, Passages.VERSION);
  assert.deepEqual(json.passages, [entry]);
  const markdown = plugin.exportData({reader, session}, 'md');
  assert.ok(markdown.includes('PDF 第 6–7 页'));
  assert.ok(markdown.includes('page=6'));
  assert.ok(markdown.includes('> line one\n> line two'));
});

test('an invalid cache is protected by the existing unreadable-session guard', async () => {
  const plugin = createPlugin(async () => ({version: 3, passages: [{id: 'same', text: 3, pageIndex: 1}], turns: []}),
    async () => assert.fail('must not overwrite a damaged file'));
  const reader = {itemID: 1};
  const session = await plugin.session(reader);
  assert.ok(session.loadWarning);
  await assert.rejects(plugin.persist(reader), /本地会话/);
});
