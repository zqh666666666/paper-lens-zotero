const {test}=require('node:test');
const assert=require('node:assert/strict');
const P=require('../src/pdf-text.js');
const ch=(c,x,y=100,size=10,extra={})=>({c,rect:[x,y-2,x+4,y+7],baseline:y,fontSize:size,...extra});
const slot=(x,y=100,size=10,fontName='symbol')=>({str:'\0',fontName,width:size/4,transform:[size,0,0,size,x,y],chars:[]});
const font=(fontName='symbol',name='ABCDEF+TeX_CM_Maths_Symbols')=>({str:'=',fontName,chars:[{fontName:name}]});

test('recovers a known mathematical minus without inventing other font mappings',()=>{
 const page={chars:[ch('x',10),ch('=',16),ch('y',30)]};
 const r=P.extract(page,{items:[font(),slot(23)]});
 assert.equal(r.text,'x=−y');assert.equal(r.stats.recoveredGlyphs,1);assert.equal(r.stats.unknownGlyphs,0);
 const unknown=P.extract(page,{items:[font('symbol','CustomFont'),slot(23)]});
 assert.equal(unknown.text,'x=[未识别符号]y');assert.equal(unknown.stats.unknownGlyphs,1);
 assert.equal(page.chars.length,3);
});

test('known TeX extension slot is a parenthesis, not a minus',()=>{
 const r=P.extract({chars:[ch('x',20),ch(')',26)]},{items:[font('symbol','ABCDEF+TeX_CM_Maths_Extension'),slot(15)]});
 assert.match(r.text,/\(x\)/);assert.equal(r.stats.recoveredGlyphs,1);assert.ok(r.stats.layoutWarnings>0);
});

test('preserves negative exponents and subscripts with geometric evidence',()=>{
 const page={chars:[ch('1',10),ch('0',14,100,10,{spaceAfter:true}),ch('1',23,104,7),ch('1',27,104,7),ch(',',32),ch('r',40),ch('b',44,98.5,7,{spaceAfter:true}),ch('=',50)]};
 const r=P.extract(page,{items:[font(),slot(19,104,7)]});
 assert.equal(r.text,'10^{−11},r_{b} =');
 assert.equal(r.stats.scriptRuns,2);
});

test('preserves an ASCII minus as part of a geometric negative exponent',()=>{
 const page={chars:[ch('1',10),ch('0',14),ch('-',18,104,7),ch('1',22,104,7),ch('1',26,104,7)]};
 assert.equal(P.extract(page,null).text,'10^{-11}');
});

test('never turns ordinary adjacent digits or remote small text into exponents',()=>{
 const page={chars:[ch('1',10),ch('0',14),ch('4',18),ch('5',90,104,7),ch('n',10,70,10,{lineBreakAfter:true}),ch('2',14,64,7)]};
 assert.equal(P.extract(page,null).text,'1045n\n2');
});

test('restoration follows page reading order and stays within the correct column',()=>{
 const page={chars:[ch('L',10),ch('R',25,100,10,{paragraphBreakAfter:true}),ch('A',200),ch('B',215)]};
 const r=P.extract(page,{items:[font(),slot(208),slot(18)]});
 assert.equal(r.text,'L−R\n\nA−B');
});

test('missing geometry is flagged instead of dropping a missing symbol',()=>{
 const r=P.extract({chars:[{c:'text'}]},{items:[font(),{str:'\0',fontName:'symbol'}]});
 assert.match(r.text,/text/);assert.match(r.text,/1 个符号无法可靠定位/);
 assert.equal(r.stats.unplacedGlyphs,1);
});

test('unplaced glyphs in a clearly separate column do not block a valid selection',()=>{
 const page={chars:[ch('x',10)]},items=[font(),slot(200)];
 assert.equal(P.extract(page,{items}).stats.unplacedGlyphs,1);
 const selected=P.extract(page,{items},{rects:[[9,95,15,110]]});
 assert.equal(selected.text,'x');assert.equal(selected.stats.unplacedGlyphs,0);
});

test('an unplaced glyph without reliable geometry still warns for a narrow selection',()=>{
 const r=P.extract({chars:[ch('x',10)]},{items:[font(),{str:'\0',fontName:'symbol'}]},{rects:[[9,95,15,110]]});
 assert.equal(r.stats.unplacedGlyphs,1);assert.match(r.text,/无法可靠定位/);
});

test('an overlapping unplaced glyph remains a warning even when its center is outside the selection',()=>{
 const page={chars:[ch('x',10)]};
 const item={...slot(8),str:'a\0b',width:50};
 const r=P.extract(page,{items:[font(),item]},{rects:[[9,95,15,110]]});
 assert.equal(r.stats.unplacedGlyphs,1);
});

test('only actual Latin word-wrap hyphens are removed',()=>{
 const chars=[{c:'con'},{c:'-',ignorable:true,lineBreakAfter:true},{c:'text',spaceAfter:true},{c:'x'},{c:'-',ignorable:true,lineBreakAfter:true},{c:'y',spaceAfter:true},{c:'x'},{c:'-',ignorable:true,lineBreakAfter:true},{c:'2',spaceAfter:true},{c:'中文'},{c:'−'},{c:'数字'}];
 assert.equal(P.extract({chars},null).text,'context x-\ny x-\n2 中文−数字');
});

test('selection uses repaired glyphs and the full line script baseline',()=>{
 const page={chars:[ch('1',10),ch('0',14),ch('4',24,104,7),ch(',',30),ch('x',60),ch('y',72)]};
 const r=P.extract(page,{items:[font(),slot(19,104,7),slot(67,100,10,'unknown')]},{rects:[[9,95,30,113]]});
 assert.equal(r.text,'10^{−4}');assert.equal(r.stats.recoveredGlyphs,1);assert.equal(r.stats.unknownGlyphs,0);
});

test('generic text-content fallback preserves unknown glyphs and line breaks',()=>{
 const r=P.extract(null,{items:[{str:'中文 x',width:25,transform:[10,0,0,10,10,100],hasEOL:true},{str:'\0 2',width:10,transform:[10,0,0,10,10,80]}]});
 assert.equal(r.text,'中文 x\n[未识别符号] 2');assert.equal(r.stats.unknownGlyphs,1);
 const withoutGeometry=P.extract(null,{items:[{str:'\0'}]},{rects:[[9,95,15,110]]});
 assert.equal(withoutGeometry.stats.unplacedGlyphs,1);
});

test('ambiguous font identities do not recover slot zero as a minus',()=>{
 const r=P.extract({chars:[ch('x',10),ch('y',25)]},{items:[font(),font('symbol','UnknownFont'),slot(18)]});
 assert.equal(r.stats.unknownGlyphs,1);assert.match(r.text,/未识别符号/);
});

test('raw stream anchors restore tall parentheses next to the formula, not a nearby prose line',()=>{
 const a=ch('h',24,100),page={chars:[ch('word',21,105,10,{paragraphBreakAfter:true}),a,ch(')',30,106.4,10,{fontName:'TeX_CM_Maths_Extension'})]};
 const r=P.extract(page,{items:[font('symbol','ABCDEF+TeX_CM_Maths_Extension'),slot(20,106.4),{str:'h',chars:[a]}]});
 assert.match(r.text,/word\n\n\[二维公式结构未复原\] \(h\)/);
 assert.ok(!r.text.includes('wo(rd'));
});

test('a tall closing delimiter never makes a following square into a subscript',()=>{
 const page={chars:[ch('x',10),ch(')',16,106.4,10,{fontName:'TeX_CM_Maths_Extension'}),ch('2',22,104,7)]};
 const r=P.extract(page,null);assert.ok(!r.text.includes('_{2}'));assert.match(r.text,/x\)2/);assert.ok(r.stats.layoutWarnings);
});

test('an exponential slash remains inside the high-confidence superscript run',()=>{
 const page={chars:[ch('e',10),ch('j',14,104,7),ch('n',18,104,7),ch('/',22,104,7),ch('K',26,104,7)]};
 assert.equal(P.extract(page,null).text,'e^{jn/K}');
});

test('large-operator limits and interleaved scripts are explicitly marked rather than fabricated',()=>{
 const page={chars:[ch('∫',10),ch('+',14,98,7),ch('∞',18,98,7,{paragraphBreakAfter:true}),ch('σ',10,70),ch('t',14,68,7),ch('f',17,74,7),ch('c',20,68,7)]};
 const r=P.extract(page,null);assert.ok(!r.text.includes('∫_{+}'));assert.ok(!r.text.includes('_{t}^{f}'));
 assert.match(r.text,/\[二维公式结构未复原\]/);assert.ok(r.stats.layoutWarnings);
});

test('a missing minus before a stacked fraction follows the raw numerator anchor',()=>{
 const top=ch('1',26,105),bottom=ch('2',26,95),page={chars:[ch('x',10),top,{...bottom,paragraphBreakAfter:true}]};
 const r=P.extract(page,{items:[font(),slot(20),{str:'1',chars:[top]},{str:'2',chars:[bottom]}]});
 assert.match(r.text,/x−12/);assert.ok(!r.text.includes('2−'));
});
