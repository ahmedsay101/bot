import React, { useEffect, useState } from 'react';
import {
  Box, Grid, Card, CardContent, Typography, Chip, Button, Stack, Divider,
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
import type { TraderSummary, HedgeLevelInfo, TraderOrderView } from '../services/api';

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

function pct(v: string | null | undefined): string {
  if (v == null) return '—';
  const n = parseFloat(v);
  if (!isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

type LadderRung = {
  key: string;
  price: number;
  label: string;
  state: string;
  accent: string;
  isMark?: boolean;
  detail?: string;
};

function orderStatus(
  orders: TraderOrderView[] | undefined,
  pred: (o: TraderOrderView) => boolean,
): string | null {
  const o = (orders ?? []).find(pred);
  return o?.status ?? null;
}

/**
 * Strategy ladder — renders engine hedgeLevels + order statuses only.
 * Never invents TRIGGERED from a separate "ACTIVE" phase.
 */
function StrategyLadder({ trader }: { trader: TraderSummary }): React.ReactElement {
  const mark = parseFloat(trader.markPrice) || 0;
  const rungs: LadderRung[] = [];

  const shortTpState =
    orderStatus(trader.orders, (o) => o.role === 'SHORT' && (o.type === 'TAKE_PROFIT' || o.type === 'TAKE_PROFIT_MARKET'))
    ?? 'PENDING';

  if (trader.tpPrice != null) {
    const dist =
      trader.distanceToTpAbs != null
        ? `${px(trader.distanceToTpAbs)} (${pct(trader.distanceToTpPct)})`
        : undefined;
    rungs.push({
      key: 'short-tp',
      price: parseFloat(trader.tpPrice) || 0,
      label: 'Main Short TP',
      state: shortTpState,
      accent: '#4caf50',
      detail: dist != null ? `Dist ${dist}` : undefined,
    });
  }

  for (const h of trader.hedgeLevels) {
    const phase = h.status;
    const entryOrderState = h.entryOrderStatus ?? phase;
    const slPrice = h.stopPrice;

    if (phase === 'HIT_TP' || phase === 'HIT_SL' || phase === 'CANCELED') {
      rungs.push({
        key: `hist-${h.level}-${phase}`,
        price: parseFloat(h.entryPrice) || 0,
        label: `Hedge L${h.level}`,
        state: phase,
        accent: phase === 'HIT_TP' ? '#66bb6a' : '#ef5350',
        detail: `Entry ${px(h.entryPrice)} · SL ${px(slPrice)}`,
      });
      continue;
    }

    const entryLabel = phase === 'PENDING'
      ? `Pending Hedge L${h.level}`
      : phase === 'TRIGGERED'
        ? `Triggered Hedge L${h.level}`
        : `Filled Hedge L${h.level}`;

    rungs.push({
      key: `htp-${h.level}`,
      price: parseFloat(h.tpPrice) || 0,
      label: `Hedge L${h.level} Take Profit`,
      state: phase === 'OPEN' ? 'OPEN' : 'ARMED',
      accent: '#8bc34a',
    });
    rungs.push({
      key: `hent-${h.level}`,
      price: parseFloat(h.entryPrice) || 0,
      label: entryLabel,
      state: phase === 'OPEN' ? 'FILLED' : phase,
      accent: phase === 'TRIGGERED' ? '#ffb74d' : '#ff9800',
      detail: `Order ${entryOrderState}`,
    });
    rungs.push({
      key: `hsl-${h.level}`,
      price: parseFloat(slPrice) || 0,
      label: `Hedge L${h.level} Stop Loss`,
      state: phase === 'OPEN' ? 'OPEN' : 'ARMED',
      accent: '#f44336',
    });
  }

  if (trader.entryPrice != null) {
    rungs.push({
      key: 'short-entry',
      price: parseFloat(trader.entryPrice) || 0,
      label: 'Main Short',
      state: 'FILLED',
      accent: '#2196f3',
    });
  }

  rungs.push({
    key: 'mark',
    price: mark,
    label: '▸ Current Price',
    state: 'LIVE',
    accent: '#fff',
    isMark: true,
    detail: `$${px(trader.markPrice)}`,
  });

  rungs.sort((a, b) => b.price - a.price);

  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="caption" color="text.secondary" fontWeight={700} letterSpacing={0.5}>
        STRATEGY LADDER
      </Typography>
      <Stack spacing={0.5} sx={{ mt: 0.75 }}>
        {rungs.map((r) => (
          <Box
            key={r.key}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              py: r.isMark ? 0.75 : 0.4,
              px: 1,
              borderRadius: 1,
              bgcolor: r.isMark ? 'rgba(255,255,255,0.08)' : 'transparent',
              border: r.isMark ? '1px solid rgba(255,255,255,0.25)' : '1px solid transparent',
              minHeight: 36,
            }}
          >
            <Box sx={{ width: 4, alignSelf: 'stretch', borderRadius: 1, bgcolor: r.accent, flexShrink: 0 }} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="body2"
                fontWeight={r.isMark ? 700 : 600}
                sx={{ color: r.accent, fontSize: { xs: 13, sm: 13 }, lineHeight: 1.2 }}
              >
                {r.label}
              </Typography>
              {r.detail != null && (
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: 11 }}>
                  {r.detail}
                </Typography>
              )}
            </Box>
            <Typography
              fontFamily="monospace"
              fontWeight={700}
              sx={{ color: r.accent, fontSize: { xs: 12, sm: 13 }, flexShrink: 0 }}
            >
              ${px(String(r.price))}
            </Typography>
            <Chip
              label={r.state}
              size="small"
              sx={{ height: 22, fontSize: 10, minWidth: 72, flexShrink: 0 }}
              variant={r.isMark ? 'filled' : 'outlined'}
            />
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

function OrderStrip({ orders }: { orders?: TraderOrderView[] }): React.ReactElement {
  const list = orders ?? [];
  const open = list.filter((o) =>
    ['PENDING', 'NEW', 'TRIGGERED', 'PARTIALLY_FILLED'].includes(o.status),
  );
  const closed = list.filter((o) =>
    !['PENDING', 'NEW', 'TRIGGERED', 'PARTIALLY_FILLED'].includes(o.status),
  );

  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="caption" color="text.secondary" fontWeight={700}>
        ORDERS · open {open.length} · closed {closed.length}
      </Typography>
      <Stack spacing={0.4} sx={{ mt: 0.5 }}>
        {(open.length ? open : list.slice(-6)).map((o) => {
          const isStopLimit = o.type === 'STOP_LIMIT';
          const priceLabel = isStopLimit
            ? `trigger ${px(o.stopPrice ?? o.price)}`
            : px(o.price ?? o.stopPrice);
          return (
            <Box
              key={o.clientOrderId}
              sx={{
                display: 'flex', flexWrap: 'wrap', gap: 0.5, alignItems: 'center',
                py: 0.35, minHeight: 32,
              }}
            >
              <Chip label={o.role} size="small" sx={{ height: 20, fontSize: 10 }} />
              <Typography variant="caption" fontFamily="monospace">{o.type}</Typography>
              <Typography variant="caption" color="text.secondary">
                {priceLabel}
              </Typography>
              <Chip label={o.status} size="small" variant="outlined" sx={{ height: 20, fontSize: 10, ml: 'auto' }} />
            </Box>
          );
        })}
        {list.length === 0 && (
          <Typography variant="caption" color="text.secondary">No orders tracked yet</Typography>
        )}
      </Stack>
    </Box>
  );
}

function TraderCard({ trader }: { trader: TraderSummary }): React.ReactElement {
  // Engine SSOT — never sum realized+unrealized on the client when totalPnl is present
  const totalPnl = trader.totalPnl ?? String(parseFloat(trader.realizedPnl) + parseFloat(trader.unrealizedPnl));
  const activeHedge = trader.hedgeLevels.find((h: HedgeLevelInfo) => h.status === 'OPEN');
  const workingHedge = trader.hedgeLevels.find(
    (h: HedgeLevelInfo) => h.status === 'PENDING' || h.status === 'TRIGGERED',
  );
  const currentHedge = activeHedge ?? workingHedge;
  const hs = trader.hedgeStats ?? {
    currentHedgeNumber: trader.hedgeLevel,
    ordersCreated: 0,
    ordersTriggered: 0,
    positionsOpened: 0,
    positionsClosed: 0,
    stopLosses: trader.hedgeLosses ?? 0,
    takeProfits: trader.hedgeWins ?? 0,
    recreations: trader.hedgeRecreates ?? 0,
    pendingOrders: trader.pendingOrders ?? 0,
    activePositions: activeHedge != null ? 1 : 0,
  };

  return (
    <Card sx={{ border: '1px solid', borderColor: 'divider', height: '100%', overflow: 'hidden' }}>
      <CardContent sx={{ p: { xs: 1.5, sm: 2 }, '&:last-child': { pb: { xs: 1.5, sm: 2 } } }}>
        {/* General */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 1, mb: 1 }}>
          <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="h5" fontWeight={800} sx={{ fontSize: { xs: '1.25rem', sm: '1.5rem' } }}>
              {trader.symbol.replace('USDT', '')}
            </Typography>
            <Chip
              label={trader.status}
              size="small"
              color={trader.status === 'ACTIVE' ? 'success' : 'default'}
              sx={{ height: 24, fontSize: 11 }}
            />
            <Chip label={`Hedge #${trader.hedgeLevel}`} size="small" variant="outlined" sx={{ height: 24, fontSize: 11 }} />
          </Box>
          <Typography fontWeight={800} sx={{ color: col(totalPnl), fontSize: { xs: 16, sm: 18 }, whiteSpace: 'nowrap' }}>
            {pnl(totalPnl)}
          </Typography>
        </Box>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr 1fr', sm: '1fr 1fr 1fr' },
            gap: 1,
            mb: 1.5,
          }}
        >
          <Stat label="Price" value={`$${px(trader.markPrice)}`} />
          <Stat label="Total P/L" value={pnl(totalPnl)} color={col(totalPnl)} />
          <Stat label="Short PnL" value={pnl(trader.shortUnrealizedPnl ?? '0')} color={col(trader.shortUnrealizedPnl ?? '0')} />
          <Stat label="Hedge PnL" value={pnl(trader.hedgeUnrealizedPnl ?? '0')} color={col(trader.hedgeUnrealizedPnl ?? '0')} />
          <Stat label="Realized" value={pnl(trader.realizedPnl)} color={col(trader.realizedPnl)} />
          <Stat label="Unrealized" value={pnl(trader.unrealizedPnl)} color={col(trader.unrealizedPnl)} />
          <Stat label="To Short TP" value={pct(trader.distanceToTpPct)} />
        </Box>

        <Divider sx={{ my: 1 }} />

        {/* Main short */}
        <Typography variant="caption" color="text.secondary" fontWeight={700}>MAIN SHORT</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.75, mt: 0.5, mb: 1 }}>
          <Stat label="Entry" value={`$${px(trader.entryPrice)}`} />
          <Stat label="Current Price" value={`$${px(trader.markPrice)}`} />
          <Stat label="Take Profit" value={`$${px(trader.tpPrice)}`} />
          <Stat label="Current PnL" value={pnl(trader.shortUnrealizedPnl ?? '0')} color={col(trader.shortUnrealizedPnl ?? '0')} />
        </Box>

        {/* Current hedge */}
        <Typography variant="caption" color="text.secondary" fontWeight={700}>CURRENT HEDGE</Typography>
        {currentHedge != null ? (
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.75, mt: 0.5, mb: 1 }}>
            <Stat label="Hedge Number" value={`#${currentHedge.level}`} />
            <Stat label="State" value={currentHedge.status} />
            <Stat label="Entry" value={`$${px(currentHedge.entryPrice)}`} />
            <Stat label="Stop Loss" value={`$${px(currentHedge.stopPrice)}`} />
            <Stat label="Take Profit" value={`$${px(currentHedge.tpPrice)}`} />
            <Stat label="Qty" value={currentHedge.quantity ?? '—'} />
          </Box>
        ) : (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', my: 1 }}>No active hedge</Typography>
        )}

        {/* Hedge lifecycle stats — backend SSOT only */}
        <Typography variant="caption" color="text.secondary" fontWeight={700}>HEDGE STATISTICS</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.75, mt: 0.5 }}>
          <Stat label="Current Hedge" value={`#${hs.currentHedgeNumber}`} />
          <Stat label="Orders Created" value={String(hs.ordersCreated)} />
          <Stat label="Orders Triggered" value={String(hs.ordersTriggered)} />
          <Stat label="Positions Opened" value={String(hs.positionsOpened)} />
          <Stat label="Positions Closed" value={String(hs.positionsClosed)} />
          <Stat label="Take Profits" value={String(hs.takeProfits)} />
          <Stat label="Stop Losses" value={String(hs.stopLosses)} />
          <Stat label="Recreated" value={String(hs.recreations)} />
          <Stat label="Pending Orders" value={String(hs.pendingOrders)} />
          <Stat label="Active Hedge Positions" value={String(hs.activePositions)} />
        </Box>

        <StrategyLadder trader={trader} />
        <OrderStrip orders={trader.orders} />
      </CardContent>
    </Card>
  );
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
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ fontSize: 11 }}>{label}</Typography>
      <Typography variant="subtitle1" fontWeight={700} sx={{ color: color ?? 'inherit', lineHeight: 1.2, fontSize: { xs: 14, sm: 16 } }}>
        {value}
      </Typography>
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
  const [, setTick] = useState(0);

  // Keep Live/WS-idle chip honest without other updates
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const list = traders ?? summary?.traders ?? [];
  const mode = summary?.tradingMode ?? '…';
  const gainers = summary?.topGainers ?? [];
  const wsFresh = dashWs && Date.now() - lastWs < 5000;

  return (
    <Box sx={{ width: '100%', maxWidth: '100%', overflowX: 'hidden' }}>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: 'repeat(2, minmax(0, 1fr))',
            sm: 'repeat(3, minmax(0, 1fr))',
            md: 'repeat(4, minmax(0, 1fr))',
            lg: 'repeat(5, minmax(0, 1fr))',
          },
          gap: { xs: 1.5, sm: 2 },
          p: { xs: 1.5, sm: 2 },
          mb: 2,
          borderRadius: 2,
          bgcolor: 'background.paper',
          border: '1px solid',
          borderColor: 'divider',
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

        <Box sx={{ gridColumn: { xs: '1 / -1', lg: 'auto' }, display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
          <Chip label={mode} size="small" color={mode === 'LIVE' ? 'error' : 'info'} sx={{ height: 28 }} />
          <Chip label={summary?.botStatus ?? '…'} size="small" variant="outlined" sx={{ height: 28 }} />
          <Chip
            label={wsFresh ? 'Live' : dashWs ? 'WS idle' : 'Polling'}
            size="small"
            color={wsFresh ? 'success' : 'warning'}
            variant="outlined"
            sx={{ height: 28 }}
          />
        </Box>

        <Box
          sx={{
            gridColumn: '1 / -1',
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            gap: 1,
          }}
        >
          <Button fullWidth sx={{ minHeight: 44 }} variant="outlined" color="warning" onClick={() => pauseMutation.mutate()}>
            Pause
          </Button>
          <Button fullWidth sx={{ minHeight: 44 }} variant="outlined" color="success" onClick={() => resumeMutation.mutate()}>
            Resume
          </Button>
          <Button
            fullWidth
            sx={{ minHeight: 44 }}
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
        <Grid item xs={12} md={gainers.length ? 8 : 12} lg={gainers.length ? 9 : 12}>
          {list.length === 0 ? (
            <Box sx={{ py: 8, textAlign: 'center', color: 'text.secondary' }}>
              <Typography>No active traders</Typography>
            </Box>
          ) : (
            <Grid container spacing={2}>
              {list.map((t) => (
                <Grid item xs={12} key={t.id}>
                  <TraderCard trader={t} />
                </Grid>
              ))}
            </Grid>
          )}
        </Grid>

        {gainers.length > 0 && (
          <Grid item xs={12} md={4} lg={3}>
            <Card sx={{ overflow: 'hidden' }}>
              <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1, opacity: 0.7 }}>TOP GAINERS</Typography>
                {gainers.slice(0, 12).map((g) => {
                  const gPct = parseFloat(g.priceChangePercent);
                  return (
                    <Box key={g.symbol} sx={{ display: 'flex', justifyContent: 'space-between', py: 0.5, minHeight: 32 }}>
                      <Typography variant="body2" fontFamily="monospace" fontWeight={600}>
                        {g.symbol.replace('USDT', '')}
                      </Typography>
                      <Typography variant="body2" fontWeight={700} sx={{ color: gPct >= 0 ? '#4caf50' : '#f44336' }}>
                        {gPct >= 0 ? '+' : ''}{gPct.toFixed(1)}%
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
