// Run in Zotero's developer console with a PDF open. Commands and turns live
// in memory. The active PDF supplies real page text, but requests stay local.
async function runPaperLensCommandsSmoke(rootURI) {
  const {AddonManager} = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
  const addon = await AddonManager.getAddonByID('paper-lens@local.tools');
  const root = rootURI || addon.getResourceURI().spec;
  const main = Zotero.getMainWindow();
  const actual = Zotero.Reader.getByTabID(main.Zotero_Tabs.selectedID);
  if (!actual?._internalReader?._primaryView) throw new Error('请打开已加载的 PDF 标签后重试。');
  const win = actual._window, doc = win.document, focused = doc.activeElement;
  const entries = new Map(), checks = [], errors = [], captures = [];
  const prefs = {get:key => entries.get(key), set:(key, value) => entries.set(key, value)};
  const scope = {
    Zotero:{Prefs:prefs, Items:{get:id => Zotero.Items.get(id)}, debug() {}},
    Services:{prompt:{confirm:() => true}}, Components, IOUtils:{stat:path => IOUtils.stat(path)}, PathUtils, URL,
    // Only the command UI is under test. Other sections are covered by their own probes.
    PaperLensResearch:{mount() {}}, PaperLensWriteback:{mount() {}, addActions() {}}
  };
  scope.globalThis = scope;
  for (const name of ['retrieval','math','locations','pdf-text','passages','core','commands','plugin']) {
    Services.scriptloader.loadSubScriptWithOptions(root + 'src/' + name + '.js', {target:scope, ignoreCache:true});
  }
  const plugin = new scope.PaperLensPlugin(root);
  plugin.css = '';
  plugin.config = () => ({...scope.PaperLensCore.DEFAULTS, model:'memory-only', contextChars:160000, remember:false});
  plugin.keyFor = async () => 'unused-fixture';
  plugin.request = async (_cfg, _key, messages) => {
    captures.push(messages.at(-1).content); return '本地模拟回答';
  };
  plugin.alert = msg => errors.push(String(msg));
  const el = tag => doc.createElementNS('http://www.w3.org/1999/xhtml', tag);
  const host = el('div'), anchor = el('div');
  host.style.cssText = 'position:fixed;left:-12000px;top:0;width:900px;height:700px;';
  host.append(anchor); doc.documentElement.append(host);
  const reader = {itemID:actual.itemID, _window:win, _internalReader:actual._internalReader, _iframe:anchor};
  const next = () => new Promise(resolve => win.setTimeout(resolve, 0));
  const check = (name, ok) => checks.push({name, ok:!!ok});
  const find = (box, selector, text) => [...box.querySelectorAll(selector)].find(node => node.textContent === text);
  const click = async (box, text) => {
    const button = find(box, 'button', text);
    if (!button) throw new Error('未找到按钮「' + text + '」。');
    button.click(); await next(); await Promise.all([...plugin.runs]);
  };
  const change = (node, value) => { node.value = value; node.dispatchEvent(new win.Event('change', {bubbles:true})); };
  const session = {selection:null, passages:[], turns:[], marks:{}, pinned:null};
  let panel;
  try {
    panel = plugin.makePanel(reader, session);
    const toolbox = panel.root.querySelector('.pl-toolbox'); toolbox.open = true;
    await click(panel.root, '管理指令');
    let manager = panel.root.querySelector('.pl-command-editor');
    manager.querySelector('input').value = '本页要点';
    manager.querySelector('textarea').value = '概括测试页并引用原文。';
    change(manager.querySelector('select[aria-label="携带的原文"]'), 'page');
    await click(manager, '保存指令');
    check('native editor saves current-page command in isolated preferences',
      scope.PaperLensCommands.read(prefs)[0]?.scope === 'page' && !panel.root.querySelector('.pl-command-editor'));
    await click(panel.root, '本页要点');
    const turn = session.turns.at(-1), internal = actual._internalReader;
    const active = internal._lastViewPrimary === false ? internal._secondaryView : internal._primaryView;
    const current = active._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber;
    const first = turn?.sources[0];
    check('button runs from empty selection with real current-page text and citation',
      turn?.action === 'custom' && turn.selection.kind === 'document' && first?.id === 'P' + current + '-1' &&
      first.text.trim() && captures.length === 1 && captures[0].includes(JSON.stringify(first.text)));
    check('original command is preserved next to its display name',
      turn?.label === '本页要点' && turn?.question === '概括测试页并引用原文。' && panel.selected == null);
    await click(panel.root, '管理指令');
    manager = panel.root.querySelector('.pl-command-editor');
    const saved = scope.PaperLensCommands.read(prefs)[0];
    change(manager.querySelector('select[aria-label="选择要编辑的指令"]'), saved.id);
    manager.querySelector('input').value = '页段要点';
    change(manager.querySelector('select[aria-label="携带的原文"]'), 'range');
    manager.querySelectorAll('input')[1].value = '1';
    await click(manager, '保存指令');
    plugin.disposePanel(reader, panel);
    panel = plugin.makePanel(reader, session);
    await click(panel.root, '页段要点');
    const edited = session.turns.at(-1);
    check('edited range command survives panel reopen and reads only PDF page 1',
      captures.length === 2 && edited?.label === '页段要点' && edited.sources.length === 1 && edited.sources[0].id === 'P1-1');
    await click(panel.root, '管理指令');
    manager = panel.root.querySelector('.pl-command-editor');
    change(manager.querySelector('select[aria-label="选择要编辑的指令"]'), saved.id);
    await click(manager, '删除指令');
    check('deleting the saved command removes its button and retains earlier turns',
      !find(panel.root, 'button', '页段要点') && scope.PaperLensCommands.read(prefs).length === 0 && session.turns.length === 2);
    check('only command preferences were written in memory', entries.size === 1 && entries.has('paperLens.commands') && !errors.length);
  } catch (err) { errors.push(String(err)); check('probe completed', false); }
  finally {
    // The adapter was never started; remove just the isolated test panel.
    if (panel && !panel.disposed) plugin.disposePanel(reader, panel);
    host.remove(); try { focused?.focus(); } catch {}
  }
  return {passed:checks.filter(c => c.ok).length, total:checks.length, checks, errors,
    interceptedModelCalls:captures.length, realModelCalls:0, realPreferenceWrites:0};
}
