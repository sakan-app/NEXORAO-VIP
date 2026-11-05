import { Router } from 'express';
import { z } from 'zod';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import nodemailer from 'nodemailer';

const scrypt = promisify(scryptCallback);
const signupSchema = z.object({
  email: z.string().trim().email().max(254).transform(v => v.toLowerCase()),
  password: z.string().min(12).max(128)
}).strict();
const emailSchema = z.object({ email: z.string().trim().email().max(254).transform(v => v.toLowerCase()) }).strict();
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: (process.env.SMTP_SECURE || 'true') === 'true',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined
}) : null;

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return 'scrypt$16384$8$1$' + salt.toString('hex') + '$' + Buffer.from(derived).toString('hex');
}
async function verifyPassword(password, stored) {
  const [algorithm, n, r, p, saltHex, hashHex] = String(stored).split('$');
  if (algorithm !== 'scrypt' || n !== '16384' || r !== '8' || p !== '1' || !/^[a-f0-9]{32}$/.test(saltHex || '') || !/^[a-f0-9]{128}$/.test(hashHex || '')) return false;
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
  const expected = Buffer.from(hashHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function issueVerification(prisma, user) {
  if (!mailer || !process.env.MAIL_FROM) throw Object.assign(new Error('Email delivery is not configured.'), { status: 503 });
  const token = randomBytes(32).toString('base64url');
  await prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } });
  await prisma.emailVerificationToken.create({ data: {
    userId: user.id, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000)
  }});
  const url = new URL('/api/auth/verify', process.env.APP_ORIGIN);
  url.searchParams.set('token', token);
  await mailer.sendMail({
    from: process.env.MAIL_FROM, to: user.email,
    subject: 'Bitte bestätigen Sie Ihre E-Mail-Adresse – NEXORA',
    text: 'Bitte bestätigen Sie Ihre E-Mail-Adresse innerhalb einer Stunde: ' + url.toString(),
    html: '<p>Vielen Dank für Ihre Registrierung bei NEXORA.</p><p><a href="' + url.toString() + '">E-Mail-Adresse bestätigen</a></p><p>Der Link ist eine Stunde gültig. Falls Sie kein Konto erstellt haben, ignorieren Sie diese Nachricht.</p>'
  });
}
export default function authRouter(prisma) {
  const router = Router();
  router.get('/me', async (req, res, next) => {
    try {
      if (!req.session.userId) return res.json({ user: null });
      const user = await prisma.user.findUnique({ where: { id: req.session.userId }, select: { id: true, email: true, emailVerifiedAt: true } });
      if (!user || !user.emailVerifiedAt) { delete req.session.userId; return res.json({ user: null }); }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ user });
    } catch (err) { next(err); }
  });
  router.post('/register', async (req, res, next) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Bitte geben Sie eine gültige E-Mail-Adresse und ein Passwort mit mindestens 12 Zeichen ein.' });
    if (!mailer || !process.env.MAIL_FROM) return res.status(503).json({ error: 'E-Mail-Versand ist noch nicht konfiguriert. Bitte versuchen Sie es später erneut.' });
    try {
      const passwordHash = await hashPassword(parsed.data.password);
      const user = await prisma.user.create({ data: { email: parsed.data.email, passwordHash }, select: { id: true, email: true } });
      await issueVerification(prisma, user);
      res.status(202).json({ message: 'Wenn die Adresse registriert werden kann, erhalten Sie eine E-Mail mit einem Bestätigungslink.' });
    } catch (err) {
      if (err.code === 'P2002') return res.status(202).json({ message: 'Wenn die Adresse registriert werden kann, erhalten Sie eine E-Mail mit einem Bestätigungslink.' });
      if (err.status === 503) return res.status(503).json({ error: 'E-Mail-Versand ist noch nicht konfiguriert. Bitte versuchen Sie es später erneut.' });
      next(err);
    }
  });
  router.post('/login', async (req, res, next) => {
    const parsed = z.object({ email: emailSchema.shape.email, password: z.string().min(1).max(128) }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Ungültige Anmeldedaten.' });
    try {
      const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
      if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) return res.status(401).json({ error: 'E-Mail-Adresse oder Passwort ist nicht korrekt.' });
      if (!user.emailVerifiedAt) return res.status(403).json({ error: 'Bitte bestätigen Sie zuerst Ihre E-Mail-Adresse. Sie können eine neue Bestätigungs-E-Mail anfordern.' });
      await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
      req.session.userId = user.id;
      req.session.csrfToken = randomBytes(32).toString('hex');
      res.setHeader('Cache-Control', 'no-store');
      res.json({ user: { id: user.id, email: user.email } });
    } catch (err) { next(err); }
  });
  router.post('/resend-verification', async (req, res, next) => {
    const parsed = emailSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Bitte geben Sie eine gültige E-Mail-Adresse ein.' });
    try {
      const user = await prisma.user.findUnique({ where: { email: parsed.data.email }, select: { id: true, email: true, emailVerifiedAt: true } });
      if (user && !user.emailVerifiedAt) await issueVerification(prisma, user);
      res.status(202).json({ message: 'Falls ein unbestätigtes Konto besteht, wurde eine Bestätigungs-E-Mail versendet.' });
    } catch (err) { next(err); }
  });
  router.get('/verify', async (req, res, next) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return res.redirect('/?account=verification-invalid');
    try {
      const record = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: tokenHash(token) } });
      if (!record || record.expiresAt <= new Date()) return res.redirect('/?account=verification-expired');
      await prisma.$transaction([
        prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } }),
        prisma.emailVerificationToken.deleteMany({ where: { userId: record.userId } })
      ]);
      res.redirect('/?account=verified');
    } catch (err) { next(err); }
  });
  router.post('/logout', (req, res, next) => {
    req.session.destroy(err => {
      if (err) return next(err);
      res.clearCookie('__Host-nexora.sid', { httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
      res.status(204).end();
    });
  });
  return router;
}
