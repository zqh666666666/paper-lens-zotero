// Run from Zotero's developer console after installing the current build.
// This isolated probe uses fixture readers, in-memory preferences/session saves,
// and a mock request. It never reads a real API key, contacts a model, writes a
// library item, or changes the user's reading session. The temporary DOM is
// removed in finally, even if a check fails.
async function runPaperLensReadingSmoke() {
  const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
  const addon=await AddonManager.getAddonByID('paper-lens@local.tools');
  if(!addon?.isActive)throw new Error('循文插件尚未启用。');
  const root=addon.getResourceURI().spec,win=Zotero.getMainWindow(),doc=win.document;
  const focused=doc.activeElement,checks=[];
  let preferences=JSON.stringify({model:'fixture-model',baseURL:'https://fixture.invalid',remember:false,scope:'selection'});
  const mockZotero={
    Prefs:{get:()=>preferences,set:(key,value)=>{if(key!=='paperLens.config')throw new Error('Unexpected preference');preferences=value;}},
    Items:{get:()=>({libraryID:1,key:'SMOKETEST',getField:()=> 'Disposable reading fixture'})},
    Libraries:{userLibraryID:1},Reader:{unregisterEventListener(){}},debug(){}
  };
  const scope={Zotero:mockZotero,Services,URL,Components,DOMParser,IOUtils:{},PathUtils};scope.globalThis=scope;
  for(const name of ['retrieval','math','locations','pdf-text','passages','core','research','commands','writeback','plugin','vendor/katex']) {
    Services.scriptloader.loadSubScriptWithOptions(root+'src/'+name+'.js',{target:scope,ignoreCache:true});
  }
  const probe=new scope.PaperLensPlugin(root);probe.math=scope.PaperLensKatex;
  probe.css=await (await win.fetch(root+'src/panel.css')).text();
  const mount=probe.el(doc,'div');mount.id='paper-lens-reading-smoke';
  mount.style.cssText='position:fixed;top:30px;left:3vw;width:94vw;height:85vh;display:flex;gap:8px;background:#eff3f8;z-index:2147483646;';
  doc.documentElement.append(mount);
  const frame=()=>new Promise(resolve=>win.requestAnimationFrame(()=>win.requestAnimationFrame(resolve)));
  const check=(name,ok,detail='')=>checks.push({name,ok:!!ok,...(detail?{detail}: {})});
  const session={selection:{text:'Original passage for this window.',pageIndex:2},pinned:null,marks:{},turns:Array.from({length:8},(_,i)=>({
    id:'smoke-'+i,time:1,model:'fixture',question:'本地显示样例 '+i,action:'explain',partial:false,
    answer:'这是一条用于验证滚动位置的本地显示样例。'.repeat(25),selection:{text:'Fixture passage '+i,pageIndex:0},sources:[],scope:'selection'
  }))};
  const readers=[],panels=[];let saved=0,requestCount=0,finishResponse;
  probe.persist=async()=>{saved++;};
  probe.keyFor=async()=> 'fixture-only-key';
  probe.alert=text=>{throw new Error(text);};
  try {
    for(let i=0;i<2;i++) {
      const host=probe.el(doc,'div');host.style.cssText='display:flex;min-width:0;flex:1;height:100%;';
      const anchor=probe.el(doc,'div');host.append(anchor);mount.append(host);
      const reader={itemID:1,_window:win,_iframe:anchor,navigate:async()=>{}};readers.push(reader);
      if(i===1)session.selection={text:'Another passage in the second window.',pageIndex:7};
      panels.push(probe.makePanel(reader,session));
    }
    const [first,second]=panels;await frame();
    check('two native panels mount',panels.every(p=>p.root.isConnected&&p.feed.clientHeight>0));
    check('window selection remains independent',first.selected.pageIndex===2&&second.selected.pageIndex===7);
    probe.setPanelWidth(first,460,true);probe.setReadingFont(first,17,true);probe.setSelectionCollapsed(first,true,true);await frame();
    const prefs=JSON.parse(preferences);
    check('layout settings persist only in fixture preferences',prefs.panelWidth===460&&prefs.fontSize===17&&prefs.selectionCollapsed===true);
    check('answer font changes in native layout',win.getComputedStyle(first.feed.querySelector('.pl-answer')).fontSize==='17px');
    check('selection collapses',first.selectionBody.hidden&&first.collapse.getAttribute('aria-expanded')==='false');
    probe.setSelectionCollapsed(first,false,false);
    first.selected.position={pageIndex:2,rects:[[1,2,3,4]]};first.selection.value='Corrected formula';
    first.selection.dispatchEvent(new win.Event('input',{bubbles:true}));probe.updateSessionViews(session);
    check('editing text keeps its window and discards stale position',first.selected.text==='Corrected formula'&&first.selected.pageIndex===2&&!first.selected.position&&second.selected.pageIndex===7);
    let started;
    const startedPromise=new Promise(resolve=>{started=resolve;});
    probe.request=(cfg,key,messages,onText,onAbort)=>new Promise((resolve,reject)=>{
      requestCount++;finishResponse=resolve;onAbort(()=>reject(new Error('已停止。')));
      onText('本地模拟生成中的回答。'.repeat(15));started();
    });
    const oldCard=first.turnViews.get('smoke-1').card;
    const running=probe.run(first,'explain');await startedPromise;await frame();
    const pending=session.turns.at(-1),pendingView=first.turnViews.get(pending.id);
    check('pending card hides actions',pending.pending===true&&pendingView.buttons.childElementCount===0);
    first.feed.scrollTop=120;await frame();const before=first.feed.scrollTop;
    finishResponse('本地模拟生成完成的回答。'.repeat(30));await running;await frame();
    check('completion preserves scroll position',Math.abs(first.feed.scrollTop-before)<2,`${before} -> ${first.feed.scrollTop}`);
    check('completion preserves existing card elements',first.turnViews.get('smoke-1').card===oldCard);
    check('other window receives completed history',second.turnViews.has(pending.id)&&second.selected.pageIndex===7);
    check('completion exposes actions and clears pending',!pending.pending&&pendingView.buttons.childElementCount>0);
    check('mock request and in-memory persistence used',requestCount===1&&saved>0);
    return {version:addon.version,passed:checks.filter(x=>x.ok).length,total:checks.length,checks,realApiCalls:0,sessionFileWrites:0};
  } finally {
    for(const [index,panel] of panels.entries())probe.disposePanel(readers[index],panel);
    mount.remove();try{focused?.focus();}catch{}
  }
}
