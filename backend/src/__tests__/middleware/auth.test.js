const { authenticateUser, requireApprover, isApprover } = require('../../middleware/auth');
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
          'INSERT INTO users (email) VALUES (?)',
          ['newuser@example.com'],
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

  describe('Approver Role', () => {
    const originalApproverEmails = process.env.APPROVER_EMAILS;

    afterEach(() => {
      if (originalApproverEmails === undefined) {
        delete process.env.APPROVER_EMAILS;
      } else {
        process.env.APPROVER_EMAILS = originalApproverEmails;
      }
    });

    test('should recognise configured approver emails case insensitively', () => {
      process.env.APPROVER_EMAILS = ' Approver@example.com , second@example.com ';

      expect(isApprover('approver@example.com')).toBe(true);
      expect(isApprover('second@example.com')).toBe(true);
      expect(isApprover('employee@example.com')).toBe(false);
    });

    test('should treat everyone as employee when no approvers are configured', () => {
      delete process.env.APPROVER_EMAILS;

      expect(isApprover('anyone@example.com')).toBe(false);
    });

    test('should attach approver role to the request', (done) => {
      process.env.APPROVER_EMAILS = 'approver@example.com';
      req.headers['x-user-email'] = 'approver@example.com';

      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { email: 'approver@example.com' });
      });

      authenticateUser(req, res, next);

      setImmediate(() => {
        expect(req.isApprover).toBe(true);
        expect(req.userRole).toBe('approver');
        done();
      });
    });

    test('should attach employee role to a non-approver request', (done) => {
      process.env.APPROVER_EMAILS = 'approver@example.com';
      req.headers['x-user-email'] = 'employee@example.com';

      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null);
      });
      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      authenticateUser(req, res, next);

      setImmediate(() => {
        expect(req.isApprover).toBe(false);
        expect(req.userRole).toBe('employee');
        done();
      });
    });

    test('requireApprover should call next for an approver', () => {
      req.isApprover = true;

      requireApprover(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('requireApprover should return 403 for a non-approver', () => {
      req.isApprover = false;

      requireApprover(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Approver role required' });
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
