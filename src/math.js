(function(root){
  'use strict';
  const escaped=(s,i)=>{let n=0;while(i>0&&s[--i]==='\\')n++;return n%2===1;};
  // Code spans and escaped currency are never interpreted as math.
  function splitInline(value) {
    const s=String(value),out=[];let start=0,i=0;
    const push=(type,text,raw,display=false)=>out.push({type,text,raw,display});
    while(i<s.length){
      if(s[i]==='`'&&!escaped(s,i)){const end=s.indexOf('`',i+1);if(end!==-1){if(i>start)push('text',s.slice(start,i));push('code',s.slice(i+1,end),s.slice(i,end+1));i=end+1;start=i;continue;}}
      let open,close,display=false;
      if(!escaped(s,i)){
        if(s.startsWith('\\(',i)){open='\\(';close='\\)';}
        else if(s.startsWith('\\[',i)){open='\\[';close='\\]';display=true;}
        else if(s.startsWith('$$',i)){open='$$';close='$$';display=true;}
        else if(s[i]==='$'&&!/\s/.test(s[i+1]||' ')){open='$';close='$';}
      }
      if(open){
        let end=s.indexOf(close,i+open.length);
        while(end!==-1&&escaped(s,end))end=s.indexOf(close,end+close.length);
        const valid=end>i+open.length&&(open!=='$'||(!/\s/.test(s[end-1])&&!/\d/.test(s[end+1]||'')));
        if(valid){if(i>start)push('text',s.slice(start,i));push('math',s.slice(i+open.length,end),s.slice(i,end+close.length),display);i=end+close.length;start=i;continue;}
      }
      i++;
    }
    if(start<s.length)push('text',s.slice(start));return out;
  }
  function displayBlock(lines,index) {
    const first=lines[index].trim();const open=first.startsWith('$$')?'$$':first.startsWith('\\[')?'\\[':null;
    if(!open)return null;const close=open==='$$'?'$$':'\\]';let body=first.slice(2),end=index;
    while(true){const at=body.indexOf(close);if(at>=0){if(body.slice(at+2).trim())return null;return {text:body.slice(0,at),raw:lines.slice(index,end+1).join('\n'),next:end+1};}
      end++;if(end>=lines.length||/^\s*```/.test(lines[end]))return null;body+='\n'+lines[end];
    }
  }
  function mathML(katex,tex,display=false) {
    if(!katex||tex.length>8000)throw new Error('公式过长或排版库未加载');
    return katex.renderToString(tex,{displayMode:display,output:'mathml',trust:false,throwOnError:true,strict:'ignore',maxExpand:500,maxSize:12,macros:{}});
  }
  const api={splitInline,displayBlock,mathML};root.PaperLensMath=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
