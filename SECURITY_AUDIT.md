# OWASP Top 10 Security Audit — Timesheet App

**Date:** 2026-06-09
**Scope:** Full-stack review of `backend/` (Express + SQLite) and `frontend/` (React + TypeScript)

---

## Finding 1 — Broken Authentication (OWASP A07:2021)

**Severity: CRITICAL**

### Vulnerability

The application uses email-only authentication with no password, no session tokens, and no cryptographic verification. The sole authentication mechanism is a plaintext `x-user-email` HTTP header:

```js
// backend/src/middleware/auth.js
const userEmail = req.headers['x-user-email'];
```

Any attacker who knows (or guesses) a user's email can impersonate them by setting this header. The frontend stores the email in `localStorage` and attaches it to every request via an Axios interceptor. Auto-registration on unknown emails means any string that passes a regex check creates a valid account.

### Impact

- Complete account takeover for any user
- No way to revoke access or detect unauthorized sessions
- Data for every user is one HTTP header away from full exposure

### Recommended Fix

Replace email-only auth with JWT-based sessions backed by hashed passwords (`bcrypt`). Issue a signed JWT on login; validate it in the auth middleware via the `Authorization: Bearer <token>` header. The `jsonwebtoken` package is already a dependency.

**Status: FIXED in this PR** — see `backend/src/middleware/auth.js`, `backend/src/routes/auth.js`, `frontend/src/pages/LoginPage.tsx`, and `frontend/src/api/client.ts`.

---

## Finding 2 — Broken Access Control via Header Spoofing (OWASP A01:2021)

**Severity: CRITICAL**

### Vulnerability

Data isolation between tenants relies entirely on the unauthenticated `x-user-email` header. Every SQL query filters by `user_email = ?` using this header value. Since the header is trivially spoofable, any user can read, modify, or delete another user's clients and work entries.

### Impact

- Full CRUD access to all users' data
- Delete-all-clients endpoint (`DELETE /api/clients`) amplifies the damage

### Recommended Fix

This is a direct consequence of Finding 1. Once JWT authentication is enforced, the `user_email` claim comes from a signed token that the client cannot forge.

**Status: FIXED in this PR** — the auth middleware now extracts the email from a verified JWT payload.

---

## Finding 3 — Cross-Site Scripting (XSS) Hardening (OWASP A03:2021)

**Severity: MEDIUM**

### Vulnerability

React's JSX auto-escaping provides baseline XSS protection, and the app does **not** use `dangerouslySetInnerHTML`. However:

1. **Error handler leaks internals** — The default error branch in `errorHandler.js` passes `err.message` verbatim to the client, which may contain stack traces, SQL errors, or file paths.
2. **No Content-Security-Policy (CSP)** — Helmet is used but CSP is not explicitly configured, leaving the default which may be too permissive in some deployments.
3. **PDF content injection** — Client names and descriptions are rendered directly into generated PDFs via `pdfkit`. While not a traditional XSS vector, malicious content could manipulate the PDF layout.

### Recommended Fix

- Sanitize error responses: return generic messages in production; never echo raw `err.message`.
- Configure Helmet with an explicit CSP that restricts `script-src`, `style-src`, and `connect-src`.
- Sanitize text content before rendering into PDFs.

**Status: FIXED in this PR** — error handler sanitized, Helmet CSP configured.

---

## Finding 4 — Cross-Site Request Forgery (CSRF) (OWASP A01:2021)

**Severity: MEDIUM**

### Vulnerability

No explicit CSRF protection is implemented. The app has partial natural protection because:
- API endpoints require `Content-Type: application/json` (HTML forms cannot send JSON)
- The custom `x-user-email` header (now `Authorization`) cannot be set by cross-origin form submissions

However, CORS is the only barrier, and misconfiguration could expose all state-changing endpoints.

### Recommended Fix

- Add explicit Origin/Referer header validation for state-changing requests.
- Configure CORS strictly: allowlist only the known frontend origin, reject requests with no or unknown Origin.
- After moving to JWT in Bearer tokens (Finding 1 fix), the attack surface is further reduced since cookies are not used.

**Status: FIXED in this PR** — added Origin header validation middleware and tightened CORS.

---

## Finding 5 — SQL Injection (OWASP A03:2021)

**Severity: LOW (properly mitigated)**

### Assessment

All SQL queries use parameterized placeholders (`?` with parameter arrays). Dynamic query building in the update endpoints (`clients.js:157`, `workEntries.js:223`) also uses parameterized queries. Integer IDs from URL params are parsed with `parseInt()` before use.

```js
// Example — properly parameterized
db.get('SELECT email FROM users WHERE email = ?', [userEmail], ...);
```

No string concatenation or template literals are used in SQL statements.

### Recommendation

No fix required. Continue using parameterized queries for any future SQL additions.

---

## Finding 6 — Security Misconfiguration (OWASP A05:2021)

**Severity: MEDIUM**

### Vulnerability

1. **Default JWT secret** — `.env.example` contains a default secret (`your-super-secret-jwt-key-change-this-in-production-min-32-chars`). If deployed without changing this, all tokens are forgeable.
2. **Unused dependency** — `jsonwebtoken` was listed but not used, suggesting the token-based auth was planned but never implemented.
3. **Verbose logging** — `morgan('combined')` logs all headers, which previously included the plaintext auth email.

### Recommended Fix

- Validate that `JWT_SECRET` is set at startup; refuse to start with the default value in production.
- Rotate or remove the default secret from `.env.example`.

**Status: PARTIALLY FIXED** — JWT is now enforced; startup validates `JWT_SECRET` presence.

---

## Finding 7 — Sensitive Data Exposure (OWASP A02:2021)

**Severity: LOW**

### Vulnerability

- `morgan('combined')` logs request headers, which could capture auth tokens.
- The health endpoint (`/health`) returns a timestamp but no sensitive data.
- Temp CSV files are created on disk during export and cleaned up afterward.

### Recommended Fix

- Redact `Authorization` header values from logs in production.
- Ensure temp file cleanup is guaranteed (use `finally` blocks or streams instead of temp files).

---

## Summary

| # | Finding | OWASP Category | Severity | Fixed? |
|---|---------|---------------|----------|--------|
| 1 | Email-only auth, no passwords/tokens | A07:2021 Identification & Authentication Failures | CRITICAL | Yes |
| 2 | Header-spoofable access control | A01:2021 Broken Access Control | CRITICAL | Yes |
| 3 | XSS hardening (error leakage, no CSP) | A03:2021 Injection | MEDIUM | Yes |
| 4 | No CSRF protection | A01:2021 Broken Access Control | MEDIUM | Yes |
| 5 | SQL Injection | A03:2021 Injection | LOW | N/A (already safe) |
| 6 | Security misconfiguration (default secrets) | A05:2021 Security Misconfiguration | MEDIUM | Partial |
| 7 | Sensitive data in logs | A02:2021 Cryptographic Failures | LOW | No |
