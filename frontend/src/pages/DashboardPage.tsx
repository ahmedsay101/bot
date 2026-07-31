import React from 'react';
import {
  Box, Grid, Card, CardContent, Typography, Chip, Button, Divider,
} from '@mui/material';
import { Warning } from '@mui/icons-material';
import {
  useGlobalStats,
  useStatsSummary,
  useActiveTraders,
  usePauseTraders,
  useResumeTraders,
  useEmergencyStop,
} from '../hooks/useQueries';
import type { TraderSummary, HedgeLevelInfo } from '../services/api';

function fmt(v: string | number | null | undefined, dp = 4): string {
  const n = parseFloat(String(v ?? '0'));
  if (!isFinite(n) || isNaN(n)) return '—';
  return `$${n.toFixed(dp)}`;
}

function pnlCol(v: string): string {
  const n = parseFloat(v);
  if (n > 0) return '#4caf50';
  if (n < 0) return '#f44336';
  return '#757575';
}

function pnlStr(v: string, dp = 4): string {
  const n = parseFloat(v);
  if (!isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(dp)}`;
}

interface Level {
  price: number;
  label: string;
  color: string;
  dashed?: boolean;
  isMark?: boolean;
}

/** Ladder: current price, main short, short TP, active hedge, hedge SL/TP, pending levels. */
function PriceLadder({ trader }: { trader: TraderSummary }): React.ReactElement | null {
  const mark = parseFloat(trader.markPrice);
  const entry = trader.entryPrice != null ? parseFloat(trader.entryPrice) : null;
  const tp = trader.tpPrice != null ? parseFloat(trader.tpPrice) : null;

  if (!isFinite(mark) || mark === 0) {
    return (
      <Box sx={{ py: 2, textAlign: 'center' }}>
        <Typography variant="caption" color="text.secondary">Awaiting price feed…</Typography>
      </Box>
    );
  }

  const levels: Level[] = [];

  if (tp != null && tp > 0) levels.push({ price: tp, label: 'Short TP', color: '#4caf50' });
  if (entry != null && entry > 0) levels.push({ price: entry, label: 'Main Short', color: '#2196f3' });

  for (const h of trader.hedgeLevels) {
    if (h.status === 'CANCELED' || h.status === 'HIT_TP' || h.status === 'HIT_SL') continue;
    const isOpen = h.status === 'OPEN';
    const isPending = h.status === 'PENDING' || h.status === 'ACTIVE';
    const prefix = isOpen ? 'Active' : 'Pending';

    if (parseFloat(h.tpPrice) > 0) {
      levels.push({
        price: parseFloat(h.tpPrice),
        label: `L${h.level} Hedge TP`,
        color: '#8bc34a',
        dashed: isPending,
      });
    }
    if (parseFloat(h.entryPrice) > 0) {
      levels.push({
        price: parseFloat(h.entryPrice),
        label: `L${h.level} ${prefix} Hedge`,
        color: '#ff9800',
        dashed: isPending,
      });
    }
    if (parseFloat(h.stopPrice) > 0) {
      levels.push({
        price: parseFloat(h.stopPrice),
        label: `L${h.level} Hedge SL`,
        color: '#f44336',
        dashed: isPending,
      });
    }
  }

  levels.push({ price: mark, label: '◀ Current', color: '#ffffff', isMark: true });

  const prices = levels.map((l) => l.price).filter((p) => p > 0 && isFinite(p));
  if (prices.length === 0) return null;

  const hi = Math.max(...prices) * 1.018;
  const lo = Math.min(...prices) * 0.982;
  const rng = hi - lo || 1;
  const pct = (p: number): number => ((hi - p) / rng) * 100;

  const sorted = [...levels].sort((a, b) => b.price - a.price);
  const HEIGHT = Math.max(180, sorted.length * 34);
  const mag = Math.floor(Math.log10(mark));
  const dp = Math.max(2, 5 - mag);

  return (
    <Box sx={{ position: 'relative', height: HEIGHT, my: 1 }}>
      <Box sx={{ position: 'absolute', left: 98, top: 0, bottom: 0, width: 1, bgcolor: 'rgba(255,255,255,0.06)' }} />
      {sorted.map((lvl, i) => (
        <Box
          key={`${lvl.label}-${i}`}
          sx={{
            position: 'absolute',
            top: `${pct(lvl.price)}%`,
            left: 0,
            right: 0,
            transform: 'translateY(-50%)',
            display: 'flex',
            alignItems: 'center',
            zIndex: lvl.isMark ? 2 : 1,
          }}
        >
          <Typography
            sx={{
              width: 92,
              textAlign: 'right',
              pr: 0.75,
              fontSize: lvl.isMark ? 12 : 11,
              fontFamily: 'monospace',
              fontWeight: lvl.isMark ? 700 : 400,
              color: lvl.color,
              whiteSpace: 'nowrap',
            }}
          >
            ${lvl.price.toFixed(dp)}
          </Typography>
          <Box
            sx={{
              width: lvl.isMark ? 10 : 7,
              height: lvl.isMark ? 10 : 7,
              borderRadius: '50%',
              bgcolor: lvl.color,
              flexShrink: 0,
              boxShadow: lvl.isMark ? `0 0 8px ${lvl.color}` : 'none',
              zIndex: 2,
            }}
          />
          <Box
            sx={{
              flex: 1,
              height: lvl.isMark ? 2 : 1,
              bgcolor: lvl.color,
              opacity: lvl.isMark ? 0.5 : 0.25,
              mx: 0.5,
              borderStyle: lvl.dashed ? 'dashed' : 'solid',
            }}
          />
          <Typography
            sx={{
              fontSize: 10,
              color: lvl.color,
              whiteSpace: 'nowrap',
              pl: 0.5,
              fontWeight: lvl.isMark ? 700 : 400,
            }}
          >
            {lvl.label}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

function TraderCard({ trader }: { trader: TraderSummary }): React.ReactElement {
  const isActive = trader.status === 'ACTIVE';
  const activeHedge = trader.hedgeLevels.find((h: HedgeLevelInfo) => h.status === 'OPEN' || h.status === 'ACTIVE');

  return (
    <Card
      sx={{
        border: '1px solid',
        borderColor: isActive ? 'rgba(33,150,243,0.25)' : 'divider',
        height: '100%',
      }}
    >
      <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Typography variant="h6" fontWeight={700}>{trader.symbol}</Typography>
            <Chip
              label={trader.status}
              size="small"
              sx={{
                height: 20,
                fontSize: 10,
                bgcolor: isActive ? 'rgba(76,175,80,0.15)' : 'rgba(255,255,255,0.07)',
                color: isActive ? '#4caf50' : 'text.secondary',
              }}
            />
            {activeHedge != null && (
              <Chip
                label={`L${activeHedge.level}`}
                size="small"
                sx={{ height: 20, fontSize: 10, bgcolor: 'rgba(255,152,0,0.15)', color: '#ff9800' }}
              />
            )}
          </Box>
          <Box sx={{ textAlign: 'right' }}>
            <Typography variant="caption" color="text.secondary" display="block">PnL</Typography>
            <Typography variant="body2" fontWeight={700} sx={{ color: pnlCol(trader.unrealizedPnl) }}>
              {pnlStr(trader.unrealizedPnl, 4)}
            </Typography>
          </Box>
        </Box>

        <Divider sx={{ mb: 1, opacity: 0.15 }} />
        <PriceLadder trader={trader} />
        <Divider sx={{ mt: 1.5, mb: 1, opacity: 0.15 }} />

        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
          <Box>
            <Typography variant="caption" color="text.secondary">Realized</Typography>
            <Typography variant="body2" fontWeight={600} sx={{ color: pnlCol(trader.realizedPnl) }}>
              {pnlStr(trader.realizedPnl, 4)}
            </Typography>
          </Box>
          <Box sx={{ textAlign: 'center' }}>
            <Typography variant="caption" color="text.secondary">Main Short</Typography>
            <Typography variant="body2">{fmt(trader.entryPrice)}</Typography>
          </Box>
          <Box sx={{ textAlign: 'right' }}>
            <Typography variant="caption" color="text.secondary">Short TP</Typography>
            <Typography variant="body2" sx={{ color: '#4caf50' }}>{fmt(trader.tpPrice)}</Typography>
          </Box>
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

  const equity = summary?.totalEquity ?? stats?.totalEquity;
  const totalPnl = summary?.totalPnl
    ?? stats?.totalPnl
    ?? String(
      parseFloat(summary?.totalRealizedPnl ?? stats?.totalRealizedPnl ?? '0')
      + parseFloat(summary?.totalUnrealizedPnl ?? stats?.totalUnrealizedPnl ?? '0'),
    );
  const activeCount = summary?.activeTraders ?? stats?.activeTraders ?? traders?.length ?? 0;
  const maxTraders = summary?.maxTraders ?? stats?.maxTraders ?? 0;
  const mode = summary?.tradingMode ?? stats?.tradingMode ?? '…';
  const isLive = mode === 'LIVE';
  const gainers = summary?.topGainers ?? [];

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 3,
          p: 2,
          mb: 2,
          borderRadius: 2,
          bgcolor: 'background.paper',
          border: '1px solid',
          borderColor: 'divider',
        }}
      >
        {[
          { label: 'Equity', value: fmt(equity, 2) },
          { label: 'Total PnL', value: pnlStr(totalPnl, 2), color: pnlCol(totalPnl) },
          { label: 'Active Traders', value: `${activeCount} / ${maxTraders}` },
        ].map((item) => (
          <Box key={item.label}>
            <Typography variant="caption" color="text.secondary" display="block">{item.label}</Typography>
            <Typography variant="h6" fontWeight={700} sx={{ color: item.color ?? 'text.primary' }}>
              {item.value}
            </Typography>
          </Box>
        ))}

        <Chip label={mode} size="small" color={isLive ? 'error' : 'info'} />

        <Box sx={{ ml: 'auto', display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button size="small" variant="outlined" color="warning" onClick={() => pauseMutation.mutate()} disabled={pauseMutation.isPending}>
            Pause
          </Button>
          <Button size="small" variant="outlined" color="success" onClick={() => resumeMutation.mutate()} disabled={resumeMutation.isPending}>
            Resume
          </Button>
          <Button
            size="small"
            variant="contained"
            color="error"
            startIcon={<Warning />}
            onClick={() => {
              if (window.confirm('EMERGENCY STOP — close all positions?')) stopMutation.mutate();
            }}
          >
            Emergency Stop
          </Button>
        </Box>
      </Box>

      <Grid container spacing={2}>
        <Grid item xs={12} md={gainers.length > 0 ? 9 : 12}>
          {traders == null || traders.length === 0 ? (
            <Box sx={{ textAlign: 'center', py: 10, color: 'text.secondary' }}>
              <Typography variant="h6" gutterBottom>No active traders</Typography>
              <Typography variant="body2">Scanning top gainers…</Typography>
            </Box>
          ) : (
            <Grid container spacing={2}>
              {traders.map((t) => (
                <Grid item xs={12} lg={6} key={t.id}>
                  <TraderCard trader={t} />
                </Grid>
              ))}
            </Grid>
          )}
        </Grid>

        {gainers.length > 0 && (
          <Grid item xs={12} md={3}>
            <Card sx={{ position: 'sticky', top: 16 }}>
              <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1, opacity: 0.7 }}>
                  TOP GAINERS
                </Typography>
                {gainers.slice(0, 15).map((g) => {
                  const pct = parseFloat(g.priceChangePercent);
                  const color = pct >= 0 ? '#4caf50' : '#f44336';
                  return (
                    <Box
                      key={g.symbol}
                      sx={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        py: 0.5,
                        borderBottom: '1px solid',
                        borderColor: 'divider',
                        '&:last-child': { borderBottom: 'none' },
                      }}
                    >
                      <Typography variant="caption" fontFamily="monospace" fontWeight={600}>
                        {g.symbol.replace('USDT', '')}
                      </Typography>
                      <Typography variant="caption" sx={{ color, fontWeight: 700 }}>
                        {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
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
