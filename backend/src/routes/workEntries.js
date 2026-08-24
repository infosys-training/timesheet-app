const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateUser, requireApprover } = require('../middleware/auth');
const {
  workEntrySchema,
  updateWorkEntrySchema,
  rejectWorkEntrySchema
} = require('../validation/schemas');

const router = express.Router();

const workEntrySelect = `
  SELECT we.id, we.client_id, we.user_email, we.hours, we.description, we.date,
         we.status, we.submitted_at, we.reviewed_at, we.reviewed_by,
         we.rejection_reason, we.created_at, we.updated_at, c.name as client_name
  FROM work_entries we
  JOIN clients c ON we.client_id = c.id
`;

function transitionError(res, action, status) {
  return res.status(409).json({
    error: `Cannot ${action} work entry with status '${status}'`
  });
}

function parseWorkEntryId(req, res) {
  const workEntryId = parseInt(req.params.id);

  if (isNaN(workEntryId)) {
    res.status(400).json({ error: 'Invalid work entry ID' });
    return null;
  }

  return workEntryId;
}

function loadWorkEntry(req, res, workEntryId, userEmail, callback) {
  const db = getDatabase();
  const ownershipClause = userEmail ? ' AND user_email = ?' : '';
  const params = userEmail ? [workEntryId, userEmail] : [workEntryId];

  db.get(
    `SELECT status FROM work_entries WHERE id = ?${ownershipClause}`,
    params,
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      if (!row) {
        return res.status(404).json({ error: 'Work entry not found' });
      }

      callback(db, row);
    }
  );
}

function respondWithWorkEntry(db, res, workEntryId, userEmail, message, retrievalError) {
  const ownershipClause = userEmail ? ' AND we.user_email = ?' : '';
  const params = userEmail ? [workEntryId, userEmail] : [workEntryId];

  db.get(
    `${workEntrySelect} WHERE we.id = ?${ownershipClause}`,
    params,
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: retrievalError });
      }

      res.json({
        message,
        workEntry: row
      });
    }
  );
}

// All routes require authentication
router.use(authenticateUser);

// Get pending work entries for approvers
router.get('/pending-approvals', requireApprover, (req, res) => {
  const db = getDatabase();

  db.all(
    `${workEntrySelect}
     WHERE we.status = 'submitted'
     ORDER BY we.date DESC, we.created_at DESC`,
    [],
    (err, rows) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      res.json({ workEntries: rows });
    }
  );
});

// Get all work entries for authenticated user (with optional client filter)
router.get('/', (req, res) => {
  const { clientId } = req.query;
  const db = getDatabase();
  
  let query = `${workEntrySelect} WHERE we.user_email = ?`;
  
  const params = [req.userEmail];
  
  if (clientId) {
    const clientIdNum = parseInt(clientId);
    if (isNaN(clientIdNum)) {
      return res.status(400).json({ error: 'Invalid client ID' });
    }
    query += ' AND we.client_id = ?';
    params.push(clientIdNum);
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

// Get specific work entry
router.get('/:id', (req, res) => {
  const workEntryId = parseInt(req.params.id);
  
  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }
  
  const db = getDatabase();
  
  db.get(
    `${workEntrySelect} WHERE we.id = ? AND we.user_email = ?`,
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

            // Return the created work entry with client name
            db.get(
              `${workEntrySelect} WHERE we.id = ?`,
              [this.lastID],
              (err, row) => {
                if (err) {
                  console.error('Database error:', err);
                  return res.status(500).json({ error: 'Work entry created but failed to retrieve' });
                }

                res.status(201).json({
                  message: 'Work entry created successfully',
                  workEntry: row
                });
              }
            );
          }
        );
      }
    );
  } catch (error) {
    next(error);
  }
});

// Submit work entry
router.post('/:id/submit', (req, res) => {
  const workEntryId = parseWorkEntryId(req, res);
  if (workEntryId === null) {
    return;
  }

  loadWorkEntry(req, res, workEntryId, req.userEmail, (db, row) => {
    if (!['draft', 'rejected'].includes(row.status)) {
      return transitionError(res, 'submit', row.status);
    }

    db.run(
      `UPDATE work_entries
       SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
           reviewed_at = NULL, reviewed_by = NULL, rejection_reason = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_email = ?`,
      [workEntryId, req.userEmail],
      function(err) {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Failed to submit work entry' });
        }

        respondWithWorkEntry(
          db,
          res,
          workEntryId,
          req.userEmail,
          'Work entry submitted successfully',
          'Work entry submitted but failed to retrieve'
        );
      }
    );
  });
});

function reviewWorkEntry(req, res, action, status, reason) {
  const workEntryId = parseWorkEntryId(req, res);
  if (workEntryId === null) {
    return;
  }

  loadWorkEntry(req, res, workEntryId, null, (db, row) => {
    if (row.status !== 'submitted') {
      return transitionError(res, action, row.status);
    }

    const rejectionReason = action === 'reject' ? (reason || null) : null;
    db.run(
      `UPDATE work_entries
       SET status = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?,
           rejection_reason = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'submitted'`,
      [status, req.userEmail, rejectionReason, workEntryId],
      function(err) {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: `Failed to ${action} work entry` });
        }

        respondWithWorkEntry(
          db,
          res,
          workEntryId,
          null,
          `Work entry ${action}d successfully`,
          `Work entry ${action}d but failed to retrieve`
        );
      }
    );
  });
}

// Approve submitted work entry
router.post('/:id/approve', requireApprover, (req, res) => {
  reviewWorkEntry(req, res, 'approve', 'approved');
});

// Reject submitted work entry
router.post('/:id/reject', requireApprover, (req, res, next) => {
  try {
    const { error, value } = rejectWorkEntrySchema.validate(req.body);
    if (error) {
      return next(error);
    }

    reviewWorkEntry(req, res, 'reject', 'rejected', value.reason);
  } catch (error) {
    next(error);
  }
});

// Update work entry
router.put('/:id', (req, res, next) => {
  try {
    const workEntryId = parseWorkEntryId(req, res);
    if (workEntryId === null) {
      return;
    }

    const { error, value } = updateWorkEntrySchema.validate(req.body);
    if (error) {
      return next(error);
    }

    // Check if work entry exists and belongs to user
    loadWorkEntry(req, res, workEntryId, req.userEmail, (db, row) => {
      if (row.status === 'approved') {
        return transitionError(res, 'edit', row.status);
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

          // Return updated work entry with client name
          respondWithWorkEntry(
            db,
            res,
            workEntryId,
            req.userEmail,
            'Work entry updated successfully',
            'Work entry updated but failed to retrieve'
          );
        });
      }
    });
  } catch (error) {
    next(error);
  }
});

// Delete work entry
router.delete('/:id', (req, res) => {
  const workEntryId = parseWorkEntryId(req, res);
  if (workEntryId === null) {
    return;
  }
  
  // Check if work entry exists and belongs to user
  loadWorkEntry(req, res, workEntryId, req.userEmail, (db, row) => {
    if (row.status === 'approved') {
      return transitionError(res, 'delete', row.status);
    }

    // Delete work entry
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
  });
});

module.exports = router;
