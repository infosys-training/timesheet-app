const request = require('supertest');
const express = require('express');
const workEntryRoutes = require('../../routes/workEntries');
const { getDatabase } = require('../../database/init');

jest.mock('../../database/init');

// Authenticated identity for the request under test, swapped per test case
const mockCurrentUser = { email: 'employee@example.com', isApprover: false };

jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');

  return {
    ...actual,
    authenticateUser: (req, res, next) => {
      req.userEmail = mockCurrentUser.email;
      req.isApprover = mockCurrentUser.isApprover;
      req.userRole = mockCurrentUser.isApprover ? 'approver' : 'employee';
      next();
    }
  };
});

const app = express();
app.use(express.json());
app.use('/api/work-entries', workEntryRoutes);
app.use((err, req, res, next) => {
  if (err.isJoi) {
    return res.status(400).json({ error: 'Validation error' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

const OWNER = 'employee@example.com';
const APPROVER = 'approver@example.com';

describe('Work Entry Approval Workflow', () => {
  let mockDb;

  const asEmployee = (email = OWNER) => {
    mockCurrentUser.email = email;
    mockCurrentUser.isApprover = false;
  };

  const asApprover = (email = APPROVER) => {
    mockCurrentUser.email = email;
    mockCurrentUser.isApprover = true;
  };

  // Lookup returns the stored entry, the follow-up select returns the updated row
  const withStoredEntry = (entry) => {
    mockDb.get.mockImplementation((query, params, callback) => {
      if (query.includes('work_entries we')) {
        callback(null, { id: 1, client_name: 'Client A', ...entry });
      } else {
        callback(null, entry);
      }
    });
    mockDb.run.mockImplementation((query, params, callback) => {
      callback(null);
    });
  };

  beforeEach(() => {
    mockDb = {
      all: jest.fn(),
      get: jest.fn(),
      run: jest.fn()
    };
    getDatabase.mockReturnValue(mockDb);
    asEmployee();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/work-entries/:id/submit', () => {
    test('should submit a draft entry', async () => {
      withStoredEntry({ id: 1, status: 'draft', user_email: OWNER });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry submitted for approval');
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining("status = 'submitted'"),
        [1, OWNER],
        expect.any(Function)
      );
    });

    test('should resubmit a rejected entry and clear the previous review', async () => {
      withStoredEntry({ id: 1, status: 'rejected', user_email: OWNER });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(200);
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('review_note = NULL'),
        [1, OWNER],
        expect.any(Function)
      );
    });

    test('should reject submitting an already submitted entry', async () => {
      withStoredEntry({ id: 1, status: 'submitted', user_email: OWNER });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: "Cannot submit a work entry with status 'submitted'" });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('should reject submitting an approved entry', async () => {
      withStoredEntry({ id: 1, status: 'approved', user_email: OWNER });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: "Cannot submit a work entry with status 'approved'" });
    });

    test('should return 404 when the entry belongs to another user', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null);
      });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Work entry not found' });
    });

    test('should return 400 for invalid work entry ID', async () => {
      const response = await request(app).post('/api/work-entries/invalid/submit');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid work entry ID' });
    });

    test('should handle database error when loading the entry', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });

    test('should handle database error during the status update', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'draft', user_email: OWNER });
      });
      mockDb.run.mockImplementation((query, params, callback) => {
        callback(new Error('Update failed'));
      });

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to submit work entry' });
    });
  });

  describe('POST /api/work-entries/:id/approve', () => {
    test('should approve a submitted entry', async () => {
      asApprover();
      withStoredEntry({ id: 1, status: 'submitted', user_email: OWNER });

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry approved');
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('SET status = ?'),
        ['approved', APPROVER, null, 1],
        expect.any(Function)
      );
    });

    test('should return 403 when the user is not an approver', async () => {
      asEmployee();
      withStoredEntry({ id: 1, status: 'submitted', user_email: 'other@example.com' });

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Approver role required' });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('should return 403 when an approver reviews their own entry', async () => {
      asApprover();
      withStoredEntry({ id: 1, status: 'submitted', user_email: APPROVER });

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Approvers cannot review their own work entries' });
    });

    test('should reject approving a draft entry', async () => {
      asApprover();
      withStoredEntry({ id: 1, status: 'draft', user_email: OWNER });

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: "Cannot approve a work entry with status 'draft'" });
    });

    test('should reject approving an approved entry', async () => {
      asApprover();
      withStoredEntry({ id: 1, status: 'approved', user_email: OWNER });

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: "Cannot approve a work entry with status 'approved'" });
    });

    test('should reject approving a rejected entry', async () => {
      asApprover();
      withStoredEntry({ id: 1, status: 'rejected', user_email: OWNER });

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: "Cannot approve a work entry with status 'rejected'" });
    });

    test('should return 404 when the entry does not exist', async () => {
      asApprover();
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null);
      });

      const response = await request(app).post('/api/work-entries/999/approve');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Work entry not found' });
    });

    test('should return 400 for invalid work entry ID', async () => {
      asApprover();

      const response = await request(app).post('/api/work-entries/invalid/approve');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid work entry ID' });
    });

    test('should return 400 for an invalid review note', async () => {
      asApprover();

      const response = await request(app)
        .post('/api/work-entries/1/approve')
        .send({ note: 'x'.repeat(1001) });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Validation error' });
    });

    test('should handle database error during the status update', async () => {
      asApprover();
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'submitted', user_email: OWNER });
      });
      mockDb.run.mockImplementation((query, params, callback) => {
        callback(new Error('Update failed'));
      });

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to approve work entry' });
    });

    test('should handle error retrieving the entry after approval', async () => {
      asApprover();
      let getCallCount = 0;
      mockDb.get.mockImplementation((query, params, callback) => {
        getCallCount++;
        if (getCallCount === 1) {
          callback(null, { id: 1, status: 'submitted', user_email: OWNER });
        } else {
          callback(new Error('Retrieval failed'), null);
        }
      });
      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Work entry updated but failed to retrieve' });
    });
  });

  describe('POST /api/work-entries/:id/reject', () => {
    test('should reject a submitted entry with a note', async () => {
      asApprover();
      withStoredEntry({ id: 1, status: 'submitted', user_email: OWNER });

      const response = await request(app)
        .post('/api/work-entries/1/reject')
        .send({ note: 'Please split this across clients' });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry rejected');
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('SET status = ?'),
        ['rejected', APPROVER, 'Please split this across clients', 1],
        expect.any(Function)
      );
    });

    test('should return 403 when the user is not an approver', async () => {
      asEmployee();
      withStoredEntry({ id: 1, status: 'submitted', user_email: 'other@example.com' });

      const response = await request(app).post('/api/work-entries/1/reject');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Approver role required' });
    });

    test('should reject rejecting a draft entry', async () => {
      asApprover();
      withStoredEntry({ id: 1, status: 'draft', user_email: OWNER });

      const response = await request(app).post('/api/work-entries/1/reject');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: "Cannot reject a work entry with status 'draft'" });
    });

    test('should reject rejecting an approved entry', async () => {
      asApprover();
      withStoredEntry({ id: 1, status: 'approved', user_email: OWNER });

      const response = await request(app).post('/api/work-entries/1/reject');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: "Cannot reject a work entry with status 'approved'" });
    });

    test('should reject rejecting an already rejected entry', async () => {
      asApprover();
      withStoredEntry({ id: 1, status: 'rejected', user_email: OWNER });

      const response = await request(app).post('/api/work-entries/1/reject');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: "Cannot reject a work entry with status 'rejected'" });
    });
  });

  describe('GET /api/work-entries/pending-approvals', () => {
    test('should list submitted entries for an approver', async () => {
      asApprover();
      const pending = [
        { id: 1, status: 'submitted', user_email: OWNER, client_name: 'Client A' }
      ];
      mockDb.all.mockImplementation((query, params, callback) => {
        callback(null, pending);
      });

      const response = await request(app).get('/api/work-entries/pending-approvals');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ workEntries: pending });
      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining("we.status = 'submitted'"),
        [],
        expect.any(Function)
      );
    });

    test('should return 403 for a non-approver', async () => {
      asEmployee();

      const response = await request(app).get('/api/work-entries/pending-approvals');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Approver role required' });
      expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('should handle database error', async () => {
      asApprover();
      mockDb.all.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app).get('/api/work-entries/pending-approvals');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('Editing entries by status', () => {
    test('should allow updating a draft entry', async () => {
      withStoredEntry({ id: 1, status: 'draft', user_email: OWNER });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 4 });

      expect(response.status).toBe(200);
    });

    test('should allow updating a rejected entry', async () => {
      withStoredEntry({ id: 1, status: 'rejected', user_email: OWNER });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 4 });

      expect(response.status).toBe(200);
    });

    test('should refuse updating an approved entry', async () => {
      withStoredEntry({ id: 1, status: 'approved', user_email: OWNER });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 4 });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: 'Approved work entries cannot be edited' });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('should refuse deleting an approved entry', async () => {
      withStoredEntry({ id: 1, status: 'approved', user_email: OWNER });

      const response = await request(app).delete('/api/work-entries/1');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: 'Approved work entries cannot be deleted' });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('should allow deleting a submitted entry', async () => {
      withStoredEntry({ id: 1, status: 'submitted', user_email: OWNER });

      const response = await request(app).delete('/api/work-entries/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'Work entry deleted successfully' });
    });
  });
});
