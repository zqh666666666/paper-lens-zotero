const {test}=require('node:test');
const assert=require('node:assert/strict');
const {evaluate}=require('../scripts/evaluate-retrieval.cjs');
const corpus=require('./fixtures/retrieval-papers.json');

test('public-paper locator cases retain expected pages and reject absent topics',()=>{
  const report=evaluate();
  assert.equal(report.papers,3);
  for(const entry of report.cases){
    if(entry.knownLimitation)continue; // Report real limitations; do not require an intentional failure forever.
    if(entry.expectedPages.length)assert.equal(entry.recallAt1,1,entry.id);
    else assert.equal(entry.correctlyEmpty,true,entry.id);
  }
});

test('benchmark stores only short attributed quotations with explicit physical page indexes',()=>{
  for(const paper of corpus.papers){
    assert.match(paper.source,/^https:\/\//);
    const wordCount=paper.pages.reduce((sum,page)=>sum+page.text.trim().split(/\s+/).length,0);
    assert.ok(wordCount<=25,`${paper.id}: ${wordCount} words`);
    assert.ok(paper.pages.every(page=>Number.isInteger(page.pageIndex)&&page.pageIndex>=0&&page.location));
  }
});
