var PaperLens;
async function startup({ rootURI }) {
  await Zotero.initializationPromise;
  Services.scriptloader.loadSubScript(rootURI + 'src/retrieval.js', globalThis);
  Services.scriptloader.loadSubScript(rootURI + 'src/math.js', globalThis);
  Services.scriptloader.loadSubScript(rootURI + 'src/locations.js', globalThis);
  Services.scriptloader.loadSubScript(rootURI + 'src/pdf-text.js', globalThis);
  Services.scriptloader.loadSubScript(rootURI + 'src/passages.js', globalThis);
  Services.scriptloader.loadSubScript(rootURI + 'src/core.js', globalThis);
  Services.scriptloader.loadSubScript(rootURI + 'src/research.js', globalThis);
  Services.scriptloader.loadSubScript(rootURI + 'src/commands.js', globalThis);
  Services.scriptloader.loadSubScript(rootURI + 'src/writeback.js', globalThis);
  Services.scriptloader.loadSubScript(rootURI + 'src/plugin.js', globalThis);
  PaperLens = new PaperLensPlugin(rootURI);
  await PaperLens.start();
}
async function shutdown() { await PaperLens?.stop(); PaperLens = null; }
function install() {}
function uninstall() {}
