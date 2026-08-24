const request = require('supertest');
const express = require('express');
const workEntryRoutes = require('../../routes/workEntries');
const { getDatabase } = require('../../database/init');

jest.mock('../../database/init');
let mockRole = 'member';
jest.mock('../../middleware/auth', () => ({
  authenticateUser: (req, res, next) => {
    req.userEmail = 'test@example.com';
    req.role = mockRole;
    next();
  },
  requireApprover: (req, res, next) => {
    if (req.role !== 'approver') {
      return res.status(403).json({ error: 'Approver access required' });
    }
    next();
  }
}));

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
    mockRole = 'member';
    mockDb = {
      all: jest.fn(),
      get: jest.fn(),
      run: jest.fn()
    };
    getDatabase.mockReturnValue(mockDb);
  });

  describe('Approval state machine', () => {
    const entry = { id: 1, status: 'draft', client_id: 1, client_name: 'Client A' };

    const mockEntryLookup = (row = entry, returnedEntry = row) => {
      let calls = 0;
      mockDb.get.mockImplementation((query, params, callback) => {
        calls += 1;
        callback(null, calls === 1 ? row : returnedEntry);
      });
      mockDb.run.mockImplementation((query, params, callback) => callback(null));
    };

    test.each([
      ['draft', 200],
      ['rejected', 200]
    ])('should submit a %s entry', async (status, expectedStatus) => {
      mockEntryLookup({ ...entry, status }, { ...entry, status: 'submitted' });
      const response = await request(app).post('/api/work-entries/1/submit');
      expect(response.status).toBe(expectedStatus);
      expect(mockDb.run).toHaveBeenCalled();
    });

    test.each(['submitted', 'approved'])('should reject submitting a %s entry', async (status) => {
      mockEntryLookup({ ...entry, status });
      const response = await request(app).post('/api/work-entries/1/submit');
      expect(response.status).toBe(409);
    });

    test.each([
      ['approve', 'approved'],
      ['reject', 'rejected']
    ])('should allow an approver to %s a submitted entry', async (action, status) => {
      mockRole = 'approver';
      mockEntryLookup({ ...entry, status: 'submitted' }, { ...entry, status });
      const response = await request(app)
        .post(`/api/work-entries/1/${action}`)
        .send(action === 'reject' ? { note: 'Please add more detail' } : {});
      expect(response.status).toBe(200);
      expect(mockDb.run).toHaveBeenCalled();
    });

    test.each(['draft', 'approved', 'rejected'])('should reject approving a %s entry', async (status) => {
      mockRole = 'approver';
      mockEntryLookup({ ...entry, status });
      const response = await request(app).post('/api/work-entries/1/approve').send({});
      expect(response.status).toBe(409);
    });

    test.each(['draft', 'approved', 'rejected'])('should reject rejecting a %s entry', async (status) => {
      mockRole = 'approver';
      mockEntryLookup({ ...entry, status });
      const response = await request(app).post('/api/work-entries/1/reject').send({});
      expect(response.status).toBe(409);
    });

    test.each(['approve', 'reject'])('should reject non-approver %s requests', async (action) => {
      const response = await request(app).post(`/api/work-entries/1/${action}`).send({});
      expect(response.status).toBe(403);
      expect(mockDb.get).not.toHaveBeenCalled();
    });

    test('should return 404 when an owner submits an entry they cannot access', async () => {
      mockDb.get.mockImplementation((query, params, callback) => callback(null, null));
      const response = await request(app).post('/api/work-entries/1/submit');
      expect(response.status).toBe(404);
    });

    test.each(['submitted', 'approved'])('should refuse editing a %s entry', async (status) => {
      mockEntryLookup({ ...entry, status });
      const response = await request(app).put('/api/work-entries/1').send({ hours: 8 });
      expect(response.status).toBe(409);
    });

    test('should refuse deleting an approved entry', async () => {
      mockEntryLookup({ ...entry, status: 'approved' });
      const response = await request(app).delete('/api/work-entries/1');
      expect(response.status).toBe(409);
    });

    test('should list pending approvals across all owners', async () => {
      mockRole = 'approver';
      mockDb.all.mockImplementation((query, params, callback) => {
        expect(query).toContain("WHERE we.status = 'submitted'");
        expect(query).not.toContain('we.user_email = ?');
        expect(params).toEqual([]);
        callback(null, [entry]);
      });
      const response = await request(app).get('/api/work-entries/pending-approvals');
      expect(response.status).toBe(200);
      expect(response.body.workEntries).toEqual([entry]);
    });
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

    test('should filter by status when provided', async () => {
      mockDb.all.mockImplementation((query, params, callback) => {
        expect(query).toContain('AND we.status = ?');
        expect(params).toEqual(['test@example.com', 'submitted']);
        callback(null, []);
      });

      await request(app).get('/api/work-entries?status=submitted');
      expect(mockDb.all).toHaveBeenCalled();
    });

    test('should return 400 for invalid status filter', async () => {
      const response = await request(app).get('/api/work-entries?status=unknown');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid status' });
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
  });
});
