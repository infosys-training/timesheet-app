const request = require('supertest');
const express = require('express');
const workEntryRoutes = require('../../routes/workEntries');
const { getDatabase } = require('../../database/init');

jest.mock('../../database/init');
jest.mock('../../middleware/auth', () => ({
  authenticateUser: (req, res, next) => {
    req.userEmail = mockAuthState.email;
    req.isApprover = mockAuthState.isApprover;
    next();
  },
  requireApprover: (req, res, next) => {
    if (!req.isApprover) {
      return res.status(403).json({ error: 'Only an approver can perform this action' });
    }
    next();
  }
}));

let mockAuthState = { email: 'test@example.com', isApprover: false };

const app = express();
app.use(express.json());
app.use('/api/work-entries', workEntryRoutes);
// Add error handler for Joi validation
app.use((err, req, res, next) => {
  if (err.isJoi) {
    return res.status(400).json({ error: 'Validation error' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

describe('Work Entry Routes', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = {
      all: jest.fn(),
      get: jest.fn(),
      run: jest.fn()
    };
    getDatabase.mockReturnValue(mockDb);
    mockAuthState = { email: 'test@example.com', isApprover: false };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/work-entries', () => {
    test('should return all work entries for user', async () => {
      const mockEntries = [
        { id: 1, client_id: 1, hours: 5, description: 'Work 1', date: '2024-01-01', client_name: 'Client A' },
        { id: 2, client_id: 2, hours: 3, description: 'Work 2', date: '2024-01-02', client_name: 'Client B' }
      ];

      mockDb.all.mockImplementation((query, params, callback) => {
        callback(null, mockEntries);
      });

      const response = await request(app).get('/api/work-entries');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ workEntries: mockEntries });
    });

    test('should filter by client ID when provided', async () => {
      mockDb.all.mockImplementation((query, params, callback) => {
        expect(params).toEqual(['test@example.com', 1]);
        callback(null, []);
      });

      await request(app).get('/api/work-entries?clientId=1');

      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('AND we.client_id = ?'),
        ['test@example.com', 1],
        expect.any(Function)
      );
    });

    test('should return 400 for invalid client ID filter', async () => {
      const response = await request(app).get('/api/work-entries?clientId=invalid');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid client ID' });
    });

    test('should handle database error', async () => {
      mockDb.all.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app).get('/api/work-entries');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('GET /api/work-entries/:id', () => {
    test('should return specific work entry', async () => {
      const mockEntry = { id: 1, client_id: 1, hours: 5, description: 'Work', client_name: 'Client A' };

      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, mockEntry);
      });

      const response = await request(app).get('/api/work-entries/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ workEntry: mockEntry });
    });

    test('should return 404 if work entry not found', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null);
      });

      const response = await request(app).get('/api/work-entries/999');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Work entry not found' });
    });

    test('should return 400 for invalid work entry ID', async () => {
      const response = await request(app).get('/api/work-entries/invalid');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid work entry ID' });
    });
  });

  describe('POST /api/work-entries', () => {
    test('should create work entry with valid data', async () => {
      const newEntry = {
        clientId: 1,
        hours: 5.5,
        description: 'Development work',
        date: '2024-01-15'
      };

      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('clients')) {
          callback(null, { id: 1 }); // Client exists
        } else {
          callback(null, { id: 1, ...newEntry, client_name: 'Client A' });
        }
      });

      mockDb.run.mockImplementation(function(query, params, callback) {
        this.lastID = 1;
        callback.call(this, null);
      });

      const response = await request(app)
        .post('/api/work-entries')
        .send(newEntry);

      expect(response.status).toBe(201);
      expect(response.body.message).toBe('Work entry created successfully');
    });

    test('should return 400 if client not found', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null); // Client doesn't exist
      });

      const response = await request(app)
        .post('/api/work-entries')
        .send({
          clientId: 999,
          hours: 5,
          date: '2024-01-15'
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Client not found or does not belong to user' });
    });

    test('should return 400 for missing required fields', async () => {
      const response = await request(app)
        .post('/api/work-entries')
        .send({ hours: 5 });

      expect(response.status).toBe(400);
    });

    test('should return 400 for invalid hours', async () => {
      const response = await request(app)
        .post('/api/work-entries')
        .send({
          clientId: 1,
          hours: -5,
          date: '2024-01-15'
        });

      expect(response.status).toBe(400);
    });

    test('should return 400 for hours exceeding 24', async () => {
      const response = await request(app)
        .post('/api/work-entries')
        .send({
          clientId: 1,
          hours: 25,
          date: '2024-01-15'
        });

      expect(response.status).toBe(400);
    });

    test('should handle database error on insert', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1 });
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(new Error('Insert failed'));
      });

      const response = await request(app)
        .post('/api/work-entries')
        .send({
          clientId: 1,
          hours: 5,
          date: '2024-01-15'
        });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to create work entry' });
    });
  });

  describe('PUT /api/work-entries/:id', () => {
    test('should update work entry hours', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries we')) {
          callback(null, { id: 1, hours: 8, client_name: 'Client A' });
        } else {
          callback(null, { id: 1 });
        }
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 8 });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry updated successfully');
    });

    test('should update work entry client', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1 });
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ clientId: 2 });

      expect(response.status).toBe(200);
    });

    test('should return 404 if work entry not found', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null);
      });

      const response = await request(app)
        .put('/api/work-entries/999')
        .send({ hours: 8 });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Work entry not found' });
    });

    test('should return 400 for invalid work entry ID', async () => {
      const response = await request(app)
        .put('/api/work-entries/invalid')
        .send({ hours: 8 });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid work entry ID' });
    });

    test('should return 400 for empty update', async () => {
      const response = await request(app)
        .put('/api/work-entries/1')
        .send({});

      expect(response.status).toBe(400);
    });

    test('should return 400 if new client not found', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries')) {
          callback(null, { id: 1 });
        } else {
          callback(null, null); // Client doesn't exist
        }
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ clientId: 999 });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Client not found or does not belong to user' });
    });
  });

  describe('DELETE /api/work-entries/:id', () => {
    test('should delete existing work entry', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1 });
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      const response = await request(app).delete('/api/work-entries/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'Work entry deleted successfully' });
    });

    test('should return 404 if work entry not found', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null);
      });

      const response = await request(app).delete('/api/work-entries/999');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Work entry not found' });
    });

    test('should return 400 for invalid work entry ID', async () => {
      const response = await request(app).delete('/api/work-entries/invalid');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid work entry ID' });
    });

    test('should handle database delete error', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1 });
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(new Error('Delete failed'));
      });

      const response = await request(app).delete('/api/work-entries/1');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to delete work entry' });
    });

    test('should handle database error when checking work entry existence', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app).delete('/api/work-entries/1');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('GET /api/work-entries/:id - Error Handling', () => {
    test('should handle database error when fetching single work entry', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app).get('/api/work-entries/1');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('POST /api/work-entries - Error Handling', () => {
    test('should handle database error when verifying client', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app)
        .post('/api/work-entries')
        .send({
          clientId: 1,
          hours: 5,
          date: '2024-01-15'
        });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });

    test('should handle error retrieving work entry after creation', async () => {
      let getCallCount = 0;
      mockDb.get.mockImplementation((query, params, callback) => {
        getCallCount++;
        if (getCallCount === 1) {
          callback(null, { id: 1 });
        } else {
          callback(new Error('Retrieval failed'), null);
        }
      });

      mockDb.run.mockImplementation(function(query, params, callback) {
        this.lastID = 1;
        callback.call(this, null);
      });

      const response = await request(app)
        .post('/api/work-entries')
        .send({
          clientId: 1,
          hours: 5,
          date: '2024-01-15'
        });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Work entry created but failed to retrieve' });
    });
  });

  describe('PUT /api/work-entries/:id - Error Handling', () => {
    test('should handle database error when checking work entry existence', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 8 });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });

    test('should handle database error when verifying new client in update', async () => {
      let callCount = 0;
      mockDb.get.mockImplementation((query, params, callback) => {
        callCount++;
        if (callCount === 1) {
          callback(null, { id: 1 });
        } else {
          callback(new Error('Database error'), null);
        }
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ clientId: 2 });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });

    test('should handle database error during update', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1 });
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(new Error('Update failed'));
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 8 });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to update work entry' });
    });

    test('should handle error retrieving work entry after update', async () => {
      let getCallCount = 0;
      mockDb.get.mockImplementation((query, params, callback) => {
        getCallCount++;
        if (getCallCount === 1) {
          callback(null, { id: 1 });
        } else {
          callback(new Error('Retrieval failed'), null);
        }
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 8 });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Work entry updated but failed to retrieve' });
    });

    test('should update work entry date', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries we')) {
          callback(null, { id: 1, date: '2024-02-01', client_name: 'Client A' });
        } else {
          callback(null, { id: 1 });
        }
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ date: '2024-02-01' });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry updated successfully');
    });

    test('should update work entry description', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries we')) {
          callback(null, { id: 1, description: 'New description', client_name: 'Client A' });
        } else {
          callback(null, { id: 1 });
        }
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ description: 'New description' });

      expect(response.status).toBe(200);
    });

    test('should update description to null when empty string provided', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries we')) {
          callback(null, { id: 1, description: null, client_name: 'Client A' });
        } else {
          callback(null, { id: 1 });
        }
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ description: '' });

      expect(response.status).toBe(200);
    });

    test('should update multiple fields at once', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries we')) {
          callback(null, { id: 1, hours: 10, description: 'Updated', date: '2024-03-01', client_name: 'Client A' });
        } else {
          callback(null, { id: 1 });
        }
      });

      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 10, description: 'Updated', date: '2024-03-01' });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry updated successfully');
    });

    test('should return 409 when updating an approved work entry', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'approved' });
      });

      const response = await request(app)
        .put('/api/work-entries/1')
        .send({ hours: 8 });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: 'Approved work entries cannot be edited' });
      expect(mockDb.run).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/work-entries/:id - approval rules', () => {
    test('should return 409 when deleting an approved work entry', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'approved' });
      });

      const response = await request(app).delete('/api/work-entries/1');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: 'Approved work entries cannot be deleted' });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('should delete a draft work entry', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'draft' });
      });
      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });

      const response = await request(app).delete('/api/work-entries/1');

      expect(response.status).toBe(200);
    });
  });

  describe('POST /api/work-entries/:id/submit', () => {
    // Returns the entry lookup row, then the reloaded entry after the update
    function mockEntry(status) {
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries we')) {
          callback(null, { id: 1, status: 'submitted', client_name: 'Client A' });
        } else {
          callback(null, { id: 1, status });
        }
      });
      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });
    }

    test('should submit a draft work entry', async () => {
      mockEntry('draft');

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry submitted for approval');
      expect(response.body.workEntry.status).toBe('submitted');
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining("status = 'submitted'"),
        [1],
        expect.any(Function)
      );
    });

    test('should resubmit a rejected work entry and clear the previous review', async () => {
      mockEntry('rejected');

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(200);
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('reviewed_by = NULL'),
        [1],
        expect.any(Function)
      );
    });

    test('should return 409 when submitting an already submitted work entry', async () => {
      mockEntry('submitted');

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: "Cannot submit a work entry with status 'submitted'" });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('should return 409 when submitting an approved work entry', async () => {
      mockEntry('approved');

      const response = await request(app).post('/api/work-entries/1/submit');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: "Cannot submit a work entry with status 'approved'" });
    });

    test('should return 404 if the work entry does not belong to the user', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null);
      });

      const response = await request(app).post('/api/work-entries/999/submit');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Work entry not found' });
    });

    test('should return 400 for invalid work entry ID', async () => {
      const response = await request(app).post('/api/work-entries/invalid/submit');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid work entry ID' });
    });

    test('should handle database error on update', async () => {
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'draft' });
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
    function mockEntry(status, finalStatus = 'approved') {
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries we')) {
          callback(null, { id: 1, status: finalStatus, reviewed_by: 'boss@example.com', client_name: 'Client A' });
        } else {
          callback(null, { id: 1, status });
        }
      });
      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });
    }

    test('should return 403 when the user is not an approver', async () => {
      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Only an approver can perform this action' });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('should approve a submitted work entry', async () => {
      mockAuthState = { email: 'boss@example.com', isApprover: true };
      mockEntry('submitted');

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry approved successfully');
      expect(response.body.workEntry.status).toBe('approved');
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('reviewed_by = ?'),
        ['approved', 'boss@example.com', 1],
        expect.any(Function)
      );
    });

    test('should approve an entry belonging to another user', async () => {
      mockAuthState = { email: 'boss@example.com', isApprover: true };
      mockEntry('submitted');

      await request(app).post('/api/work-entries/1/approve');

      expect(mockDb.get).toHaveBeenCalledWith(
        'SELECT id, status FROM work_entries WHERE id = ?',
        [1],
        expect.any(Function)
      );
    });

    test('should return 409 when approving a draft work entry', async () => {
      mockAuthState = { email: 'boss@example.com', isApprover: true };
      mockEntry('draft');

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: "Cannot approve a work entry with status 'draft'" });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('should return 409 when approving a rejected work entry', async () => {
      mockAuthState = { email: 'boss@example.com', isApprover: true };
      mockEntry('rejected');

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: "Cannot approve a work entry with status 'rejected'" });
    });

    test('should return 409 when approving an already approved work entry', async () => {
      mockAuthState = { email: 'boss@example.com', isApprover: true };
      mockEntry('approved');

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: "Cannot approve a work entry with status 'approved'" });
    });

    test('should return 404 if the work entry does not exist', async () => {
      mockAuthState = { email: 'boss@example.com', isApprover: true };
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, null);
      });

      const response = await request(app).post('/api/work-entries/999/approve');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Work entry not found' });
    });

    test('should return 400 for invalid work entry ID', async () => {
      mockAuthState = { email: 'boss@example.com', isApprover: true };

      const response = await request(app).post('/api/work-entries/invalid/approve');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid work entry ID' });
    });

    test('should handle database error on update', async () => {
      mockAuthState = { email: 'boss@example.com', isApprover: true };
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'submitted' });
      });
      mockDb.run.mockImplementation((query, params, callback) => {
        callback(new Error('Update failed'));
      });

      const response = await request(app).post('/api/work-entries/1/approve');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to approve work entry' });
    });
  });

  describe('POST /api/work-entries/:id/reject', () => {
    function mockEntry(status, finalStatus = 'rejected') {
      mockDb.get.mockImplementation((query, params, callback) => {
        if (query.includes('work_entries we')) {
          callback(null, { id: 1, status: finalStatus, reviewed_by: 'boss@example.com', client_name: 'Client A' });
        } else {
          callback(null, { id: 1, status });
        }
      });
      mockDb.run.mockImplementation((query, params, callback) => {
        callback(null);
      });
    }

    test('should return 403 when the user is not an approver', async () => {
      const response = await request(app).post('/api/work-entries/1/reject');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Only an approver can perform this action' });
    });

    test('should reject a submitted work entry', async () => {
      mockAuthState = { email: 'boss@example.com', isApprover: true };
      mockEntry('submitted');

      const response = await request(app).post('/api/work-entries/1/reject');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Work entry rejected');
      expect(response.body.workEntry.status).toBe('rejected');
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.any(String),
        ['rejected', 'boss@example.com', 1],
        expect.any(Function)
      );
    });

    test('should return 409 when rejecting a draft work entry', async () => {
      mockAuthState = { email: 'boss@example.com', isApprover: true };
      mockEntry('draft');

      const response = await request(app).post('/api/work-entries/1/reject');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: "Cannot reject a work entry with status 'draft'" });
      expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('should return 409 when rejecting an approved work entry', async () => {
      mockAuthState = { email: 'boss@example.com', isApprover: true };
      mockEntry('approved');

      const response = await request(app).post('/api/work-entries/1/reject');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: "Cannot reject a work entry with status 'approved'" });
    });

    test('should return 409 when rejecting an already rejected work entry', async () => {
      mockAuthState = { email: 'boss@example.com', isApprover: true };
      mockEntry('rejected');

      const response = await request(app).post('/api/work-entries/1/reject');

      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: "Cannot reject a work entry with status 'rejected'" });
    });

    test('should handle database error on update', async () => {
      mockAuthState = { email: 'boss@example.com', isApprover: true };
      mockDb.get.mockImplementation((query, params, callback) => {
        callback(null, { id: 1, status: 'submitted' });
      });
      mockDb.run.mockImplementation((query, params, callback) => {
        callback(new Error('Update failed'));
      });

      const response = await request(app).post('/api/work-entries/1/reject');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to reject work entry' });
    });
  });

  describe('GET /api/work-entries/pending-approvals', () => {
    test('should return 403 when the user is not an approver', async () => {
      const response = await request(app).get('/api/work-entries/pending-approvals');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Only an approver can perform this action' });
      expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('should return submitted entries from all users for an approver', async () => {
      mockAuthState = { email: 'boss@example.com', isApprover: true };
      const pending = [
        { id: 1, user_email: 'a@example.com', status: 'submitted', hours: 5, client_name: 'Client A' },
        { id: 2, user_email: 'b@example.com', status: 'submitted', hours: 3, client_name: 'Client B' }
      ];

      mockDb.all.mockImplementation((query, params, callback) => {
        expect(query).toContain("we.status = 'submitted'");
        callback(null, pending);
      });

      const response = await request(app).get('/api/work-entries/pending-approvals');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ workEntries: pending });
    });

    test('should handle database error', async () => {
      mockAuthState = { email: 'boss@example.com', isApprover: true };
      mockDb.all.mockImplementation((query, params, callback) => {
        callback(new Error('Database error'), null);
      });

      const response = await request(app).get('/api/work-entries/pending-approvals');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });
  });
});
