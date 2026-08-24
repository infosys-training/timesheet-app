import React from 'react';
import { Chip } from '@mui/material';
import { type WorkEntryStatus } from '../types/api';

const STATUS_COLORS: Record<WorkEntryStatus, 'default' | 'info' | 'success' | 'error'> = {
  draft: 'default',
  submitted: 'info',
  approved: 'success',
  rejected: 'error',
};

interface StatusChipProps {
  status: WorkEntryStatus;
}

const StatusChip: React.FC<StatusChipProps> = ({ status }) => (
  <Chip label={status} color={STATUS_COLORS[status]} size="small" />
);

export default StatusChip;
