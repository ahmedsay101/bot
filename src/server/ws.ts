import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { URL } from 'node:url';
import { verifyTokenString } from './auth.middleware.js';
import { subscribe } from '../services/redis.service.js';
import { Channels } from '../core/constants.js';
import { scoped } from '../utils/logger.js';

const log = scoped('WS-GW');

export function attachWsGateway(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    const user = verifyTokenString(token);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const channels = [
    Channels.CANDLE_CLOSE,
    Channels.BOOK_TICKER,
    Channels.ORDER_FILLED,
    Channels.ORDER_PARTIAL,
    Channels.TRADE_CLOSED,
    Channels.POSITION_UPDATED,
    Channels.BALANCE_UPDATED,
    Channels.CONFIG_UPDATED,
  ];

  const clients = new Set<WebSocket>();
  wss.on('connection', (ws) => {
    clients.add(ws);
    log.info({ count: clients.size }, 'client connected');
    const hb = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30_000);
    ws.on('close', () => {
      clients.delete(ws);
      clearInterval(hb);
    });
  });

  for (const ch of channels) {
    void subscribe(ch, (msg) => {
      const payload = JSON.stringify({ channel: ch, data: msg });
      for (const c of clients) {
        if (c.readyState === WebSocket.OPEN) c.send(payload);
      }
    });
  }
}
