const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateUser, requireApprover } = require('../middleware/auth');
const {
  workEntrySchema,
  updateWorkEntrySchema,
  rejectWorkEntrySchema
} = require('../validation/schemas');

const router = express.Router();
const validStatuses = ['draft', 'submitted', 'approved', 'rejected'];
const workEntryColumns = `
  we.id, we.client_id, we.hours, we.description, we.date,
  we.status, we.submitted_at, we.reviewed_at, we.reviewed_by, we.rejection_reason,
  we.created_at, we.updated_at, c.name as client_name
`;

function getWorkEntryQuery(whereClause) {
  return `
    SELECT ${workEntryColumns}
    FROM work_entries we
    JOIN clients c ON we.client_id = c.id
    ${whereClause}
  `;
}

function getWorkEntryById(db, id, callback) {
  db.get(getWorkEntryQuery('WHERE we.id = ?'), [id], callback);
}

function respondWithWorkEntry(db, id, res, message, retrievalError) {
  getWorkEntryById(db, id, (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: retrievalError });
    }

    res.json({ message, workEntry: row });
  });
}

function invalidStatusResponse(res, action, status) {
  return res.status(409).json({ error: `Cannot ${action} a work entry with status ${status}` });
}

function parseWorkEntryId(req, res) {
  const workEntryId = parseInt(req.params.id);

  if (isNaN(workEntryId)) {
    res.status(400).json({ error: 'Invalid work entry ID' });
    return null;
  }

  return workEntryId;
}

function runStatusAction({
  db,
  res,
  id,
  action,
  lookupQuery,
  lookupParams,
  allowedStatuses,
  updateQuery,
  updateParams,
  message,
  retrievalError
}) {
  db.get(lookupQuery, lookupParams, (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Work entry not found' });
    }

    if (!allowedStatuses.includes(row.status)) {
      return invalidStatusResponse(res, action, row.status);
    }

    db.run(updateQuery, updateParams, (err) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: `Failed to ${action} work entry` });
      }

      respondWithWorkEntry(db, id, res, message, retrievalError);
    });
  });
}

// All routes require authentication
router.use(authenticateUser);

// Get all work entries for authenticated user (with optional client filter)
router.get('/', (req, res) => {
  const { clientId, status } = req.query;
  const db = getDatabase();

  if (status !== undefined && !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  let query = getWorkEntryQuery('WHERE we.user_email = ?');
  const params = [req.userEmail];

  if (clientId) {
    const clientIdNum = parseInt(clientId);
    if (isNaN(clientIdNum)) {
      return res.status(400).json({ error: 'Invalid client ID' });
    }
    query += ' AND we.client_id = ?';
    params.push(clientIdNum);
  }

  if (status !== undefined) {
    query += ' AND we.status = ?';
    params.push(status);
  }

  query += ' ORDER BY we.date DESC, we.created_at DESC';
  
  db.all(query, params, (err, rows) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    
    res.json({ workEntries: rows });
  });
});

router.get('/pending', requireApprover, (req, res) => {
  const db = getDatabase();
  const query = `
    SELECT we.id, we.client_id, we.user_email, we.hours, we.description, we.date,
           we.status, we.submitted_at, we.reviewed_at, we.reviewed_by, we.rejection_reason,
           we.created_at, we.updated_at, c.name as client_name
    FROM work_entries we
    JOIN clients c ON we.client_id = c.id
    WHERE we.status = 'submitted'
    ORDER BY we.date DESC, we.created_at DESC
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }

    res.json({ workEntries: rows });
  });
});

// Get specific work entry
router.get('/:id', (req, res) => {
  const workEntryId = parseInt(req.params.id);
  
  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }
  
  const db = getDatabase();
  
  db.get(
    getWorkEntryQuery('WHERE we.id = ? AND we.user_email = ?'),
    [workEntryId, req.userEmail],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      
      if (!row) {
        return res.status(404).json({ error: 'Work entry not found' });
      }
      
      res.json({ workEntry: row });
    }
  );
});

// Create new work entry
router.post('/', (req, res, next) => {
  try {
    const { error, value } = workEntrySchema.validate(req.body);
    if (error) {
      return next(error);
    }

    const { clientId, hours, description, date } = value;
    const db = getDatabase();

    // Verify client exists and belongs to user
    db.get(
      'SELECT id FROM clients WHERE id = ? AND user_email = ?',
      [clientId, req.userEmail],
      (err, row) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }

        if (!row) {
          return res.status(400).json({ error: 'Client not found or does not belong to user' });
        }

        // Create work entry
        db.run(
          'INSERT INTO work_entries (client_id, user_email, hours, description, date) VALUES (?, ?, ?, ?, ?)',
          [clientId, req.userEmail, hours, description || null, date],
          function(err) {
            if (err) {
              console.error('Database error:', err);
              return res.status(500).json({ error: 'Failed to create work entry' });
            }

            getWorkEntryById(db, this.lastID, (err, row) => {
              if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ error: 'Work entry created but failed to retrieve' });
              }

              res.status(201).json({
                message: 'Work entry created successfully',
                workEntry: row
              });
            });
          }
        );
      }
    );
  } catch (error) {
    next(error);
  }
});

router.post('/:id/submit', (req, res) => {
  const workEntryId = parseWorkEntryId(req, res);
  if (workEntryId === null) {
    return;
  }

  const db = getDatabase();
  runStatusAction({
    db,
    res,
    id: workEntryId,
    action: 'submit',
    lookupQuery: 'SELECT id, status FROM work_entries WHERE id = ? AND user_email = ?',
    lookupParams: [workEntryId, req.userEmail],
    allowedStatuses: ['draft', 'rejected'],
    updateQuery: `UPDATE work_entries
      SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
          reviewed_at = NULL, reviewed_by = NULL, rejection_reason = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_email = ?`,
    updateParams: [workEntryId, req.userEmail],
    message: 'Work entry submitted successfully',
    retrievalError: 'Work entry submitted but failed to retrieve'
  });
});

router.post('/:id/approve', requireApprover, (req, res) => {
  const workEntryId = parseWorkEntryId(req, res);
  if (workEntryId === null) {
    return;
  }

  const db = getDatabase();
  runStatusAction({
    db,
    res,
    id: workEntryId,
    action: 'approve',
    lookupQuery: 'SELECT id, status FROM work_entries WHERE id = ?',
    lookupParams: [workEntryId],
    allowedStatuses: ['submitted'],
    updateQuery: `UPDATE work_entries
      SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP,
          reviewed_by = ?, rejection_reason = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    updateParams: [req.userEmail, workEntryId],
    message: 'Work entry approved successfully',
    retrievalError: 'Work entry approved but failed to retrieve'
  });
});

router.post('/:id/reject', requireApprover, (req, res, next) => {
  try {
    const workEntryId = parseWorkEntryId(req, res);
    if (workEntryId === null) {
      return;
    }

    const { error, value } = rejectWorkEntrySchema.validate(req.body);
    if (error) {
      return next(error);
    }

    const db = getDatabase();
    const rejectionReason = value.reason === undefined ? null : value.reason;
    runStatusAction({
      db,
      res,
      id: workEntryId,
      action: 'reject',
      lookupQuery: 'SELECT id, status FROM work_entries WHERE id = ?',
      lookupParams: [workEntryId],
      allowedStatuses: ['submitted'],
      updateQuery: `UPDATE work_entries
        SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP,
            reviewed_by = ?, rejection_reason = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      updateParams: [req.userEmail, rejectionReason, workEntryId],
      message: 'Work entry rejected successfully',
      retrievalError: 'Work entry rejected but failed to retrieve'
    });
  } catch (error) {
    next(error);
  }
});

// Update work entry
router.put('/:id', (req, res, next) => {
  try {
    const workEntryId = parseInt(req.params.id);
    
    if (isNaN(workEntryId)) {
      return res.status(400).json({ error: 'Invalid work entry ID' });
    }

    const { error, value } = updateWorkEntrySchema.validate(req.body);
    if (error) {
      return next(error);
    }

    const db = getDatabase();

    db.get(
      'SELECT id, status FROM work_entries WHERE id = ? AND user_email = ?',
      [workEntryId, req.userEmail],
      (err, row) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }

        if (!row) {
          return res.status(404).json({ error: 'Work entry not found' });
        }

        if (row.status === 'approved') {
          return invalidStatusResponse(res, 'edit', row.status);
        }

        // If clientId is being updated, verify it belongs to user
        if (value.clientId) {
          db.get(
            'SELECT id FROM clients WHERE id = ? AND user_email = ?',
            [value.clientId, req.userEmail],
            (err, clientRow) => {
              if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ error: 'Internal server error' });
              }

              if (!clientRow) {
                return res.status(400).json({ error: 'Client not found or does not belong to user' });
              }

              performUpdate();
            }
          );
        } else {
          performUpdate();
        }

        function performUpdate() {
          // Build update query dynamically
          const updates = [];
          const values = [];

          if (value.clientId !== undefined) {
            updates.push('client_id = ?');
            values.push(value.clientId);
          }

          if (value.hours !== undefined) {
            updates.push('hours = ?');
            values.push(value.hours);
          }

          if (value.description !== undefined) {
            updates.push('description = ?');
            values.push(value.description || null);
          }

          if (value.date !== undefined) {
            updates.push('date = ?');
            values.push(value.date);
          }

          updates.push('updated_at = CURRENT_TIMESTAMP');
          values.push(workEntryId, req.userEmail);

          const query = `UPDATE work_entries SET ${updates.join(', ')} WHERE id = ? AND user_email = ?`;

          db.run(query, values, function(err) {
            if (err) {
              console.error('Database error:', err);
              return res.status(500).json({ error: 'Failed to update work entry' });
            }

            respondWithWorkEntry(
              db,
              workEntryId,
              res,
              'Work entry updated successfully',
              'Work entry updated but failed to retrieve'
            );
          });
        }
      }
    );
  } catch (error) {
    next(error);
  }
});

// Delete work entry
router.delete('/:id', (req, res) => {
  const workEntryId = parseInt(req.params.id);
  
  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }
  
  const db = getDatabase();
  
  db.get(
    'SELECT id, status FROM work_entries WHERE id = ? AND user_email = ?',
    [workEntryId, req.userEmail],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      
      if (!row) {
        return res.status(404).json({ error: 'Work entry not found' });
      }

      if (row.status === 'approved') {
        return invalidStatusResponse(res, 'delete', row.status);
      }

      db.run(
        'DELETE FROM work_entries WHERE id = ? AND user_email = ?',
        [workEntryId, req.userEmail],
        function(err) {
          if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Failed to delete work entry' });
          }
          
          res.json({ message: 'Work entry deleted successfully' });
        }
      );
    }
  );
});

module.exports = router;
