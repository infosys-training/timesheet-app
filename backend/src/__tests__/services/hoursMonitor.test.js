const request = require('supertest');
const express = require('express');

jest.mock('../../database/init');
jest.mock('../../services/emailService');
jest.mock('../../middleware/auth');

const { getDatabase } = require('../../database/init');
const { sendEmail } = require('../../services/emailService');
const { checkAndAlert, getWeekBounds, buildReportHtml } = require('../../services/hoursMonitor');
const { underThresholdEntries, overThresholdEntries, createMockDb } = require('../helpers/mockEntries');
const hoursMonitorRoutes = require('../../routes/hoursMonitor');

const app = express();
app.use(express.json());
app.use('/api/hours-monitor', hoursMonitorRoutes);

describe('HoursMonitor', () => {
  let mockDb;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = createMockDb();
    getDatabase.mockReturnValue(mockDb);
    sendEmail.mockResolvedValue({ accepted: ['test@example.com'], messageId: 'mock-id' });
  });

  describe('getWeekBounds', () => {
    test('should return Monday-Sunday for a Wednesday', () => {
      const { weekStart, weekEnd } = getWeekBounds('2024-01-10');
      expect(weekStart).toBe('2024-01-08');
      expect(weekEnd).toBe('2024-01-14');
    });

    test('should return correct bounds for a Monday', () => {
      const { weekStart, weekEnd } = getWeekBounds('2024-01-08');
      expect(weekStart).toBe('2024-01-08');
      expect(weekEnd).toBe('2024-01-14');
    });

    test('should return correct bounds for a Sunday', () => {
      const { weekStart, weekEnd } = getWeekBounds('2024-01-14');
      expect(weekStart).toBe('2024-01-08');
      expect(weekEnd).toBe('2024-01-14');
    });

    test('should handle week spanning across months', () => {
      const { weekStart, weekEnd } = getWeekBounds('2024-02-01');
      expect(weekStart).toBe('2024-01-29');
      expect(weekEnd).toBe('2024-02-04');
    });
  });

  describe('buildReportHtml', () => {
    test('should produce HTML with employee, hours, and client breakdown', () => {
      const entries = [
        { date: '2024-01-08', client_name: 'Acme', hours: 25, description: 'Dev work' },
        { date: '2024-01-09', client_name: 'Acme', hours: 10, description: 'Testing' },
        { date: '2024-01-10', client_name: 'Beta Corp', hours: 8, description: '' }
      ];

      const html = buildReportHtml('employee@test.com', 43, entries, '2024-01-08', '2024-01-14');

      expect(html).toContain('employee@test.com');
      expect(html).toContain('43.00');
      expect(html).toContain('Acme: 35.00 hrs');
      expect(html).toContain('Beta Corp: 8.00 hrs');
      expect(html).toContain('Dev work');
    });
  });

  describe('checkAndAlert', () => {
    test('should not send email when hours are under threshold', async () => {
      mockDb.all.mockImplementation((q, p, cb) => cb(null, underThresholdEntries));

      const result = await checkAndAlert('user@test.com', '2024-01-10');

      expect(result.alert).toBe(false);
      expect(result.totalHours).toBe(25);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    test('should send email when hours exceed threshold', async () => {
      mockDb.all.mockImplementation((q, p, cb) => cb(null, overThresholdEntries));

      const result = await checkAndAlert('user@test.com', '2024-01-10');

      expect(result.alert).toBe(true);
      expect(result.totalHours).toBe(45);
      expect(result.emailSentTo).toBe('Jorawer_mann@infosys.com');
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'Jorawer_mann@infosys.com',
          subject: expect.stringContaining('Hours Threshold Exceeded'),
          html: expect.stringContaining('user@test.com')
        })
      );
    });

    test('should not send email when hours exactly equal threshold', async () => {
      mockDb.all.mockImplementation((q, p, cb) => cb(null, [
        { hours: 20, description: 'Work', date: '2024-01-08', client_name: 'Client A' },
        { hours: 20, description: 'Work', date: '2024-01-09', client_name: 'Client A' }
      ]));

      const result = await checkAndAlert('user@test.com', '2024-01-10');

      expect(result.alert).toBe(false);
      expect(result.totalHours).toBe(40);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    test('should handle empty entries', async () => {
      mockDb.all.mockImplementation((q, p, cb) => cb(null, []));

      const result = await checkAndAlert('user@test.com', '2024-01-10');

      expect(result.alert).toBe(false);
      expect(result.totalHours).toBe(0);
    });

    test('should reject on database error', async () => {
      mockDb.all.mockImplementation((q, p, cb) => cb(new Error('DB error')));

      await expect(checkAndAlert('user@test.com', '2024-01-10')).rejects.toThrow('DB error');
    });

    test('should query the correct week range', async () => {
      mockDb.all.mockImplementation((q, params, cb) => {
        expect(params).toEqual(['user@test.com', '2024-01-08', '2024-01-14']);
        cb(null, []);
      });

      await checkAndAlert('user@test.com', '2024-01-10');
      expect(mockDb.all).toHaveBeenCalled();
    });
  });

  describe('GET /api/hours-monitor/weekly-check (route)', () => {
    const weeklyCheck = (date) =>
      request(app).get(`/api/hours-monitor/weekly-check${date ? `?date=${date}` : ''}`);

    test('should return alert=false when under threshold', async () => {
      mockDb.all.mockImplementation((q, p, cb) => cb(null, underThresholdEntries));
      const { status, body } = await weeklyCheck('2024-01-10');
      expect(status).toBe(200);
      expect(body.alert).toBe(false);
      expect(body.totalHours).toBe(25);
    });

    test('should return alert=true and send email when over threshold', async () => {
      mockDb.all.mockImplementation((q, p, cb) => cb(null, overThresholdEntries));
      const { status, body } = await weeklyCheck('2024-01-10');
      expect(status).toBe(200);
      expect(body.alert).toBe(true);
      expect(body.emailSentTo).toBe('Jorawer_mann@infosys.com');
    });

    test('should return 500 on database error', async () => {
      mockDb.all.mockImplementation((q, p, cb) => cb(new Error('DB error')));
      const { status, body } = await weeklyCheck('2024-01-10');
      expect(status).toBe(500);
      expect(body.error).toBe('Failed to check weekly hours');
    });

    test('should use current date when no date query param', async () => {
      mockDb.all.mockImplementation((q, p, cb) => cb(null, []));
      const { status, body } = await weeklyCheck();
      expect(status).toBe(200);
      expect(body.alert).toBe(false);
    });
  });
});
