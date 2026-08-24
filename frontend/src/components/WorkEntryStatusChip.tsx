import React from 'react';
import { Chip, Tooltip } from '@mui/material';
import { type WorkEntryStatus } from '../types/api';

const STATUS_CONFIG: Record<WorkEntryStatus, { label: string; color: 'default' | 'info' | 'success' | 'error' }> = {
  draft: { label: 'Draft', color: 'default' },
  submitted: { label: 'Submitted', color: 'info' },
  approved: { label: 'Approved', color: 'success' },
  rejected: { label: 'Rejected', color: 'error' },
};

interface WorkEntryStatusChipProps {
  status: WorkEntryStatus;
  reviewNote?: string | null;
  reviewedBy?: string | null;
}

const WorkEntryStatusChip: React.FC<WorkEntryStatusChipProps> = ({ status, reviewNote, reviewedBy }) => {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.draft;
  const chip = <Chip label={config.label} color={config.color} size="small" />;

  const tooltip = [reviewedBy && `Reviewed by ${reviewedBy}`, reviewNote].filter(Boolean).join(' — ');

  return tooltip ? <Tooltip title={tooltip}>{chip}</Tooltip> : chip;
};

export default WorkEntryStatusChip;
