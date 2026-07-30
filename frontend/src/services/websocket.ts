import { useEffect, useRef } from 'react';
import { useSystemStore } from '../stores/systemStore';

const WS_URL = import.meta.env.VITE_WS_URL ?? `ws://${window.location.host}/ws`;

export function useWebSocket(): void {
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { updateTrader } = useSystemStore();

  const connect = (): void => {
    ws.current = new WebSocket(WS_URL);

    ws.current.onopen = () => {
      console.log('Dashboard WS connected');
    };

    ws.current.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as {
          type: string;
          traderId?: string;
          symbol?: string;
          status?: string;
          realizedPnl?: string;
          unrealizedPnl?: string;
        };

        if (msg.type === 'STATUS_CHANGED' && msg.traderId != null) {
          updateTrader({ id: msg.traderId, status: msg.status });
        } else if (msg.type === 'PNL_UPDATE' && msg.traderId != null) {
          updateTrader({
            id: msg.traderId,
            realizedPnl: msg.realizedPnl,
            unrealizedPnl: msg.unrealizedPnl,
          });
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.current.onclose = () => {
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.current.onerror = () => {
      ws.current?.close();
    };
  };

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current != null) clearTimeout(reconnectTimer.current);
      ws.current?.close();
    };
  }, []);
}
