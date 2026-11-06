// Copies the public storefront (index.html and assets/) into dist/, the only folder the Cloudflare Worker
// serves as static files. Keeps server code, scripts, migrations and config out of the public site.
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync('index.html', 'dist/index.html');
cpSync('assets', 'dist/assets', { recursive: true });
console.log('Copied index.html and assets/ to dist/');
