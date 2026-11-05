# Account registration and email verification setup

The storefront account flow uses the existing PostgreSQL/Prisma database, Redis-backed secure sessions, CSRF protection, and Nodemailer for outbound verification mail.

## Required deployment steps

1. Set the SMTP credentials issued by the mail provider in the deployment environment. The example values in `.env.example` are configuration hints, not credentials.
2. Set `MAIL_FROM` to an address authorized by the sending domain, such as `Digital Future Stores Group <server@digital-future.ai>`.
3. Confirm `APP_ORIGIN` is the exact public HTTPS origin used by the store.
4. Install dependencies with `npm install`.
5. Generate the Prisma client and apply the migration: `npm run prisma:generate && npm run prisma:migrate`.
6. Restart the application and verify `GET /api/health`.

Registration requires a valid email and a password of at least 12 characters. Passwords are stored using scrypt; verification tokens are random, stored only as SHA-256 hashes, expire after one hour, and are single-use. Login is enabled only after the email address is verified.

SMTP credentials and database/session secrets must be supplied through the hosting platform's secret manager. Never commit real credentials to the repository. Configure the domain's SPF, DKIM, and DMARC records with the mail provider before production email delivery.
