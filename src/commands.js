/* Saved reading commands. Each PDF scope is explicit and never silently shortened. */
(function (root) {
  'use strict';
  const PREF = 'paperLens.commands';
  const scopes = new Map([['selection', '当前选段'], ['page', '当前页'], ['range', '指定页段'], ['full', '全文']]);
  const tooLong = '指令要求的原文超过总输入上限。请缩小页段，或在设置中提高总输入字数。';

  function pageRange(value) {
    const match = String(value || '').trim().match(/^(\d+)(?:\s*[-–—至]\s*(\d+))?$/);
    const start = Number(match?.[1]), end = Number(match?.[2] ?? match?.[1]);
    if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
      throw new Error('请填写从 1 开始的 PDF 页码，如 3 或 3–7，结束页不能小于起始页。');
    }
    return {start, end};
  }

  function commandFields(draft) {
    const name = String(draft.name || '').trim(), prompt = String(draft.prompt || '').trim();
    if (!name || name.length > 40) throw new Error('请填写 1–40 字的按钮名称。');
    if (!prompt || prompt.length > 4000) throw new Error('请填写 1–4,000 字的提示词。');
    if (!scopes.has(draft.scope)) throw new Error('请选择要携带的原文范围。');
    const command = {name, prompt, scope:draft.scope};
    if (command.scope === 'range') {
      const {start, end} = pageRange(draft.range);
      command.range = start === end ? String(start) : start + '–' + end;
    }
    return command;
  }

  function read(prefs) {
    const raw = prefs.get(PREF);
    if (raw == null || raw === '') return [];
    try {
      const entries = JSON.parse(raw), ids = new Set();
      if (!Array.isArray(entries)) throw new Error();
      return entries.map(entry => {
        if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) throw new Error();
        ids.add(entry.id);
        return {id:entry.id, ...commandFields(entry)};
      });
    } catch {
      throw new Error('自定义指令配置无法读取。原配置已保留，请检查 Zotero 首选项中的 paperLens.commands。');
    }
  }

  // Re-read immediately before writing so editors in two reader windows cannot
  // overwrite unrelated changes, or a concurrent edit to the same command.
  function update(prefs, before, draft) {
    const entries = read(prefs);
    const index = before ? entries.findIndex(entry => entry.id === before.id) : -1;
    if (before && (index < 0 || JSON.stringify(entries[index]) !== JSON.stringify(before))) {
      throw new Error('这条指令已在另一个窗口更改。请重新打开管理器后再编辑。');
    }
    if (draft == null) {
      if (index < 0) throw new Error('请先选择要删除的指令。');
      entries.splice(index, 1);
    } else {
      const fields = commandFields(draft);
      if (entries.some((entry, i) => i !== index && entry.name === fields.name)) throw new Error('已有同名按钮，请使用其他名称。');
      if (index >= 0) entries[index] = {id:before.id, ...fields};
      else {
        if (entries.length >= 40) throw new Error('最多可保存 40 条自定义指令，请先整理已有按钮。');
        let id;
        do { id = 'cmd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
        while (entries.some(entry => entry.id === id));
        entries.push({id, ...fields});
      }
    }
    prefs.set(PREF, JSON.stringify(entries));
  }

  function scopeLabel(command) {
    return command.scope === 'range' ? 'PDF 第 ' + command.range + ' 页' : scopes.get(command.scope);
  }

  function captureRange(reader, command) {
    const internal = reader._internalReader || reader._iframeWindow?.wrappedJSObject?.reader;
    const secondary = internal?._lastViewPrimary === false;
    const view = secondary ? internal._secondaryView : internal?._primaryView;
    const app = view?._iframeWindow?.PDFViewerApplication;
    const count = app?.pdfDocument?.numPages;
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('PDF 尚未加载完成，请稍后再试。');
    if (command.scope === 'full') return {start:1, end:count};
    if (command.scope === 'range') {
      const range = pageRange(command.range);
      if (range.end > count) throw new Error('指定页段超出这篇 PDF 的 ' + count + ' 页，请编辑指令中的页段。');
      return range;
    }
    const activeStats = internal?._state?.[secondary ? 'secondaryViewStats' : 'primaryViewStats'];
    const number = app.pdfViewer?.currentPageNumber ?? (activeStats?.pageIndex + 1);
    if (!Number.isSafeInteger(number) || number < 1 || number > count) throw new Error('无法确定当前 PDF 页，请等待页面加载。');
    return {start:number, end:number};
  }

  async function readRange(plugin, p, command, range, {cfg, cancelled, progress}) {
    const {start, end} = range, sources = [];
    let chars = command.prompt.length;
    for (let page = start; page <= end; page++) {
      if (cancelled()) throw new Error('已停止。');
      const [row] = await plugin.pages(p.reader, progress, cancelled, page - 1);
      if (cancelled()) throw new Error('已停止。');
      if (!row?.text?.trim()) throw new Error('PDF 第 ' + page + ' 页没有可提取文字。请先进行 OCR 或调整页段。');
      chars += row.text.length;
      if (chars > cfg.contextChars) throw new Error(tooLong);
      sources.push({...row, id:'P' + page + '-1', reasons:[scopeLabel(command)]});
    }
    const label = (command.scope === 'full' ? '全文文字层 · ' : '') + 'PDF 第 ' +
      (start === end ? String(start) : start + '–' + end) + ' 页';
    return {selection:{kind:'document', pageIndex:start - 1, text:label}, sources, scope:'document', history:[], requireComplete:true};
  }

  function execute(plugin, p, command) {
    if (p.busy) { p.status.textContent = '请等当前回答完成后再运行指令。'; return; }
    const options = {label:command.name, history:[], pinned:null, scope:'selection'};
    if (command.scope !== 'selection') {
      // Freeze the requested page before credentials or PDF extraction can yield.
      const range = captureRange(p.reader, command);
      options.prepareContext = state => readRange(plugin, p, command, range, state);
    }
    return plugin.run(p, 'custom', command.prompt, options);
  }

  function edit(plugin, p) {
    const prefs = Zotero.Prefs, entries = read(prefs), doc = p.doc;
    const field = (label, input) => {
      const row = plugin.el(doc, 'label', 'pl-field');
      row.append(plugin.el(doc, 'span', '', label), input);
      return row;
    };
    const box = plugin.el(doc, 'section', 'pl-settings pl-command-editor');
    const picker = plugin.select(doc, [['', '＋ 新建指令'], ...entries.map(e => [e.id, e.name])], '', '选择要编辑的指令');
    const name = plugin.el(doc, 'input'), prompt = plugin.el(doc, 'textarea'), range = plugin.el(doc, 'input');
    name.maxLength = 40; name.placeholder = '例如：找出实验局限';
    prompt.rows = 4; prompt.maxLength = 4000; prompt.placeholder = '你希望模型如何处理这些原文？';
    const scope = plugin.select(doc, [...scopes], 'selection', '携带的原文');
    range.placeholder = '例如 3–7（按 PDF 实际页序，从 1 开始）';
    const rangeField = field('PDF 页码', range), status = plugin.el(doc, 'p', 'pl-status');
    status.setAttribute('role', 'status');
    const buttons = plugin.el(doc, 'div', 'pl-row');
    let before = null;
    const save = remove => {
      try {
        if (remove && !Services.prompt.confirm(null, '删除自定义指令', '删除按钮「' + before.name + '」？')) return;
        update(prefs, before, remove ? null : {name:name.value, prompt:prompt.value, scope:scope.value, range:range.value});
        box.remove();
        for (const panel of plugin.panels.values()) panel.refreshCommands?.();
        p.status.textContent = remove ? '已删除这条自定义指令。' : '已保存，可在阅读工具中点击指令按钮。';
      } catch (error) { status.textContent = error.message; }
    };
    const remove = plugin.button(doc, '删除指令', () => save(true));
    const populate = () => {
      before = entries.find(entry => entry.id === picker.value) || null;
      name.value = before?.name || ''; prompt.value = before?.prompt || '';
      scope.value = before?.scope || 'selection'; range.value = before?.range || '';
      rangeField.hidden = scope.value !== 'range'; remove.hidden = !before; status.textContent = '';
    };
    picker.addEventListener('change', populate);
    scope.addEventListener('change', () => { rangeField.hidden = scope.value !== 'range'; });
    buttons.append(plugin.button(doc, '保存指令', () => save(false), 'pl-button pl-primary'), remove,
      plugin.button(doc, '取消', () => box.remove()));
    box.append(plugin.el(doc, 'h2', '', '自定义快捷指令'), field('管理指令', picker), field('按钮名称', name),
      field('提示词', prompt), field('携带的原文', scope), rangeField,
      plugin.el(doc, 'p', 'pl-muted', '当前页跟随正在阅读的页面。页段和全文使用 PDF 文字层，超出输入上限时会提示调整范围。'),
      buttons, status);
    populate(); p.root.append(box); picker.focus?.();
  }

  function mount(plugin, p, host) {
    const group = plugin.el(p.doc, 'section', 'pl-command-group');
    const header = plugin.el(p.doc, 'div', 'pl-selection-header');
    header.append(plugin.el(p.doc, 'strong', '', '自定义快捷指令'), plugin.button(p.doc, '管理指令', () => edit(plugin, p)));
    const buttons = plugin.el(p.doc, 'div', 'pl-row');
    group.append(header, buttons); host.append(group);
    p.refreshCommands = () => {
      buttons.replaceChildren();
      try {
        const entries = read(Zotero.Prefs);
        if (!entries.length) buttons.append(plugin.el(p.doc, 'small', 'pl-muted', '在「管理指令」中新建你的第一个按钮。'));
        for (const entry of entries) {
          const button = plugin.button(p.doc, entry.name, () => execute(plugin, p, entry));
          button.title = scopeLabel(entry) + ' · ' + entry.prompt;
          buttons.append(button);
        }
      } catch (error) { buttons.append(plugin.el(p.doc, 'small', 'pl-muted', error.message)); }
    };
    p.refreshCommands();
  }

  const api = {mount, execute, read, update};
  root.PaperLensCommands = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
