const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Core=require('../src/core.js');

// Small DOM test double: layout is deterministic, while plugin event handlers and
// card reconciliation run unchanged. Real Zotero layout is checked separately.
class Element {
  constructor(tag='div') {
    this.tagName=tag;this.children=[];this.parentNode=null;this.listeners=new Map();
    this.attributes={};this.style={setProperty(name,value){this[name]=value;}};
    const classes=new Set();this.classList={add:x=>classes.add(x),remove:x=>classes.delete(x)};
    this.scrollTop=0;this.clientHeight=200;this.hidden=false;this.disabled=false;this.value='';this._text='';
  }
  set textContent(value){this._text=String(value??'');this.replaceChildren();}
  get textContent(){return this._text+this.children.map(x=>x.textContent).join('');}
  append(...nodes){for(const node of nodes){node.remove();node.parentNode=this;this.children.push(node);}}
  prepend(...nodes){for(const node of nodes.reverse()){node.remove();node.parentNode=this;this.children.unshift(node);}}
  replaceChildren(...nodes){for(const node of this.children)node.parentNode=null;this.children=[];this.append(...nodes);}
  remove(){if(this.parentNode){const siblings=this.parentNode.children;siblings.splice(siblings.indexOf(this),1);this.parentNode=null;}}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(fn);}
  dispatch(name,event={}){for(const fn of this.listeners.get(name)||[])fn(event);}
  setPointerCapture(){}
  get lastElementChild(){return this.children.at(-1);}
  get parentElement(){return this.parentNode;}
  get scrollHeight(){return this.children.length*100;}
  getBoundingClientRect(){
    const parent=this.parentNode,top=parent&&parent.className==='pl-feed'?parent.children.indexOf(this)*100-parent.scrollTop:0;
    return {top,bottom:top+100,width:parseInt(this.style.width)||410};
  }
}

function setup(config={},session={turns:[],selection:{pageIndex:0,text:'current'},marks:{},pinned:null}) {
  let prefs=JSON.stringify({...Core.DEFAULTS,...config});
  const doc={createElementNS:(ns,tag)=>new Element(tag),createTextNode:text=>{const n=new Element('#text');n.textContent=text;return n;}};
  const host=new Element('host'),iframe=new Element('iframe');host.append(iframe);
  const ctx={PaperLensCore:Core,PaperLensPassages:require('../src/passages.js'),URL,Zotero:{Prefs:{get:()=>prefs,set:(key,value)=>{prefs=value;}}}};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync('src/plugin.js','utf8'),ctx);
  const plugin=vm.runInContext('new PaperLensPlugin("")',ctx);
  let rendered=0;plugin.renderAnswer=(p,target,text)=>{rendered++;target.textContent=text;};
  plugin.persist=async()=>{};
  plugin.commitEditedPassage=async p=>{p.session.selection={...p.selected};};
  const reader={_window:{document:doc},_iframe:iframe,navigate(){}};
  const panel=plugin.makePanel(reader,session);
  return {plugin,panel,doc,getPrefs:()=>JSON.parse(prefs),rendered:()=>rendered};
}

function turns(count){return Array.from({length:count},(_,i)=>({id:'turn-'+i,answer:'answer '+i,question:'explain',time:1,model:'fixture',selection:{text:'passage '+i,pageIndex:i},sources:[],partial:false}));}

test('reader width, font, collapse and independent response length persist safely',()=>{
  const {plugin,panel,getPrefs}=setup({model:'fixture',panelWidth:500,fontSize:16,selectionCollapsed:true,apiKey:'must-not-persist'});
  assert.equal(panel.root.style.width,'500px');assert.equal(panel.root.style['--pl-font-size'],'16px');assert.equal(panel.selectionBody.hidden,true);
  plugin.setPanelWidth(panel,900,true);plugin.setReadingFont(panel,30,true);plugin.setSelectionCollapsed(panel,false,true);
  panel.length.value='detailed';panel.length.dispatch('change');
  const prefs=getPrefs();assert.equal(prefs.panelWidth,760);assert.equal(prefs.fontSize,20);assert.equal(prefs.selectionCollapsed,false);
  assert.equal(prefs.answerLength,'detailed');assert.equal(prefs.depth,'standard');assert.equal(prefs.model,'fixture');assert.ok(!('apiKey' in prefs));
});

test('width separator supports dragging and keyboard adjustment',()=>{
  const {panel,getPrefs}=setup();
  panel.resize.dispatch('pointerdown',{button:0,clientX:500,pointerId:1,preventDefault(){}});
  panel.resize.dispatch('pointermove',{clientX:420,pointerId:1});panel.resize.dispatch('pointerup');
  assert.equal(getPrefs().panelWidth,490);
  panel.resize.dispatch('keydown',{key:'ArrowRight',preventDefault(){}});assert.equal(getPrefs().panelWidth,470);
});

test('completed answer refresh keeps old cards, evidence state, and reading position',()=>{
  const session={turns:turns(8),marks:{},selection:{text:'selected',pageIndex:0}};
  const {plugin,panel,rendered}=setup({},session);panel.feed.scrollTop=120;
  const old=panel.turnViews.get('turn-1'),evidence=old.card.children.at(-2);evidence.open=true;
  const before=rendered();session.turns.at(-1).answer+=' new content';plugin.renderFeed(panel);
  assert.equal(panel.feed.scrollTop,120);assert.equal(panel.turnViews.get('turn-1'),old);assert.equal(evidence.open,true);
  assert.equal(rendered()-before,1);
});

test('new history in another window does not pull a reader away from older text',()=>{
  const session={turns:turns(8),marks:{},selection:{text:'selected',pageIndex:0}};
  const {plugin,panel}=setup({},session);panel.feed.scrollTop=120;
  session.turns.push({...turns(1)[0],id:'new-turn'});plugin.renderFeed(panel);
  assert.equal(panel.feed.scrollTop,120);assert.equal(panel.turnViews.size,9);
});

test('pending answers hide actions and restored partial answers offer continuation',()=>{
  const t={...turns(1)[0],pending:true,partial:true};
  const {plugin,panel}=setup({}, {turns:[t],marks:{},selection:t.selection});
  const view=panel.turnViews.get(t.id);assert.equal(view.buttons.children.length,0);
  t.pending=false;t.recovered=true;plugin.renderFeed(panel);
  assert.ok(view.meta.textContent.includes('已恢复未完成回答'));assert.equal(view.buttons.children[0].textContent,'继续回答');
});

test('selected text stays local to each window and edits invalidate old positions',()=>{
  const session={turns:[],marks:{},selection:{text:'first',pageIndex:2,position:{pageIndex:2,rects:[[1,2,3,4]]}}};
  const {plugin,panel}=setup({},session);
  session.selection={text:'other window',pageIndex:7};plugin.renderSelection(panel);assert.equal(panel.selection.value,'first');
  panel.selection.value='corrected formula';panel.selection.dispatch('input');plugin.renderSelection(panel);
  assert.equal(panel.selection.value,'corrected formula');assert.equal(panel.selected.pageIndex,2);assert.ok(!('position' in panel.selected));
});

test('historical expansion uses its own snapshots without replacing the current selection',async()=>{
  const {plugin,panel}=setup();let args;plugin.run=async(...value)=>{args=value;};
  const old={...turns(1)[0],action:'translate',scope:'selection',pinned:null};
  await plugin.expandTurn(panel,old,true);
  assert.equal(args[1],'breakdown');assert.equal(args[3].selection.text,'passage 0');assert.equal(args[3].answerLength,'detailed');assert.equal(panel.selected.text,'current');
});

test('source button and export format pass the intended local context',async()=>{
  const {plugin,panel}=setup();let source,format;
  plugin.navigateSource=async(p,value)=>{source=value;};plugin.exportSession=async(p,value)=>{format=value;};
  panel.page.dispatch('click');panel.export.value='md';panel.export.dispatch('change');await Promise.resolve();
  assert.equal(source,panel.selected);assert.equal(format,'md');assert.equal(panel.export.value,'');
});

test('typing a formula correction clears stale PDF rectangles before running or pinning',()=>{
 for(const event of ['input','change']){
  const session={turns:[],selection:{text:'x y',pageIndex:2,rects:[[1,2,3,4]]},marks:{}};
  const {panel}=setup({},session);panel.selection.value='x − y';panel.selection.dispatch(event);
  assert.equal(panel.selected.text,'x − y');assert.ok(!panel.selected.rects);
  if(event==='change')assert.ok(!session.selection.rects);
 }
});

test('passage cache is lazy, paginated and usable while the selection is collapsed',async()=>{
  const passages=Array.from({length:19},(_,index)=>({id:`entry-${index}`,pageIndex:index,text:`段落 ${index} `+'示例'.repeat(100)}));
  const session={turns:[],marks:{},passages,selection:passages[0]};
  const {plugin,panel}=setup({selectionCollapsed:true},session);
  assert.equal(panel.passageSummary.textContent,'段落缓存（19）');
  assert.equal(panel.passageList.children.length,0);
  assert.notEqual(panel.passageCache.parentElement,panel.selectionBody);
  panel.passageCache.open=true;panel.passageCache.dispatch('toggle');
  assert.equal(panel.passageList.children.length,8);
  assert.match(panel.passageList.children[0].textContent,/PDF 第 1 页 · 当前选段/);
  assert.ok(panel.passageList.children[0].children[0].children[1].textContent.length<=81);
  panel.passageNext.dispatch('click');await Promise.resolve();
  panel.passageNext.dispatch('click');await Promise.resolve();
  assert.equal(panel.passageList.children.length,3);
  assert.equal(panel.passagePageLabel.textContent,'3 / 3');
  session.passages=session.passages.slice(0,16);plugin.renderSelection(panel);
  assert.equal(panel.passagePageLabel.textContent,'2 / 2');
  panel.passageCache.open=false;panel.passageCache.dispatch('toggle');
  assert.equal(panel.passageList.children.length,0);
});

test('restore and delete target the clicked cache entry independently of the comparison passage',async()=>{
  const entries=[{id:'current',pageIndex:1,text:'原文'},{id:'other',pageIndex:2,text:'另一段'}];
  const session={turns:[],marks:{},passages:entries,selection:entries[0],pinned:{text:'比较依据',pageIndex:0}};
  const {plugin,panel}=setup({},session);
  let restored,removed;
  plugin.restorePassage=async(p,entry)=>{restored=entry;};
  plugin.removePassage=async(p,entry)=>{removed=entry;};
  panel.passageCache.open=true;panel.passageCache.dispatch('toggle');
  const controls=panel.passageList.children[1].children[1];
  controls.children[0].dispatch('click');controls.children[1].dispatch('click');await Promise.resolve();
  assert.equal(restored,entries[1]);assert.equal(removed,entries[1]);
  assert.match(panel.pin.textContent,/比较段.*比较依据/);
  assert.equal(session.pinned.text,'比较依据');
});

test('submitting an edited cached passage delegates the new text without its old cache ID',()=>{
  const entry={id:'prior',pageIndex:1,text:'old',rects:[[1,2,3,4]]};
  const {plugin,panel}=setup({}, {turns:[],marks:{},passages:[entry],selection:entry});
  let submitted;
  plugin.commitEditedPassage=async p=>{submitted=p.selected;};
  panel.selection.value='修正后的公式';panel.selection.dispatch('input');
  assert.equal(submitted,undefined);assert.equal(panel.selected.id,undefined);assert.equal(panel.selected.rects,undefined);
  panel.selection.dispatch('change');
  assert.equal(submitted.text,'修正后的公式');assert.equal(submitted.pageIndex,1);
  assert.equal(entry.text,'old');
});
