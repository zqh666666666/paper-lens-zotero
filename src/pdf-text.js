/* Loss-aware PDF text reconstruction. Geometry comes from Zotero/PDF.js, never a model. */
(function(root){
  'use strict';
  const finite=Number.isFinite;
  const rectOK=r=>Array.isArray(r)&&r.length===4&&r.every(finite)&&r[2]>=r[0]&&r[3]>=r[1];
  const glyphOK=c=>rectOK(c.rect)&&finite(c.baseline)&&finite(c.fontSize)&&c.fontSize>0;
  const unknown='[未识别符号]';
  function fontNames(items){
    const names=new Map();
    for(const item of items)for(const c of item.chars||[]){
      if(!c.fontName)continue;
      if(!names.has(item.fontName))names.set(item.fontName,new Set());
      names.get(item.fontName).add(c.fontName.replace(/^[A-Z]{6}\+/,''));
    }
    return names;
  }
  function missingGlyph(font){
    // Encoding slot 0 in these TeX fonts is known. A NUL in any other font is
    // ambiguous: in particular it is NOT universally a minus sign.
    if(font==='TeX_CM_Maths_Symbols')return '−';
    if(font==='TeX_CM_Maths_Extension')return '(';
    return unknown;
  }
  function insertIndex(chars,glyph){
    const x=glyph.rect[0],y=glyph.baseline,size=glyph.fontSize;
    const candidates=[];
    for(let i=0;i<chars.length;i++){
      const c=chars[i];if(!glyphOK(c)||c.rotation||c.diagonal)continue;
      const dy=Math.abs(c.baseline-y),dx=c.rect[0]-x;
      if(dx>=-0.6&&dx<=size*3&&dy<=size*0.2)candidates.push({index:i,score:Math.max(0,dx)+dy*4});
    }
    candidates.sort((a,b)=>a.score-b.score);
    if(candidates.length&&!(candidates[1]&&Math.abs(candidates[1].score-candidates[0].score)<0.05&&Math.abs(candidates[1].index-candidates[0].index)>1))return candidates[0].index;
    const preceding=[];
    for(let i=0;i<chars.length;i++){
      const c=chars[i];if(!glyphOK(c)||c.rotation||c.diagonal)continue;
      const dx=x-c.rect[2],dy=Math.abs(c.baseline-y);
      if(dx>=-0.6&&dx<size*2&&dy<size*0.2&&!c.lineBreakAfter&&!c.paragraphBreakAfter)preceding.push({index:i+1,score:Math.max(0,dx)+dy*4});
    }
    preceding.sort((a,b)=>a.score-b.score);
    return preceding[0]?.index??-1;
  }
  function restore(chars,items,stats,unplacedBounds){
    const names=fontNames(items),insertions=new Map();
    const recordUnplaced=bound=>{stats.unplacedGlyphs++;unplacedBounds.push(bound);};
    const findOriginal=c=>chars.findIndex(original=>original.c===c.c&&rectOK(original.rect)&&rectOK(c.rect)&&original.rect.every((n,j)=>Math.abs(n-c.rect[j])<0.02));
    for(let itemIndex=0;itemIndex<items.length;itemIndex++){
      const item=items[itemIndex];
      const value=String(item.str||'');if(!value.includes('\0'))continue;
      const fonts=names.get(item.fontName),font=fonts?.size===1?[...fonts][0]:null;
      const symbol=missingGlyph(font),transform=item.transform;
      const usable=Array.isArray(transform)&&transform.length===6&&transform.every(finite)&&Math.abs(transform[1])+Math.abs(transform[2])<0.01&&finite(item.width)&&item.width>=0;
      const positions=[...value.matchAll(/\0/g)].map(m=>m.index);
      for(const pos of positions){
        if(symbol===unknown)stats.unknownGlyphs++;else stats.recoveredGlyphs++;
        // Bounds are deliberately generous because a missing glyph's reported
        // width can be a fallback width. Only clearly disjoint selections may
        // exclude it; absent/rotated geometry remains a conservative warning.
        const size=usable?Math.abs(transform[3]):0;
        const bound=usable&&size?[transform[4]-size,transform[5]-size,transform[4]+item.width+size,transform[5]+size*1.5]:null;
        if(!usable||!size||positions.length!==1||(value.slice(0,pos).trim()&&value.slice(pos+1).trim())){recordUnplaced(bound);continue;}
        // Known glyphs preceding the missing final slot supply an exact anchor;
        // for an isolated slot the text item's transform is its origin.
        const following=value.slice(pos+1).trim();
        let x=transform[4];
        if(pos>0&&!following)x=transform[4]+item.width-size*0.25;
        else if(pos>0)x+=item.width*pos/value.length;
        const glyph={c:symbol,u:symbol,rect:[x,transform[5]-size*0.2,x+size*0.25,transform[5]+size*0.75],baseline:transform[5],fontSize:size,fontName:font||'',recovered:true};
        // The unfiltered text stream carries reading-order anchors even when
        // the glyph itself has no Unicode mapping. Prefer its next real glyph
        // over nearest baseline: TeX extensible brackets have shifted baselines.
        let index=-1;
        for(let j=itemIndex+1;j<Math.min(items.length,itemIndex+5);j++){
          const anchor=(items[j].chars||[]).find(glyphOK);
          if(!anchor)continue;
          const dx=anchor.rect[0]-x,dy=Math.abs(anchor.baseline-glyph.baseline);
          if(dx>=-size*0.3&&dx<=size*4&&dy<=size*2){
            index=findOriginal(anchor);
            if(index>=0&&font==='TeX_CM_Maths_Extension'){
              glyph.baseline=anchor.baseline;
              glyph.rect[1]=anchor.baseline-size*0.2;glyph.rect[3]=anchor.baseline+size*0.75;
            }
          }
          break;
        }
        if(index<0)index=insertIndex(chars,glyph);
        if(index<0){recordUnplaced(bound);continue;}
        if(!insertions.has(index))insertions.set(index,[]);
        insertions.get(index).push(glyph);
      }
    }
    const result=[];
    for(let i=0;i<=chars.length;i++){
      const added=insertions.get(i);if(added)result.push(...added.sort((a,b)=>a.rect[0]-b.rect[0]));
      if(i<chars.length)result.push({...chars[i]});
    }
    return result;
  }
  function markScripts(chars,stats){
    let base=null,last=null,script=null,run=[];
    const clearRun=()=>{run=[];};
    for(const c of chars){
      if(!glyphOK(c)){base=null;last=c;script=null;continue;}
      if(last?.lineBreakAfter||last?.paragraphBreakAfter){base=null;script=null;clearRun();}
      const adjacent=base&&last&&glyphOK(last)&&c.rect[0]>=last.rect[0]-0.3&&c.rect[0]-last.rect[2]<base.fontSize*0.85;
      const extensionBase=/TeX_CM_Maths_Extension/.test(base?.fontName||'');
      const dy=base?c.baseline-base.baseline:0;
      const smaller=base&&c.fontSize<=base.fontSize*0.83;
      const upper=smaller&&dy>=base.fontSize*0.12&&dy<=base.fontSize*0.85;
      const lower=smaller&&dy<=-base.fontSize*0.08&&dy>=-base.fontSize*0.55;
      // Do not interpret a new line or a remote fraction component as an exponent.
      const simpleBase=/[\p{L}\p{N}\])}]$/u.test(base?.c||'');
      if(adjacent&&!extensionBase&&simpleBase&&(upper||lower)&&/^[\p{L}\p{N}*∗+−=,/().-]+$/u.test(c.c)){
        c.script=upper?'sup':'sub';
        if(c.script!==script)stats.scriptRuns++;
        if(run.length&&script&&script!==c.script){
          // Interleaved upper/lower glyphs need a two-dimensional parser.
          // Leave their original reading order visible instead of generating
          // a fabricated nesting such as sigma_{t}^{f}_{,}^{i}_{c}^{nal}.
          for(const prior of run)delete prior.script;
          if(run[0])run[0].layoutUncertain=true;
          delete c.script;c.layoutUncertain=true;
          base=null;script=null;clearRun();last=c;continue;
        }
        run.push(c);
        script=c.script;
      }else{base=c;script=null;clearRun();}
      last=c;
    }
    return chars;
  }
  function serialize(chars){
    let text='',script=null,paragraphStart=true;
    const close=()=>{if(script){text+='}';script=null;}};
    for(let i=0;i<chars.length;i++){
      const c=chars[i],previous=chars[i-1],next=chars[i+1];
      if(paragraphStart){
        let end=i;while(end<chars.length&&!chars[end].paragraphBreakAfter)end++;
        if(chars.slice(i,end+1).some(char=>char.layoutUncertain))text+='[二维公式结构未复原] ';
        paragraphStart=false;
      }
      // Only join true Latin word wrapping. A minus/hyphen next to a number,
      // unknown symbol, or mathematical font remains visible.
      let left='',right='';
      if(c.c==='-'&&c.ignorable&&c.lineBreakAfter){
        for(let j=i-1;j>=0&&left.length<60;j--){const part=chars[j];if(!/^[A-Za-z]+$/.test(part.c)||part.spaceAfter||part.lineBreakAfter)break;left=part.c+left;}
        for(let j=i+1;j<chars.length&&right.length<60;j++){const part=chars[j];if(!/^[a-z]+$/.test(part.c))break;right+=part.c;if(part.spaceAfter||part.lineBreakAfter||part.paragraphBreakAfter)break;}
      }
      const wordWrap=c.c==='-'&&c.ignorable&&c.lineBreakAfter&&!previous?.script&&left.length>=2&&right.length>=2&&!/Math|Italic/i.test(previous?.fontName||'')&&!/Math|Italic/i.test(next?.fontName||'');
      if(wordWrap)continue;
      if(c.script!==script){close();if(c.script){text=text.trimEnd()+(c.script==='sup'?'^{':'_{');script=c.script;}}
      text+=c.c||'';
      const nextScript=next?.script;
      if(c.paragraphBreakAfter||c.lineBreakAfter){close();text+=c.paragraphBreakAfter?'\n\n':'\n';if(c.paragraphBreakAfter)paragraphStart=true;}
      else if(c.spaceAfter&&(!script||nextScript!==script)){close();text+=' ';}
    }
    close();return text.replace(/\r/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
  }
  function intersects(c,rects){
    if(!rectOK(c.rect))return false;
    const x=(c.rect[0]+c.rect[2])/2,y=(c.rect[1]+c.rect[3])/2;
    return rects.some(r=>rectOK(r)&&x>=r[0]-0.5&&x<=r[2]+0.5&&y>=r[1]-1&&y<=r[3]+1);
  }
  function extract(pageData,textContent,options={}){
    const stats={recoveredGlyphs:0,unknownGlyphs:0,unplacedGlyphs:0,scriptRuns:0,layoutWarnings:0,rawTextAvailable:!!textContent};
    let input=Array.isArray(pageData?.chars)?pageData.chars:[];
    const items=Array.isArray(textContent?.items)?textContent.items:[];
    let chars;const unplacedBounds=[];
    if(!input.length&&items.length){
      // Generic PDF.js has no Zotero per-character data. Retain every visible
      // string, but do not claim a missing font encoding has been recovered.
      input=items.filter(item=>typeof item.str==='string').map(item=>{
        const missing=(item.str.match(/\0/g)||[]).length;stats.unknownGlyphs+=missing;
        const t=item.transform||[],size=Math.abs(t[3]);
        const rect=[t[4],t[5]-size*0.2,t[4]+item.width,t[5]+size*0.75];
        if(missing&&!rectOK(rect)){stats.unplacedGlyphs+=missing;for(let n=0;n<missing;n++)unplacedBounds.push(null);}
        return {c:item.str.replace(/\0/g,unknown),fontSize:size,baseline:t[5],rect,lineBreakAfter:!!item.hasEOL};
      });
      chars=markScripts(input,stats);
    }else chars=markScripts(restore(input,items,stats,unplacedBounds),stats);
    for(const c of chars)if(/[∑∫∏√]/.test(c.c)||/TeX_CM_Maths_Extension/.test(c.fontName||''))c.layoutUncertain=true;
    if(Array.isArray(options.rects)){
      chars=chars.filter(c=>intersects(c,options.rects));
      stats.recoveredGlyphs=chars.filter(c=>c.recovered&&c.c!==unknown).length;
      stats.unknownGlyphs=chars.reduce((n,c)=>n+(c.c.match(/\[未识别符号\]/g)||[]).length,0);
      stats.unplacedGlyphs=unplacedBounds.filter(bound=>!rectOK(bound)||options.rects.some(r=>rectOK(r)&&bound[0]<=r[2]+0.5&&bound[2]>=r[0]-0.5&&bound[1]<=r[3]+1&&bound[3]>=r[1]-1)).length;
    }
    // Fractions, large delimiters and sum/integral limits are still spatial
    // text, not a reconstructed equation tree. Never advertise them as LaTeX.
    stats.layoutWarnings=chars.filter(c=>c.layoutUncertain).length;
    let text=serialize(chars);
    if(stats.unplacedGlyphs)text+='\n\n[文字提取提示：有 '+stats.unplacedGlyphs+' 个符号无法可靠定位，请对照 PDF 原式；不要猜补。]';
    if(stats.layoutWarnings)text+='\n\n[公式布局提示：此段含二维公式或交错上下标；分式、根号、求和上下限与变高括号未自动重建，仅保留文字顺序。请对照原式，不要把邻接字符当作确定的乘法或上下标关系。]';
    return {text,chars,stats};
  }
  const api={extract,serialize};
  if(typeof module!=='undefined')module.exports=api;else root.PaperLensPDFText=api;
})(typeof globalThis!=='undefined'?globalThis:this);
