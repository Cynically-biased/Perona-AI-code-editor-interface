const { net, protocol } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const assets = new Set([
  'index.html', 'style.css', 'renderer.js', 'workspace.js', 'dock.js', 'dock-model.js', 'editor.js', 'tools.js', 'git.js',
  'perona.png', 'codex-logo.png', 'claude-logo.png', 'monaco-worker.js', 'perona-pet.js', 'terminal-ui.js'
]);

protocol.registerSchemesAsPrivileged([{
  scheme: 'perona',
  privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true }
}]);

function registerInterface(root) {
  protocol.handle('perona', request => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname.slice(1));
    const dependencies = /^(?:node_modules\/@xterm\/(?:xterm|addon-fit)\/(?:css|lib)\/|node_modules\/monaco-editor\/min\/vs\/)/;
    if (url.hostname !== 'app' || relative.includes('\\') || relative.split('/').some(part => part === '..')
        || (!assets.has(relative) && !dependencies.test(relative))) {
      return new Response(null, { status: 404 });
    }
    return net.fetch(pathToFileURL(path.join(root, relative)).href);
  });
}

module.exports = { registerInterface };
