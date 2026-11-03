// Local current-PDF adapter check; no model request, annotation or session write.
async function runPaperLensPDFSmoke() {
  const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
  const addon=await AddonManager.getAddonByID('paper-lens@local.tools');
  const scope={Zotero,Services,Components,IOUtils,PathUtils,URL,DOMParser};scope.globalThis=scope;
  const root=addon.getResourceURI().spec;
  for(const name of ['retrieval','math','locations','pdf-text','core','plugin'])Services.scriptloader.loadSubScriptWithOptions(root+'src/'+name+'.js',{target:scope,ignoreCache:true});
  const win=Zotero.getMainWindow(),reader=Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
  if(!reader)throw new Error('请先打开 PDF。');
  const view=reader._internalReader._primaryView;
  const originalPage=Math.max(0,(view._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber||1)-1);
  const probe=new scope.PaperLensPlugin(root),panel={reader,status:{}};
  const pages=await probe.pages(reader,()=>{},()=>false,originalPage);
  const source={pageIndex:originalPage,text:pages[0].text.slice(0,160)};
  try {
    await probe.navigateSource(panel,source);
    await new Promise(resolve=>win.setTimeout(resolve,100));
    const position=view._highlightedPosition;
    return {version:addon.version,requestedPage:originalPage+1,pagesRead:pages.length,
      cachedPages:probe.cache.get(probe.sessionID(reader)).byPage.size,
      matched:!!position&&position.pageIndex===originalPage&&position.rects.length>0,
      highlightRectangles:position?.rects?.length||0,status:panel.status.textContent,
      realApiCalls:0,annotationsCreated:0,sessionFileWrites:0};
  } finally {await reader.navigate({pageIndex:originalPage});}
}
