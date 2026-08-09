import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { config } from '../../config';
import { createContextLogger } from '../logger';
import { sleep } from '../utils/retry';
import type { PriceUpdate, OrderUpdate, AccountUpdate } from '../../types';

const log = createContextLogger('WebSocketManager');

export type WsEvent =
  | { type: 'PRICE_UPDATE'; data: PriceUpdate }
  | { type: 'ORDER_UPDATE'; data: OrderUpdate }
  | { type: 'ACCOUNT_UPDATE'; data: AccountUpdate };

interface StreamSubscription {
  streamName: string;
  ws: WebSocket;
  pingInterval: NodeJS.Timeout;
  isAlive: boolean;
  reconnectAttempts: number;
}

export class WebSocketManager extends EventEmitter {
  private subscriptions = new Map<string, StreamSubscription>();
  private reconnecting = new Set<string>(); // prevents concurrent reconnects per key
  private listenKey: string | null = null;
  private listenKeyTimer: NodeJS.Timeout | null = null;
  private readonly wsBaseUrl: string;
  private isShuttingDown = false;
  private readonly seenEventIds = new Set<string>();

  constructor() {
    super();
    this.wsBaseUrl = config.binance.futuresWsUrl;
  }

  async subscribeMarkPrice(symbol: string): Promise<void> {
    const stream = `${symbol.toLowerCase()}@markPrice@1s`;
    if (this.subscriptions.has(stream)) return; // already subscribed, no duplicate
    await this.openStream(stream, this.handleMarkPrice.bind(this));
    log.info(`Subscribed to mark price for ${symbol}`);
  }

  async subscribeMultipleMarkPrices(symbols: string[]): Promise<void> {
    const streams = symbols.map((s) => `${s.toLowerCase()}@markPrice@1s`);
    const combined = streams.join('/');
    const streamName = `combined:${combined}`;
    await this.openCombinedStream(streams, streamName, this.handleMarkPrice.bind(this));
    log.info(`Subscribed to ${symbols.length} mark price streams`);
  }

  async subscribeUserDataStream(listenKey: string): Promise<void> {
    this.listenKey = listenKey;
    const url = `${this.wsBaseUrl}/ws/${listenKey}`;
    await this.openStreamByUrl('user-data', url, this.handleUserDataEvent.bind(this));
    this.scheduleListenKeyRenewal();
    log.info('Subscribed to user data stream');
  }

  private async openStream(
    streamName: string,
    handler: (data: Record<string, unknown>) => void,
  ): Promise<void> {
    const url = `${this.wsBaseUrl}/ws/${streamName}`;
    await this.openStreamByUrl(streamName, url, handler);
  }

  private async openCombinedStream(
    streams: string[],
    key: string,
    handler: (data: Record<string, unknown>) => void,
  ): Promise<void> {
    const url = `${this.wsBaseUrl}/stream?streams=${streams.join('/')}`;
    await this.openStreamByUrl(key, url, handler);
  }

  private async openStreamByUrl(
    key: string,
    url: string,
    handler: (data: Record<string, unknown>) => void,
  ): Promise<void> {
    // Close any existing connection for this key — prevents orphaned ping intervals
    const existing = this.subscriptions.get(key);
    if (existing != null) {
      clearInterval(existing.pingInterval);
      existing.ws.removeAllListeners();
      existing.ws.terminate();
      this.subscriptions.delete(key);
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);

      const connectTimeout = setTimeout(() => {
        ws.removeAllListeners();
        ws.terminate();
        reject(new Error(`WS connect timeout for ${key}`));
      }, 15000);

      const onOpen = (): void => {
        clearTimeout(connectTimeout);
        log.debug(`WS opened: ${key}`);

        const ping = setInterval(() => {
          // Check that this interval belongs to the current connection for this key
          const cur = this.subscriptions.get(key);
          if (cur == null || cur.ws !== ws) { clearInterval(ping); return; }

          if (cur.isAlive) {
            cur.isAlive = false;
            ws.ping();
          } else {
            // Self-clear before reconnecting — prevents double-reconnect with onClose
            clearInterval(ping);
            cur.ws.removeAllListeners('close');
            cur.ws.terminate();
            this.subscriptions.delete(key);
            log.warn(`WS heartbeat missed for ${key} — reconnecting`);
            void this.reconnectStream(key, url, handler);
          }
        }, 30000);

        const sub: StreamSubscription = { streamName: url, ws, pingInterval: ping, isAlive: true, reconnectAttempts: 0 };
        this.subscriptions.set(key, sub);
        resolve();
      };

      const onError = (err: Error): void => {
        log.error(`WS error for ${key}: ${err.message}`);
        if (!this.subscriptions.has(key)) reject(err);
      };

      const onClose = (code: number, reason: Buffer): void => {
        const sub = this.subscriptions.get(key);
        // Only handle if this is still the active connection
        if (sub != null && sub.ws === ws) {
          clearInterval(sub.pingInterval);
          this.subscriptions.delete(key);
          if (!this.isShuttingDown && !this.reconnecting.has(key)) {
            log.warn(`WS closed for ${key}: code=${code} ${reason.toString()} — reconnecting`);
            void this.reconnectStream(key, url, handler);
          }
        }
      };

      const onPong = (): void => {
        const sub = this.subscriptions.get(key);
        if (sub != null && sub.ws === ws) sub.isAlive = true;
      };

      ws.on('open', onOpen);
      ws.on('error', onError);
      ws.on('close', onClose);
      ws.on('pong', onPong);
      ws.on('message', (raw: Buffer) => {
        try {
          const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
          const data = 'data' in parsed ? (parsed.data as Record<string, unknown>) : parsed;
          handler(data);
        } catch (err) {
          log.error('WS message parse error', { error: String(err) });
        }
      });
    });
  }

  private async reconnectStream(
    key: string,
    url: string,
    handler: (data: Record<string, unknown>) => void,
  ): Promise<void> {
    if (this.reconnecting.has(key) || this.isShuttingDown) return;
    this.reconnecting.add(key);

    let attempts = 0;
    while (!this.isShuttingDown) {
      attempts++;
      const delay = Math.min(1000 * Math.pow(2, attempts - 1), 30000);
      log.info(`Reconnecting WS ${key} in ${delay}ms (attempt ${attempts})`);
      await sleep(delay);
      if (this.isShuttingDown) break;
      try {
        await this.openStreamByUrl(key, url, handler);
        this.reconnecting.delete(key);
        this.emit('reconnected', key);
        return;
      } catch (err) {
        log.error(`Reconnect attempt ${attempts} failed for ${key}`, { error: String(err) });
      }
    }
    this.reconnecting.delete(key);
  }

  private handleMarkPrice(data: Record<string, unknown>): void {
    if (typeof data.e !== 'string' || data.e !== 'markPriceUpdate') return;

    const update: PriceUpdate = {
      symbol: data.s as string,
      price: data.p as string,
      timestamp: data.E as number,
    };

    const eventId = `${update.symbol}:${update.timestamp}`;
    if (this.seenEventIds.has(eventId)) return;
    this.seenEventIds.add(eventId);
    if (this.seenEventIds.size > 50000) {
      const iter = this.seenEventIds.values();
      for (let i = 0; i < 10000; i++) this.seenEventIds.delete(iter.next().value as string);
    }

    this.emit('priceUpdate', update);
  }

  private handleUserDataEvent(data: Record<string, unknown>): void {
    const eventType = data.e as string;

    if (eventType === 'ORDER_TRADE_UPDATE') {
      const order = data.o as Record<string, unknown>;
      const update: OrderUpdate = {
        clientOrderId: order.c as string,
        exchangeOrderId: String(order.i),
        symbol: order.s as string,
        status: order.X as OrderUpdate['status'],
        filledQuantity: order.z as string,
        avgFillPrice: (order.ap as string) || null,
        fee: (order.n as string) || null,
        feeCurrency: (order.N as string) || null,
        timestamp: data.E as number,
      };

      const eventId = `order:${update.exchangeOrderId}:${update.status}:${update.timestamp}`;
      if (this.seenEventIds.has(eventId)) return;
      this.seenEventIds.add(eventId);

      this.emit('orderUpdate', update);
    } else if (eventType === 'ACCOUNT_UPDATE') {
      const accountData = data.a as Record<string, unknown>;
      const balances = (accountData.B as Array<Record<string, string>>).map((b) => ({
        asset: b.a,
        balance: b.wb,
        availableBalance: b.cw,
      }));
      const positions = (accountData.P as Array<Record<string, string>>).map((p) => ({
        symbol: p.s,
        side: (parseFloat(p.pa) >= 0 ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT',
        entryPrice: p.ep,
        quantity: p.pa,
        unrealizedPnl: p.up,
        leverage: 0,
        liquidationPrice: '0',
        markPrice: '0',
      }));
      const update: AccountUpdate = { balances, positions, timestamp: data.E as number };
      this.emit('accountUpdate', update);
    }
  }

  private scheduleListenKeyRenewal(): void {
    if (this.listenKeyTimer != null) clearInterval(this.listenKeyTimer);
    // Binance listen keys expire after 60 minutes; renew every 30 minutes
    this.listenKeyTimer = setInterval(async () => {
      try {
        await this.renewListenKey();
      } catch (err) {
        log.error('Failed to renew listen key', { error: String(err) });
      }
    }, 30 * 60 * 1000);
  }

  private async renewListenKey(): Promise<void> {
    if (this.listenKey == null) return;
    const url = `${config.binance.futuresBaseUrl}/listenKey`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'X-MBX-APIKEY': config.binance.apiKey },
    });
    if (!res.ok) throw new Error(`Listen key renewal failed: ${res.status}`);
    log.debug('Listen key renewed');
  }

  async unsubscribe(key: string): Promise<void> {
    const sub = this.subscriptions.get(key);
    if (sub == null) return;
    clearInterval(sub.pingInterval);
    sub.ws.close(1000);
    this.subscriptions.delete(key);
    log.info(`Unsubscribed from ${key}`);
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    if (this.listenKeyTimer != null) clearInterval(this.listenKeyTimer);
    for (const [key, sub] of this.subscriptions) {
      clearInterval(sub.pingInterval);
      sub.ws.close(1000, 'shutdown');
      log.debug(`Closed WS: ${key}`);
    }
    this.subscriptions.clear();
    log.info('WebSocketManager shut down');
  }

  getActiveStreams(): string[] {
    return [...this.subscriptions.keys()];
  }

  isConnected(key: string): boolean {
    const sub = this.subscriptions.get(key);
    return sub != null && sub.ws.readyState === WebSocket.OPEN;
  }
}
