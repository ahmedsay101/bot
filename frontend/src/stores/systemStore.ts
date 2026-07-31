import { create } from 'zustand';
import type { SystemHealth } from '../services/api';

interface SystemStore {
  health: SystemHealth | null;
  isPaused: boolean;
  dashboardWsConnected: boolean;
  lastWsMessageAt: number;
  setHealth: (health: SystemHealth) => void;
  setPaused: (paused: boolean) => void;
  setDashboardWsConnected: (connected: boolean) => void;
  touchWsMessage: () => void;
}

export const useSystemStore = create<SystemStore>((set) => ({
  health: null,
  isPaused: false,
  dashboardWsConnected: false,
  lastWsMessageAt: 0,
  setHealth: (health) => set({ health }),
  setPaused: (paused) => set({ isPaused: paused }),
  setDashboardWsConnected: (connected) => set({ dashboardWsConnected: connected }),
  touchWsMessage: () => set({ lastWsMessageAt: Date.now() }),
}));
