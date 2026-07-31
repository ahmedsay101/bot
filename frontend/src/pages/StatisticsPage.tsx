import React from 'react';
import { Box, Typography, Grid, Card, CardContent } from '@mui/material';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { useGlobalStats, useAllTraders } from '../hooks/useQueries';

const COLORS = ['#00C49F', '#FF8042', '#FFBB28', '#0088FE'];

export function StatisticsPage(): React.ReactElement {
  const { data: stats } = useGlobalStats();
  const { data: traders } = useAllTraders();

  const statusData = [
    { name: 'Active', value: stats?.activeTraders ?? 0 },
    { name: 'Completed', value: stats?.completedTraders ?? 0 },
    { name: 'Failed', value: (stats?.totalTraders ?? 0) - (stats?.activeTraders ?? 0) - (stats?.completedTraders ?? 0) },
  ].filter((d) => d.value > 0);

  const pnlData = (traders ?? [])
    .filter((t) => parseFloat(t.realizedPnl) !== 0)
    .slice(0, 20)
    .map((t) => ({
      symbol: t.symbol.replace('USDT', ''),
      pnl: parseFloat(parseFloat(t.realizedPnl).toFixed(2)),
    }));

  return (
    <Box>
      <Typography variant="h4" fontWeight="bold" mb={3}>Statistics</Typography>

      <Grid container spacing={2} mb={3}>
        <Grid item xs={6} sm={3}>
          <Card elevation={2}><CardContent>
            <Typography variant="body2" color="text.secondary">Equity</Typography>
            <Typography variant="h5" fontWeight="bold">
              ${parseFloat(stats?.totalEquity ?? '0').toFixed(2)}
            </Typography>
          </CardContent></Card>
        </Grid>
        <Grid item xs={6} sm={3}>
          <Card elevation={2}><CardContent>
            <Typography variant="body2" color="text.secondary">Total PnL</Typography>
            <Typography variant="h5" color={parseFloat(stats?.totalPnl ?? stats?.totalRealizedPnl ?? '0') >= 0 ? 'success.main' : 'error.main'} fontWeight="bold">
              ${parseFloat(stats?.totalPnl ?? stats?.totalRealizedPnl ?? '0').toFixed(2)}
            </Typography>
          </CardContent></Card>
        </Grid>
        <Grid item xs={6} sm={3}>
          <Card elevation={2}><CardContent>
            <Typography variant="body2" color="text.secondary">Active Traders</Typography>
            <Typography variant="h5" color="primary.main" fontWeight="bold">
              {stats?.activeTraders ?? 0} / {stats?.maxTraders ?? 0}
            </Typography>
          </CardContent></Card>
        </Grid>
        <Grid item xs={6} sm={3}>
          <Card elevation={2}><CardContent>
            <Typography variant="body2" color="text.secondary">Win Rate</Typography>
            <Typography variant="h5" color="primary.main" fontWeight="bold">{stats?.winRate ?? '0'}%</Typography>
          </CardContent></Card>
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid item xs={12} md={8}>
          <Card elevation={2}>
            <CardContent>
              <Typography variant="h6" gutterBottom>PnL by Trader</Typography>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={pnlData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="symbol" />
                  <YAxis />
                  <Tooltip formatter={(v) => [`$${String(v)}`, 'PnL']} />
                  <Bar dataKey="pnl" fill="#2196f3" radius={[4, 4, 0, 0]}
                    label={{ position: 'top', fontSize: 10 }}
                  />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} md={4}>
          <Card elevation={2}>
            <CardContent>
              <Typography variant="h6" gutterBottom>Trader Status Distribution</Typography>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={statusData} cx="50%" cy="50%" outerRadius={100} dataKey="value" label={({ name, value }) => `${name}: ${String(value)}`}>
                    {statusData.map((_entry, idx) => (
                      <Cell key={`cell-${idx}`} fill={COLORS[idx % COLORS.length]} />
                    ))}
                  </Pie>
                  <Legend />
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
