import React, { useState } from 'react';
import {
  Box, Typography, Card, CardContent, TextField, Button, Grid,
  MenuItem, Select, FormControl, InputLabel, Switch, FormControlLabel, Alert,
} from '@mui/material';
import { useConfig, useUpdateConfig } from '../hooks/useQueries';

export function ConfigurationPage(): React.ReactElement {
  const { data: config, isLoading } = useConfig();
  const updateMutation = useUpdateConfig();
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState(false);

  const handleChange = (field: string, value: unknown): void => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setSaved(false);
  };

  const handleSave = (): void => {
    updateMutation.mutate(form, {
      onSuccess: () => setSaved(true),
    });
  };

  if (isLoading || config == null) return <Typography>Loading configuration...</Typography>;

  const current = { ...config, ...form };

  return (
    <Box>
      <Typography variant="h4" fontWeight="bold" mb={1}>Configuration</Typography>
      <Typography color="text.secondary" mb={3} sx={{ maxWidth: 720 }}>
        This branch runs directional grid traders only. Equity is split across max trader slots;
        each slot builds LONG levels above and SHORT levels below an immutable start price.
      </Typography>
      <Alert severity="info" sx={{ mb: 2 }}>
        Equity allocation is automatic: Testing = 2000 USDT + realized PnL; Live = Binance Futures balance.
        Each trader gets Equity / MaxTraders as allocation, sized across grid level weights.
      </Alert>
      {saved && <Alert severity="success" sx={{ mb: 2 }}>Configuration saved successfully</Alert>}

      <Card elevation={2}>
        <CardContent>
          <Grid container spacing={3}>
            <Grid item xs={12} sm={6} md={4}>
              <TextField
                label="Max Traders"
                type="number"
                value={current.maxTraders}
                onChange={(e) => handleChange('maxTraders', parseInt(e.target.value, 10))}
                fullWidth
                inputProps={{ min: 1, max: 50 }}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <TextField
                label="Leverage"
                type="number"
                value={current.leverage}
                onChange={(e) => handleChange('leverage', parseInt(e.target.value, 10))}
                fullWidth
                inputProps={{ min: 1, max: 125 }}
                helperText="Applied to grid level notionals"
              />
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <FormControl fullWidth>
                <InputLabel>Margin Mode</InputLabel>
                <Select
                  value={current.marginMode}
                  label="Margin Mode"
                  onChange={(e) => handleChange('marginMode', e.target.value)}
                >
                  <MenuItem value="ISOLATED">ISOLATED</MenuItem>
                  <MenuItem value="CROSSED">CROSSED</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <FormControl fullWidth>
                <InputLabel>Trading Mode</InputLabel>
                <Select
                  value={current.mode}
                  label="Trading Mode"
                  onChange={(e) => handleChange('mode', e.target.value)}
                >
                  <MenuItem value="SIMULATION">SIMULATION</MenuItem>
                  <MenuItem value="LIVE">LIVE</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <TextField
                label="Grid Levels Per Side"
                type="number"
                value={current.gridLevelsPerSide ?? 10}
                onChange={(e) => handleChange('gridLevelsPerSide', parseInt(e.target.value, 10))}
                fullWidth
                inputProps={{ min: 1, max: 100 }}
                helperText="Levels above and below start price"
              />
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <TextField
                label="Grid Distance %"
                value={current.gridDistancePercent ?? '2'}
                onChange={(e) => handleChange('gridDistancePercent', e.target.value)}
                fullWidth
                helperText="Percent points between levels (2 = 2%)"
              />
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <TextField
                label="Trader Take Profit %"
                value={current.traderTakeProfitPercent ?? '10'}
                onChange={(e) => handleChange('traderTakeProfitPercent', e.target.value)}
                fullWidth
                helperText="Combined unrealized exit target (10 = 10%)"
              />
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <TextField
                label="Trader Max Lifetime (hours)"
                type="number"
                value={current.traderMaxLifetimeHours ?? 12}
                onChange={(e) => handleChange('traderMaxLifetimeHours', parseFloat(e.target.value))}
                fullWidth
                inputProps={{ min: 0.001, step: 1 }}
                helperText="Force-close and recycle slot after this duration"
              />
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <TextField
                label="Maker Fee Rate"
                value={current.makerFeeRate ?? '0.0002'}
                helperText="Binance Futures maker (e.g. 0.0002 = 0.02%)"
                onChange={(e) => handleChange('makerFeeRate', e.target.value)}
                fullWidth
              />
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <TextField
                label="Taker Fee Rate"
                value={current.takerFeeRate ?? current.feeRate ?? '0.0005'}
                helperText="Binance Futures taker / market (e.g. 0.0005 = 0.05%)"
                onChange={(e) => {
                  handleChange('takerFeeRate', e.target.value);
                  handleChange('feeRate', e.target.value);
                }}
                fullWidth
              />
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <TextField
                label="Refresh Interval (ms)"
                type="number"
                value={current.refreshInterval}
                onChange={(e) => handleChange('refreshInterval', parseInt(e.target.value, 10))}
                fullWidth
              />
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <TextField
                label="Retry Limit"
                type="number"
                value={current.retryLimit}
                onChange={(e) => handleChange('retryLimit', parseInt(e.target.value, 10))}
                fullWidth
              />
            </Grid>
            <Grid item xs={12}>
              <FormControlLabel
                control={
                  <Switch
                    checked={Boolean(current.isPaused)}
                    onChange={(e) => handleChange('isPaused', e.target.checked)}
                  />
                }
                label="Pause All Trading"
              />
            </Grid>
          </Grid>

          <Box mt={3} display="flex" gap={2}>
            <Button
              variant="contained"
              onClick={handleSave}
              disabled={updateMutation.isPending || Object.keys(form).length === 0}
            >
              Save Configuration
            </Button>
            <Button variant="outlined" onClick={() => { setForm({}); setSaved(false); }}>
              Reset
            </Button>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
