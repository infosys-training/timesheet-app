import React from 'react';
import { Chip, Tooltip } from '@mui/material';
import { type WorkEntryStatus } from '../types/api';

const STATUS_LABELS: Record<WorkEntryStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  rejected: 'Rejected',
};

const STATUS_COLORS: Record<WorkEntryStatus, 'default' | 'info' | 'success' | 'error'> = {
  draft: 'default',
  submitted: 'info',
  approved: 'success',
  rejected: 'error',
};

interface WorkEntryStatusChipProps {
  status: WorkEntryStatus;
  rejectionReason?: string | null;
}

const WorkEntryStatusChip: React.FC<WorkEntryStatusChipProps> = ({ status, rejectionReason }) => {
  const chip = (
    <Chip
      label={STATUS_LABELS[status] || status}
      color={STATUS_COLORS[status] || 'default'}
      size="small"
    />
  );

  if (status === 'rejected' && rejectionReason) {
    return <Tooltip title={`Reason: ${rejectionReason}`}>{chip}</Tooltip>;
  }

  return chip;
};

export default WorkEntryStatusChip;
