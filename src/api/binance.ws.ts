import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { env } from '../core/env.js';
import { scoped } from '../utils/logger.js';
import { sleep } from '../utils/time.js';

const log = scoped('BINANCE-WS');

export interface KlineEvent {
  symbol: string;
  interval: string;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;
}

export interface BookTickerEvent {
  symbol: string;
  bidPrice: number;
  askPrice: number;
  bidQty: number;
  askQty: number;
  ts: number;
}

type Stream = string;

export interface BinanceWsClientEvents {
  kline: (e: KlineEvent) => void;
  bookTicker: (e: BookTickerEvent) => void;
  open: () => void;
  close: () => void;
  error: (err: Error) => void;
}

export class BinanceWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private streams = new Set<Stream>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private lastMsgAt = 0;
  private closing = false;
  private pendingSubs = new Set<Stream>();
  private nextReqId = 1;
  private readonly base: string;

  constructor(baseUrl = env.BINANCE_WS_BASE) {
    super();
    this.base = baseUrl;
  }

  override on<K extends keyof BinanceWsClientEvents>(event: K, listener: BinanceWsClientEvents[K]): this {
    return super.on(event, listener);
  }
  override emit<K extends keyof BinanceWsClientEvents>(event: K, ...args: Parameters<BinanceWsClientEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  start(): void {
    this.closing = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    await sleep(50);
  }

  /** Replace the active stream set with `desired`. Sub/unsub deltas only. */
  setStreams(desired: Stream[]): void {
    const next = new Set(desired);
    const toAdd = [...next].filter((s) => !this.streams.has(s));
    const toRemove = [...this.streams].filter((s) => !next.has(s));
    this.streams = next;
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (toAdd.length) this.send({ method: 'SUBSCRIBE', params: toAdd, id: this.nextReqId++ });
      if (toRemove.length) this.send({ method: 'UNSUBSCRIBE', params: toRemove, id: this.nextReqId++ });
    } else {
      for (const s of toAdd) this.pendingSubs.add(s);
    }
  }

  private connect(): void {
    if (this.closing) return;
    const url = `${this.base}/ws`;
    log.debug({ url }, 'connecting');
    const ws = new WebSocket(url);
    this.ws = ws;
    this.lastMsgAt = Date.now();

    ws.on('open', () => {
      log.info('open');
      this.emit('open');
      const all = [...this.streams, ...this.pendingSubs];
      this.pendingSubs.clear();
      if (all.length) this.send({ method: 'SUBSCRIBE', params: all, id: this.nextReqId++ });
      if (!this.watchdog) {
        this.watchdog = setInterval(() => this.checkLiveness(), 5_000);
      }
    });

    ws.on('message', (data) => {
      this.lastMsgAt = Date.now();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      this.dispatch(msg);
    });

    ws.on('error', (err) => {
      log.warn({ err: err.message }, 'ws error');
      this.emit('error', err);
    });

    ws.on('close', (code, reason) => {
      log.warn({ code, reason: reason.toString() }, 'closed');
      this.emit('close');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), 3_000);
  }

  private checkLiveness(): void {
    if (!this.ws) return;
    if (Date.now() - this.lastMsgAt > 15_000) {
      log.warn('liveness timeout, reconnecting');
      this.ws.terminate();
    }
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const e = msg.e as string | undefined;
    if (e === 'kline') {
      const k = msg.k as Record<string, unknown>;
      this.emit('kline', {
        symbol: String(msg.s),
        interval: String(k.i),
        openTime: Number(k.t),
        closeTime: Number(k.T),
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        volume: Number(k.v),
        isClosed: Boolean(k.x),
      });
      return;
    }
    if (e === 'bookTicker' || (msg.u !== undefined && msg.b !== undefined && msg.a !== undefined)) {
      this.emit('bookTicker', {
        symbol: String(msg.s),
        bidPrice: Number(msg.b),
        askPrice: Number(msg.a),
        bidQty: Number(msg.B ?? 0),
        askQty: Number(msg.A ?? 0),
        ts: Number(msg.E ?? Date.now()),
      });
    }
  }
}
