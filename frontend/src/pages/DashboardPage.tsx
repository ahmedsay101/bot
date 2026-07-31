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

function pnl(v: string, dp = 4): string {
  const n = parseFloat(v);
  if (!isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(dp)}`;
}

function pnlColor(v: string): string {
  const n = parseFloat(v);
  if (n > 0) return '#4caf50';
  if (n < 0) return '#f44336';
  return 'text.secondary';
}

function priceDp(p: number): number {
  if (p >= 100) return 2;
  if (p >= 1) return 4;
  return 6;
}

function LadderRows({ trader }: { trader: TraderSummary }): React.ReactElement {
  const mark = parseFloat(trader.markPrice);
  const rows: Array<{ label: string; price: string; tone?: string }> = [];

  rows.push({
    label: 'Current',
    price: isFinite(mark) && mark > 0 ? mark.toFixed(priceDp(mark)) : '—',
    tone: '#fff',
  });
  rows.push({ label: 'Main Short', price: trader.entryPrice != null ? parseFloat(trader.entryPrice).toFixed(priceDp(parseFloat(trader.entryPrice))) : '—', tone: '#2196f3' });
  rows.push({ label: 'Short TP', price: trader.tpPrice != null ? parseFloat(trader.tpPrice).toFixed(priceDp(parseFloat(trader.tpPrice))) : '—', tone: '#4caf50' });

  const live = trader.hedgeLevels.filter((h) => h.status === 'OPEN' || h.status === 'ACTIVE' || h.status === 'PENDING');
  for (const h of live) {
    const open = h.status === 'OPEN';
    rows.push({
      label: open ? `Hedge L${h.level}` : `Pending L${h.level}`,
      price: parseFloat(h.entryPrice).toFixed(priceDp(parseFloat(h.entryPrice) || 1)),
      tone: '#ff9800',
    });
    rows.push({
      label: `Hedge SL L${h.level}`,
      price: parseFloat(h.stopPrice).toFixed(priceDp(parseFloat(h.stopPrice) || 1)),
      tone: '#f44336',
    });
    rows.push({
      label: `Hedge TP L${h.level}`,
      price: parseFloat(h.tpPrice).toFixed(priceDp(parseFloat(h.tpPrice) || 1)),
      tone: '#8bc34a',
    });
  }

  return (
    <Table size="small" sx={{ mt: 1 }}>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.label} sx={{ '& td': { border: 0, py: 0.35, px: 0 } }}>
            <TableCell sx={{ color: 'text.secondary', width: '45%' }}>{r.label}</TableCell>
            <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 600, color: r.tone }}>
              {r.price === '—' ? '—' : `$${r.price}`}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function TraderCard({ trader }: { trader: TraderSummary }): React.ReactElement {
  const total = String(parseFloat(trader.realizedPnl) + parseFloat(trader.unrealizedPnl));
  const hedge = trader.hedgeLevels.find((h: HedgeLevelInfo) => h.status === 'OPEN' || h.status === 'ACTIVE' || h.status === 'PENDING');

  return (
    <Card sx={{ border: '1px solid', borderColor: 'divider', height: '100%' }}>
      <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
          <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center' }}>
            <Typography variant="h6" fontWeight={700}>{trader.symbol.replace('USDT', '')}</Typography>
            <Chip label={trader.status} size="small" sx={{ height: 20, fontSize: 10 }} color={trader.status === 'ACTIVE' ? 'success' : 'default'} />
            {hedge != null && <Chip label={`L${hedge.level}`} size="small" sx={{ height: 20, fontSize: 10 }} color="warning" variant="outlined" />}
          </Box>
          <Typography fontWeight={700} sx={{ color: pnlColor(total) }}>{pnl(total, 2)}</Typography>
        </Box>
        <LadderRows trader={trader} />
      </CardContent>
    </Card>
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
  const equity = summary?.totalEquity ?? '0';
  const totalPnl = summary?.totalPnl
    ?? String(parseFloat(summary?.totalRealizedPnl ?? '0') + parseFloat(summary?.totalUnrealizedPnl ?? '0'));
  const active = summary?.activeTraders ?? list.length;
  const max = summary?.maxTraders ?? 0;
  const mode = summary?.tradingMode ?? '…';
  const gainers = summary?.topGainers ?? [];
  const wsFresh = dashWs && Date.now() - lastWs < 5000;

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 3,
          alignItems: 'center',
          p: 2,
          mb: 2,
          borderRadius: 2,
          bgcolor: 'background.paper',
          border: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Box>
          <Typography variant="caption" color="text.secondary">Equity</Typography>
          <Typography variant="h5" fontWeight={700}>{money(equity, 2)}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">Total PnL</Typography>
          <Typography variant="h5" fontWeight={700} sx={{ color: pnlColor(totalPnl) }}>{pnl(totalPnl, 2)}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">Active Traders</Typography>
          <Typography variant="h5" fontWeight={700} sx={{ color: active > max && max > 0 ? '#f44336' : 'inherit' }}>
            {active} / {max}
          </Typography>
        </Box>

        <Chip label={mode} size="small" color={mode === 'LIVE' ? 'error' : 'info'} />
        <Chip
          label={wsFresh ? 'Live feed' : dashWs ? 'WS idle' : 'WS down · polling'}
          size="small"
          color={wsFresh ? 'success' : dashWs ? 'warning' : 'error'}
          variant="outlined"
        />

        <Box sx={{ ml: 'auto', display: 'flex', gap: 1 }}>
          <Button size="small" variant="outlined" color="warning" onClick={() => pauseMutation.mutate()}>Pause</Button>
          <Button size="small" variant="outlined" color="success" onClick={() => resumeMutation.mutate()}>Resume</Button>
          <Button
            size="small"
            variant="contained"
            color="error"
            startIcon={<Warning />}
            onClick={() => { if (window.confirm('Close all positions?')) stopMutation.mutate(); }}
          >
            Stop
          </Button>
        </Box>
      </Box>

      <Grid container spacing={2}>
        <Grid item xs={12} md={gainers.length ? 9 : 12}>
          {list.length === 0 ? (
            <Box sx={{ py: 8, textAlign: 'center', color: 'text.secondary' }}>
              <Typography>No active traders — scanning gainers…</Typography>
            </Box>
          ) : (
            <Grid container spacing={2}>
              {list.map((t) => (
                <Grid item xs={12} sm={6} lg={4} key={t.id}>
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
                    <Box key={g.symbol} sx={{ display: 'flex', justifyContent: 'space-between', py: 0.4 }}>
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
