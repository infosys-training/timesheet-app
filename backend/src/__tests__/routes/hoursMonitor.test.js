const request = require('supertest');
const express = require('express');

jest.mock('../../database/init');
jest.mock('../../services/emailService');
jest.mock('../../middleware/auth', () => ({
  authenticateUser: (req, res, next) => {
    req.userEmail = 'test@example.com';
    next();
  }
}));

const { getDatabase } = require('../../database/init');
const { sendEmail } = require('../../services/emailService');
const hoursMonitorRoutes = require('../../routes/hoursMonitor');

const app = express();
app.use(express.json());
app.use('/api/hours-monitor', hoursMonitorRoutes);

describe('Hours Monitor Routes', () => {
  let mockDb;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = {
      all: jest.fn(),
      get: jest.fn(),
      run: jest.fn()
    };
    getDatabase.mockReturnValue(mockDb);
    sendEmail.mockResolvedValue({ accepted: ['test@example.com'], messageId: 'mock-id' });
  });

  describe('GET /api/hours-monitor/weekly-check', () => {
    test('should return alert=false when under threshold', async () => {
      mockDb.all.mockImplementation((query, params, callback) => {
        callback(null, [
          { hours: 10, description: 'Work', date: '2024-01-08', client_name: 'Client A' }
        ]);
      });

      const response = await request(app)
        .get('/api/hours-monitor/weekly-check?date=2024-01-10');

      expect(response.status).toBe(200);
      expect(response.body.alert).toBe(false);
      expect(response.body.totalHours).toBe(10);
    });

    test('should return alert=true and send email when over threshold', async () => {
      mockDb.all.mockImplementation((query, params, callback) => {
        callback(null, [
          { hours: 25, description: 'Work A', date: '2024-01-08', client_name: 'Client A' },
          { hours: 20, description: 'Work B', date: '2024-01-09', client_name: 'Client B' }
        ]);
      });

      const response = await request(app)
        .get('/api/hours-monitor/weekly-check?date=2024-01-10');

      expect(response.status).toBe(200);
      expect(response.body.alert).toBe(true);
      expect(response.body.totalHours).toBe(45);
      expect(response.body.emailSentTo).toBe('Jorawer_mann@infosys.com');
      expect(sendEmail).toHaveBeenCalled();
    });

    test('should return 500 on database error', async () => {
      mockDb.all.mockImplementation((query, params, callback) => {
        callback(new Error('DB error'));
      });

      const response = await request(app)
        .get('/api/hours-monitor/weekly-check?date=2024-01-10');

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to check weekly hours');
    });

    test('should use current date when no date query param', async () => {
      mockDb.all.mockImplementation((query, params, callback) => {
        callback(null, []);
      });

      const response = await request(app)
        .get('/api/hours-monitor/weekly-check');

      expect(response.status).toBe(200);
      expect(response.body.alert).toBe(false);
    });
  });
});
