#!/usr/bin/env node
// Offline source-checked excerpt evaluation; never fetches papers or calls an API.
const R=require('../src/retrieval.js');
const corpus=require('../tests/fixtures/retrieval-papers.json');

function evaluate(dataset=corpus) {
  const cases=[];
  for(const paper of dataset.papers)for(const question of paper.queries){
    const hits=R.retrieve(paper.pages,question.query,-1,10000,'related',{question:question.query})
      .sort((a,b)=>a.rank-b.rank);
    const pagesAt=k=>new Set(hits.slice(0,k).map(hit=>hit.pageIndex));
    const recallAt=k=>question.expectedPages.length
      ? question.expectedPages.filter(page=>pagesAt(k).has(page)).length/question.expectedPages.length
      : null;
    cases.push({paper:paper.id,id:question.id,query:question.query,expectedPages:question.expectedPages,
      retrievedPages:hits.map(hit=>hit.pageIndex),recallAt1:recallAt(1),recallAt3:recallAt(3),
      correctlyEmpty:question.expectedPages.length===0?hits.length===0:null,
      knownLimitation:question.knownLimitation||null});
  }
  const positives=cases.filter(c=>c.expectedPages.length),negatives=cases.filter(c=>!c.expectedPages.length);
  const mean=key=>positives.reduce((sum,c)=>sum+c[key],0)/positives.length;
  return {benchmark:'source-checked short-excerpt locator',papers:dataset.papers.length,
    positiveQueries:positives.length,negativeQueries:negatives.length,
    meanRecallAt1:mean('recallAt1'),meanRecallAt3:mean('recallAt3'),
    negativeAccuracy:negatives.filter(c=>c.correctlyEmpty).length/negatives.length,
    limitations:dataset.limitations,cases};
}

if(require.main===module)console.log(JSON.stringify(evaluate(),null,2));
module.exports={evaluate};
