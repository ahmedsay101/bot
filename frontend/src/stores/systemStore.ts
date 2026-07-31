import { create } from 'zustand';
import type { SystemHealth } from '../services/api';

/** Thin store for non-trader UI flags. Live trader data lives in React Query. */
interface SystemStore {
  health: SystemHealth | null;
  isPaused: boolean;
  setHealth: (health: SystemHealth) => void;
  setPaused: (paused: boolean) => void;
}

export const useSystemStore = create<SystemStore>((set) => ({
  health: null,
  isPaused: false,
  setHealth: (health) => set({ health }),
  setPaused: (paused) => set({ isPaused: paused }),
}));
