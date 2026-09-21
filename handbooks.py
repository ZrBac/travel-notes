"""Trusted behavior and restrictive response policy for imported HTML handbooks."""
import base64
import hashlib

BUDGET_SCRIPT = """(() => {
  const inputs = [...document.querySelectorAll('.budget-input')];
  const total = document.getElementById('budgetTotal');
  if (!total) return;
  const prefix = 'travel-handbook:' + location.pathname + ':budget:';
  const calculate = () => {
    const sum = inputs.reduce((sum, input) => sum + Math.max(0, Number(input.value) || 0), 0);
    total.textContent = '¥' + Math.round(sum).toLocaleString('zh-CN');
    inputs.forEach((input, index) => {
      try { localStorage.setItem(prefix + index, input.value); } catch (_) {}
    });
  };
  inputs.forEach((input, index) => {
    try { input.value = localStorage.getItem(prefix + index) || ''; } catch (_) {}
    input.addEventListener('input', calculate);
  });
  calculate();
})();"""
SCRIPT_HASH = base64.b64encode(hashlib.sha256(BUDGET_SCRIPT.encode()).digest()).decode()
HANDBOOK_CSP = (
    "default-src 'none'; script-src 'sha256-" + SCRIPT_HASH + "'; "
    "style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; "
    "base-uri 'none'; frame-ancestors 'none'; form-action 'none'; "
    "sandbox allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
)
