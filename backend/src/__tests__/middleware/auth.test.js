const { authenticateUser, requireApprover } = require('../../middleware/auth');
const { getDatabase } = require('../../database/init');

jest.mock('../../database/init');

describe('Authentication Middleware', () => {
  let req, res, next, mockDb;
  let originalApproverEmails;

  beforeEach(() => {
    originalApproverEmails = process.env.APPROVER_EMAILS;
    process.env.APPROVER_EMAILS = '';
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
    if (originalApproverEmails === undefined) {
      delete process.env.APPROVER_EMAILS;
    } else {
      process.env.APPROVER_EMAILS = originalApproverEmails;
    }
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
        callback(null, { email: 'existing@example.com', role: 'employee' });
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

  describe('Role handling', () => {
    test('should create an approver for a configured email', (done) => {
      process.env.APPROVER_EMAILS = ' first@example.com, APPROVER@example.com ';
      req.headers['x-user-email'] = 'approver@example.com';
      mockDb.get.mockImplementation((query, params, callback) => callback(null, null));
      mockDb.run.mockImplementation((query, params, callback) => callback(null));

      authenticateUser(req, res, next);

      setImmediate(() => {
        expect(mockDb.run).toHaveBeenCalledWith(
          'INSERT INTO users (email, role) VALUES (?, ?)',
          ['approver@example.com', 'approver'],
          expect.any(Function)
        );
        expect(req.userRole).toBe('approver');
        expect(req.isApprover).toBe(true);
        done();
      });
    });

    test('should reconcile an existing user role with configuration', (done) => {
      process.env.APPROVER_EMAILS = 'approver@example.com';
      req.headers['x-user-email'] = 'approver@example.com';
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { email: 'approver@example.com', role: 'employee' });
      });
      mockDb.run.mockImplementation((query, params, callback) => callback(null));

      authenticateUser(req, res, next);

      setImmediate(() => {
        expect(mockDb.run).toHaveBeenCalledWith(
          'UPDATE users SET role = ? WHERE email = ?',
          ['approver', 'approver@example.com'],
          expect.any(Function)
        );
        expect(req.userRole).toBe('approver');
        expect(req.isApprover).toBe(true);
        done();
      });
    });

    test('should allow approvers through requireApprover', () => {
      req.isApprover = true;
      requireApprover(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('should reject non-approvers through requireApprover', () => {
      req.isApprover = false;
      requireApprover(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Approver role required' });
      expect(next).not.toHaveBeenCalled();
    });
  });
});
