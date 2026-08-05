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
        Equity allocation is automatic: Testing = 200 USDT + realized PnL; Live = Binance Futures balance.
        Each trader gets Equity / MaxTraders, split equally between Main Short and Hedge.
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
                helperText="Position notional = (Equity ÷ MaxTraders ÷ 2) × Leverage"
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
                label="Hedge Entry Distance"
                value={current.hedgeDistance}
                helperText="Above previous reference — e.g. 0.10 = 10%"
                onChange={(e) => handleChange('hedgeDistance', e.target.value)}
                fullWidth
              />
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <TextField
                label="Hedge Stop Loss %"
                value={current.hedgeSlPercent}
                helperText="Below hedge entry — e.g. 0.03 = 3%"
                onChange={(e) => handleChange('hedgeSlPercent', e.target.value)}
                fullWidth
              />
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <TextField
                label="Hedge Take Profit %"
                value={current.hedgeTpPercent}
                helperText="Above hedge entry — e.g. 0.10 = 10%"
                onChange={(e) => handleChange('hedgeTpPercent', e.target.value)}
                fullWidth
              />
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <TextField
                label="Short Take Profit %"
                value={current.shortTpPercent}
                helperText="Below short entry — e.g. 0.10 = 10%"
                onChange={(e) => handleChange('shortTpPercent', e.target.value)}
                fullWidth
              />
            </Grid>
            <Grid item xs={12} sm={6} md={4}>
              <TextField
                label="Fee Rate"
                value={current.feeRate}
                helperText="e.g. 0.0004 = 0.04%"
                onChange={(e) => handleChange('feeRate', e.target.value)}
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
