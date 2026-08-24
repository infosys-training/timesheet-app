const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateUser, requireApprover } = require('../middleware/auth');
const { workEntrySchema, updateWorkEntrySchema, reviewDecisionSchema } = require('../validation/schemas');
const {
  isValidStatus,
  canTransition,
  nextStatus,
  isEditable,
  transitionErrorMessage
} = require('../domain/workEntryStatus');

const router = express.Router();

const WORK_ENTRY_COLUMNS = `we.id, we.client_id, we.hours, we.description, we.date,
           we.status, we.submitted_at, we.reviewed_at, we.reviewed_by, we.review_note,
           we.created_at, we.updated_at, c.name as client_name`;

// All routes require authentication
router.use(authenticateUser);

// Get all work entries for authenticated user (with optional client filter)
router.get('/', (req, res) => {
  const { clientId, status } = req.query;
  const db = getDatabase();
  
  let query = `
    SELECT ${WORK_ENTRY_COLUMNS}
    FROM work_entries we
    JOIN clients c ON we.client_id = c.id
    WHERE we.user_email = ?
  `;
  
  const params = [req.userEmail];
  
  if (status) {
    if (!isValidStatus(status)) {
      return res.status(400).json({ error: 'Invalid status filter' });
    }
    query += ' AND we.status = ?';
    params.push(status);
  }
  
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

// Get all submitted work entries awaiting review (approvers only)
router.get('/pending-approvals', requireApprover, (req, res) => {
  const db = getDatabase();
  
  db.all(
    `SELECT ${WORK_ENTRY_COLUMNS}, we.user_email
     FROM work_entries we
     JOIN clients c ON we.client_id = c.id
     WHERE we.status = 'submitted'
     ORDER BY we.submitted_at ASC, we.date ASC`,
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

// Get specific work entry
router.get('/:id', (req, res) => {
  const workEntryId = parseInt(req.params.id);
  
  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }
  
  const db = getDatabase();
  
  db.get(
    `SELECT ${WORK_ENTRY_COLUMNS}
     FROM work_entries we
     JOIN clients c ON we.client_id = c.id
     WHERE we.id = ? AND we.user_email = ?`,
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
              `SELECT ${WORK_ENTRY_COLUMNS}
               FROM work_entries we
               JOIN clients c ON we.client_id = c.id
               WHERE we.id = ?`,
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

    // Check if work entry exists and belongs to user
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

        if (!isEditable(row.status)) {
          return res.status(409).json({ error: `Cannot edit a work entry with status '${row.status}'` });
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
            db.get(
              `SELECT ${WORK_ENTRY_COLUMNS}
               FROM work_entries we
               JOIN clients c ON we.client_id = c.id
               WHERE we.id = ?`,
              [workEntryId],
              (err, row) => {
                if (err) {
                  console.error('Database error:', err);
                  return res.status(500).json({ error: 'Work entry updated but failed to retrieve' });
                }

                res.json({
                  message: 'Work entry updated successfully',
                  workEntry: row
                });
              }
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
  
  // Check if work entry exists and belongs to user
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
      
      if (!isEditable(row.status)) {
        return res.status(409).json({ error: `Cannot delete a work entry with status '${row.status}'` });
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
    }
  );
});

// Apply a status transition and return the updated work entry
function performTransition({ action, workEntryId, ownerEmail, reviewer, note }, res) {
  const db = getDatabase();

  const lookupQuery = ownerEmail
    ? 'SELECT id, status FROM work_entries WHERE id = ? AND user_email = ?'
    : 'SELECT id, status FROM work_entries WHERE id = ?';
  const lookupParams = ownerEmail ? [workEntryId, ownerEmail] : [workEntryId];

  db.get(lookupQuery, lookupParams, (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Work entry not found' });
    }

    if (!canTransition(action, row.status)) {
      return res.status(409).json({ error: transitionErrorMessage(action, row.status) });
    }

    const targetStatus = nextStatus(action);
    const updates = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const values = [targetStatus];

    if (action === 'submit') {
      // A resubmission clears the previous review
      updates.push('submitted_at = CURRENT_TIMESTAMP', 'reviewed_at = NULL', 'reviewed_by = NULL', 'review_note = NULL');
    } else {
      updates.push('reviewed_at = CURRENT_TIMESTAMP', 'reviewed_by = ?', 'review_note = ?');
      values.push(reviewer, note || null);
    }

    values.push(workEntryId);

    db.run(`UPDATE work_entries SET ${updates.join(', ')} WHERE id = ?`, values, function(err) {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: `Failed to ${action} work entry` });
      }

      db.get(
        `SELECT ${WORK_ENTRY_COLUMNS}
         FROM work_entries we
         JOIN clients c ON we.client_id = c.id
         WHERE we.id = ?`,
        [workEntryId],
        (err, updatedRow) => {
          if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Work entry updated but failed to retrieve' });
          }

          res.json({
            message: `Work entry ${targetStatus} successfully`,
            workEntry: updatedRow
          });
        }
      );
    });
  });
}

// Submit own work entry for approval (draft or rejected -> submitted)
router.post('/:id/submit', (req, res) => {
  const workEntryId = parseInt(req.params.id);

  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }

  performTransition({ action: 'submit', workEntryId, ownerEmail: req.userEmail }, res);
});

// Approve a submitted work entry (approvers only)
router.post('/:id/approve', requireApprover, (req, res, next) => {
  const workEntryId = parseInt(req.params.id);

  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }

  const { error, value } = reviewDecisionSchema.validate(req.body || {});
  if (error) {
    return next(error);
  }

  performTransition(
    { action: 'approve', workEntryId, reviewer: req.userEmail, note: value.note },
    res
  );
});

// Reject a submitted work entry (approvers only)
router.post('/:id/reject', requireApprover, (req, res, next) => {
  const workEntryId = parseInt(req.params.id);

  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }

  const { error, value } = reviewDecisionSchema.validate(req.body || {});
  if (error) {
    return next(error);
  }

  performTransition(
    { action: 'reject', workEntryId, reviewer: req.userEmail, note: value.note },
    res
  );
});

module.exports = router;
