import React, { useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Card,
  CardContent,
  Grid,
  CircularProgress,
  Chip,
  LinearProgress,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
} from '@mui/material';
import {
  Category as CategoryIcon,
  Code as CodeIcon,
  Timer as TimerIcon,
  Assignment as AssignmentIcon,
} from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import apiClient from '../api/client';
import {
  type ActivityCodeDashboardData,
  type ActivityCodeSummary,
  type CategorySummary,
} from '../types/api';

const CATEGORY_COLORS: Record<string, string> = {
  Engineering: '#1976d2',
  Management: '#f57c00',
  Support: '#388e3c',
  Operations: '#7b1fa2',
};

const ActivityCodeDashboardPage: React.FC = () => {
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  const { data: dashboardData, isLoading } = useQuery<ActivityCodeDashboardData>({
    queryKey: ['activityCodeDashboard'],
    queryFn: () => apiClient.getActivityCodeDashboard(),
  });

  if (isLoading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress />
      </Box>
    );
  }

  const byActivityCode: ActivityCodeSummary[] = dashboardData?.byActivityCode || [];
  const byCategory: CategorySummary[] = dashboardData?.byCategory || [];

  const totalHours = byCategory.reduce((sum, cat) => sum + cat.total_hours, 0);
  const totalEntries = byCategory.reduce((sum, cat) => sum + cat.entry_count, 0);
  const categoriesWithData = byCategory.filter((c) => c.total_hours > 0).length;

  const filteredCodes =
    selectedCategory === 'all'
      ? byActivityCode
      : byActivityCode.filter((ac) => ac.category === selectedCategory);

  const maxHours = Math.max(...byActivityCode.map((ac) => ac.total_hours), 1);

  const statCards = [
    {
      title: 'Total Hours Tracked',
      value: totalHours.toFixed(2),
      icon: <TimerIcon />,
      color: '#1976d2',
    },
    {
      title: 'Total Entries',
      value: totalEntries,
      icon: <AssignmentIcon />,
      color: '#388e3c',
    },
    {
      title: 'Active Categories',
      value: categoriesWithData,
      icon: <CategoryIcon />,
      color: '#f57c00',
    },
    {
      title: 'Activity Codes Used',
      value: byActivityCode.filter((ac) => ac.total_hours > 0).length,
      icon: <CodeIcon />,
      color: '#7b1fa2',
    },
  ];

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Activity Code Dashboard
      </Typography>

      {/* Stats Cards */}
      <Grid container spacing={3} sx={{ mb: 4 }}>
        {statCards.map((stat, index) => (
          // @ts-expect-error - MUI Grid item prop type issue
          <Grid item xs={12} sm={6} md={3} key={index}>
            <Card>
              <CardContent>
                <Box display="flex" alignItems="center" justifyContent="space-between" gap={2}>
                  <Box>
                    <Typography color="textSecondary" variant="body2" gutterBottom>
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

      {/* Category Breakdown */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Typography variant="h6" gutterBottom>
          Hours by Category
        </Typography>
        {byCategory.length > 0 ? (
          <Grid container spacing={2}>
            {byCategory.map((cat) => (
              // @ts-expect-error - MUI Grid item prop type issue
              <Grid item xs={12} sm={6} md={3} key={cat.category}>
                <Box
                  sx={{
                    p: 2,
                    borderRadius: 1,
                    border: '1px solid',
                    borderColor: 'divider',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    backgroundColor:
                      selectedCategory === cat.category ? 'action.selected' : 'transparent',
                    '&:hover': { backgroundColor: 'action.hover' },
                  }}
                  onClick={() =>
                    setSelectedCategory(
                      selectedCategory === cat.category ? 'all' : cat.category
                    )
                  }
                >
                  <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
                    <Typography variant="subtitle2">{cat.category}</Typography>
                    <Chip
                      label={`${cat.total_hours.toFixed(1)}h`}
                      size="small"
                      sx={{
                        backgroundColor: CATEGORY_COLORS[cat.category] || '#757575',
                        color: 'white',
                      }}
                    />
                  </Box>
                  <LinearProgress
                    variant="determinate"
                    value={totalHours > 0 ? (cat.total_hours / totalHours) * 100 : 0}
                    sx={{
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: 'grey.200',
                      '& .MuiLinearProgress-bar': {
                        backgroundColor: CATEGORY_COLORS[cat.category] || '#757575',
                        borderRadius: 4,
                      },
                    }}
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                    {cat.entry_count} {cat.entry_count === 1 ? 'entry' : 'entries'}
                    {totalHours > 0 && ` (${((cat.total_hours / totalHours) * 100).toFixed(1)}%)`}
                  </Typography>
                </Box>
              </Grid>
            ))}
          </Grid>
        ) : (
          <Typography color="text.secondary">No data yet. Log time entries with activity codes to see category breakdown.</Typography>
        )}
      </Paper>

      {/* Activity Code Drill-Down Table */}
      <Paper sx={{ p: 3 }}>
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={2} gap={2}>
          <Typography variant="h6">Activity Code Drill-Down</Typography>
          <FormControl size="small" sx={{ minWidth: 200 }}>
            <InputLabel>Filter by Category</InputLabel>
            <Select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              label="Filter by Category"
            >
              <MenuItem value="all">All Categories</MenuItem>
              {byCategory.map((cat) => (
                <MenuItem key={cat.category} value={cat.category}>
                  {cat.category}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>

        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Code</TableCell>
                <TableCell>Activity Name</TableCell>
                <TableCell>Category</TableCell>
                <TableCell align="right">Hours</TableCell>
                <TableCell align="right">Entries</TableCell>
                <TableCell>Distribution</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredCodes.length > 0 ? (
                filteredCodes.map((ac) => (
                  <TableRow key={ac.activity_code_id}>
                    <TableCell>
                      <Chip
                        label={ac.code}
                        size="small"
                        sx={{
                          backgroundColor: CATEGORY_COLORS[ac.category] || '#757575',
                          color: 'white',
                          fontWeight: 'bold',
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">{ac.activity_name}</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {ac.category}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="body2" fontWeight="medium">
                        {ac.total_hours.toFixed(2)}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="body2">{ac.entry_count}</Typography>
                    </TableCell>
                    <TableCell sx={{ minWidth: 150 }}>
                      <LinearProgress
                        variant="determinate"
                        value={(ac.total_hours / maxHours) * 100}
                        sx={{
                          height: 8,
                          borderRadius: 4,
                          backgroundColor: 'grey.200',
                          '& .MuiLinearProgress-bar': {
                            backgroundColor: CATEGORY_COLORS[ac.category] || '#757575',
                            borderRadius: 4,
                          },
                        }}
                      />
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={6} align="center">
                    <Typography color="text.secondary" sx={{ py: 3 }}>
                      No activity data available. Log time entries with activity codes to see the drill-down.
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

export default ActivityCodeDashboardPage;
