const WORK_ENTRY_STATUSES = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  REJECTED: 'rejected'
};

// Approval state machine:
//   draft     --submit--> submitted
//   rejected  --submit--> submitted
//   submitted --approve--> approved (terminal)
//   submitted --reject--> rejected
const TRANSITIONS = {
  submit: {
    from: [WORK_ENTRY_STATUSES.DRAFT, WORK_ENTRY_STATUSES.REJECTED],
    to: WORK_ENTRY_STATUSES.SUBMITTED
  },
  approve: {
    from: [WORK_ENTRY_STATUSES.SUBMITTED],
    to: WORK_ENTRY_STATUSES.APPROVED
  },
  reject: {
    from: [WORK_ENTRY_STATUSES.SUBMITTED],
    to: WORK_ENTRY_STATUSES.REJECTED
  }
};

function canTransition(action, currentStatus) {
  const transition = TRANSITIONS[action];
  if (!transition) {
    return false;
  }

  return transition.from.includes(currentStatus || WORK_ENTRY_STATUSES.DRAFT);
}

function nextStatus(action) {
  return TRANSITIONS[action] ? TRANSITIONS[action].to : null;
}

function transitionErrorMessage(action, currentStatus) {
  const transition = TRANSITIONS[action];
  const from = transition ? transition.from.join(' or ') : '';

  return `Cannot ${action} a work entry with status '${currentStatus || WORK_ENTRY_STATUSES.DRAFT}', expected status ${from}`;
}

function isEditable(status) {
  return (status || WORK_ENTRY_STATUSES.DRAFT) !== WORK_ENTRY_STATUSES.APPROVED;
}

module.exports = {
  WORK_ENTRY_STATUSES,
  TRANSITIONS,
  canTransition,
  nextStatus,
  transitionErrorMessage,
  isEditable
};
