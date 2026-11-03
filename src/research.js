/* Cross-paper reading and page images. No network calls on selection or preview. */
(function (root) {
  'use strict';

  const MAX_PAPERS = 6;
  const MAX_EDGE = 1800;
  const VISION_QUESTION = '请解释这页的主要图表，说明图例、坐标轴、主要趋势及图中能支持的结论。';
  const check = cancelled => { if (cancelled?.()) throw new Error('已停止。'); };

  function pdfState(reader) {
    const internal = reader?._internalReader || reader?._iframeWindow?.wrappedJSObject?.reader;
    const view = internal?._lastView || internal?._primaryView;
    const win = view?._iframeWindow;
    const app = win?.PDFViewerApplication;
    if (!app?.pdfDocument || !app?.pdfViewer) throw new Error('请在 PDF 阅读视图中打开要读的页面，等加载完成后重试。');
    return {win, app};
  }

  function currentPage(reader) {
    const {app} = pdfState(reader);
    const index = app.pdfViewer.currentPageNumber - 1;
    if (!Number.isInteger(index) || index < 0 || index >= app.pdfDocument.numPages) throw new Error('无法确定当前页，请等待 PDF 加载后重试。');
    return index;
  }

  // This object and its viewport/context must belong to the PDF.js window:
  // privileged JavaScript objects cannot be safely passed into a content realm.
  function captureParams(win, fields) {
    const params = Components.utils.createObjectIn(win);
    for (const [key, value] of Object.entries(fields)) params.wrappedJSObject
      ? (params.wrappedJSObject[key] = value) : (params[key] = value);
    return params;
  }

  async function capturePage(reader, pageIndex = null, cancelled = () => false) {
    check(cancelled);
    const {win, app} = pdfState(reader);
    pageIndex ??= currentPage(reader);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= app.pdfDocument.numPages) throw new Error('截图页码无效，请重新选择页面。');
    // The promise boundary reinstates Xrays even when pdfDocument came from
    // the unwrapped reader. Recover PDFPageProxy methods in its own realm.
    const proxy = await app.pdfDocument.getPage(pageIndex + 1);
    const page = proxy.wrappedJSObject || proxy;
    check(cancelled);
    const baseViewport = page.getViewport(captureParams(win, {scale: 1}));
    const viewport = baseViewport.wrappedJSObject || baseViewport;
    const edge = Math.max(viewport.width, viewport.height);
    if (!(edge > 0) || !Number.isFinite(edge)) throw new Error('此 PDF 页尺寸异常，无法截图。');
    const fullViewport = page.getViewport(captureParams(win, {scale: MAX_EDGE / edge}));
    const scaled = fullViewport.wrappedJSObject || fullViewport;
    const canvas = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
    canvas.width = Math.max(1, Math.ceil(scaled.width));
    canvas.height = Math.max(1, Math.ceil(scaled.height));
    try {
      // Fresh PDF render: exclude reader overlays, selection, other windows and annotations.
      // Keep native viewport and canvas in the content compartment.
      const context = canvas.getContext('2d');
      const taskHandle = page.render(captureParams(win, {canvasContext: context, viewport: scaled, background: '#ffffff', annotationMode: 0}));
      const task = taskHandle.wrappedJSObject || taskHandle;
      await task.promise;
      check(cancelled);
      const imageURL = canvas.toDataURL('image/jpeg', 0.9);
      if (!/^data:image\/jpeg;base64,/.test(imageURL) || imageURL.length > 6 * 1024 * 1024)
        throw new Error('此页图像未能编码或过大，无法发送。');
      return {pageIndex, imageURL};
    } finally {
      canvas.width = canvas.height = 0;
    }
  }

  function paperInfo(item) {
    const parent = item.parentID && Zotero.Items.get(item.parentID);
    return {attachmentID: item.id, attachmentKey: item.key, libraryID: item.libraryID,
      paperTitle: String(parent?.getField?.('title') || item.getField('title') || item.attachmentFilename || '未命名 PDF').slice(0, 350)};
  }

  async function pdfOf(item) {
    if (!item || item.deleted) return null;
    if (item.isPDFAttachment?.()) return item;
    if (!item.isRegularItem?.()) return null;
    return (await item.getBestAttachments()).find(a => !a.deleted && a.isPDFAttachment()) || null;
  }

  // The local PDF worker separates physical pages with form feeds and trims its
  // final string. Blank cover/trailing pages can lose their form feeds in trim().
  async function workerPages(id, read, cancelled) {
    check(cancelled);
    const {text, extractedPages} = await read(id, null);
    check(cancelled);
    if (typeof text !== 'string' || !text.trim()) throw new Error('没有可检索的文字层，请先在本地 OCR。');
    const parts = text.split('\f');
    if (!Number.isInteger(extractedPages) || parts.length > extractedPages)
      throw new Error('无法验证文字对应的页码，请在阅读器中打开此 PDF 后重试。');
    let offset = 0;
    const missing = extractedPages - parts.length;
    if (missing) {
      // Find the first nonempty page in O(log n) prefix reads so citations never shift.
      let low = 0, high = missing;
      while (low < high) {
        check(cancelled);
        const mid = Math.floor((low + high) / 2);
        const prefix = await read(id, mid + 1);
        if (prefix.text.trim()) high = mid; else low = mid + 1;
      }
      offset = low;
    }
    check(cancelled);
    return parts.map((text, i) => ({pageIndex: i + offset, text: text.trim(),
      extractionWarning: 'Zotero PDF 文字层；复杂公式与图表须对照该页原文。'})).filter(p => p.text);
  }

  async function readPaper(plugin, primary, paper, cancelled, progress) {
    const open = primary.itemID === paper.attachmentID ? primary :
      (Zotero.Reader._readers || []).find(r => !r._isTabClosed && r.itemID === paper.attachmentID && r._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfDocument);
    try {
      if (open) return await plugin.pages(open, progress, cancelled);
      return await workerPages(paper.attachmentID, (id, pages) => Zotero.PDFWorker.getFullText(id, pages, true), cancelled);
    } catch (error) {
      check(cancelled);
      throw new Error('无法读取《' + paper.paperTitle + '》：' + (open || /文字层|页码/.test(error.message) ? error.message : '请确认 PDF 已下载、可打开且含文字层。'));
    }
  }

  // A separate budget for each paper prevents a verbose paper from displacing
  // the others. Give first-ranked excerpts precedence across all papers.
  function candidates(C, papers, pageSets, question, budget) {
    const perPaper = Math.max(128, Math.floor(Math.max(0, budget - 1600) * 0.78 / papers.length));
    return papers.flatMap((paper, index) => {
      const pages = pageSets[index], first = pages.find(p => p.text?.trim());
      if (!first) throw new Error('《' + paper.paperTitle + '》没有可检索文字。');
      let rows = C.retrieve(pages, question, -1, perPaper, 'related', {question, action:'ask'});
      if (!rows.length) {
        rows = C.retrieve(pages, '', first.pageIndex, perPaper, 'page').map(s => ({...s, reasons:['未命中问题关键词，使用首个有文字的页面']}));
      }
      return rows.sort((a, b) => (a.rank || 1) - (b.rank || 1)).map((s, rank) => ({...s, ...paper,
        id:'D' + (index + 1) + '-' + s.id, score:10000 - rank - index * 0.001}));
    });
  }

  async function multipleContext(plugin, panel, papers, question, {cfg, cancelled, progress}) {
    if (papers.length < 2 || papers.length > MAX_PAPERS) throw new Error('请选择 2–' + MAX_PAPERS + ' 篇 PDF。');
    const pageSets = [];
    for (const [i, paper] of papers.entries()) {
      check(cancelled);
      const update = detail => progress('正在检索第 ' + (i + 1) + '/' + papers.length + ' 篇：《' + paper.paperTitle + '》' + (detail ? ' · ' + detail : ''));
      update();
      pageSets.push(await readPaper(plugin, panel.reader, paper, cancelled, update));
    }
    check(cancelled);
    return {scope:'multi', title:'多篇论文问答', requiredDocuments:papers.length,
      selection:{kind:'multi', pageIndex:0, text:papers.map((s,i) => 'D' + (i + 1) + ' · ' + s.paperTitle).join('\n')},
      sources:candidates(plugin.C, papers, pageSets, question, cfg.contextChars), history:[]};
  }

  function mount(plugin, p, host) {
    const {doc} = p;
    const el = (tag, cls, text) => plugin.el(doc, tag, cls, text);
    const button = (label, fn) => plugin.button(doc, label, fn);
    const detail = title => {const node = el('details', 'pl-research-section');node.append(el('summary','',title));host.append(node);return node;};
    const field = (parent, label, tag, placeholder) => {
      const wrap = el('label','pl-field'), input = el(tag);
      input.placeholder = placeholder;
      if (tag === 'textarea') {input.rows = 2; input.maxLength = 8000;} else {input.type = 'text'; input.maxLength = 200;}
      wrap.append(el('span','',label),input); parent.append(wrap);return input;
    };
    const multi = detail('多篇论文问答');
    const helper = el('small','pl-muted','选 2–' + MAX_PAPERS + ' 篇 PDF，只发送各篇与问题相关的文字片段。');
    const tools = el('div','pl-row'), list = el('ol','pl-research-papers');
    list.setAttribute('aria-label','本次问答的论文');
    const papers = new Map();
    multi.append(helper, tools, list);
    const question = field(multi, '跨论文问题', 'textarea', '例如：这些研究的方法和证据有什么不同？');
    const ask = button('向所选论文提问', () => {
      if (p.busy || p.disposed) return;
      const text = question.value.trim();
      if (!text) {p.status.textContent='请填写要向这些论文提出的问题。';question.focus();return;}
      const snapshot = [...papers.values()].map(s => ({...s}));
      return plugin.run(p, 'ask', text, {label:'多篇论文问答', prepareContext:args => multipleContext(plugin,p,snapshot,text,args)});
    });
    multi.append(ask);
    const render = () => {
      list.replaceChildren();
      for (const [id, s] of papers) {
        const row = el('li','pl-research-paper');
        const rm = button('移除', () => {papers.delete(id);render();});
        rm.setAttribute('aria-label','从本次问答中移除《' + s.paperTitle + '》');
        row.append(el('span','',s.paperTitle),rm);list.append(row);
      }
      ask.disabled = papers.size < 2;
    };
    const add = async items => {
      let excess = 0, skipped = 0;
      for (const item of items) {
        const pdf = await pdfOf(item);
        if (!pdf) {skipped++;continue;}
        if (!papers.has(pdf.id) && papers.size >= MAX_PAPERS) {excess++;continue;}
        papers.set(pdf.id, paperInfo(pdf));
      }
      render();
      p.status.textContent='已选 ' + papers.size + ' 篇。' + (excess ? '每次最多 ' + MAX_PAPERS + ' 篇；超出的未加入。' : '') +
        (skipped ? '没有 PDF 的条目已跳过。' : '');
    };
    tools.append(button('从文库多选…', async () => {
      const io = {dataOut:null, multiSelect:true};
      p.reader._window.openDialog('chrome://zotero/content/selectItemsDialog.xhtml','','chrome,dialog=no,modal,centerscreen,resizable=yes',io);
      if (io.dataOut?.length && !p.disposed) await add(await Zotero.Items.getAsync(io.dataOut));
    }),button('加入已打开的 PDF', async () => {
      const readers = (Zotero.Reader._readers || []).filter(r => !r._isTabClosed);
      await add(readers.map(r => Zotero.Items.get(r.itemID)).filter(Boolean));
    }));
    let initialized = false;
    multi.addEventListener('toggle', () => {
      if (!multi.open || initialized) return;
      const current = plugin.attachment(p.reader);
      if (current?.isPDFAttachment?.()) papers.set(current.id, paperInfo(current));
      initialized = true; render();
    });
    render();
    const vision = detail('理解当前页图表');
    vision.append(el('small','pl-muted','发送时，当前 PDF 页图像会交给设置中的读图服务。可在面板顶部的「设置」单独指定服务地址、密钥和支持图片的模型。未指定读图服务时，使用常规 API。'));
    const model = field(vision,'仅本次使用的读图模型 ID（选填）','input','留空使用设置里的模型');
    const visualQuestion = field(vision,'想了解图中的什么？','textarea','留空时解释本页主要图表、趋势和结论。');
    vision.append(button('发送当前页图像并提问', () => {
      if (p.busy || p.disposed) return;
      const pageIndex = currentPage(p.reader), modelID = model.value.trim(), text = visualQuestion.value.trim() || VISION_QUESTION;
      return plugin.run(p, 'ask', text, {label:'当前页读图',prepareContext:async ({cancelled,progress}) => {
        progress('正在渲染 PDF 第 ' + (pageIndex + 1) + ' 页…');
        const {imageURL} = await capturePage(p.reader, pageIndex, cancelled);
        return {scope:'vision', selection:{kind:'vision',pageIndex,text:'PDF 第 ' + (pageIndex + 1) + ' 页图像'}, imageURL,
          ...(modelID ? {model:modelID} : {}),sources:[], history:[]};
      }});
    }));
  }

  const api = {mount, currentPage, capturePage, workerPages, candidates, multipleContext};
  root.PaperLensResearch = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
