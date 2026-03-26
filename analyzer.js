document.addEventListener('DOMContentLoaded', async () => {
    const loadingOverlay = document.getElementById('loadingOverlay');
    const machineSelect = document.getElementById('machineSelect');
    const variablesList = document.getElementById('variablesList');
    const variableSearch = document.getElementById('variableSearch');
    const chartContainer = document.getElementById('chartContainer');
    
    // Stats
    const statRecords = document.getElementById('statRecords');
    const statDays = document.getElementById('statDays');
    const statVars = document.getElementById('statVars');

    const startDateInput = document.getElementById('startDate');
    const endDateInput = document.getElementById('endDate');
    const resampleSelect = document.getElementById('resampleSelect');

    // Default dates (Last 7 days)
    const now = new Date();
    const weekAgo = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
    
    // Function to format for datetime-local (YYYY-MM-DDThh:mm)
    const toLocalFormat = (d) => {
        const p = n => n.toString().padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    
    if (startDateInput && endDateInput) {
        startDateInput.value = toLocalFormat(weekAgo);
        endDateInput.value = toLocalFormat(now);

        startDateInput.addEventListener('change', () => fetchAndPlotTimeseries());
        endDateInput.addEventListener('change', () => fetchAndPlotTimeseries());
    }
    
    if (resampleSelect) {
        resampleSelect.addEventListener('change', () => fetchAndPlotTimeseries());
    }

    const TOKEN = "aaad4edbd7e57de0f34d035176a52842900d3216";
    const HEADERS = {
        "Authorization": `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
    };

    // Always point to port 8085 (the ENLYZE proxy) regardless of which port the page was opened from
    const PROXY_BASE = `${window.location.protocol}//${window.location.hostname}:8085`;

    let currentMachineId = null;
    const chartTheme = window.CHART_THEME || 'dark';
    let chart = echarts.init(chartContainer, chartTheme, { renderer: 'canvas' });
    
    // State
    let availableVars = [];
    let selectedVarIds = new Set();
    let unifiedTimeline = [];
    let variableDataMap = {}; // varId -> array of [timestamp, value]

    const dict = {
        "Sollwert": "Setpoint", "Druck": "Pressure", "Menge": "Quantity", 
        "Geschwindigkeit": "Speed", "Beflammung": "Flaming", "Temperatur": "Temperature",
        "Abzug": "Take-off", "Heizung": "Heating", "Kuehlung": "Cooling", "Walze": "Roller",
        "Messer": "Knife", "Zug": "Tension", "Dicke": "Thickness", "Breite": "Width",
        "Wasser": "Water", "Luft": "Air", "Ofen": "Oven", "Istwert": "Actual Value",
        "Antrieb": "Drive", "Stufe": "Stage"
    };

    function translate(name) {
        if (!name) return name;
        let eng = name;
        for (const [de, en] of Object.entries(dict)) {
            const regex = new RegExp(`\\b${de}\\b`, 'gi');
            eng = eng.replace(regex, en);
        }
        if (eng !== name) {
            return `${name} [${eng}]`;
        }
        return name;
    }

    // Pre-defined color palette
    const colors = [
        '#58a6ff', '#3fb950', '#f85149', '#a371f7', '#d29922', 
        '#2f81f7', '#2ea043', '#f47067', '#bc8cff', '#e3b341',
        '#00ffff', '#ff00ff', '#00ff00', '#ffff00', '#ff8800'
    ];

    window.addEventListener('resize', () => chart.resize());
    document.getElementById('resetZoomBtn').addEventListener('click', () => {
        chart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
    });

    loadingOverlay.querySelector('p').innerText = "Connecting to API Proxy...";

    try {
        const res = await fetch(`${PROXY_BASE}/proxy/machines`, { headers: HEADERS });
        if (!res.ok) throw new Error("API Proxy failed to load machines.");
        const machineData = await res.json();
        
        machineSelect.innerHTML = '<option value="">-- Choose Machine --</option>';
        machineData.data.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.uuid;
            opt.textContent = m.name;
            machineSelect.appendChild(opt);
        });
        loadingOverlay.classList.remove('active');
    } catch (e) {
        console.error(e);
        alert("Failed to connect to the ENLYZE Proxy API. Is serve.ps1 running?");
        loadingOverlay.classList.remove('active');
    }

    machineSelect.addEventListener('change', async (e) => {
        const uuid = e.target.value;
        if (uuid) {
            await loadMachineVariables(uuid);
        }
    });

    document.getElementById('clearVarsBtn').addEventListener('click', async () => {
        selectedVarIds.clear();
        statVars.innerText = '0';
        document.querySelectorAll('.var-item.active').forEach(el => el.classList.remove('active'));
        document.getElementById('analysisResult').style.display = 'none';
        await fetchAndPlotTimeseries();
    });

    document.getElementById('runAnalysisBtn').addEventListener('click', () => {
        runStatisticalAnalysis();
    });

    variableSearch.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        Array.from(variablesList.children).forEach(el => {
            if (el.dataset.name.toLowerCase().includes(query)) {
                el.style.display = 'flex';
            } else {
                el.style.display = 'none';
            }
        });
    });

    async function loadMachineVariables(uuid) {
        currentMachineId = uuid;
        selectedVarIds.clear();
        variablesList.innerHTML = '';
        chart.clear();
        statVars.innerText = '0';
        statRecords.innerText = '0';
        statDays.innerText = '0 Days';
        
        loadingOverlay.querySelector('p').innerText = "Fetching Machine Variables...";
        loadingOverlay.classList.add('active');

        try {
            let vars = [];
            let nextCursor = "";
            do {
                const query = nextCursor ? `?machine=${uuid}&cursor=${encodeURIComponent(nextCursor)}` : `?machine=${uuid}`;
                const res = await fetch(`${PROXY_BASE}/proxy/variables${query}`, { headers: HEADERS });
                const json = await res.json();
                vars = vars.concat(json.data);
                nextCursor = json.metadata?.next_cursor;
            } while (nextCursor);

            // Filter to interesting variables (Setpoints, Speeds, Parameters, Quantities)
            const keywords = /Sollwert|Speed|Parameter|Temp|Druck|Press|Flow|Quantity|Scrap|Waste|Set|Menge/i;
            availableVars = vars.filter(v => v.display_name && keywords.test(v.display_name));
            
            // Limit to top 50 to avoid clutter
            if (availableVars.length > 50) availableVars = availableVars.slice(0, 50);

            renderVariablesList();
            loadingOverlay.classList.remove('active');
        } catch(e) {
            console.error(e);
            alert("Failed to load variables.");
            loadingOverlay.classList.remove('active');
        }
    }

    function renderVariablesList() {
        variablesList.innerHTML = '';
        availableVars.forEach((v, idx) => {
            const displayName = translate(v.display_name);
            const color = colors[idx % colors.length];
            const el = document.createElement('div');
            el.className = 'var-item';
            el.dataset.id = v.uuid;
            el.dataset.name = displayName;
            el.dataset.color = color;
            
            const dot = document.createElement('div');
            dot.className = 'var-color';
            dot.style.backgroundColor = color;
            
            const name = document.createElement('div');
            name.className = 'var-name';
            name.textContent = displayName;
            name.title = displayName;
            
            el.appendChild(dot);
            el.appendChild(name);
            
            el.addEventListener('click', () => {
                const isActive = el.classList.contains('active');
                toggleVariable(v.uuid, !isActive, el);
            });
            
            variablesList.appendChild(el);
        });
    }

    async function toggleVariable(uuid, activate, domElement) {
        if (activate) {
            domElement.classList.add('active');
            selectedVarIds.add(uuid);
        } else {
            domElement.classList.remove('active');
            selectedVarIds.delete(uuid);
        }
        
        statVars.innerText = selectedVarIds.size;
        
        // Fetch data whenever selection changes (debouncing could be added)
        await fetchAndPlotTimeseries();
    }

    async function fetchAndPlotTimeseries() {
        if (selectedVarIds.size === 0) {
            chart.clear();
            return;
        }

        loadingOverlay.querySelector('p').innerText = "Crunching Timeseries range...";
        loadingOverlay.classList.add('active');

        let start, end, diffDays, resampleVal;
        
        if (startDateInput && endDateInput && startDateInput.value) {
            start = new Date(startDateInput.value);
            end = new Date(endDateInput.value);
            diffDays = Math.round((end - start) / (1000 * 60 * 60 * 24));
        } else {
            end = new Date();
            start = new Date(end.getTime() - (90 * 24 * 60 * 60 * 1000));
            diffDays = 90;
        }
        
        resampleVal = resampleSelect ? parseInt(resampleSelect.value) : 600;

        const reqBody = {
            machine: currentMachineId,
            start: start.toISOString(),
            end: end.toISOString(),
            resampling_interval: resampleVal,
            variables: Array.from(selectedVarIds).map(id => ({ uuid: id, resampling_method: "avg" }))
        };

        try {
            variableDataMap = {};
            availableVars.forEach(v => variableDataMap[v.uuid] = []);
            
            let currentCursor = "";
            let recordCount = 0;
            let firstChunkCols = null;

            do {
                if (currentCursor) reqBody.cursor = currentCursor;
                const res = await fetch(`${PROXY_BASE}/proxy/timeseries`, {
                    method: 'POST',
                    headers: HEADERS,
                    body: JSON.stringify(reqBody)
                });
                
                if (!res.ok) throw new Error("Timeseries API failure");
                
                const tsJson = await res.json();
                const chunk = tsJson.data;

                if (chunk && chunk.columns) {
                    if (!firstChunkCols) firstChunkCols = chunk.columns;
                    const timeIdx = firstChunkCols.indexOf("time");
                    
                    chunk.records.forEach(row => {
                        const ts = new Date(row[timeIdx]).getTime();
                        recordCount++;
                        
                        for (let i = 0; i < firstChunkCols.length; i++) {
                            if (i === timeIdx) continue;
                            const vId = firstChunkCols[i];
                            if (variableDataMap[vId] && row[i] !== null) {
                                variableDataMap[vId].push([ts, row[i]]);
                            }
                        }
                    });
                }
                
                currentCursor = tsJson.metadata?.next_cursor;
                loadingOverlay.querySelector('p').innerText = `Crunching Timeseries... (${recordCount} points pulled)`;
                
            } while (currentCursor);
            
            statRecords.innerText = recordCount.toLocaleString();
            statDays.innerText = `${diffDays} Days`;

            drawChart();
            loadingOverlay.classList.remove('active');
        } catch (e) {
            console.error(e);
            alert("Failed to fetch timeseries.");
            loadingOverlay.classList.remove('active');
        }
    }

    let globalAnomalies = [];

    function runStatisticalAnalysis() {
        if (selectedVarIds.size !== 2) {
            alert("Please select exactly 2 specific variables (e.g. one Setting and one Output) to analyze process lags and correlations.");
            return;
        }
        
        const varKeys = Array.from(selectedVarIds);
        const v1Id = varKeys[0];
        const v2Id = varKeys[1];
        
        const data1 = variableDataMap[v1Id] || [];
        const data2 = variableDataMap[v2Id] || [];
        
        if (data1.length < 10 || data2.length < 10) return;
        
        const x = data1.map(pt => pt[1]);
        const y = data2.map(pt => pt[1]);
        
        const meanX = x.reduce((a,b)=>a+b,0)/x.length;
        const meanY = y.reduce((a,b)=>a+b,0)/y.length;
        
        const stdX = Math.sqrt(x.reduce((a,b)=>a+Math.pow(b-meanX,2),0)/x.length);
        const stdY = Math.sqrt(y.reduce((a,b)=>a+Math.pow(b-meanY,2),0)/y.length);
        
        // Find Anomalies (Z > 3)
        globalAnomalies = [];
        for (let i = 0; i < x.length; i++) {
            if (stdX > 0 && Math.abs((x[i]-meanX)/stdX) > 3) {
                globalAnomalies.push({ coord: [data1[i][0], x[i]], value: 'Anomaly' });
            }
            if (stdY > 0 && Math.abs((y[i]-meanY)/stdY) > 3) {
                globalAnomalies.push({ coord: [data2[i][0], y[i]], value: 'Anomaly' });
            }
        }
        
        // Cross Correlation (max lag +/- 30%)
        const maxLag = Math.min(200, Math.floor(x.length * 0.3));
        let bestCorrelation = -1;
        let bestK = 0;
        
        const pCorr = (arr1, arr2) => {
            const m1 = arr1.reduce((a,b)=>a+b,0)/arr1.length;
            const m2 = arr2.reduce((a,b)=>a+b,0)/arr2.length;
            let num = 0, den1 = 0, den2 = 0;
            for(let i=0; i<arr1.length; i++){
                const d1 = arr1[i]-m1;
                const d2 = arr2[i]-m2;
                num += d1*d2;
                den1 += d1*d1;
                den2 += d2*d2;
            }
            if(den1===0 || den2===0) return 0;
            return num / Math.sqrt(den1*den2);
        };
        
        for (let k = -maxLag; k <= maxLag; k++) {
            let sliceX, sliceY;
            if (k >= 0) {
                sliceX = x.slice(0, x.length - k);
                sliceY = y.slice(k);
            } else {
                sliceX = x.slice(-k);
                sliceY = y.slice(0, y.length + k);
            }
            const c = Math.abs(pCorr(sliceX, sliceY));
            if (c > bestCorrelation) {
                bestCorrelation = c;
                bestK = k;
            }
        }
        
        let resampleVal = 600;
        if (resampleSelect) {
            resampleVal = parseInt(resampleSelect.value);
        }
        let timeOffsetAbs = Math.abs(bestK) * resampleVal;
        
        let timeStr = "";
        if (timeOffsetAbs >= 3600) {
            timeStr = (timeOffsetAbs/3600).toFixed(1) + " hours";
        } else if (timeOffsetAbs >= 60) {
            timeStr = (timeOffsetAbs/60).toFixed(1) + " minutes";
        } else {
            timeStr = timeOffsetAbs + " seconds";
        }

        const name1 = translate(availableVars.find(v=>v.uuid===v1Id)?.display_name) || "Var 1";
        const name2 = translate(availableVars.find(v=>v.uuid===v2Id)?.display_name) || "Var 2";

        let report = `<strong>Cross-Correlation: ${(bestCorrelation*100).toFixed(1)}%</strong><br><br>`;
        if (bestK === 0) {
            report += `No time lag detected. Both occur instantly together.`;
        } else if (bestK > 0) {
             report += `<strong>${name1}</strong> leads. It happens FIRST, and <strong>${name2}</strong> reacts after a lag of <span style="color:#f85149; font-weight:bold;">${timeStr}</span>.`;
        } else {
             report += `<strong>${name2}</strong> leads. It happens FIRST, and <strong>${name1}</strong> reacts after a lag of <span style="color:#f85149; font-weight:bold;">${timeStr}</span>.`;
        }
        
        report += `<br><br><em>Detected ${globalAnomalies.length} extreme statistical anomalies (plotted below).</em>`;
        const resDiv = document.getElementById('analysisResult');
        resDiv.style.display = 'block';
        resDiv.innerHTML = report;
        
        drawChart();
    }

    function drawChart() {
        const series = [];
        const yAxes = [];
        let axisIndex = 0;

        availableVars.forEach((v, idx) => {
            if (!selectedVarIds.has(v.uuid)) return;
            
            const color = colors[idx % colors.length];
            const dataPts = variableDataMap[v.uuid];
            
            const displayName = translate(v.display_name);
            const myAnomalies = globalAnomalies.filter(a => variableDataMap[v.uuid].some(pt => pt[0] === a.coord[0] && pt[1] === a.coord[1]));
            
            series.push({
                name: displayName,
                type: 'line',
                data: dataPts,
                smooth: true,
                symbol: 'none',
                lineStyle: { width: 2, color: color },
                yAxisIndex: axisIndex,
                markPoint: myAnomalies.length > 0 ? {
                    symbol: 'pin',
                    symbolSize: 30,
                    itemStyle: { color: 'rgba(248, 81, 73, 0.8)' },
                    data: myAnomalies,
                    label: {show: false}
                } : undefined
            });
            
            yAxes.push({
                type: 'value',
                name: displayName,
                position: axisIndex % 2 === 0 ? 'left' : 'right',
                offset: Math.floor(axisIndex / 2) * 60,
                splitLine: { show: axisIndex === 0 ? true : false, lineStyle: { color: 'rgba(255,255,255,0.05)' } },
                axisLabel: { color: color, fontSize: 10 },
                nameTextStyle: { color: color, fontSize: 10, align: 'right' }
            });
            
            axisIndex++;
        });
        
        const option = {
            backgroundColor: 'transparent',
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'cross', label: { backgroundColor: '#58a6ff' } },
                backgroundColor: chartTheme === 'dark' ? 'rgba(13, 17, 23, 0.9)' : 'rgba(255, 255, 255, 0.95)',
                borderColor: chartTheme === 'dark' ? '#30363d' : '#e5e7eb',
                textStyle: { color: chartTheme === 'dark' ? '#f0f6fc' : '#111827' }
            },
            legend: { show: false },
            grid: {
                left: '5%',
                right: `${Math.max(1, Math.floor(axisIndex/2)) * 60 + 20}px`,
                bottom: '10%',
                top: '15%',
                containLabel: true
            },
            dataZoom: [
                { type: 'inside', start: 0, end: 100 },
                {
                    start: 0, end: 100,
                    textStyle: { color: '#8b949e' }
                }
            ],
            xAxis: {
                type: 'time',
                splitLine: { show: false },
                axisLine: { lineStyle: { color: chartTheme === 'dark' ? '#30363d' : '#cbd5e1' } },
                axisLabel: { color: chartTheme === 'dark' ? '#8b949e' : '#64748b' }
            },
            yAxis: yAxes,
            series: series
        };

        chart.setOption(option, true);
    }
});
