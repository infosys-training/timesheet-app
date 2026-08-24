const request = require('supertest');
const express = require('express');
const { getDatabase } = require('../../database/init');
const { STATUS } = require('../../workflow/workEntryStatus');

process.env.APPROVER_EMAILS = 'approver@example.com';

// Authenticate as this user, requireApprover keeps its real implementation
var mockCurrentEmail = 'owner@example.com'; // eslint-disable-line no-var

jest.mock('../../database/init');
jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');

  return {
    ...actual,
    authenticateUser: (req, res, next) => {
      req.userEmail = mockCurrentEmail;
      req.isApprover = actual.isApprover(mockCurrentEmail);
      next();
    }
  };
});

const workEntryRoutes = require('../../routes/workEntries');

const app = express();
app.use(express.json());
app.use('/api/work-entries', workEntryRoutes);
app.use((err, req, res, next) => {
  if (err.isJoi) {
    return res.status(400).json({ error: 'Validation error' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

const OWNER = 'owner@example.com';
const APPROVER = 'approver@example.com';

describe('Work Entry Approval Routes', () => {
  let mockDb;

  // Existence lookups return the current status, reads of the full row use the client join
  const mockEntryWithStatus = (status, { owned = true } = {}) => {
    mockDb.get.mockImplementation((query, params, callback) => {
      if (query.includes('work_entries we')) {
        return callback(null, { id: 1, status, client_name: 'Client A' });
      }
      return callback(null, owned ? { id: 1, status } : null);
    });
    mockDb.run.mockImplementation((query, params, callback) => callback(null));
  };

  beforeEach(() => {
    mockCurrentEmail = OWNER;
    mockDb = {
      all: jest.fn(),
      get: jest.fn(),
      run: jest.fn()
    };
    getDatabase.mockReturnValue(mockDb);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Valid transitions', () => {
    test('owner should submit a draft entry', async () => {
      mockEntryWithStatus(STATUS.DRAFT);

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry submitted successfully');
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('submitted_at = CURRENT_TIMESTAMP'),
        [STATUS.SUBMITTED, 1],
        expect.any(Function)
      );
    });

    test('owner should submit an entry with no status stored yet', async () => {
      mockEntryWithStatus(undefined);

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(200);
    });

    test('owner should resubmit a rejected entry and clear the review', async () => {
      mockEntryWithStatus(STATUS.REJECTED);

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(200);
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('review_note = NULL'),
        [STATUS.SUBMITTED, 1],
        expect.any(Function)
      );
    });

    test('approver should approve a submitted entry', async () => {
      mockCurrentEmail = APPROVER;
      mockEntryWithStatus(STATUS.SUBMITTED);

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry approved successfully');
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('reviewed_by = ?'),
        [STATUS.APPROVED, APPROVER, 1],
        expect.any(Function)
      );
    });

    test('approver should reject a submitted entry with a reason', async () => {
      mockCurrentEmail = APPROVER;
      mockEntryWithStatus(STATUS.SUBMITTED);

      const response = await request(app)
        .post('/api/work-entries/1/reject')
        .send({ reason: 'Hours look too high' });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry rejected successfully');
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('review_note = ?'),
        [STATUS.REJECTED, APPROVER, 'Hours look too high', 1],
        expect.any(Function)
      );
    });

    test('approver should reject a submitted entry without a reason', async () => {
      mockCurrentEmail = APPROVER;
      mockEntryWithStatus(STATUS.SUBMITTED);

      const response = await request(app).post('/api/work-entries/1/reject');

      expect(response.status).toBe(200);
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.any(String),
        [STATUS.REJECTED, APPROVER, null, 1],
        expect.any(Function)
      );
    });
  });

  describe('Rejected transitions', () => {
    test.each([
      ['submit', STATUS.SUBMITTED, OWNER],
      ['submit', STATUS.APPROVED, OWNER],
      ['approve', STATUS.DRAFT, APPROVER],
      ['approve', STATUS.APPROVED, APPROVER],
      ['approve', STATUS.REJECTED, APPROVER],
      ['reject', STATUS.DRAFT, APPROVER],
      ['reject', STATUS.APPROVED, APPROVER],
      ['reject', STATUS.REJECTED, APPROVER]
    ])('should return 409 when %sing an entry in status %s', async (action, status, email) => {
      mockCurrentEmail = email;
      mockEntryWithStatus(status);

      const response = await request(app).post(`/api/work-entries/1/${action}`);

      expect(response.status).toBe(409);
      expect(response.body.error).toContain(`from '${status}'`);
      expect(mockDb.run).not.toHaveBeenCalled();
    });
  });

  describe('Approver authorization', () => {
    test('should return 403 when a non approver approves', async () => {
      mockEntryWithStatus(STATUS.SUBMITTED);

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Only an approver can perform this action' });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('should return 403 when a non approver rejects', async () => {
      mockEntryWithStatus(STATUS.SUBMITTED);

      const response = await request(app)
        .post('/api/work-entries/1/reject')
        .send({ reason: 'nope' });

      expect(response.status).toBe(403);
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('should return 403 when a non approver lists pending approvals', async () => {
      const response = await request(app).get('/api/work-entries/pending-approvals');

      expect(response.status).toBe(403);
      expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('approver should be allowed to review entries owned by other users', async () => {
      mockCurrentEmail = APPROVER;
      mockEntryWithStatus(STATUS.SUBMITTED);

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(200);
      expect(mockDb.get).toHaveBeenCalledWith(
        'SELECT id, status FROM work_entries WHERE id = ?',
        [1],
        expect.any(Function)
      );
    });

    test('owner should only be able to submit their own entries', async () => {
      mockEntryWithStatus(STATUS.DRAFT, { owned: false });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(404);
      expect(mockDb.get).toHaveBeenCalledWith(
        'SELECT id, status FROM work_entries WHERE id = ? AND user_email = ?',
        [1, OWNER],
        expect.any(Function)
      );
    });
  });

  describe('GET /api/work-entries/pending-approvals', () => {
    test('should return submitted entries for an approver', async () => {
      mockCurrentEmail = APPROVER;
      const pending = [
        { id: 1, status: STATUS.SUBMITTED, user_email: OWNER, client_name: 'Client A' }
      ];
      mockDb.all.mockImplementation((query, params, callback) => callback(null, pending));

      const response = await request(app).get('/api/work-entries/pending-approvals');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ workEntries: pending });
      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('we.status = ?'),
        [STATUS.SUBMITTED],
        expect.any(Function)
      );
    });

    test('should handle database error', async () => {
      mockCurrentEmail = APPROVER;
      mockDb.all.mockImplementation((query, params, callback) => callback(new Error('Database error'), null));

      const response = await request(app).get('/api/work-entries/pending-approvals');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('Approved entries are frozen', () => {
    test('should return 409 when updating an approved entry', async () => {
      mockEntryWithStatus(STATUS.APPROVED);

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 8 });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: 'An approved work entry can no longer be edited' });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('should return 409 when deleting an approved entry', async () => {
      mockEntryWithStatus(STATUS.APPROVED);

      const response = await request(app).delete('/api/work-entries/1');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: 'An approved work entry can no longer be deleted' });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test.each([STATUS.DRAFT, STATUS.SUBMITTED, STATUS.REJECTED])(
      'should still allow updating an entry in status %s',
      async (status) => {
        mockEntryWithStatus(status);

        const response = await request(app)
          .put('/api/work-entries/1')
          .send({ hours: 8 });

        expect(response.status).toBe(200);
      }
    );
  });

  describe('Transition error handling', () => {
    test('should return 400 for an invalid work entry ID', async () => {
      const response = await request(app).post('/api/work-entries/invalid/submit');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid work entry ID' });
    });

    test('should return 404 when the entry does not exist', async () => {
      mockDb.get.mockImplementation((query, params, callback) => callback(null, null));

      const response = await request(app).post('/api/work-entries/999/submit');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Work entry not found' });
    });

    test('should return 400 when the rejection reason is too long', async () => {
      mockCurrentEmail = APPROVER;
      mockEntryWithStatus(STATUS.SUBMITTED);

      const response = await request(app)
        .post('/api/work-entries/1/reject')
        .send({ reason: 'x'.repeat(1001) });

      expect(response.status).toBe(400);
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('should handle database error when looking up the entry', async () => {
      mockDb.get.mockImplementation((query, params, callback) => callback(new Error('Database error'), null));

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });

    test('should handle database error while updating the status', async () => {
      mockEntryWithStatus(STATUS.DRAFT);
      mockDb.run.mockImplementation((query, params, callback) => callback(new Error('Update failed')));

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to update work entry status' });
    });

    test('should handle database error while reloading the entry', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries we')) {
          return callback(new Error('Retrieval failed'), null);
        }
        return callback(null, { id: 1, status: STATUS.DRAFT });
      });
      mockDb.run.mockImplementation((query, params, callback) => callback(null));

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Work entry status updated but failed to retrieve' });
    });
  });
});
