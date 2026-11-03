(function(root){
  'use strict';
  const cache=new WeakMap();
  const stop=new Set('the a an and or for that with from this are was were have has had into which their these those can not using used of in on to is as by it be at we our they its such than also explain explanation show describe what how why please eq equation fig figure table section'.split(' '));
  const greek={α:'alpha',β:'beta',γ:'gamma',δ:'delta',ε:'epsilon',λ:'lambda',μ:'mu',σ:'sigma',τ:'tau',ψ:'psi',ω:'omega',θ:'theta',φ:'phi'};
  const concepts={'消融':['ablation'],'定义':['defined','denote','definition'],'符号':['notation','denote'],'损失':['loss','objective'],'权重':['weight','lambda'],'实验':['experiment','result'],'对照':['baseline','comparison'],'鲁棒':['robustness','noise'],'泛化':['generalization'],'域':['domain'],'阶次':['order'],'包络':['envelope'],'小波':['wavelet'],'转速':['speed'],'频率':['frequency'],'时频':['frequency','temporal'],'公式':['equation'],'参数':['parameter'],'输入':['input'],'输出':['output'],'采样':['sampling'],'注意力':['attention'],'卷积':['convolution']};
  function tokenize(text) {
    let s=String(text).normalize('NFKC').toLowerCase().replace(/[αβγδελμστψωθφ]/g,c=>' '+greek[c]+' ');
    const words=s.match(/[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*|[\u3400-\u9fff]+/g)||[];
    return words.flatMap(w=>{
      if(/[\u3400-\u9fff]/.test(w))return w.length<2?[w]:Array.from({length:w.length-1},(_,i)=>w.slice(i,i+2));
      const parts=w.split(/[-_]/);return [...new Set([w,...parts])].filter(x=>!stop.has(x));
    });
  }
  function chunks(pages) {
    const out=[];let bibliography=false;
    for(const p of pages){
      const text=String(p.text||'').replace(/\r/g,'').trim();
      // Split at section transitions so an appendix after references is searchable normally.
      const markers=[...text.matchAll(/^[ \t]*(?:(?:\d+(?:\.\d+)*\.?[ \t]+)?(?:references|bibliography)|appendi(?:x|ces)(?:[ \t]+[^\n]*)?|supplementary[ \t]+(?:material|information)(?:[ \t]+[^\n]*)?)[ \t]*$/gim)].map(m=>({start:m.index,bibliography:/^(?:\d+(?:\.\d+)*\.?\s+)?(?:references|bibliography)\s*$/i.test(m[0].trim())}));
      let start=0,n=0;
      while(start<text.length){
        for(const marker of markers)if(marker.start===start)bibliography=marker.bibliography;
        const nextMarker=markers.find(m=>m.start>start);
        let end=Math.min(start+1800,text.length,nextMarker?.start??Infinity);
        if(end<text.length&&end!==nextMarker?.start){const para=text.lastIndexOf('\n\n',end);const sentence=Math.max(text.lastIndexOf('. ',end),text.lastIndexOf('。',end));const cut=para>=start+650?para+2:sentence>=start+650?sentence+1:-1;if(cut>start)end=cut;}
        const raw=text.slice(start,end),content=raw.trim(),leading=raw.length-raw.trimStart().length;
        if(content)out.push({id:`P${p.pageIndex+1}-${++n}`,pageIndex:p.pageIndex,text:content,start:start+leading,end:start+leading+content.length,bibliography,...(p.extractionWarning?{extractionWarning:p.extractionWarning}:{})});
        start=end;
      }
    }
    return out;
  }
  function index(pages) {
    if(cache.has(pages))return cache.get(pages);
    const rows=chunks(pages).map(c=>{const words=tokenize(c.text),tf=new Map();for(const w of words)tf.set(w,(tf.get(w)||0)+1);return {...c,tf,length:Math.max(words.length,1)};});
    const df=new Map();for(const row of rows)for(const w of row.tf.keys())df.set(w,(df.get(w)||0)+1);
    const idx={rows,df,avg:rows.reduce((n,r)=>n+r.length,0)/(rows.length||1)};cache.set(pages,idx);return idx;
  }
  function references(query) {
    return [...String(query).matchAll(/(?:\b(eq(?:uation)?s?\.?|fig(?:ure)?s?\.?|tables?|sections?)\s*\(?|([式图表节])\s*[（(]?)([0-9]+(?:\.[0-9]+)*)(?![0-9]|\.[0-9])/gi)].map(m=>{
      const label=(m[1]||m[2]).toLowerCase();
      return {kind:label.startsWith('eq')||label==='式'?'equation':label.startsWith('fig')||label==='图'?'figure':label.startsWith('table')||label==='表'?'table':'section',number:m[3]};
    });
  }
  function matchesReference(text,ref) {
    const number=ref.number.replace(/\./g,'\\.'),end='(?![0-9]|\\.[0-9])';
    if(ref.kind==='equation')return new RegExp('(?:[（(]\\s*'+number+'\\s*[）)]|\\b(?:eq(?:uation)?s?\\.?)\\s*[（(]?'+number+end+')','i').test(text);
    if(ref.kind==='section')return new RegExp('(?:^|\\n)[ \\t]*'+number+'(?:[ \\t]+|\\.[ \\t]+)|\\bsections?\\s+'+number+end,'i').test(text);
    return new RegExp('(?:\\b'+(ref.kind==='figure'?'fig(?:ure)?s?\\.?':'tables?')+'\\s*|'+(ref.kind==='figure'?'图':'表')+'\\s*)'+number+end,'i').test(text);
  }
  function retrieve(pages,query,pageIndex,budget,scope='related',options={}) {
    if(scope==='selection'||!Number.isFinite(budget)||budget<=0)return [];
    const {rows,df,avg}=index(pages),weights=new Map();
    const add=(text,weight)=>{for(const w of new Set(tokenize(text)))weights.set(w,Math.max(weights.get(w)||0,weight));};
    add(query,1);if(options.question)add(options.question,2.2);
    for(const [zh,en] of Object.entries(concepts))if(String(query).includes(zh)||String(options.question||'').includes(zh))for(const w of en)weights.set(w,Math.max(weights.get(w)||0,1.4));
    const action=options.action||'context';
    const definition=/\b(where|denotes?|defined|definition|represents?|refers to|is the|are the)\b|表示|定义|其中/i;
    const intent=action==='terms'?definition:action==='evidence'?/\b(ablation|baseline|experiment|accuracy|results?)\b/i:action==='method'||action==='formula'?/\b(proposed|method|equation|loss|objective)\b/i:null;
    const selection=String(options.selection||'').replace(/\s+/g,' ').trim().slice(0,150);
    const local=rows.find(r=>r.pageIndex===pageIndex&&selection&&r.text.replace(/\s+/g,' ').includes(selection));
    const refs=references(query),equations=refs.filter(r=>r.kind==='equation');
    const formulaAnchors=rows.filter(r=>!r.bibliography&&(equations.some(ref=>matchesReference(r.text,ref))||(action==='formula'&&r===local)));
    const adjacentDefinitions=new Set();
    for(const anchor of formulaAnchors){
      const i=rows.indexOf(anchor);
      for(const candidate of [rows[i-1],rows[i+1]]){
        if(!candidate||candidate.bibliography||Math.abs(candidate.pageIndex-anchor.pageIndex)>1)continue;
        // Only the next/previous chunk, and only if it visibly explains notation.
        if(definition.test(candidate.text))adjacentDefinitions.add(candidate.id);
      }
    }
    const ranked=rows.filter(r=>scope!=='page'||r.pageIndex===pageIndex).map(r=>{
      let score=0;const matches=[];
      for(const [w,weight] of weights){const tf=r.tf.get(w)||0;if(!tf)continue;const idf=Math.log(1+(rows.length-(df.get(w)||0)+.5)/((df.get(w)||0)+.5));score+=weight*idf*tf*2.2/(tf+1.2*(.25+.75*r.length/avg));matches.push(w);}
      const reasons=[];
      if(matches.length)reasons.push('匹配：'+matches.slice(0,6).join('、'));
      if(r===local){score+=5;reasons.push('选段所在段落');}
      else if(r.pageIndex===pageIndex){score+=.45;reasons.push('选段同页');}
      if(intent&&matches.length&&intent.test(r.text)){score+=1.5;reasons.push(action==='terms'?'定义线索':action==='evidence'?'实验线索':'方法线索');}
      const matchedRefs=refs.filter(ref=>matchesReference(r.text,ref));
      if(matchedRefs.length){score+=3*matchedRefs.length;reasons.push('编号关联');for(const ref of matchedRefs)reasons.push(({equation:'公式',figure:'图',table:'表',section:'章节'})[ref.kind]+' '+ref.number);}
      if(adjacentDefinitions.has(r.id)){score+=2.5;reasons.push('公式邻近定义');}
      if(r.bibliography&&r!==local){score*=.3;reasons.push('参考文献降权');}
      return {...r,score,reasons,matched:matches.length>0};
    }).filter(r=>scope==='page'||r.matched||r.reasons.includes('编号关联')||r.reasons.includes('选段所在段落')||r.reasons.includes('公式邻近定义')).sort((a,b)=>b.score-a.score||a.pageIndex-b.pageIndex||a.start-b.start);
    const selected=[],seen=new Set(),pageCounts=new Map();let used=0;
    const take=r=>{
      const fingerprint=r.text.replace(/\s+/g,' ').toLowerCase();if(seen.has(fingerprint))return;
      const text=r.text.slice(0,Math.max(0,budget-used));if(!text)return;
      seen.add(fingerprint);selected.push({id:r.id,pageIndex:r.pageIndex,text,start:r.start,end:r.start+text.length,textAnchor:text.slice(0,240),rank:selected.length+1,score:r.score,reasons:r.reasons,truncated:text.length<r.text.length,...(r.extractionWarning?{extractionWarning:r.extractionWarning}:{})});used+=text.length;pageCounts.set(r.pageIndex,(pageCounts.get(r.pageIndex)||0)+1);
    };
    if(local){const r=ranked.find(r=>r.id===local.id);if(r)take(r);}
    while(used<budget){let best=null,bestScore=-Infinity;for(const r of ranked){if(seen.has(r.text.replace(/\s+/g,' ').toLowerCase()))continue;const adjusted=r.score/(1+.22*(pageCounts.get(r.pageIndex)||0));if(adjusted>bestScore){best=r;bestScore=adjusted;}}if(!best)break;take(best);}
    return selected.sort((a,b)=>a.pageIndex-b.pageIndex||a.id.localeCompare(b.id,undefined,{numeric:true}));
  }
  const api={tokenize,chunks,retrieve};root.PaperLensRetrieval=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
