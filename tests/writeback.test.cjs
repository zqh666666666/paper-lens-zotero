'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const locations = require('../src/locations.js');
const source = fs.readFileSync(path.join(__dirname, '../src/writeback.js'), 'utf8');

function harness() {
  const saved = [], navigated = [], turns = [], confirmations = [];
  const records = new Map();
  const attachment = {id:101, key:'PAPER001', libraryID:2, isPDFAttachment:()=>true, isEditable:()=>true};
  const native = {getAnnotationMeta:()=>({sortIndex:'00002|000001|00010',pageLabel:'iii'}),
    _iframeWindow:{PDFViewerApplication:{pdfDocument:{numPages:5,getPage:async()=>({view:[0,0,612,792]})}}}};
  const reader = {navigate:async loc=>navigated.push(loc), _internalReader:{_primaryView:native}, _window:{ZoteroContextPane:{}}};
  const plugin = {attachment:()=>attachment, persist:async()=>{}, el:()=>({}),
    button:(_doc,label,click)=>({label,click}), run:(_p,_action,_q,options)=>{const turn={}; options.onTurn(turn); turns.push(turn);}};
  const panel = {reader,status:{}};
  const Z = {Libraries:{get:()=>({editable:true})}, Items:{getByLibraryAndKey:(_l,k)=>records.get(k)},
    Utilities:{generateObjectKey:()=>String(saved.length+1)}, Annotations:{saveFromJSON:async(parent, json)=>{
      assert.equal(parent,attachment); saved.push(json);
      const item={key:json.key, isAnnotation:()=>true, parentID:parent.id}; records.set(item.key,item);return item;
    }}};
  const scope = {Zotero:Z,Components:{utils:{cloneInto:o=>o}},Services:{prompt:{confirm:(...args)=>{confirmations.push(args);return true;}}},PaperLensLocations:locations};
  vm.runInNewContext(source, scope);
  return {api:scope.PaperLensWriteback, Z, attachment, native, reader, plugin, panel, saved, navigated, turns, confirmations, records};
}

function withNote(h) {
  const changes = [], plain={type:'paragraph',content:[{type:'text',text:'old'}]};
  const doc = {textBetween:()=> 'old'};
  const selection = {from:2,to:5,$from:{parent:{inlineContent:true,type:{spec:{}}}},$to:{parent:{inlineContent:true}},
    content:()=>({content:{toJSON:()=>[plain]}})};
  const tr = {insertText(t){changes.push(t);return tr;},replaceSelectionWith(){changes.push('\n');return tr;},scrollIntoView:()=>tr};
  const view={editable:true, state:{doc,selection,schema:{nodes:{hardBreak:{create:()=>({})}}},tr},dispatch:()=>changes.push('dispatch')};
  const item={id:7,isNote:()=>true,isEditable:()=>true,getNoteTitle:()=> 'Example'};
  const instance={_iframeWindow:{wrappedJSObject:{_currentEditorInstance:{_editorCore:{view}}}}};
  h.reader._window.ZoteroContextPane.activeEditor = {getCurrentInstance:()=>instance,item};
  return {view,selection,item,changes,instance,plain};
}

test('writes through one native editor transaction; blocks inserts over selections and protected content',()=>{
  const h=harness(), n=withNote(h);
  assert.throws(()=>h.api.captureNote(h.reader,'insert'),/插入光标/);
  const target=h.api.captureNote(h.reader,'replace');
  h.api.applyNote(h.reader,target,'a\n<b>b</b>');
  assert.deepEqual(n.changes,['a','\n','<b>b</b>','dispatch']);
  n.plain.content=[{type:'citation'}];
  assert.throws(()=>h.api.captureNote(h.reader,'replace'),/普通正文/);
});

test('a generated rewrite cannot overwrite a changed document, selection, tab or note, including after closing and reopening',()=>{
  const h=harness(), n=withNote(h), target=h.api.captureNote(h.reader,'replace');
  n.selection.from++;
  assert.throws(()=>h.api.applyNote(h.reader,target,'new'),/已改变/);
  n.selection.from--;
  const old=n.view.state.doc;
  n.view.state.doc={...old};
  assert.throws(()=>h.api.applyNote(h.reader,target,'new'),/已改变/);
  n.view.state.doc=old;
  n.item.id=8;
  assert.throws(()=>h.api.applyNote(h.reader,target,'new'),/已改变/);
  n.item.id=7;
  n.instance._readOnly=true;
  assert.throws(()=>h.api.applyNote(h.reader,target,'new'),/只读/);
  n.instance._readOnly=false;
  h.reader.tabID='a';h.reader._window.Zotero_Tabs={selectedID:'b'};
  assert.throws(()=>h.api.applyNote(h.reader,target,'new'),/切回/);
  h.reader._window.Zotero_Tabs.selectedID='a';
  h.reader._window.ZoteroContextPane.activeEditor=null;
  assert.throws(()=>h.api.applyNote(h.reader,target,'new'),/已有笔记/);
  assert.deepEqual(n.changes,[]);
});

test('persists exact original cross-page geometry and comment once, then opens the existing Zotero annotation',async()=>{
  const h=harness(), turn={answer:'line 1\nline 2',selection:{text:'repaired',sourceText:'original',
    pageIndex:2, rects:[[10,20,100,28]], nextPageRects:[[20,700,90,714]]}};
  await Promise.all([h.api.saveAnnotation(h.plugin,h.panel,turn),h.api.saveAnnotation(h.plugin,h.panel,turn)]);
  assert.equal(h.saved.length,1);
  const a=h.saved[0];
  assert.equal(a.comment,turn.answer);
  assert.equal(a.text,'original');
  assert.equal(a.position.pageIndex,2);
  assert.deepEqual(Array.from(a.position.nextPageRects[0]),[20,700,90,714]);
  await h.api.saveAnnotation(h.plugin,h.panel,turn);
  assert.equal(h.saved.length,1);assert.equal(h.navigated[0].annotationID,a.key);
});

test('page image answers create page notes and unrelated origins or ambiguous pasted text cannot create highlights',async()=>{
  const h=harness();
  const turn={answer:'chart',selection:{kind:'vision',pageIndex:1,text:'current page'}};
  await h.api.saveAnnotation(h.plugin,h.panel,turn);
  assert.equal(h.saved[0].type,'note');assert.equal(h.saved[0].position.pageIndex,1);
  for(const kind of ['note','document','multi']) {
    await assert.rejects(h.api.saveAnnotation(h.plugin,h.panel,{...turn,selection:{kind,pageIndex:0,text:'q'}}),/没有可标注/);
  }
  h.native._iframeWindow.PDFViewerApplication.pdfDocument.getPageData=async()=>({chars:[
    {c:'x',rect:[1,2,3,4]},{c:'x',rect:[4,2,6,4]}]});
  await assert.rejects(h.api.saveAnnotation(h.plugin,h.panel,{answer:'q',selection:{text:'x',pageIndex:1}}),/唯一定位/);
  assert.equal(h.saved.length,1);
  h.native._readOnly=true;
  await assert.rejects(h.api.saveAnnotation(h.plugin,h.panel,{...turn,pdfAnnotation:undefined}),/只读/);
});
