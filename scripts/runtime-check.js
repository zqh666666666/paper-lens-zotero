// Run from Zotero's developer console. No API requests or library-item writes.
async function runPaperLensRuntimeCheck(outputPath) {
  const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
  const addon=await AddonManager.getAddonByID('paper-lens@local.tools');
  const root=addon.getResourceURI().spec;
  const scope={Zotero,IOUtils,PathUtils,Services,URL,Components,DOMParser};scope.globalThis=scope;
  for(const name of ['retrieval','math','locations','pdf-text','core','plugin','vendor/katex'])Services.scriptloader.loadSubScriptWithOptions(root+'src/'+name+'.js',{target:scope,ignoreCache:true});
  const probe=new scope.PaperLensPlugin(root);probe.math=scope.PaperLensKatex;
  const win=Zotero.getMainWindow(),doc=win.document,reader=Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
  const pages=await probe.pages(reader,()=>{},()=>false);
  const queries=[{query:'gamma decay to rise',action:'terms'},{query:'消融实验 ablation',action:'evidence'},{query:'Eq. (12)',action:'formula'}];
  const retrieval=queries.map(q=>({query:q.query,hits:scope.PaperLensRetrieval.retrieve(pages,q.query,0,3500,'related',{action:q.action,question:q.query}).map(r=>({id:r.id,page:r.pageIndex+1,reasons:r.reasons,text:r.text.slice(0,120)}))}));
  const feed=doc.querySelector('.pl-feed');if(!feed)throw new Error('Open the Paper Lens panel first');
  doc.getElementById('paper-lens-render-probe')?.remove();
  for(const b of doc.querySelectorAll('.pl-settings button'))if(b.textContent==='关闭')b.click();
  const box=probe.el(doc,'section','pl-answer');box.id='paper-lens-render-probe';
  const fixture=String.raw`### 公式排版验证（本地示例）
行内：\(\lambda\) 控制权重，$x_i^2$ 表示平方。
\[
\mathcal{L}=\frac{1}{N}\sum_{i=1}^{N}(y_i-\hat y_i)^2+\lambda\lVert W\rVert_2^2
\]
$$
\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}
$$
\[
\begin{aligned}
a&=b+c\\
x&=\frac{1}{2}
\end{aligned}
\]
无法解析时保留：\(\frac{a\)
以上仅用于显示测试，不是论文内容。`;
  probe.renderAnswer({doc,reader},box,fixture,[],{pageIndex:0},null);
  box.append(probe.button(doc,'关闭验证示例',()=>box.remove()));
  feed.prepend(box);feed.scrollTop=0;
  const result={version:addon.version,pages:pages.length,mathCount:box.getElementsByTagNameNS('http://www.w3.org/1998/Math/MathML','math').length,fallbacks:box.querySelectorAll('.pl-math-fallback').length,retrieval};
  if (outputPath) await IOUtils.writeJSON(outputPath, result);
  return result;
}
