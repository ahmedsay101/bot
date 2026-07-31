import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../hooks/useQueries';
import { useSystemStore } from '../stores/systemStore';
import type { StatsSummary, TraderSummary, Ticker } from './api';

const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = import.meta.env.VITE_WS_URL ?? `${wsProtocol}//${window.location.host}/ws`;

interface DashboardMessage {
  type: string;
  traderId?: string;
  symbol?: string;
  status?: string;
  realizedPnl?: string;
  unrealizedPnl?: string;
  trader?: TraderSummary;
  data?: {
    totalEquity?: string;
    totalPnl?: string;
    totalRealizedPnl?: string;
    totalUnrealizedPnl?: string;
    activeTraders?: number;
    maxTraders?: number;
    topGainers?: Ticker[];
    tradingMode?: string;
  };
}

export function useWebSocket(): void {
  const qc = useQueryClient();
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalClose = useRef(false);
  const setConnected = useSystemStore((s) => s.setDashboardWsConnected);
  const touchWs = useSystemStore((s) => s.touchWsMessage);

  useEffect(() => {
    intentionalClose.current = false;

    const connect = (): void => {
      ws.current = new WebSocket(WS_URL);

      ws.current.onopen = () => {
        console.log('Dashboard WS connected', WS_URL);
        setConnected(true);
      };

      ws.current.onmessage = (event) => {
        touchWs();
        try {
          const msg = JSON.parse(event.data as string) as DashboardMessage;

          if (msg.type === 'TRADER_SNAPSHOT' && msg.trader != null) {
            const snapshot = msg.trader;
            qc.setQueryData<TraderSummary[]>(queryKeys.activeTraders, (prev) => {
              const list = prev ?? [];
              const idx = list.findIndex((t) => t.id === snapshot.id);
              if (idx < 0) return [...list, snapshot];
              const next = [...list];
              next[idx] = { ...next[idx], ...snapshot };
              return next;
            });
            return;
          }

          if (msg.type === 'SUMMARY' && msg.data != null) {
            const d = msg.data;
            qc.setQueryData<StatsSummary>(queryKeys.statsSummary, (prev) => ({
              activeTraders: d.activeTraders ?? prev?.activeTraders ?? 0,
              maxTraders: d.maxTraders ?? prev?.maxTraders ?? 0,
              topGainers: d.topGainers ?? prev?.topGainers ?? [],
              totalEquity: d.totalEquity ?? prev?.totalEquity ?? '0',
              totalPnl: d.totalPnl ?? prev?.totalPnl ?? '0',
              totalRealizedPnl: d.totalRealizedPnl ?? prev?.totalRealizedPnl ?? '0',
              totalUnrealizedPnl: d.totalUnrealizedPnl ?? prev?.totalUnrealizedPnl ?? '0',
              tradingMode: d.tradingMode ?? prev?.tradingMode,
              equityPerTrader: prev?.equityPerTrader,
              positionNotional: prev?.positionNotional,
              leverage: prev?.leverage,
            }));

            qc.setQueryData(queryKeys.globalStats, (prev: Record<string, unknown> | undefined) => {
              if (prev == null) return prev;
              return {
                ...prev,
                totalEquity: d.totalEquity ?? prev.totalEquity,
                totalPnl: d.totalPnl ?? prev.totalPnl,
                totalRealizedPnl: d.totalRealizedPnl ?? prev.totalRealizedPnl,
                totalUnrealizedPnl: d.totalUnrealizedPnl ?? prev.totalUnrealizedPnl,
                activeTraders: d.activeTraders ?? prev.activeTraders,
                maxTraders: d.maxTraders ?? prev.maxTraders,
                tradingMode: d.tradingMode ?? prev.tradingMode,
              };
            });
            return;
          }

          if (msg.type === 'STATUS_CHANGED' && msg.traderId != null) {
            qc.setQueryData<TraderSummary[]>(queryKeys.activeTraders, (prev) =>
              (prev ?? []).map((t) =>
                t.id === msg.traderId ? { ...t, status: msg.status ?? t.status } : t,
              ),
            );
            void qc.invalidateQueries({ queryKey: queryKeys.activeTraders });
            return;
          }

          if (msg.type === 'PNL_UPDATE' && msg.traderId != null) {
            qc.setQueryData<TraderSummary[]>(queryKeys.activeTraders, (prev) =>
              (prev ?? []).map((t) =>
                t.id === msg.traderId
                  ? {
                      ...t,
                      realizedPnl: msg.realizedPnl ?? t.realizedPnl,
                      unrealizedPnl: msg.unrealizedPnl ?? t.unrealizedPnl,
                    }
                  : t,
              ),
            );
            return;
          }

          if (msg.type === 'COMPLETED' || msg.type === 'FAILED') {
            if (msg.traderId != null) {
              qc.setQueryData<TraderSummary[]>(queryKeys.activeTraders, (prev) =>
                (prev ?? []).filter((t) => t.id !== msg.traderId),
              );
            }
            void qc.invalidateQueries({ queryKey: queryKeys.activeTraders });
            void qc.invalidateQueries({ queryKey: queryKeys.statsSummary });
            void qc.invalidateQueries({ queryKey: queryKeys.globalStats });
          }
        } catch {
          // ignore malformed
        }
      };

      ws.current.onclose = () => {
        setConnected(false);
        if (!intentionalClose.current) {
          reconnectTimer.current = setTimeout(connect, 2000);
        }
      };

      ws.current.onerror = () => {
        setConnected(false);
        ws.current?.close();
      };
    };

    connect();

    return () => {
      intentionalClose.current = true;
      if (reconnectTimer.current != null) clearTimeout(reconnectTimer.current);
      ws.current?.close();
      setConnected(false);
    };
  }, [qc, setConnected, touchWs]);
}
