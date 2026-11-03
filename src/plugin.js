/* Zotero 10 adapter. Formula engine is bundled; no remote runtime resources. */
var PaperLensPlugin = class {
  constructor(rootURI) {
    this.rootURI = rootURI;
    this.id = 'paper-lens@local.tools';
    this.panels = new Map(); this.sessions = new Map(); this.sessionLoads = new Map(); this.writes = new Map();
    this.cache = new Map(); this.requests = new Set(); this.runs = new Set(); this.nodes = new Set();
    this.lastPopups = new WeakMap();
    this.readerSelections = new WeakMap();
    this.selectionJobs = new Set();
    this.listeners = []; this.stopped = false;
  }
  get C() { return PaperLensCore; }
  config() {
    try { return {...this.C.DEFAULTS,...JSON.parse(Zotero.Prefs.get('paperLens.config')||'{}')}; }
    catch { return {...this.C.DEFAULTS}; }
  }
  async start() {
    const mathScope={};mathScope.globalThis=mathScope;
    Services.scriptloader.loadSubScript(this.rootURI+'src/vendor/katex.js',mathScope);
    this.math=mathScope.PaperLensKatex;
    this.css = await (await fetch(this.rootURI+'src/panel.css')).text();
    this.storage = PathUtils.join(Zotero.DataDirectory.dir,'paper-lens');
    await IOUtils.makeDirectory(this.storage,{ignoreExisting:true});
    const selection = event => {
      try {
        const {reader,doc,params,append}=event;
        const selected = this.copyPDFSelection(params.annotation);
        if (!selected) return;
        const wrap=doc.createElement('div'); wrap.className='paper-lens-popup';
        wrap.style.cssText='display:flex;gap:5px;flex-wrap:wrap;padding:7px 3px;border-top:1px solid #a0a0a055;max-width:300px';
        for(const [label,action] of [['翻译','translate'],['讲懂','explain'],['结合全文','context'],['更多…',null]]) {
          const b=doc.createElement('button'); b.textContent=label;b.type='button';
          b.style.cssText='padding:4px 8px;border:1px solid #8193a066;border-radius:5px;background:transparent;color:inherit;cursor:pointer';
          b.addEventListener('click',()=>this.open(reader,selected,action).catch(()=>this.alert('无法打开精读面板，请重新打开 PDF 后重试。')));
          wrap.append(b);
        }
        for(const node of this.nodes)if(!node.isConnected)this.nodes.delete(node);
        append(wrap); this.nodes.add(wrap);
        // Zotero requires append() to finish synchronously. Its popup can rerender on scroll.
        const observed = this.observeSelection(reader, selected, wrap.closest('.custom-sections'));
        this.selectionJobs.add(observed);
        observed.catch(error => {
          this.safeLog('save selected passage', error);
          const panel = this.panels.get(reader);
          if (panel && !panel.busy) panel.status.textContent = '段落暂未保存到本地，请检查会话文件。';
        }).finally(() => this.selectionJobs.delete(observed));
      } catch(e) { this.safeLog('selection hook',e); }
    };
    const toolbar = ({reader,doc,append}) => {
      try {
        const b=doc.createElement('button');b.textContent='循文';b.title='打开论文精读助手与 API 设置';
        b.addEventListener('click',()=>this.open(reader).catch(e=>this.safeLog('open',e)));
        append(b);this.nodes.add(b);
      } catch(e) {this.safeLog('toolbar hook',e);}
    };
    for(const [type,handler] of [['renderTextSelectionPopup',selection],['renderToolbar',toolbar]]) {
      Zotero.Reader.registerEventListener(type,handler,this.id);this.listeners.push([type,handler]);
    }
    for(const win of Zotero.getMainWindows()) this.addMenu(win);
    this.observer=Zotero.Notifier.registerObserver({notify:(event,type,ids)=>{
      if(type==='tab'&&event==='close') for(const [reader,p] of this.panels) if(ids.includes(reader.tabID)) this.disposePanel(reader,p);
    }},['tab'],'paper-lens');
  }
  addMenu(win) {
    if(win.document.getElementById('paper-lens-menu')) return;
    const popup=win.document.getElementById('menu_ToolsPopup'); if(!popup) return;
    const item=win.document.createXULElement('menuitem');item.id='paper-lens-menu';item.setAttribute('label','循文 · API 设置');
    item.addEventListener('command',()=>{
      const reader=Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
      if(reader) this.open(reader).then(p=>this.settings(p));
      else this.settingsWindow(win);
    });popup.append(item);this.nodes.add(item);
  }
  safeLog(stage,e) { Zotero.debug('Paper Lens: '+stage+' ('+(e?.name||'Error')+')'); }
  alert(text) { Services.prompt.alert(null,'循文 · Paper Lens',text); }
  el(doc,tag,cls,text) {
    const node=doc.createElementNS('http://www.w3.org/1999/xhtml',tag);
    if(cls) node.className=cls;if(text!==undefined) node.textContent=text;return node;
  }
  button(doc,text,fn,cls='pl-button') {
    const b=this.el(doc,'button',cls,text);b.type='button';
    b.addEventListener('click',()=>Promise.resolve().then(fn).catch(e=>this.alert(e.message||'操作未完成。')));return b;
  }
  async keyFor(baseURL) {
    const identity=this.C.endpoint(baseURL);
    const logins=Services.logins.findLogins('chrome://paper-lens',null,'Paper Lens API');
    return logins.find(x=>x.username===identity)?.password||'';
  }
  async setKey(baseURL,key) {
    const identity=this.C.endpoint(baseURL);
    const old=Services.logins.findLogins('chrome://paper-lens',null,'Paper Lens API').find(x=>x.username===identity);
    if(!key) {if(old) Services.logins.removeLogin(old);return;}
    const login=Components.classes['@mozilla.org/login-manager/loginInfo;1'].createInstance(Components.interfaces.nsILoginInfo);
    login.init('chrome://paper-lens',null,'Paper Lens API',identity,key,'','');
    if(old) Services.logins.modifyLogin(old,login);else await Services.logins.addLoginAsync(login);
  }
  attachment(reader) { return Zotero.Items.get(reader.itemID); }
  sessionID(reader) { const a=this.attachment(reader);return `${a.libraryID}-${a.key}`; }
  async session(reader) {
    const id=this.sessionID(reader);
    if(this.sessions.has(id))return this.sessions.get(id);
    if(!this.sessionLoads.has(id)) {
      const loading=(async()=>{
        let value={turns:[],pinned:null,selection:null,marks:{},passages:[]};
        if(this.config().remember) {
          try {
            const saved=await IOUtils.readJSON(PathUtils.join(this.storage,id+'.json'));
            if(!Array.isArray(saved.turns))throw new Error('Invalid session');
            const passages=PaperLensPassages.restore(saved);
            value={...value,...saved,passages};
            value.turns=saved.turns.filter(t=>t&&typeof t.answer==='string'&&typeof t.question==='string'&&t.selection&&typeof t.selection.text==='string')
              .filter(t=>!t.pending||t.answer).slice(-30).map(t=>t.pending?{...t,pending:false,partial:true,recovered:true}:t);
            if(!value.marks||typeof value.marks!=='object'||Array.isArray(value.marks))value.marks={};
            if(value.selection&&typeof value.selection.text!=='string')value.selection=null;
            if(value.pinned&&typeof value.pinned.text!=='string')value.pinned=null;
            for(const key of ['selection','pinned'])if(value[key]){
              const cached=PaperLensPassages.find(value,value[key]);
              if(cached)value[key]={...value[key],id:cached.id};
              else delete value[key].id;
            }
          } catch(e) {
            if(e.name!=='NotFoundError')value.loadWarning='本地会话未能读取。原文件未删除；导出或继续操作前请检查备份。';
          }
        }
        this.sessions.set(id,value);return value;
      })();
      this.sessionLoads.set(id,loading);
    }
    try {return await this.sessionLoads.get(id);}finally{this.sessionLoads.delete(id);}
  }
  persist(reader,force=false) {
    const id=this.sessionID(reader),session=this.sessions.get(id);
    if(!session) return Promise.resolve();
    const clearRequested = force && !session.selection && !session.pinned && !session.turns.length &&
      !session.passages?.length && !Object.keys(session.marks).length;
    if (!clearRequested && !this.config().remember) return Promise.resolve();
    // Preserve an unreadable file rather than silently replacing it with an empty session.
    if(session.loadWarning&&!force)return Promise.reject(new Error(session.loadWarning));
    const completed=session.turns.filter(t=>!t.pending).slice(-30);
    const turns=session.turns.filter(t=>t.pending||completed.includes(t));
    const marks=Object.fromEntries(turns.filter(t=>session.marks[t.id]).map(t=>[t.id,session.marks[t.id]]));
    const snapshot=JSON.stringify({version:PaperLensPassages.VERSION,selection:session.selection,pinned:session.pinned,passages:session.passages??[],marks,turns});
    const path=PathUtils.join(this.storage,id+'.json');
    const pending=(this.writes.get(id)||Promise.resolve()).catch(()=>{}).then(()=>{
      if(clearRequested || this.config().remember)return IOUtils.writeUTF8(path,snapshot,{tmpPath:path+'.tmp'});
    });
    this.writes.set(id,pending);return pending;
  }
  scheduleCheckpoint(p) {
    if(!this.config().remember||p.checkpointTimer!=null)return;
    p.checkpointTimer=p.reader._window.setTimeout(()=>{
      p.checkpointTimer=null;
      this.persist(p.reader).catch(()=>{p.saveFailed=true;if(!p.disposed)p.status.textContent='部分回答暂存失败；请完成后导出会话。';});
    },3000);
  }
  cancelCheckpoint(p) {
    if(p.checkpointTimer!=null){p.reader._window.clearTimeout(p.checkpointTimer);p.checkpointTimer=null;}
  }
  updateSessionViews(session,except=null) {
    for(const panel of this.panels.values())if(panel.session===session&&panel!==except&&!panel.busy&&!panel.disposed){
      this.renderFeed(panel);this.renderSelection(panel);
    }
  }
  exportData(p,format='json') {
    const a=this.attachment(p.reader),link=page=>this.C.sourceLink(a.libraryID,Zotero.Libraries.userLibraryID,
      a.libraryID===Zotero.Libraries.userLibraryID?null:Zotero.Groups.getGroupIDFromLibraryID(a.libraryID),a.key,page);
    const session=p.session;
    const data={format:'paper-lens-session',version:PaperLensPassages.VERSION,exportedAt:new Date().toISOString(),attachment:{libraryID:a.libraryID,key:a.key},
      selection:session.selection,pinned:session.pinned,passages:session.passages??[],marks:session.marks,turns:session.turns};
    if(format==='json')return JSON.stringify(data,null,2);
    const lines=['# 循文阅读记录','',`导出时间：${data.exportedAt}`,''];
    if(data.passages.length){
      lines.push('## 已缓存段落','');
      for(const [index,passage] of data.passages.entries()){
        const page=passage.pageIndex+1;
        const range=passage.nextPageRects?.length?`${page}–${page+1}`:String(page);
        lines.push(`### ${index+1}. [PDF 第 ${range} 页](${link(passage.pageIndex)})`,'',
          ...passage.text.split('\n').map(line=>'> '+line),'');
      }
    }
    for(const t of session.turns){
      lines.push(`## ${t.question.replace(/\n/g,' ')}`,'',`${t.model||''} · ${new Date(t.time).toISOString()}${t.partial?' · 未完成':''}`,'',
        `[返回选段：PDF 第 ${t.selection.pageIndex+1} 页](${link(t.selection.pageIndex)})`,'',
        ...t.selection.text.split('\n').map(s=>'> '+s),'',t.answer,'');
      if(t.pinned)lines.push(`### 暂存段落（PDF 第 ${t.pinned.pageIndex+1} 页）`,'',...t.pinned.text.split('\n').map(s=>'> '+s),'');
      for(const s of t.sources||[])lines.push(`### [${s.id}](${link(s.pageIndex)})`,'',...s.text.split('\n').map(x=>'> '+x),'');
      if(session.marks[t.id])lines.push(`理解标记：${session.marks[t.id]}`,'');
    }
    return lines.join('\n');
  }
  async exportSession(p,format='json') {
    if(!['json','md'].includes(format))throw new Error('不支持的导出格式。');
    const {FilePicker}=ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
    const picker=new FilePicker();picker.init(p.reader._window,'导出循文会话',picker.modeSave);
    picker.appendFilter(format==='json'?'JSON 备份（含原文依据）':'Markdown 阅读笔记','*.'+format);
    picker.defaultString=`paper-lens-${this.sessionID(p.reader)}.${format}`;picker.defaultExtension=format;
    const result=await picker.show();if(result!==picker.returnOK&&result!==picker.returnReplace)return;
    if(!picker.file.toLowerCase().endsWith('.'+format))throw new Error(`请使用 .${format} 扩展名保存，以免混淆文件格式。`);
    await IOUtils.writeUTF8(picker.file,this.exportData(p,format),{tmpPath:picker.file+'.tmp'});
    p.status.textContent=`会话已导出为 ${format==='md'?'Markdown':'JSON'}。`;
  }
  copyPDFSelection(annotation) {
    const text = this.C.cleanText(annotation?.text);
    if (!text) return null;
    const position = annotation.position;
    const selection = {text, pageIndex: position?.pageIndex ?? 0};
    // Read the content window's numbers directly. Calling its Array.map with a
    // privileged callback can fail, and would retain foreign arrays in the session.
    for (const field of ['rects', 'nextPageRects']) {
      const source = position?.[field];
      if (!source?.length) continue;
      const rectangles = [];
      for (let i = 0; i < source.length; i++) {
        const rect = source[i];
        if (rect?.length === 4) rectangles.push([rect[0], rect[1], rect[2], rect[3]]);
      }
      if (rectangles.length) selection[field] = rectangles;
    }
    return selection;
  }
  async observeSelection(reader, selected, popup) {
    if (this.stopped) return;
    const previous = this.lastPopups.get(reader);
    if (previous?.popup === popup && previous?.selection.text === selected.text &&
        PaperLensPassages.same(previous.selection, selected)) return;
    this.lastPopups.set(reader, {popup, selection:selected});
    const session = this.panels.get(reader)?.session ?? this.sessions.get(this.sessionID(reader)) ?? await this.session(reader);
    if (this.stopped || reader._isUninitialized || reader._isTabClosed) {
      PaperLensPassages.remember(session, selected);
    } else {
      this.selectPassage(reader, session, selected);
    }
    await this.persist(reader);
  }
  selectPassage(reader, session, selected) {
    const panel = this.panels.get(reader);
    if (panel?.selected?.text && !panel.selected.id) PaperLensPassages.remember(session, panel.selected);
    const entry = PaperLensPassages.remember(session, selected);
    const current = {...(entry || selected)};
    this.readerSelections.set(reader, current);
    session.selection = current;
    if (panel) {
      panel.selected = current;
      panel.passagePage = 0;
      if (!entry && !panel.busy && selected.text.length > PaperLensPassages.MAX_TEXT) {
        panel.status.textContent = '当前选段超过 20,000 字，请缩小选区后加入缓存。';
      }
    }
    this.refreshPassageViews(session);
    return current;
  }
  refreshPassageViews(session) {
    for (const panel of this.panels.values()) {
      if (panel.session === session && !panel.disposed) this.renderSelection(panel);
    }
  }
  async commitEditedPassage(panel) {
    this.selectPassage(panel.reader, panel.session, panel.selected);
    await this.persist(panel.reader);
  }
  async restorePassage(panel, entry) {
    const saved = panel.session.passages.find(passage => passage.id === entry.id);
    if (!saved) return;
    this.selectPassage(panel.reader, panel.session, saved);
    await this.persist(panel.reader);
  }
  async removePassage(panel, entry) {
    const session = panel.session;
    if (!PaperLensPassages.remove(session, entry.id)) return;
    const replacement = session.passages[0] || null;
    if (session.selection?.id === entry.id) session.selection = replacement;
    if (PaperLensPassages.same(session.pinned, entry)) session.pinned = null;
    for (const other of this.panels.values()) {
      if (other.session === session && other.selected?.id === entry.id) {
        other.selected = replacement;
        this.readerSelections.set(other.reader, replacement);
      }
    }
    this.refreshPassageViews(session);
    await this.persist(panel.reader);
  }
  clearSelections(session) {
    session.passages = [];
    session.selection = null;
    for (const panel of this.panels.values()) {
      if (panel.session === session) {
        panel.selected = null;
        this.readerSelections.delete(panel.reader);
        if (panel.sources) panel.sources.replaceChildren(this.el(panel.doc,'summary','','本次使用的原文'));
        panel.status.textContent = '已清空这篇论文的阅读记录。';
      }
    }
  }
  async open(reader,selected,action) {
    if(this.stopped)throw new Error('插件已停止。');
    let p=this.panels.get(reader);
    if(!p||!p.root.isConnected) {
      const session=await this.session(reader);
      if(this.stopped||reader._isUninitialized||reader._isTabClosed)throw new Error('阅读器已关闭或插件已停止。');
      // A second click may arrive while the session is loading.
      p=this.panels.get(reader);
      if(!p||!p.root.isConnected) {
        p=this.makePanel(reader,session);
        const recent = this.readerSelections.get(reader);
        if (recent?.id && session.passages?.some(entry => entry.id === recent.id)) {
          p.selected = recent;
          this.renderSelection(p);
        }
      }
    }
    p.root.hidden=false;
    if (!selected && !this.lastPopups.has(reader) && p.session.version !== PaperLensPassages.VERSION) {
      // A selection popup may already be on screen when the plugin is installed.
      const internal = reader._internalReader || reader._iframeWindow?.wrappedJSObject?.reader;
      const popupKey = internal?._lastViewPrimary === false ? 'secondaryViewSelectionPopup' : 'primaryViewSelectionPopup';
      const highlighted = this.copyPDFSelection(internal?._state?.[popupKey]?.annotation);
      if (highlighted) await this.observeSelection(reader, highlighted, null);
    }
    if(selected) {
      const current = this.selectPassage(reader, p.session, selected);
      // Reserve the action before an asynchronous save can admit another click.
      if(action && !p.busy){await this.run(p,action,'',{selection:{...current}});return p;}
      await this.persist(reader);
      return p;
    }
    if(action) await this.run(p,action);
    return p;
  }
  saveReadingPrefs(patch) {
    const saved={...this.config()},allowed={
      depth:['basic','standard','advanced'],scope:['selection','page','related'],answerLength:['brief','standard','detailed']
    };
    for(const [key,values] of Object.entries(allowed))if(values.includes(patch[key]))saved[key]=patch[key];
    for(const [key,min,max] of [['panelWidth',300,760],['fontSize',12,20]]) {
      if(Number.isFinite(Number(patch[key])))saved[key]=Math.min(max,Math.max(min,Math.round(Number(patch[key]))));
    }
    if(typeof patch.selectionCollapsed==='boolean')saved.selectionCollapsed=patch.selectionCollapsed;
    // Reading controls never read or store Login Manager credentials.
    for(const key of ['key','apiKey','api_key','password','token'])delete saved[key];
    Zotero.Prefs.set('paperLens.config',JSON.stringify(saved));return saved;
  }
  setPanelWidth(p,width,remember=false) {
    width=Math.min(760,Math.max(300,Math.round(Number(width)||410)));
    p.panelWidth=width;p.root.style.width=width+'px';p.root.style.flexBasis=width+'px';
    p.resize?.setAttribute('aria-valuenow',String(width));
    if(remember)this.saveReadingPrefs({panelWidth:width});
  }
  setReadingFont(p,size,remember=false) {
    size=Math.min(20,Math.max(12,Math.round(Number(size)||13)));
    p.fontSize=size;p.root.style.setProperty('--pl-font-size',size+'px');
    if(p.smaller)p.smaller.disabled=size<=12;if(p.larger)p.larger.disabled=size>=20;
    if(remember)this.saveReadingPrefs({fontSize:size});
  }
  setSelectionCollapsed(p,collapsed,remember=false) {
    p.selectionBody.hidden=!!collapsed;p.collapse.textContent=collapsed?'展开选段':'折叠选段';
    p.collapse.setAttribute('aria-expanded',String(!collapsed));
    if(remember)this.saveReadingPrefs({selectionCollapsed:!!collapsed});
  }
  captureFeedPosition(p) {
    const position={top:p.feed.scrollTop,follow:p.feed.scrollHeight-p.feed.scrollTop-p.feed.clientHeight<90};
    const edge=p.feed.getBoundingClientRect?.().top;
    if(Number.isFinite(edge))for(const [key,view] of p.turnViews||[]) {
      const rect=view.card.getBoundingClientRect();
      if(rect.bottom>edge){position.key=key;position.offset=rect.top-edge;break;}
    }
    return position;
  }
  restoreFeedPosition(p,position) {
    if(position.follow){p.feed.scrollTop=p.feed.scrollHeight;return;}
    const view=p.turnViews?.get(position.key);
    if(view&&Number.isFinite(position.offset)) {
      p.feed.scrollTop+=view.card.getBoundingClientRect().top-p.feed.getBoundingClientRect().top-position.offset;
    } else p.feed.scrollTop=position.top;
  }
  refreshTurn(p,view,t) {
    view.turn=t;
    if(view.answer!==t.answer){this.renderAnswer(p,view.content,t.answer,t.sources||[],t.selection||{pageIndex:0},t.pinned);view.answer=t.answer;}
    const mark=p.session.marks[t.id]||'';
    view.meta.textContent=`${t.model||''} · ${new Date(t.time).toLocaleString()}${t.pending?' · 正在生成':t.recovered?' · 已恢复未完成回答':t.partial?' · 未完成':''}${mark?' · '+mark:''}`;
    const state=[!!t.pending,!!t.partial,!!t.answer,t.action||'',t.question||''].join('|');
    if(view.actionState===state)return;view.actionState=state;view.buttons.replaceChildren();
    if(t.pending)return;
    const buttons=view.buttons;
    if(t.partial&&t.answer)buttons.append(this.button(p.doc,'继续回答',()=>this.resume(p,view.turn),'pl-button pl-primary'));
    if(t.answer&&!t.partial) {
      const translation=t.action==='translate'||(!t.action&&t.question==='翻译');
      buttons.append(this.button(p.doc,translation?'拆解长句':'深入展开',()=>this.expandTurn(p,view.turn,translation)));
    }
    buttons.append(this.button(p.doc,'保存笔记',()=>this.saveNote(p,view.turn)),this.button(p.doc,'复制',()=>{
      Components.classes['@mozilla.org/widget/clipboardhelper;1'].getService(Components.interfaces.nsIClipboardHelper).copyString(view.turn.answer);
      p.status.textContent='已复制回答。';
    }));
    for(const label of ['已懂','仍有疑问'])buttons.append(this.button(p.doc,label,async()=>{
      p.session.marks[view.turn.id]=label;await this.persist(p.reader);
      if(this.updateSessionViews)this.updateSessionViews(p.session);else this.refreshTurn(p,view,view.turn);
    }));
  }
  async expandTurn(p,t,translation=false) {
    if(p.busy||t.pending)return;
    await this.run(p,translation?'breakdown':'ask',translation?'请拆解这段原文中难懂的长句。':'请在上一条回答的基础上深入展开，补充关键推理和必要的例子。',{
      selection:{...t.selection},sources:t.sources||[],history:[t],pinned:t.pinned||null,scope:t.scope||'related',answerLength:'detailed',depth:t.depth||p.depth.value
    });
  }
  makePanel(reader,session) {
    const doc=reader._window.document;
    const root=this.el(doc,'aside','pl-root');root.setAttribute('aria-label','循文论文精读助手');
    const style=this.el(doc,'style');style.textContent=this.css;root.append(style);
    const header=this.el(doc,'header','pl-header');
    const brand=this.el(doc,'div');brand.append(this.el(doc,'strong','pl-brand','循文'),this.el(doc,'span','pl-caption','PAPER LENS'));
    const controls=this.el(doc,'div','pl-row');header.append(brand,controls);root.append(header);
    const p={reader,root,doc,session,selected:session.selection?{...session.selection}:null,busy:false,turnViews:new Map()};this.panels.set(reader,p);
    const cfg=this.config();
    p.smaller=this.button(doc,'A−',()=>this.setReadingFont(p,p.fontSize-1,true));p.smaller.setAttribute('aria-label','缩小回答字号');p.smaller.title='缩小回答字号';
    p.larger=this.button(doc,'A+',()=>this.setReadingFont(p,p.fontSize+1,true));p.larger.setAttribute('aria-label','增大回答字号');p.larger.title='增大回答字号';
    controls.append(p.smaller,p.larger,this.button(doc,'设置',()=>this.settings(p)),this.button(doc,'收起',()=>{root.hidden=true;}));
    const resize=this.el(doc,'div','pl-resize');p.resize=resize;resize.tabIndex=0;
    resize.setAttribute('role','separator');resize.setAttribute('aria-label','调整阅读面板宽度，左右方向键可调整');resize.setAttribute('aria-orientation','vertical');resize.setAttribute('aria-valuemin','300');resize.setAttribute('aria-valuemax','760');resize.title='拖动调整宽度；方向键每次调整 20 像素';
    let drag=null;
    resize.addEventListener('pointerdown',e=>{if(e.button!==0)return;drag={x:e.clientX,width:root.getBoundingClientRect().width,id:e.pointerId};resize.setPointerCapture(e.pointerId);root.classList.add('pl-resizing');e.preventDefault();});
    resize.addEventListener('pointermove',e=>{if(drag&&e.pointerId===drag.id)this.setPanelWidth(p,drag.width+drag.x-e.clientX);});
    const finishResize=()=>{if(!drag)return;drag=null;root.classList.remove('pl-resizing');this.saveReadingPrefs({panelWidth:p.panelWidth});};
    resize.addEventListener('pointerup',finishResize);resize.addEventListener('pointercancel',finishResize);resize.addEventListener('lostpointercapture',finishResize);
    resize.addEventListener('keydown',e=>{const visible=root.getBoundingClientRect().width,widths={ArrowLeft:visible+20,ArrowRight:visible-20,Home:300,End:760};if(e.key in widths){e.preventDefault();this.setPanelWidth(p,widths[e.key],true);}});root.append(resize);
    const source=this.el(doc,'section','pl-selection');
    const sourceHeader=this.el(doc,'div','pl-selection-header');
    p.page=this.el(doc,'button','pl-page');p.page.type='button';p.page.addEventListener('click',()=>{if(p.selected)this.navigateSource(p,p.selected).catch(()=>{p.status.textContent='暂时无法定位原文，请等待 PDF 加载后重试。';});});
    p.collapse=this.button(doc,'折叠选段',()=>this.setSelectionCollapsed(p,!p.selectionBody.hidden,true),'pl-button pl-collapse');
    sourceHeader.append(p.page,p.collapse);source.append(sourceHeader);
    const sourceBody=this.el(doc,'div');p.selectionBody=sourceBody;
    p.selection=this.el(doc,'textarea','pl-selected');p.selection.setAttribute('aria-label','当前选段，可纠正公式识别');p.selection.rows=4;
    const readEditedSelection = () => {
      p.selected = {...(p.selected || {pageIndex:0}), text:p.selection.value};
      for (const field of ['id', 'position', 'rects', 'nextPageRects', 'sourceText']) delete p.selected[field];
    };
    p.selection.addEventListener('input', () => { if (!p.busy) readEditedSelection(); });
    p.selection.addEventListener('change', () => {
      if (p.busy) return;
      readEditedSelection();
      this.commitEditedPassage(p).catch(() => { p.status.textContent='选段暂未保存，请稍后重试。'; });
    });
    sourceBody.append(p.selection);
    const pinRow=this.el(doc,'div','pl-row');p.pinRow=pinRow;
    pinRow.append(this.button(doc,'设为比较段',async()=>{if(!p.selected?.text)return;if(p.selected.text.length>20000)throw new Error('比较段请控制在 20,000 字内。');session.pinned={...p.selected};await this.persist(reader);if(this.updateSessionViews)this.updateSessionViews(session);else this.renderSelection(p);}),this.button(doc,'清除比较段',async()=>{session.pinned=null;await this.persist(reader);if(this.updateSessionViews)this.updateSessionViews(session);else this.renderSelection(p);}));
    p.pin=this.el(doc,'small','pl-muted');sourceBody.append(pinRow,p.pin);source.append(sourceBody);
    p.passageCache = this.el(doc, 'details', 'pl-passage-cache');
    p.passageSummary = this.el(doc, 'summary');
    p.passageList = this.el(doc, 'ul', 'pl-passage-list');
    p.passageList.setAttribute('aria-label', '已缓存的段落');
    p.passagePage = 0;
    p.passageNav = this.el(doc, 'div', 'pl-passage-nav');
    const changePage = step => {
      p.passagePage += step;
      this.renderPassageCache(p);
      p.passageList.scrollTop = 0;
    };
    p.passagePrev = this.button(doc, '上一页', () => changePage(-1));
    p.passageNext = this.button(doc, '下一页', () => changePage(1));
    p.passagePageLabel = this.el(doc, 'span');
    p.passageNav.append(p.passagePrev, p.passagePageLabel, p.passageNext);
    p.passageCache.append(p.passageSummary, p.passageList, p.passageNav);
    p.passageCache.addEventListener('toggle', () => this.renderPassageCache(p));
    source.append(p.passageCache);root.append(source);
    const options=this.el(doc,'div','pl-options');
    p.depth=this.select(doc,[['basic','从基础讲'],['standard','专业基础'],['advanced','深入原理']],cfg.depth,'解释深度');
    p.length=this.select(doc,[['brief','简短回答'],['standard','适中长度'],['detailed','详细展开']],cfg.answerLength||'brief','回答长度');
    p.scope=this.select(doc,[['selection','只发选段'],['page','当前页'],['related','全文检索相关段落']],cfg.scope,'发送上下文范围');
    for(const [key,control] of [['depth',p.depth],['answerLength',p.length],['scope',p.scope]])control.addEventListener('change',()=>this.saveReadingPrefs({[key]:control.value}));
    options.append(p.depth,p.length,p.scope);root.append(options);
    const actions=this.el(doc,'nav','pl-actions');actions.setAttribute('aria-label','精读操作');
    for (const action of ['translate', 'explain', 'context']) {
      actions.append(this.button(doc, this.C.ACTIONS[action][0], () => this.run(p, action)));
    }
    const more=this.select(doc,[['','更多精读功能…'],...Object.entries(this.C.ACTIONS).filter(([k])=>!['translate','explain','context','ask','continue'].includes(k)).map(([k,v])=>[k,v[0]])],'','更多精读功能');
    more.addEventListener('change',()=>{const v=more.value;more.value='';if(v)this.run(p,v);});actions.append(more);root.append(actions);
    p.status=this.el(doc,'div','pl-status',session.loadWarning||'选择操作开始精读 · 仅在点击后发送内容');p.status.setAttribute('role','status');root.append(p.status);
    p.sources=this.el(doc,'details','pl-sources');p.sources.append(this.el(doc,'summary','','本次使用的原文'));root.append(p.sources);
    p.feed=this.el(doc,'div','pl-feed');p.feed.setAttribute('aria-label','阅读对话');root.append(p.feed);
    const compose=this.el(doc,'footer','pl-compose');p.question=this.el(doc,'textarea');p.question.placeholder='追问、回答自测，或描述你卡住的地方…';p.question.rows=2;p.question.setAttribute('aria-label','追问');
    p.question.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'&&!e.isComposing){e.preventDefault();const q=p.question.value.trim();if(q)this.run(p,'ask',q);}});
    const suggestions=this.el(doc,'div','pl-row pl-suggestions');
    for(const q of ['举个例子','从基础讲起','与前文有什么关系？'])suggestions.append(this.button(doc,q,()=>{p.question.value=q;p.question.focus();}));
    compose.append(suggestions);
    const sendRow=this.el(doc,'div','pl-row pl-send-row');
    p.send=this.button(doc,'发送追问',()=>{const q=p.question.value.trim();if(q)this.run(p,'ask',q);},'pl-button pl-primary');
    p.cancel=this.button(doc,'停止',()=>{p.cancelled=true;p.abort?.();});p.cancel.disabled=true;
    p.export=this.select(doc,[['','导出会话…'],['json','JSON 备份'],['md','Markdown 笔记']],'','导出会话格式');
    p.export.addEventListener('change',()=>{const format=p.export.value;p.export.value='';if(format)this.exportSession(p,format).catch(e=>{p.status.textContent=e.message||'会话导出失败，请重试。';});});
    sendRow.append(p.send,p.cancel,p.export,this.button(doc,'清空会话',async()=>{
      if([...this.panels.values()].some(other=>other.session===session&&other.busy)){p.status.textContent='这篇论文仍有回答正在生成，请停止后再清空。';return;}
      if(!Services.prompt.confirm(null,'清空当前论文会话','清除这篇论文的对话、当前选段、段落缓存、比较段和理解标记？已保存的 Zotero 笔记不受影响。')) return;
      session.turns=[];session.pinned=null;session.marks={};this.clearSelections(session);delete session.loadWarning;await this.persist(reader,true);if(this.updateSessionViews)this.updateSessionViews(session);else{this.renderFeed(p);this.renderSelection(p);}
    }));compose.append(p.question,sendRow);root.append(compose);
    // A chrome sibling keeps the API request outside the unprivileged PDF iframe.
    const iframe=reader._iframe || doc.getElementById('reader');
    if(!iframe?.parentElement)throw new Error('当前阅读器没有可挂载的面板位置。');
    const host=iframe.parentElement;
    p.host=host;p.originalDisplay=host.style.display;p.originalDirection=host.style.flexDirection;
    host.style.display='flex';host.style.flexDirection='row';
    this.setPanelWidth(p,cfg.panelWidth);this.setReadingFont(p,cfg.fontSize);this.setSelectionCollapsed(p,cfg.selectionCollapsed);host.append(root);
    this.renderSelection(p);this.renderFeed(p);
    return p;
  }
  select(doc,choices,value,label) {
    const s=this.el(doc,'select');s.setAttribute('aria-label',label);
    for(const [v,t] of choices){const o=this.el(doc,'option','',t);o.value=v;s.append(o);}s.value=value;return s;
  }
  renderSelection(p) {
    const s=p.selected;if(p.selection.value!==(s?.text||''))p.selection.value=s?.text||'';
    if(p.pinRow)p.pinRow.lastElementChild.hidden=!p.session.pinned;
    p.selection.placeholder='在 PDF 中选中文字，或在这里粘贴需要解释的内容。';
    p.page.textContent=s?`选段 · PDF 第 ${s.pageIndex+1} 页 ↗`:'当前选段';p.page.disabled=!s?.text;
    p.pin.textContent=p.session.pinned?`比较段 · 第 ${p.session.pinned.pageIndex+1} 页　${p.session.pinned.text.slice(0,65)}`:'设好比较段后，可选另一段进行跨段比较。';
    this.renderPassageCache(p);
  }
  renderPassageCache(p) {
    if (!p.passageCache) return;
    const entries = p.session.passages || [];
    p.passageSummary.textContent = `段落缓存（${entries.length}）`;
    if (!p.passageCache.open) {
      p.passagePage = 0;
      p.passageList.replaceChildren();
      return;
    }
    const pageSize = 8;
    const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
    p.passagePage = Math.max(0, Math.min(pageCount - 1, p.passagePage));
    p.passagePageLabel.textContent = `${p.passagePage + 1} / ${pageCount}`;
    p.passagePrev.disabled = p.passagePage === 0;
    p.passageNext.disabled = p.passagePage === pageCount - 1;
    p.passageNav.hidden = pageCount === 1;

    const start = p.passagePage * pageSize;
    const rows = entries.slice(start, start + pageSize).map(entry => {
      const page = `PDF 第 ${entry.pageIndex + 1} 页`;
      const current = p.selected?.id === entry.id && p.selected?.text === entry.text;
      const row = this.el(p.doc, 'li', 'pl-cached-passage');
      const info = this.el(p.doc, 'div', 'pl-cached-info');
      const characters = Array.from(entry.text.trim().replace(/\s+/g, ' '));
      const preview = characters.slice(0, 80).join('') + (characters.length > 80 ? '…' : '');
      info.append(this.el(p.doc, 'small', 'pl-cache-page', current ? `${page} · 当前选段` : page),
        this.el(p.doc, 'p', 'pl-cache-preview', preview));
      const controls = this.el(p.doc, 'div', 'pl-cache-buttons');
      const restore = this.button(p.doc, '恢复', () => this.restorePassage(p, entry));
      const remove = this.button(p.doc, '删除', () => this.removePassage(p, entry));
      restore.setAttribute('aria-label', `恢复${page}的段落「${preview}」`);
      remove.setAttribute('aria-label', `删除${page}的缓存段落「${preview}」`);
      controls.append(restore, remove);
      row.append(info, controls);
      return row;
    });
    if (!rows.length) rows.push(this.el(p.doc, 'li', 'pl-cache-empty', '还没有缓存段落。'));
    const scrollTop = p.passageList.scrollTop;
    p.passageList.replaceChildren(...rows);
    p.passageList.scrollTop = scrollTop;
  }
  renderFeed(p) {
    const position=this.captureFeedPosition(p);if(!p.feedRendered)position.follow=true;
    p.turnViews ||= new Map();p.updatingFeed=true;
    try {
      const keys=new Set(p.session.turns.map(t=>t.id||t));
      for(const [key,view] of p.turnViews)if(!keys.has(key)){view.card.remove();p.turnViews.delete(key);}
      if(!p.session.turns.length) {
        if(!p.empty){p.empty=this.el(p.doc,'p','pl-empty','从一句话开始，把概念、方法与证据连起来。\n\n选择“讲懂这段”，或在“更多”里追踪符号、拆解公式、演示方法。');p.feed.append(p.empty);}
      } else {
        p.empty?.remove();p.empty=null;
        for(const t of p.session.turns){const view=p.turnViews.get(t.id||t);if(view)this.refreshTurn(p,view,t);else this.appendTurn(p,t);}
      }
    } finally {p.updatingFeed=false;p.feedRendered=true;}
    this.restoreFeedPosition(p,position);
  }
  renderAnswer(p,target,text,sources,selection,pinned) {
    target.replaceChildren();
    const available=new Map(sources.map(s=>[s.id,s]));available.set('选段',selection);if(pinned)available.set('暂存',pinned);
    const formatted=(parent,value,depth=0)=>{
      if(depth>3){parent.append(p.doc.createTextNode(value));return;}
      const pattern=/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[(?:P\d+-\d+|选段|暂存)\])/g;let pos=0;
      for(const match of value.matchAll(pattern)) {
        parent.append(p.doc.createTextNode(value.slice(pos,match.index)));const token=match[0];
        if(token.startsWith('`'))parent.append(this.el(p.doc,'code','',token.slice(1,-1)));
        else if(token.startsWith('**')){const strong=this.el(p.doc,'strong');inline(strong,token.slice(2,-2),depth+1);parent.append(strong);}
        else {const id=token.slice(1,-1);if(available.has(id))parent.append(this.button(p.doc,token,()=>this.navigateSource(p,available.get(id)),'pl-citation'));else parent.append(p.doc.createTextNode(token+'（来源未提供）'));}
        pos=match.index+token.length;
      }
      parent.append(p.doc.createTextNode(value.slice(pos)));
    };
    const inline=(parent,value,depth=0)=>{
      for(const part of PaperLensMath.splitInline(value)) {
        if(part.type==='math')this.renderMath(p,parent,part.text,part.display,part.raw);
        else if(part.type==='code')parent.append(this.el(p.doc,'code','',part.text));
        else formatted(parent,part.text,depth);
      }
    };
    for(const block of this.C.markdownBlocks(text)) {
      if(block.type==='math'){this.renderMath(p,target,block.text,true,block.raw);continue;}

      if(block.type==='rule'){target.append(this.el(p.doc,'hr'));continue;}
      if(block.type==='code'){const pre=this.el(p.doc,'pre');pre.append(this.el(p.doc,'code','',block.text));target.append(pre);continue;}
      if(block.type==='list'){const list=this.el(p.doc,block.ordered?'ol':'ul');if(block.ordered)list.setAttribute('start',String(block.start));for(const value of block.items){const li=this.el(p.doc,'li');inline(li,value);list.append(li);}target.append(list);continue;}
      if(block.type==='table'){
        const wrap=this.el(p.doc,'div','pl-table-wrap'),table=this.el(p.doc,'table');
        for(const [index,row] of [block.header,...block.rows].entries()){const tr=this.el(p.doc,'tr');for(const value of row){const td=this.el(p.doc,index===0?'th':'td');inline(td,value);tr.append(td);}table.append(tr);}wrap.append(table);target.append(wrap);continue;
      }
      const node=this.el(p.doc,block.type==='heading'?'h'+block.level:block.type==='quote'?'blockquote':'p');inline(node,block.text);target.append(node);
    }
  }
  renderMath(p,parent,tex,display,raw) {
    const node=this.el(p.doc,'span',display?'pl-math pl-math-display':'pl-math');
    node.title=tex;node.setAttribute('aria-label',tex);
    try {
      const markup=PaperLensMath.mathML(this.math,tex,display);
      // Only import the MathML subtree generated by the bundled parser, never model HTML.
      const parsed=new DOMParser().parseFromString(markup,'application/xml');
      const math=parsed.getElementsByTagNameNS('http://www.w3.org/1998/Math/MathML','math')[0];
      if(!math||parsed.getElementsByTagName('parsererror').length)throw new Error('公式解析失败');
      node.append(p.doc.importNode(math,true));
    } catch {
      node.classList.add('pl-math-fallback');node.textContent=raw||tex;
      node.title='无法排版或公式尚未完整，已保留 LaTeX 原文。';
    }
    parent.append(node);
  }
  async resume(p,t) {
    if(p.busy)return;
    await this.run(p,'continue','从上次正文中断的位置继续，不要重复已写内容。',{selection:{...t.selection},sources:t.sources||[],history:[t],pinned:t.pinned||null,scope:t.scope||'related',answerLength:t.answerLength||'detailed',depth:t.depth||p.depth?.value});
  }

  appendTurn(p,t) {
    const position=this.captureFeedPosition(p);p.empty?.remove();p.empty=null;
    const card=this.el(p.doc,'article','pl-turn');
    card.append(this.el(p.doc,'div','pl-turn-title',t.question));
    const content=this.el(p.doc,'div','pl-answer');
    card.append(content);
    const meta=this.el(p.doc,'small','pl-muted');card.append(meta);
    const buttons=this.el(p.doc,'div','pl-row');
    const view={card,content,meta,buttons,turn:t};
    const evidence=this.el(p.doc,'details','pl-turn-sources');evidence.append(this.el(p.doc,'summary','','查看这条回答的选段与依据'));
    let loaded=false;evidence.addEventListener('toggle',()=>{if(evidence.open&&!loaded){loaded=true;const source=view.turn,holder=this.el(p.doc,'div');this.renderSources({...p,sources:holder},source.sources||[],source.selection||{text:'',pageIndex:0},source.pinned,!!source.pinned);evidence.append(holder);}});
    card.append(evidence,buttons);p.feed.append(card);p.turnViews ||= new Map();p.turnViews.set(t.id||t,view);this.refreshTurn(p,view,t);
    if(!p.updatingFeed)this.restoreFeedPosition(p,position);return view;
  }
  async readPageText(reader,pageIndex,rects=null) {
    const internal=reader._internalReader || reader._iframeWindow?.wrappedJSObject?.reader;
    const view=internal?._primaryView,pdf=view?._iframeWindow?.PDFViewerApplication?.pdfDocument;
    if(!pdf)throw new Error('当前 PDF 文本接口不可用。请等待 PDF 加载后重试。');
    if(!Number.isInteger(pageIndex)||pageIndex<0||pageIndex>=pdf.numPages)throw new Error('选段页码无效，请重新选择原文。');
    let data=null,textContent=null;
    if(typeof pdf.getPageData==='function')data=await pdf.getPageData(Components.utils.cloneInto({pageIndex},view._iframeWindow));
    if(typeof pdf.getPage==='function'){
      const proxy=await pdf.getPage(pageIndex+1),page=proxy.wrappedJSObject||proxy;
      if(typeof page.getTextContent==='function')textContent=await page.getTextContent();
    }
    if(!data&&!textContent)throw new Error('此版本的 PDF 文本接口不可用，请切换“只发选段”。');
    const result=PaperLensPDFText.extract(data,textContent,rects?{rects}:{});
    if(!textContent&&data)result.text+='\n\n[文字层校验不可用：未能核验缺失符号，请对照原 PDF 检查公式。]';
    return {...result,verified:!!textContent};
  }
  async pages(reader,onProgress,cancelled,onlyPage=null) {
    if(cancelled())throw new Error('已停止。');
    const id=this.sessionID(reader);
    const a=this.attachment(reader),path=await a.getFilePathAsync();
    if(!path)throw new Error('PDF 文件未下载到本机。');
    const stat=await IOUtils.stat(path);const stamp=`${stat.size}:${stat.lastModified}`;
    const cached=this.cache.get(id)?.stamp===stamp?this.cache.get(id):null;
    if(cached&&(onlyPage==null?cached.full:cached.byPage.has(onlyPage)))return onlyPage==null?cached.full:[cached.byPage.get(onlyPage)];
    const internal=reader._internalReader || reader._iframeWindow?.wrappedJSObject?.reader;
    const view=internal?._primaryView;
    const pdf=view?._iframeWindow?.PDFViewerApplication?.pdfDocument;
    if(!pdf)throw new Error('当前 PDF 文本接口不可用。请等待 PDF 加载后重试；也可切换为“只发选段”。');
    if(onlyPage!=null&&(!Number.isInteger(onlyPage)||onlyPage<0||onlyPage>=pdf.numPages))throw new Error('选段页码无效，请重新选择原文。');
    const pageNumbers=onlyPage==null?Array.from({length:pdf.numPages},(_,i)=>i):[onlyPage];
    const byPage=new Map(cached?.byPage||[]),result=[];
    for(const pageIndex of pageNumbers) {
      if(cancelled())throw new Error('已停止。');
      if(byPage.has(pageIndex)){result.push(byPage.get(pageIndex));continue;}
      onProgress(`正在本地读取 PDF：第 ${pageIndex+1}/${pdf.numPages} 页…`);
      const extracted=await this.readPageText(reader,pageIndex);
      if(cancelled())throw new Error('已停止。');
      const extractionWarning=!extracted.verified?'文字层校验不可用，数学符号可能缺失。':extracted.stats.unknownGlyphs||extracted.stats.unplacedGlyphs?'有未识别或无法定位的符号，不得据此补全公式。':extracted.stats.layoutWarnings?'此页含未重建的二维公式；分式、根号、求和上下限及交错脚标须对照原式，不能按字符邻接猜测。':'';
      const row={pageIndex,text:extracted.text.trim(),...(extractionWarning?{extractionWarning}:{})};byPage.set(pageIndex,row);result.push(row);
    }
    if(!result.some(x=>x.text.trim()))throw new Error('此 PDF 未提取到文字，可能是扫描件。请先 OCR，或切换“只发选段”。');
    // Another window may have completed a broader read while this one awaited PDF.js.
    const latest=this.cache.get(id);
    if(latest?.stamp===stamp)for(const [page,row] of latest.byPage)if(!byPage.has(page))byPage.set(page,row);
    const full=latest?.stamp===stamp&&latest.full?latest.full:byPage.size===pdf.numPages?Array.from(byPage.values()).sort((a,b)=>a.pageIndex-b.pageIndex):null;
    this.cache.set(id,{stamp,byPage,full});
    if(this.cache.size>5)this.cache.delete(this.cache.keys().next().value);
    return onlyPage==null?full:result;
  }
  async navigateSource(p,source) {
    const pageIndex=source.pageIndex;
    try {
      const internal=p.reader._internalReader||p.reader._iframeWindow?.wrappedJSObject?.reader;
      const view=internal?._primaryView,pdf=view?._iframeWindow?.PDFViewerApplication?.pdfDocument;
      if(typeof pdf?.getPageData==='function'){
        const data=await pdf.getPageData(Components.utils.cloneInto({pageIndex},view._iframeWindow));
        const position=PaperLensLocations.locate(data.chars,source.text,pageIndex);
        if(position){await p.reader.navigate({position});p.status.textContent='已定位并短暂高亮对应原文。';return;}
      }
    }catch(e){this.safeLog('source location',e);}
    await p.reader.navigate({pageIndex});
    p.status.textContent='已跳到原文页；此片段未能唯一匹配，未添加高亮。';
  }
  run(p,action,question='',options={}) {
    if(p.busy||p.disposed||this.stopped)return Promise.resolve();
    // Reserve the panel before any await, including credential lookup.
    p.busy=true;p.cancelled=false;p.cancel.disabled=false;p.send.disabled=true;p.selection.disabled=true;
    const running=this.runTurn(p,action,question,options);
    this.runs.add(running);
    const release=()=>{
      this.runs.delete(running);
      p.busy=false;p.abort=null;
      if(!p.disposed){p.cancel.disabled=true;p.send.disabled=false;p.selection.disabled=false;}
    };
    running.then(release,release);
    return running;
  }
  async runTurn(p,action,question,options) {
    const startingSelection = p.selected;
    const startingSharedSelection = p.session.selection;
    const original=options.selection||p.selected||p.session.selection||{pageIndex:0};
    const selected=options.selection?{...original}:{...original,text:p.selection.value.trim()};
    // A manual correction is authoritative; its old selection rectangles no longer describe it.
    if(selected.text!==original.text){
      for(const field of ['id','position','rects','nextPageRects','sourceText'])delete selected[field];
    }
    if(!selected.text) {p.status.textContent='请先选中文字，或在选段框粘贴内容。';return;}
    if(selected.text.length>20000){p.status.textContent='选段超过 20,000 字，请缩小选区。';return;}
    if(question.length>8000){p.status.textContent='追问过长，请控制在 8,000 字内。';return;}
    if(action==='compare'&&!p.session.pinned){p.status.textContent='请先暂存一段，再选择另一段进行比较。';return;}
    const pinned=Object.prototype.hasOwnProperty.call(options,'pinned')
      ? (options.pinned?{...options.pinned}:null)
      : (p.session.pinned?{...p.session.pinned}:null);
    const usePinned=action==='compare'||action==='continue'||!!options.pinned;
    const scope=options.scope||(['translate','breakdown'].includes(action)?'selection':p.scope.value),depth=options.depth||p.depth.value;
    let turn,view;
    try {
      let cfg,key;
      try {cfg=this.C.validateConfig(this.config());key=await this.keyFor(cfg.baseURL);if(!key)throw new Error('请先在设置中填写 API Key。');}
      catch(e){if(!p.cancelled&&!p.disposed&&!this.stopped){p.status.textContent=e.message;this.settings(p);}return;}
      if(p.cancelled||p.disposed||this.stopped)throw new Error('已停止。');
      if(!Array.isArray(options.sources)){
        let cacheUpdated = false;
        for(const [passage,label] of [[selected,'选段'],...(usePinned&&pinned?[[pinned,'暂存段落']]:[])]){
          if(!passage.rects?.length)continue;
          p.status.textContent=`正在核验${label}中的数学符号与上下标…`;
          const parts=[await this.readPageText(p.reader,passage.pageIndex,passage.rects)];
          if(passage.nextPageRects?.length&&!p.cancelled&&!p.disposed&&!this.stopped)parts.push(await this.readPageText(p.reader,passage.pageIndex+1,passage.nextPageRects));
          const extracted={text:parts.map(part=>part.text).join('\n\n'),verified:parts.every(part=>part.verified),stats:Object.fromEntries(['unknownGlyphs','unplacedGlyphs','layoutWarnings'].map(key=>[key,parts.reduce((sum,part)=>sum+(part.stats[key]||0),0)]))};
          if(p.cancelled||p.disposed||this.stopped)throw new Error('已停止。');
          if(!extracted.verified||extracted.stats.unknownGlyphs||extracted.stats.unplacedGlyphs||extracted.stats.layoutWarnings)throw new Error(`${label}含无法可靠核验的符号或二维公式，请对照 PDF 纠正为清晰公式${label==='暂存段落'?'并重新暂存':''}后重试。`);
          if(!extracted.text.trim())throw new Error('未能从选区读取文字，请重新选择或在选段框粘贴公式。');
          const sourceText = passage.sourceText ?? passage.text;
          passage.text=extracted.text.trim();
          if(passage.text.length>20000)throw new Error('核验后的段落超过 20,000 字，请缩小选区。');
          if (passage.text !== sourceText) passage.sourceText = sourceText;
          else delete passage.sourceText;
          // A second window may already have changed or removed this location.
          // Update only the same cached source, without reviving or reordering it.
          const cached = passage.id && p.session.passages?.find(entry => entry.id === passage.id);
          if (cached && (cached.sourceText ?? cached.text) === sourceText &&
              PaperLensPassages.same(cached, passage) && cached.text !== passage.text) {
            cached.text = passage.text;
            if (passage.sourceText) cached.sourceText = passage.sourceText;
            else delete cached.sourceText;
            cacheUpdated = true;
          }
        }
        if (p.selected === startingSelection && (selected.rects?.length || !options.selection)) {
          const current = {...selected};
          p.selected = current;
          this.readerSelections.set(p.reader, current);
          if (p.session.selection === startingSharedSelection) p.session.selection = current;
          if (selected.rects?.length) {
            p.selection.value = selected.text;
          }
        }
        if (cacheUpdated || selected.rects?.length) this.refreshPassageViews(p.session);
      }
      const hasSourceSnapshot=Array.isArray(options.sources);
      const pages=scope==='selection'||hasSourceSnapshot?[]:await this.pages(p.reader,text=>{p.status.textContent=text;},()=>p.cancelled||this.stopped,scope==='page'?selected.pageIndex:null);
      if(p.cancelled||this.stopped)throw new Error('已停止。');
      const candidates=hasSourceSnapshot?options.sources.map(s=>({...s})):this.C.retrieve(pages,selected.text+' '+question+' '+(action==='compare'?pinned?.text||'':''),selected.pageIndex,cfg.contextChars,scope,{action,question,selection:selected.text});
      const attachment=this.attachment(p.reader);const paper=attachment.parentID?Zotero.Items.get(attachment.parentID):attachment;
      const answerLength=options.answerLength||p.length?.value||cfg.answerLength;
      const prepared=this.C.prepareRequest({action,selection:selected,sources:candidates,history:options.history||(action==='ask'?p.session.turns.filter(t=>!t.pending):[]),question,pinned:usePinned?pinned:null,depth,answerLength,title:paper.getField('title')},cfg.contextChars);
      const {messages,sources,stats}=prepared;
      this.renderSources(p,sources,selected,pinned,usePinned,stats);
      turn={id:Date.now().toString(36)+Math.random().toString(36).slice(2,6),time:Date.now(),question:question||this.C.ACTIONS[action][0],action,answer:'',scope,depth,answerLength,selection:selected,pinned:usePinned?pinned:null,sources,contextStats:stats,model:cfg.model,partial:true,pending:true};
      p.session.turns.push(turn);view=this.appendTurn(p,turn);
      p.status.textContent=`正在请求 ${new URL(cfg.baseURL).host} · 总输入 ${stats.totalChars.toLocaleString()} / ${stats.limit.toLocaleString()} 字 · ${sources.length} 个原文片段。`;
      let lastPaint=0;
      const result=await this.request(cfg,key,messages,text=>{
        turn.answer=text;this.scheduleCheckpoint(p);if(Date.now()-lastPaint<100)return;lastPaint=Date.now();
        const follow=p.feed.scrollHeight-p.feed.scrollTop-p.feed.clientHeight<90;
        this.renderAnswer(p,view.content,text,sources,selected,turn.pinned);if(follow)p.feed.scrollTop=p.feed.scrollHeight;
      },abort=>{p.abort=abort;});
      turn.answer=result;turn.partial=false;
      const follow=p.feed.scrollHeight-p.feed.scrollTop-p.feed.clientHeight<90;
      this.renderAnswer(p,view.content,result,sources,selected,turn.pinned);
      if(follow)p.feed.scrollTop=p.feed.scrollHeight;
      if(action==='ask'&&p.question.value.trim()===question)p.question.value='';
      p.status.textContent=`回答完成。${scope==='selection'?'本次仅发送选段。':'已使用检索页段；引用可跳转，仍需对照原文核验。'}`;
    } catch(e) {
      if(turn&&!turn.answer){p.session.turns=p.session.turns.filter(t=>t!==turn);view?.card.remove();}
      p.status.textContent=p.cancelled?'已停止；收到的部分回答已保留。':e.message||'请求未完成，请重试。';
    } finally {
      this.cancelCheckpoint(p);
      if(turn)turn.pending=false;
      // Never evict another window's active turn while applying the history limit.
      const completed=p.session.turns.filter(t=>!t.pending).slice(-30);
      p.session.turns=p.session.turns.filter(t=>t.pending||completed.includes(t));
      await this.persist(p.reader).catch(()=>{p.status.textContent+=' 本地会话保存失败。';});
      if(!p.disposed&&!this.stopped)this.renderFeed(p);
      if(!this.stopped)this.updateSessionViews(p.session,p);
    }
  }
  renderSources(p,sources,selection,pinned,includePinned,stats=null) {
    p.sources.replaceChildren(this.el(p.doc,'summary','',`本次使用的原文 · ${sources.length} 个检索片段`));
    if(stats)p.sources.append(this.el(p.doc,'p','pl-muted',`总输入 ${stats.totalChars.toLocaleString()} / ${stats.limit.toLocaleString()} 字（含提示词、选段和历史）。带入 ${stats.historyCount} 轮对话；省略 ${stats.omittedHistory} 轮、${stats.omittedSources} 个候选片段。${stats.truncatedSources||stats.truncatedHistory?'部分检索文字或历史已按预算截取。':''}`));
    const rows=[{id:'选段',...selection},...(includePinned&&pinned?[{id:'暂存',...pinned}]:[]),...sources];
    for(const s of rows) {
      const d=this.el(p.doc,'details');d.append(this.el(p.doc,'summary','',`[${s.id}] · PDF 第 ${s.pageIndex+1} 页`),this.el(p.doc,'small','pl-muted',(s.reasons||[]).join(' · ')+(s.truncated?' · 达到字数上限，片段已截取':'')+(s.extractionWarning?' · '+s.extractionWarning:'')),this.el(p.doc,'p','pl-excerpt',s.text),this.button(p.doc,'定位原文',()=>this.navigateSource(p,s)));p.sources.append(d);
    }
  }
  request(cfg,key,messages,onText=()=>{},onAbort=()=>{}) {
    if(this.stopped)return Promise.reject(new Error('插件已停止。'));
    return new Promise((resolve,reject)=>{
      let xhr;
      let offset=0,buffer='',answer='',finished=false,streamError=false,doneSeen=false,limitReached=false,streamSeen=false,protocolError=false;
      const finish=(error)=>{
        if(finished)return;finished=true;this.requests.delete(xhr);
        if(error)reject(error);else if(!answer.trim())reject(new Error('模型没有返回正文，请检查模型是否支持聊天接口，或增加最大输出 token。'));else resolve(answer);
      };
      const accept=(obj,stream)=>{
        if(!obj||typeof obj!=='object'){protocolError=true;return;}
        if(obj.error){streamError=true;return;}
        const choice=obj.choices?.[0];
        const content=stream?choice?.delta?.content:choice?.message?.content;
        if(choice?.finish_reason)doneSeen=true;
        if(choice?.finish_reason==='length')limitReached=true;
        if(typeof content==='string'){
          answer+=content;if(!stream)doneSeen=true;
          try {onText(answer);}catch {finish(new Error('回答显示失败，已接收的内容将尽量保留。'));xhr.abort();}
        }
      };
      const consume=(flush=false)=>{
        const data=xhr.responseText.slice(offset);offset=xhr.responseText.length;buffer+=data;
        const lines=buffer.split('\n');buffer=lines.pop();if(flush&&buffer){lines.push(buffer);buffer='';}
        for(let line of lines) {
          if(finished)return;
          line=line.trim();if(!line.startsWith('data:'))continue;
          streamSeen=true;
          const raw=line.slice(5).trim();if(!raw)continue;if(raw==='[DONE]'){doneSeen=true;continue;}
          let obj;
          try {obj=JSON.parse(raw);}catch {protocolError=true;continue;}
          accept(obj,true);
        }
      };
      try {
        xhr=new XMLHttpRequest();this.requests.add(xhr);
        xhr.open('POST',this.C.endpoint(cfg.baseURL));xhr.timeout=120000;
        xhr.setRequestHeader('Content-Type','application/json');xhr.setRequestHeader('Authorization','Bearer '+key);
        xhr.onprogress=()=>{if(!finished&&xhr.status>=200&&xhr.status<300)consume();};
        xhr.onload=()=>{
          if(finished)return;
          if(xhr.status<200||xhr.status>=300)return finish(new Error(this.C.statusError(xhr.status)));
          consume(true);
          if(!streamSeen) {
            let obj;
            try {obj=JSON.parse(xhr.responseText);}catch {protocolError=true;}
            if(!protocolError)accept(obj,false);
          }
          if(finished)return;
          if(streamError)return finish(new Error('服务在生成过程中返回错误，请重试。'));
          if(protocolError)return finish(new Error('服务返回的数据不完整或格式异常，已保留收到的正文。请重试。'));
          if(limitReached)return finish(new Error('回答达到最大输出 token，已保留部分内容。请增加限制或缩小问题。'));
          if(answer&&!doneSeen)return finish(new Error('连接提前结束，已保留部分回答。'));
          finish();
        };
        xhr.onerror=()=>finish(new Error('无法连接 API，请检查网络和服务地址。'));
        xhr.ontimeout=()=>finish(new Error('请求超过 120 秒，请缩小上下文或稍后重试。'));
        xhr.onabort=()=>finish(new Error('已停止。'));
        onAbort(()=>{if(finished)return;finish(new Error('已停止。'));xhr.abort();});
        if(!finished)xhr.send(JSON.stringify(this.C.requestBody(cfg,messages)));
      }
      catch {finish(new Error('请求无法发送，请检查 API 设置。'));}
    });
  }
  async saveNote(p,t) {
    if(!t.answer.trim())throw new Error('回答尚未生成。');
    const a=this.attachment(p.reader),library=Zotero.Libraries.get(a.libraryID);
    if(!library.editable)throw new Error('当前文库为只读，无法保存笔记。');
    const groupID=a.libraryID===Zotero.Libraries.userLibraryID?null:Zotero.Groups.getGroupIDFromLibraryID(a.libraryID);
    const link=page=>this.C.sourceLink(a.libraryID,Zotero.Libraries.userLibraryID,groupID,a.key,page);
    const esc=this.C.escapeHTML;
    const note=new Zotero.Item('note');note.libraryID=a.libraryID;if(a.parentID)note.parentID=a.parentID;
    const refs=(t.sources||[]).map(s=>`<p><a href="${esc(link(s.pageIndex))}">[${esc(s.id)}] PDF 第 ${s.pageIndex+1} 页</a></p><blockquote>${esc(s.text)}</blockquote>`).join('');
    note.setNote(`<h2>循文 · ${esc(t.question)}</h2><p>${esc(t.model)} · ${esc(new Date(t.time).toLocaleString())}${t.partial?' · 未完成回答':''}</p><p><a href="${esc(link(t.selection.pageIndex))}">返回选段所在页</a></p><blockquote>${esc(t.selection.text)}</blockquote>${t.pinned?`<p><a href="${esc(link(t.pinned.pageIndex))}">暂存段落</a></p><blockquote>${esc(t.pinned.text)}</blockquote>`:''}<p>${esc(t.answer).replace(/\n/g,'<br/>')}</p><h3>使用的原文片段</h3>${refs}<p>AI 辅助解释，请对照原文核验。页码为 PDF 物理页码。</p>`);
    await note.saveTx();p.status.textContent='已保存到 Zotero 笔记'+(a.parentID?'（当前论文下）。':'（当前文库，独立附件没有父条目）。');
  }
  async settingsWindow(win) {
    const doc=win.document;let root=doc.getElementById('paper-lens-settings-host');if(root){root.remove();}
    root=this.el(doc,'aside','pl-root pl-floating');root.id='paper-lens-settings-host';const style=this.el(doc,'style');style.textContent=this.css;root.append(style);doc.documentElement.append(root);this.nodes.add(root);
    const p={root,doc};this.settings(p,true);
  }
  settings(p,standalone=false) {
    if(p.settings){p.settings.remove();p.settings=null;return;}
    const {doc}=p,cfg=this.config();const box=this.el(doc,'section','pl-settings');p.settings=box;
    box.append(this.el(doc,'h2','','连接你的 AI'));
    const message=this.el(doc,'p','pl-muted','支持 OpenAI 兼容的 Chat Completions 接口。API Key 仅存于 Zotero 本机凭据库，不写入笔记或会话文件。');box.append(message);
    const fields={};
    const field=(id,label,value,type='text')=>{
      const wrap=this.el(doc,'label','pl-field');wrap.append(this.el(doc,'span','',label));
      const input=this.el(doc,'input');input.type=type;input.value=value;input.autocomplete='off';wrap.append(input);box.append(wrap);fields[id]=input;return input;
    };
    field('baseURL','服务地址（Base URL）',cfg.baseURL).placeholder='https://api.deepseek.com';
    field('model','模型 ID',cfg.model).placeholder='填写服务商提供的模型 ID';
    const key=field('key','API Key（留空保留该地址已有密钥）','','password');key.placeholder='sk-…';
    const keyState=this.el(doc,'small','pl-muted');box.append(keyState);
    const refreshKey=async()=>{try{keyState.textContent=await this.keyFor(fields.baseURL.value)?'此地址已保存密钥。':'此地址尚未保存密钥。';}catch{keyState.textContent='请填写有效服务地址。';}};
    fields.baseURL.addEventListener('change',()=>{key.value='';refreshKey();});refreshKey();
    field('contextChars','总输入字数上限（含提示词、选段和历史）',cfg.contextChars,'number');
    field('maxTokens','最大输出 token',cfg.maxTokens,'number');
    const thinkingLabel=this.el(doc,'label','pl-field');thinkingLabel.append(this.el(doc,'span','','DeepSeek 回答模式'));
    const thinking=this.select(doc,[['disabled','快速回答（推荐日常阅读）'],['enabled','深入思考（建议提高输出上限）'],['default','使用服务商默认模式']],cfg.thinking,'DeepSeek 回答模式');thinkingLabel.append(thinking);box.append(thinkingLabel);
    box.append(this.el(doc,'small','pl-muted','此设置仅对 api.deepseek.com 生效。深入思考可能先消耗输出额度，再生成正文。'));
    const rememberLabel=this.el(doc,'label','pl-field');const remember=this.el(doc,'input');remember.type='checkbox';remember.checked=cfg.remember;
    rememberLabel.append(remember,doc.createTextNode('在本机保存每篇论文的段落缓存及最近 30 轮对话'));box.append(rememberLabel);
    box.append(this.el(doc,'p','pl-muted','所有请求正文共同受总输入字数上限约束（字符不等于 token）。追问最多带入最近 4 轮；检索片段和历史可能按预算截取，当前选段不会自动截断。生成中每隔约 3 秒暂存新增正文；关闭会话保存不会删除已有记录。测试连接仅发送测试消息。'));
    const status=this.el(doc,'p','pl-status');status.setAttribute('role','status');box.append(status);
    const read=()=>this.C.validateConfig({...this.config(),baseURL:fields.baseURL.value,model:fields.model.value,contextChars:fields.contextChars.value,maxTokens:fields.maxTokens.value,remember:remember.checked,thinking:thinking.value});
    const row=this.el(doc,'div','pl-row');let testing=false,abortTest;
    const test=this.button(doc,'测试连接',async()=>{
      if(testing)return;
      try {const v=read(),secret=key.value.trim()||await this.keyFor(v.baseURL);if(!secret)throw new Error('请输入 API Key。');
        testing=true;test.disabled=true;status.textContent='正在测试连接…';
        await this.request({...v,maxTokens:256,thinking:'disabled'},secret,[{role:'user',content:'Reply with OK.'}],()=>{},a=>{abortTest=a;});status.textContent='连接成功，模型已返回正文。请保存设置。';
      }catch(e){status.textContent=e.message;}finally{testing=false;test.disabled=false;abortTest=null;}
    });
    row.append(test,this.button(doc,'保存设置',async()=>{
      try {
        const v=read();const secret=key.value.trim();if(secret)await this.setKey(v.baseURL,secret);
        if(!await this.keyFor(v.baseURL))throw new Error('请填写此地址的 API Key。');
        Zotero.Prefs.set('paperLens.config',JSON.stringify(v));key.value='';status.textContent='设置已保存。';refreshKey();
      }catch(e){status.textContent=e.message;}
    },'pl-button pl-primary'),this.button(doc,'关闭',()=>{abortTest?.();if(standalone)p.root.remove();else box.remove();p.settings=null;}));box.append(row);
    box.append(this.button(doc,'删除此地址的密钥',async()=>{try{await this.setKey(fields.baseURL.value,'');key.value='';status.textContent='已删除此地址的密钥。';refreshKey();}catch(e){status.textContent=e.message;}}));
    p.root.append(box);
  }
  disposePanel(reader,p) {
    this.cancelCheckpoint(p);
    p.disposed=true;p.cancelled=true;p.abort?.();p.root.remove();
    if(p.host){p.host.style.display=p.originalDisplay;p.host.style.flexDirection=p.originalDirection;}
    this.panels.delete(reader);
  }
  async stop() {
    this.stopped=true;
    for(const req of this.requests)req.abort();
    for(const [type,fn] of this.listeners)Zotero.Reader.unregisterEventListener(type,fn);
    if(this.observer)Zotero.Notifier.unregisterObserver(this.observer);
    for(const [r,p] of this.panels)this.disposePanel(r,p);
    for(const node of this.nodes)try{node.remove();}catch{}
    // Aborted requests still need to append and persist their partial answer.
    await Promise.allSettled([...this.runs,...this.selectionJobs,...this.sessionLoads.values()]);
    await Promise.allSettled([...this.writes.values()]);
    this.nodes.clear();this.cache.clear();this.sessions.clear();this.sessionLoads.clear();this.writes.clear();
  }
};
function onMainWindowLoad({window}) { PaperLens?.addMenu(window); }
