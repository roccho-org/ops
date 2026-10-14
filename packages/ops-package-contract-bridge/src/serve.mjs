import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.mmd', 'text/plain; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.jsonl', 'application/x-ndjson; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
]);

export function serveDist({ dir, host = '127.0.0.1', port = 4173 }) {
  if (typeof dir !== 'string' || !dir) throw new Error('serve-dist requires --dir');
  const root = fs.realpathSync(dir);
  const number = Number(port);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('invalid serve-dist port');
  const server = http.createServer((request, response) => {
    try {
      const target = new URL(request.url, `http://${host}:${number}`);
      const relative = decodeURIComponent(target.pathname === '/' ? '/index.html' : target.pathname).replace(/^\/+/, '');
      const file = path.resolve(root, relative);
      if (!(file === root || file.startsWith(`${root}${path.sep}`))) throw new Error('path escape');
      if (!fs.statSync(file).isFile()) throw new Error('not a file');
      response.writeHead(200, {
        'content-type': TYPES.get(path.extname(file)) ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      fs.createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found\n');
    }
  });
  server.listen(number, host, () => process.stdout.write(`ops-package-contract-bridge serve-dist http://${host}:${number}/\n`));
  return server;
}
