// Every amount in the portal is stored and charged in Omani Rial
// (0107_currency_omr.sql). OMR is subdivided into 1,000 baisa, so money is
// kept to 3 decimal places.
const CURRENCY = 'OMR';
const CURRENCY_DECIMALS = 3;

const moneyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: CURRENCY,
  currencyDisplay: 'code',
  minimumFractionDigits: CURRENCY_DECIMALS,
  maximumFractionDigits: CURRENCY_DECIMALS,
});

// "OMR 1,234.500" — for emails, notifications and any other human-facing text.
function formatMoney(amount) {
  return moneyFormatter.format(Number(amount) || 0).replace(/ /g, ' ');
}

// Rounds to the nearest baisa.
function roundMoney(amount) {
  const factor = 10 ** CURRENCY_DECIMALS;
  return Math.round((Number(amount) || 0) * factor) / factor;
}

module.exports = { CURRENCY, CURRENCY_DECIMALS, formatMoney, roundMoney };
