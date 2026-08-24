const { authenticateUser, requireApprover, roleForEmail } = require('../../middleware/auth');
const { getDatabase } = require('../../database/init');

jest.mock('../../database/init');

describe('Authentication Middleware', () => {
  let req, res, next, mockDb;

  beforeEach(() => {
    req = {
      headers: {}
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    next = jest.fn();
    
    mockDb = {
      get: jest.fn(),
      run: jest.fn()
    };
    
    getDatabase.mockReturnValue(mockDb);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Email Header Validation', () => {
    test('should return 401 if x-user-email header is missing', () => {
      authenticateUser(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'User email required in x-user-email header'
      });
      expect(next).not.toHaveBeenCalled();
    });

    test('should return 400 if email format is invalid', () => {
      req.headers['x-user-email'] = 'invalid-email';

      authenticateUser(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invalid email format'
      });
      expect(next).not.toHaveBeenCalled();
    });

    test('should accept valid email format', () => {
      req.headers['x-user-email'] = 'test@example.com';
      
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { email: 'test@example.com' });
      });

      authenticateUser(req, res, next);

      expect(mockDb.get).toHaveBeenCalled();
    });
  });

  describe('Existing User Authentication', () => {
    test('should authenticate existing user and call next()', (done) => {
      req.headers['x-user-email'] = 'existing@example.com';
      
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { email: 'existing@example.com' });
      });

      authenticateUser(req, res, next);

      setImmediate(() => {
        expect(req.userEmail).toBe('existing@example.com');
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
        done();
      });
    });

    test('should handle database error when checking user', (done) => {
      req.headers['x-user-email'] = 'test@example.com';
      
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      authenticateUser(req, res, next);

      setImmediate(() => {
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
          error: 'Internal server error'
        });
        expect(next).not.toHaveBeenCalled();
        done();
      });
    });
  });

  describe('New User Creation', () => {
    test('should create new user if not exists and call next()', (done) => {
      req.headers['x-user-email'] = 'newuser@example.com';
      
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null); // User doesn't exist
      });
      
      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      authenticateUser(req, res, next);

      setImmediate(() => {
        expect(mockDb.run).toHaveBeenCalledWith(
          'INSERT INTO users (email, role) VALUES (?, ?)',
          ['newuser@example.com', 'employee'],
          expect.any(Function)
        );
        expect(req.userEmail).toBe('newuser@example.com');
        expect(req.userRole).toBe('employee');
        expect(next).toHaveBeenCalled();
        done();
      });
    });

    test('should handle error when creating new user', (done) => {
      req.headers['x-user-email'] = 'newuser@example.com';
      
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null);
      });
      
      mockDb.run.mockImplementation((query, params, callback) => {
        callback(new Error('Insert failed'));
      });

      authenticateUser(req, res, next);

      setImmediate(() => {
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
          error: 'Failed to create user'
        });
        expect(next).not.toHaveBeenCalled();
        done();
      });
    });
  });

  describe('Role Assignment', () => {
    const originalApprovers = process.env.APPROVER_EMAILS;

    afterEach(() => {
      if (originalApprovers === undefined) {
        delete process.env.APPROVER_EMAILS;
      } else {
        process.env.APPROVER_EMAILS = originalApprovers;
      }
    });

    test('roleForEmail returns approver for configured emails, case-insensitively', () => {
      process.env.APPROVER_EMAILS = 'Boss@example.com, lead@example.com';

      expect(roleForEmail('boss@EXAMPLE.com')).toBe('approver');
      expect(roleForEmail('lead@example.com')).toBe('approver');
      expect(roleForEmail('worker@example.com')).toBe('employee');
    });

    test('roleForEmail returns employee when no approvers are configured', () => {
      delete process.env.APPROVER_EMAILS;

      expect(roleForEmail('anyone@example.com')).toBe('employee');
    });

    test('should create new user with approver role when configured', (done) => {
      process.env.APPROVER_EMAILS = 'boss@example.com';
      req.headers['x-user-email'] = 'boss@example.com';

      mockDb.get.mockImplementation((query, params, callback) => callback(null, null));
      mockDb.run.mockImplementation((query, params, callback) => callback(null));

      authenticateUser(req, res, next);

      setImmediate(() => {
        expect(mockDb.run).toHaveBeenCalledWith(
          'INSERT INTO users (email, role) VALUES (?, ?)',
          ['boss@example.com', 'approver'],
          expect.any(Function)
        );
        expect(req.userRole).toBe('approver');
        done();
      });
    });

    test('should read the stored role for existing users', (done) => {
      req.headers['x-user-email'] = 'boss@example.com';

      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { email: 'boss@example.com', role: 'approver' });
      });

      authenticateUser(req, res, next);

      setImmediate(() => {
        expect(req.userRole).toBe('approver');
        expect(next).toHaveBeenCalled();
        done();
      });
    });

    test('should default to employee when the stored role is missing', (done) => {
      req.headers['x-user-email'] = 'legacy@example.com';

      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { email: 'legacy@example.com', role: null });
      });

      authenticateUser(req, res, next);

      setImmediate(() => {
        expect(req.userRole).toBe('employee');
        done();
      });
    });
  });

  describe('requireApprover', () => {
    test('should call next() for approvers', () => {
      req.userRole = 'approver';

      requireApprover(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('should return 403 for employees', () => {
      req.userRole = 'employee';

      requireApprover(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Approver role required' });
      expect(next).not.toHaveBeenCalled();
    });

    test('should return 403 when no role is set', () => {
      requireApprover(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Email Format Edge Cases', () => {
    test('should reject email without @', () => {
      req.headers['x-user-email'] = 'notanemail';
      authenticateUser(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('should reject email without domain', () => {
      req.headers['x-user-email'] = 'test@';
      authenticateUser(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('should reject email without TLD', () => {
      req.headers['x-user-email'] = 'test@domain';
      authenticateUser(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
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
