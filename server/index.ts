import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkspaceEngine, ActionError } from './engine.ts';
import { WorkspaceStore } from './store.ts';
import { inspectRepository } from './inspector.ts';
import { checkProviders, runProviderTask } from './providers.ts';
import { ArtifactError, listTaskFiles, readTaskFile } from './artifacts.ts';

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
export const PREVIEW_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage, limit: number): Promise<unknown> {
  if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new ActionError('Send application/json.', 415);
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new ActionError('Compressed request bodies are unsupported.', 415);
  const declared = request.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new ActionError('Request body is too large.', 413);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length; if (size > limit) throw new ActionError('Request body is too large.', 413); chunks.push(bytes); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ActionError('Malformed JSON.'); }
}

export function createWorkspaceServer(engine: WorkspaceEngine, options: { distDirectory?: string; maxBodyBytes?: number } = {}) {
  const streams = new Set<ServerResponse>();
  const dist = resolve(options.distDirectory ?? 'dist');
  const server = createServer(async (request, response) => {
    try {
      const address = server.address(); const port = typeof address === 'object' && address ? address.port : 4174;
      const host = request.headers.host ?? '';
      if (![ `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}` ].includes(host)) throw new ActionError('Invalid local server host.', 403);
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (request.method === 'POST') {
        const origin = request.headers.origin;
        if (origin && origin !== `http://${host}`) throw new ActionError('Cross-origin actions are refused.', 403);
        if (request.headers['sec-fetch-site'] === 'cross-site') throw new ActionError('Cross-site actions are refused.', 403);
        if (url.pathname !== '/api/actions') return json(response, 404, { error: 'Unknown endpoint.' });
        return json(response, 200, await engine.dispatch(await body(request, options.maxBodyBytes ?? 256 * 1024)));
      }
      if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.setHeader('Allow', 'GET, HEAD, POST'); return json(response, 405, { error: 'Method not allowed.' }); }
      if (url.pathname === '/api/state') return json(response, 200, engine.getState());
      if (url.pathname === '/api/history') return json(response, 200, engine.getHistory());
      const checkpointRoute = /^\/api\/history\/([^/]+)$/.exec(url.pathname);
      if (checkpointRoute) {
        let id: string;
        try { id = decodeURIComponent(checkpointRoute[1]); } catch { throw new ActionError('Invalid history checkpoint identifier.'); }
        return json(response, 200, engine.getHistoryCheckpoint(id));
      }
      const taskFilesRoute = /^\/api\/tasks\/([^/]+)\/(files|file|preview)$/.exec(url.pathname);
      if (taskFilesRoute) {
        let id: string;
        try { id = decodeURIComponent(taskFilesRoute[1]); } catch { throw new ActionError('Invalid task identifier.'); }
        const state = engine.getState();
        if (taskFilesRoute[2] === 'files') return json(response, 200, await listTaskFiles(state, id));
        if (taskFilesRoute[2] === 'preview') {
          const paths = url.searchParams.getAll('path'), checkpoints = url.searchParams.getAll('checkpoint');
          if (paths.length > 1 || checkpoints.length > 1 || (paths.length && checkpoints.length)) throw new ActionError('Preview accepts one changed-file path or one history checkpoint, never both.');
          let html: string;
          if (paths.length) {
            const file = await readTaskFile(state, id, paths[0]);
            if (file.language !== 'html') throw new ActionError('Only changed HTML files can be shown as an app preview.', 415);
            html = file.content;
          } else {
            const snapshot = checkpoints.length ? engine.getHistoryCheckpoint(checkpoints[0]).snapshot : state;
            const task = snapshot.tasks.find(item => item.id === id);
            if (!task) throw new ActionError('Unknown task in this workspace or checkpoint.', 404);
            if (!task.preview?.html) throw new ActionError(checkpoints.length ? 'This checkpoint has no captured HTML preview for the task.' : 'This task has no attached HTML preview. Open an actual changed HTML file or attach a self-contained preview.', 409);
            html = task.preview.html;
          }
          if (Buffer.byteLength(html, 'utf8') > 256 * 1024) throw new ActionError('HTML preview exceeds the 256 KiB response limit.', 413);
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PREVIEW_CSP, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
          response.end(request.method === 'HEAD' ? undefined : html);
          return;
        }
        if (url.searchParams.getAll('path').length !== 1) throw new ActionError('Provide exactly one changed-file path.');
        return json(response, 200, await readTaskFile(state, id, url.searchParams.get('path')!));
      }
      if (url.pathname === '/api/template') { response.setHeader('Content-Disposition', 'attachment; filename="team-template.json"'); return json(response, 200, engine.getTemplate()); }
      if (url.pathname === '/api/events') {
        if (request.method !== 'GET') return json(response, 405, { error: 'Use GET for event streams.' });
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        streams.add(response);
        let blocked = false;
        let pending: ReturnType<WorkspaceEngine['getState']> | null = null;
        const send = (state: ReturnType<WorkspaceEngine['getState']>) => {
          if (response.destroyed) return;
          if (blocked) { pending = state; return; }
          blocked = !response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
        };
        response.on('drain', () => { blocked = false; if (pending) { const latest = pending; pending = null; send(latest); } });
        response.write('retry: 1500\n\n'); send(engine.getState());
        const unsubscribe = engine.subscribe(send);
        const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': heartbeat\n\n'); }, 15000); heartbeat.unref();
        response.on('close', () => { clearInterval(heartbeat); unsubscribe(); streams.delete(response); });
        return;
      }
      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: 'Unknown endpoint.' });
      let candidate: string;
      try { candidate = resolve(dist, `.${decodeURIComponent(url.pathname)}`); } catch { throw new ActionError('Invalid URL.'); }
      const rel = relative(dist, candidate);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new ActionError('Invalid file path.', 403);
      try { if (!(await stat(candidate)).isFile()) candidate = resolve(dist, 'index.html'); }
      catch { if (!url.pathname.includes('.')) candidate = resolve(dist, 'index.html'); else return json(response, 404, { error: 'File not found.' }); }
      let canonical: string;
      try { canonical = await realpath(candidate); } catch { return json(response, 404, { error: 'Frontend is unavailable. Run npm run build, or use the development server.' }); }
      const canonicalRoot = await realpath(dist); const canonicalRel = relative(canonicalRoot, canonical);
      if (canonicalRel.startsWith('..') || isAbsolute(canonicalRel)) throw new ActionError('Invalid file path.', 403);
      const extension = canonical.slice(canonical.lastIndexOf('.'));
      response.writeHead(200, { 'Content-Type': mime[extension] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': APP_CSP, 'Referrer-Policy': 'no-referrer', 'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=3600' });
      response.end(request.method === 'HEAD' ? undefined : await readFile(canonical));
    } catch (error) { if (!response.headersSent) json(response, error instanceof ActionError || error instanceof ArtifactError ? error.status : 500, { error: (error as Error).message }); else response.end(); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  return { server, closeStreams: () => { for (const response of streams) response.end(); streams.clear(); } };
}

async function main(): Promise<void> {
  const port = Number(process.env.STARTUP_PORT ?? 4174);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('STARTUP_PORT must be a TCP port between 1 and 65535.');
  const engine = await WorkspaceEngine.open(new WorkspaceStore(resolve(process.env.STARTUP_STATE_DIR ?? '.startup-workspace')), { inspectRepository, checkProviders, runProviderTask });
  const app = createWorkspaceServer(engine);
  try { await new Promise<void>((resolveListen, reject) => { app.server.once('error', reject); app.server.listen(port, '127.0.0.1', resolveListen); }); }
  catch (error) { await engine.close(); throw error; }
  console.log(`Startup Workspace API: http://127.0.0.1:${port}`);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    app.closeStreams(); app.server.close();
    await engine.close(); process.exitCode = 0;
  };
  process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error: unknown) => { console.error((error as Error).message); process.exitCode = 1; });
