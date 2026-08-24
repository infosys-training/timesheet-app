import React from 'react';
import { Chip } from '@mui/material';
import { type WorkEntryStatus } from '../types/api';

const statusConfig: Record<WorkEntryStatus, { label: string; color: 'default' | 'info' | 'success' | 'error' }> = {
  draft: { label: 'Draft', color: 'default' },
  submitted: { label: 'Submitted', color: 'info' },
  approved: { label: 'Approved', color: 'success' },
  rejected: { label: 'Rejected', color: 'error' },
};

interface WorkEntryStatusChipProps {
  status?: WorkEntryStatus;
}

const WorkEntryStatusChip: React.FC<WorkEntryStatusChipProps> = ({ status }) => {
  const { label, color } = statusConfig[status ?? 'draft'] ?? statusConfig.draft;

  return <Chip label={label} color={color} size="small" />;
};

export default WorkEntryStatusChip;
