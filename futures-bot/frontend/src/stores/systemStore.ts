import { create } from 'zustand';
import type { TraderSummary, SystemHealth } from '../services/api';

interface SystemStore {
  health: SystemHealth | null;
  isPaused: boolean;
  activeTraders: TraderSummary[];
  setHealth: (health: SystemHealth) => void;
  setPaused: (paused: boolean) => void;
  setActiveTraders: (traders: TraderSummary[]) => void;
  updateTrader: (trader: Partial<TraderSummary> & { id: string }) => void;
}

export const useSystemStore = create<SystemStore>((set) => ({
  health: null,
  isPaused: false,
  activeTraders: [],

  setHealth: (health) => set({ health }),
  setPaused: (paused) => set({ isPaused: paused }),
  setActiveTraders: (traders) => set({ activeTraders: traders }),
  updateTrader: (update) =>
    set((state) => ({
      activeTraders: state.activeTraders.map((t) =>
        t.id === update.id ? { ...t, ...update } : t,
      ),
    })),
}));
