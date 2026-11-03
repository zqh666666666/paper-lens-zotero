const {test}=require('node:test');const assert=require('node:assert/strict');
const M=require('../src/math.js'),C=require('../src/core.js'),katex=require('../src/vendor/katex.js');
test('inline math recognizes four delimiters without consuming code or currency',()=>{
 const parts=M.splitInline(String.raw`文字 \(a_i\) 与 $x^2$，$$\sum_i x_i$$ 和 \[\lambda\]，代码 \`$skip$\`，价格 $5 and $10，转义 \$20。`.replace(/\\`/g,'`'));
 assert.deepEqual(parts.filter(p=>p.type==='math').map(p=>p.text),['a_i','x^2','\\sum_i x_i','\\lambda']);
 assert.equal(parts.filter(p=>p.type==='code')[0].text,'$skip$');
});
test('multiline aligned equations form one block; unfinished streaming math stays literal',()=>{
 const text=String.raw`前文
\[
\begin{aligned}
a &= b + c \\
x &= \frac{1}{2}
\end{aligned}
\]
后文`;
 const blocks=C.markdownBlocks(text);assert.deepEqual(blocks.map(b=>b.type),['paragraph','math','paragraph']);
 assert.ok(blocks[1].text.includes('aligned'));assert.ok(!C.markdownBlocks('$$\nx =').some(b=>b.type==='math'));
 assert.equal(C.markdownBlocks('```tex\n$$x$$\n```')[0].type,'code');
});
test('actual bundled renderer produces accessible fractions, sums, matrices and Greek',()=>{
 for(const tex of [String.raw`\frac{a_i}{\sqrt{b}}`,String.raw`\sum_{i=1}^n x_i^2`,String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`,String.raw`\lambda+\alpha`,String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`]) {
  const markup=M.mathML(katex,tex,true);assert.ok(markup.includes('http://www.w3.org/1998/Math/MathML'));assert.ok(markup.includes('<annotation'));assert.ok(!markup.includes('<script'));
 }
});
test('untrusted formula commands cannot create remote images, links, or arbitrary styles',()=>{
 for(const tex of [String.raw`\includegraphics{https://evil.example/a}`,String.raw`\href{javascript:alert(1)}{x}`,String.raw`\htmlStyle{position:fixed}{x}`]){
  let output='';try{output=M.mathML(katex,tex);}catch{}
  assert.ok(!/<(?:img|a)\b|href=|src=|style=["'][^"']*position:fixed/.test(output));
 }
 assert.throws(()=>M.mathML(katex,String.raw`\def\a{\a}\a`));
 assert.throws(()=>M.mathML(katex,'a'.repeat(8001)));
 assert.throws(()=>M.mathML(katex,String.raw`\frac{a`));
});
