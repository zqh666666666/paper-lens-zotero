const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const Core=require('../src/core.js');
function create(extra={}){const ctx={PaperLensCore:Core,PaperLensPassages:require('../src/passages.js'),PaperLensLocations:require('../src/locations.js'),PaperLensPDFText:require('../src/pdf-text.js'),URL,...extra};vm.createContext(ctx);vm.runInContext(fs.readFileSync('src/plugin.js','utf8'),ctx);return vm.runInContext('new PaperLensPlugin("")',ctx);}
test('Zotero 10 getPageData adapter clones arguments and caches by file version',async()=>{
 let calls=0,clones=0,stamp=1;
 const p=create({Zotero:{Items:{get:()=>({libraryID:1,key:'PDF1',getFilePathAsync:async()=>'/fixture.pdf'})}},IOUtils:{stat:async()=>({size:20,lastModified:stamp})},Components:{utils:{cloneInto:x=>{clones++;return x;}}}});
 const r={itemID:1,_internalReader:{_primaryView:{_iframeWindow:{PDFViewerApplication:{pdfDocument:{numPages:2,getPageData:async({pageIndex})=>{calls++;return {chars:[{c:'page'+pageIndex,spaceAfter:true},{c:'text',paragraphBreakAfter:true},{c:'ignore',ignorable:true}]};}}}}}}};
 const pages=await p.pages(r,()=>{},()=>false);assert.equal(pages.length,2);assert.match(pages[0].text,/^page0 text/);assert.match(pages[0].text,/文字层校验不可用/);assert.equal(clones,2);
 await p.pages(r,()=>{},()=>false);assert.equal(calls,2);stamp++;await p.pages(r,()=>{},()=>false);assert.equal(calls,4);
});
test('PDF extraction cancellation does not cache partial text',async()=>{
 const p=create({Zotero:{Items:{get:()=>({libraryID:1,key:'PDF1',getFilePathAsync:async()=>'/fixture.pdf'})}},IOUtils:{stat:async()=>({size:20,lastModified:1})}});
 const r={itemID:1,_internalReader:{_primaryView:{_iframeWindow:{PDFViewerApplication:{pdfDocument:{numPages:2}}}}}};
 await assert.rejects(p.pages(r,()=>{},()=>true),/已停止/);assert.equal(p.cache.size,0);
});
test('credential stores isolate API endpoints without plaintext preference fallback',async()=>{
 const logins=[];const p=create({Services:{logins:{findLogins:()=>logins,addLoginAsync:async l=>logins.push(l),modifyLogin:(old,n)=>logins.splice(logins.indexOf(old),1,n),removeLogin:l=>logins.splice(logins.indexOf(l),1)}},Components:{classes:{'@mozilla.org/login-manager/loginInfo;1':{createInstance:()=>({init(origin,form,realm,username,password){Object.assign(this,{origin,form,realm,username,password});}})}},interfaces:{nsILoginInfo:{}}}});
 await p.setKey('https://a.example/v1','fake-A');await p.setKey('https://b.example/v1','fake-B');
 assert.equal(await p.keyFor('https://a.example/v1'),'fake-A');assert.equal(await p.keyFor('https://a.example/v2'),'');
 await p.setKey('https://a.example/v1','new-A');assert.equal(await p.keyFor('https://a.example/v1'),'new-A');
 await p.setKey('https://a.example/v1','');assert.equal(await p.keyFor('https://a.example/v1'),'');assert.equal(await p.keyFor('https://b.example/v1'),'fake-B');
});
test('save note attaches to parent paper, escapes output, keeps source positions',async()=>{
 let saved;class Item {constructor(type){this.type=type;}setNote(html){this.html=html;}async saveTx(){saved=this;}}
 const p=create({Zotero:{Item,Items:{get:()=>({libraryID:1,key:'ABC',parentID:12})},Libraries:{userLibraryID:1,get:()=>({editable:true})}}});
 const panel={reader:{itemID:2},status:{}};
 await p.saveNote(panel,{question:'讲解',answer:'<script>bad</script>',selection:{text:'selected',pageIndex:2},sources:[{id:'P5-1',pageIndex:4,text:'evidence'}],time:1,model:'fixture'});
 assert.equal(saved.parentID,12);assert.equal(saved.libraryID,1);assert.ok(saved.html.includes('&lt;script&gt;'));assert.ok(!saved.html.includes('<script>'));assert.ok(saved.html.includes('page=5'));
});
test('read-only libraries reject note writes',async()=>{
 const p=create({Zotero:{Items:{get:()=>({libraryID:1})},Libraries:{get:()=>({editable:false})}}});
 await assert.rejects(p.saveNote({reader:{itemID:2}},{answer:'test'}),/只读/);
});
test('concurrent windows share one loaded paper session and libraries stay isolated',async()=>{
 let reads=0;const p=create({Zotero:{Items:{get:id=>({libraryID:id,key:'SAMEKEY'})},Prefs:{get:()=>JSON.stringify({remember:true})}},PathUtils:{join:(...parts)=>parts.join('/')},IOUtils:{readJSON:async()=>{reads++;await new Promise(r=>setTimeout(r,5));return {turns:[]};}}});p.storage='/tmp';
 const [a,b]=await Promise.all([p.session({itemID:1}),p.session({itemID:1})]);assert.equal(a,b);assert.equal(reads,1);const c=await p.session({itemID:2});assert.notEqual(c,a);
});
test('continue uses the clicked answer context rather than a newly selected passage',async()=>{
 const p=create();const turn={selection:{text:'old selection',pageIndex:2},pinned:{text:'pin',pageIndex:1},scope:'selection',answer:'incomplete'};
 const panel={busy:false,session:{selection:{text:'new'}},scope:{value:'related'}};p.renderSelection=()=>{};
 let args;p.run=async(...a)=>{args=a;};await p.resume(panel,turn);
 assert.equal(panel.session.selection.text,'new');assert.equal(args[3].selection.text,'old selection');assert.equal(args[1],'continue');assert.equal(args[3].scope,'selection');assert.equal(args[3].history[0],turn);
});
test('page scope reads just one page and full scope reuses already cached pages',async()=>{
 const calls=[];let cancelled=false;
 const p=create({Zotero:{Items:{get:()=>({libraryID:1,key:'PDF',getFilePathAsync:async()=>'/fixture.pdf'})}},IOUtils:{stat:async()=>({size:20,lastModified:1})},Components:{utils:{cloneInto:x=>x}}});
 const r={itemID:1,_internalReader:{_primaryView:{_iframeWindow:{PDFViewerApplication:{pdfDocument:{numPages:3,getPageData:async({pageIndex})=>{calls.push(pageIndex);return {chars:[{c:'page '+pageIndex}]};}}}}}}};
 const one=await p.pages(r,()=>{},()=>cancelled,2);assert.equal(one.length,1);assert.equal(one[0].pageIndex,2);assert.deepEqual(calls,[2]);
 const all=await p.pages(r,()=>{},()=>cancelled);assert.equal(all.length,3);assert.deepEqual(calls,[2,0,1]);
 assert.equal(await p.pages(r,()=>{},()=>false),all);
 cancelled=true;await assert.rejects(p.pages(r,()=>{},()=>cancelled,2),/已停止/);
});
test('cancellation during the final page does not publish partial cache',async()=>{
 let cancelled=false;
 const p=create({Zotero:{Items:{get:()=>({libraryID:1,key:'PDF',getFilePathAsync:async()=>'/fixture.pdf'})}},IOUtils:{stat:async()=>({size:1,lastModified:1})},Components:{utils:{cloneInto:x=>x}}});
 const r={itemID:1,_internalReader:{_primaryView:{_iframeWindow:{PDFViewerApplication:{pdfDocument:{numPages:1,getPageData:async()=>{cancelled=true;return {chars:[{c:'text'}]};}}}}}}};
 await assert.rejects(p.pages(r,()=>{},()=>cancelled,0),/已停止/);assert.equal(p.cache.size,0);
});
test('a slower page read cannot replace a complete same-version cache',async()=>{
 let release,startedResolve,first=true,calls=0;
 const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{startedResolve=r;});
 const p=create({Zotero:{Items:{get:()=>({libraryID:1,key:'PDF',getFilePathAsync:async()=>'/fixture.pdf'})}},IOUtils:{stat:async()=>({size:1,lastModified:1})},Components:{utils:{cloneInto:x=>x}}});
 const r={itemID:1,_internalReader:{_primaryView:{_iframeWindow:{PDFViewerApplication:{pdfDocument:{numPages:3,getPageData:async({pageIndex})=>{calls++;if(pageIndex===2&&first){first=false;startedResolve();await gate;}return {chars:[{c:'page '+pageIndex}]};}}}}}}};
 const single=p.pages(r,()=>{},()=>false,2);await started;
 const full=await p.pages(r,()=>{},()=>false);release();await single;
 assert.equal(await p.pages(r,()=>{},()=>false),full);assert.equal(calls,4);
});
test('source clicks briefly highlight matched text and fall back to the page when ambiguous',async()=>{
 let location;
 const p=create({Components:{utils:{cloneInto:x=>x}}});p.safeLog=()=>{};
 const panel={status:{},reader:{navigate:async value=>{location=value;},_internalReader:{_primaryView:{_iframeWindow:{PDFViewerApplication:{pdfDocument:{getPageData:async()=>({chars:[{c:'exact source',rect:[1,2,30,12]}]})}}}}}}};
 await p.navigateSource(panel,{text:'exact source',pageIndex:4});assert.equal(location.position.pageIndex,4);assert.ok(panel.status.textContent.includes('高亮'));
 await p.navigateSource(panel,{text:'missing source',pageIndex:4});assert.equal(location.pageIndex,4);assert.ok(!location.position);assert.ok(panel.status.textContent.includes('未能唯一匹配'));
});
test('checkpointed turns reopen as recoverable partial answers without an active request',async()=>{
 const p=create({Zotero:{Items:{get:()=>({libraryID:1,key:'PAPER'})},Prefs:{get:()=>JSON.stringify({remember:true})}},PathUtils:{join:(...p)=>p.join('/')},IOUtils:{readJSON:async()=>({turns:[{id:'saved',pending:true,partial:true,question:'explain',answer:'partial answer',selection:{text:'source',pageIndex:1}}]})}});
 const session=await p.session({itemID:1});assert.equal(session.turns[0].pending,false);assert.equal(session.turns[0].recovered,true);assert.equal(session.turns[0].partial,true);assert.equal(session.turns[0].answer,'partial answer');
});
test('corrupt saved sessions are not silently overwritten',async()=>{
 let writes=0;
 const p=create({Zotero:{Items:{get:()=>({libraryID:1,key:'PAPER'})},Prefs:{get:()=>JSON.stringify({remember:true})}},PathUtils:{join:(...p)=>p.join('/')},IOUtils:{readJSON:async()=>{throw new SyntaxError('broken');},writeUTF8:async()=>{writes++;}}});
 const reader={itemID:1};const session=await p.session(reader);assert.ok(session.loadWarning);
 await assert.rejects(p.persist(reader),/本地会话/);assert.equal(writes,0);
});
test('JSON and Markdown exports contain evidence and LaTeX but no API configuration',()=>{
 const p=create({Zotero:{Items:{get:()=>({libraryID:1,key:'PAPER'})},Libraries:{userLibraryID:1}}});
 p.config=()=>({apiKey:'fixture-secret',model:'private-config'});
 const panel={reader:{itemID:1},session:{selection:{text:'source',pageIndex:0},pinned:null,marks:{t:'已懂'},turns:[{id:'t',time:1,question:'explain',answer:'Formula: \\(x^2\\)',model:'fixture',selection:{text:'source',pageIndex:0},sources:[{id:'P2-1',pageIndex:1,text:'evidence'}]}]}};
 const json=p.exportData(panel,'json'),md=p.exportData(panel,'md');
 assert.equal(JSON.parse(json).turns[0].sources[0].text,'evidence');assert.ok(md.includes('page=2'));assert.ok(md.includes('\\(x^2\\)'));assert.ok(md.includes('已懂'));
 assert.ok(!json.includes('fixture-secret')&&!md.includes('fixture-secret'));assert.ok(!json.includes('private-config'));
});

test('raw PDF text uses the unwrapped page API and reports unresolved font slots',async()=>{
 let calls=0;
 const p=create({Components:{utils:{cloneInto:x=>x}}});
 const r={_internalReader:{_primaryView:{_iframeWindow:{PDFViewerApplication:{pdfDocument:{numPages:1,
  getPageData:async()=>({chars:[{c:'x',rect:[4,0,9,10],fontSize:10,baseline:2}]}),
  getPage:async()=>({wrappedJSObject:{getTextContent:async()=>{calls++;return {items:[{str:'\u0000',fontName:'unknown',transform:[10,0,0,10,1,2],width:2.5,chars:[]}]};}}})
 }}}}}};
 const result=await p.readPageText(r,0);assert.equal(calls,1);assert.equal(result.verified,true);assert.equal(result.stats.unknownGlyphs,1);assert.match(result.text,/未识别符号/);
});

test('external citations navigate and export by stable library/key even if numeric attachment IDs change',async()=>{
 let opened,byKey;
 const current={libraryID:1,key:'CURRENT'},remote={id:48,key:'OTHER',libraryID:5,isPDFAttachment:()=>true};
 const p=create({Zotero:{Items:{get:()=>current,getByLibraryAndKey:(libraryID,key)=>{byKey=[libraryID,key];return remote;}},
   Reader:{open:async(...args)=>{opened=args;}},Libraries:{userLibraryID:1},Groups:{getGroupIDFromLibraryID:()=>777}}});
 const source={id:'D2-P3-1',attachmentID:123,libraryID:5,attachmentKey:'OTHER',paperTitle:'Paper B',pageIndex:2,text:'Paper B evidence'};
 const turn={id:'t',question:'compare',time:1,selection:{kind:'multi',pageIndex:0,text:'papers'},sources:[source],answer:'[D2-P3-1]'};
 const panel={reader:{itemID:1},status:{},session:{turns:[turn],marks:{}}};
 await p.navigateSource(panel,source);assert.deepEqual(byKey,[5,'OTHER']);assert.equal(opened[0],48);assert.equal(opened[1].pageIndex,2);
 const md=p.exportData(panel,'md');assert.match(md,/groups\/777\/items\/OTHER\?page=3/);assert.ok(!md.includes('CURRENT?page=1'));
});
