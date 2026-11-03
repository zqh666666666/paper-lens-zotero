const {test}=require('node:test');const assert=require('node:assert/strict');const R=require('../src/retrieval.js');
const filler='A general overview of rotating machinery diagnosis under various conditions. '.repeat(20);
const fixtures=[
 {name:'Greek symbol definition',query:'lambda',action:'terms',answer:'The coefficient λ is defined as the weight balancing the two loss terms. ',p:3},
 {name:'Chinese ablation question against English paper',query:'消融实验说明什么',question:'消融实验说明什么',action:'evidence',answer:'Ablation experiment: removing the envelope stream reduces accuracy by 8 points. ',p:5},
 {name:'Explicit equation reference',query:'Explain Eq. (12)',action:'formula',answer:'The proposed objective is L = Lc + λ Lp. (12) It combines classification and physical losses. ',p:7},
 {name:'Distinctive method term',query:'cyclostationary',action:'method',answer:'Our proposed method uses cyclostationary analysis to detect periodic modulation. ',p:9}
];
for(const f of fixtures)test('retrieval regression: '+f.name,()=>{
 const pages=[{pageIndex:0,text:filler},{pageIndex:f.p,text:f.answer.repeat(5)}];
 const found=R.retrieve(pages,f.query,0,250,'related',{action:f.action,question:f.question});
 assert.equal(found.length,1);assert.equal(found[0].pageIndex,f.p);assert.ok(found[0].reasons.length);assert.ok(found[0].text.length<=250);
});
test('paragraph chunks preserve boundaries and stable page-local source IDs',()=>{
 const a='First paragraph. '.repeat(55),b='Second paragraph. '.repeat(60);const pages=[{pageIndex:2,text:a+'\n\n'+b}];
 const c=R.chunks(pages);assert.equal(c[0].id,'P3-1');assert.equal(c[0].text,a.trim());assert.equal(c[1].id,'P3-2');assert.equal(c[1].text,b.trim());
});
test('current selection context is retained without repeating duplicate paragraphs',()=>{
 const selection='A particular sentence needs surrounding context.';
 const repeated='Fault diagnosis gives strong evidence. '.repeat(10);
 const pages=[{pageIndex:0,text:'Background. '.repeat(200)+'\n\n'+selection},{pageIndex:1,text:repeated},{pageIndex:2,text:repeated}];
 const result=R.retrieve(pages,'fault diagnosis',0,3000,'related',{selection});
 assert.ok(result.some(x=>x.text.includes(selection)));const texts=result.map(r=>r.text);assert.equal(new Set(texts).size,texts.length);
});
test('references are downweighted and page scope cannot pull in other pages',()=>{
 const pages=[{pageIndex:0,text:'The lambda coefficient is defined as the balance weight.'},{pageIndex:1,text:'References\nlambda lambda coefficient defined balance weight '.repeat(10)}];
 const result=R.retrieve(pages,'lambda coefficient',5,50,'related',{action:'terms'});assert.equal(result[0].pageIndex,0);
 assert.ok(R.retrieve(pages,'lambda',1,300,'page').every(r=>r.pageIndex===1));
 assert.deepEqual(R.retrieve(pages,'lambda',0,0),[]);
});
module.exports={fixtures,filler};
test('explicit equation retrieval does not fill spare budget with unrelated current-page text',()=>{
 const pages=[{pageIndex:0,text:filler},{pageIndex:4,text:'The loss function is L = Lc + lambda Lp. (12)'}];
 const hits=R.retrieve(pages,'Eq. (12)',0,10000,'related',{action:'formula'});assert.equal(hits.length,1);assert.equal(hits[0].pageIndex,4);
});
test('numbered references keep figure, table and section identities distinct',()=>{
 const pages=[{pageIndex:0,text:'Figure 3. Architecture overview.'},{pageIndex:1,text:'Table 3. Measured classification results.'},{pageIndex:2,text:'Table 30. Unrelated configuration.'},{pageIndex:3,text:'3.1 Method details'},{pageIndex:4,text:'3 Introduction'}];
 assert.deepEqual(R.retrieve(pages,'Table 3',9,4000).map(x=>x.pageIndex),[1]);
 assert.deepEqual(R.retrieve(pages,'Fig. 3.',9,4000).map(x=>x.pageIndex),[0]);
 assert.deepEqual(R.retrieve(pages,'Section 3',9,4000).map(x=>x.pageIndex),[4]);
 assert.deepEqual(R.retrieve(pages,'Section 3.1',9,4000).map(x=>x.pageIndex),[3]);
});
test('Chinese equation references link to exact numbers and adjacent definitions',()=>{
 const pages=[{pageIndex:0,text:'The derived objective is L = A + B. (12)'},{pageIndex:1,text:'Where A denotes the reconstruction term and B represents the penalty.'},{pageIndex:2,text:'A different relation. (120)'}];
 const result=R.retrieve(pages,'式（12）',9,4000,'related',{action:'formula'});
 assert.deepEqual(result.map(x=>x.pageIndex),[0,1]);
 assert.ok(result[0].reasons.includes('公式 12'));
 assert.ok(result[1].reasons.includes('公式邻近定义'));
 assert.deepEqual(R.retrieve(pages,'式（12）',0,4000,'page',{action:'formula'}).map(x=>x.pageIndex),[0]);
});
test('reference sections stop at an appendix on the same or following page',()=>{
 const pages=[{pageIndex:0,text:'Main discussion.\nReferences\nAuthor, 2020. Citation.\nAppendix A Proof\nA complete derivation.'},{pageIndex:1,text:'References\nA second list.'},{pageIndex:2,text:'Appendix B\nAdditional ablation experiment.'}];
 const pieces=R.chunks(pages);
 assert.equal(pieces.find(x=>x.text.startsWith('References')).bibliography,true);
 assert.ok(pieces.filter(x=>x.text.startsWith('Appendix')).every(x=>!x.bibliography));
 assert.ok(R.retrieve(pages,'ablation',9,1000).every(x=>!x.reasons.includes('参考文献降权')));
});
test('source anchors and offsets describe exactly the budgeted excerpt',()=>{
 const pages=[{pageIndex:4,text:'A definition of alpha. '+ 'Useful explanation. '.repeat(90)}];
 const [hit]=R.retrieve(pages,'alpha',0,75);
 assert.equal(hit.text,pages[0].text.slice(hit.start,hit.end));
 assert.equal(hit.textAnchor,hit.text);assert.equal(hit.truncated,true);
});
