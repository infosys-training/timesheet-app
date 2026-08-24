import { type WorkEntryStatus } from '../types/api';

export const STATUS_LABELS: Record<WorkEntryStatus, string> = {
  draft: 'Draft',
  submitted: 'Pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

export const STATUS_COLORS: Record<WorkEntryStatus, 'default' | 'info' | 'success' | 'error'> = {
  draft: 'default',
  submitted: 'info',
  approved: 'success',
  rejected: 'error',
};

// An approved entry is final: it can no longer be edited or deleted
export const canEdit = (status: WorkEntryStatus): boolean => status !== 'approved';

export const canSubmit = (status: WorkEntryStatus): boolean =>
  status === 'draft' || status === 'rejected';
