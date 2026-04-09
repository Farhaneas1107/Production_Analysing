/**
 * analyzer_v3.js — Recipe Intelligence Engine
 * Compares production runs by Article / Item Number to find optimal machine settings.
 */

document.addEventListener('DOMContentLoaded', async () => {
    const PROXY_BASE = `${window.location.protocol}//${window.location.hostname}:8085`;
    const TOKEN = "aaad4edbd7e57de0f34d035176a52842900d3216";
    const HEADERS = { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" };

    const loadingOverlay = document.getElementById('loadingOverlay');
    const loadingMsg     = document.getElementById('loadingMsg');
    const locationFilter = document.getElementById('locationFilter');
    const machineFilter  = document.getElementById('machineFilter');
    const startInput     = document.getElementById('startDate');
    const endInput       = document.getElementById('endDate');
    const articleInput   = document.getElementById('articleFilter');
    const articleSugg    = document.getElementById('articleSuggestions');
    const loadRunsBtn    = document.getElementById('loadRunsBtn');
    const compareBtn     = document.getElementById('compareBtn');
    const clearRunsBtn   = document.getElementById('clearRunsBtn');
    const runsList       = document.getElementById('runsList');
    const runCount       = document.getElementById('runCount');
    const selectedPills  = document.getElementById('selectedPills');
    const qualityCards   = document.getElementById('qualityCards');
    const summaryBody    = document.getElementById('summaryBody');
    const colRun1        = document.getElementById('colRun1');
    const colRun2        = document.getElementById('colRun2');
    const varSearch      = document.getElementById('varSearch');
    const varList        = document.getElementById('varList');

    // Default date range: last 90 days
    const now = new Date();
    const past90 = new Date(now.getTime() - 90 * 86400000);
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    startInput.value = fmt(past90);
    endInput.value   = fmt(now);

    const colors = ['#58a6ff','#3fb950','#f85149','#a371f7','#d29922','#2f81f7','#e3b341','#00ffff','#ff8800'];

    let allMachines     = [];  // [{uuid, name, site}]
    let allSites        = {};  // siteUUID → display name
    let allRuns         = [];  // raw API production runs
    let selectedRunIds  = new Set();
    let availableVars   = [];  // variables for selected machine
    let selectedVarIds  = new Set();
    let runDataCache    = {};  // runUUID → [{varId→[ts,val]}]
    let chart           = null;

    // ─── INIT: load locations and machines ──────────────────────────────────
    showLoading("Connecting to API...");
    try {
        // Load real site/plant names (Espelkamp, Adorf, Selangor)
        const [machRes, siteRes] = await Promise.all([
            fetch(`${PROXY_BASE}/proxy/machines`, { headers: HEADERS }),
            fetch(`${PROXY_BASE}/proxy/sites`, { headers: HEADERS })
        ]);
        const machData = await machRes.json();
        allMachines = machData.data;

        // Build site name map from real API data
        if (siteRes.ok) {
            const siteData = await siteRes.json();
            (siteData.data || []).forEach(s => { allSites[s.uuid] = s.name || s.display_name || s.uuid; });
        }
        // Fallback for any site IDs not in the sites API
        allMachines.forEach(m => {
            if (m.site && !allSites[m.site]) allSites[m.site] = m.site.substring(0, 8);
        });

        locationFilter.innerHTML = '<option value="">— All Plants —</option>';
        Object.entries(allSites).forEach(([id, name]) => {
            locationFilter.innerHTML += `<option value="${id}">${name}</option>`;
        });

        populateMachines(null);
        hideLoading();
    } catch(e) {
        console.error(e);
        hideLoading();
        alert("Failed to connect to the ENLYZE Proxy API. Is serve.ps1 running?");
    }

    // ─── LOCATION CHANGE ────────────────────────────────────────────────────
    locationFilter.addEventListener('change', () => {
        populateMachines(locationFilter.value || null);
    });

    function populateMachines(siteId) {
        const filtered = siteId ? allMachines.filter(m => m.site === siteId) : allMachines;
        machineFilter.innerHTML = '<option value="">— Select Machine —</option>';
        filtered.forEach(m => {
            machineFilter.innerHTML += `<option value="${m.uuid}">${m.name}</option>`;
        });
        selectedVarIds.clear();
        availableVars = [];
        varList.innerHTML = '';
    }

    // ─── MACHINE CHANGE → Load variables ────────────────────────────────────
    machineFilter.addEventListener('change', async () => {
        const uuid = machineFilter.value;
        if (!uuid) return;
        showLoading("Fetching machine variables...");
        try {
            let vars = [], cursor = "";
            do {
                const q = cursor ? `?machine=${uuid}&cursor=${encodeURIComponent(cursor)}` : `?machine=${uuid}`;
                const res = await fetch(`${PROXY_BASE}/proxy/variables${q}`, { headers: HEADERS });
                const json = await res.json();
                vars = vars.concat(json.data || []);
                cursor = json.metadata?.next_cursor;
            } while (cursor);
            availableVars = vars.filter(v => v.display_name);
            if (availableVars.length > 80) availableVars = availableVars.slice(0, 80);
            renderVarList();
        } catch(e) { console.error(e); }
        hideLoading();
    });

    function renderVarList() {
        const query = varSearch.value.toLowerCase();
        varList.innerHTML = '';
        availableVars
            .filter(v => v.display_name.toLowerCase().includes(query))
            .forEach((v, idx) => {
                const color = colors[idx % colors.length];
                const el = document.createElement('div');
                el.className = 'var-item' + (selectedVarIds.has(v.uuid) ? ' active' : '');
                el.dataset.id = v.uuid;
                el.innerHTML = `<div class="var-color" style="background:${color}"></div><div class="var-name">${v.display_name}</div>`;
                el.addEventListener('click', async () => {
                    if (selectedVarIds.has(v.uuid)) { 
                        selectedVarIds.delete(v.uuid); 
                        el.classList.remove('active');
                        // Redraw if comparison active
                        if (Object.keys(runDataCache).length > 0) {
                            drawComparisonChart(allRuns.filter(r => selectedRunIds.has(r.uuid)));
                            buildSummaryTable(allRuns.filter(r => selectedRunIds.has(r.uuid)));
                        }
                    } else { 
                        selectedVarIds.add(v.uuid); 
                        el.classList.add('active');
                        // If comparison active, fetch this NEW var on the fly
                        const activeRuns = allRuns.filter(r => selectedRunIds.has(r.uuid));
                        if (activeRuns.length >= 1) {
                            showLoading(`Adding ${v.display_name}...`);
                            try {
                                const machineId = machineFilter.value;
                                for (const run of activeRuns) {
                                    const body = {
                                        machine: machineId, start: run.start, end: run.end,
                                        resampling_interval: 600,
                                        variables: [{ uuid: v.uuid, resampling_method: "avg" }]
                                    };
                                    const res = await fetch(`${PROXY_BASE}/proxy/timeseries`, {
                                        method: 'POST', headers: HEADERS, body: JSON.stringify(body)
                                    });
                                    const json = await res.json();
                                    if (json.data?.records) {
                                        if (!runDataCache[run.uuid]) runDataCache[run.uuid] = {};
                                        const timeIdx = json.data.columns.indexOf('time');
                                        const valIdx = json.data.columns.indexOf(v.uuid);
                                        runDataCache[run.uuid][v.uuid] = json.data.records
                                            .filter(row => row[valIdx] !== null)
                                            .map(row => [new Date(row[timeIdx]).getTime(), row[valIdx]]);
                                    }
                                }
                                drawComparisonChart(activeRuns);
                                if (activeRuns.length >= 2) buildSummaryTable(activeRuns);
                            } catch(e) { console.error(e); }
                            hideLoading();
                        }
                    }
                });
                varList.appendChild(el);
            });
    }

    varSearch.addEventListener('input', renderVarList);

    // ─── ARTICLE AUTOCOMPLETE ────────────────────────────────────────────────
    articleInput.addEventListener('input', () => {
        const q = articleInput.value.trim().toLowerCase();
        if (!q || allRuns.length === 0) { articleSugg.style.display = 'none'; return; }
        const matches = [...new Set(allRuns.map(r => extractArticle(r.production_order)))].filter(a => a && a.toLowerCase().includes(q));
        if (matches.length === 0) { articleSugg.style.display = 'none'; return; }
        articleSugg.innerHTML = '';
        matches.slice(0, 10).forEach(a => {
            const el = document.createElement('div');
            el.style.cssText = 'padding: 8px 12px; cursor: pointer; font-size: 0.8rem; border-bottom: 1px solid rgba(255,255,255,0.05);';
            el.textContent = a;
            el.addEventListener('click', () => { articleInput.value = a; articleSugg.style.display = 'none'; });
            el.addEventListener('mouseover', () => el.style.background = 'rgba(88,166,255,0.1)');
            el.addEventListener('mouseout',  () => el.style.background = 'transparent');
            articleSugg.appendChild(el);
        });
        articleSugg.style.display = 'block';
    });
    document.addEventListener('click', e => { if (!articleSugg.contains(e.target) && e.target !== articleInput) articleSugg.style.display = 'none'; });

    function extractArticle(po) {
        if (!po) return null;
        const match = po.match(/\d{6,}/);
        return match ? match[0] : po;
    }

    // ─── LOAD PRODUCTION RUNS ───────────────────────────────────────────────
    loadRunsBtn.addEventListener('click', loadProductionRuns);

    async function loadProductionRuns() {
        const machineId = machineFilter.value;
        if (!machineId) { alert("Please select a machine first."); return; }

        showLoading("Fetching production runs...");
        try {
            const start = new Date(startInput.value).toISOString();
            const end   = new Date(endInput.value).toISOString();
            let q = `?machine=${machineId}&start=${start}&end=${end}`;
            let runs = [], cursor = "";
            do {
                const urlQ = cursor ? `${q}&cursor=${encodeURIComponent(cursor)}` : q;
                const res = await fetch(`${PROXY_BASE}/proxy/production-runs${urlQ}`, { headers: HEADERS });
                const json = await res.json();
                runs = runs.concat(json.data || []);
                cursor = json.metadata?.next_cursor;
                loadingMsg.innerText = `Fetched ${runs.length} runs...`;
            } while (cursor);

            allRuns = runs;
            selectedRunIds.clear();
            applyArticleFilter();
        } catch(e) {
            console.error(e);
            alert("Failed to load production runs.");
        }
        hideLoading();
    }

    function applyArticleFilter() {
        const articleQuery = articleInput.value.trim().toLowerCase();
        let filtered = allRuns;
        if (articleQuery) {
            filtered = allRuns.filter(r => {
                const art = extractArticle(r.production_order);
                return art && art.toLowerCase().includes(articleQuery);
            });
        }
        renderRunsList(filtered);
    }

    articleInput.addEventListener('change', applyArticleFilter);

    function renderRunsList(runs) {
        runCount.textContent = `(${runs.length} runs)`;
        if (runs.length === 0) {
            runsList.innerHTML = '<div class="empty-state"><p>No production runs found for this filter. Try expanding the date range.</p></div>';
            return;
        }

        runsList.innerHTML = '';
        runs.sort((a,b) => new Date(b.start) - new Date(a.start));

        runs.forEach(run => {
            const qScore = run.quality?.score ?? 0;
            const perf   = run.performance?.score ?? 0;
            const avail  = run.availability?.score ?? 0;
            const composite = ((qScore + perf + avail) / 3 * 100).toFixed(0);
            const scoreCls = composite >= 85 ? 'score-hi' : composite >= 65 ? 'score-mid' : 'score-lo';

            const startDt = new Date(run.start);
            const dateStr = startDt.toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'2-digit'});
            const timeStr = startDt.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'});

            const article = extractArticle(run.production_order) || '—';
            const qty = run.quantity_yield?.value ? `${Math.round(run.quantity_yield.value)} ${run.quantity_yield.unit}` : '—';

            const row = document.createElement('div');
            row.className = 'run-row' + (selectedRunIds.has(run.uuid) ? ' selected' : '');
            row.dataset.uuid = run.uuid;
            row.innerHTML = `
                <div class="run-check"></div>
                <div>
                    <div class="run-po" title="${run.production_order}">${run.production_order || article}</div>
                    <div class="run-date">${dateStr} ${timeStr}</div>
                </div>
                <div class="run-qty">${qty}</div>
                <div class="run-score ${scoreCls}">${composite}%</div>
            `;
            row.addEventListener('click', () => toggleRunSelection(run, row));
            runsList.appendChild(row);
        });
    }

    function toggleRunSelection(run, rowEl) {
        if (selectedRunIds.has(run.uuid)) {
            selectedRunIds.delete(run.uuid);
            rowEl.classList.remove('selected');
        } else {
            if (selectedRunIds.size >= 4) { alert("Maximum 4 runs can be selected for comparison."); return; }
            selectedRunIds.add(run.uuid);
            rowEl.classList.add('selected');
        }
        updateCompareUI();
    }

    function updateCompareUI() {
        const count = selectedRunIds.size;
        compareBtn.style.display = count >= 1 ? 'block' : 'none';

        // Update pills
        if (count === 0) {
            selectedPills.innerHTML = '<span style="color: var(--text-secondary); font-size: 0.75rem;">Select 2 or more runs from the table above to compare their variable overlays.</span>';
            qualityCards.innerHTML = 'Select runs to see quality KPIs.';
            return;
        }

        const selectedRuns = allRuns.filter(r => selectedRunIds.has(r.uuid));
        selectedPills.innerHTML = selectedRuns.map((r, idx) => {
            const art = extractArticle(r.production_order);
            const dt  = new Date(r.start).toLocaleDateString('en-GB',{day:'2-digit',month:'short'});
            return `<div class="run-pill"><div class="pill-dot" style="background:${colors[idx]}"></div>${art} · ${dt}</div>`;
        }).join('');

        // Quality cards
        qualityCards.innerHTML = selectedRuns.map((r, idx) => {
            const q = (r.quality?.score * 100 || 0).toFixed(0);
            const p = (r.performance?.score * 100 || 0).toFixed(0);
            const a = (r.availability?.score * 100 || 0).toFixed(0);
            const dt = new Date(r.start).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'2-digit'});
            return `
            <div style="border: 1px solid ${colors[idx]}33; border-radius: 6px; padding: 10px 12px;">
                <div style="font-size: 0.7rem; color: ${colors[idx]}; font-weight: 700; margin-bottom: 6px;">${r.production_order || 'Run '+(idx+1)} · ${dt}</div>
                <div style="display: grid; grid-template-columns: repeat(3,1fr); gap: 6px; text-align: center;">
                    <div><div style="font-size: 1rem; font-weight: 800; color: var(--text-primary);">${q}%</div><div style="font-size: 0.6rem; color: var(--text-secondary);">QUALITY</div></div>
                    <div><div style="font-size: 1rem; font-weight: 800; color: var(--text-primary);">${p}%</div><div style="font-size: 0.6rem; color: var(--text-secondary);">PERFORMANCE</div></div>
                    <div><div style="font-size: 1rem; font-weight: 800; color: var(--text-primary);">${a}%</div><div style="font-size: 0.6rem; color: var(--text-secondary);">AVAILABILITY</div></div>
                </div>
                ${r.quantity_yield?.value ? `<div style="margin-top:6px; font-size:0.7rem; color: #3fb950; font-weight:700;">Yield: ${Math.round(r.quantity_yield.value)} ${r.quantity_yield.unit} &nbsp;|&nbsp; Scrap: ${Math.round(r.quantity_scrap?.value||0)} ${r.quantity_scrap?.unit||''}</div>` : ''}
            </div>`;
        }).join('');
    }

    // ─── COMPARE BUTTON: fetch timeseries for selected runs ─────────────────
    compareBtn.addEventListener('click', async () => {
        if (selectedVarIds.size === 0) { alert("Please select at least one variable from the 'Variable Overlays' panel on the left."); return; }

        showLoading("Fetching timeseries for comparison...");
        const machineId = machineFilter.value;
        const selectedRuns = allRuns.filter(r => selectedRunIds.has(r.uuid));
        const varPayload = Array.from(selectedVarIds).map(id => ({ uuid: id, resampling_method: "avg" }));

        runDataCache = {};
        for (const [ri, run] of selectedRuns.entries()) {
            loadingMsg.innerText = `Fetching run ${ri+1} of ${selectedRuns.length}...`;
            try {
                const body = {
                    machine: machineId,
                    start: run.start,
                    end: run.end,
                    resampling_interval: 600,
                    variables: varPayload
                };
                const res = await fetch(`${PROXY_BASE}/proxy/timeseries`, {
                    method: 'POST', headers: HEADERS, body: JSON.stringify(body)
                });
                const json = await res.json();
                const chunk = json.data;
                if (chunk?.columns && chunk?.records) {
                    const timeIdx = chunk.columns.indexOf('time');
                    const varMap = {};
                    Array.from(selectedVarIds).forEach(vid => varMap[vid] = []);
                    chunk.records.forEach(row => {
                        const ts = new Date(row[timeIdx]).getTime();
                        chunk.columns.forEach((col, ci) => {
                            if (ci !== timeIdx && varMap[col] !== undefined && row[ci] !== null) {
                                varMap[col].push([ts, row[ci]]);
                            }
                        });
                    });
                    runDataCache[run.uuid] = varMap;
                }
            } catch(e) { console.error(`Run ${run.uuid} failed`, e); }
        }

        drawComparisonChart(selectedRuns);
        buildSummaryTable(selectedRuns);
        hideLoading();
    });

    // ─── CHART DRAWING ───────────────────────────────────────────────────────
    function drawComparisonChart(selectedRuns) {
        const container = document.getElementById('compareChart');
        container.innerHTML = '';
        if (!chart) {
            chart = echarts.init(container, 'dark', { renderer: 'canvas' });
        } else {
            chart.dispose();
            chart = echarts.init(container, 'dark', { renderer: 'canvas' });
        }
        window.addEventListener('resize', () => chart?.resize());

        const series = [];
        const yAxes = [];
        const varArr = availableVars.filter(v => selectedVarIds.has(v.uuid));

        varArr.forEach((v, vi) => {
            selectedRuns.forEach((run, ri) => {
                const data = runDataCache[run.uuid]?.[v.uuid] || [];
                const runDt = new Date(run.start).toLocaleDateString('en-GB',{day:'2-digit',month:'short'});
                const col = colors[ri % colors.length];
                const isDash = ri > 0;
                series.push({
                    name: `${v.display_name} · ${runDt}`,
                    type: 'line',
                    data: data,
                    smooth: true,
                    symbol: 'none',
                    lineStyle: { width: 2, color: col, type: isDash ? 'dashed' : 'solid' },
                    yAxisIndex: vi
                });
            });

            yAxes.push({
                type: 'value',
                name: v.display_name.length > 16 ? v.display_name.substring(0,16)+'…' : v.display_name,
                position: vi % 2 === 0 ? 'left' : 'right',
                offset: Math.floor(vi / 2) * 60,
                splitLine: { show: vi === 0, lineStyle: { color: 'rgba(255,255,255,0.05)' } },
                axisLabel: { fontSize: 10, color: '#8b949e' },
                nameTextStyle: { fontSize: 9, color: '#8b949e' }
            });
        });

        chart.setOption({
            backgroundColor: 'transparent',
            tooltip: { trigger: 'axis', axisPointer: { type: 'cross' }, backgroundColor: 'rgba(13,17,23,0.9)', textStyle: { color: '#f0f6fc' }, borderColor: '#30363d' },
            legend: { show: true, bottom: 0, type: 'scroll', textStyle: { color: '#8b949e', fontSize: 10 } },
            grid: { left: '5%', right: `${Math.max(1, Math.floor(varArr.length/2)) * 60 + 20}px`, bottom: '15%', top: '8%', containLabel: true },
            dataZoom: [{ type: 'inside' }, { start: 0, end: 100, textStyle: { color: '#8b949e' } }],
            xAxis: { type: 'time', splitLine: { show: false }, axisLabel: { color: '#8b949e' }, axisLine: { lineStyle: { color: '#30363d' } } },
            yAxis: yAxes,
            series
        }, true);
    }

    // ─── SUMMARY TABLE ───────────────────────────────────────────────────────
    function buildSummaryTable(selectedRuns) {
        if (selectedRuns.length < 2) return;
        const run1 = selectedRuns[0];
        const run2 = selectedRuns[1];
        const dt1  = new Date(run1.start).toLocaleDateString('en-GB',{day:'2-digit',month:'short'});
        const dt2  = new Date(run2.start).toLocaleDateString('en-GB',{day:'2-digit',month:'short'});
        colRun1.innerHTML = `<span style="color:${colors[0]}">${extractArticle(run1.production_order)}</span><br><small>${dt1}</small>`;
        colRun2.innerHTML = `<span style="color:${colors[1]}">${extractArticle(run2.production_order)}</span><br><small>${dt2}</small>`;

        const varArr = availableVars.filter(v => selectedVarIds.has(v.uuid));
        summaryBody.innerHTML = '';
        varArr.forEach((v, vi) => {
            const data1 = runDataCache[run1.uuid]?.[v.uuid] || [];
            const data2 = runDataCache[run2.uuid]?.[v.uuid] || [];
            const avg1 = data1.length ? (data1.reduce((a,b) => a + b[1], 0) / data1.length) : null;
            const avg2 = data2.length ? (data2.reduce((a,b) => a + b[1], 0) / data2.length) : null;
            const delta = (avg1 !== null && avg2 !== null) ? avg2 - avg1 : null;
            const deltaPct = (avg1 && delta !== null && avg1 !== 0) ? ((delta/avg1)*100).toFixed(1) : null;
            const col = colors[vi % colors.length];
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><span class="var-badge" style="background:${col};"></span>${v.display_name}</td>
                <td>${avg1 !== null ? avg1.toFixed(2) : '—'}</td>
                <td>${avg2 !== null ? avg2.toFixed(2) : '—'}</td>
                <td>${delta !== null ? `<span class="${delta >= 0 ? 'delta-pos' : 'delta-neg'}">${delta >= 0 ? '+' : ''}${delta.toFixed(2)}${deltaPct ? ` (${delta>=0?'+':''}${deltaPct}%)` : ''}</span>` : '—'}</td>
            `;
            summaryBody.appendChild(tr);
        });
    }

    // ─── CLEAR BUTTON ────────────────────────────────────────────────────────
    clearRunsBtn.addEventListener('click', () => {
        selectedRunIds.clear();
        renderRunsList(allRuns);
        updateCompareUI();
        summaryBody.innerHTML = '<tr><td colspan="4" style="color: var(--text-secondary); padding: 20px; text-align: center;">Compare runs to see parameter differences.</td></tr>';
        if (chart) { chart.dispose(); chart = null; document.getElementById('compareChart').innerHTML = '<div class="empty-state" style="height:100%;"><p>Select runs and a variable to compare production configurations.</p></div>'; }
    });

    // ─── UTIL ────────────────────────────────────────────────────────────────
    function showLoading(msg) { loadingMsg.innerText = msg || "Loading..."; loadingOverlay.classList.add('active'); }
    function hideLoading()    { loadingOverlay.classList.remove('active'); }
});
