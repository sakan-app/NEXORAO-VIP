import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import { createClient } from 'redis';
import { PrismaClient } from '@prisma/client';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ordersRouter from './src/routes/orders.js';

for (const key of ['SESSION_SECRET', 'REDIS_URL', 'DATABASE_URL', 'APP_ORIGIN']) {
  if (!process.env[key]) throw new Error('Missing required environment variable: ' + key);
}
if (process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');

const app = express();
const prisma = new PrismaClient();
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', err => console.error('Redis connection error:', err.message));
await redis.connect();

app.disable('x-powered-by');
app.set('trust proxy', 1); // Configure only behind a trusted TLS proxy.
app.use((req, res, next) => {
  const nonce = randomBytes(18).toString('base64');
  res.locals.cspNonce = nonce;
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'nonce-" + nonce + "' https://cdn.jsdelivr.net",
    "style-src 'self' 'nonce-" + nonce + "' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests"
  ].join('; '));
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});
app.use(helmet({ contentSecurityPolicy: false, frameguard: { action: 'deny' }, noSniff: true }));
app.use(express.json({ limit: '32kb', strict: true }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use(session({
  name: '__Host-nexora.sid',
  secret: process.env.SESSION_SECRET,
  store: new RedisStore({ client: redis, prefix: 'nexora:sess:' }),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 2 * 60 * 60 * 1000 }
}));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: 'draft-7', legacyHeaders: false }));

app.get('/api/csrf-token', (req, res) => {
  if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString('hex');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ csrfToken: req.session.csrfToken });
});
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (req.get('origin') !== process.env.APP_ORIGIN) return res.status(403).json({ error: 'Invalid request origin.' });
  if (!safeEqual(req.get('x-csrf-token'), req.session.csrfToken)) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
  }
  next();
});
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api/orders', ordersRouter(prisma));

// A nonce is generated per response and applied to every inline script/style tag.
// This preserves the existing single-file design without enabling unsafe-inline.
app.get('/', async (_req, res, next) => {
  try {
    let html = await readFile(fileURLToPath(new URL('./index.html', import.meta.url)), 'utf8');
    const nonce = res.locals.cspNonce;
    html = html.replace(/<script(?![^>]*\bsrc=)([^>]*)>/gi, (tag, attrs) => '<script nonce="' + nonce + '"' + attrs + '>');
    html = html.replace(/<style([^>]*)>/gi, (tag, attrs) => '<style nonce="' + nonce + '"' + attrs + '>');
    res.type('html').set('Cache-Control', 'no-store').send(html);
  } catch (err) { next(err); }
});
app.use('/assets', express.static(fileURLToPath(new URL('./public/', import.meta.url)), {
  dotfiles: 'deny', index: false, immutable: true, maxAge: '1y'
}));
app.use((err, _req, res, _next) => {
  console.error('Request failed:', err?.message || 'unknown error');
  if (!res.headersSent) res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error.' });
});
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => console.log('NEXORA security server listening on ' + port));
async function shutdown() {
  server.close();
  await prisma.$disconnect();
  await redis.quit();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
