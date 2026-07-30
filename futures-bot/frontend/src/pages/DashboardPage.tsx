import React from 'react';
import { Grid, Card, CardContent, Typography, Box, Button, Chip, Alert } from '@mui/material';
import { TrendingUp, TrendingDown, People, CheckCircle, Warning } from '@mui/icons-material';
import {
  useStatsSummary,
  useGlobalStats,
  useActiveTraders,
  usePauseTraders,
  useResumeTraders,
  useEmergencyStop,
} from '../hooks/useQueries';
import { useNavigate } from 'react-router-dom';

function StatCard({ title, value, color = 'text.primary', icon }: {
  title: string;
  value: string | number;
  color?: string;
  icon?: React.ReactNode;
}): React.ReactElement {
  return (
    <Card elevation={2}>
      <CardContent>
        <Box display="flex" justifyContent="space-between" alignItems="flex-start">
          <Box>
            <Typography variant="body2" color="text.secondary" gutterBottom>{title}</Typography>
            <Typography variant="h5" fontWeight="bold" color={color}>{value}</Typography>
          </Box>
          {icon != null && <Box color="text.secondary">{icon}</Box>}
        </Box>
      </CardContent>
    </Card>
  );
}

export function DashboardPage(): React.ReactElement {
  const { data: stats } = useGlobalStats();
  const { data: summary } = useStatsSummary();
  const { data: traders } = useActiveTraders();
  const pauseMutation = usePauseTraders();
  const resumeMutation = useResumeTraders();
  const stopMutation = useEmergencyStop();
  const navigate = useNavigate();

  const pnlColor = parseFloat(stats?.totalRealizedPnl ?? '0') >= 0 ? 'success.main' : 'error.main';
  const dailyColor = parseFloat(stats?.dailyPnl ?? '0') >= 0 ? 'success.main' : 'error.main';

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
        <Typography variant="h4" fontWeight="bold">Dashboard</Typography>
        <Box display="flex" gap={1}>
          <Button variant="outlined" color="warning" onClick={() => pauseMutation.mutate()} disabled={pauseMutation.isPending}>
            Pause All
          </Button>
          <Button variant="outlined" color="success" onClick={() => resumeMutation.mutate()} disabled={resumeMutation.isPending}>
            Resume All
          </Button>
          <Button variant="contained" color="error" onClick={() => { if (confirm('EMERGENCY STOP? This closes all positions!')) stopMutation.mutate(); }}>
            Emergency Stop
          </Button>
        </Box>
      </Box>

      {stopMutation.isSuccess && (
        <Alert severity="warning" sx={{ mb: 2 }}>Emergency stop executed. All positions closed.</Alert>
      )}

      <Grid container spacing={2} mb={3}>
        <Grid item xs={6} sm={3}>
          <StatCard title="Active Traders" value={stats?.activeTraders ?? 0} icon={<People />} />
        </Grid>
        <Grid item xs={6} sm={3}>
          <StatCard title="Completed Traders" value={stats?.completedTraders ?? 0} icon={<CheckCircle />} />
        </Grid>
        <Grid item xs={6} sm={3}>
          <StatCard title="Total Realized PnL" value={`$${parseFloat(stats?.totalRealizedPnl ?? '0').toFixed(2)}`} color={pnlColor} icon={<TrendingUp />} />
        </Grid>
        <Grid item xs={6} sm={3}>
          <StatCard title="Daily PnL" value={`$${parseFloat(stats?.dailyPnl ?? '0').toFixed(2)}`} color={dailyColor} />
        </Grid>
        <Grid item xs={6} sm={3}>
          <StatCard title="Unrealized PnL" value={`$${parseFloat(summary?.totalUnrealizedPnl ?? '0').toFixed(2)}`} />
        </Grid>
        <Grid item xs={6} sm={3}>
          <StatCard title="Win Rate" value={`${stats?.winRate ?? '0'}%`} color="primary.main" />
        </Grid>
        <Grid item xs={6} sm={3}>
          <StatCard title="Total Fees" value={`$${parseFloat(stats?.totalFees ?? '0').toFixed(2)}`} color="warning.main" />
        </Grid>
        <Grid item xs={6} sm={3}>
          <StatCard title="Total Traders" value={stats?.totalTraders ?? 0} />
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid item xs={12} md={8}>
          <Card elevation={2}>
            <CardContent>
              <Typography variant="h6" gutterBottom>Active Traders</Typography>
              {traders == null || traders.length === 0 ? (
                <Typography color="text.secondary">No active traders</Typography>
              ) : (
                traders.map((t) => (
                  <Box
                    key={t.id}
                    sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1, borderBottom: '1px solid', borderColor: 'divider', cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
                    onClick={() => void navigate(`/traders/${t.id}`)}
                  >
                    <Typography fontWeight="bold" sx={{ minWidth: 120 }}>{t.symbol}</Typography>
                    <Chip label={t.status} size="small" color={t.status === 'ACTIVE' ? 'success' : 'default'} />
                    <Typography color="text.secondary" sx={{ flexGrow: 1 }}>
                      Entry: {t.entryPrice != null ? `$${parseFloat(t.entryPrice).toFixed(2)}` : 'N/A'}
                    </Typography>
                    <Typography color="text.secondary">L{t.hedgeLevel}</Typography>
                    <Typography color={parseFloat(t.realizedPnl) >= 0 ? 'success.main' : 'error.main'}>
                      ${parseFloat(t.realizedPnl).toFixed(2)}
                    </Typography>
                  </Box>
                ))
              )}
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={4}>
          <Card elevation={2}>
            <CardContent>
              <Typography variant="h6" gutterBottom>Top Gainers</Typography>
              {(summary?.topGainers ?? []).slice(0, 8).map((g) => (
                <Box key={g.symbol} sx={{ display: 'flex', justifyContent: 'space-between', py: 0.5 }}>
                  <Typography variant="body2">{g.symbol}</Typography>
                  <Typography
                    variant="body2"
                    color={parseFloat(g.priceChangePercent) >= 0 ? 'success.main' : 'error.main'}
                    fontWeight="bold"
                  >
                    {parseFloat(g.priceChangePercent) >= 0 ? <TrendingUp fontSize="small" /> : <TrendingDown fontSize="small" />}
                    {g.priceChangePercent}%
                  </Typography>
                </Box>
              ))}
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
