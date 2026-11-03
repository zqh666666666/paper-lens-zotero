// Write through Zotero's live note editor and annotation store.
(function (root) {
  'use strict';
  const rewriteTargets = new WeakMap();
  const savingAnnotations = new WeakSet();
  const editorObjects = new WeakMap();
  let nextObjectID = 0;

  function objectID(object) {
    if (!editorObjects.has(object)) editorObjects.set(object, ++nextObjectID);
    return editorObjects.get(object);
  }

  function activeNote(reader) {
    const win = reader._window;
    if (reader.tabID && win?.Zotero_Tabs && win.Zotero_Tabs.selectedID !== reader.tabID) {
      throw new Error('请先切回发起操作的 PDF 标签。');
    }
    const editor = win?.ZoteroContextPane?.activeEditor;
    const instance = editor?.getCurrentInstance?.(), item = editor?.item;
    if (!item?.id || !item.isNote() || !instance) {
      throw new Error('请在当前 PDF 的 Zotero 笔记侧栏打开一篇已有笔记，再设置光标或选中文字。');
    }
    if (instance._readOnly || instance._disableSaving || !item.isEditable() || item.deleted || item.parentItem?.deleted) {
      throw new Error('当前笔记为只读或已移入回收站。');
    }
    const view = instance._iframeWindow?.wrappedJSObject?._currentEditorInstance?._editorCore?.view;
    if (!view?.state || !view.dispatch || !view.editable) throw new Error('笔记编辑器尚未就绪或不可写，请重新打开笔记。');
    return {view, item};
  }

  function captureNote(reader, mode) {
    const {view, item} = activeNote(reader);
    const {doc, selection} = view.state;
    const {from, to} = selection;
    if (!selection.$from.parent.inlineContent || !selection.$to.parent.inlineContent || selection.node) {
      throw new Error('请在笔记正文中设置光标或选择普通文字。');
    }
    if (mode === 'insert' && from !== to) throw new Error('请在笔记中单击设置插入光标，或使用「替换笔记选文」。');
    if (mode === 'replace' && from === to) throw new Error('请先在笔记侧栏选中要替换的文字。');
    // Embedded citations, highlights, images and formulas carry independent Zotero data.
    const text = doc.textBetween(from, to, '\n', '\n');
    if (mode === 'replace') {
      const slice = JSON.parse(JSON.stringify(selection.content().content.toJSON() || []));
      const plain = nodes => nodes.every(node =>
        ['paragraph','heading','text','hardBreak','hard_break','blockquote','bulletList','orderedList','listItem',
          'bullet_list','ordered_list','list_item','codeBlock','code_block'].includes(node.type) &&
          (!node.content || plain(node.content)));
      if (!plain(slice) || !text.trim()) throw new Error('选文含引文、图片或其他结构。请只选择要改写的普通正文。');
    }
    // A saved answer must not keep a closed editor or its full document alive.
    return {itemID:item.id, viewID:objectID(view), docID:objectID(doc), from, to, text,
      title:item.getNoteTitle() || '未命名笔记'};
  }

  function checkedView(reader, target) {
    const current = activeNote(reader);
    const state = current.view.state;
    if (current.item.id !== target.itemID || objectID(current.view) !== target.viewID || objectID(state.doc) !== target.docID ||
        state.selection.from !== target.from || state.selection.to !== target.to) {
      throw new Error('笔记、选文或光标已改变，未写入。请重新选择后再操作。');
    }
    return current.view;
  }

  // ProseMirror owns the document. A single transaction keeps surrounding
  // formatting, native undo and Zotero autosave intact.
  function applyNote(reader, target, answer) {
    if (!answer?.trim()) throw new Error('回答尚未生成。');
    const view = checkedView(reader, target);
    const state = view.state;
    const tr = state.tr;
    const lines = answer.replace(/\r\n?/g, '\n').split('\n');
    const hardBreak = state.schema.nodes.hardBreak || state.schema.nodes.hard_break;
    if (lines.length === 1 || !hardBreak || state.selection.$from.parent.type.spec.code) {
      tr.insertText(lines.join('\n'));
    } else {
      tr.insertText(lines[0]);
      for (const line of lines.slice(1)) {
        tr.replaceSelectionWith(hardBreak.create());
        if (line) tr.insertText(line);
      }
    }
    view.dispatch(tr.scrollIntoView());
  }

  function mount(plugin, p, host) {
    const hint = plugin.el(p.doc, 'p', 'pl-muted', '在 Zotero 笔记侧栏打开已有笔记并选中文字。改写结果会先显示在回答卡中。');
    const button = plugin.button(p.doc, '改写笔记选文', () => {
      if (p.busy || p.disposed) return;
      const target = captureNote(p.reader, 'replace');
      if (target.text.length > 20000) throw new Error('笔记选文超过 20,000 字，请缩小范围。');
      return plugin.run(p, 'rewrite', '在保留原意和事实的前提下改写这段笔记，让表达更清楚。只输出改写后的正文。', {
        label:'改写笔记选文',
        prepareContext:async () => ({
          selection:{kind:'note', text:target.text, pageIndex:0}, sources:[], history:[], pinned:null, scope:'note'
        }),
        onTurn:turn => rewriteTargets.set(turn, target)
      });
    });
    host.append(button, hint);
  }

  function editNote(p, turn, mode) {
    const isRewrite = mode === 'replace' && turn.action === 'rewrite';
    const target = isRewrite ? rewriteTargets.get(turn) : captureNote(p.reader, mode);
    if (!target) throw new Error('这条改写的原笔记选区已关闭，请重新选中文字并生成改写。');
    if (mode === 'replace') {
      checkedView(p.reader, target);
      const preview = text => text.length > 200 ? text.slice(0, 200) + '…' : text;
      if (!Services.prompt.confirm(p.reader._window, '替换笔记选文',
        '笔记：' + target.title + '\n\n原选文：\n' + preview(target.text) + '\n\n替换为：\n' + preview(turn.answer))) return;
    }
    applyNote(p.reader, target, turn.answer);
    p.status.textContent = (mode === 'insert' ? '回答已插入笔记光标处' : '已替换笔记选文') + '，可在 Zotero 笔记中撤销。';
  }

  function copiedRects(rects) {
    if (!Array.isArray(rects) || !rects.length) return null;
    if (!rects.every(r => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1])) {
      throw new Error('原选段的位置数据无效，请重新划选并提问。');
    }
    return rects.map(r => r.slice());
  }
  function copyChars(chars) {
    const local = [];
    for (let i = 0; i < (chars?.length || 0); i++) {
      const c = chars[i], r = c.rect;
      local.push({c:c.c, ignorable:c.ignorable, lineBreakAfter:c.lineBreakAfter, paragraphBreakAfter:c.paragraphBreakAfter,
        spaceAfter:c.spaceAfter, rect:r?.length === 4 ? [r[0],r[1],r[2],r[3]] : null});
    }
    return local;
  }

  async function annotationPosition(reader, selection, pageNote) {
    const internal = reader._internalReader || reader._iframeWindow?.wrappedJSObject?.reader;
    const view = internal?._primaryView, pdf = view?._iframeWindow?.PDFViewerApplication?.pdfDocument;
    const pageIndex = selection?.pageIndex;
    if (!view || !pdf || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdf.numPages) {
      throw new Error('原回答缺少有效 PDF 页码，请等待 PDF 加载或重新从原文提问。');
    }
    let position;
    if (pageNote) {
      const proxy = await pdf.getPage(pageIndex + 1);
      const box = (proxy.wrappedJSObject || proxy).view;
      const [x0,y0,x1,y1] = [box?.[0],box?.[1],box?.[2],box?.[3]];
      if (![x0,y0,x1,y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) throw new Error('无法确定 PDF 页面边界。');
      const size = Math.min(22, (x1-x0)/3, (y1-y0)/3);
      position = {pageIndex, rects:[[x1-size*2, y1-size*2, x1-size, y1-size]]};
    } else {
      const rects = copiedRects(selection.rects), next = copiedRects(selection.nextPageRects);
      if (next && (!rects || pageIndex + 1 >= pdf.numPages)) throw new Error('原选段的跨页位置无效。');
      if (rects) position = {pageIndex, rects, ...(next ? {nextPageRects:next} : {})};
      else if (typeof pdf.getPageData === 'function') {
        const data = await pdf.getPageData(Components.utils.cloneInto({pageIndex}, view._iframeWindow));
        position = PaperLensLocations.locate(copyChars(data?.chars), selection.text, pageIndex);
      }
      if (!position) throw new Error('无法在回答的原页唯一定位该段，请从 PDF 重新划选并提问。');
    }
    if (internal._state?.readOnly || view._readOnly) throw new Error('当前 PDF 为只读，无法添加标注。');
    const meta = view.getAnnotationMeta(Components.utils.cloneInto(position, reader._iframeWindow || view._iframeWindow));
    if (!meta?.sortIndex) throw new Error('当前阅读器无法确定标注在页面中的位置。');
    return {position, sortIndex:meta.sortIndex, pageLabel:meta.pageLabel || String(pageIndex+1)};
  }

  function annotationMode(turn) {
    const s = turn.selection;
    if (!s || s.kind === 'note' || turn.scope === 'multi' || turn.action === 'rewrite') return null;
    if (s.kind === 'vision') return 'note';
    return (!s.kind || s.kind === 'selection') && s.text ? 'highlight' : null;
  }

  async function saveAnnotation(plugin, p, turn) {
    const type = annotationMode(turn);
    if (!type || !turn.answer?.trim()) throw new Error('这条回答没有可标注的 PDF 原文。');
    if (savingAnnotations.has(turn)) return;
    savingAnnotations.add(turn);
    try {
      const attachment = plugin.attachment(p.reader);
      if (!attachment?.isPDFAttachment() || !attachment.isEditable() || attachment.deleted || attachment.parentItem?.deleted ||
          !Zotero.Libraries.get(attachment.libraryID)?.editable) throw new Error('当前 PDF 不可编辑，无法写入标注。');
      const previous = turn.pdfAnnotation;
      if (previous?.attachmentKey === attachment.key && previous.libraryID === attachment.libraryID) {
        const item = Zotero.Items.getByLibraryAndKey(attachment.libraryID, previous.key);
        if (item?.isAnnotation() && item.parentID === attachment.id && !item.deleted) {
          await p.reader.navigate({annotationID:item.key});
          p.status.textContent = '已定位这条回答之前保存的 PDF 标注。';
          return;
        }
      }
      const meta = await annotationPosition(p.reader, turn.selection, type === 'note');
      if (p.disposed || plugin.stopped || !attachment.isEditable() || attachment.deleted || attachment.parentItem?.deleted) {
        throw new Error('阅读器已关闭或 PDF 不再可写。');
      }
      const item = await Zotero.Annotations.saveFromJSON(attachment, {
        key:Zotero.Utilities.generateObjectKey(), type, ...meta, color:'#ffd400',
        ...(type === 'highlight' ? {text:turn.selection.sourceText || turn.selection.text} : {}),
        comment:(turn.partial ? '【未完成回答】\n' : '') + turn.answer
      });
      turn.pdfAnnotation = {key:item.key, attachmentKey:attachment.key, libraryID:attachment.libraryID};
      p.status.textContent = '已保存到 Zotero 的 PDF 标注，回答位于标注评论中。';
      try { await plugin.persist(p.reader); }
      catch { p.status.textContent += ' 本地会话中的标注链接尚未保存。'; }
    } finally { savingAnnotations.delete(turn); }
  }

  function addActions(plugin, p, turn, host) {
    if (!turn.answer?.trim() || turn.pending) return;
    host.append(plugin.button(p.doc, '插入笔记光标', () => editNote(p, turn, 'insert')));
    if (turn.action !== 'rewrite' || !turn.partial) {
      host.append(plugin.button(p.doc, turn.action === 'rewrite' ? '用改写替换原选文…' : '替换笔记选文…', () => editNote(p, turn, 'replace')));
    }
    const type = annotationMode(turn);
    if (type) host.append(plugin.button(p.doc, type === 'note' ? '在原页创建便签' : '将回答写入原选段标注', () => saveAnnotation(plugin, p, turn)));
  }

  const api = {mount, addActions, captureNote, applyNote, annotationMode, saveAnnotation};
  root.PaperLensWriteback = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
