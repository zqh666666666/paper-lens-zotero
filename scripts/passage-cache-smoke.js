// Zotero developer-console smoke check. Uses the active reader's native DOM,
// two fixture readers, a captured selection-popup listener and a memory-only IO adapter.
async function runPaperLensPassageCacheSmoke() {
  const {AddonManager} = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
  const addon = await AddonManager.getAddonByID('paper-lens@local.tools');
  if (!addon?.isActive) throw new Error('请先启用本轮构建的循文插件。');
  const main = Zotero.getMainWindow();
  const actualReader = Zotero.Reader.getByTabID(main.Zotero_Tabs.selectedID);
  if (!actualReader?._window?.document) throw new Error('请先打开一个 PDF 阅读标签。');
  const win = actualReader._window, doc = win.document, focused = doc.activeElement;
  const root = addon.getResourceURI().spec;
  const files = new Map(), listeners = new Map(), checks = [], errors = [];
  let writes = 0, apiAttempts = 0, keyAttempts = 0, noteAttempts = 0;
  const config = JSON.stringify({remember:true, scope:'selection'});
  const fakeZotero = {
    DataDirectory:{dir:'/paper-lens-smoke'}, Prefs:{get:()=>config},
    Items:{get:()=>({libraryID:1,key:'FIXTURECACHE',getField:()=> 'Fixture paper'})},
    Item:class { constructor(){noteAttempts++;throw new Error('Unexpected library write');} },
    Libraries:{userLibraryID:1}, getMainWindows:()=>[], debug(){},
    Notifier:{registerObserver:()=>1,unregisterObserver(){}},
    Reader:{
      registerEventListener:(type,fn)=>listeners.set(type,fn),
      unregisterEventListener:(type,fn)=>{if(listeners.get(type)===fn)listeners.delete(type);}
    }
  };
  const io = {
    async makeDirectory(){},
    async readJSON(path){
      if (files.has(path)) return JSON.parse(files.get(path));
      const missing = new Error('Missing fixture');missing.name='NotFoundError';throw missing;
    },
    async writeUTF8(path,contents){files.set(path,contents);writes++;}
  };
  const scope = {Zotero:fakeZotero, Services:{scriptloader:Services.scriptloader}, Components, IOUtils:io, PathUtils, URL, DOMParser,
    fetch:url=>{if(url!==root+'src/panel.css')throw new Error('Unexpected fetch');return win.fetch(url);}};
  scope.globalThis = scope;
  for (const name of ['retrieval','math','locations','pdf-text','passages','core','plugin']) {
    Services.scriptloader.loadSubScriptWithOptions(root+'src/'+name+'.js',{target:scope,ignoreCache:true});
  }
  const element = tag => doc.createElementNS('http://www.w3.org/1999/xhtml',tag);
  const mount = element('div');
  mount.style.cssText='position:fixed;left:-12000px;top:0;width:1000px;height:700px;display:flex;pointer-events:none;';
  doc.documentElement.append(mount);
  const check = (name,ok)=>checks.push({name,ok:!!ok});
  const nextTask = ()=>new Promise(resolve=>win.setTimeout(resolve,0));
  let probe;
  const startProbe = async () => {
    probe = new scope.PaperLensPlugin(root);
    probe.keyFor=async()=>{keyAttempts++;throw new Error('Unexpected credential access');};
    probe.request=async()=>{apiAttempts++;throw new Error('Unexpected model request');};
    probe.alert=message=>errors.push(String(message));
    await probe.start();
  };
  const makeReader = tabID => {
    const host=element('div'),anchor=element('div');host.append(anchor);mount.append(host);
    return {itemID:1,tabID,_window:win,_iframe:anchor,navigate:async()=>{}};
  };
  const popupHost = () => {
    const host=element('div');host.className='custom-sections';mount.append(host);return host;
  };
  const emitSelection = async (reader,selection,host=popupHost()) => {
    const callback = listeners.get('renderTextSelectionPopup');
    if (!callback) throw new Error('Selection-popup listener was not registered');
    callback({reader,doc,params:{annotation:selection},append:node=>host.append(node)});
    await Promise.all([...probe.selectionJobs]);
  };
  const clickEntry = async (panel,text,label) => {
    const row = Array.from(panel.passageList.children).find(node=>node.querySelector('.pl-cache-preview')?.textContent===text);
    const button = row && Array.from(row.querySelectorAll('button')).find(node=>node.textContent===label);
    if (!button) throw new Error('Missing passage button '+label);
    button.click();await nextTask();await Promise.all([...probe.writes.values()]);
  };
  try {
    await startProbe();
    const r1=makeReader('fixture-left'),r2=makeReader('fixture-right');
    const a={text:'测试段落 A',position:{pageIndex:1,rects:[[1,2,12,6]]}};
    const b={text:'测试段落 B',position:{pageIndex:4,rects:[[7,8,22,13]]}};
    const left=await probe.open(r1),right=await probe.open(r2);
    const session=left.session;
    check('two fixture readers share one loaded paper session',left.root.isConnected&&right.root.isConnected&&session===right.session);
    const firstPopup=popupHost();await emitSelection(r1,a,firstPopup);
    check('native selection hook fills the open panel without clicking an action',left.selection.value===a.text&&session.passages.length===1);
    const firstID=session.passages[0]?.id,writesAfterA=writes;
    await emitSelection(r1,a,firstPopup);
    check('rerender of the same popup skips duplicate persistence',writes===writesAfterA&&session.passages.length===1);
    await emitSelection(r1,b);
    check('a new selection keeps the prior passage and updates page',left.selection.value===b.text&&left.selected.pageIndex===4&&session.passages.length===2);
    await emitSelection(r2,a);
    check('two readers retain independent current selections',left.selected.text===b.text&&right.selected.text===a.text);
    check('reselecting a cached location reuses the entry',session.passages.length===2&&session.passages[0].id===firstID);
    left.passageCache.open=true;await nextTask();
    check('native passage list shows both cached pages',left.passageList.children.length===2&&left.passageSummary.textContent.includes('2'));
    await clickEntry(left,a.text,'恢复');
    check('restore button restores text, page and rectangles',left.selection.value===a.text&&left.selected.pageIndex===1&&left.selected.rects?.[0]?.[2]===12);
    await emitSelection(r2,b);
    await clickEntry(left,b.text,'删除');
    check('single deletion preserves the other entry and synchronizes both readers',session.passages.length===1&&session.passages[0].id===firstID&&left.selected.id===firstID&&right.selected.id===firstID);
    probe.disposePanel(r1,left);
    const reopened=await probe.open(r1);
    check('closing and reopening a panel restores the surviving passage',!left.root.isConnected&&reopened.root.isConnected&&reopened.selected.id===firstID);
    await probe.stop();
    await startProbe();
    const reloaded=await probe.open(makeReader('fixture-reloaded'));
    check('fresh plugin instance reloads cache from serialized fixture IO',files.size===1&&writes>0&&reloaded.session.passages.length===1&&reloaded.selected.id===firstID&&reloaded.selection.value===a.text);
    check('selection and cache actions do not call a model, credentials or notes',apiAttempts===0&&keyAttempts===0&&noteAttempts===0&&errors.length===0);
  } catch (error) {
    errors.push(String(error));check('probe completed',false);
  } finally {
    try {if(probe&&!probe.stopped)await probe.stop();}
    finally {mount.remove();try{focused?.focus();}catch{}}
  }
  return {version:addon.version,passed:checks.filter(check=>check.ok).length,total:checks.length,checks,errors,
    inMemoryWrites:writes,modelCallAttempts:apiAttempts,credentialAccessAttempts:keyAttempts,noteCreationAttempts:noteAttempts,realSessionFileWrites:0};
}
