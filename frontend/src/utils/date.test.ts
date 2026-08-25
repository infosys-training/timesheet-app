import { describe, expect, it } from 'vitest';
import { formatDateOnly } from './date';

describe('formatDateOnly', () => {
  it('formats date-only strings without a timezone shift', () => {
    expect(formatDateOnly('2024-01-15', 'en-US')).toBe('1/15/2024');
  });

  it('documents the old date-only formatting bug in a UTC-negative timezone', () => {
    expect(new Date('2024-01-15').toLocaleDateString('en-US')).toBe('1/14/2024');
  });
});
