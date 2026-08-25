import { describe, expect, it } from 'vitest';
import { formatDateOnly, parseDateOnly, toDateOnlyString } from './date';

describe('formatDateOnly', () => {
  it('formats date-only strings without a timezone shift', () => {
    expect(formatDateOnly('2024-01-15', 'en-US')).toBe('1/15/2024');
  });

  it('documents the old date-only formatting bug in a UTC-negative timezone', () => {
    expect(new Date('2024-01-15').toLocaleDateString('en-US')).toBe(
      process.env.TZ === 'America/New_York' ? '1/14/2024' : '1/15/2024'
    );
  });

  it('keeps a picked local calendar date when serializing', () => {
    const pickedDate = new Date(2024, 0, 15);
    const oldSerializedValue = pickedDate.toISOString().split('T')[0];

    expect(oldSerializedValue).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone === 'Asia/Calcutta'
        ? '2024-01-14'
        : '2024-01-15'
    );
    expect(toDateOnlyString(pickedDate)).toBe('2024-01-15');
  });

  it('round-trips date-only strings and UTC epoch dates', () => {
    const dateOnly = parseDateOnly('2024-01-15');
    expect([dateOnly.getFullYear(), dateOnly.getMonth(), dateOnly.getDate()]).toEqual([2024, 0, 15]);

    const epochDate = parseDateOnly(Date.UTC(2024, 0, 15));
    expect([epochDate.getFullYear(), epochDate.getMonth(), epochDate.getDate()]).toEqual([2024, 0, 15]);
  });
});
