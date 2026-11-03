const {test}=require('node:test');
const assert=require('node:assert/strict');
const L=require('../src/locations.js');
function chars(text){return Array.from(text,(c,i)=>({c,rect:[i*5,10,i*5+5,20]}));}
test('source location joins PDF hyphenation and ligatures to exact rectangles',()=>{
  const input=chars('The ﬁlter is time-\nfrequency localized.');
  const result=L.locate(input,'filter is timefrequency',3);
  assert.equal(result.pageIndex,3);assert.equal(result.rects[0][0],20);
  assert.equal(L.locate(input,'not in the document',3),null);
});
test('duplicate excerpts do not produce a misleading highlight',()=>{
  assert.equal(L.locate(chars('same sentence. same sentence.'),'same sentence.',0),null);
});
test('highlights use separate line rectangles and ignore invalid geometry',()=>{
  const input=[{c:'first',rect:[10,30,40,40],lineBreakAfter:true},{c:'second',rect:[10,10,60,20]}];
  assert.deepEqual(L.locate(input,'first second',2),{pageIndex:2,rects:[[10,30,40,40],[10,10,60,20]]});
  assert.equal(L.locate([{c:'bad',rect:[0,0,NaN,5]}],'bad',0),null);
});
test('formula matching preserves case, minus signs and superscripts',()=>{
  for(const [actual,query] of [['xy','x-y'],['x','X'],['x²','x2'],['α₁','α1']])assert.equal(L.locate(chars(actual),query,0),null);
  assert.equal(L.locate([{c:'first',rect:[0,0,10,10]},{c:'second'}],'first second',0),null);
});
