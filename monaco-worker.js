self.MonacoEnvironment = {
  baseUrl: new URL('./node_modules/monaco-editor/min/', self.location.href).href
};
importScripts(new URL('vs/base/worker/workerMain.js', self.MonacoEnvironment.baseUrl).href);
