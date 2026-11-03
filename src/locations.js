/* Match a supplied excerpt to PDF character rectangles without creating annotations. */
(function(root){
  'use strict';
  const ligatures={'ﬀ':'ff','ﬁ':'fi','ﬂ':'fl','ﬃ':'ffi','ﬄ':'ffl','ﬅ':'st','ﬆ':'st'};
  const glyphText=text=>String(text||'').normalize('NFC').replace(/[ﬀﬁﬂﬃﬄﬅﬆ]/g,c=>ligatures[c]);
  const normalize=text=>glyphText(text).replace(/([A-Za-z])-\s*\n\s*([a-z])/g,'$1$2').replace(/[\s\u00ad]/g,'');
  const validRect=rect=>Array.isArray(rect)&&rect.length===4&&rect.every(Number.isFinite)&&rect[2]>=rect[0]&&rect[3]>=rect[1];
  function locate(chars,text,pageIndex){
    const needle=normalize(text);
    if(!needle||!Array.isArray(chars))return null;
    let raw='';const rawOffsets=[];
    chars.forEach((char,index)=>{
      if(char.ignorable)return;
      const part=glyphText(char.c)+(char.lineBreakAfter||char.paragraphBreakAfter?'\n':char.spaceAfter?' ':'');raw+=part;
      for(let i=0;i<part.length;i++)rawOffsets.push(index);
    });
    const wrappedHyphens=new Set([...raw.matchAll(/([A-Za-z])-\s*\n\s*([a-z])/g)].map(m=>m.index+1));
    let haystack='';const offsets=[];
    for(let i=0;i<raw.length;i++)if(!/[\s\u00ad]/.test(raw[i])&&!wrappedHyphens.has(i)){haystack+=raw[i];offsets.push(rawOffsets[i]);}
    const start=haystack.indexOf(needle);
    // Repeated phrases are ambiguous; do not highlight an arbitrary occurrence.
    if(start<0||haystack.indexOf(needle,start+1)!==-1)return null;
    const first=offsets[start],last=offsets[start+needle.length-1],rects=[];
    let line=null;
    for(let i=first;i<=last;i++){
      const char=chars[i];
      if(!char.ignorable&&normalize(char.c)&&!validRect(char.rect))return null;
      if(!char.ignorable&&validRect(char.rect)){
        const r=char.rect;
        if(line&&(Math.abs(line[1]-r[1])>Math.max(2,(r[3]-r[1])*.5)||r[0]<line[0]-2||r[0]-line[2]>40)){
          rects.push(line);line=null;
        }
        line=line?[Math.min(line[0],r[0]),Math.min(line[1],r[1]),Math.max(line[2],r[2]),Math.max(line[3],r[3])]:[...r];
      }
      if(line&&(char.lineBreakAfter||char.paragraphBreakAfter)){rects.push(line);line=null;}
    }
    if(line)rects.push(line);
    return rects.length?{pageIndex,rects}:null;
  }
  const api={locate,normalize};root.PaperLensLocations=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
