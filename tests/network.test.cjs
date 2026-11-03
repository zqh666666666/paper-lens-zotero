const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const Core=require('../src/core.js');
function setup(scenario,options={}){
 let sent;
 class XHR {
  constructor(){this.status=200;this.responseText='';this.headers={};}
  open(method,url){if(options.openError)throw new Error('private transport details');this.method=method;this.url=url;}
  setRequestHeader(k,v){this.headers[k]=v;}
  send(body){sent={body:JSON.parse(body),headers:this.headers,url:this.url};queueMicrotask(()=>scenario(this));}
  abort(){this.onabort();}
 }
 const ctx={PaperLensCore:Core,PaperLensPassages:require('../src/passages.js'),XMLHttpRequest:XHR,URL,console};vm.createContext(ctx);vm.runInContext(fs.readFileSync('src/plugin.js','utf8'),ctx);
 return {plugin:vm.runInContext('new PaperLensPlugin("file:///")',ctx),getSent:()=>sent};
}
const cfg={...Core.DEFAULTS,model:'test-model'};
test('stream split across arbitrary chunks preserves Chinese and authorization',async()=>{
 const {plugin,getSent}=setup(x=>{
  for(const part of ['data: {"choices":[{"delta":{"content":"你','好"}}]}\n\n','data: {"choices":[{"delta":{"content":" [P1-1]"}}]}\n\ndata: [DONE]\n\n']){x.responseText+=part;x.onprogress();}x.onload();
 });
 const answer=await plugin.request(cfg,'test-only-key',[{role:'user',content:'test'}]);
 assert.equal(answer,'你好 [P1-1]');assert.equal(getSent().headers.Authorization,'Bearer test-only-key');assert.equal(getSent().body.model,'test-model');assert.equal(plugin.requests.size,0);
});
test('non-streaming compatible API fallback',async()=>{
 const {plugin}=setup(x=>{x.responseText=JSON.stringify({choices:[{message:{content:'OK'}}]});x.onload();});
 assert.equal(await plugin.request(cfg,'k',[]),'OK');
});
test('HTTP errors do not expose raw server body or credentials',async()=>{
 const {plugin}=setup(x=>{x.status=401;x.responseText='secret echoed by server';x.onload();});
 await assert.rejects(plugin.request(cfg,'k',[]),e=>e.message.includes('API Key')&&!e.message.includes('secret'));
});
test('abort releases request and rejects',async()=>{
 const {plugin}=setup(x=>x.abort());await assert.rejects(plugin.request(cfg,'k',[]),/已停止/);assert.equal(plugin.requests.size,0);
});
test('truncated stream rejected instead of complete answer',async()=>{
 const {plugin}=setup(x=>{x.responseText='data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';x.onprogress();x.onload();});
 await assert.rejects(plugin.request(cfg,'k',[]),/提前结束/);
});
test('stream error and timeout are actionable',async()=>{
 const a=setup(x=>{x.responseText='data: {"error":{"message":"sensitive"}}\n\n';x.onload();});await assert.rejects(a.plugin.request(cfg,'k',[]),/生成过程中/);
 const b=setup(x=>x.ontimeout());await assert.rejects(b.plugin.request(cfg,'k',[]),/120 秒/);
});
test('output token truncation is reported as partial, not successful completion',async()=>{
 const {plugin}=setup(x=>{x.responseText='data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n';x.onprogress();x.onload();});
 await assert.rejects(plugin.request(cfg,'k',[]),/最大输出 token/);
});
test('JSON token truncation preserves partial text and rejects completion',async()=>{
 const {plugin}=setup(x=>{x.responseText=JSON.stringify({choices:[{message:{content:'partial JSON answer'},finish_reason:'length'}]});x.onload();});
 let partial='';
 await assert.rejects(plugin.request(cfg,'k',[],text=>{partial=text;}),/最大输出 token/);
 assert.equal(partial,'partial JSON answer');assert.equal(plugin.requests.size,0);
});
test('JSON API errors are reported without exposing response details',async()=>{
 const {plugin}=setup(x=>{x.responseText=JSON.stringify({error:{message:'secret server details'}});x.onload();});
 await assert.rejects(plugin.request(cfg,'k',[]),e=>/生成过程中/.test(e.message)&&!e.message.includes('secret'));
});
test('transport setup failures release the request and hide raw errors',async()=>{
 const {plugin}=setup(()=>{}, {openError:true});
 await assert.rejects(plugin.request(cfg,'k',[]),e=>/无法发送/.test(e.message)&&!e.message.includes('private'));
 assert.equal(plugin.requests.size,0);
});
test('cancellation before send prevents dispatch',async()=>{
 const {plugin,getSent}=setup(()=>{});
 await assert.rejects(plugin.request(cfg,'k',[],()=>{},abort=>abort()),/已停止/);
 assert.equal(getSent(),undefined);assert.equal(plugin.requests.size,0);
});
test('malformed SSE data cannot silently produce a complete answer',async()=>{
 const {plugin}=setup(x=>{x.responseText='data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {broken}\n\ndata: [DONE]\n\n';x.onload();});
 await assert.rejects(plugin.request(cfg,'k',[]),/数据|生成过程中/);
});
test('a rendering failure ends the request instead of swallowing the error',async()=>{
 const {plugin}=setup(x=>{x.responseText='data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n';x.onprogress();x.onload();});
 await assert.rejects(plugin.request(cfg,'k',[],()=>{throw new Error('private UI error');}),/回答显示失败/);
 assert.equal(plugin.requests.size,0);
});
