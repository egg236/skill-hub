import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { hub } from './hub.mjs';
import { createStore } from './gui-store.mjs';
import { conversionPrompt } from './conversion-plan.mjs';
import { createAgentJobs } from './agent-jobs.mjs';
import { createPathPicker } from './path-picker.mjs';

export function createGuiServer({ base = hub, agentOptions, pathPicker = createPathPicker() } = {}) {
  const store = createStore(base);
  const jobs = createAgentJobs(agentOptions);
  const token = randomBytes(32).toString('hex');
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/editors.js', ['editors.js', 'text/javascript; charset=utf-8']],
    ['/workspace-ui.js', ['workspace-ui.js', 'text/javascript; charset=utf-8']],
    ['/project-conversion.js', ['project-conversion.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ]);
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (code, data) => {
      response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(data));
    };
    const port = server.address().port;
    const host = request.headers.host;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) {
      send(403, { error: 'Разрешён только локальный интерфейс хаба.' }); return;
    }
    try {
      const url = new URL(request.url, `http://${host}`);
      // A link from another site may open the UI document; API access remains same-origin.
      const landingNavigation = request.method === 'GET' && url.pathname === '/' &&
        request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
      if ((request.headers.origin && request.headers.origin !== `http://${host}`) ||
          (request.headers['sec-fetch-site'] === 'cross-site' && !landingNavigation)) {
        send(403, { error: 'Разрешён только локальный интерфейс хаба.' }); return;
      }
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        response.writeHead(200, { 'Content-Type': type });
        response.end(fs.readFileSync(path.join(hub, 'gui', file)));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/session') { send(200, { token }); return; }
      if (request.headers['x-hub-token'] !== token) { send(403, { error: 'Обнови страницу, чтобы открыть локальную сессию.' }); return; }
      let input = {};
      if (request.method !== 'GET') {
        if (request.headers['content-type'] !== 'application/json') { send(415, { error: 'Ожидался application/json.' }); return; }
        let size = 0;
        const chunks = [];
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) { send(413, { error: 'Запрос превышает 2 МБ.' }); return; }
          chunks.push(chunk);
        }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Ожидался JSON object.');
      }
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const [api, resource, id, action, skill] = parts;
      const method = request.method;
      let result;
      if (api === 'api' && resource === 'catalog' && parts.length === 2 && method === 'GET') result = store.catalog();
      else if (api === 'api' && resource === 'conversion-prompt' && parts.length === 2 && method === 'GET') result = { prompt: conversionPrompt };
      else if (api === 'api' && resource === 'picker' && parts.length === 2 && method === 'POST') {
        const controller = new AbortController();
        const disconnected = () => { if (!response.writableEnded) controller.abort(); };
        response.once('close', disconnected);
        try { result = await pathPicker.pick(input, { signal: controller.signal }); }
        finally { response.off('close', disconnected); }
      }
      else if (api === 'api' && resource === 'agent') {
        if (parts.length === 2 && method === 'GET') result = jobs.status();
        else if (parts.length === 2 && method === 'POST') result = jobs.start(input);
        else if (parts.length === 3 && method === 'GET') result = jobs.get(id);
        else if (parts.length === 3 && method === 'DELETE') result = jobs.cancel(id);
      } else if (api === 'api' && resource === 'projects') {
        if (parts.length === 2 && method === 'GET') result = store.projects();
        else if (parts.length === 2 && method === 'POST') result = store.register(input);
        else if (parts.length === 3 && method === 'PUT') result = store.register({ ...input, id });
        else if (parts.length === 3 && method === 'DELETE') result = store.unregister(id);
        else if (parts.length === 4 && action === 'conversion-draft' && method === 'POST') {
          const prepared = store.conversionInput(id, input.paths);
          result = { ...jobs.start(prepared.input), revision: prepared.revision };
        }
        else if (parts.length === 4 && action === 'conversion-preview' && method === 'POST') result = store.conversionPreview(id, input);
        else if (parts.length === 4 && action === 'convert' && method === 'POST') result = store.saveConversion(id, input);
        else if (parts.length === 4 && action === 'instruction' && method === 'GET') result = store.projectInstruction(id, url.searchParams.get('path'));
        else if (parts.length === 4 && action === 'instruction' && method === 'PUT') result = store.saveProjectSkill(id, input);
        else if (parts.length === 4 && action === 'skill' && method === 'GET') result = store.projectSkill(id, url.searchParams.get('path'));
        else if (parts.length === 4 && action === 'skill' && method === 'PUT') result = store.saveProjectSkill(id, input);
        else if (parts.length === 4 && action === 'connection-preview' && method === 'POST') result = store.connectionPreview(id, input.modules);
        else if (parts.length === 4 && action === 'migration-preview' && method === 'POST') result = store.connectionPreview(id, input.modules, true);
        else if (parts.length === 4 && action === 'migrate' && method === 'POST') result = store.connect(id, input.modules, input.fingerprint, true);
        else if (parts.length === 4 && action === 'connect' && method === 'POST') result = store.connect(id, input.modules, input.fingerprint);
        else if (parts.length === 4 && action === 'adopt-preview' && method === 'POST') result = store.adoptPreview(id, input.modules);
        else if (parts.length === 4 && action === 'adopt' && method === 'POST') result = store.adopt(id, input.modules, input.fingerprint);
        else if (parts.length === 4 && action === 'modules' && method === 'POST') result = store.createProjectModule(id, input);
        else if (parts.length === 5 && action === 'modules' && method === 'GET') result = store.projectModule(id, skill, Object.fromEntries(url.searchParams));
        else if (parts.length === 5 && action === 'modules' && method === 'PUT') result = store.saveProjectModule(id, skill, input);
        else if (parts.length === 6 && action === 'modules' && parts[5] === 'capture-preview' && method === 'POST') result = store.capturePreview(id, skill);
        else if (parts.length === 6 && action === 'modules' && parts[5] === 'capture' && method === 'POST') result = store.capture(id, skill, input);
        else if (parts.length === 6 && action === 'modules' && parts[5] === 'promote-preview' && method === 'POST') result = store.promotePreview(id, skill, input);
        else if (parts.length === 6 && action === 'modules' && parts[5] === 'promote' && method === 'POST') result = store.promote(id, skill, input);
        else if (parts.length === 4 && action === 'preview' && method === 'POST') result = store.preview(id, input.modules);
        else if (parts.length === 4 && action === 'apply' && method === 'POST') result = store.apply(id, input.modules, input.fingerprint);
      } else if (api === 'api' && resource === 'modules') {
        if (parts.length === 2 && method === 'POST') result = store.createModule(input);
        else if (parts.length === 3 && method === 'GET') result = store.module(id);
        else if (parts.length === 3 && method === 'PUT') result = store.saveModule(id, input);
        else if (parts.length === 4 && action === 'design-draft' && method === 'POST') result = jobs.start(store.designAgentInput(id, input));
        else if (parts.length === 4 && action === 'designs' && method === 'POST') result = store.createDesign(id, input);
        else if (parts.length === 5 && action === 'versions' && method === 'GET') result = store.version(id, skill);
        else if (parts.length === 3 && method === 'DELETE') result = store.deleteModule(id, input.revision);
        else if (action === 'import' && parts.length === 4 && method === 'POST') result = store.importSkill(id, input);
        else if (action === 'skills') {
          if (parts.length === 4 && method === 'POST') result = store.saveSkill(id, { ...input, create: true });
          else if (parts.length === 5 && method === 'GET') result = store.skill(id, skill);
          else if (parts.length === 5 && method === 'PUT') result = store.saveSkill(id, { ...input, name: skill, create: false });
          else if (parts.length === 5 && method === 'DELETE') result = store.deleteSkill(id, skill, input.revision);
        }
      }
      if (result === undefined) send(404, { error: 'Маршрут не найден.' });
      else send(200, result);
    } catch (error) { send(400, { error: error.message, ...(error.code === 'EXISTING_PROJECT_FILES' ? { code: error.code, conflicts: error.conflicts } : {}) }); }
  });
  server.on('close', () => { jobs.close(); pathPicker.close(); });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const port = args.length === 0 ? 4317 : args.length === 2 && args[0] === '--port' && /^\d+$/.test(args[1]) ? Number(args[1]) : NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('Использование: node scripts/gui.mjs [--port 4317]');
    process.exitCode = 1;
  } else {
    const server = createGuiServer();
    server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Порт ${port} занят. Используй --port 4318.` : error.message); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`skill-hub: http://127.0.0.1:${server.address().port}\nОстановка: Ctrl+C`));
  }
}
