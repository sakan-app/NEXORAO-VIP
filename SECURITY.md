# NEXORA security deployment notes

## Scope and limits

The root `index.html` is a static storefront/demo. Client-side validation and sanitization are defense in depth, not an authorization boundary. The Express/Prisma files are a backend foundation, not a complete production checkout or identity system. Do not accept real payments or sensitive customer data until authentication, payment provider integration, monitoring, backups, and security tests are completed.

## Implemented in this repository

- DOMPurify loads before storefront code and sanitizes HTML strings assigned through `innerHTML`. Prefer `textContent` for plain text and use contextual output encoding.
- Express sets a per-response nonce CSP, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, MIME sniffing protection, referrer policy, and permissions policy.
- Session cookies are Redis-backed and configured `HttpOnly`, `Secure`, and `SameSite=Strict`.
- State-changing API calls require exact Origin matching and a session-bound 256-bit CSRF token in `X-CSRF-Token`.
- Prisma provides parameterized database operations. Order reads/deletes are scoped to the authenticated session user. Prices are calculated from database catalog records, never trusted from the browser.
- Zod validates request bodies, body sizes are limited, and API rate limiting is enabled.

## Required before production

1. Implement a complete authentication flow. Set `req.session.userId` only after successful credential verification, rotate the session ID after login, use Argon2id or bcrypt for password hashes, and implement logout/session invalidation and password recovery. The sample routes deliberately reject unauthenticated users.
2. The server's GET / route injects CSP nonces into inline script/style tags. Test this against the real page and all browser console/network errors before deployment. The pinned DOMPurify CDN should be replaced with a self-hosted, lockfile-pinned dependency and verified build pipeline.
3. Configure PostgreSQL and Redis, use TLS, a least-privilege database role, backups, alerting, audit logs, and reviewed Prisma migrations. Never commit `.env`.
4. Add hosted payment checkout and signed/idempotent provider webhooks. Never collect or store raw card numbers or CVVs in this app.
5. Verify all external font/image/script origins used by the storefront and adjust CSP narrowly. Set `APP_ORIGIN` to the exact canonical HTTPS origin. Configure HSTS at the trusted TLS edge after confirming all subdomains support HTTPS.
6. The client should fetch `GET /api/csrf-token` and send the returned `csrfToken` as `X-CSRF-Token` for every POST/PUT/PATCH/DELETE. Use the same session cookie for both requests.
7. Add automated integration tests for cross-user order access, missing/invalid CSRF token, Origin mismatch, CSP headers, invalid payloads, inventory race conditions, and rate limiting. Run dependency/static-analysis scans in CI.
8. Create and review database migrations in development, then apply reviewed migrations with `npm run prisma:migrate` in deployment. Seed catalog records through a trusted admin workflow only.

## Database setup

After configuring secrets and services, run `npm ci`, `npx prisma generate`, create/review a migration with `npx prisma migrate dev` in development, and use `npm run prisma:migrate` for deployment.
