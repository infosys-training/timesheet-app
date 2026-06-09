function errorHandler(err, req, res, next) {
  console.error('Error:', err);

  // Joi validation errors
  if (err.isJoi) {
    return res.status(400).json({
      error: 'Validation error',
      details: err.details.map(detail => detail.message)
    });
  }

  // SQLite errors — never leak internal details
  if (err.code && err.code.startsWith('SQLITE_')) {
    return res.status(500).json({
      error: 'An error occurred while processing your request'
    });
  }

  // Default error — sanitize: never expose raw error messages in production
  const statusCode = err.status || 500;
  const isProduction = process.env.NODE_ENV === 'production';

  res.status(statusCode).json({
    error: statusCode === 500
      ? 'Internal server error'
      : err.message || 'Internal server error'
  });
}

module.exports = {
  errorHandler
};
