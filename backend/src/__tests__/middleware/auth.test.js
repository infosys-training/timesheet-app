const jwt = require('jsonwebtoken');
const { authenticateUser } = require('../../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret';

describe('Authentication Middleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      headers: {}
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    next = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Authorization Header Validation', () => {
    test('should return 401 if Authorization header is missing', () => {
      authenticateUser(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Authorization token required'
      });
      expect(next).not.toHaveBeenCalled();
    });

    test('should return 401 if Authorization header has wrong format', () => {
      req.headers['authorization'] = 'Basic some-token';

      authenticateUser(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Authorization token required'
      });
      expect(next).not.toHaveBeenCalled();
    });

    test('should return 401 for invalid token', () => {
      req.headers['authorization'] = 'Bearer invalid-token';

      authenticateUser(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invalid token'
      });
      expect(next).not.toHaveBeenCalled();
    });

    test('should return 401 for expired token', () => {
      const expiredToken = jwt.sign(
        { email: 'test@example.com' },
        JWT_SECRET,
        { expiresIn: '-1s' }
      );
      req.headers['authorization'] = `Bearer ${expiredToken}`;

      authenticateUser(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Token expired'
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Valid Token Authentication', () => {
    test('should authenticate user with valid token and call next()', () => {
      const token = jwt.sign(
        { email: 'test@example.com' },
        JWT_SECRET,
        { expiresIn: '1h' }
      );
      req.headers['authorization'] = `Bearer ${token}`;

      authenticateUser(req, res, next);

      expect(req.userEmail).toBe('test@example.com');
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('should extract email from token payload', () => {
      const token = jwt.sign(
        { email: 'another@example.com' },
        JWT_SECRET,
        { expiresIn: '1h' }
      );
      req.headers['authorization'] = `Bearer ${token}`;

      authenticateUser(req, res, next);

      expect(req.userEmail).toBe('another@example.com');
      expect(next).toHaveBeenCalled();
    });
  });
});
