// Vercel function: the two read-only Diana Native queries the site needs
// (receipts and EVM windows). Diana Native REST does not allow browser
// cross-origin requests, so the site asks this same-origin route instead.
import { nativeRead } from '../server/native.js';

export async function GET(request) {
  const url = new URL(request.url);
  // vercel.json rewrites /api/native/<path> to /api/native?path=<path>.
  const tail = url.searchParams.get('path') ?? url.pathname.replace(/^\/api\/native\/?/, '');
  const response = await nativeRead(new Request('https://treaty.local/api/native/' + tail, { method: 'GET' }));
  return response ?? Response.json({ error: 'Unknown Diana query' }, { status: 404 });
}
