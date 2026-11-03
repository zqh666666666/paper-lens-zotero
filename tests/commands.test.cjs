const {test} = require('node:test');
const assert = require('node:assert/strict');
const Commands = require('../src/commands.js');
const fs = require('node:fs');
const vm = require('node:vm');

const draft = {name:'实验局限', prompt:'逐条列出实验局限并引用依据。', scope:'range', range:'2 至 4'};
function preferences(initial) {
  const data = new Map([['paperLens.commands', initial], ['paperLens.config', 'independent']]);
  return {get:key => data.get(key), set:(key, value) => data.set(key, value)};
}
function reader(current = 3, count = 6) {
  const view = number => ({_iframeWindow:{PDFViewerApplication:{pdfDocument:{numPages:count}, pdfViewer:{currentPageNumber:number}}}});
  return {_internalReader:{_lastViewPrimary:false, _primaryView:view(1), _secondaryView:view(current)}};
}
function adapter(open = reader()) {
  const pages = [], panel = {reader:open, status:{}, busy:false};
  const plugin = {
    pages:async (reader, progress, cancelled, index) => { pages.push(index); return [{pageIndex:index, text:'页' + (index + 1)}]; },
    run:(p, action, prompt, options) => ({action, prompt, options})
  };
  const state = {cfg:{contextChars:4000}, cancelled:() => false, progress:() => {}};
  return {pages, panel, plugin, state};
}

test('saved commands survive reload, preserve other settings, and reject stale edits', () => {
  const prefs = preferences();
  Commands.update(prefs, null, draft);
  const [saved] = Commands.read(prefs);
  assert.equal(saved.range, '2–4');
  Commands.update(prefs, null, {...draft, name:'翻译', scope:'selection'});
  Commands.update(prefs, saved, {...saved, name:'实验条件', range:'1'});
  const [changed, unrelated] = Commands.read(prefs);
  assert.equal(changed.id, saved.id);
  assert.equal(unrelated.name, '翻译');
  assert.ok(!('range' in unrelated));
  assert.throws(() => Commands.update(prefs, saved, null), /另一个窗口/);
  Commands.update(prefs, changed, null);
  assert.deepEqual(Commands.read(prefs), [unrelated]);
  assert.equal(prefs.get('paperLens.config'), 'independent');
});

test('bad ranges, duplicate names, and corrupt preferences do not destroy saved commands', () => {
  const prefs = preferences();
  Commands.update(prefs, null, draft);
  const raw = prefs.get('paperLens.commands');
  for (const range of ['0', '4-2', '1-2-3', '2.5', '']) {
    assert.throws(() => Commands.update(prefs, null, {...draft, name:'第二条', range}), /页码/);
  }
  assert.throws(() => Commands.update(prefs, null, draft), /同名/);
  assert.equal(prefs.get('paperLens.commands'), raw);
  prefs.set('paperLens.commands', '{not-json');
  assert.throws(() => Commands.update(prefs, null, draft), /配置无法读取/);
  assert.equal(prefs.get('paperLens.commands'), '{not-json');
});

test('current page captures the active split before page navigation and requests full text', async () => {
  const {pages, plugin, panel, state} = adapter();
  const call = Commands.execute(plugin, panel, {...draft, scope:'page'});
  panel.reader._internalReader._secondaryView._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber = 5;
  const result = await call.options.prepareContext(state);
  assert.deepEqual(pages, [2]);
  assert.equal(call.action, 'custom'); assert.equal(call.prompt, draft.prompt);
  assert.equal(result.selection.kind, 'document'); assert.equal(result.selection.pageIndex, 2);
  assert.equal(result.sources[0].id, 'P3-1'); assert.equal(result.sources[0].text, '页3');
  assert.equal(result.requireComplete, true);
});

test('ranges read exact inclusive PDF pages, full reads all pages, and selection keeps normal PDF verification', async () => {
  const {pages, plugin, panel, state} = adapter();
  const range = await Commands.execute(plugin, panel, draft).options.prepareContext(state);
  assert.deepEqual(pages, [1, 2, 3]);
  assert.deepEqual(range.sources.map(row => row.id), ['P2-1', 'P3-1', 'P4-1']);
  pages.length = 0;
  const full = await Commands.execute(plugin, panel, {...draft, scope:'full'}).options.prepareContext(state);
  assert.deepEqual(pages, [0, 1, 2, 3, 4, 5]); assert.match(full.selection.text, /全文文字层/);
  assert.throws(() => Commands.execute(plugin, panel, {...draft, range:'6–7'}), /超出/);
  const selected = Commands.execute(plugin, panel, {...draft, scope:'selection'});
  assert.equal(selected.options.scope, 'selection');
  assert.equal(selected.options.prepareContext, undefined);
  assert.deepEqual(selected.options.history, []); assert.equal(selected.options.pinned, null);
});

test('over-budget or cancelled commands halt extraction without a partial context', async () => {
  const {pages, plugin, panel, state} = adapter();
  const read = Commands.execute(plugin, panel, {...draft, scope:'full'}).options.prepareContext;
  await assert.rejects(read({...state, cfg:{contextChars:draft.prompt.length + 3}}), /超过总输入/);
  assert.deepEqual(pages, [0, 1]); pages.length = 0;
  await assert.rejects(read({...state, cancelled:() => pages.length === 1}), /已停止/);
  assert.deepEqual(pages, [0]);
  plugin.pages = async () => [{pageIndex:0, text:' '}];
  await assert.rejects(read(state), /OCR/);
});

test('manager buttons create, run, edit and delete a command using persisted preferences', () => {
  const prefs = preferences(), calls = [];
  const sandbox = {Zotero:{Prefs:prefs}, Services:{prompt:{confirm:() => true}}};
  vm.createContext(sandbox); vm.runInContext(fs.readFileSync('src/commands.js', 'utf8'), sandbox);
  function element(tag, label = '') {
    return {tag, label, children:[], listeners:{}, value:'',
      append(...nodes) { for (const node of nodes) { this.children.push(node); node.parent = this; } },
      replaceChildren() { this.children = []; }, remove() { this.parent.children = this.parent.children.filter(el => el !== this); },
      addEventListener(name, fn) { this.listeners[name] = fn; }, setAttribute() {}};
  }
  const plugin = {
    el:(doc, tag, cls, label) => element(tag, label),
    button:(doc, label, click) => Object.assign(element('button', label), {click}),
    select:(doc, choices, value, label) => Object.assign(element('select', label), {value}),
    panels:new Map(), run:(p, action, prompt, options) => calls.push({action, prompt, options})
  };
  const p = {root:element('aside'), doc:{}, reader:reader(), status:{}};
  plugin.panels.set(p.reader, p);
  const host = element('section'); p.root.append(host);
  function all(node) { return [node, ...node.children.flatMap(all)]; }
  const button = label => all(p.root).find(n => n.tag === 'button' && n.label === label);
  const editor = () => p.root.children.at(-1);
  const control = label => all(editor()).find(n => n.label === label);
  const open = () => button('管理指令').click();
  const pick = name => {
    const picker = control('选择要编辑的指令');
    picker.value = Commands.read(prefs).find(entry => entry.name === name).id;
    picker.listeners.change();
  };
  sandbox.PaperLensCommands.mount(plugin, p, host);
  open();
  all(editor()).find(n => n.tag === 'input').value = '分析';
  all(editor()).find(n => n.tag === 'textarea').value = '列出关键假设。';
  button('保存指令').click();
  button('分析').click(); assert.equal(calls[0].prompt, '列出关键假设。');
  open(); pick('分析');
  all(editor()).find(n => n.tag === 'input').value = '关键假设';
  button('保存指令').click();
  assert.equal(button('分析'), undefined); assert.ok(button('关键假设'));
  open(); pick('关键假设'); button('删除指令').click();
  assert.equal(button('关键假设'), undefined); assert.deepEqual(Commands.read(prefs), []);
});
