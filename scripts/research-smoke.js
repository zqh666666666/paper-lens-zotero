// Run in Zotero's developer console. No external requests; fixturePDF explicitly opts into
// importing and then erasing one disposable attachment to exercise cross-file navigation.
// Pass a file: or jar: root ending in "/" to test a staged build before installation.
async function runPaperLensResearchSmoke(outputPath, rootURI, fixturePDF) {
  if (!rootURI) {
    const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    rootURI=(await AddonManager.getAddonByID('paper-lens@local.tools')).getResourceURI().spec;
  }
  const scope={Zotero,Components,Services,IOUtils,PathUtils,URL};scope.globalThis=scope;
  for (const name of ['retrieval','math','pdf-text','core','research','writeback','plugin']) {
    Services.scriptloader.loadSubScriptWithOptions(rootURI+'src/'+name+'.js',{target:scope,ignoreCache:true});
  }
  const {PaperLensResearch:R,PaperLensCore:C}=scope;
  const plugin=new scope.PaperLensPlugin(rootURI);
  const win=Zotero.getMainWindow();
  const active=Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID) ||
    Zotero.Reader._readers.find(r=>r._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfDocument);
  if (!active) throw new Error('请先打开一篇本地 PDF。');
  const readerPDF=r=>!r._isTabClosed && !!r._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfDocument;
  const activePage=R.currentPage(active), image=await R.capturePage(active,activePage);
  const jpg=win.atob(image.imageURL.split(',')[1]);
  if (image.pageIndex!==activePage || jpg.length<512 || jpg.charCodeAt(0)!==255 || jpg.charCodeAt(1)!==216 ||
      jpg.charCodeAt(jpg.length-2)!==255 || jpg.charCodeAt(jpg.length-1)!==217) throw new Error('PDF 图像重绘未得到完整 JPEG。');
  const ctx={cfg:{contextChars:8000},cancelled:()=>false,progress:()=>{}};
  const pages=await R.workerPages(active.itemID,(id,pages)=>Zotero.PDFWorker.getFullText(id,pages,true),ctx.cancelled);
  if (!pages.length || !pages.every(p=>Number.isInteger(p.pageIndex)&&p.text.trim())) throw new Error('本地 PDF worker 分页失败。');
  const originalTab=win.Zotero_Tabs.selectedID;
  const metadata=(a,i)=>({attachmentID:a.id,attachmentKey:a.key,libraryID:a.libraryID,paperTitle:'本地测试论文 '+i});
  let fixture, fixtureErased=false, result;
  try {
    if (fixturePDF) {
      if (PathUtils.filename(fixturePDF)!=='sample.pdf' || PathUtils.filename(PathUtils.parent(fixturePDF))!=='.test-runtime')
        throw new Error('测试附件仅接受项目的 .test-runtime/sample.pdf。');
      const bytes=await IOUtils.read(fixturePDF);
      const digest=await win.crypto.subtle.digest('SHA-256',bytes);
      const hex=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
      if(hex!=='20217af6f0b243bb89c6ed23617cfe24231cd2ba865145eb9d67901b47f489f8')
        throw new Error('测试 PDF 的 SHA-256 与项目合成样例不符。');
      fixture=await Zotero.Attachments.importFromFile({file:fixturePDF,libraryID:Zotero.Libraries.userLibraryID});
    }
    const activeItem=Zotero.Items.get(active.itemID);
    const other=fixture || Zotero.Items.get(Zotero.Reader._readers.find(r=>r.itemID!==active.itemID && readerPDF(r))?.itemID || active.itemID);
    const papers=[metadata(activeItem,1)];
    if (other.id!==activeItem.id) papers.push(metadata(other,2));
    const q='比较研究方法 method experiment resample by angle';
    let multi;
    if (papers.length===2) {
      multi=await R.multipleContext(plugin,{reader:active},papers,q,ctx);
    } else {
      const synthetic={attachmentID:-1,attachmentKey:'TESTONLY',libraryID:papers[0].libraryID,paperTitle:'合成测试论文'};
      const sources=R.candidates(C,[...papers,synthetic],[pages,[{pageIndex:2,text:'This synthetic method uses a controlled experiment.'}]],q,ctx.cfg.contextChars);
      multi={sources,requiredDocuments:2,scope:'multi',selection:{kind:'multi',pageIndex:0,text:'两篇测试论文'},history:[]};
    }
    const request=C.prepareRequest({action:'ask',selection:multi.selection,sources:multi.sources,question:q},ctx.cfg.contextChars);
    if(new Set(request.sources.map(s=>s.attachmentID)).size!==2 || !request.sources.every(s=>/^D[12]-P\d+-\d+$/.test(s.id))) throw new Error('跨论文证据没有正确区分来源。');
    result={jpegBytes:jpg.length,page:activePage+1,workerTextPages:pages.length,
      multiInput:fixture?'active-and-unopened-fixture-pdf':papers.length===2?'two-open-pdfs':'one-local-pdf-and-synthetic-fixture',
      presentDocuments:2,sourceCount:request.sources.length,modelCalls:0};
    if (fixture) {
      const evidence=request.sources.find(s=>s.attachmentID===fixture.id && s.pageIndex===1 && s.text.includes('resample by angle'));
      if (!evidence || Zotero.Reader._readers.some(r=>r.itemID===fixture.id)) throw new Error('未打开的两页合成 PDF 未提供第 2 页证据。');
      const runResult=await runResearchRequests(plugin,R,win,active,multi,q,image,evidence);
      Object.assign(result,runResult);
    }
  } finally {
    if (fixture?.id) {
      try {
        const open=Zotero.Reader._readers.find(r=>r.itemID===fixture.id && !r._isTabClosed);
        if (open) open.close();
        if (originalTab && win.Zotero_Tabs.selectedID!==originalTab && win.Zotero_Tabs._getTab(originalTab)?.tab)
          win.Zotero_Tabs.select(originalTab);
      } finally {
        await fixture.eraseTx();
        fixtureErased=true;
      }
    }
  }
  if (fixture) {
    result.fixtureErased=fixtureErased;
    result.restoredTab=win.Zotero_Tabs.selectedID===originalTab;
    if (!result.restoredTab) throw new Error('未恢复最初选中的标签页。');
  }
  if (outputPath) await IOUtils.writeJSON(outputPath,result);
  return result;
}

// Use a real plugin.run and detached native answer feed. The only substituted
// boundaries are credentials, transport and persistence. No real session changes.
async function runResearchRequests(plugin,R,win,reader,multi,question,image,evidence) {
  const doc=win.document, el=tag=>plugin.el(doc,tag);
  const p={doc,reader,session:{turns:[],marks:{},selection:null,pinned:null,passages:[]},feed:el('div'),sources:el('details'),
    cancel:el('button'),send:el('button'),selection:el('textarea'),status:el('div'),question:el('textarea'),
    depth:{value:'standard'},scope:{value:'related'},length:{value:'brief'},turnViews:new Map()};
  plugin.config=()=>({...plugin.C.DEFAULTS,remember:false,baseURL:'https://example.invalid',model:'fixture',contextChars:8000});
  plugin.persist=async()=>{};
  plugin.keyFor=async()=>'synthetic';
  plugin.alert=text=>{p.status.textContent=text;};
  let count=0;
  plugin.request=async (_cfg,_key,messages,onText)=>{
    const payload=messages.at(-1).content;
    let answer;
    if (count===0) {
      if(typeof payload!=='string' || !payload.includes('D1-P') || !payload.includes(evidence.id) ||
        !payload.includes('resample by angle')) throw new Error('多篇请求没有包含来自两个 PDF 的真实证据。');
      answer='见 ['+evidence.id+']。';
    } else {
      if(count!==1 || !Array.isArray(payload) || payload[0]?.type!=='text' ||
          payload[1]?.type!=='image_url' || payload[1]?.image_url?.url!==image.imageURL)
        throw new Error('读图请求没有附带已捕获的 JPEG。');
      answer='本地读图请求已验证。';
    }
    count++;
    onText(answer);
    return answer;
  };
  await plugin.run(p,'ask',question,{label:'多篇论文问答',prepareContext:async()=>multi});
  const cross=p.session.turns.at(-1);
  if (!cross || cross.partial || cross.scope!=='multi') throw new Error('多篇测试请求失败。'+p.status.textContent);
  await plugin.run(p,'ask','请解释当前页图表',{label:'当前页读图',prepareContext:async()=>({
    scope:'vision',sources:[],history:[],selection:{kind:'vision',pageIndex:image.pageIndex,text:'PDF 页图像'},imageURL:image.imageURL})});
  const visual=p.session.turns.at(-1);
  if (count!==2 || visual.partial || visual.scope!=='vision' || JSON.stringify(visual).includes('data:image/'))
    throw new Error('读图测试请求失败。'+p.status.textContent);
  const citation=[...p.feed.querySelectorAll('.pl-citation')].find(b=>b.textContent==='['+evidence.id+']');
  if (!citation) throw new Error('合成论文的引用按钮没有显示。');
  citation.click();
  for(let i=0;i<150;i++) {
    const target=Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
    if (target?.itemID===evidence.attachmentID && target._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfDocument) {
      if (R.currentPage(target)===evidence.pageIndex) return {interceptedRequests:count,citationOpenedFixturePage:evidence.pageIndex+1};
    }
    await Zotero.Promise.delay(100);
  }
  throw new Error('点击证据后未跳转到合成 PDF 的指定物理页。');
}
