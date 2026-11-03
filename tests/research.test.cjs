const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Core = require('../src/core');
const {currentPage,workerPages,candidates} = require('../src/research');

test('跨论文证据独立分配排序和上下文，两个相同物理页也能区分', () => {
  const papers = [1,2,3].map(i => ({attachmentID:i,attachmentKey:'A'+i,libraryID:i === 3 ? 2 : 1,paperTitle:'Paper '+i}));
  const pages = papers.map((_,i) => [{pageIndex:0,text:('baseline accuracy experiment paper '+i+' results. ').repeat(i === 0 ? 240 : 40)}]);
  const rows = candidates(Core,papers,pages,'baseline accuracy',4000);
  const out = Core.prepareRequest({action:'ask',question:'baseline accuracy',selection:{kind:'multi',text:'Paper 1, Paper 2, Paper 3',pageIndex:0}, sources:rows},4000);
  assert.deepEqual([...new Set(out.sources.map(r => r.attachmentID))], [1,2,3]);
  for(const r of out.sources) {
    assert.match(r.id,new RegExp('^D'+r.attachmentID+'-P1-'));
    assert.equal(r.paperTitle,'Paper '+r.attachmentID);
  }
  assert.ok(out.stats.totalChars<=4000);
});
test('未命中跨语言问题时带入首个有文字的页面并明确标记检索局限',() => {
  const [first] = candidates(Core,[{paperTitle:'p'}],[[{pageIndex:0,text:''},{pageIndex:1,text:'Optical coatings.'}]],'流程如何',4000);
  assert.equal(first.id,'D1-P2-1');
  assert.match(first.reasons.join(''),/未命中/);
});
test('非活动 PDF 的文字按物理页引用，保留空白封面、尾页和中间页产生的偏移',async()=>{
  const pages = ['', '', 'figure A', '', 'figure B', ''];
  const requests=[];
  const rows=await workerPages(16,async(id,n)=>{
    requests.push([id,n]);
    const part=n==null?pages:pages.slice(0,n);
    return {text:part.join('\f').trim(),extractedPages:part.length};
  },()=>false);
  assert.deepEqual(rows.map(r=>[r.pageIndex,r.text]),[[2,'figure A'],[4,'figure B']]);
  assert.ok(requests.every(([id])=>id===16));
  assert.ok(requests.length<=3);
});
test('扫描件、取消和不可验证的页码均不伪造来源',async()=>{
  await assert.rejects(workerPages(1,async()=>({text:' \n ',extractedPages:3})),/文字层/);
  await assert.rejects(workerPages(1,async()=>({text:'p1\fp2',extractedPages:1})),/页码/);
  await assert.rejects(workerPages(1,async()=>{throw Error('must not read');},()=>true),/已停止/);
});
test('渲染活动窗格的指定页或当前页，不发送阅读器 UI，释放画布',async()=>{
  let pageNumber, renderArgs, encoded = 0;
  const canvas = {getContext:()=>({}),toDataURL:()=>{encoded++;assert.equal(Math.max(canvas.height,canvas.width),1800);return 'data:image/jpeg;base64,AAAA';}};
  const page={getViewport:({scale})=>({wrappedJSObject:{width:720*scale,height:1080*scale}}),render:o=>(renderArgs=o,{wrappedJSObject:{promise:Promise.resolve()}})};
  const app={pdfViewer:{currentPageNumber:7},pdfDocument:{numPages:10,getPage:async n=>(pageNumber=n,{wrappedJSObject:page})}};
  const win={PDFViewerApplication:app,document:{createElementNS:()=>canvas}};
  const primary={_iframeWindow:{PDFViewerApplication:{...app,pdfViewer:{currentPageNumber:1}}}};
  const reader={_internalReader:{_primaryView:primary,_lastView:{_iframeWindow:win}}};
  const scope={Components:{utils:{createObjectIn:()=>({})}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/research'),'utf8'),scope);
  assert.equal(currentPage(reader),6);
  const result=await scope.PaperLensResearch.capturePage(reader);
  assert.equal(result.pageIndex,6);assert.equal(pageNumber,7);assert.equal(renderArgs.annotationMode,0);
  assert.equal(encoded,1);assert.equal(canvas.height,0);
  await scope.PaperLensResearch.capturePage(reader,1);
  assert.equal(pageNumber,2);
  await assert.rejects(scope.PaperLensResearch.capturePage(reader,99),/页码/);
});
test('渲染期间取消或编码失败时释放画布，并且不返回可发送的图像',async()=>{
  let stopped=false,encoded=0;
  const canvas={getContext:()=>({}),toDataURL:()=>{encoded++;return 'data:,';}};
  const page={getViewport:()=>({width:800,height:1200}),render:()=>({promise:Promise.resolve().then(()=>{stopped=true;})})};
  const app={pdfViewer:{currentPageNumber:1},pdfDocument:{numPages:1,getPage:async()=>page}};
  const reader={_internalReader:{_primaryView:{_iframeWindow:{PDFViewerApplication:app,document:{createElementNS:()=>canvas}}}}};
  const scope={Components:{utils:{createObjectIn:()=>({})}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/research'),'utf8'),scope);
  await assert.rejects(scope.PaperLensResearch.capturePage(reader,0,()=>stopped),/已停止/);
  assert.equal(encoded,0);assert.equal(canvas.width,0);
  await assert.rejects(scope.PaperLensResearch.capturePage(reader),/编码|过大/);
  assert.equal(canvas.height,0);
});
test('添加、移除和重新打开论文列表不发送请求，提交时固定本次集合',async()=>{
  const pdf=(id,title)=>({id,key:'K'+id,libraryID:1,isPDFAttachment:()=>true,getField:()=>title});
  const items=[pdf(1,'独立附件'),{...pdf(2,'Full Text PDF'),parentID:9}];
  const parent={id:9,getField:()=>'父条目题名',isRegularItem:()=>true,getBestAttachments:async()=>[items[1]]};
  const withoutPDF={id:10,isRegularItem:()=>true,getBestAttachments:async()=>[]};
  const byID=id=>[...items,parent,withoutPDF].find(x=>x.id===id);
  const readers=items.map(i=>({itemID:i.id}));
  readers[0]._window={openDialog:(url,_name,flags,io)=>{
    assert.match(url,/selectItemsDialog.xhtml$/);assert.ok(flags.includes('modal'));assert.equal(io.multiSelect,true);
    io.dataOut=[1,9,2,10]; // A standalone PDF, a parent, its same child PDF, and an item without a PDF.
  }};
  const scope={Zotero:{Reader:{_readers:readers},Items:{get:byID,getAsync:async ids=>ids.map(byID)}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/research'),'utf8'),scope);
  const nodes=[];
  function el(_doc,tag,cls,title){
    const n={tag,cls,title,children:[],listeners:{},value:'',
      append(...a){this.children.push(...a);},replaceChildren(...a){this.children=a;},
      addEventListener(e,f){this.listeners[e]=f;},setAttribute(){},focus(){}};
    nodes.push(n);return n;
  }
  const runs=[];
  const plugin={C:Core,attachment:()=>items[0],el,button:(_doc,title,click)=>Object.assign(el(null,'button','',title),{click}),
    run:(_p,_a,q,opts)=>runs.push({q,opts}),
    pages:async reader=>[{pageIndex:0,text:'baseline for '+reader.itemID}]};
  readers.forEach(reader=>{reader._internalReader={_primaryView:{_iframeWindow:{PDFViewerApplication:{pdfDocument:{}}}}};});
  const p={doc:{},status:{},reader:readers[0]};
  scope.PaperLensResearch.mount(plugin,p,el(null,'div'));
  const get=s=>nodes.find(n=>n.title===s);
  const multi=nodes.find(n=>n.tag==='details');
  multi.open=true;multi.listeners.toggle();
  await get('从文库多选…').click();
  assert.match(p.status.textContent,/已选 2 篇.*跳过/);
  assert.ok(get('父条目题名'));assert.ok(get('独立附件'));
  await get('加入已打开的 PDF').click();
  assert.equal(runs.length,0);assert.equal(get('向所选论文提问').disabled,false);
  nodes.find(n=>n.tag==='textarea').value='baseline?';
  await get('向所选论文提问').click();
  await get('移除').click();multi.open=false;multi.listeners.toggle();multi.open=true;multi.listeners.toggle();
  assert.equal(get('向所选论文提问').disabled,true);
  assert.equal(runs.length,1);
  const ctx=await runs[0].opts.prepareContext({cfg:{contextChars:4000},progress(){},cancelled:()=>false});
  assert.equal(ctx.requiredDocuments,2);
  assert.equal(new Set(ctx.sources.map(s=>s.attachmentID)).size,2);
});
