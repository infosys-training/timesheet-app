import React from 'react';
import {
  Grid,
  Card,
  CardContent,
  Typography,
  Box,
  Button,
  Paper,
  LinearProgress,
  Chip,
} from '@mui/material';
import {
  Business as BusinessIcon,
  Assignment as AssignmentIcon,
  Assessment as AssessmentIcon,
  Add as AddIcon,
  School as SchoolIcon,
  ManageAccounts as ManageAccountsIcon,
  Code as CodeIcon,
  BugReport as BugReportIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import apiClient from '../api/client';
import { type EffortBreakdownItem } from '../types/api';

const CATEGORY_CONFIG: Record<string, { color: string; icon: React.ReactElement }> = {
  Learning: { color: '#0288d1', icon: <SchoolIcon /> },
  'Project Management': { color: '#ed6c02', icon: <ManageAccountsIcon /> },
  Development: { color: '#2e7d32', icon: <CodeIcon /> },
  Testing: { color: '#9c27b0', icon: <BugReportIcon /> },
};

const DashboardPage: React.FC = () => {
  const navigate = useNavigate();

  const { data: clientsData } = useQuery({
    queryKey: ['clients'],
    queryFn: () => apiClient.getClients(),
  });

  const { data: workEntriesData } = useQuery({
    queryKey: ['workEntries'],
    queryFn: () => apiClient.getWorkEntries(),
  });

  const { data: effortData } = useQuery({
    queryKey: ['effortBreakdown'],
    queryFn: () => apiClient.getEffortBreakdown(),
  });

  const clients = clientsData?.clients || [];
  const workEntries = workEntriesData?.workEntries || [];
  const effortBreakdown: EffortBreakdownItem[] = effortData?.breakdown || [];
  const grandTotalHours: number = effortData?.grandTotalHours || 0;

  const totalHours = workEntries.reduce((sum: number, entry: { hours: number }) => sum + entry.hours, 0);
  const recentEntries = workEntries.slice(0, 5);

  const statsCards = [
    {
      title: 'Total Clients',
      value: clients.length,
      icon: <BusinessIcon />,
      color: '#1976d2',
      action: () => navigate('/clients'),
    },
    {
      title: 'Total Work Entries',
      value: workEntries.length,
      icon: <AssignmentIcon />,
      color: '#388e3c',
      action: () => navigate('/work-entries'),
    },
    {
      title: 'Total Hours',
      value: totalHours.toFixed(2),
      icon: <AssessmentIcon />,
      color: '#f57c00',
      action: () => navigate('/reports'),
    },
  ];

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Dashboard
      </Typography>

      <Grid container spacing={3} sx={{ mb: 4 }}>
        {statsCards.map((stat, index) => (
          // @ts-expect-error - MUI Grid item prop type issue
          <Grid item xs={12} sm={6} md={4} key={index}>
            <Card
              sx={{
                cursor: 'pointer',
                transition: 'transform 0.2s',
                '&:hover': {
                  transform: 'translateY(-4px)',
                },
              }}
              onClick={stat.action}
            >
              <CardContent>
                <Box display="flex" alignItems="center" justifyContent="space-between" gap={3}>
                  <Box>
                    <Typography color="textSecondary" gutterBottom variant="h6">
                      {stat.title}
                    </Typography>
                    <Typography variant="h4" component="div">
                      {stat.value}
                    </Typography>
                  </Box>
                  <Box
                    sx={{
                      backgroundColor: stat.color,
                      borderRadius: 1,
                      p: 1,
                      color: 'white',
                      flexShrink: 0,
                    }}
                  >
                    {stat.icon}
                  </Box>
                </Box>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      {/* Effort Breakdown Section */}
      <Paper sx={{ p: 3, mb: 4 }}>
        <Typography variant="h6" gutterBottom>
          Effort Breakdown
        </Typography>
        {effortBreakdown.length > 0 && grandTotalHours > 0 ? (
          <Grid container spacing={3}>
            {effortBreakdown.map((item) => {
              const config = CATEGORY_CONFIG[item.category] || { color: '#757575', icon: <AssignmentIcon /> };
              const percentage = grandTotalHours > 0 ? (item.totalHours / grandTotalHours) * 100 : 0;

              return (
                // @ts-expect-error - MUI Grid item prop type issue
                <Grid item xs={12} sm={6} md={3} key={item.category}>
                  <Box sx={{ p: 2, border: '1px solid #e0e0e0', borderRadius: 2 }}>
                    <Box display="flex" alignItems="center" gap={1} mb={1}>
                      <Box sx={{ color: config.color }}>{config.icon}</Box>
                      <Typography variant="subtitle2">{item.category}</Typography>
                    </Box>
                    <Typography variant="h5" sx={{ color: config.color, fontWeight: 'bold' }}>
                      {item.totalHours.toFixed(1)}h
                    </Typography>
                    <Box display="flex" alignItems="center" gap={1} mt={1}>
                      <LinearProgress
                        variant="determinate"
                        value={percentage}
                        sx={{
                          flex: 1,
                          height: 8,
                          borderRadius: 4,
                          backgroundColor: '#e0e0e0',
                          '& .MuiLinearProgress-bar': { backgroundColor: config.color, borderRadius: 4 },
                        }}
                      />
                      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 40 }}>
                        {percentage.toFixed(0)}%
                      </Typography>
                    </Box>
                    <Chip
                      label={`${item.entryCount} ${item.entryCount === 1 ? 'entry' : 'entries'}`}
                      size="small"
                      variant="outlined"
                      sx={{ mt: 1 }}
                    />
                  </Box>
                </Grid>
              );
            })}
          </Grid>
        ) : (
          <Typography color="text.secondary">
            No work entries yet. Add entries with effort categories to see the breakdown.
          </Typography>
        )}
      </Paper>

      <Grid container spacing={3}>
        {/* @ts-expect-error - MUI Grid item prop type issue */}
        <Grid item xs={12} md={8}>
          <Paper sx={{ p: 3 }}>
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={2} gap={3}>
              <Typography variant="h6">Recent Work Entries</Typography>
              <Button
                variant="outlined"
                startIcon={<AddIcon />}
                onClick={() => navigate('/work-entries')}
                sx={{ flexShrink: 0 }}
              >
                Add Entry
              </Button>
            </Box>
            {recentEntries.length > 0 ? (
              recentEntries.map((entry: { id: number; client_name: string; hours: number; date: string; description?: string; effort_category?: string }) => (
                <Box key={entry.id} sx={{ mb: 2, pb: 2, borderBottom: '1px solid #eee' }}>
                  <Box display="flex" alignItems="center" gap={1}>
                    <Typography variant="subtitle1">{entry.client_name}</Typography>
                    {entry.effort_category && (
                      <Chip
                        label={entry.effort_category}
                        size="small"
                        sx={{
                          backgroundColor: CATEGORY_CONFIG[entry.effort_category]?.color || '#757575',
                          color: 'white',
                        }}
                      />
                    )}
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    {entry.hours} hours - {new Date(entry.date).toLocaleDateString()}
                  </Typography>
                  {entry.description && (
                    <Typography variant="body2" sx={{ mt: 1 }}>
                      {entry.description}
                    </Typography>
                  )}
                </Box>
              ))
            ) : (
              <Typography color="text.secondary">No work entries yet</Typography>
            )}
          </Paper>
        </Grid>

        {/* @ts-expect-error - MUI Grid item prop type issue */}
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" mb={2}>
              Quick Actions
            </Typography>
            <Box display="flex" flexDirection="column" gap={2}>
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={() => navigate('/clients')}
                fullWidth
              >
                Add Client
              </Button>
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={() => navigate('/work-entries')}
                fullWidth
              >
                Add Work Entry
              </Button>
              <Button
                variant="outlined"
                startIcon={<AssessmentIcon />}
                onClick={() => navigate('/reports')}
                fullWidth
              >
                View Reports
              </Button>
            </Box>
          </Paper>
        </Grid>
      </Grid>
    </Box>
  );
};

export default DashboardPage;
