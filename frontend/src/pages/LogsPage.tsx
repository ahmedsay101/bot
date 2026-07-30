import React, { useState } from 'react';
import { Box, Typography, Card, CardContent, Chip, TextField, MenuItem, Select, FormControl, InputLabel } from '@mui/material';
import { useLogs } from '../hooks/useQueries';
import type { AppLog } from '../services/api';

const LEVEL_COLORS: Record<string, 'error' | 'warning' | 'info' | 'default'> = {
  error: 'error',
  warn: 'warning',
  info: 'info',
  debug: 'default',
  http: 'default',
};

export function LogsPage(): React.ReactElement {
  const [level, setLevel] = useState('');
  const [limit, setLimit] = useState(100);
  const { data: logs, isLoading } = useLogs(level || undefined, limit);

  return (
    <Box>
      <Typography variant="h4" fontWeight="bold" mb={3}>Application Logs</Typography>

      <Box display="flex" gap={2} mb={2}>
        <FormControl sx={{ minWidth: 120 }} size="small">
          <InputLabel>Level</InputLabel>
          <Select value={level} label="Level" onChange={(e) => setLevel(e.target.value)}>
            <MenuItem value="">All</MenuItem>
            <MenuItem value="error">Error</MenuItem>
            <MenuItem value="warn">Warning</MenuItem>
            <MenuItem value="info">Info</MenuItem>
            <MenuItem value="debug">Debug</MenuItem>
          </Select>
        </FormControl>
        <TextField
          label="Limit"
          type="number"
          size="small"
          value={limit}
          onChange={(e) => setLimit(parseInt(e.target.value, 10))}
          inputProps={{ min: 10, max: 1000 }}
          sx={{ width: 100 }}
        />
      </Box>

      <Card elevation={2}>
        <CardContent sx={{ p: 1, fontFamily: 'monospace' }}>
          {isLoading && <Typography>Loading logs...</Typography>}
          {(logs ?? []).map((log: AppLog) => (
            <Box key={log.id} sx={{ display: 'flex', gap: 1, py: 0.25, borderBottom: '1px solid', borderColor: 'divider', alignItems: 'flex-start' }}>
              <Typography variant="caption" color="text.secondary" sx={{ minWidth: 170, whiteSpace: 'nowrap' }}>
                {new Date(log.timestamp).toLocaleString()}
              </Typography>
              <Chip
                label={log.level.toUpperCase()}
                size="small"
                color={LEVEL_COLORS[log.level] ?? 'default'}
                sx={{ minWidth: 60 }}
              />
              {log.context != null && (
                <Typography variant="caption" color="primary.main" sx={{ minWidth: 100 }}>
                  [{log.context}]
                </Typography>
              )}
              <Typography variant="caption" sx={{ wordBreak: 'break-word', flexGrow: 1 }}>
                {log.message}
              </Typography>
            </Box>
          ))}
          {(logs ?? []).length === 0 && !isLoading && (
            <Typography color="text.secondary">No logs found</Typography>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
