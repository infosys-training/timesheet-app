// Approval state machine for work entries
const STATUS = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  REJECTED: 'rejected'
};

const TRANSITIONS = {
  [STATUS.DRAFT]: [STATUS.SUBMITTED],
  [STATUS.SUBMITTED]: [STATUS.APPROVED, STATUS.REJECTED],
  [STATUS.APPROVED]: [],
  [STATUS.REJECTED]: [STATUS.SUBMITTED]
};

function normalizeStatus(status) {
  return status || STATUS.DRAFT;
}

function canTransition(from, to) {
  const allowed = TRANSITIONS[normalizeStatus(from)];
  return Array.isArray(allowed) && allowed.includes(to);
}

function isEditable(status) {
  return normalizeStatus(status) !== STATUS.APPROVED;
}

module.exports = {
  STATUS,
  TRANSITIONS,
  normalizeStatus,
  canTransition,
  isEditable
};
