import React from 'react';
import { Box, Typography, Grid, Card, CardContent, Alert, Chip, LinearProgress } from '@mui/material';
import { CheckCircle, Error, Warning } from '@mui/icons-material';
import { useSystemHealth } from '../hooks/useQueries';

function HealthIndicator({ label, ok }: { label: string; ok: boolean }): React.ReactElement {
  return (
    <Box display="flex" alignItems="center" gap={1} py={1}>
      {ok ? <CheckCircle color="success" fontSize="small" /> : <Error color="error" fontSize="small" />}
      <Typography>{label}</Typography>
      <Chip label={ok ? 'OK' : 'FAIL'} size="small" color={ok ? 'success' : 'error'} />
    </Box>
  );
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

export function SystemHealthPage(): React.ReactElement {
  const { data: health, isLoading, isError } = useSystemHealth();

  if (isLoading) return <Typography>Loading system health...</Typography>;
  if (isError || health == null) return <Alert severity="error">Failed to load system health</Alert>;

  return (
    <Box>
      <Typography variant="h4" fontWeight="bold" mb={3}>System Health</Typography>

      <Box mb={2}>
        <Chip
          label={health.status.toUpperCase()}
          color={health.status === 'healthy' ? 'success' : health.status === 'degraded' ? 'warning' : 'error'}
          icon={health.status === 'healthy' ? <CheckCircle /> : <Warning />}
          sx={{ fontSize: '1rem', py: 2, px: 1 }}
        />
      </Box>

      <Grid container spacing={2}>
        <Grid item xs={12} md={6}>
          <Card elevation={2}>
            <CardContent>
              <Typography variant="h6" gutterBottom>Services</Typography>
              <HealthIndicator label="Database (PostgreSQL)" ok={health.database} />
              <HealthIndicator label="Cache (Redis)" ok={health.redis} />
              <HealthIndicator label="Binance REST API" ok={health.binanceApi} />
              <HealthIndicator label="Binance WebSocket" ok={health.binanceWs} />
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={6}>
          <Card elevation={2}>
            <CardContent>
              <Typography variant="h6" gutterBottom>Resources</Typography>
              <Box mb={2}>
                <Box display="flex" justifyContent="space-between" mb={0.5}>
                  <Typography variant="body2">CPU Usage</Typography>
                  <Typography variant="body2">{health.cpuPercent.toFixed(1)}%</Typography>
                </Box>
                <LinearProgress
                  variant="determinate"
                  value={Math.min(health.cpuPercent, 100)}
                  color={health.cpuPercent > 80 ? 'error' : health.cpuPercent > 60 ? 'warning' : 'success'}
                />
              </Box>
              <Typography variant="body2" color="text.secondary">Memory: {health.memoryMb} MB used</Typography>
              <Typography variant="body2" color="text.secondary" mt={1}>Uptime: {formatUptime(health.uptime)}</Typography>
              <Typography variant="body2" color="text.secondary" mt={1}>Active Traders: {health.activeTraders}</Typography>
              <Typography variant="body2" color="text.secondary" mt={1}>Last checked: {new Date(health.timestamp).toLocaleTimeString()}</Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
