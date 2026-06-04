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
    test.each([
      ['multiple details', [{ message: 'Field is required' }, { message: 'Invalid format' }], ['Field is required', 'Invalid format']],
      ['single detail', [{ message: 'Name is required' }], ['Name is required']],
    ])('should handle Joi validation error with %s', (_, details, expectedDetails) => {
      errorHandler({ isJoi: true, details }, req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Validation error', details: expectedDetails });
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

    test.each([
      ['SQLITE_CONSTRAINT', 'UNIQUE constraint failed'],
      ['SQLITE_ERROR', 'SQL error'],
    ])('should handle %s error as 500', (code, message) => {
      errorHandler({ code, message }, req, res, next);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Database error',
        message: 'An error occurred while processing your request'
      });
    });
  });

  describe('Generic Errors', () => {
    test.each([
      ['custom status', { status: 403, message: 'Forbidden access' }, 403, { error: 'Forbidden access' }],
      ['default 500 status', { message: 'Something went wrong' }, 500, { error: 'Something went wrong' }],
      ['default message', {}, 500, { error: 'Internal server error' }],
    ])('should handle %s', (_, err, expectedStatus, expectedBody) => {
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(expectedStatus);
      expect(res.json).toHaveBeenCalledWith(expectedBody);
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
