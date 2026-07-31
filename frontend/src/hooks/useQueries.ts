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
    refetchInterval: 10000,
    staleTime: 2000,
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
  return useQuery({
    queryKey: queryKeys.statsSummary,
    queryFn: () => statisticsApi.getSummary().then((r) => r.data.data),
    refetchInterval: 10000,
    staleTime: 2000,
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

export function usePauseTraders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => tradersApi.pause(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.traders }),
  });
}

export function useResumeTraders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => tradersApi.resume(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.traders }),
  });
}

export function useEmergencyStop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => tradersApi.emergencyStop(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.traders }),
  });
}

export function useUpdateConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => configApi.update(data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.config }),
  });
}
