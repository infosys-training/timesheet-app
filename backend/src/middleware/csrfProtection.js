// Origin header validation for CSRF protection on state-changing requests
function csrfProtection(allowedOrigins) {
  const origins = Array.isArray(allowedOrigins) ? allowedOrigins : [allowedOrigins];

  return (req, res, next) => {
    // Only check state-changing methods
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    const origin = req.headers['origin'];
    const referer = req.headers['referer'];

    // If an Origin header is present, it must be in the allowlist
    if (origin) {
      if (origins.includes(origin)) {
        return next();
      }
      return res.status(403).json({ error: 'Forbidden: invalid origin' });
    }

    // Fall back to Referer check if no Origin header
    if (referer) {
      try {
        const refererOrigin = new URL(referer).origin;
        if (origins.includes(refererOrigin)) {
          return next();
        }
      } catch (_) {
        // malformed Referer
      }
      return res.status(403).json({ error: 'Forbidden: invalid origin' });
    }

    // Requests with no Origin/Referer are typically same-origin or non-browser.
    // Allow them since CORS already blocks cross-origin browser requests.
    next();
  };
}

module.exports = { csrfProtection };
