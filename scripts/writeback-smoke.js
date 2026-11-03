// Developer-console check. Requires an explicit synthetic fixture PDF and opt-in
// to create disposable Zotero records. Never attaches to an existing note.
async function runPaperLensWritebackSmoke({fixturePDF, createTemporaryItems = false, sourceRoot} = {}) {
  if (!createTemporaryItems || !fixturePDF || !/[\\/]sample\.pdf$/i.test(fixturePDF)) {
    throw new Error('请显式提供项目生成的 sample.pdf，并设置 createTemporaryItems:true。');
  }
  const bytes = await IOUtils.read(fixturePDF);
  const expectedText = 'Introduction: speed changes alter vibration signals.';
  if (bytes.length > 10000 || !new TextDecoder().decode(bytes).includes(expectedText)) {
    throw new Error('需要的是包含合成测试文本的两页 sample.pdf。');
  }
  const {AddonManager} = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
  const addon = await AddonManager.getAddonByID('paper-lens@local.tools');
  const root = sourceRoot || addon.getResourceURI().spec;
  const scope = {Zotero, Services, Components};
  scope.globalThis = scope;
  for (const file of ['locations','writeback']) Services.scriptloader.loadSubScriptWithOptions(
    root+'src/'+file+'.js',{target:scope,ignoreCache:true});
  const api = scope.PaperLensWriteback;
  const win = Zotero.getMainWindow(), doc = win.document;
  const oldTab = win.Zotero_Tabs.selectedID, checks = [];
  const until = async (test, message) => {
    for (let i = 0; i < 120; i++) {
      const ok = await test();
      if (ok) return ok;
      await Zotero.Promise.delay(100);
    }
    throw new Error(message);
  };
  const check = (name, value) => {
    checks.push({name,ok:!!value});
    if (!value) throw new Error(name);
  };
  let attachment, note, reader, host;
  try {
    attachment = await Zotero.Attachments.importFromFile({file:fixturePDF,libraryID:Zotero.Libraries.userLibraryID});
    note = new Zotero.Item('note');
    note.libraryID = Zotero.Libraries.userLibraryID;
    note.setNote('<p>before OLD after</p>');
    await note.saveTx();
    host = doc.createXULElement('note-editor');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:500px;height:300px';
    doc.documentElement.append(host);
    host.mode='edit';
    host.item=note;
    const instance = await until(()=>host.getCurrentInstance(), 'fixture editor failed to initialize');
    await instance._initPromise;
    const editorWin = instance._iframeWindow.wrappedJSObject;
    const view = editorWin._currentEditorInstance._editorCore.view;
    const fixtureReader = {_window:{ZoteroContextPane:{activeEditor:host}}};
    const select = (from, to) => {
      const state = view.state;
      view.dispatch(state.tr.setSelection(state.selection.constructor.create(state.doc,from,to)));
    };
    const start = view.state.doc.textContent.indexOf('OLD') + 1;
    select(start,start+3);
    const original = api.captureNote(fixtureReader,'replace');
    check('selected text is taken from the native editor',original.text==='OLD');
    api.applyNote(fixtureReader, original, 'NEW');
    check('replacement preserves surrounding text',view.state.doc.textContent==='before NEW after');
    editorWin.doUndo();
    check('Zotero native undo restores original',view.state.doc.textContent==='before OLD after');
    select(start,start);
    const cursor = api.captureNote(fixtureReader,'insert');
    api.applyNote(fixtureReader,cursor,'<b>X</b>\nY');
    const edited = editorWin.getDataSync(false)?.html ?? view.dom.innerHTML;
    check('multiline insert is inert text at the original caret',edited.includes('&lt;b&gt;X&lt;/b&gt;') && /<br\s*\/?>/i.test(edited));
    let refused = false;
    try {api.applyNote(fixtureReader,original,'STALE');} catch {refused=true;}
    check('stale rewrite cannot overwrite an edited note',refused && !view.state.doc.textContent.includes('STALE'));
    host.saveSync();
    await until(async()=>{
      const stored = await Zotero.DB.valueQueryAsync('SELECT note FROM itemNotes WHERE itemID=?', [note.id]);
      return stored?.includes('&lt;b&gt;X&lt;/b&gt;');
    },'native note save timed out');
    check('fixture note saved through the editor',true);

    reader = await Zotero.Reader.open(attachment.id);
    await reader._initPromise;
    await until(()=>reader._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfDocument?.numPages===2,
      'fixture PDF text layer timed out');
    const panel={reader,status:{}};
    const plugin={attachment:()=>attachment,persist:async()=>{}};
    const turn={answer:'Paper Lens synthetic annotation comment',selection:{text:expectedText,pageIndex:0}};
    await api.saveAnnotation(plugin,panel,turn);
    let items=attachment.getAnnotations();
    const record = items.find(item=>item.key===turn.pdfAnnotation?.key);
    check('Zotero saved a highlight child on the correct page',record?.parentID===attachment.id && record.annotationType==='highlight' &&
      record.annotationComment===turn.answer && JSON.parse(record.annotationPosition).pageIndex===0);
    await api.saveAnnotation(plugin,panel,turn);
    check('retry locates the existing annotation',attachment.getAnnotations().length===items.length);
    const imageTurn={answer:'Page image fixture',selection:{kind:'vision',pageIndex:1,text:'image'}};
    await api.saveAnnotation(plugin,panel,imageTurn);
    items=attachment.getAnnotations();
    const pageNote=items.find(item=>item.key===imageTurn.pdfAnnotation?.key);
    check('page image answer persists as a page note',pageNote?.annotationType==='note' && JSON.parse(pageNote.annotationPosition).pageIndex===1);
    return {checks};
  } finally {
    host?.remove();
    if (reader) reader.close();
    if (oldTab && win.Zotero_Tabs.selectedID!==oldTab && win.Zotero_Tabs._getTab(oldTab)?.tab) win.Zotero_Tabs.select(oldTab);
    if (note?.id) await note.eraseTx();
    if (attachment?.id) await attachment.eraseTx();
  }
}
