import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { tradersApi, statisticsApi, systemApi, ordersApi, configApi } from '../services/api';

export const queryKeys = {
  traders: ['traders'] as const,
  activeTraders: ['traders', 'active'] as const,
  traderById: (id: string) => ['traders', id] as const,
  globalStats: ['statistics', 'global'] as const,
  statsSummary: ['statistics', 'summary'] as const,
  health: ['system', 'health'] as const,
  logs: (level?: string) => ['system', 'logs', level] as const,
  orders: (params?: object) => ['orders', params] as const,
  config: ['config'] as const,
};

export function useActiveTraders() {
  return useQuery({
    queryKey: queryKeys.activeTraders,
    queryFn: () => tradersApi.getActive().then((r) => r.data.data),
    // Fast REST fallback if dashboard WS drops; WS patches keep this fresh between polls
    refetchInterval: 1000,
    staleTime: 0,
  });
}

export function useAllTraders() {
  return useQuery({
    queryKey: queryKeys.traders,
    queryFn: () => tradersApi.getAll().then((r) => r.data.data),
    refetchInterval: 10000,
  });
}

export function useTraderById(id: string) {
  return useQuery({
    queryKey: queryKeys.traderById(id),
    queryFn: () => tradersApi.getById(id).then((r) => r.data.data),
    refetchInterval: 5000,
    enabled: id.length > 0,
  });
}

export function useGlobalStats() {
  return useQuery({
    queryKey: queryKeys.globalStats,
    queryFn: () => statisticsApi.getGlobal().then((r) => r.data.data),
    refetchInterval: 15000,
    staleTime: 2000,
  });
}

export function useStatsSummary() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: queryKeys.statsSummary,
    queryFn: async () => {
      const data = await statisticsApi.getSummary().then((r) => r.data.data);
      // Merge traders by id — WS snapshot wins for live ladder/PnL/orders
      if (data.traders != null) {
        qc.setQueryData(queryKeys.activeTraders, (prev: import('../services/api').TraderSummary[] | undefined) => {
          if (prev == null || prev.length === 0) return data.traders;
          const byId = new Map(prev.map((t) => [t.id, t]));
          const restIds = new Set(data.traders!.map((t) => t.id));
          const merged = data.traders!.map((rest) => {
            const live = byId.get(rest.id);
            if (live == null) return rest;
            const liveMark = parseFloat(live.markPrice);
            // Prefer WS fields when mark is live; keep REST status if terminal
            if (liveMark > 0) {
              return {
                ...rest,
                ...live,
                status: rest.status === 'COMPLETED' || rest.status === 'FAILED' ? rest.status : live.status,
              };
            }
            return rest;
          });
          // Keep any WS-only traders not yet in REST (race after spawn)
          for (const live of prev) {
            if (!restIds.has(live.id)) merged.push(live);
          }
          return merged;
        });
      }
      return data;
    },
    refetchInterval: 1000,
    staleTime: 0,
  });
}

export function useSystemHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: () => systemApi.getHealth().then((r) => r.data.data),
    refetchInterval: 10000,
  });
}

export function useLogs(level?: string, limit = 100) {
  return useQuery({
    queryKey: queryKeys.logs(level),
    queryFn: () => systemApi.getLogs({ level, limit }).then((r) => r.data.data),
    refetchInterval: 30000,
  });
}

export function useOrders(params?: { traderId?: string; status?: string; symbol?: string }) {
  return useQuery({
    queryKey: queryKeys.orders(params),
    queryFn: () => ordersApi.getAll(params).then((r) => r.data.data),
    refetchInterval: 10000,
  });
}

export function useConfig() {
  return useQuery({
    queryKey: queryKeys.config,
    queryFn: () => configApi.get().then((r) => r.data.data),
  });
}

function invalidateTraderCaches(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: queryKeys.traders });
  void qc.invalidateQueries({ queryKey: queryKeys.activeTraders });
  void qc.invalidateQueries({ queryKey: queryKeys.statsSummary });
  void qc.invalidateQueries({ queryKey: queryKeys.globalStats });
}

export function usePauseTraders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => tradersApi.pause(),
    onSuccess: () => invalidateTraderCaches(qc),
  });
}

export function useResumeTraders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => tradersApi.resume(),
    onSuccess: () => invalidateTraderCaches(qc),
  });
}

export function useEmergencyStop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => tradersApi.emergencyStop(),
    onSuccess: () => invalidateTraderCaches(qc),
  });
}

export function useUpdateConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => configApi.update(data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.config }),
  });
}
