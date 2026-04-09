/**
 * analyzer_v4.js — Recipe Intelligence Engine V4
 * Features: Insights Engine, Resilient graphing, Quick Dates
 */

document.addEventListener('DOMContentLoaded', async () => {
    const PROXY_BASE = window.location.origin;
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
    const compareChart   = document.getElementById('compareChart');
    const showInsightsBtn= document.getElementById('showInsightsBtn');
    const insightsModal  = document.getElementById('insightsModal');
    const closeInsights  = document.getElementById('closeInsightsBtn');
    const insightsModalContent = document.getElementById('insightsModalContent');
    const refreshBtn     = document.getElementById('refreshBtn');
    const exportBtn      = document.getElementById('exportBtn');

    // Quick Date Pills
    const datePills = document.querySelectorAll('.date-pill');
    
    function setDateRange(days) {
        const now = new Date();
        const start = new Date();
        if (days === 'all') {
            start.setFullYear(start.getFullYear() - 5);
        } else {
            start.setDate(now.getDate() - parseInt(days));
        }
        const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        startInput.value = fmt(start);
        endInput.value   = fmt(now);
    }
    
    datePills.forEach(pill => {
        pill.addEventListener('click', () => {
            datePills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            setDateRange(pill.dataset.days);
        });
    });
    
    // Init default 90D
    setDateRange(90);

    const colors = ['#58a6ff','#3fb950','#f85149','#a371f7','#d29922','#2f81f7','#e3b341','#00ffff','#ff8800', '#ff69b4', '#00ced1', '#ff1493'];

    // UI Listeners
    refreshBtn.addEventListener('click', () => {
        if (machineFilter.value) { loadRunsBtn.click(); } else { alert('Please select a machine first.'); }
    });
    
    exportBtn.addEventListener('click', exportSummaryCSV);
    
    showInsightsBtn.addEventListener('click', () => {
        insightsModal.classList.add('active');
    });
    
    closeInsights.addEventListener('click', () => {
        insightsModal.classList.remove('active');
    });

    let allMachines     = [];
    let allSites        = {};
    let allProducts     = {};
    let allRuns         = [];
    let selectedRunIds  = new Set();
    let availableVars   = [];
    let selectedVarIds  = new Set();
    let runDataCache    = {};
    let chart           = null;

    // ─── INIT: load locations and machines ──────────────────────────────────
    showLoading("Connecting to API...");
    try {
        const [machRes, siteRes] = await Promise.all([
            fetch(`${PROXY_BASE}/proxy/machines`, { headers: HEADERS }).catch(e=>({ok:false})),
            fetch(`${PROXY_BASE}/proxy/sites`, { headers: HEADERS }).catch(e=>({ok:false}))
        ]);
        
        if (machRes.ok) {
            const machData = await machRes.json();
            allMachines = machData.data || [];
        }
        if (siteRes.ok) {
            const siteData = await siteRes.json();
            (siteData.data || []).forEach(s => { allSites[s.uuid] = s.name || s.display_name || s.uuid; });
        }
        allMachines.forEach(m => {
            if (m.site && !allSites[m.site]) allSites[m.site] = m.site.substring(0, 8);
        });

        locationFilter.innerHTML = '<option value="">— All Plants —</option>';
        Object.entries(allSites).forEach(([id, name]) => {
            locationFilter.innerHTML += `<option value="${id}">${name}</option>`;
        });

        loadingMsg.innerText = "Syncing article database...";
        let cursor = "";
        do {
            const res = await fetch(`${PROXY_BASE}/proxy/products?limit=500${cursor ? '&cursor='+encodeURIComponent(cursor) : ''}`, { headers: HEADERS });
            if (!res.ok) break;
            const json = await res.json();
            (json.data || []).forEach(p => { allProducts[p.uuid] = p.external_id || p.name || p.uuid; });
            cursor = json.metadata?.next_cursor;
        } while (cursor);

        populateMachines(null);
        hideLoading();
    } catch(e) {
        console.error(e);
        hideLoading();
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
        showLoading("Fetching variables...");
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
                        if (Object.keys(runDataCache).length > 0 && selectedRunIds.size > 0) {
                            if (selectedVarIds.size === 0) {
                                if (chart) chart.dispose(); chart = null;
                                compareChart.innerHTML = '<div class="empty-state" style="height:100%;"><p>Select variables to compare.</p></div>';
                            } else {
                                drawComparisonChart(allRuns.filter(r => selectedRunIds.has(r.uuid)));
                            }
                            buildSummaryTable(allRuns.filter(r => selectedRunIds.has(r.uuid)));
                        }
                    } else { 
                        selectedVarIds.add(v.uuid); 
                        el.classList.add('active');
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
                                        const timeIdx = json.data.columns.findIndex(c => c.toLowerCase() === 'time');
                                        const valIdx = json.data.columns.findIndex(c => c.includes(v.uuid));
                                        
                                        if (timeIdx > -1 && valIdx > -1) {
                                            runDataCache[run.uuid][v.uuid] = json.data.records
                                                .filter(row => row[valIdx] !== null && row[timeIdx] !== null)
                                                .map(row => [new Date(row[timeIdx]).getTime(), row[valIdx]])
                                                .sort((a,b) => a[0] - b[0]);
                                        }
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
        applyArticleFilter(); // Make filter instantly interactive!
        
        const q = articleInput.value.trim().toLowerCase();
        if (!q || allRuns.length === 0) { articleSugg.style.display = 'none'; return; }
        const matches = [...new Set(allRuns.map(r => extractArticle(r)))].filter(a => a && a.toLowerCase().includes(q));
        if (matches.length === 0) { articleSugg.style.display = 'none'; return; }
        articleSugg.innerHTML = '';
        matches.slice(0, 10).forEach(a => {
            const el = document.createElement('div');
            el.style.cssText = 'padding: 8px 12px; cursor: pointer; font-size: 0.8rem; border-bottom: 1px solid rgba(255,255,255,0.05);';
            el.textContent = a;
            el.addEventListener('click', () => { articleInput.value = a; articleSugg.style.display = 'none'; applyArticleFilter(); });
            el.addEventListener('mouseover', () => el.style.background = 'rgba(88,166,255,0.1)');
            el.addEventListener('mouseout',  () => el.style.background = 'transparent');
            articleSugg.appendChild(el);
        });
        articleSugg.style.display = 'block';
    });
    document.addEventListener('click', e => { if (!articleSugg.contains(e.target) && e.target !== articleInput) articleSugg.style.display = 'none'; });

    function extractArticle(run) {
        if (!run) return null;
        if (run.product && allProducts[run.product]) return String(allProducts[run.product]);
        const po = run.production_order;
        if (!po) return null;
        const match = String(po).match(/\d{6,}/);
        return match ? match[0] : String(po);
    }

    // ─── LOAD PRODUCTION RUNS ───────────────────────────────────────────────
    loadRunsBtn.addEventListener('click', async () => {
        const machineId = machineFilter.value;
        if (!machineId) { alert("Please select a machine first."); return; }

        showLoading("Fetching production runs...");
        try {
            const start = new Date(startInput.value).toISOString();
            const end   = new Date(endInput.value).toISOString();
            let q = `?machine=${machineId}&start=${start}&end=${end}`;
            let runs = [], cursor = "";
            let limit = 0;
            do {
                const urlQ = cursor ? `${q}&cursor=${encodeURIComponent(cursor)}` : q;
                const res = await fetch(`${PROXY_BASE}/proxy/production-runs${urlQ}`, { headers: HEADERS });
                const json = await res.json();
                runs = runs.concat(json.data || []);
                cursor = json.metadata?.next_cursor;
                loadingMsg.innerText = `Fetched ${runs.length} runs...`;
                limit++;
                if (limit > 10) break; // Safeguard
            } while (cursor);

            allRuns = runs;
            selectedRunIds.clear();
            applyArticleFilter();
            
        } catch(e) {
            console.error(e);
            alert("Failed to load production runs.");
        }
        hideLoading();
    });

    function applyArticleFilter() {
        const articleQuery = articleInput.value.trim().toLowerCase();
        let filtered = allRuns;
        if (articleQuery) {
            filtered = allRuns.filter(r => {
                const art = extractArticle(r);
                return art && art.toLowerCase().includes(articleQuery);
            });
        }
        renderRunsList(filtered);
        generateInsights(filtered);
    }

    articleInput.addEventListener('change', applyArticleFilter);

    // ─── GENERATE INSIGHTS (V4) ───────────────────────────────────────────────
    function getOEE(r) { return (((r.quality?.score||0)+(r.performance?.score||0)+(r.availability?.score||0))/3)*100; }

    function generateInsights(runs) {
        if (runs.length === 0) {
            showInsightsBtn.style.display = 'none';
            return; 
        }

        const validRuns = runs.filter(r => getOEE(r) > 0);
        if (validRuns.length === 0) {
            showInsightsBtn.style.display = 'none';
            return;
        }

        showInsightsBtn.style.display = 'flex';

        // Calculate statistics
        let bestRun = null, worstRun = null;
        let maxOEE = -1, minOEE = 101, totalOEE = 0;
        let totalYield = 0, runsWithYield = 0;

        validRuns.forEach(r => {
            const oee = getOEE(r);
            totalOEE += oee;
            if (oee > maxOEE) { maxOEE = oee; bestRun = r; }
            if (oee < minOEE) { minOEE = oee; worstRun = r; }
            
            if (r.quantity_yield?.value) {
                totalYield += r.quantity_yield.value;
                runsWithYield++;
            }
        });

        const avgOEE = totalOEE / validRuns.length;
        const avgYield = runsWithYield > 0 ? Math.round(totalYield / runsWithYield) : 0;
        
        const formatRun = (r) => {
            const d = new Date(r.start).toLocaleDateString();
            return `<b>${r.production_order||'Unknown'}</b> on ${d}`;
        };

        const html = `
        <div style="display:flex; flex-direction:column; height:100%; justify-content:center; gap:16px; animation: floatIn 0.5s ease-out;">
            <div style="font-size: 0.85rem; color: var(--text-secondary); text-align: center; margin-bottom: 10px;">
                Found <b style="color:#fff;">${runs.length}</b> production runs in this range.<br>Select runs below to compare, or review the high-level insights.
            </div>
            
            <div style="display:flex; gap:16px; margin: 0 40px;">
                <div class="insight-card overall">
                    <div class="insight-title">Average Performance</div>
                    <div class="insight-val" style="color:var(--accent);">${avgOEE.toFixed(1)}% <span style="font-size:0.6em; color:var(--text-secondary);">OEE</span></div>
                    <div class="insight-sub">Avg Yield: ${avgYield > 0 ? avgYield : 'N/A'} units</div>
                </div>
                
                <div class="insight-card best">
                    <div class="insight-title">Best Run</div>
                    <div class="insight-val" style="color:#3fb950;">${maxOEE.toFixed(0)}% <span style="font-size:0.6em; color:var(--text-secondary);">OEE</span></div>
                    <div class="insight-sub">${formatRun(bestRun)}</div>
                </div>
                
                <div class="insight-card worst">
                    <div class="insight-title">Lowest Run</div>
                    <div class="insight-val" style="color:#f85149;">${minOEE.toFixed(0)}% <span style="font-size:0.6em; color:var(--text-secondary);">OEE</span></div>
                    <div class="insight-sub">${formatRun(worstRun)}</div>
                </div>
            </div>
            
            <div style="margin-top:20px; font-size: 0.75rem; color: #8b949e; text-align:center; padding: 0 60px;">
                <i>Insight:</i> The most optimal performance was achieved during ${formatRun(bestRun)}. To understand why, return to the dashboard, select it alongside ${formatRun(worstRun)}, and select variables to compare parameter configurations.
            </div>
        </div>
        `;
        
        insightsModalContent.innerHTML = html;
        if(lucide) lucide.createIcons();
        // Removed intrusive auto-popup: User must explicitly click 'View Insights' to see it!
    }

    function renderRunsList(runs) {
        runCount.textContent = `(${runs.length} runs)`;
        if (runs.length === 0) {
            runsList.innerHTML = '<div class="empty-state"><p>No production runs found.</p></div>';
            return;
        }

        runsList.innerHTML = '';
        runs.sort((a,b) => new Date(b.start) - new Date(a.start));

        runs.forEach(run => {
            const composite = getOEE(run);
            const scoreCls = composite >= 85 ? 'score-hi' : composite >= 65 ? 'score-mid' : 'score-lo';
            const startDt = new Date(run.start);
            const dateStr = startDt.toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'2-digit'});
            const timeStr = startDt.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'});
            const article = extractArticle(run) || '—';
            const qty = run.quantity_yield?.value ? `${Math.round(run.quantity_yield.value)}` : '—';

            const row = document.createElement('div');
            row.className = 'run-row' + (selectedRunIds.has(run.uuid) ? ' selected' : '');
            row.dataset.uuid = run.uuid;
            row.innerHTML = `
                <div class="run-check"></div>
                <div>
                    <div class="run-po" title="Item / Article: ${article}" style="font-weight:700; color:#fff;">Item: ${article}</div>
                    <div class="run-date" style="font-size:0.7em; margin-top:2px;" title="Production Order: ${run.production_order}">PO: ${run.production_order}</div>
                    <div class="run-date" style="font-size:0.7em; opacity:0.7;">${dateStr} ${timeStr}</div>
                </div>
                <div class="run-qty">${qty}</div>
                <div class="run-score ${scoreCls}">${composite.toFixed(0)}%</div>
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

        if (count === 0) {
            selectedPills.innerHTML = '<span style="color: var(--text-secondary); font-size: 0.75rem;">Select 2 or more runs from the table above to compare their variable overlays.</span>';
            qualityCards.innerHTML = '<div class="empty-state" style="font-size:0.72rem;">Select runs to see KPIs.</div>';
            return;
        }

        const selectedRuns = allRuns.filter(r => selectedRunIds.has(r.uuid));
        selectedPills.innerHTML = selectedRuns.map((r, idx) => {
            const art = extractArticle(r);
            const dt  = new Date(r.start).toLocaleDateString('en-GB',{day:'2-digit',month:'short'});
            return `<div class="run-pill"><div class="pill-dot" style="background:${colors[idx]}"></div>${art} · ${dt}</div>`;
        }).join('');

        qualityCards.innerHTML = selectedRuns.map((r, idx) => {
            const q = (r.quality?.score * 100 || 0).toFixed(0);
            const p = (r.performance?.score * 100 || 0).toFixed(0);
            const a = (r.availability?.score * 100 || 0).toFixed(0);
            const dt = new Date(r.start).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'2-digit'});
            return `
            <div style="border: 1px solid ${colors[idx]}33; border-radius: 6px; padding: 10px 12px; margin-bottom: 8px;">
                <div style="font-size: 0.7rem; color: ${colors[idx]}; font-weight: 700; margin-bottom: 6px;">${r.production_order || 'Run '+(idx+1)} · ${dt}</div>
                <div style="display: grid; grid-template-columns: repeat(3,1fr); gap: 6px; text-align: center;">
                    <div><div style="font-size: 1rem; font-weight: 800; color: var(--text-primary);">${q}%</div><div style="font-size: 0.6rem; color: var(--text-secondary);">QUALITY</div></div>
                    <div><div style="font-size: 1rem; font-weight: 800; color: var(--text-primary);">${p}%</div><div style="font-size: 0.6rem; color: var(--text-secondary);">PERFORMANCE</div></div>
                    <div><div style="font-size: 1rem; font-weight: 800; color: var(--text-primary);">${a}%</div><div style="font-size: 0.6rem; color: var(--text-secondary);">AVAILABILITY</div></div>
                </div>
                ${r.quantity_yield?.value ? `<div style="margin-top:6px; font-size:0.7rem; color: #3fb950; font-weight:700;">Yield: ${Math.round(r.quantity_yield.value)} ${r.quantity_yield.unit}</div>` : ''}
            </div>`;
        }).join('');
    }

    // ─── COMPARE BUTTON ────────────────────────────────────────────────────────
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
                    machine: machineId, start: run.start, end: run.end,
                    resampling_interval: 600, variables: varPayload
                };
                const res = await fetch(`${PROXY_BASE}/proxy/timeseries`, {
                    method: 'POST', headers: HEADERS, body: JSON.stringify(body)
                });
                const json = await res.json();
                const chunk = json.data;
                if (chunk?.columns && chunk?.records) {
                    const timeIdx = chunk.columns.findIndex(c => c.toLowerCase() === 'time');
                    if (timeIdx === -1) continue;

                    const varMap = {};
                    Array.from(selectedVarIds).forEach(vid => varMap[vid] = []);
                    
                    chunk.records.forEach(row => {
                        const ts = new Date(row[timeIdx]).getTime();
                        chunk.columns.forEach((colStr, ci) => {
                            if (ci === timeIdx) return;
                            // Resilient matching of UUID inside column name
                            const matchedVarId = Array.from(selectedVarIds).find(vid => colStr.includes(vid));
                            if (matchedVarId && row[ci] !== null) {
                                varMap[matchedVarId].push([ts, row[ci]]);
                            }
                        });
                    });
                    
                    // Bug Fix: ECharts needs sorted data
                    Array.from(selectedVarIds).forEach(vid => {
                        varMap[vid].sort((a,b) => a[0] - b[0]);
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
        if (!compareChart) return;
        
        if (!chart) {
            compareChart.innerHTML = ''; // wipe insights
            chart = echarts.init(compareChart, 'dark', { renderer: 'canvas' });
        } else {
            chart.dispose();
            chart = echarts.init(compareChart, 'dark', { renderer: 'canvas' });
        }
        window.addEventListener('resize', () => chart?.resize());

        const series = [];
        const yAxes = [];
        const varArr = availableVars.filter(v => selectedVarIds.has(v.uuid));

        varArr.forEach((v, vi) => {
            selectedRuns.forEach((run, ri) => {
                const data = runDataCache[run.uuid]?.[v.uuid] || [];
                const runDt = new Date(run.start).toLocaleDateString('en-GB',{day:'2-digit',month:'short'});
                
                // Give each combination of Variable & Run a DISTINCT color
                const colorIdx = (vi * selectedRuns.length + ri) % colors.length;
                const col = colors[colorIdx];
                const isDash = ri > 0;
                
                // Align runs on the X-axis for comparison by centering them locally if desired, 
                // but since these are distinct times, we just show raw times. ECharts Zoom does the rest.
                series.push({
                    name: `${v.display_name} · ${runDt}`,
                    type: 'line',
                    data: data,
                    smooth: true,
                    symbol: 'none',
                    lineStyle: { width: 2, color: col, type: isDash ? 'dashed' : 'solid' },
                    yAxisIndex: Math.min(vi, 1) // limit to 2 yAxes technically if too crowded? Let's use vi
                });
            });

            // If we have > 2 variables, ECharts axes overlap unless offset. 
            // In V4, we adjust offset dynamically better.
            const isLeft = vi % 2 === 0;
            const offset = Math.floor(vi / 2) * 50;

            yAxes.push({
                type: 'value',
                name: v.display_name.length > 14 ? v.display_name.substring(0,14)+'…' : v.display_name,
                position: isLeft ? 'left' : 'right',
                offset: offset,
                splitLine: { show: vi === 0, lineStyle: { color: 'rgba(255,255,255,0.05)' } },
                axisLabel: { fontSize: 9, color: '#8b949e' },
                nameTextStyle: { fontSize: 9, color: '#8b949e' }
            });
        });

        // Calculate grid dynamic margins
        const maxOffsetLeft = Math.floor((varArr.length - 1) / 2) * 50;
        const maxOffsetRight = Math.floor((varArr.length - 2) / 2) * 50;

        chart.setOption({
            backgroundColor: 'transparent',
            tooltip: { trigger: 'axis', axisPointer: { type: 'cross' }, backgroundColor: 'rgba(13,17,23,0.9)', textStyle: { color: '#f0f6fc' }, borderColor: '#30363d' },
            legend: { show: true, bottom: 0, padding:[10,0], type: 'scroll', textStyle: { color: '#8b949e', fontSize: 10 } },
            grid: { 
                left: `${10 + maxOffsetLeft}px`, 
                right: `${maxOffsetRight > 0 ? 30 + maxOffsetRight : 20}px`, 
                bottom: '18%', 
                top: '12%', 
                containLabel: true 
            },
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
        colRun1.innerHTML = `<span style="color:${colors[0]}">${extractArticle(run1) || 'R1'}</span><br><small>${dt1}</small>`;
        colRun2.innerHTML = `<span style="color:${colors[1]}">${extractArticle(run2) || 'R2'}</span><br><small>${dt2}</small>`;

        const varArr = availableVars.filter(v => selectedVarIds.has(v.uuid));
        summaryBody.innerHTML = '';
        varArr.forEach((v, vi) => {
            const data1 = runDataCache[run1.uuid]?.[v.uuid] || [];
            const data2 = runDataCache[run2.uuid]?.[v.uuid] || [];
            const avg1 = data1.length ? (data1.reduce((a,b) => a + b[1], 0) / data1.length) : null;
            const avg2 = data2.length ? (data2.reduce((a,b) => a + b[1], 0) / data2.length) : null;
            const delta = (avg1 !== null && avg2 !== null) ? avg2 - avg1 : null;
            const deltaPct = (avg1 && delta !== null && avg1 !== 0) ? ((delta/avg1)*100).toFixed(1) : null;
            
            const colIdx1 = (vi * selectedRuns.length + 0) % colors.length;
            const colIdx2 = (vi * selectedRuns.length + 1) % colors.length;
            
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${v.display_name}</td>
                <td><span class="var-badge" style="background:${colors[colIdx1]};"></span> ${avg1 !== null ? avg1.toFixed(2) : '—'}</td>
                <td><span class="var-badge" style="background:${colors[colIdx2]};"></span> ${avg2 !== null ? avg2.toFixed(2) : '—'}</td>
                <td>${delta !== null ? `<span class="${delta >= 0 ? 'delta-pos' : 'delta-neg'}">${delta >= 0 ? '+' : ''}${delta.toFixed(2)}${deltaPct ? ` (${delta>=0?'+':''}${deltaPct}%)` : ''}</span>` : '—'}</td>
            `;
            summaryBody.appendChild(tr);
        });
    }

    // ─── CSV EXPORT ──────────────────────────────────────────────────────────
    function exportSummaryCSV() {
        if (!chart) { alert("Nothing to export. Please run a comparison first."); return; }
        
        const selectedRuns = allRuns.filter(r => selectedRunIds.has(r.uuid));
        if (selectedRuns.length < 2) return;
        
        let csv = 'Variable,Run A,Run B,Difference\\n';
        
        const varArr = availableVars.filter(v => selectedVarIds.has(v.uuid));
        varArr.forEach(v => {
            const data1 = runDataCache[selectedRuns[0].uuid]?.[v.uuid] || [];
            const data2 = runDataCache[selectedRuns[1].uuid]?.[v.uuid] || [];
            const avg1 = data1.length ? (data1.reduce((a,b) => a + b[1], 0) / data1.length) : 0;
            const avg2 = data2.length ? (data2.reduce((a,b) => a + b[1], 0) / data2.length) : 0;
            const delta = avg2 - avg1;
            csv += `"${v.display_name}",${avg1.toFixed(3)},${avg2.toFixed(3)},${delta.toFixed(3)}\\n`;
        });
        
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `comparison_export_${new Date().getTime()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ─── CLEAR BUTTON ────────────────────────────────────────────────────────
    clearRunsBtn.addEventListener('click', () => {
        selectedRunIds.clear();
        selectedVarIds.clear();
        document.querySelectorAll('.var-item').forEach(el => el.classList.remove('active'));
        
        applyArticleFilter(); // Also re-renders insights!
        updateCompareUI();
        summaryBody.innerHTML = '<tr><td colspan="4" style="color: var(--text-secondary); padding: 20px; text-align: center;">Compare runs to see differences.</td></tr>';
        if (chart) { chart.dispose(); chart = null; }
    });

    // ─── UTIL ────────────────────────────────────────────────────────────────
    function showLoading(msg) { loadingMsg.innerText = msg || "Loading..."; loadingOverlay.classList.add('active'); }
    function hideLoading()    { loadingOverlay.classList.remove('active'); }
});
