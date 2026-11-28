import { defineConfig, loadEnv } from 'vite';
import { nativeRead } from './server/native.js';

function nativeRoutes(server) {
  server.middlewares.use(async (request, response, next) => {
    if (!request.url?.startsWith('/api/native/')) return next();
    const result = await nativeRead(new Request('http://localhost' + request.url, { method: request.method }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
  });
}

export default defineConfig(({ mode }) => {
  // `npm run dev` runs in development mode, where Vite does not read .env.production. Unless a
  // deployment is configured for this mode (a .env file, or the environment, as the tests do),
  // use the public Diana deployment from .env.production, so the dev server shows the live contract.
  if (!loadEnv(mode, process.cwd(), 'VITE_').VITE_TREATY_ADDRESS) {
    const { VITE_TREATY_ADDRESS } = loadEnv('production', process.cwd(), 'VITE_');
    if (VITE_TREATY_ADDRESS) process.env.VITE_TREATY_ADDRESS = VITE_TREATY_ADDRESS;
  }
  return {
    plugins: [{ name: 'diana-native-reads', configureServer: nativeRoutes, configurePreviewServer: nativeRoutes }],
  };
});
