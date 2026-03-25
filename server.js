const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// ── Zoho credentials from env vars ────────────────────────────────────────────
const ZOHO_CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_API           = 'https://www.zohoapis.eu/crm/v6';
const ZOHO_ACCOUNTS      = 'https://accounts.zoho.eu';
const Q1_TARGET          = 55;

let accessToken  = null;
let cachedData   = null;
let lastFetched  = 0;
const CACHE_TTL  = 5 * 60 * 1000; // 5 min

// ── Token refresh ─────────────────────────────────────────────────────────────
async function refreshToken() {
  const body = `grant_type=refresh_token&client_id=${ZOHO_CLIENT_ID}&client_secret=${ZOHO_CLIENT_SECRET}&refresh_token=${ZOHO_REFRESH_TOKEN}`;
  const res  = await fetch(`${ZOHO_ACCOUNTS}/oauth/v2/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(json));
  accessToken = json.access_token;
  console.log('[token] refreshed');
}

// ── Paginated fetch from Zoho ─────────────────────────────────────────────────
async function fetchAllPages(criteria, fields, maxPages = 10) {
  const records = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${ZOHO_API}/Deals/search?criteria=${encodeURIComponent(criteria)}&fields=${fields}&page=${page}&per_page=200`;
    let res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
    let json = await res.json();

    if (json.code === 'INVALID_TOKEN' || json.code === 'AUTHENTICATION_FAILURE') {
      await refreshToken();
      res  = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
      json = await res.json();
    }

    if (!json.data) break;
    records.push(...json.data);
    if (!json.info?.more_records) break;
  }
  return records;
}

// ── Categorise deal by channel ────────────────────────────────────────────────
function categorize(deal) {
  const src  = deal.Lead_Source || '';
  const tags = (deal.Tag || []).map(t => t.name);
  if (src === 'Distribuidor' || tags.includes('Distribuidores')) return 'distribuidor';
  if (src === 'Distribuidores referidos')  return 'dist_ref';
  if (src === 'Customer Referral')         return 'customer_ref';
  if (src === 'Partner')                   return 'partner';
  if (src === 'Employee Referral' || src === 'External Referral') return 'referral';
  return 'directo';
}

const CATS = ['distribuidor','partner','customer_ref','dist_ref','referral','directo'];

function countByCat(deals) {
  const out = Object.fromEntries(CATS.map(c => [c, 0]));
  deals.forEach(d => out[d.cat]++);
  return out;
}

// ── Main data fetch ───────────────────────────────────────────────────────────
async function fetchData() {
  if (!accessToken) await refreshToken();

  console.log('[data] fetching Customer deals...');
  const FIELDS = 'id,Owner,Pricing_Plan_Value,Closing_Date,Lead_Source,Tag,Distributor1,Overall_Sales_Duration';
  const rawDeals = await fetchAllPages('(Stage:equals:Customer)', FIELDS);

  // Filter from Sep 2025 and add category
  const deals = rawDeals
    .filter(d => d.Closing_Date && d.Closing_Date >= '2025-09-01')
    .map(d => ({ ...d, cat: categorize(d) }));

  console.log(`[data] ${deals.length} deals desde sep 2025`);

  // Unique months sorted
  const months = [...new Set(deals.map(d => d.Closing_Date.slice(0, 7)))].sort();

  // Monthly breakdown
  const monthly = months.map(m => {
    const md = deals.filter(d => d.Closing_Date.slice(0, 7) === m);
    const row = { month: m, total: md.length };
    CATS.forEach(c => row[c] = md.filter(d => d.cat === c).length);
    return row;
  });

  // Category totals (all months)
  const category_totals = countByCat(deals);

  // Q1 2026 — indirect only
  const q1Deals = deals.filter(d => d.Closing_Date >= '2026-01-01' && d.Closing_Date <= '2026-03-31' && d.cat !== 'directo');
  const q1_breakdown = countByCat(q1Deals);
  delete q1_breakdown.directo;

  // Q2 2026 — indirect only
  const q2Deals = deals.filter(d => d.Closing_Date >= '2026-04-01' && d.Closing_Date <= '2026-06-30' && d.cat !== 'directo');
  const q2_breakdown = countByCat(q2Deals);
  delete q2_breakdown.directo;

  return {
    category_totals,
    monthly,
    q1_total: q1Deals.length,
    q1_breakdown,
    q2_total: q2Deals.length,
    q2_breakdown,
    updated: new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid', hour12: false }),
  };
}

// ── Cached getter ─────────────────────────────────────────────────────────────
async function getData() {
  if (cachedData && Date.now() - lastFetched < CACHE_TTL) return cachedData;
  cachedData  = await fetchData();
  lastFetched = Date.now();
  return cachedData;
}

// ── HTML template ─────────────────────────────────────────────────────────────
function buildHTML(data) {
  const D = JSON.stringify(data);
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="300">
<title>Customers por Canal — Last App</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0}
  .header{background:linear-gradient(135deg,#1a1f2e,#252b3b);padding:22px 32px;border-bottom:1px solid #2d3748;display:flex;justify-content:space-between;align-items:center}
  .header h1{font-size:20px;font-weight:700;color:#fff}
  .upd{font-size:12px;color:#718096}
  .kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;padding:22px 32px}
  .kpi{background:#1a1f2e;border:1px solid #2d3748;border-radius:10px;padding:16px 18px}
  .kpi .lbl{font-size:10px;color:#718096;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
  .kpi .val{font-size:26px;font-weight:700}
  .kpi .sub{font-size:11px;color:#718096;margin-top:3px}
  .quarters{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:0 32px 20px}
  .qcard{background:#1a1f2e;border:1px solid #2d3748;border-radius:10px;padding:18px 20px}
  .qcard h3{font-size:13px;font-weight:600;color:#a0aec0;text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px}
  .q-meta{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:8px}
  .q-count{font-size:28px;font-weight:700}
  .q-target{font-size:12px;color:#718096}
  .q-pct{font-size:13px;font-weight:600}
  .progress-track{width:100%;height:18px;background:#2d3748;border-radius:9px;overflow:hidden;margin-bottom:8px}
  .progress-fill{height:100%;border-radius:9px;display:flex;align-items:center;justify-content:flex-end;padding-right:8px;font-size:11px;font-weight:700;color:#fff}
  .q-breakdown{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}
  .q-cat{font-size:11px;padding:3px 9px;border-radius:10px}
  .section{padding:0 32px 20px}
  .card{background:#1a1f2e;border:1px solid #2d3748;border-radius:10px;padding:20px;margin-bottom:16px}
  .card h2{font-size:13px;font-weight:600;color:#a0aec0;text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px}
  .chart-wrap{position:relative;height:320px}
  .chart-wrap.tall{height:380px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .legend{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
  .pill{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:12px;font-size:12px;font-weight:500}
  .pill-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
  table{width:100%;border-collapse:collapse;font-size:13px}
  thead th{text-align:left;color:#718096;font-size:11px;font-weight:600;text-transform:uppercase;padding:8px 10px;border-bottom:1px solid #2d3748}
  tbody tr{border-bottom:1px solid #1e2433}
  tbody tr:hover{background:#252b3b}
  tbody td{padding:9px 10px}
  .bar-inline{display:inline-block;height:8px;border-radius:4px;vertical-align:middle;margin-left:6px}
  .footer{text-align:center;padding:18px;color:#4a5568;font-size:11px}
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>&#x1F4CA; Customers por Canal de Captacion &#x2014; Last App</h1>
    <div style="font-size:12px;color:#718096;margin-top:3px">Locations &middot; sep 2025 &rarr; hoy &middot; Distribuidor &middot; Partner &middot; Referral &middot; Customer Referral &middot; Distribuidores Referidos</div>
  </div>
  <div class="upd">Actualizado: ${data.updated}</div>
</div>

<div class="kpis">
  <div class="kpi" style="border-left:3px solid #F59E0B"><div class="lbl">Distribuidor</div><div class="val" id="kpi-dist" style="color:#F59E0B">-</div><div class="sub">desde sep 2025</div></div>
  <div class="kpi" style="border-left:3px solid #8B5CF6"><div class="lbl">Partner</div><div class="val" id="kpi-partner" style="color:#8B5CF6">-</div><div class="sub">desde sep 2025</div></div>
  <div class="kpi" style="border-left:3px solid #10B981"><div class="lbl">Customer Referral</div><div class="val" id="kpi-cref" style="color:#10B981">-</div><div class="sub">desde sep 2025</div></div>
  <div class="kpi" style="border-left:3px solid #F97316"><div class="lbl">Dist. Referidos</div><div class="val" id="kpi-dref" style="color:#F97316">-</div><div class="sub">desde sep 2025</div></div>
  <div class="kpi" style="border-left:3px solid #6B7280"><div class="lbl">Referral / Otros</div><div class="val" id="kpi-ref" style="color:#a0aec0">-</div><div class="sub">desde sep 2025</div></div>
</div>

<div class="quarters">
  <div class="qcard">
    <h3>Q1 2026 - Progreso canales indirectos (ene - feb - mar)</h3>
    <div class="q-meta">
      <div><div class="q-count" id="q1-count" style="color:#63b3ed">-</div><div class="q-target">Objetivo: ${Q1_TARGET} deals</div></div>
      <div class="q-pct" id="q1-pct" style="color:#63b3ed">-%</div>
    </div>
    <div class="progress-track"><div class="progress-fill" id="q1-bar" style="width:0%;background:linear-gradient(90deg,#3b82f6,#63b3ed)"><span id="q1-bar-label"></span></div></div>
    <div style="font-size:11px;color:#718096;margin-top:4px">Dias restantes en Q1: <span id="q1-days"></span></div>
    <div class="q-breakdown" id="q1-breakdown"></div>
  </div>
  <div class="qcard">
    <h3>Q2 2026 - Progreso canales indirectos (abr - may - jun)</h3>
    <div class="q-meta">
      <div><div class="q-count" id="q2-count" style="color:#68d391">-</div><div class="q-target">En curso</div></div>
      <div class="q-pct" id="q2-pct" style="color:#68d391"></div>
    </div>
    <div class="progress-track"><div class="progress-fill" id="q2-bar" style="width:0%;background:linear-gradient(90deg,#38a169,#68d391)"><span id="q2-bar-label"></span></div></div>
    <div style="font-size:11px;color:#718096;margin-top:4px">Q2 2026 acumula datos del mes actual</div>
    <div class="q-breakdown" id="q2-breakdown"></div>
  </div>
</div>

<div class="section">
  <div class="card">
    <h2>&#x1F4C5; Customers Won por Mes y Canal (sep 2025 &rarr; hoy)</h2>
    <div class="legend" id="legend-main"></div>
    <div class="chart-wrap tall"><canvas id="chartStacked"></canvas></div>
  </div>
</div>

<div class="section">
  <div class="grid2">
    <div class="card"><h2>&#x1F369; Mix de Canales (% total)</h2><div class="chart-wrap"><canvas id="chartDoughnut"></canvas></div></div>
    <div class="card"><h2>&#x1F4C8; Tendencia Canales Clave (linea)</h2><div class="chart-wrap"><canvas id="chartLine"></canvas></div></div>
  </div>
</div>

<div class="section">
  <div class="card">
    <h2>&#x1F4CB; Desglose Mensual por Canal</h2>
    <table>
      <thead><tr>
        <th>Mes</th>
        <th style="color:#F59E0B">Distribuidor</th>
        <th style="color:#8B5CF6">Partner</th>
        <th style="color:#10B981">Customer Referral</th>
        <th style="color:#F97316">Dist. Referidos</th>
        <th style="color:#a0aec0">Referral/Otros</th>
        <th><strong>Total Indirecto</strong></th>
      </tr></thead>
      <tbody id="detail-tbody"></tbody>
    </table>
  </div>
</div>

<div class="footer">Last App Sales Dashboard &middot; Zoho CRM EU &middot; Datos actualizados cada 5 min</div>

<script>
const DATA = ${D};
const MONTHLY = DATA.monthly;
const Q1_TARGET = ${Q1_TARGET};
const CATS = [
  {key:'distribuidor', label:'Distribuidor',      color:'#F59E0B', bg:'rgba(245,158,11,0.8)'},
  {key:'partner',      label:'Partner',           color:'#8B5CF6', bg:'rgba(139,92,246,0.8)'},
  {key:'customer_ref', label:'Customer Referral', color:'#10B981', bg:'rgba(16,185,129,0.8)'},
  {key:'dist_ref',     label:'Dist. Referidos',   color:'#F97316', bg:'rgba(249,115,22,0.8)'},
  {key:'referral',     label:'Referral / Otros',  color:'#94A3B8', bg:'rgba(148,163,184,0.8)'},
  {key:'directo',      label:'Directo',           color:'#3B82F6', bg:'rgba(59,130,246,0.6)'},
];
Chart.defaults.color='#718096';
Chart.defaults.borderColor='#2d3748';
const shortMonth=m=>{const[y,mo]=m.split('-');return['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][+mo]+"'"+y.slice(2)};

const ct=DATA.category_totals;
document.getElementById('kpi-dist').textContent=ct.distribuidor;
document.getElementById('kpi-partner').textContent=ct.partner;
document.getElementById('kpi-cref').textContent=ct.customer_ref;
document.getElementById('kpi-dref').textContent=ct.dist_ref;
document.getElementById('kpi-ref').textContent=ct.referral;

function fillProgress(prefix,total,target,breakdown){
  const pct=target>0?Math.min(Math.round(total*100/target),100):0;
  document.getElementById(prefix+'-count').textContent=total;
  document.getElementById(prefix+'-pct').textContent=pct+'% del objetivo';
  const bar=document.getElementById(prefix+'-bar');
  bar.style.width=pct+'%';
  if(total>target)bar.style.background='linear-gradient(90deg,#065f46,#10b981)';
  document.getElementById(prefix+'-bar-label').textContent=pct>12?pct+'%':'';
  const el=document.getElementById(prefix+'-breakdown');
  CATS.filter(c=>c.key!=='directo').forEach(c=>{
    const v=breakdown[c.key]||0;if(!v)return;
    const s=document.createElement('span');s.className='q-cat';
    s.style.cssText='background:'+c.color+'22;color:'+c.color+';border:1px solid '+c.color+'55';
    s.textContent=c.label+': '+v;el.appendChild(s);
  });
}
fillProgress('q1',DATA.q1_total,Q1_TARGET,DATA.q1_breakdown);
fillProgress('q2',DATA.q2_total,DATA.q2_total,DATA.q2_breakdown);

const today=new Date(),q1end=new Date('2026-03-31');
document.getElementById('q1-days').textContent=Math.max(0,Math.ceil((q1end-today)/86400000))+' dias';

const legendEl=document.getElementById('legend-main');
CATS.forEach(c=>{
  const d=document.createElement('div');d.className='pill';
  d.style.cssText='background:'+c.color+'18;border:1px solid '+c.color+'44';
  d.innerHTML='<span class="pill-dot" style="background:'+c.color+'"></span><span style="color:'+c.color+'">'+c.label+'</span>';
  legendEl.appendChild(d);
});

const labels=MONTHLY.map(m=>shortMonth(m.month));
new Chart(document.getElementById('chartStacked'),{
  type:'bar',
  data:{labels,datasets:CATS.map(c=>({label:c.label,data:MONTHLY.map(m=>m[c.key]||0),backgroundColor:c.bg,borderRadius:c.key==='directo'?4:0,borderSkipped:false}))},
  options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false}},scales:{x:{stacked:true,grid:{color:'#1e2433'}},y:{stacked:true,grid:{color:'#1e2433'},beginAtZero:true,ticks:{stepSize:10}}}}
});

new Chart(document.getElementById('chartDoughnut'),{
  type:'doughnut',
  data:{labels:CATS.map(c=>c.label),datasets:[{data:CATS.map(c=>ct[c.key]||0),backgroundColor:CATS.map(c=>c.bg),borderColor:CATS.map(c=>c.color),borderWidth:1,hoverOffset:6}]},
  options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{padding:14,font:{size:12}}},tooltip:{callbacks:{label:ctx=>{const t=ctx.dataset.data.reduce((a,b)=>a+b,0);return ' '+ctx.label+': '+ctx.parsed+' ('+Math.round(ctx.parsed*100/t)+'%)';}}}}}
});

const keyCats=CATS.filter(c=>c.key!=='directo');
new Chart(document.getElementById('chartLine'),{
  type:'line',
  data:{labels,datasets:keyCats.map(c=>({label:c.label,data:MONTHLY.map(m=>m[c.key]||0),borderColor:c.color,backgroundColor:c.color+'18',tension:0.3,fill:false,pointRadius:4,pointHoverRadius:6,borderWidth:2}))},
  options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{padding:12,font:{size:11}}}},scales:{x:{grid:{color:'#1e2433'}},y:{grid:{color:'#1e2433'},beginAtZero:true}}}
});

const tbody=document.getElementById('detail-tbody');
const maxInd=Math.max(...MONTHLY.map(x=>(['distribuidor','partner','customer_ref','dist_ref','referral'].reduce((s,k)=>s+(x[k]||0),0))));
MONTHLY.forEach(m=>{
  const isQ1=m.month>='2026-01'&&m.month<='2026-03';
  const isQ2=m.month>='2026-04'&&m.month<='2026-06';
  const hl=isQ1?'background:rgba(59,130,246,0.06)':isQ2?'background:rgba(16,185,129,0.06)':'';
  const ind=(m.distribuidor||0)+(m.partner||0)+(m.customer_ref||0)+(m.dist_ref||0)+(m.referral||0);
  const bw=maxInd>0?Math.round(ind*80/maxInd):0;
  const badge=isQ1?' <span style="font-size:10px;color:#63b3ed;background:#1e3a5f;padding:1px 6px;border-radius:8px">Q1</span>':isQ2?' <span style="font-size:10px;color:#68d391;background:#1a3a2a;padding:1px 6px;border-radius:8px">Q2</span>':'';
  tbody.innerHTML+='<tr style="'+hl+'"><td><strong>'+shortMonth(m.month)+'</strong>'+badge+'</td><td style="color:#F59E0B">'+(m.distribuidor||0)+'</td><td style="color:#8B5CF6">'+(m.partner||0)+'</td><td style="color:#10B981">'+(m.customer_ref||0)+'</td><td style="color:#F97316">'+(m.dist_ref||0)+'</td><td style="color:#94A3B8">'+(m.referral||0)+'</td><td><strong>'+ind+'</strong><span class="bar-inline" style="width:'+bw+'px;background:#2d3748"></span></td></tr>';
});
const totals=CATS.filter(c=>c.key!=='directo').reduce((a,c)=>{a[c.key]=ct[c.key]||0;return a},{});
const indTot=Object.values(totals).reduce((s,v)=>s+v,0);
tbody.innerHTML+='<tr style="border-top:2px solid #4a5568;background:#161b2e"><td><strong>TOTAL</strong></td><td style="color:#F59E0B"><strong>'+totals.distribuidor+'</strong></td><td style="color:#8B5CF6"><strong>'+totals.partner+'</strong></td><td style="color:#10B981"><strong>'+totals.customer_ref+'</strong></td><td style="color:#F97316"><strong>'+totals.dist_ref+'</strong></td><td style="color:#94A3B8"><strong>'+totals.referral+'</strong></td><td><strong>'+indTot+'</strong></td></tr>';
</script>
</body>
</html>`;
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  try {
    const data = await getData();
    res.send(buildHTML(data));
  } catch (err) {
    console.error(err);
    res.status(500).send('<pre>Error fetching data: ' + err.message + '</pre>');
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', cached: !!cachedData, lastFetched }));

app.get('/debug', async (req, res) => {
  const clientId     = ZOHO_CLIENT_ID     ? ZOHO_CLIENT_ID.slice(0,12)+'...'     : 'MISSING';
  const clientSecret = ZOHO_CLIENT_SECRET ? ZOHO_CLIENT_SECRET.slice(0,8)+'...'  : 'MISSING';
  const refreshTok   = ZOHO_REFRESH_TOKEN ? ZOHO_REFRESH_TOKEN.slice(0,12)+'...' : 'MISSING';
  // Get server's outbound IP
  let serverIP = 'unknown';
  try {
    const ipRes = await fetch('https://api.ipify.org?format=json');
    const ipJson = await ipRes.json();
    serverIP = ipJson.ip;
  } catch {}
  // Try a live token refresh and report result
  let refreshResult;
  try {
    await refreshToken();
    refreshResult = 'OK — access token starts: ' + accessToken.slice(0,15);
  } catch (e) {
    refreshResult = 'FAILED: ' + e.message;
  }
  res.json({ clientId, clientSecret, refreshTok, serverIP, refreshResult });
});

app.get('/data', async (req, res) => {
  try {
    res.json(await getData());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
  // Warm up cache on start
  getData().catch(console.error);
});
