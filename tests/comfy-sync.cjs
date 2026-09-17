const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

async function main() {
  const sockets = [];
  class Socket extends EventTarget {
    constructor() { super(); sockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    close() { this.dispatchEvent(new Event('close')); }
    sendEvent(type, data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({type, data}) })); }
  }
  let history = {}, queue = {queue_running: [], queue_pending: []};
  const requests = [];
  const context = {exports: {}, require, Buffer, URLSearchParams, AbortSignal, WebSocket: Socket, setTimeout, clearTimeout, process: {env: {COMFYUI_BASE_URL: 'http://comfy.test'}}, fetch: async (url, options = {}) => {
    requests.push([url, options]);
    if (url.endsWith('/interrupt')) { queue.queue_running = []; return Response.json({}); }
    if (url.endsWith('/queue') && options.method === 'POST') { queue.queue_pending = []; return Response.json({}); }
    return Response.json(url.includes('/history/') ? history : queue);
  }};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/server/providers/video-comfy.ts', 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, context);
  const api = context.exports;
  const task = 'comfy::p::client';
  queue.queue_running = [[0,'p']];
  await api.comfyQueryVideoTask(task);
  const socket = sockets.at(-1);
  socket.sendEvent('execution_start', {prompt_id:'p', timestamp:Date.now()-52000});
  for (const percent of [16,17,95]) {
    socket.sendEvent('progress', {prompt_id:'p', node:'sampler',value:percent,max:100});
    const result = await api.comfyQueryVideoTask(task);
    assert.ok(result.progress.includes(`${percent}%`));
    assert.ok(result.progress.includes('52 秒'));
  }
  socket.sendEvent('execution_interrupted', {prompt_id:'p'});
  assert.equal((await api.comfyQueryVideoTask(task)).state, 'failed');
  queue.queue_running = [];
  assert.equal((await api.comfyQueryVideoTask('comfy::missing')).state, 'failed');
  history.p = {status:{status_str:'success'},outputs:{preview:{images:[{filename:'reference.png'}]}}};
  assert.equal((await api.comfyQueryVideoTask('comfy::p','frame')).state, 'failed');
  assert.equal((await api.comfyQueryVideoTask('comfy::p')).state, 'failed');
  history.p.outputs['998'] = {images:[{filename:'generated.png',type:'output'}]};
  assert.match((await api.comfyQueryVideoTask('comfy::p','frame')).resultUrl, /generated.png/);
  history.p.outputs.video = {gifs:[{filename:'generated.mp4',type:'output'}]};
  assert.equal((await api.comfyQueryVideoTask('comfy::p')).state, 'success');
  queue.queue_pending = [[0,'queued']];
  await api.comfyCancelVideoTask('comfy::queued');
  assert.ok(requests.some(([url, opts]) => url.endsWith('/queue') && opts.body === JSON.stringify({delete:['queued']})));
  queue.queue_running = [[0,'running']];
  await api.comfyCancelVideoTask('comfy::running');
  assert.ok(requests.some(([url]) => url.endsWith('/interrupt')));
  console.log('PASS: exact percentages, elapsed time, external interruption, missing task, strict frame/video outputs, queued/running cancellation');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
