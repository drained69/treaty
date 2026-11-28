import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';

const dist = new URL('../dist/', import.meta.url);
const source = await readFile(new URL('../server/native.js', import.meta.url), 'utf8');
const assets = {};
for (const file of ['index.html', ...(await readdir(new URL('assets/', dist))).map((name) => 'assets/' + name)]) {
  assets['/' + file] = await readFile(new URL(file, dist), 'utf8');
}
await mkdir(new URL('server/', dist), { recursive: true });
await writeFile(new URL('server/index.js', dist), source + '\nconst assets = ' + JSON.stringify(assets) + `;
const types = { html: 'text/html', js: 'text/javascript', css: 'text/css' };
export default {
  async fetch(request) {
    const native = await nativeRead(request);
    if (native) return native;
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    const path = new URL(request.url).pathname;
    const key = path === '/' ? '/index.html' : path;
    if (!Object.hasOwn(assets, key)) return new Response('Not found', { status: 404 });
    const type = types[key.split('.').pop()] ?? 'application/octet-stream';
    return new Response(request.method === 'HEAD' ? null : assets[key], {
      headers: {
        'Content-Type': type + '; charset=utf-8',
        'Cache-Control': key === '/index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
};
`);
