const request = require('supertest');
const express = require('express');
const authRoutes = require('../../routes/auth');
const { getDatabase } = require('../../database/init');

jest.mock('../../database/init');

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
// Add error handler for Joi validation
app.use((err, req, res, next) => {
  if (err.isJoi) {
    return res.status(400).json({ error: 'Validation error' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

describe('Auth Routes', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = {
      get: jest.fn(),
      run: jest.fn()
    };
    getDatabase.mockReturnValue(mockDb);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/auth/login', () => {
    test('should login existing user', async () => {
      const existingUser = {
        email: 'existing@example.com',
        created_at: '2024-01-01T00:00:00.000Z'
      };

      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, existingUser);
      });

      const response = await request(app)
        .post('/api/auth/login')
        .send({ email: 'existing@example.com' });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Login successful');
      expect(response.body.token).toBeDefined();
      expect(response.body.user.email).toBe('existing@example.com');
    });

    test('should create new user on first login', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null); // User doesn't exist
      });

      mockDb.run.mockImplementation(function(query, params, callback) {
        callback.call(this, null);
      });

      const response = await request(app)
        .post('/api/auth/login')
        .send({ email: 'newuser@example.com' });

      expect(response.status).toBe(201);
      expect(response.body.message).toBe('User created and logged in successfully');
      expect(response.body.token).toBeDefined();
      expect(response.body.user.email).toBe('newuser@example.com');
      expect(mockDb.run).toHaveBeenCalledWith(
        'INSERT INTO users (email) VALUES (?)',
        ['newuser@example.com'],
        expect.any(Function)
      );
    });

    test.each([
      ['invalid email', { email: 'invalid-email' }],
      ['missing email', {}],
    ])('should return 400 for %s', async (_, body) => {
      const response = await request(app).post('/api/auth/login').send(body);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation error');
    });

    test('should handle database error when checking user', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app)
        .post('/api/auth/login')
        .send({ email: 'test@example.com' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });

    test('should handle database error when creating user', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null);
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(new Error('Insert failed'));
      });

      const response = await request(app)
        .post('/api/auth/login')
        .send({ email: 'newuser@example.com' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to create user' });
    });

    test('should handle unexpected errors in try-catch block', async () => {
      getDatabase.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const response = await request(app)
        .post('/api/auth/login')
        .send({ email: 'test@example.com' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('GET /api/auth/me', () => {
    test('should return current user info', async () => {
      const user = {
        email: 'test@example.com',
        created_at: '2024-01-01T00:00:00.000Z'
      };

      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, user);
      });

      const response = await request(app)
        .get('/api/auth/me')
        .set('x-user-email', 'test@example.com');

      expect(response.status).toBe(200);
      expect(response.body.user.email).toBe('test@example.com');
      expect(response.body.user.createdAt).toBe('2024-01-01T00:00:00.000Z');
    });

    test('should return 401 if no email header provided', async () => {
      const response = await request(app).get('/api/auth/me');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Authentication required' });
    });

    test.each([
      ['should return 404 if user not found', null, null, 404, { error: 'User not found' }],
      ['should handle database error', new Error('Database error'), null, 500, { error: 'Internal server error' }],
    ])('%s', async (_, meError, meResult, expectedStatus, expectedBody) => {
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('SELECT email FROM users WHERE email = ?')) {
          callback(null, { email: 'test@example.com' });
        } else {
          callback(meError, meResult);
        }
      });

      const response = await request(app)
        .get('/api/auth/me')
        .set('x-user-email', 'test@example.com');

      expect(response.status).toBe(expectedStatus);
      expect(response.body).toEqual(expectedBody);
    });
  });
});
