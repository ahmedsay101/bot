'use client';
import { useEffect, useRef, useState } from 'react';
import { getToken } from './api.js';

let socket = null;
const subscribers = new Set();
let backoffMs = 1000;

function connect() {
  if (typeof window === 'undefined') return;
  const token = getToken();
  if (!token) return;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${window.location.host}/ws?token=${encodeURIComponent(token)}`;
  socket = new WebSocket(url);

  socket.onopen = () => {
    backoffMs = 1000;
    subscribers.forEach((cb) => cb({ type: 'open' }));
  };
  socket.onmessage = (ev) => {
    let parsed;
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      return;
    }
    subscribers.forEach((cb) => cb(parsed));
  };
  socket.onclose = () => {
    socket = null;
    subscribers.forEach((cb) => cb({ type: 'close' }));
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  };
  socket.onerror = () => {
    try {
      socket?.close();
    } catch {
      /* noop */
    }
  };
}

export function ensureSocket() {
  if (!socket && getToken()) connect();
}

export function useChannel(channels, handler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const key = channels.join(',');
  useEffect(() => {
    ensureSocket();
    const cb = (msg) => {
      if (!msg.channel) return;
      if (channels.length === 0 || channels.includes(msg.channel)) {
        handlerRef.current(msg);
      }
    };
    subscribers.add(cb);
    return () => subscribers.delete(cb);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

export function useWsStatus() {
  const [status, setStatus] = useState('connecting');
  useEffect(() => {
    ensureSocket();
    const cb = (msg) => {
      if (msg.type === 'open') setStatus('open');
      else if (msg.type === 'close') setStatus('closed');
    };
    subscribers.add(cb);
    return () => subscribers.delete(cb);
  }, []);
  return status;
}
