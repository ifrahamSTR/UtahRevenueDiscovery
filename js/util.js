/**
 * Formatting + small math helpers shared by map.js and charts.js.
 */
function fmtCurrency(n) {
  if (n == null || isNaN(n)) return "—";
  return "$" + Math.round(n).toLocaleString("en-US");
}
function fmtCurrencyCompact(n) {
  if (n == null || isNaN(n)) return "—";
  if (Math.abs(n) >= 1000) return "$" + (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "k";
  return "$" + Math.round(n).toLocaleString("en-US");
}
function fmtPct(fraction, digits) {
  if (fraction == null || isNaN(fraction)) return "—";
  return (fraction * 100).toFixed(digits == null ? 0 : digits) + "%";
}
function fmtNumber(n) {
  if (n == null || isNaN(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}
function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s == null ? "" : String(s);
  return div.innerHTML;
}

// Haversine great-circle distance.
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371.0088;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function distanceMiles(lat1, lng1, lat2, lng2) {
  return distanceKm(lat1, lng1, lat2, lng2) / 1.60934;
}

function median(sortedArr) {
  if (!sortedArr.length) return null;
  const mid = Math.floor(sortedArr.length / 2);
  return sortedArr.length % 2 !== 0 ? sortedArr[mid] : (sortedArr[mid - 1] + sortedArr[mid]) / 2;
}
function medianOf(values) {
  const v = values.filter((x) => x != null && !isNaN(x)).sort((a, b) => a - b);
  return median(v);
}
function quantileOf(values, p) {
  const v = values.filter((x) => x != null && !isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = (v.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return v[lo];
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}
function pearsonCorr(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? null : num / denom;
}
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Generic CSV export: `columns` is [{ label, value(row) }, ...]; triggers a
// browser download, no server round-trip.
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadCsv(filename, columns, rows) {
  const lines = [columns.map((c) => csvCell(c.label)).join(",")];
  rows.forEach((row) => lines.push(columns.map((c) => csvCell(c.value(row))).join(",")));
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
