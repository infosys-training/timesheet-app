const jwt = require('jsonwebtoken');
const { authenticateUser, JWT_SECRET } = require('../../middleware/auth');
const { getDatabase } = require('../../database/init');

jest.mock('../../database/init');

describe('Authentication Middleware', () => {
  let req, res, next, mockDb;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    req = { headers: {} };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
    mockDb = { get: jest.fn(), run: jest.fn() };
    getDatabase.mockReturnValue(mockDb);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    jest.clearAllMocks();
  });

  function runAuth(assertions) {
    authenticateUser(req, res, next);
    return new Promise(resolve => setImmediate(() => { assertions(); resolve(); }));
  }

  describe('Email Header Validation (dev/test mode)', () => {
    test('should return 401 if no auth provided', () => {
      authenticateUser(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
      expect(next).not.toHaveBeenCalled();
    });

    test('should return 400 if email format is invalid', () => {
      req.headers['x-user-email'] = 'invalid-email';
      authenticateUser(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid email format' });
      expect(next).not.toHaveBeenCalled();
    });

    test('should accept valid email format via x-user-email header', () => {
      req.headers['x-user-email'] = 'test@example.com';
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { email: 'test@example.com' });
      });
      authenticateUser(req, res, next);
      expect(mockDb.get).toHaveBeenCalled();
    });
  });

  describe('JWT Authentication', () => {
    test('should authenticate with valid JWT token', async () => {
      const token = jwt.sign({ email: 'jwt@example.com' }, JWT_SECRET, { expiresIn: '1h' });
      req.headers['authorization'] = `Bearer ${token}`;
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { email: 'jwt@example.com' });
      });
      await runAuth(() => {
        expect(req.userEmail).toBe('jwt@example.com');
        expect(next).toHaveBeenCalled();
      });
    });

    test('should return 401 for invalid JWT token', () => {
      req.headers['authorization'] = 'Bearer invalid-token-here';
      authenticateUser(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
      expect(next).not.toHaveBeenCalled();
    });

    test('should return 401 for expired JWT token', () => {
      const token = jwt.sign({ email: 'test@example.com' }, JWT_SECRET, { expiresIn: '-1h' });
      req.headers['authorization'] = `Bearer ${token}`;
      authenticateUser(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
    });

    test('should reject x-user-email header in production without JWT', () => {
      process.env.NODE_ENV = 'production';
      req.headers['x-user-email'] = 'test@example.com';
      authenticateUser(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
    });
  });

  describe('User Lookup and Creation', () => {
    test('should authenticate existing user and call next()', async () => {
      req.headers['x-user-email'] = 'existing@example.com';
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { email: 'existing@example.com' });
      });
      await runAuth(() => {
        expect(req.userEmail).toBe('existing@example.com');
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });
    });

    test('should handle database error when checking user', async () => {
      req.headers['x-user-email'] = 'test@example.com';
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });
      await runAuth(() => {
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
        expect(next).not.toHaveBeenCalled();
      });
    });

    test('should create new user if not exists and call next()', async () => {
      req.headers['x-user-email'] = 'newuser@example.com';
      mockDb.get.mockImplementation((query, params, callback) => callback(null, null));
      mockDb.run.mockImplementation((query, params, callback) => callback(null));
      await runAuth(() => {
        expect(mockDb.run).toHaveBeenCalledWith(
          'INSERT INTO users (email) VALUES (?)',
          ['newuser@example.com'],
          expect.any(Function)
        );
        expect(req.userEmail).toBe('newuser@example.com');
        expect(next).toHaveBeenCalled();
      });
    });

    test('should handle error when creating new user', async () => {
      req.headers['x-user-email'] = 'newuser@example.com';
      mockDb.get.mockImplementation((query, params, callback) => callback(null, null));
      mockDb.run.mockImplementation((query, params, callback) => callback(new Error('Insert failed')));
      await runAuth(() => {
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'Failed to create user' });
        expect(next).not.toHaveBeenCalled();
      });
    });
  });

  describe('Email Format Edge Cases', () => {
    test.each([
      ['notanemail', 400],
      ['test@', 400],
      ['test@domain', 400],
    ])('should reject invalid email "%s"', (email, expectedStatus) => {
      req.headers['x-user-email'] = email;
      authenticateUser(req, res, next);
      expect(res.status).toHaveBeenCalledWith(expectedStatus);
    });

    test('should accept email with subdomain', () => {
      req.headers['x-user-email'] = 'test@mail.example.com';
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { email: 'test@mail.example.com' });
      });
      authenticateUser(req, res, next);
      expect(mockDb.get).toHaveBeenCalled();
    });
  });
});
