const {
  WORK_ENTRY_STATUSES,
  DEFAULT_STATUS,
  isValidStatus,
  canTransition,
  nextStatus,
  isEditable,
  transitionErrorMessage
} = require('../../domain/workEntryStatus');

describe('Work Entry Status State Machine', () => {
  test('exposes the four known statuses with draft as default', () => {
    expect(WORK_ENTRY_STATUSES).toEqual(['draft', 'submitted', 'approved', 'rejected']);
    expect(DEFAULT_STATUS).toBe('draft');
  });

  describe('isValidStatus', () => {
    test.each(WORK_ENTRY_STATUSES)('accepts %s', (status) => {
      expect(isValidStatus(status)).toBe(true);
    });

    test('rejects unknown status', () => {
      expect(isValidStatus('pending')).toBe(false);
    });
  });

  describe('canTransition', () => {
    const allowed = [
      ['submit', 'draft'],
      ['submit', 'rejected'],
      ['approve', 'submitted'],
      ['reject', 'submitted']
    ];

    test.each(allowed)('allows %s from %s', (action, status) => {
      expect(canTransition(action, status)).toBe(true);
    });

    const rejected = [
      ['submit', 'submitted'],
      ['submit', 'approved'],
      ['approve', 'draft'],
      ['approve', 'rejected'],
      ['approve', 'approved'],
      ['reject', 'draft'],
      ['reject', 'rejected'],
      ['reject', 'approved']
    ];

    test.each(rejected)('rejects %s from %s', (action, status) => {
      expect(canTransition(action, status)).toBe(false);
    });

    test('rejects unknown actions', () => {
      expect(canTransition('archive', 'draft')).toBe(false);
    });
  });

  describe('nextStatus', () => {
    test.each([
      ['submit', 'submitted'],
      ['approve', 'approved'],
      ['reject', 'rejected']
    ])('%s results in %s', (action, status) => {
      expect(nextStatus(action)).toBe(status);
    });
  });

  describe('isEditable', () => {
    test.each(['draft', 'submitted', 'rejected'])('%s entries are editable', (status) => {
      expect(isEditable(status)).toBe(true);
    });

    test('approved entries are immutable', () => {
      expect(isEditable('approved')).toBe(false);
    });
  });

  test('transitionErrorMessage lists the allowed source statuses', () => {
    expect(transitionErrorMessage('approve', 'draft')).toBe(
      "Cannot approve a work entry with status 'draft'. Allowed statuses: submitted"
    );
  });
});
