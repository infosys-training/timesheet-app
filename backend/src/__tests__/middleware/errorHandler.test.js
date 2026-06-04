const { errorHandler } = require('../../middleware/errorHandler');

describe('Error Handler Middleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = {};
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    next = jest.fn();
    
    // Mock console.error to avoid cluttering test output
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Joi Validation Errors', () => {
    test('should handle Joi validation error', () => {
      const joiError = {
        isJoi: true,
        details: [
          { message: 'Field is required' },
          { message: 'Invalid format' }
        ]
      };

      errorHandler(joiError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Validation error',
        details: ['Field is required', 'Invalid format']
      });
    });

    test('should handle single Joi validation error', () => {
      const joiError = {
        isJoi: true,
        details: [{ message: 'Name is required' }]
      };

      errorHandler(joiError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Validation error',
        details: ['Name is required']
      });
    });
  });

  describe('SQLite Errors', () => {
    test('should handle SQLITE_BUSY error with 503 and Retry-After', () => {
      res.setHeader = jest.fn().mockReturnThis();
      const busyError = {
        code: 'SQLITE_BUSY',
        message: 'Database is locked'
      };

      errorHandler(busyError, req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '1');
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Database busy',
        message: 'Server is under heavy load, please retry'
      });
    });

    test('should handle SQLITE_CONSTRAINT error', () => {
      const sqliteError = {
        code: 'SQLITE_CONSTRAINT',
        message: 'UNIQUE constraint failed'
      };

      errorHandler(sqliteError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Database error',
        message: 'An error occurred while processing your request'
      });
    });

    test('should handle SQLITE_ERROR', () => {
      const sqliteError = {
        code: 'SQLITE_ERROR',
        message: 'SQL error'
      };

      errorHandler(sqliteError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Database error',
        message: 'An error occurred while processing your request'
      });
    });
  });

  describe('Generic Errors', () => {
    test('should handle error with custom status', () => {
      const customError = {
        status: 403,
        message: 'Forbidden access'
      };

      errorHandler(customError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Forbidden access'
      });
    });

    test('should default to 500 status if not specified', () => {
      const genericError = {
        message: 'Something went wrong'
      };

      errorHandler(genericError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Something went wrong'
      });
    });

    test('should use default message if none provided', () => {
      const emptyError = {};

      errorHandler(emptyError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Internal server error'
      });
    });
  });

  describe('Console Logging', () => {
    test('should log error to console', () => {
      const error = new Error('Test error');
      
      errorHandler(error, req, res, next);

      expect(console.error).toHaveBeenCalledWith('Error:', error);
    });
  });
});
