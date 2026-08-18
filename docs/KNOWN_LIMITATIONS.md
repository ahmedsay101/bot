# Known limitations

## Funding fees

Binance USDⓈ-M Futures funding payments are **not** booked into the account ledger or trader PnL today (neither `reversal` nor `grid_directional`).

- Live mode: wallet balance may move due to funding while local `realizedPnl` / fee totals do not include those payments unless Binance COMMISSION-style events are already reconciled elsewhere.
- Testing mode: funding is not simulated.

Net trader TP / dashboard PnL therefore reflect **trading price PnL and trading fees only**, not funding.

## Strategy switch

`TRADER_BEHAVIOR` is process-global. Changing it applies to **new** traders after slot recycle; restart is recommended for a clean switch. Existing open traders keep the behavior they were created with.
