import React, { useState } from 'react';
import {
  Box,
  Typography,
  Button,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Alert,
  CircularProgress,
} from '@mui/material';
import {
  Check as CheckIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from '../api/client';
import { getApiErrorMessage } from '../api/errors';
import WorkEntryCells from '../components/WorkEntryCells';
import { useAuth } from '../hooks/useAuth';
import { type WorkEntry } from '../types/api';

const PendingApprovalsPage: React.FC = () => {
  const [error, setError] = useState('');
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['pendingApprovals'],
    queryFn: () => apiClient.getPendingApprovals(),
    enabled: !!user?.isApprover,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['pendingApprovals'] });
    queryClient.invalidateQueries({ queryKey: ['workEntries'] });
  };

  const handleError = (fallback: string) => (err: unknown) => setError(getApiErrorMessage(err, fallback));

  const approveMutation = useMutation({
    mutationFn: (id: number) => apiClient.approveWorkEntry(id),
    onSuccess: invalidate,
    onError: handleError('Failed to approve work entry'),
  });

  const rejectMutation = useMutation({
    mutationFn: (id: number) => apiClient.rejectWorkEntry(id),
    onSuccess: invalidate,
    onError: handleError('Failed to reject work entry'),
  });

  if (!user?.isApprover) {
    return (
      <Alert severity="info">
        You are not configured as an approver, so there is nothing to review here.
      </Alert>
    );
  }

  if (isLoading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress />
      </Box>
    );
  }

  const workEntries: WorkEntry[] = data?.workEntries || [];
  const isPending = approveMutation.isPending || rejectMutation.isPending;

  return (
    <Box>
      <Typography variant="h4" sx={{ mb: 3 }}>
        Pending Approvals
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <Paper>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Employee</TableCell>
                <TableCell>Client</TableCell>
                <TableCell>Date</TableCell>
                <TableCell>Hours</TableCell>
                <TableCell>Description</TableCell>
                <TableCell>Submitted</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {workEntries.length > 0 ? (
                workEntries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>
                      <Typography variant="body2">{entry.user_email}</Typography>
                    </TableCell>
                    <WorkEntryCells entry={entry} />
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {entry.submitted_at ? new Date(entry.submitted_at).toLocaleString() : '-'}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        startIcon={<CheckIcon />}
                        color="success"
                        size="small"
                        onClick={() => approveMutation.mutate(entry.id)}
                        disabled={isPending}
                      >
                        Approve
                      </Button>
                      <Button
                        startIcon={<CloseIcon />}
                        color="error"
                        size="small"
                        onClick={() => rejectMutation.mutate(entry.id)}
                        disabled={isPending}
                      >
                        Reject
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={7} align="center">
                    <Typography color="text.secondary" sx={{ py: 3 }}>
                      No work entries are waiting for approval.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>
    </Box>
  );
};

export default PendingApprovalsPage;
