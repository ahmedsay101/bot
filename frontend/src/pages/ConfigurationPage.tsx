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
      <Typography variant="h4" fontWeight="bold" mb={3}>Configuration</Typography>
      <Alert severity="info" sx={{ mb: 2 }}>
        Equity allocation is automatic: Testing = 2000 USDT + realized PnL; Live = Binance Futures balance.
        Each trader gets Equity / MaxTraders as allocation, sized by capital steps (notional = step amount × leverage).
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
                label="Trader Lifetime (hours)"
                type="number"
                value={current.traderLifetimeHours ?? 24}
                onChange={(e) => handleChange('traderLifetimeHours', parseFloat(e.target.value))}
                fullWidth
                inputProps={{ min: 0.001, step: 1 }}
                helperText="Trader is destroyed and replaced after this duration"
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
                helperText="Position notional = (Equity ÷ MaxTraders) × Leverage"
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
              <FormControl fullWidth>
                <InputLabel>Starting Side</InputLabel>
                <Select
                  value={current.startingSide ?? 'SHORT'}
                  label="Starting Side"
                  onChange={(e) => handleChange('startingSide', e.target.value)}
                >
                  <MenuItem value="SHORT">SHORT</MenuItem>
                  <MenuItem value="LONG">LONG</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <TextField
                label="Capital Steps"
                type="number"
                value={current.capitalSteps ?? 5}
                onChange={(e) => handleChange('capitalSteps', parseInt(e.target.value, 10))}
                fullWidth
                inputProps={{ min: 1, max: 100 }}
                helperText="Allocation divided into N steps (TP +1, SL −1)"
              />
            </Grid>
            <Grid item xs={12}>
              <FormControlLabel
                control={
                  <Switch
                    checked={Boolean(current.switchPositionOnTakeProfit)}
                    onChange={(e) => handleChange('switchPositionOnTakeProfit', e.target.checked)}
                  />
                }
                label="Switch position on Take Profit (on: TP→opposite, SL→same; off: TP→same, SL→opposite)"
              />
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <TextField
                label="Take Profit %"
                value={current.takeProfitPercent ?? '0.10'}
                helperText="e.g. 0.10 = 10% — next side depends on Switch on TP setting"
                onChange={(e) => handleChange('takeProfitPercent', e.target.value)}
                fullWidth
              />
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <TextField
                label="Stop Loss %"
                value={current.stopLossPercent ?? '0.10'}
                helperText="e.g. 0.10 = 10% — next side depends on Switch on TP setting"
                onChange={(e) => handleChange('stopLossPercent', e.target.value)}
                fullWidth
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
