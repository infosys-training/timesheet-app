import React from 'react';
import { Chip } from '@mui/material';
import { type WorkEntryStatus } from '../types/api';

const STATUS_CONFIG: Record<WorkEntryStatus, { label: string; color: 'default' | 'info' | 'success' | 'error' }> = {
  draft: { label: 'Draft', color: 'default' },
  submitted: { label: 'Submitted', color: 'info' },
  approved: { label: 'Approved', color: 'success' },
  rejected: { label: 'Rejected', color: 'error' },
};

interface WorkEntryStatusChipProps {
  status: WorkEntryStatus;
}

const WorkEntryStatusChip: React.FC<WorkEntryStatusChipProps> = ({ status }) => {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.draft;

  return <Chip label={config.label} color={config.color} size="small" />;
};

export default WorkEntryStatusChip;
