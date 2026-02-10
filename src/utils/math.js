function pctChange(base, pct) {
  return base * (1 + pct / 100);
}

function toFixedDown(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.floor(value * factor) / factor;
}

function absPctChange(from, to) {
  return Math.abs(((to - from) / from) * 100);
}

module.exports = {
  pctChange,
  toFixedDown,
  absPctChange
};
