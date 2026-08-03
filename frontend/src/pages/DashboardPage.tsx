import React from 'react';
import {
  Box, Grid, Card, CardContent, Typography, Chip, Button, Table, TableBody, TableCell, TableRow,
} from '@mui/material';
import { Warning } from '@mui/icons-material';
import {
  useStatsSummary,
  useActiveTraders,
  usePauseTraders,
  useResumeTraders,
  useEmergencyStop,
} from '../hooks/useQueries';
import { useSystemStore } from '../stores/systemStore';
import type { TraderSummary, HedgeLevelInfo } from '../services/api';

function money(v: string | number | null | undefined, dp = 2): string {
  const n = parseFloat(String(v ?? '0'));
  if (!isFinite(n)) return '—';
  return `$${n.toFixed(dp)}`;
}

function pnl(v: string, dp = 2): string {
  const n = parseFloat(v);
  if (!isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(dp)}`;
}

function col(v: string): string {
  const n = parseFloat(v);
  if (n > 0) return '#4caf50';
  if (n < 0) return '#f44336';
  return 'inherit';
}

function px(p: string | null | undefined): string {
  if (p == null) return '—';
  const n = parseFloat(p);
  if (!isFinite(n) || n === 0) return '—';
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

/** Simple strategy ladder — not a market chart. */
function StrategyLadder({ trader }: { trader: TraderSummary }): React.ReactElement {
  const active = trader.hedgeLevels.find((h) => h.status === 'OPEN');
  const pending = trader.hedgeLevels.find((h) => h.status === 'PENDING' || h.status === 'ACTIVE');

  const rows: Array<{ label: string; value: string; state?: string; color?: string }> = [
    { label: 'Current Price', value: px(trader.markPrice), color: '#fff' },
  ];

  if (pending != null && pending.status !== 'OPEN') {
    rows.push({
      label: 'Pending Hedge Entry',
      value: px(pending.entryPrice),
      state: pending.status === 'ACTIVE' ? 'TRIGGERED/ACTIVE' : 'PENDING',
      color: '#ff9800',
    });
  }
  if (active != null) {
    rows.push({ label: 'Active Hedge Entry', value: px(active.entryPrice), state: 'FILLED/OPEN', color: '#ff9800' });
    rows.push({ label: 'Active Hedge SL', value: px(active.stopPrice), state: 'PENDING', color: '#f44336' });
    rows.push({ label: 'Active Hedge TP', value: px(active.tpPrice), state: 'PENDING', color: '#8bc34a' });
  }
  rows.push({ label: 'Main Short Entry', value: px(trader.entryPrice), state: trader.entryPrice ? 'FILLED' : '—', color: '#2196f3' });
  rows.push({ label: 'Main Short TP', value: px(trader.tpPrice), state: 'PENDING', color: '#4caf50' });
  rows.push({ label: 'Main Short SL', value: 'None', state: 'N/A', color: '#757575' });

  return (
    <Table size="small" sx={{ mt: 1 }}>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.label} sx={{ '& td': { border: 0, py: 0.3, px: 0 } }}>
            <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>{r.label}</TableCell>
            <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 600, color: r.color, fontSize: 12 }}>
              {r.value.startsWith('$') || r.value === 'None' || r.value === '—' ? r.value : `$${r.value}`}
            </TableCell>
            <TableCell align="right" sx={{ fontSize: 10, color: 'text.secondary', width: 90 }}>
              {r.state ?? ''}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function TraderCard({ trader }: { trader: TraderSummary }): React.ReactElement {
  const profit = parseFloat(trader.realizedPnl) + parseFloat(trader.unrealizedPnl);
  const profitStr = String(profit);
  const activeHedge = trader.hedgeLevels.find((h: HedgeLevelInfo) => h.status === 'OPEN');
  const pendingHedge = trader.hedgeLevels.find((h: HedgeLevelInfo) => h.status === 'PENDING' || h.status === 'ACTIVE');

  return (
    <Card sx={{ border: '1px solid', borderColor: 'divider', height: '100%' }}>
      <CardContent sx={{ p: 1.75, '&:last-child': { pb: 1.75 } }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
          <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="h6" fontWeight={700}>{trader.symbol.replace('USDT', '')}</Typography>
            <Chip label={trader.status} size="small" sx={{ height: 18, fontSize: 10 }} color={trader.status === 'ACTIVE' ? 'success' : 'default'} />
            <Chip label={`Hedge #${trader.hedgeLevel}`} size="small" sx={{ height: 18, fontSize: 10 }} variant="outlined" />
          </Box>
          <Typography fontWeight={700} sx={{ color: col(profitStr) }}>{pnl(profitStr)}</Typography>
        </Box>

        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.5, mb: 1 }}>
          <Typography variant="caption" color="text.secondary">Price <Box component="span" sx={{ color: '#fff', fontFamily: 'monospace' }}>${px(trader.markPrice)}</Box></Typography>
          <Typography variant="caption" color="text.secondary">Short PnL <Box component="span" sx={{ color: col(trader.shortUnrealizedPnl ?? trader.unrealizedPnl) }}>{pnl(trader.shortUnrealizedPnl ?? trader.unrealizedPnl)}</Box></Typography>
          <Typography variant="caption" color="text.secondary">Realized <Box component="span" sx={{ color: col(trader.realizedPnl) }}>{pnl(trader.realizedPnl)}</Box></Typography>
          <Typography variant="caption" color="text.secondary">Hedge losses <Box component="span">{trader.hedgeLosses ?? 0}</Box></Typography>
          <Typography variant="caption" color="text.secondary">Active hedge {activeHedge ? `L${activeHedge.level}` : '—'}</Typography>
          <Typography variant="caption" color="text.secondary">Pending hedge {pendingHedge && pendingHedge.status !== 'OPEN' ? `L${pendingHedge.level}` : '—'}</Typography>
          <Typography variant="caption" color="text.secondary">Open orders {trader.openOrders ?? 0}</Typography>
          <Typography variant="caption" color="text.secondary">Pending orders {trader.pendingOrders ?? 0}</Typography>
        </Box>

        <StrategyLadder trader={trader} />
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }): React.ReactElement {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" display="block">{label}</Typography>
      <Typography variant="subtitle1" fontWeight={700} sx={{ color: color ?? 'inherit', lineHeight: 1.2 }}>{value}</Typography>
    </Box>
  );
}

export function DashboardPage(): React.ReactElement {
  const { data: summary } = useStatsSummary();
  const { data: traders } = useActiveTraders();
  const pauseMutation = usePauseTraders();
  const resumeMutation = useResumeTraders();
  const stopMutation = useEmergencyStop();
  const dashWs = useSystemStore((s) => s.dashboardWsConnected);
  const lastWs = useSystemStore((s) => s.lastWsMessageAt);

  const list = traders ?? summary?.traders ?? [];
  const mode = summary?.tradingMode ?? '…';
  const gainers = summary?.topGainers ?? [];
  const wsFresh = dashWs && Date.now() - lastWs < 5000;

  return (
    <Box>
      <Box
        sx={{
          display: 'flex', flexWrap: 'wrap', gap: 2.5, alignItems: 'flex-end',
          p: 2, mb: 2, borderRadius: 2, bgcolor: 'background.paper',
          border: '1px solid', borderColor: 'divider',
        }}
      >
        <Metric label="Balance" value={money(summary?.balance ?? summary?.totalEquity)} />
        <Metric label="Equity" value={money(summary?.equity ?? summary?.totalEquity)} />
        <Metric label="Today's PnL" value={pnl(summary?.dailyPnl ?? '0')} color={col(summary?.dailyPnl ?? '0')} />
        <Metric label="Realized PnL" value={pnl(summary?.totalRealizedPnl ?? '0')} color={col(summary?.totalRealizedPnl ?? '0')} />
        <Metric label="Unrealized PnL" value={pnl(summary?.totalUnrealizedPnl ?? '0')} color={col(summary?.totalUnrealizedPnl ?? '0')} />
        <Metric label="Active Traders" value={`${summary?.activeTraders ?? list.length} / ${summary?.maxTraders ?? 0}`} />
        <Metric label="Open Positions" value={String(summary?.openPositions ?? 0)} />
        <Metric label="Used Margin" value={money(summary?.usedMargin)} />
        <Metric label="Available" value={money(summary?.availableMargin)} />

        <Chip label={mode} size="small" color={mode === 'LIVE' ? 'error' : 'info'} />
        <Chip label={summary?.botStatus ?? '…'} size="small" variant="outlined" />
        <Chip
          label={wsFresh ? 'Live' : dashWs ? 'WS idle' : 'Polling'}
          size="small"
          color={wsFresh ? 'success' : 'warning'}
          variant="outlined"
        />

        <Box sx={{ ml: 'auto', display: 'flex', gap: 1 }}>
          <Button size="small" variant="outlined" color="warning" onClick={() => pauseMutation.mutate()}>Pause</Button>
          <Button size="small" variant="outlined" color="success" onClick={() => resumeMutation.mutate()}>Resume</Button>
          <Button size="small" variant="contained" color="error" startIcon={<Warning />}
            onClick={() => { if (window.confirm('Close all positions?')) stopMutation.mutate(); }}>
            Stop
          </Button>
        </Box>
      </Box>

      <Grid container spacing={2}>
        <Grid item xs={12} md={gainers.length ? 9 : 12}>
          {list.length === 0 ? (
            <Box sx={{ py: 8, textAlign: 'center', color: 'text.secondary' }}>
              <Typography>No active traders</Typography>
            </Box>
          ) : (
            <Grid container spacing={2}>
              {list.map((t) => (
                <Grid item xs={12} md={6} xl={4} key={t.id}>
                  <TraderCard trader={t} />
                </Grid>
              ))}
            </Grid>
          )}
        </Grid>

        {gainers.length > 0 && (
          <Grid item xs={12} md={3}>
            <Card>
              <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1, opacity: 0.7 }}>TOP GAINERS</Typography>
                {gainers.slice(0, 12).map((g) => {
                  const pct = parseFloat(g.priceChangePercent);
                  return (
                    <Box key={g.symbol} sx={{ display: 'flex', justifyContent: 'space-between', py: 0.35 }}>
                      <Typography variant="caption" fontFamily="monospace" fontWeight={600}>
                        {g.symbol.replace('USDT', '')}
                      </Typography>
                      <Typography variant="caption" fontWeight={700} sx={{ color: pct >= 0 ? '#4caf50' : '#f44336' }}>
                        {pct >= 0 ? '+' : ''}{pct.toFixed(1)}%
                      </Typography>
                    </Box>
                  );
                })}
              </CardContent>
            </Card>
          </Grid>
        )}
      </Grid>
    </Box>
  );
}
