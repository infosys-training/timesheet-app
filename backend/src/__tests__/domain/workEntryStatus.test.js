const {
  WORK_ENTRY_STATUSES,
  isValidStatus,
  canTransition,
  isEditable
} = require('../../domain/workEntryStatus');

describe('Work Entry Status State Machine', () => {
  test('exposes the four known statuses', () => {
    expect(WORK_ENTRY_STATUSES).toEqual(['draft', 'submitted', 'approved', 'rejected']);
  });

  describe('isValidStatus', () => {
    test.each(WORK_ENTRY_STATUSES)('accepts %s', (status) => {
      expect(isValidStatus(status)).toBe(true);
    });

    test.each(['', 'Draft', 'archived', undefined, null])('rejects %p', (status) => {
      expect(isValidStatus(status)).toBe(false);
    });
  });

  describe('canTransition', () => {
    const valid = [
      ['draft', 'submitted'],
      ['rejected', 'submitted'],
      ['submitted', 'approved'],
      ['submitted', 'rejected']
    ];

    test.each(valid)('allows %s -> %s', (from, to) => {
      expect(canTransition(from, to)).toBe(true);
    });

    const invalid = WORK_ENTRY_STATUSES.flatMap((from) =>
      WORK_ENTRY_STATUSES.map((to) => [from, to])
    ).filter(([from, to]) => !valid.some(([vf, vt]) => vf === from && vt === to));

    test.each(invalid)('blocks %s -> %s', (from, to) => {
      expect(canTransition(from, to)).toBe(false);
    });

    test('blocks transitions from or to unknown statuses', () => {
      expect(canTransition('archived', 'submitted')).toBe(false);
      expect(canTransition('draft', 'archived')).toBe(false);
      expect(canTransition(undefined, 'submitted')).toBe(false);
    });
  });

  describe('isEditable', () => {
    test.each(['draft', 'submitted', 'rejected'])('%s entries stay editable', (status) => {
      expect(isEditable(status)).toBe(true);
    });

    test('approved entries are locked', () => {
      expect(isEditable('approved')).toBe(false);
    });
  });
});
