import React, { useEffect, useMemo, useState } from 'react';
import {
  Box, Grid, Typography, Chip, Button, Stack, LinearProgress, Divider,
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
import type { TraderSummary, GridTraderView } from '../services/api';

const LONG = '#3dd68c';
const SHORT = '#ff6b6b';
const MARK = '#f0c14b';
const START = '#8ab4ff';
const PANEL = 'rgba(18, 28, 42, 0.85)';
const BORDER = 'rgba(120, 160, 200, 0.18)';

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
  if (n > 0) return LONG;
  if (n < 0) return SHORT;
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
      <Typography variant="caption" color="text.secondary" display="block" sx={{ fontSize: 10, letterSpacing: 0.4 }}>
        {label}
      </Typography>
      <Typography
        fontFamily="monospace"
        fontWeight={700}
        sx={{ color: color ?? 'inherit', fontSize: { xs: 12, sm: 13 }, wordBreak: 'break-word' }}
      >
        {value}
      </Typography>
    </Box>
  );
}

function Kpi({
  label, value, color, hint,
}: { label: string; value: string; color?: string; hint?: string }): React.ReactElement {
  return (
    <Box
      sx={{
        p: 1.5,
        borderRadius: 2,
        bgcolor: PANEL,
        border: `1px solid ${BORDER}`,
        height: '100%',
        backgroundImage: 'linear-gradient(160deg, rgba(45, 212, 191, 0.06), transparent 55%)',
      }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase' }}>
        {label}
      </Typography>
      <Typography fontWeight={800} sx={{ color: color ?? 'inherit', fontSize: { xs: '1.05rem', sm: '1.2rem' }, mt: 0.25 }}>
        {value}
      </Typography>
      {hint != null && (
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>{hint}</Typography>
      )}
    </Box>
  );
}

function BalanceRangeBar({
  low, high, current,
}: { low?: string; high?: string; current?: string }): React.ReactElement | null {
  const lo = parseFloat(String(low ?? ''));
  const hi = parseFloat(String(high ?? ''));
  const cur = parseFloat(String(current ?? ''));
  if (![lo, hi, cur].every((n) => isFinite(n))) return null;
  const span = hi - lo;
  const pct = span <= 0 ? 50 : Math.min(100, Math.max(0, ((cur - lo) / span) * 100));
  return (
    <Box
      sx={{
        mb: 2, p: 1.5, borderRadius: 2, bgcolor: PANEL, border: `1px solid ${BORDER}`,
      }}
    >
      <Typography variant="caption" color="text.secondary" fontWeight={700} sx={{ letterSpacing: 0.5 }}>
        24H BALANCE RANGE
      </Typography>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.75, mb: 1 }}>
        <Typography variant="caption" fontFamily="monospace">{money(lo)}</Typography>
        <Typography variant="caption" fontFamily="monospace" fontWeight={800}>{money(cur)}</Typography>
        <Typography variant="caption" fontFamily="monospace">{money(hi)}</Typography>
      </Box>
      <Box sx={{ position: 'relative', height: 6, borderRadius: 99, bgcolor: 'rgba(255,255,255,0.08)' }}>
        <Box
          sx={{
            position: 'absolute',
            left: `calc(${pct}% - 7px)`,
            top: -4,
            width: 14,
            height: 14,
            borderRadius: '50%',
            bgcolor: '#2dd4bf',
            boxShadow: '0 0 0 3px rgba(45, 212, 191, 0.25)',
          }}
        />
      </Box>
    </Box>
  );
}

type LadderRow =
  | { kind: 'level'; price: number; level: GridTraderView['levels'][0] }
  | { kind: 'start'; price: number }
  | { kind: 'mark'; price: number };

/** Sort ladder by price descending so CURRENT PRICE sits between the correct levels. */
function buildPriceLadder(grid: GridTraderView, markPrice: string): LadderRow[] {
  const mark = parseFloat(markPrice) || 0;
  const start = parseFloat(grid.startPrice) || 0;
  const rows: LadderRow[] = [
    ...grid.levels.map((level) => ({
      kind: 'level' as const,
      price: parseFloat(level.triggerPrice) || 0,
      level,
    })),
    { kind: 'start', price: start },
    { kind: 'mark', price: mark },
  ];
  const kindRank = (k: LadderRow['kind']): number => {
    if (k === 'mark') return 0;
    if (k === 'start') return 1;
    return 2;
  };
  return rows.sort((a, b) => {
    if (b.price !== a.price) return b.price - a.price;
    return kindRank(a.kind) - kindRank(b.kind);
  });
}

function statusLabel(s: string): string {
  if (s === 'TRIGGERED') return 'LIMIT LIVE';
  if (s === 'PENDING') return 'PENDING';
  if (s === 'ACTIVE') return 'ACTIVE';
  if (s === 'FILLED') return 'FILLED';
  if (s === 'TP_HIT') return 'TP HIT';
  if (s === 'SL_HIT') return 'SL HIT';
  if (s === 'CANCELLED' || s === 'CANCELED') return 'CANCELLED';
  return s;
}

function GridLadder({ grid, markPrice }: { grid: GridTraderView; markPrice: string }): React.ReactElement {
  const rows = useMemo(() => buildPriceLadder(grid, markPrice), [grid, markPrice]);
  const mark = parseFloat(markPrice) || 0;

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 1 }}>
        <Typography variant="caption" fontWeight={800} sx={{ letterSpacing: 0.8, color: 'text.secondary' }}>
          PRICE LADDER
        </Typography>
        <Typography variant="caption" color="text.secondary">
          LONG {grid.longFilled}/{grid.levelsPerSide} · SHORT {grid.shortFilled}/{grid.levelsPerSide}
        </Typography>
      </Box>
      <Stack
        spacing={0.4}
        sx={{
          maxHeight: { xs: 420, md: 560 },
          overflow: 'auto',
          pr: 0.5,
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {rows.map((row, idx) => {
          if (row.kind === 'mark') {
            return (
              <Box
                key={`mark-${idx}`}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  py: 0.85,
                  px: 1.25,
                  borderRadius: 1.5,
                  bgcolor: 'rgba(240, 193, 75, 0.14)',
                  border: `1px solid ${MARK}`,
                  boxShadow: '0 0 18px rgba(240, 193, 75, 0.12)',
                }}
              >
                <Typography variant="body2" fontWeight={900} sx={{ color: MARK, letterSpacing: 0.6 }}>
                  ▸ MARK
                </Typography>
                <Typography fontFamily="monospace" fontWeight={900} sx={{ color: MARK }}>
                  ${px(String(mark))}
                </Typography>
              </Box>
            );
          }
          if (row.kind === 'start') {
            return (
              <Box
                key={`start-${idx}`}
                sx={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  py: 0.9,
                  px: 1.25,
                  my: 0.35,
                  borderRadius: 1.5,
                  border: `1px dashed ${START}`,
                  bgcolor: 'rgba(138, 180, 255, 0.08)',
                }}
              >
                <Typography variant="body2" fontWeight={800} sx={{ color: START }}>START</Typography>
                <Typography fontFamily="monospace" fontWeight={800} sx={{ color: START }}>
                  ${px(String(row.price))}
                </Typography>
              </Box>
            );
          }

          const l = row.level;
          const accent = l.direction === 'LONG' ? LONG : SHORT;
          const active = l.status === 'ACTIVE';
          const done = l.status === 'TP_HIT' || l.status === 'SL_HIT';
          return (
            <Box
              key={`${l.direction}-${l.level}`}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                py: 0.55,
                px: 1,
                borderRadius: 1.25,
                bgcolor: active ? `${accent}22` : done ? 'rgba(255,255,255,0.03)' : 'transparent',
                border: '1px solid',
                borderColor: active ? accent : done ? 'rgba(255,255,255,0.08)' : BORDER,
                opacity: done || l.status === 'CANCELLED' || l.status === 'CANCELED' ? 0.55 : 1,
              }}
            >
              <Box sx={{ width: 3, alignSelf: 'stretch', borderRadius: 99, bgcolor: accent, flexShrink: 0 }} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography fontFamily="monospace" fontWeight={800} sx={{ fontSize: 12 }}>
                  {l.direction} #{l.level}
                  {l.weight != null ? ` · w${l.weight}` : ''}
                </Typography>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ fontSize: 10 }}>
                  Margin {money(l.allocatedMargin)}
                  {' · '}
                  {l.leverage ?? '—'}x
                  {' · '}
                  Notional {money(l.notional)}
                  {' · '}
                  {statusLabel(l.status)}
                  {l.entryPrice != null ? ` · entry $${px(l.entryPrice)}` : ''}
                  {l.tpPrice != null ? ` · TP $${px(l.tpPrice)}` : ''}
                  {l.unrealizedPnl != null ? ` · PnL ${pnl(l.unrealizedPnl)}` : ''}
                </Typography>
              </Box>
              <Typography fontFamily="monospace" fontWeight={700} sx={{ fontSize: 12, color: accent }}>
                ${px(l.triggerPrice)}
              </Typography>
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}

function FillMeter({
  label, filled, total, color,
}: { label: string; filled: number; total: number; color: string }): React.ReactElement {
  const pct = total > 0 ? Math.min(100, (filled / total) * 100) : 0;
  return (
    <Box sx={{ mb: 1.25 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.4 }}>
        <Typography variant="caption" fontWeight={700} sx={{ color }}>{label}</Typography>
        <Typography variant="caption" fontFamily="monospace" fontWeight={800}>
          {filled}/{total}
        </Typography>
      </Box>
      <LinearProgress
        variant="determinate"
        value={pct}
        sx={{
          height: 8,
          borderRadius: 99,
          bgcolor: 'rgba(255,255,255,0.06)',
          '& .MuiLinearProgress-bar': { bgcolor: color, borderRadius: 99 },
        }}
      />
    </Box>
  );
}

function GridTraderCard({
  trader,
  gainers,
}: {
  trader: TraderSummary;
  gainers?: Array<{ symbol: string; priceChangePercent: string }>;
}): React.ReactElement {
  const grid = trader.grid;
  const stats = trader.stats;
  const gainerIdx = gainers?.findIndex((g) => g.symbol === trader.symbol) ?? -1;
  const gainer = gainerIdx >= 0 ? gainers![gainerIdx] : null;

  if (grid == null) {
    return (
      <Box sx={{ p: 2, borderRadius: 2, bgcolor: PANEL, border: `1px solid ${BORDER}` }}>
        <Typography fontWeight={800}>{trader.symbol.replace('USDT', '')}</Typography>
        <Typography color="text.secondary" variant="body2">Waiting for grid snapshot…</Typography>
      </Box>
    );
  }

  const lifetimeMs = stats.startedAt && stats.endsAt
    ? (new Date(stats.endsAt).getTime() - new Date(stats.startedAt).getTime())
    : 12 * 3600_000;
  const lifeProgress = lifetimeMs > 0
    ? Math.min(100, ((lifetimeMs - stats.remainingMs) / lifetimeMs) * 100)
    : 0;
  const tpTarget = parseFloat(grid.takeProfitPercent || '10') || 10;
  const tpNow = parseFloat(grid.profitPercent) || 0;
  const tpProgress = Math.min(100, Math.max(0, (tpNow / tpTarget) * 100));
  const vsStart = (() => {
    const start = parseFloat(grid.startPrice) || 0;
    const mark = parseFloat(trader.markPrice) || 0;
    if (start <= 0 || mark <= 0) return null;
    return ((mark - start) / start) * 100;
  })();

  return (
    <Box
      sx={{
        height: '100%',
        borderRadius: 2.5,
        bgcolor: PANEL,
        border: `1px solid ${BORDER}`,
        overflow: 'hidden',
        backgroundImage:
          'radial-gradient(ellipse at top right, rgba(45,212,191,0.08), transparent 45%), linear-gradient(180deg, rgba(255,255,255,0.02), transparent)',
      }}
    >
      <Box sx={{ p: { xs: 1.5, sm: 2 } }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 1, mb: 1.5 }}>
          <Box sx={{ minWidth: 0 }}>
            <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center', flexWrap: 'wrap', mb: 0.5 }}>
              <Typography variant="h5" fontWeight={900} sx={{ fontSize: { xs: '1.35rem', sm: '1.6rem' }, letterSpacing: -0.5 }}>
                {trader.symbol.replace('USDT', '')}
              </Typography>
              <Chip label={trader.status} size="small" color={trader.status === 'ACTIVE' ? 'success' : 'default'} sx={{ height: 22 }} />
              {gainer != null && (
                <Chip
                  label={`#${gainerIdx + 1} · ${parseFloat(gainer.priceChangePercent).toFixed(2)}%`}
                  size="small"
                  variant="outlined"
                  sx={{ height: 22 }}
                />
              )}
            </Box>
            <Typography variant="caption" color="text.secondary">
              Max {grid.maxOpenPositions ?? 2} positions · {grid.levelsPerSide}×{grid.levelsPerSide} · {grid.distancePercent}% · {trader.leverage}x
            </Typography>
          </Box>
          <Box sx={{ textAlign: 'right' }}>
            <Typography fontWeight={900} sx={{ color: col(grid.profitPercent), fontSize: 22, lineHeight: 1.1 }}>
              {tpNow >= 0 ? '+' : ''}{tpNow.toFixed(2)}%
            </Typography>
            <Typography variant="caption" color="text.secondary">trader PnL %</Typography>
          </Box>
        </Box>

        <Grid container spacing={1.5}>
          <Grid item xs={12} md={7}>
            {(() => {
              const positions = trader.currentPositions?.length
                ? trader.currentPositions
                : trader.currentPosition != null
                  ? [trader.currentPosition]
                  : [];
              const maxOpen = grid.maxOpenPositions ?? 2;
              if (positions.length === 0) return null;
              return (
                <Box sx={{ mb: 1.5 }}>
                  <Typography variant="caption" fontWeight={800} sx={{ letterSpacing: 0.8, color: 'text.secondary' }}>
                    ACTIVE POSITIONS · {positions.length} / {maxOpen}
                  </Typography>
                  {positions.map((pos) => (
                    <Box
                      key={`${pos.side}-${pos.number}`}
                      sx={{
                        mt: 1, p: 1.5, borderRadius: 2,
                        border: `1px solid ${pos.side === 'LONG' ? LONG : SHORT}`,
                        bgcolor: 'rgba(0,0,0,0.35)',
                      }}
                    >
                      <Typography variant="caption" fontWeight={800} sx={{ color: pos.side === 'LONG' ? LONG : SHORT }}>
                        {pos.side} #{pos.number}
                      </Typography>
                      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1, mt: 1 }}>
                        <Stat label="Entry" value={`$${px(pos.entryPrice)}`} />
                        <Stat label="Mark" value={`$${px(trader.markPrice)}`} color={MARK} />
                        <Stat label="TP" value={`$${px(pos.tpPrice)}`} color={LONG} />
                        <Stat label="Margin" value={money(pos.stepAmount)} />
                        <Stat label="Notional" value={money(pos.positionNotional)} />
                        <Stat
                          label="Net uPnL"
                          value={pnl(pos.netUnrealizedPnl ?? pos.unrealizedPnl)}
                          color={col(pos.netUnrealizedPnl ?? pos.unrealizedPnl)}
                        />
                      </Box>
                    </Box>
                  ))}
                </Box>
              );
            })()}
            <GridLadder grid={grid} markPrice={trader.markPrice} />
          </Grid>

          <Grid item xs={12} md={5}>
            <Box
              sx={{
                p: 1.5,
                borderRadius: 2,
                border: `1px solid ${BORDER}`,
                bgcolor: 'rgba(0,0,0,0.2)',
                mb: 1.5,
              }}
            >
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, mb: 1.25 }}>
                <Stat label="Start" value={`$${px(grid.startPrice)}`} color={START} />
                <Stat label="Mark" value={`$${px(trader.markPrice)}`} color={MARK} />
                <Stat label="Initial alloc" value={money(grid.initialCapital ?? trader.capital?.traderAllocatedAmount)} />
                <Stat label="Current capital" value={money(grid.currentCapital ?? trader.capital?.currentStepAmount)} color="#2dd4bf" />
                <Stat label="Leverage" value={`${trader.leverage}x`} />
                <Stat label="Open Notional" value={money(trader.capital?.positionNotional)} />
                <Stat
                  label="vs Start"
                  value={vsStart == null ? '—' : `${vsStart >= 0 ? '+' : ''}${vsStart.toFixed(2)}%`}
                  color={vsStart == null ? undefined : col(vsStart)}
                />
                <Stat label="Net PnL" value={pnl(trader.totalPnl)} color={col(trader.totalPnl)} />
                <Stat label="Unrealized" value={pnl(trader.unrealizedPnl)} color={col(trader.unrealizedPnl)} />
                <Stat
                  label="Open positions"
                  value={`${grid.activeOpenCount ?? (trader.currentPositions?.length ?? (trader.currentPosition ? 1 : 0))} / ${grid.maxOpenPositions ?? 2}`}
                />
                <Stat label="Grid TP done" value={`${grid.longFilled + grid.shortFilled}/${grid.levelsPerSide * 2}`} />
              </Box>

              <FillMeter label="LONG TP" filled={grid.longFilled} total={grid.levelsPerSide} color={LONG} />
              <FillMeter label="SHORT TP" filled={grid.shortFilled} total={grid.levelsPerSide} color={SHORT} />

              <Box sx={{ mt: 1.5 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.4 }}>
                  <Typography variant="caption" color="text.secondary">Trader TP ({grid.takeProfitPercent}% of initial)</Typography>
                  <Typography variant="caption" fontFamily="monospace" fontWeight={800}>
                    {tpNow.toFixed(1)}% / {tpTarget}%
                  </Typography>
                </Box>
                <LinearProgress
                  variant="determinate"
                  value={tpProgress}
                  sx={{
                    height: 8, borderRadius: 99, bgcolor: 'rgba(255,255,255,0.06)',
                    '& .MuiLinearProgress-bar': { bgcolor: LONG, borderRadius: 99 },
                  }}
                />
              </Box>

              <Box sx={{ mt: 1.25 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.4 }}>
                  <Typography variant="caption" color="text.secondary">Lifetime</Typography>
                  <Typography variant="caption" fontFamily="monospace" fontWeight={800}>
                    {formatDuration(stats.runtimeMs)} / {formatDuration(lifetimeMs)}
                  </Typography>
                </Box>
                <LinearProgress
                  variant="determinate"
                  value={lifeProgress}
                  sx={{
                    height: 8, borderRadius: 99, bgcolor: 'rgba(255,255,255,0.06)',
                    '& .MuiLinearProgress-bar': { bgcolor: '#60a5fa', borderRadius: 99 },
                  }}
                />
              </Box>
            </Box>

            <Box sx={{ p: 1.5, borderRadius: 2, border: `1px solid ${BORDER}`, bgcolor: 'rgba(0,0,0,0.2)' }}>
              <Typography variant="caption" fontWeight={800} color="text.secondary" sx={{ letterSpacing: 0.6 }}>
                TRADER EXIT CONDITIONS
              </Typography>
              <Stack spacing={0.75} sx={{ mt: 1 }}>
                <Typography variant="body2" sx={{ fontSize: 13 }}>
                  1. Trader TP ≥ <Box component="span" fontWeight={800} sx={{ color: LONG }}>{grid.takeProfitPercent}%</Box>
                  {' '}of initial ({tpNow.toFixed(1)}% / {tpTarget}%)
                </Typography>
                <Typography variant="body2" sx={{ fontSize: 13 }}>
                  2. Max lifetime ({formatDuration(stats.remainingMs)} left)
                </Typography>
                <Typography variant="body2" sx={{ fontSize: 13 }}>
                  3. Grid exhausted: either side {grid.levelsPerSide}/{grid.levelsPerSide} TP
                  {' '}(L {grid.longFilled}/{grid.levelsPerSide} · S {grid.shortFilled}/{grid.levelsPerSide})
                </Typography>
              </Stack>
              <Divider sx={{ my: 1.25, borderColor: BORDER }} />
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                <Stat label="Opened" value={String(stats.positionsOpened)} />
                <Stat label="Closed" value={String(stats.positionsClosed)} />
                <Stat label="Fees" value={pnl(`-${trader.totalFees ?? stats.totalFees ?? '0'}`)} color={SHORT} />
                <Stat label="Runtime" value={formatDuration(stats.runtimeMs)} />
              </Box>
            </Box>
          </Grid>
        </Grid>
      </Box>
    </Box>
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
  const gainers = summary?.topGainers ?? [];
  const list = traders ?? [];

  useEffect(() => {
    if (!confirmStop) return;
    const t = setTimeout(() => setConfirmStop(false), 4000);
    return () => clearTimeout(t);
  }, [confirmStop]);

  return (
    <Box
      sx={{
        minHeight: '100%',
        mx: { xs: -1, sm: -2 },
        px: { xs: 1, sm: 2 },
        pb: 3,
        background:
          'radial-gradient(ellipse at top left, rgba(45,212,191,0.08), transparent 40%), radial-gradient(ellipse at top right, rgba(96,165,250,0.07), transparent 35%)',
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2, flexWrap: 'wrap', gap: 1.5 }}>
        <Box>
          <Typography
            variant="overline"
            sx={{ color: '#2dd4bf', letterSpacing: 2, fontWeight: 800, display: 'block', lineHeight: 1.2 }}
          >
            DIRECTIONAL GRID
          </Typography>
          <Typography variant="h4" fontWeight={900} sx={{ letterSpacing: -0.8, fontSize: { xs: '1.6rem', sm: '2rem' } }}>
            Live traders
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Chip label={summary?.tradingMode ?? '—'} size="small" color={summary?.tradingMode === 'LIVE' ? 'error' : 'info'} />
          <Chip label={wsOk ? 'Live feed' : 'Reconnecting'} color={wsOk ? 'success' : 'warning'} size="small" />
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

      <Grid container spacing={1.25} mb={1.5}>
        <Grid item xs={6} sm={4} md={2}>
          <Kpi label="Balance" value={money(summary?.currentBalance ?? summary?.balance)} />
        </Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Kpi label="Equity" value={money(summary?.equity)} />
        </Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Kpi label="Net realized" value={pnl(summary?.netRealizedPnl ?? summary?.totalRealizedPnl ?? '0')} color={col(summary?.netRealizedPnl ?? summary?.totalRealizedPnl ?? '0')} />
        </Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Kpi label="Unrealized" value={pnl(summary?.totalUnrealizedPnl ?? '0')} color={col(summary?.totalUnrealizedPnl ?? '0')} />
        </Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Kpi label="Fees" value={pnl(`-${summary?.totalFees ?? '0'}`)} color={SHORT} />
        </Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Kpi
            label="Slots"
            value={`${summary?.activeTraders ?? 0} / ${summary?.maxTraders ?? '—'}`}
            hint={`${summary?.openPositions ?? 0} open legs`}
          />
        </Grid>
      </Grid>

      <BalanceRangeBar
        low={summary?.lowestBalance24h}
        high={summary?.highestBalance24h}
        current={summary?.currentBalance ?? summary?.balance}
      />

      <Grid container spacing={2}>
        <Grid item xs={12} lg={gainers.length > 0 ? 9 : 12}>
          {list.length === 0 ? (
            <Box
              sx={{
                textAlign: 'center',
                py: 8,
                borderRadius: 2.5,
                bgcolor: PANEL,
                border: `1px dashed ${BORDER}`,
              }}
            >
              <Typography color="text.secondary">No active traders — scanning top gainers…</Typography>
            </Box>
          ) : (
            <Grid container spacing={2}>
              {list.map((t) => (
                <Grid item xs={12} key={t.id}>
                  <GridTraderCard trader={t} gainers={gainers} />
                </Grid>
              ))}
            </Grid>
          )}
        </Grid>

        {gainers.length > 0 && (
          <Grid item xs={12} lg={3}>
            <Box
              sx={{
                position: 'sticky',
                top: 16,
                p: 1.5,
                borderRadius: 2.5,
                bgcolor: PANEL,
                border: `1px solid ${BORDER}`,
              }}
            >
              <Typography variant="caption" fontWeight={800} sx={{ letterSpacing: 0.8, color: 'text.secondary', display: 'block', mb: 1 }}>
                TOP GAINERS
              </Typography>
              {gainers.slice(0, 18).map((g) => {
                const pct = parseFloat(g.priceChangePercent);
                const active = list.some((t) => t.symbol === g.symbol);
                return (
                  <Box
                    key={g.symbol}
                    sx={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      py: 0.65,
                      px: 0.75,
                      mx: -0.75,
                      borderRadius: 1,
                      bgcolor: active ? 'rgba(45,212,191,0.1)' : 'transparent',
                      borderBottom: `1px solid ${BORDER}`,
                      '&:last-child': { borderBottom: 'none' },
                    }}
                  >
                    <Box>
                      <Typography variant="caption" fontFamily="monospace" fontWeight={700}>
                        {g.symbol.replace('USDT', '')}
                        {active ? ' ●' : ''}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ fontSize: 10 }}>
                        ${parseFloat(g.lastPrice).toFixed(4)}
                      </Typography>
                    </Box>
                    <Typography variant="caption" sx={{ color: pct >= 0 ? LONG : SHORT, fontWeight: 800 }}>
                      {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
                    </Typography>
                  </Box>
                );
              })}
            </Box>
          </Grid>
        )}
      </Grid>
    </Box>
  );
}
