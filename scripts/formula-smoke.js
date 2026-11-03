// Read-only extraction probe for the current PDF. No credentials or model calls.
async function runPaperLensFormulaSmoke(root) {
  const scope={Zotero,Services,Components,IOUtils,PathUtils,URL,DOMParser};scope.globalThis=scope;
  for(const name of ['retrieval','math','locations','pdf-text','passages','core','research','commands','writeback','plugin'])Services.scriptloader.loadSubScriptWithOptions(root+'src/'+name+'.js',{target:scope,ignoreCache:true});
  const win=Zotero.getMainWindow(),reader=Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
  if(!reader)throw new Error('请先打开目标论文。');
  const probe=new scope.PaperLensPlugin(root),pages=[];
  for(const pageIndex of [2,5,6,15]){
    const result=await probe.readPageText(reader,pageIndex);
    pages.push({pageIndex,text:result.text,stats:result.stats,verified:result.verified});
  }
  const compact=s=>s.replace(/[\s_{}]/g,'');
  const checks=[
    {name:'loss subtracts reward',ok:/Lphys=λsLsp−Rord/.test(compact(pages[2].text))},
    {name:'negative exponents',ok:/10\^\{−4\}/.test(pages[3].text)&&/10\^\{−11\}/.test(pages[3].text)},
    {name:'negative interval lower bound',ok:/\[−0\.676,1\.277\]/.test(compact(pages[3].text))},
    {name:'no unresolved glyphs',ok:pages.every(p=>p.verified&&!p.stats.unknownGlyphs&&!p.stats.unplacedGlyphs)}
  ];
  return {pages,checks,realApiCalls:0};
}
