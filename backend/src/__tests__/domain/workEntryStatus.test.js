const {
  WORK_ENTRY_STATUSES,
  canTransition,
  nextStatus,
  transitionErrorMessage,
  isEditable
} = require('../../domain/workEntryStatus');

const ALL_STATUSES = Object.values(WORK_ENTRY_STATUSES);

// Every allowed edge of the approval state machine
const ALLOWED = [
  ['submit', 'draft', 'submitted'],
  ['submit', 'rejected', 'submitted'],
  ['approve', 'submitted', 'approved'],
  ['reject', 'submitted', 'rejected']
];

describe('Work Entry Status State Machine', () => {
  describe('Allowed transitions', () => {
    test.each(ALLOWED)('%s from %s results in %s', (action, from, to) => {
      expect(canTransition(action, from)).toBe(true);
      expect(nextStatus(action)).toBe(to);
    });

    test('a missing status is treated as draft', () => {
      expect(canTransition('submit', null)).toBe(true);
      expect(canTransition('submit', undefined)).toBe(true);
      expect(canTransition('approve', null)).toBe(false);
    });
  });

  describe('Rejected transitions', () => {
    const rejected = [];
    ['submit', 'approve', 'reject'].forEach((action) => {
      ALL_STATUSES.forEach((status) => {
        if (!ALLOWED.some(([a, from]) => a === action && from === status)) {
          rejected.push([action, status]);
        }
      });
    });

    test('covers every disallowed combination', () => {
      expect(rejected).toHaveLength(3 * ALL_STATUSES.length - ALLOWED.length);
    });

    test.each(rejected)('%s is rejected from %s', (action, status) => {
      expect(canTransition(action, status)).toBe(false);
    });

    test('an unknown action is always rejected', () => {
      expect(canTransition('archive', 'draft')).toBe(false);
      expect(nextStatus('archive')).toBeNull();
      expect(transitionErrorMessage('archive', 'draft')).toBe(
        "Cannot archive a work entry with status 'draft', expected status "
      );
    });
  });

  describe('transitionErrorMessage', () => {
    test('lists the statuses the action is allowed from', () => {
      expect(transitionErrorMessage('submit', 'approved')).toBe(
        "Cannot submit a work entry with status 'approved', expected status draft or rejected"
      );
      expect(transitionErrorMessage('approve', 'draft')).toBe(
        "Cannot approve a work entry with status 'draft', expected status submitted"
      );
    });

    test('reports a missing status as draft', () => {
      expect(transitionErrorMessage('approve', null)).toContain("status 'draft'");
    });
  });

  describe('isEditable', () => {
    test.each(['draft', 'submitted', 'rejected'])('%s is editable', (status) => {
      expect(isEditable(status)).toBe(true);
    });

    test('approved is not editable', () => {
      expect(isEditable('approved')).toBe(false);
    });

    test('a missing status is editable', () => {
      expect(isEditable(null)).toBe(true);
    });
  });
});
