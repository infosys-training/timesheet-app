const request = require('supertest');
const express = require('express');
const { getDatabase } = require('../../database/init');

jest.mock('../../database/init');
jest.mock('pdfkit', () => {
  return jest.fn().mockImplementation(() => ({
    fontSize: jest.fn().mockReturnThis(),
    text: jest.fn().mockReturnThis(),
    moveDown: jest.fn().mockReturnThis(),
    moveTo: jest.fn().mockReturnThis(),
    lineTo: jest.fn().mockReturnThis(),
    stroke: jest.fn().mockReturnThis(),
    addPage: jest.fn().mockReturnThis(),
    pipe: jest.fn(),
    end: jest.fn(),
    y: 100
  }));
});

const reportRoutes = require('../../routes/reports');
jest.mock('../../middleware/auth', () => ({
  authenticateUser: (req, res, next) => {
    req.userEmail = 'test@example.com';
    next();
  },
  JWT_SECRET: 'test-secret'
}));

const app = express();
app.use(express.json());
app.use('/api/reports', reportRoutes);

describe('Report Routes', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = { all: jest.fn(), get: jest.fn() };
    getDatabase.mockReturnValue(mockDb);
  });

  afterEach(() => { jest.clearAllMocks(); });

  function setupMocks({ client, count, entries, clientErr, countErr, entriesErr }) {
    let getCallCount = 0;
    mockDb.get.mockImplementation((query, params, callback) => {
      getCallCount++;
      if (getCallCount === 1) {
        return callback(clientErr || null, client || null);
      }
      return callback(countErr || null, count !== undefined ? { count } : null);
    });
    if (entries !== undefined || entriesErr) {
      mockDb.all.mockImplementation((query, params, callback) => {
        callback(entriesErr || null, entriesErr ? null : entries);
      });
    }
  }

  describe.each([
    ['/api/reports/client', 'JSON report'],
    ['/api/reports/export/csv', 'CSV export'],
    ['/api/reports/export/pdf', 'PDF export'],
  ])('%s — shared validation (%s)', (basePath) => {
    test('should return 400 for invalid client ID', async () => {
      const response = await request(app).get(`${basePath}/invalid`);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid client ID' });
    });

    test('should return 404 if client not found', async () => {
      setupMocks({ client: null });
      const response = await request(app).get(`${basePath}/999`);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Client not found' });
    });

    test('should handle database error when fetching client', async () => {
      setupMocks({ clientErr: new Error('Database error') });
      const response = await request(app).get(`${basePath}/1`);
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });

    test('should return 400 when entry count exceeds 10000', async () => {
      setupMocks({ client: { id: 1, name: 'X' }, count: 15000 });
      const response = await request(app).get(`${basePath}/1`);
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Too many entries');
    });

    test('should handle database error when fetching entries', async () => {
      setupMocks({ client: { id: 1, name: 'X' }, count: 1, entriesErr: new Error('DB error') });
      const response = await request(app).get(`${basePath}/1`);
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('GET /api/reports/client/:clientId', () => {
    test('should return client report with work entries', async () => {
      const entries = [
        { id: 1, hours: 5.5, description: 'Work 1', date: '2024-01-01' },
        { id: 2, hours: 3.0, description: 'Work 2', date: '2024-01-02' }
      ];
      setupMocks({ client: { id: 1, name: 'Test Client' }, count: 2, entries });

      const response = await request(app).get('/api/reports/client/1');
      expect(response.status).toBe(200);
      expect(response.body.client).toEqual({ id: 1, name: 'Test Client' });
      expect(response.body.totalHours).toBe(8.5);
      expect(response.body.entryCount).toBe(2);
    });

    test('should return report with zero hours for empty client', async () => {
      setupMocks({ client: { id: 1, name: 'Empty' }, count: 0, entries: [] });
      const response = await request(app).get('/api/reports/client/1');
      expect(response.status).toBe(200);
      expect(response.body.totalHours).toBe(0);
      expect(response.body.entryCount).toBe(0);
    });

    test('should support startDate and endDate query params', async () => {
      setupMocks({ client: { id: 1, name: 'X' }, count: 2, entries: [] });
      await request(app).get('/api/reports/client/1?startDate=2024-01-01&endDate=2024-01-31');
      const countCall = mockDb.get.mock.calls[1];
      expect(countCall[0]).toContain('date >= ?');
      expect(countCall[0]).toContain('date <= ?');
    });

    test('should correctly sum decimal hours', async () => {
      setupMocks({ client: { id: 1, name: 'X' }, count: 3, entries: [{ hours: 2.5 }, { hours: 3.75 }, { hours: 1.25 }] });
      const response = await request(app).get('/api/reports/client/1');
      expect(response.body.totalHours).toBe(7.5);
    });
  });

  describe('GET /api/reports/export/csv/:clientId', () => {
    test('should stream CSV response directly', async () => {
      const entries = [{ date: '2024-01-01', hours: 5, description: 'Work 1', created_at: '2024-01-01T00:00:00Z' }];
      setupMocks({ client: { id: 1, name: 'Test Client' }, count: 1, entries });

      const response = await request(app).get('/api/reports/export/csv/1');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.text).toContain('Date,Hours,Description,Created At');
      expect(response.text).toContain('2024-01-01');
    });
  });

  describe('Data Isolation', () => {
    test('should only query data for authenticated user', async () => {
      setupMocks({ client: { id: 1, name: 'X' }, count: 0, entries: [] });
      await request(app).get('/api/reports/client/1');
      expect(mockDb.get).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['test@example.com']),
        expect.any(Function)
      );
    });
  });
});
