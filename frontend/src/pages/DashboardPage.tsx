import React, { useEffect, useState } from 'react';
import {
  Box, Grid, Card, CardContent, Typography, Chip, Button, Stack, Divider, LinearProgress,
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
import type { TraderSummary, PositionTimelineEntry, CapitalProgressView } from '../services/api';

function money(v: string | number | null | undefined, dp = 2): string {
  const n = parseFloat(String(v ?? '0'));
  if (!isFinite(n)) return '—';
  return `$${n.toFixed(dp)}`;
}

function pnl(v: string | number, dp = 2): string {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(dp)}`;
}

function col(v: string | number): string {
  const n = typeof v === 'number' ? v : parseFloat(v);
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

function formatDuration(ms: number): string {
  if (ms <= 0) return '0:00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }): React.ReactElement {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ fontSize: 11 }}>{label}</Typography>
      <Typography
        variant="body2"
        fontWeight={700}
        fontFamily="monospace"
        sx={{ color: color ?? 'inherit', fontSize: { xs: 12, sm: 13 }, wordBreak: 'break-word' }}
      >
        {value}
      </Typography>
    </Box>
  );
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }): React.ReactElement {
  return (
    <Card sx={{ height: '100%' }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Typography variant="caption" color="text.secondary">{label}</Typography>
        <Typography variant="h6" fontWeight={800} sx={{ color: color ?? 'inherit', fontSize: { xs: '1.1rem', sm: '1.25rem' } }}>
          {value}
        </Typography>
      </CardContent>
    </Card>
  );
}

/** Backend SSOT capital block — display only, never recompute amounts. */
function CapitalPanel({ capital }: { capital: CapitalProgressView }): React.ReactElement {
  const total = capital.totalSteps || capital.capitalSteps;
  const stepAlloc = capital.currentStepAllocation || capital.currentStepAmount;
  const progressPct = total > 0 ? (capital.currentStep / total) * 100 : 0;

  return (
    <Box>
      <Box sx={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 0.5,
        mb: 1.25,
        p: 1.25,
        borderRadius: 1.5,
        bgcolor: 'rgba(33, 150, 243, 0.06)',
        border: '1px solid rgba(33, 150, 243, 0.2)',
      }}>
        <Typography variant="caption" color="text.secondary">Trader Allocation</Typography>
        <Typography fontFamily="monospace" fontWeight={800} sx={{ fontSize: 16, textAlign: 'right' }}>
          {money(capital.traderAllocatedAmount)}
        </Typography>
        <Typography variant="caption" color="text.secondary">Current Step</Typography>
        <Typography fontFamily="monospace" fontWeight={700} sx={{ textAlign: 'right' }}>
          {capital.currentStep} / {total}
        </Typography>
        <Typography variant="caption" color="text.secondary">Current Step Allocation</Typography>
        <Typography fontFamily="monospace" fontWeight={800} sx={{ fontSize: 15, color: '#2196f3', textAlign: 'right' }}>
          {money(stepAlloc)}
        </Typography>
      </Box>

      <Typography variant="caption" color="text.secondary" fontWeight={700}>
        CAPITAL PROGRESS · {money(stepAlloc)} / {money(capital.traderAllocatedAmount)} allocated
      </Typography>
      <LinearProgress
        variant="determinate"
        value={progressPct}
        sx={{ mt: 0.5, mb: 1, height: 8, borderRadius: 1 }}
      />

      <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
        {capital.steps.map((s) => (
          <Box
            key={s.step}
            sx={{
              flex: '1 1 0',
              minWidth: 52,
              textAlign: 'center',
              px: 0.5,
              py: 0.6,
              borderRadius: 1,
              bgcolor: s.isCurrent ? 'rgba(33, 150, 243, 0.15)' : 'transparent',
              border: s.isCurrent ? '1px solid rgba(33, 150, 243, 0.5)' : '1px solid transparent',
            }}
          >
            <Typography sx={{ fontSize: 12, color: s.isCurrent || s.step < capital.currentStep ? '#2196f3' : 'text.secondary' }}>
              {s.isCurrent || s.step < capital.currentStep ? '●' : '○'}
            </Typography>
            <Typography variant="caption" display="block" fontWeight={s.isCurrent ? 700 : 500} sx={{ fontSize: 10 }}>
              S{s.step}{s.isCurrent ? ' ↑' : ''}
            </Typography>
            <Typography fontFamily="monospace" fontWeight={700} sx={{ fontSize: 11 }}>
              {money(s.amount)}
            </Typography>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

function PositionViz({ trader }: { trader: TraderSummary }): React.ReactElement {
  const pos = trader.currentPosition;
  if (pos == null) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        No open position
      </Typography>
    );
  }

  type Rung = { key: string; price: number; label: string; accent: string; isMark?: boolean; detail?: string };
  const mark = parseFloat(trader.markPrice) || 0;
  const rungs: Rung[] = [
    { key: 'tp', price: parseFloat(pos.tpPrice) || 0, label: 'Take Profit', accent: '#4caf50', detail: trader.distanceToTpPct != null ? `${trader.distanceToTpPct}%` : undefined },
    { key: 'entry', price: parseFloat(pos.entryPrice) || 0, label: `Entry (${pos.side})`, accent: '#2196f3' },
    { key: 'sl', price: parseFloat(pos.slPrice) || 0, label: 'Stop Loss', accent: '#f44336', detail: trader.distanceToSlPct != null ? `${trader.distanceToSlPct}%` : undefined },
    { key: 'mark', price: mark, label: '▸ Current Price', accent: '#fff', isMark: true },
  ];
  rungs.sort((a, b) => b.price - a.price);

  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="caption" color="text.secondary" fontWeight={700}>POSITION LEVELS</Typography>
      <Stack spacing={0.5} sx={{ mt: 0.75 }}>
        {rungs.map((r) => (
          <Box
            key={r.key}
            sx={{
              display: 'flex', alignItems: 'center', gap: 1,
              py: r.isMark ? 0.75 : 0.4, px: 1, borderRadius: 1,
              bgcolor: r.isMark ? 'rgba(255,255,255,0.08)' : 'transparent',
              border: r.isMark ? '1px solid rgba(255,255,255,0.25)' : '1px solid transparent',
              minHeight: 34,
            }}
          >
            <Box sx={{ width: 4, alignSelf: 'stretch', borderRadius: 1, bgcolor: r.accent, flexShrink: 0 }} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" fontWeight={r.isMark ? 700 : 600} sx={{ color: r.accent, fontSize: 13 }}>
                {r.label}
              </Typography>
              {r.detail != null && (
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: 11 }}>Dist {r.detail}</Typography>
              )}
            </Box>
            <Typography fontFamily="monospace" fontWeight={700} sx={{ color: r.accent, fontSize: 13 }}>
              ${px(String(r.price))}
            </Typography>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

function Timeline({ entries }: { entries: PositionTimelineEntry[] }): React.ReactElement {
  const list = [...entries].slice(-10).reverse();
  if (list.length === 0) {
    return <Typography variant="caption" color="text.secondary">No positions yet</Typography>;
  }
  return (
    <Stack spacing={0.75} sx={{ mt: 0.75 }}>
      {list.map((e) => (
        <Box
          key={`${e.number}-${e.openedAt}`}
          sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, alignItems: 'baseline' }}
        >
          <Typography variant="body2" fontWeight={700} fontFamily="monospace" sx={{ fontSize: 13 }}>
            #{e.number}{' '}
            <Box component="span" sx={{ color: e.side === 'SHORT' ? '#f44336' : '#4caf50' }}>{e.side}</Box>
            {' · '}Step {e.capitalStep ?? '—'}{' '}
            {e.stepAmount != null ? money(e.stepAmount) : ''}
          </Typography>
          <Typography variant="caption" fontWeight={700} sx={{
            color: e.closeReason === 'TP' ? '#4caf50' : e.closeReason === 'SL' ? '#f44336' : 'text.secondary',
          }}>
            {e.closeReason == null ? 'OPEN' : e.closeReason}
          </Typography>
        </Box>
      ))}
    </Stack>
  );
}

function TraderCard({ trader }: { trader: TraderSummary }): React.ReactElement {
  const pos = trader.currentPosition;
  const stats = trader.stats;
  const capital = trader.capital;
  const lifetimeHours = stats.startedAt && stats.endsAt
    ? (new Date(stats.endsAt).getTime() - new Date(stats.startedAt).getTime())
    : 24 * 3600_000;
  const progress = lifetimeHours > 0
    ? Math.min(100, ((lifetimeHours - stats.remainingMs) / lifetimeHours) * 100)
    : 0;

  const stepAlloc = capital?.currentStepAllocation || capital?.currentStepAmount;
  const positionNotional = capital?.positionNotional
    ?? pos?.positionNotional
    ?? null;

  return (
    <Card sx={{ border: '1px solid', borderColor: 'divider', height: '100%' }}>
      <CardContent sx={{ p: { xs: 1.5, sm: 2 } }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 1, mb: 1 }}>
          <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="h5" fontWeight={800} sx={{ fontSize: { xs: '1.25rem', sm: '1.5rem' } }}>
              {trader.symbol.replace('USDT', '')}
            </Typography>
            <Chip label={trader.status} size="small" color={trader.status === 'ACTIVE' ? 'success' : 'default'} />
            {pos != null && (
              <Chip
                label={pos.side}
                size="small"
                color={pos.side === 'SHORT' ? 'error' : 'success'}
                variant="outlined"
              />
            )}
          </Box>
          <Typography fontWeight={800} sx={{ color: col(trader.totalPnl), fontSize: 18 }}>
            {pnl(trader.totalPnl)}
          </Typography>
        </Box>

        <Box sx={{ mb: 1.5 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
            <Typography variant="caption" color="text.secondary">Time remaining</Typography>
            <Typography variant="caption" fontFamily="monospace" fontWeight={700}>
              {formatDuration(stats.remainingMs)}
            </Typography>
          </Box>
          <LinearProgress variant="determinate" value={progress} sx={{ height: 6, borderRadius: 1 }} />
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
            Runtime {formatDuration(stats.runtimeMs)} · ${px(trader.markPrice)}
          </Typography>
        </Box>

        {capital != null ? (
          <CapitalPanel capital={capital} />
        ) : (
          <Typography variant="caption" color="text.secondary">Capital data unavailable</Typography>
        )}

        <Divider sx={{ my: 1.5 }} />
        <Typography variant="caption" color="text.secondary" fontWeight={700}>CURRENT POSITION</Typography>
        {pos != null ? (
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.75, mt: 0.5, mb: 1 }}>
            <Stat label="Number" value={`#${pos.number}`} />
            <Stat label="Side" value={pos.side} />
            <Stat label="Step Allocation" value={money(pos.stepAmount || stepAlloc)} />
            <Stat label="Position Notional" value={money(pos.positionNotional || positionNotional)} color="#ff9800" />
            <Stat label="Leverage" value={`${trader.leverage}x`} />
            <Stat label="Qty" value={pos.quantity} />
            <Stat label="Entry" value={`$${px(pos.entryPrice)}`} />
            <Stat label="Mark" value={`$${px(trader.markPrice)}`} />
            <Stat label="Take Profit" value={`$${px(pos.tpPrice)}`} />
            <Stat label="Stop Loss" value={`$${px(pos.slPrice)}`} />
            <Stat label="PnL" value={pnl(pos.unrealizedPnl)} color={col(pos.unrealizedPnl)} />
            <Stat label="ROI" value={`${parseFloat(pos.roiPercent).toFixed(2)}%`} color={col(pos.roiPercent)} />
          </Box>
        ) : (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', my: 1 }}>Waiting for fill…</Typography>
        )}

        <PositionViz trader={trader} />

        <Divider sx={{ my: 1.5 }} />
        <Typography variant="caption" color="text.secondary" fontWeight={700}>STATISTICS</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.75, mt: 0.5 }}>
          <Stat label="Opened" value={String(stats.positionsOpened)} />
          <Stat label="Closed" value={String(stats.positionsClosed)} />
          <Stat label="Take Profits" value={String(stats.takeProfits)} />
          <Stat label="Stop Losses" value={String(stats.stopLosses)} />
          <Stat label="Step ↑ / ↓" value={`${stats.stepIncreases ?? 0} / ${stats.stepDecreases ?? 0}`} />
          <Stat label="Win Rate" value={`${stats.winRate}%`} />
          <Stat label="Realized" value={pnl(trader.realizedPnl)} color={col(trader.realizedPnl)} />
          <Stat label="Unrealized" value={pnl(trader.unrealizedPnl)} color={col(trader.unrealizedPnl)} />
        </Box>

        <Divider sx={{ my: 1.5 }} />
        <Typography variant="caption" color="text.secondary" fontWeight={700}>POSITION HISTORY</Typography>
        <Timeline entries={trader.timeline} />
      </CardContent>
    </Card>
  );
}

export function DashboardPage(): React.ReactElement {
  const { data: summary } = useStatsSummary();
  const { data: traders } = useActiveTraders();
  const pause = usePauseTraders();
  const resume = useResumeTraders();
  const emergency = useEmergencyStop();
  const wsOk = useSystemStore((s) => s.dashboardWsConnected);
  const [confirmStop, setConfirmStop] = useState(false);
  const botStatus = summary?.botStatus;

  const list = traders ?? [];

  useEffect(() => {
    if (!confirmStop) return;
    const t = setTimeout(() => setConfirmStop(false), 4000);
    return () => clearTimeout(t);
  }, [confirmStop]);

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h4" fontWeight={800}>Dashboard</Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          <Chip label={summary?.tradingMode ?? '—'} size="small" />
          <Chip label={wsOk ? 'Live Feed' : 'Reconnecting'} color={wsOk ? 'success' : 'warning'} size="small" />
          <Chip label={botStatus ?? '—'} size="small" variant="outlined" />
          <Button size="small" variant="outlined" onClick={() => pause.mutate()} disabled={pause.isPending}>Pause</Button>
          <Button size="small" variant="outlined" color="success" onClick={() => resume.mutate()} disabled={resume.isPending}>Resume</Button>
          <Button
            size="small"
            variant="contained"
            color="error"
            startIcon={<Warning />}
            onClick={() => {
              if (!confirmStop) { setConfirmStop(true); return; }
              emergency.mutate();
              setConfirmStop(false);
            }}
          >
            {confirmStop ? 'Confirm Stop?' : 'Emergency Stop'}
          </Button>
        </Stack>
      </Box>

      <Grid container spacing={1.5} mb={2}>
        <Grid item xs={6} sm={4} md={2}><Metric label="Balance" value={money(summary?.balance)} /></Grid>
        <Grid item xs={6} sm={4} md={2}><Metric label="Equity" value={money(summary?.equity)} /></Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Metric label="Unrealized" value={pnl(summary?.totalUnrealizedPnl ?? '0')} color={col(summary?.totalUnrealizedPnl ?? '0')} />
        </Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Metric label="Realized" value={pnl(summary?.totalRealizedPnl ?? '0')} color={col(summary?.totalRealizedPnl ?? '0')} />
        </Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Metric label="Today" value={pnl(summary?.dailyPnl ?? '0')} color={col(summary?.dailyPnl ?? '0')} />
        </Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Metric label="Traders / Positions" value={`${summary?.activeTraders ?? 0} / ${summary?.openPositions ?? 0}`} />
        </Grid>
      </Grid>

      {list.length === 0 ? (
        <Card><CardContent sx={{ textAlign: 'center', py: 6 }}>
          <Typography color="text.secondary">No active traders — scanning top gainers…</Typography>
        </CardContent></Card>
      ) : (
        <Grid container spacing={2}>
          {list.map((t) => (
            <Grid item xs={12} lg={6} key={t.id}>
              <TraderCard trader={t} />
            </Grid>
          ))}
        </Grid>
      )}
    </Box>
  );
}
