const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const Core=require('../src/core.js');

function deferred() {
  let resolve,reject;
  const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});
  return {promise,resolve,reject};
}

function setup(write=async()=>{}) {
  const context={PaperLensCore:Core,URL,
    Zotero:{Items:{get:()=>({libraryID:1,key:'PAPER',getField:()=> 'Fixture'})},Reader:{unregisterEventListener(){}}},
    PathUtils:{join:(...parts)=>parts.join('/')},IOUtils:{writeUTF8:write}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('src/plugin.js','utf8'),context);
  const plugin=vm.runInContext('new PaperLensPlugin("")',context);
  plugin.storage='/fixture';
  plugin.config=()=>({...Core.DEFAULTS,model:'fixture'});
  plugin.keyFor=async()=> 'fixture-key';
  plugin.settings=()=>{};
  plugin.renderSources=()=>{};
  plugin.renderAnswer=()=>{};
  plugin.renderFeed=()=>{};
  plugin.renderSelection=()=>{};
  plugin.appendTurn=()=>({card:{remove(){}},content:{}});
  const panel={reader:{itemID:1,_window:{setTimeout,clearTimeout}},root:{isConnected:true,remove(){this.isConnected=false;}},busy:false,
    session:{turns:[],marks:{},selection:{text:'selected',pageIndex:0}},
    selection:{value:'selected'},scope:{value:'selection'},depth:{value:'standard'},
    status:{textContent:''},cancel:{},send:{},question:{value:''},
    feed:{replaceChildren(){},scrollHeight:100,scrollTop:0,clientHeight:100}};
  plugin.panels.set(panel.reader,panel);
  plugin.sessions.set('1-PAPER',panel.session);
  return {plugin,panel};
}

test('rapid clicks reserve the panel before asynchronous credential lookup',async()=>{
  const {plugin,panel}=setup();const credential=deferred();let calls=0;
  plugin.keyFor=()=>credential.promise;
  plugin.request=async()=>{calls++;return 'answer';};
  const first=plugin.run(panel,'explain');
  const second=plugin.run(panel,'explain');
  credential.resolve('fixture-key');await Promise.all([first,second]);
  assert.equal(calls,1);assert.equal(panel.session.turns.length,1);assert.equal(panel.busy,false);
});

test('closing the panel during credential lookup prevents an API request',async()=>{
  const {plugin,panel}=setup();const credential=deferred();let calls=0;
  plugin.keyFor=()=>credential.promise;plugin.request=async()=>{calls++;return 'answer';};
  const running=plugin.run(panel,'explain');
  plugin.disposePanel(panel.reader,panel);credential.resolve('fixture-key');await running;
  assert.equal(calls,0);assert.equal(panel.session.turns.length,0);assert.equal(panel.busy,false);
});

test('shutdown waits for the aborted answer to finish saving',async()=>{
  const writeStarted=deferred(),allowWrite=deferred(),requestStarted=deferred();let saved;
  const {plugin,panel}=setup(async(path,snapshot)=>{saved=JSON.parse(snapshot);writeStarted.resolve();await allowWrite.promise;});
  plugin.request=(cfg,key,messages,onText,onAbort)=>new Promise((resolve,reject)=>{
    onText('partial answer');onAbort(()=>reject(new Error('已停止。')));requestStarted.resolve();
  });
  const running=plugin.run(panel,'explain');await requestStarted.promise;
  let stopped=false;const stopping=plugin.stop().then(()=>{stopped=true;});
  const phase=await Promise.race([writeStarted.promise.then(()=>'write'),stopping.then(()=>'stopped')]);
  await Promise.resolve();
  const stoppedBeforeWrite=stopped;allowWrite.resolve();await Promise.all([running,stopping]);
  assert.equal(phase,'write');assert.equal(stoppedBeforeWrite,false);assert.equal(saved.turns[0].answer,'partial answer');
  assert.equal(saved.turns[0].partial,true);assert.equal(plugin.sessions.size,0);
});

test('continuation keeps an explicitly absent pinned passage absent',async()=>{
  const {plugin,panel}=setup();let payload;
  panel.session.pinned={text:'new unrelated passage',pageIndex:9};
  plugin.request=async(cfg,key,messages)=>{payload=messages.at(-1).content;return 'continued';};
  await plugin.run(panel,'continue','continue',{history:[{question:'explain',answer:'previous partial answer',selection:panel.session.selection}],pinned:null,scope:'selection'});
  assert.ok(!payload.includes('new unrelated passage'));assert.equal(panel.session.turns[0].pinned,null);
});

test('a follow-up draft edited while waiting for an answer is preserved',async()=>{
  const {plugin,panel}=setup();const response=deferred(),started=deferred();
  panel.question.value='first question';
  plugin.request=()=>{started.resolve();return response.promise;};
  const running=plugin.run(panel,'ask','first question');await started.promise;
  panel.question.value='next question draft';response.resolve('answer');await running;
  assert.equal(panel.question.value,'next question draft');
});

test('invalid configuration releases controls so the user can retry',async()=>{
  const {plugin,panel}=setup();let calls=0;
  plugin.config=()=>({...Core.DEFAULTS,model:''});
  plugin.request=async()=>{calls++;return 'answer';};
  await plugin.run(panel,'explain');
  assert.equal(calls,0);assert.equal(panel.busy,false);
  assert.equal(panel.send.disabled,false);assert.equal(panel.selection.disabled,false);
  plugin.config=()=>({...Core.DEFAULTS,model:'fixture'});
  await plugin.run(panel,'explain');assert.equal(calls,1);
});

test('a pending save cannot be overtaken by another request',async()=>{
  const started=deferred(),allowWrite=deferred();let calls=0;
  const {plugin,panel}=setup(async()=>{started.resolve();await allowWrite.promise;});
  plugin.request=async()=>{calls++;return 'answer';};
  const first=plugin.run(panel,'explain');await started.promise;
  const second=plugin.run(panel,'explain');allowWrite.resolve();
  await Promise.all([first,second]);assert.equal(calls,1);assert.equal(panel.busy,false);
});

test('shutdown prevents a pending panel open from recreating UI',async()=>{
  const {plugin}=setup();const loading=deferred();let created=0;
  plugin.session=()=>loading.promise;plugin.makePanel=()=>{created++;};
  const opening=plugin.open({itemID:2});
  const rejected=assert.rejects(opening,/已停止/);
  await plugin.stop();loading.resolve({turns:[]});await rejected;
  assert.equal(created,0);assert.equal(plugin.panels.size,0);
});

test('two windows keep their own passage and page while sharing completed history',async()=>{
  const {plugin,panel}=setup();const gate=deferred(),seen=[];
  panel.selected={text:'passage A',pageIndex:1};panel.selection.value='passage A';
  const other={...panel,reader:{itemID:1,_window:{setTimeout,clearTimeout}},selected:{text:'passage B',pageIndex:9},selection:{value:'passage B'},status:{},cancel:{},send:{},question:{value:''}};
  panel.session.selection={...other.selected};plugin.panels.set(other.reader,other);
  plugin.keyFor=()=>gate.promise;
  plugin.request=async(cfg,key,messages)=>{seen.push(messages.at(-1).content);return 'answer';};
  const first=plugin.run(panel,'explain'),second=plugin.run(other,'explain');gate.resolve('fixture-key');
  await Promise.all([first,second]);
  assert.ok(seen.some(s=>s.includes('"pageIndex":1,"text":"passage A"')));
  assert.ok(seen.some(s=>s.includes('"pageIndex":9,"text":"passage B"')));
  assert.equal(panel.selected.pageIndex,1);assert.equal(other.selected.pageIndex,9);assert.equal(panel.session.turns.length,2);
});

test('stream checkpoints are saved before completion and final save clears pending',async()=>{
  const saved=[],response=deferred(),started=deferred();let checkpoint;
  const {plugin,panel}=setup(async(path,text)=>{saved.push(JSON.parse(text));});
  panel.reader._window={setTimeout:fn=>{checkpoint=fn;return 1;},clearTimeout:()=>{checkpoint=null;}};
  plugin.request=(cfg,key,messages,onText)=>{onText('first partial');started.resolve();return response.promise;};
  const running=plugin.run(panel,'explain');await started.promise;
  assert.equal(typeof checkpoint,'function');checkpoint();await plugin.writes.get('1-PAPER');
  assert.equal(saved[0].turns[0].answer,'first partial');assert.equal(saved[0].turns[0].pending,true);
  response.resolve('finished answer');await running;
  assert.equal(saved.at(-1).turns[0].answer,'finished answer');assert.equal(saved.at(-1).turns[0].pending,false);
});

test('disabling local history also disables streaming checkpoints',async()=>{
  let timers=0,writes=0;
  const {plugin,panel}=setup(async()=>{writes++;});
  plugin.config=()=>({...Core.DEFAULTS,model:'fixture',remember:false});
  panel.reader._window={setTimeout:()=>{timers++;return 1;},clearTimeout(){}};
  plugin.request=async(cfg,key,messages,onText)=>{onText('answer');return 'answer';};
  await plugin.run(panel,'explain');assert.equal(timers,0);assert.equal(writes,0);
});

test('oversized mandatory input is rejected before network dispatch',async()=>{
  let calls=0;const {plugin,panel}=setup();
  plugin.config=()=>({...Core.DEFAULTS,model:'fixture',contextChars:4000});
  panel.selection.value='large '.repeat(1000);plugin.request=async()=>{calls++;return 'answer';};
  await plugin.run(panel,'explain');assert.equal(calls,0);assert.match(panel.status.textContent,/总输入上限/);assert.equal(panel.session.turns.length,0);
});
test('selection popup actions reserve their own passage before saving',async()=>{
  const allowSave=deferred();let content='',calls=0;
  const {plugin,panel}=setup(()=>allowSave.promise);
  plugin.request=async(cfg,key,messages)=>{calls++;content=messages.at(-1).content;return 'answer';};
  const first=plugin.open(panel.reader,{text:'passage A',pageIndex:1},'translate');
  const second=plugin.open(panel.reader,{text:'passage B',pageIndex:5},'explain');
  allowSave.resolve();await Promise.all([first,second]);
  assert.equal(calls,1);assert.ok(content.includes('passage A'));assert.ok(!content.includes('passage B'));
  assert.equal(panel.selected.pageIndex,1);
});
test('continuing old answers uses saved evidence even when the PDF has changed',async()=>{
  const {plugin,panel}=setup();let content='',reads=0;
  plugin.pages=async()=>{reads++;throw new Error('PDF has changed');};
  plugin.request=async(cfg,key,messages)=>{content=messages.at(-1).content;return 'continued';};
  const turn={question:'explain',answer:'old partial [P3-1]',partial:true,scope:'related',selection:{text:'old passage',pageIndex:1},sources:[{id:'P3-1',pageIndex:2,text:'original evidence snapshot'}]};
  await plugin.resume(panel,turn);
  assert.equal(reads,0);assert.ok(content.includes('original evidence snapshot'));assert.equal(panel.session.turns[0].sources[0].id,'P3-1');
});

test('PDF selection symbols are verified before sending and the corrected text is saved',async()=>{
 const {plugin,panel}=setup();panel.selected={text:'L = A R',pageIndex:0,rects:[[1,2,3,4]]};panel.selection.value=panel.selected.text;
 let payload,reads=0;
 plugin.readPageText=async()=>{reads++;return {text:'L = A − R',verified:true,stats:{unknownGlyphs:0,unplacedGlyphs:0}};};
 plugin.request=async(cfg,key,messages)=>{payload=messages.at(-1).content;return 'explanation';};
 await plugin.run(panel,'formula');assert.equal(reads,1);assert.ok(payload.includes('L = A − R'));assert.equal(panel.session.turns[0].selection.text,'L = A − R');assert.equal(panel.selection.value,'L = A − R');
});
test('manual formula corrections and historical evidence snapshots are never replaced',async()=>{
 for(const snapshot of [false,true]){
  const {plugin,panel}=setup();panel.selected={text:'old',pageIndex:0,rects:[[1,2,3,4]]};panel.selection.value='manually corrected';
  plugin.readPageText=async()=>{throw new Error('unexpected re-extraction');};let payload;
  plugin.request=async(cfg,key,messages)=>{payload=messages.at(-1).content;return 'answer';};
  const options=snapshot?{selection:{...panel.selected,text:'historical'},sources:[]}:{};
  await plugin.run(panel,'formula','',options);assert.equal(panel.session.turns.length,1);assert.ok(payload.includes(snapshot?'historical':'manually corrected'));
 }
});
test('unresolved glyphs in a PDF selection block sending without erasing the original',async()=>{
 const {plugin,panel}=setup();panel.selected={text:'original',pageIndex:0,rects:[[1,2,3,4]]};panel.selection.value='original';let calls=0;
 plugin.readPageText=async()=>({text:'[未识别符号]',verified:true,stats:{unknownGlyphs:1,unplacedGlyphs:0}});
 plugin.request=async()=>{calls++;return 'should not send';};
 await plugin.run(panel,'formula');assert.equal(calls,0);assert.equal(panel.selection.value,'original');assert.match(panel.status.textContent,/纠正/);assert.equal(panel.session.turns.length,0);
});
test('closing during PDF selection verification prevents the request',async()=>{
 const {plugin,panel}=setup();panel.selected={text:'original',pageIndex:0,rects:[[1,2,3,4]]};panel.selection.value='original';const gate=deferred(),started=deferred();let calls=0;
 plugin.readPageText=async()=>{started.resolve();return await gate.promise;};plugin.request=async()=>{calls++;return 'answer';};
 const run=plugin.run(panel,'formula');await started.promise;plugin.disposePanel(panel.reader,panel);gate.resolve({text:'corrected',verified:true,stats:{}});await run;assert.equal(calls,0);assert.equal(panel.session.turns.length,0);
});

test('comparison verifies the pinned PDF formula as well as the current selection',async()=>{
 const {plugin,panel}=setup();panel.session.pinned={text:'A B',pageIndex:2,rects:[[1,2,3,4]]};let payload;
 plugin.readPageText=async(reader,page)=>{assert.equal(page,2);return {text:'A − B',verified:true,stats:{}};};
 plugin.request=async(cfg,key,messages)=>{payload=messages.at(-1).content;return 'answer';};
 await plugin.run(panel,'compare');assert.ok(payload.includes('A − B'));assert.equal(panel.session.turns[0].pinned.text,'A − B');
});

test('PDF selections spanning two pages retain both repaired page ranges',async()=>{
 const {plugin,panel}=setup();panel.selected={text:'both pages',pageIndex:1,rects:[[1,2,3,4]],nextPageRects:[[5,6,7,8]]};panel.selection.value='both pages';const reads=[];
 plugin.readPageText=async(reader,page)=>{reads.push(page);return {text:'page '+page+' − x',verified:true,stats:{}};};
 plugin.request=async()=> 'answer';await plugin.run(panel,'formula');
 assert.deepEqual(reads,[1,2]);assert.equal(panel.session.turns[0].selection.text,'page 1 − x\n\npage 2 − x');
});
