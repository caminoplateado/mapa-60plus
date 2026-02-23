/* ============================
   CONFIG — COMPLETAR
   ============================ */

const CONFIG = {
  // 1) Tu token público de Mapbox
  MAPBOX_TOKEN: (window.MAPBOX_TOKEN || ""),

  // 2) Tileset de centros urbanos (vector) subido a Mapbox
  //    Ej: "mapbox://usuario.tilesetid"
  TILESET_URL: "mapbox://crsilvamoreno.1oyei3t9",

  // 3) Nombre de source-layer dentro del tileset (se ve en Mapbox Studio)
  SOURCE_LAYER: "localidades_censales_2022-0zlcjj",

  // 4) Archivo local con la tabla (en /data)
  DATA_URL: "./data/localidades_60plus.json",
  // Vista inicial
  INITIAL_VIEW: {
    center: [-64.5, -35.0],
    zoom: 3.7
  }
};

/* ============================
   UTILIDADES
   ============================ */

const fmtInt = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });
const fmtPct = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const COLOR_RAMP = ["#f7fbff","#deebf7","#c6dbef","#9ecae1","#6baed6","#2171b5","#08306b"];

const fmtPP  = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function safePct(v){
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return Number(v);
}

function setText(id, text){
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function isTruthy(v){ return v !== null && v !== undefined && v !== "" && !Number.isNaN(v); }

/* ============================
   ZOOM / BOUNDS
   ============================ */

// bounds globales (se calcula al cargar el dataset)
let allBounds = null; // [[minLon,minLat],[maxLon,maxLat]]

function boundsFromRecords(list){
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  for (const r of list || []){
    const b = r && r.bbox;
    if (Array.isArray(b) && b.length === 4){
      const minx = Number(b[0]);
      const miny = Number(b[1]);
      const maxx = Number(b[2]);
      const maxy = Number(b[3]);
      if (![minx,miny,maxx,maxy].every(Number.isFinite)) continue;
      if (minx < minX) minX = minx;
      if (miny < minY) minY = miny;
      if (maxx > maxX) maxX = maxx;
      if (maxy > maxY) maxY = maxy;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return [[minX, minY],[maxX, maxY]];
}

function getFitPadding(){
  const sb = document.querySelector('.sidebar');
  const w = sb ? Math.round(sb.getBoundingClientRect().width) : 0;
  const stacked = window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
  const left = stacked ? 28 : Math.min(560, w + 28);
  return { top: 28, bottom: 28, left, right: 28 };
}

function fitToBounds(bounds, {duration=700, maxZoom=10.5} = {}){
  if (!map || !bounds) return;
  map.fitBounds(bounds, { padding: getFitPadding(), duration, maxZoom });
}

let _zoomT = null;
function requestAutoZoom(filtered){
  if (!map) return;
  if (!filtered || !filtered.length) return;

  // si hay localidad seleccionada explícita, preferimos el zoom a esa localidad
  if (filterState.localidadClc){
    zoomToClc(filterState.localidadClc);
    return;
  }

  clearTimeout(_zoomT);
  _zoomT = setTimeout(() => {
    const b = boundsFromRecords(filtered) || allBounds;
    if (b) fitToBounds(b, { maxZoom: 11.0 });
  }, 90);
}

/* ============================
   STATE
   ============================ */

let records = [];
let byClc = new Map();

let selectedClc = null;

let filterState = {
  provincia: "",
  localidadClc: "",
  pop: null,     // [min,max]
  pct: null,     // [min,max]
  pp: null       // [min,max]
};

// sliders refs
let slPop, slPct, slPP;

// stats caches
let allAgg = null;

// map refs
let map;
let hoveredId = null;

/* ============================
   CARGA DE DATOS
   ============================ */

async function loadData(){
  const url = CONFIG.DATA_URL;
  const lower = url.toLowerCase();

  if (lower.endsWith(".json")){
    const res = await fetch(url);
    if(!res.ok) throw new Error("No se pudo cargar DATA_URL (JSON)");
    records = await res.json();
  } else if (lower.endsWith(".csv")){
    if (!window.Papa){ throw new Error("PapaParse no está cargado (dependencia para CSV)."); }

    const res = await fetch(url);
    if(!res.ok) throw new Error("No se pudo cargar DATA_URL (CSV)");
    const txt = await res.text();
    const parsed = Papa.parse(txt, { header: true, dynamicTyping: true, skipEmptyLines: true });
    if (parsed.errors?.length) console.warn("CSV parse warnings:", parsed.errors);
    records = parsed.data;
  } else if (lower.endsWith(".xlsx")){
    if (!window.XLSX){
      console.warn("XLSX no está cargado. Intentando fallback a JSON con el mismo nombre.");
      const alt = url.replace(/\.xlsx$/i, ".json");
      return loadData(alt);
    }

    const res = await fetch(url);
    if(!res.ok) throw new Error("No se pudo cargar DATA_URL (XLSX)");
    const buf = await res.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    records = XLSX.utils.sheet_to_json(ws, { defval: null });
  } else {
    throw new Error("DATA_URL debe ser .json, .csv o .xlsx");
  }

  // Normalización / índices
  byClc = new Map();

  for(const r of records){
    // Compatibilidad con distintas cabeceras:
    // - si viene del XLSX original, usamos los nombres ya normalizados incluidos en este zip (localidades_60plus.xlsx)
    // - si viene de otro archivo, asegurate de que tenga al menos: clc, provincia (o jur), localidad (o nam)
    const rawClc = (r.clc ?? r.CLC ?? r.Clc ?? r["clc"] ?? r["CLC"]);
    let clcStr = rawClc == null ? "" : String(rawClc).trim();
    // Si viene como número, puede perder ceros a la izquierda -> padStart(8)
    clcStr = clcStr.replace(/\.0+$/, ""); // por si viene "123.0"
    if (clcStr && /^\d+$/.test(clcStr) && clcStr.length < 8) clcStr = clcStr.padStart(8, "0");
    r.clc = clcStr;

    r.provincia = String(r.provincia ?? r.jur ?? r.Provincia ?? "").trim();
    r.localidad = String(r.localidad ?? r.nam ?? r.Localidad ?? "").trim();

    r.total_2010 = Number(r.total_2010 ?? r["Total 2010"] ?? 0);
    r.total_2022 = Number(r.total_2022 ?? r["Total 2022"] ?? 0);
    r.p60_2010   = Number(r.p60_2010 ?? r["60+ 2010"] ?? 0);
    r.p60_2022   = Number(r.p60_2022 ?? r["60+ 2022"] ?? 0);

    // % como porcentaje (0–100)
    r.pct60_2010 = safePct(r.pct60_2010 ?? (r["%60+2010"] != null ? Number(r["%60+2010"]) : null));
    r.pct60_2022 = safePct(r.pct60_2022 ?? (r["%60+2022"] != null ? Number(r["%60+2022"]) : null));

    // crecimiento:
    r.growth_pp = Number(r.growth_pp ?? (r["evolución peso 60+ 99"] != null ? Number(r["evolución peso 60+ 99"]) : 0));
    r.growth60_rel_pct = safePct(r.growth60_rel_pct ?? (r["evolución60+"] != null ? Number(r["evolución60+"]) : null));

    // Conversión robusta: si el archivo trae % como proporción (0–1), lo pasamos a 0–100.
    // Decisión basada en coherencia con (60+ / total).
    if (r.pct60_2010 !== null && r.pct60_2010 <= 1.0 && r.total_2010 > 0){
      const ratio10 = r.p60_2010 / r.total_2010;
      if (Number.isFinite(ratio10) && Math.abs(ratio10 - r.pct60_2010) < 0.02) r.pct60_2010 = r.pct60_2010 * 100;
    }
    if (r.pct60_2022 !== null && r.pct60_2022 <= 1.0 && r.total_2022 > 0){
      const ratio22 = r.p60_2022 / r.total_2022;
      if (Number.isFinite(ratio22) && Math.abs(ratio22 - r.pct60_2022) < 0.02) r.pct60_2022 = r.pct60_2022 * 100;
    }

    // growth_pp: si viene como proporción (0–1), lo convertimos a puntos porcentuales.
    // Heurística: si pct60 ya está en 0–100, entonces (pct22 - pct10) debe coincidir con growth_pp.
    if (Math.abs(r.growth_pp) <= 1.0){
      if (r.pct60_2010 !== null && r.pct60_2022 !== null){
        const diff = r.pct60_2022 - r.pct60_2010; // puntos porcentuales esperados
        if (Number.isFinite(diff)){
          // si growth_pp*100 se parece a la diferencia, convertimos
          if (Math.abs(diff - r.growth_pp) > 1 && Math.abs(diff - (r.growth_pp * 100)) < 0.5){
            r.growth_pp = r.growth_pp * 100;
          }
        } else {
          r.growth_pp = r.growth_pp * 100;
        }
      } else {
        // si no hay pct, conservador: asumir proporción
        r.growth_pp = r.growth_pp * 100;
      }
    }

    // growth60_rel_pct: si viene como proporción (0–1), lo convertimos a %
    if (r.growth60_rel_pct !== null && Math.abs(r.growth60_rel_pct) <= 1.0) r.growth60_rel_pct = r.growth60_rel_pct * 100;

    r.growth60_abs = Number(r.growth60_abs ?? (r.p60_2022 - r.p60_2010));

    // Centroide/bbox (si vienen en la tabla)
    if (r.centroid_lon != null) r.centroid_lon = Number(r.centroid_lon);
    if (r.centroid_lat != null) r.centroid_lat = Number(r.centroid_lat);
    if (typeof r.bbox === "string"){
      try { r.bbox = JSON.parse(r.bbox); } catch(e) {}
    }

    byClc.set(r.clc, r);
  }

  // Mantener solo localidades con 2000+ hab (Total 2022)
  records = records.filter(r => Number(r.total_2022) >= 2000);
  // Re-armar índice por CLC con el subset
  byClc = new Map(records.map(r => [String(r.clc), r]));

  allAgg = aggregate(records);
  allBounds = boundsFromRecords(records);
  initFiltersUI();
  initMap();
}


/* ============================
   AGREGACIÓN
   ============================ */

function aggregate(list){
  const agg = {
    n: list.length,
    total10: 0, total22: 0,
    p6010: 0, p6022: 0
  };

  for(const r of list){
    agg.total10 += (r.total_2010 || 0);
    agg.total22 += (r.total_2022 || 0);
    agg.p6010   += (r.p60_2010 || 0);
    agg.p6022   += (r.p60_2022 || 0);
  }

  const pct10 = agg.total10 > 0 ? (agg.p6010 / agg.total10) * 100 : null;
  const pct22 = agg.total22 > 0 ? (agg.p6022 / agg.total22) * 100 : null;

  const pp = (pct22 !== null && pct10 !== null) ? (pct22 - pct10) : null;

  return {
    ...agg,
    pct10, pct22, pp,
    abs60: agg.p6022 - agg.p6010,
    rel60: agg.p6010 > 0 ? ((agg.p6022 / agg.p6010) - 1) * 100 : null
  };
}

/* ============================
   FILTROS
   ============================ */

function applyFilters({autoZoom=false} = {}){
  const prov = filterState.provincia;
  const locClc = filterState.localidadClc ? String(filterState.localidadClc) : null;
  const [pMin, pMax] = filterState.pop;
  const [pctMin, pctMax] = filterState.pct;
  const [ppMin, ppMax] = filterState.pp;

  const filtered = records.filter(r => {
    if (prov && r.provincia !== prov) return false;
    if (locClc && String(r.clc) !== locClc) return false;

    const pop = r.total_2022 ?? 0;
    if (pop < pMin || pop > pMax) return false;

    const pct = r.pct60_2022 ?? 0;
    if (pct < pctMin || pct > pctMax) return false;

    const pp = r.growth_pp ?? 0;
    if (pp < ppMin || pp > ppMax) return false;

    return true;
  });

  // Actualizar mapa (filtro por clc)
  const clcs = filtered.map(r => String(r.clc));

  if (map && map.getLayer("localidades-fill")){
    if (filtered.length === records.length){
      map.setFilter("localidades-fill", null);
      map.setFilter("localidades-line", null);
    } else {
      const expr = ["in", ["get","clc"], ["literal", clcs]];
      map.setFilter("localidades-fill", expr);
      map.setFilter("localidades-line", expr);
    }
  }

  // Si la selección quedó fuera, limpiar
  if (selectedClc && !clcs.includes(String(selectedClc))){
    clearSelection();
  }

  // Actualizar KPIs
  updateSidebar(filtered);

  if (autoZoom) requestAutoZoom(filtered);

  return filtered;
}

function updateSidebar(filtered){
  const usingSelection = selectedClc !== null && byClc.has(String(selectedClc));
  const scopeEl = document.getElementById("scope");

  if (usingSelection){
    const r = byClc.get(String(selectedClc));
    scopeEl.textContent = `${r.localidad} — ${r.provincia}`;
    renderKPIsFromRecord(r);
    renderDetailsFromRecord(r);
    setText("kpiCount", "1");
    return;
  }

  // Si hay localidad elegida en el selector (sin click en el mapa), mostrarla como selección
  if (!usingSelection && filterState.localidadClc){
    const key = String(filterState.localidadClc);
    const r = byClc.get(key);
    if (r){
      scopeEl.textContent = `${r.localidad} — ${r.provincia}`;
      renderKPIsFromRecord(r);
      renderDetailsFromRecord(r);
      setText("kpiCount", "1");
      return;
    }
  }

  // Sin selección: agregado según filtros
  const agg = aggregate(filtered);
  if (filtered.length === records.length && !filterState.provincia && !filterState.localidadClc){
    scopeEl.textContent = "Argentina";
  } else if (filterState.provincia && !filterState.localidadClc){
    scopeEl.textContent = `${filterState.provincia} (${filtered.length} localidades)`;
  } else {
    scopeEl.textContent = `Filtrado (${filtered.length} localidades)`;
  }

  setText("kpiCount", fmtInt.format(agg.n));
  setText("kpiTotal22", fmtInt.format(agg.total22));
  setText("kpi60_22", fmtInt.format(agg.p6022));
  setText("kpiPct22", agg.pct22 === null ? "s/d" : `${fmtPct.format(agg.pct22)}%`);
  setText("kpiPP", agg.pp === null ? "s/d" : `${fmtPP.format(agg.pp)} p.p.`);

  setText("dTotal10", fmtInt.format(agg.total10));
  setText("d60_10", fmtInt.format(agg.p6010));
  setText("dPct10", agg.pct10 === null ? "s/d" : `${fmtPct.format(agg.pct10)}%`);

  setText("dTotal22", fmtInt.format(agg.total22));
  setText("d60_22", fmtInt.format(agg.p6022));
  setText("dPct22", agg.pct22 === null ? "s/d" : `${fmtPct.format(agg.pct22)}%`);

  setText("dAbs60", fmtInt.format(agg.abs60));
  setText("dRel60", agg.rel60 === null ? "s/d" : `${fmtPct.format(agg.rel60)}%`);
}

function renderKPIsFromRecord(r){
  setText("kpiTotal22", fmtInt.format(r.total_2022));
  setText("kpi60_22", fmtInt.format(r.p60_2022));
  setText("kpiPct22", isTruthy(r.pct60_2022) ? `${fmtPct.format(r.pct60_2022)}%` : "s/d");
  setText("kpiPP", isTruthy(r.growth_pp) ? `${fmtPP.format(r.growth_pp)} p.p.` : "s/d");
}

function renderDetailsFromRecord(r){
  setText("dTotal10", fmtInt.format(r.total_2010));
  setText("d60_10", fmtInt.format(r.p60_2010));
  setText("dPct10", isTruthy(r.pct60_2010) ? `${fmtPct.format(r.pct60_2010)}%` : "s/d");

  setText("dTotal22", fmtInt.format(r.total_2022));
  setText("d60_22", fmtInt.format(r.p60_2022));
  setText("dPct22", isTruthy(r.pct60_2022) ? `${fmtPct.format(r.pct60_2022)}%` : "s/d");

  setText("dAbs60", fmtInt.format(r.growth60_abs));
  setText("dRel60", isTruthy(r.growth60_rel_pct) ? `${fmtPct.format(r.growth60_rel_pct)}%` : "s/d");
}

/* ============================
   UI: sliders + selects
   ============================ */

function initFiltersUI(){
  const selProv = document.getElementById("selProvincia");
  const selLoc  = document.getElementById("selLocalidad");

  // Provincias
  const provincias = Array.from(new Set(records.map(r => r.provincia).filter(Boolean)))
    .sort((a,b) => a.localeCompare(b, "es"));
  for(const p of provincias){
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    selProv.appendChild(opt);
  }

  // Rangos (robustos ante NaN)
  const maxPop = Math.max(0, ...records.map(r => Number(r.total_2022) || 0));

  const pctVals = records
    .map(r => Number(r.pct60_2022))
    .filter(v => Number.isFinite(v));
  const minPct = pctVals.length ? Math.min(...pctVals) : 0;
  const maxPct = pctVals.length ? Math.max(...pctVals) : 100;

  const ppVals = records
    .map(r => Number(r.growth_pp))
    .filter(v => Number.isFinite(v));
  let minPP = ppVals.length ? Math.min(...ppVals) : -5;
  let maxPP = ppVals.length ? Math.max(...ppVals) : 5;
  if (minPP === maxPP){ minPP -= 0.1; maxPP += 0.1; } // evitar rango 0

  filterState.pop = [0, maxPop];
  filterState.pct = [minPct, maxPct];
  filterState.pp  = [minPP, maxPP];

  // Helper slider (noUiSlider si está; fallback si no)
  function createDoubleSlider({ containerId, labelId, start, min, max, step, formatLabel, onChange }){
    const el = document.getElementById(containerId);
    const lab = document.getElementById(labelId);

    function setLabel(a,b){
      if (lab) lab.textContent = formatLabel(a,b);
    }

    // noUiSlider disponible
    if (window.noUiSlider){
      noUiSlider.create(el, { start, connect: true, range: { min, max }, step });
      el.noUiSlider.on("update", (values) => {
        const a = Number(values[0]);
        const b = Number(values[1]);
        setLabel(a,b);
      });
      el.noUiSlider.on("change", (values) => {
        const a = Number(values[0]);
        const b = Number(values[1]);
        onChange(a,b);
      });

      return {
        set: (a,b) => el.noUiSlider.set([a,b]),
        get: () => el.noUiSlider.get().map(Number)
      };
    }

    // Fallback: 2 sliders HTML nativos
    el.classList.add("sliderFallback");
    el.innerHTML = `
      <div class="range2">
        <input class="range2__min" type="range" min="${min}" max="${max}" step="${step}" value="${start[0]}"/>
        <input class="range2__max" type="range" min="${min}" max="${max}" step="${step}" value="${start[1]}"/>
      </div>
    `;
    const iMin = el.querySelector(".range2__min");
    const iMax = el.querySelector(".range2__max");

    function sync(triggerChange){
      let a = Number(iMin.value);
      let b = Number(iMax.value);
      if (a > b){ const t=a; a=b; b=t; }
      iMin.value = String(a);
      iMax.value = String(b);
      setLabel(a,b);
      if (triggerChange) onChange(a,b);
    }

    iMin.addEventListener("input", () => sync(false));
    iMax.addEventListener("input", () => sync(false));
    iMin.addEventListener("change", () => sync(true));
    iMax.addEventListener("change", () => sync(true));

    // inicial
    sync(false);

    return {
      set: (a,b) => { iMin.value = String(a); iMax.value = String(b); sync(true); },
      get: () => [Number(iMin.value), Number(iMax.value)]
    };
  }

  // Población
  const stepPop = Math.max(100, Math.round(maxPop / 400) || 100);
  slPop = createDoubleSlider({
    containerId: "slPop",
    labelId: "labPop",
    start: [0, maxPop],
    min: 0,
    max: maxPop,
    step: stepPop,
    formatLabel: (a,b) => `${fmtInt.format(Math.round(a))}–${fmtInt.format(Math.round(b))}`,
    onChange: (a,b) => { filterState.pop = [Math.round(a), Math.round(b)]; applyFilters({autoZoom:true}); }
  });

  // %60+ 2022
  slPct = createDoubleSlider({
    containerId: "slPct",
    labelId: "labPct",
    start: [minPct, maxPct],
    min: minPct,
    max: maxPct,
    step: 0.1,
    formatLabel: (a,b) => `${fmtPct.format(a)}–${fmtPct.format(b)}%`,
    onChange: (a,b) => { filterState.pct = [a,b]; applyFilters({autoZoom:true}); }
  });

  // Crecimiento p.p.
  slPP = createDoubleSlider({
    containerId: "slPP",
    labelId: "labPP",
    start: [minPP, maxPP],
    min: minPP,
    max: maxPP,
    step: 0.1,
    formatLabel: (a,b) => `${fmtPP.format(a)}–${fmtPP.format(b)} p.p.`,
    onChange: (a,b) => { filterState.pp = [a,b]; applyFilters({autoZoom:true}); }
  });

  // Leyenda
  setText("legMin", `${fmtPP.format(minPP)}`);
  setText("legMax", `${fmtPP.format(maxPP)}`);
  const legendBar = document.getElementById("legendBar");
  if (legendBar){
    legendBar.style.background = `linear-gradient(90deg, ${COLOR_RAMP[0]} 0%, ${COLOR_RAMP[1]} 16.6%, ${COLOR_RAMP[2]} 33.3%, ${COLOR_RAMP[3]} 50%, ${COLOR_RAMP[4]} 66.6%, ${COLOR_RAMP[5]} 83.3%, ${COLOR_RAMP[6]} 100%)`;
  }
  const legZero = document.getElementById("legZero");
  if (minPP > 0 || maxPP < 0){
    legZero.textContent = "—";
  }

  // Eventos selects
  selProv.addEventListener("change", () => {
    filterState.provincia = selProv.value;

    selLoc.innerHTML = '<option value="">Todas</option>';
    selLoc.disabled = !selProv.value;

    if (selProv.value){
      const locs = records
        .filter(r => r.provincia === selProv.value)
        .sort((a,b) => a.localidad.localeCompare(b.localidad, "es"));

      for(const r of locs){
        const opt = document.createElement("option");
        opt.value = String(r.clc);
        opt.textContent = r.localidad;
        selLoc.appendChild(opt);
      }
    }

    filterState.localidadClc = "";
    clearSelection();
    applyFilters({autoZoom:true});
  });

  selLoc.addEventListener("change", () => {
    filterState.localidadClc = selLoc.value;
    clearSelection();

    if (selLoc.value){
      applyFilters({autoZoom:false});
      zoomToClc(String(selLoc.value));
    } else {
      applyFilters({autoZoom:true});
    }
  });

  // Reset
  document.getElementById("btnReset").addEventListener("click", () => {
    selProv.value = "";
    selLoc.innerHTML = '<option value="">Todas</option>';
    selLoc.disabled = true;

    filterState.provincia = "";
    filterState.localidadClc = "";

    slPop.set(0, maxPop);
    slPct.set(minPct, maxPct);
    slPP.set(minPP, maxPP);

    clearSelection();
    applyFilters({autoZoom:true});
  });

  // limpiar selección
  document.getElementById("btnClearSel").addEventListener("click", () => {
    clearSelection();
    applyFilters({autoZoom:false});
  });

  // Sidebar inicial: país completo
  updateSidebar(records);
}


/* ============================
   MAPA
   ============================ */

function initMap(){
  mapboxgl.accessToken = CONFIG.MAPBOX_TOKEN;

  map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/dark-v11",
    center: CONFIG.INITIAL_VIEW.center,
    zoom: CONFIG.INITIAL_VIEW.zoom,
    maxZoom: 14
  });

  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new mapboxgl.ScaleControl({ maxWidth: 110, unit: "metric" }), "bottom-right");

  // Buscador de localidades (dataset) + geolocalización
  const geocoderHost = document.getElementById("geocoder");
  const btnMyLoc = document.getElementById("btnMyLoc");

  // Botón de geolocalización (el usuario clickea para ubicarse)
  const geolocate = new mapboxgl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: false,
    showUserHeading: true
  });
  map.addControl(geolocate, "top-right");
  if (btnMyLoc){
    btnMyLoc.addEventListener("click", () => {
      try { geolocate.trigger(); } catch (e) { /* noop */ }
    });
  }

  // Geocoder local: solo localidades del dataset (ya filtradas a >=2000 hab en 2022)
  if (window.MapboxGeocoder && geocoderHost){
    const norm = (s) => String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

    const geocoder = new MapboxGeocoder({
      accessToken: CONFIG.MAPBOX_TOKEN,
      mapboxgl,
      marker: false,
      placeholder: "Buscar localidad (>=2000 hab, 2022)…",
      localGeocoder: (query) => {
        const q = norm(query).trim();
        if (!q) return [];
        const out = [];
        for (const r of records){
          if (!r || !r.localidad || !r.provincia) continue;
          if (!Number.isFinite(Number(r.total_2022)) || Number(r.total_2022) < 2000) continue;
          const hay = norm(`${r.localidad}, ${r.provincia}`);
          if (hay.includes(q)){
            const cx = Number(r.centroid_lon);
            const cy = Number(r.centroid_lat);
            if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
            out.push({
              type: "Feature",
              geometry: { type: "Point", coordinates: [cx, cy] },
              place_name: `${r.localidad}, ${r.provincia}`,
              properties: { clc: String(r.clc) },
              center: [cx, cy],
              bbox: r.bbox
            });
          }
        }
        return out.slice(0, 10);
      },
      localGeocoderOnly: true,
      flyTo: false
    });

    geocoderHost.appendChild(geocoder.onAdd(map));

    geocoder.on("result", (e) => {
      const clc = e?.result?.properties?.clc;
      if (clc){
        const r = byClc.get(String(clc));
        if (r){
          const selProv = document.getElementById("selProvincia");
          const selLoc = document.getElementById("selLocalidad");
          if (selProv){ selProv.value = r.provincia; selProv.dispatchEvent(new Event("change")); }
          if (selLoc){ selLoc.value = String(clc); selLoc.dispatchEvent(new Event("change")); }
        } else {
          zoomToClc(String(clc));
        }
      } else if (e?.result?.bbox && Array.isArray(e.result.bbox) && e.result.bbox.length === 4){
        const b = e.result.bbox;
        fitToBounds([[b[0], b[1]],[b[2], b[3]]], { maxZoom: 11.0 });
      }
    });
  } else if (geocoderHost) {
    // Fallback: buscador local basado en el dataset (sin MapboxGeocoder)
    geocoderHost.innerHTML = `
      <input id="localSearch" class="localSearch" type="text" list="dlLocs" placeholder="Buscar localidad (>=2000 hab, 2022)…"/>
      <datalist id="dlLocs"></datalist>
      <div class="hint">Buscador local (dataset).</div>
    `;
    const dl = document.getElementById("dlLocs");
    for (const r of records){
      if (!r || !r.localidad || !r.provincia) continue;
      if (!Number.isFinite(Number(r.total_2022)) || Number(r.total_2022) < 2000) continue;
      const opt = document.createElement("option");
      opt.value = `${r.localidad}, ${r.provincia}`;
      opt.dataset.clc = String(r.clc);
      dl.appendChild(opt);
    }
    const input = document.getElementById("localSearch");
    input.addEventListener("change", () => {
      const val = input.value.trim();
      const match = records.find(r => `${r.localidad}, ${r.provincia}` === val);
      if (match){
        const selProv = document.getElementById("selProvincia");
        const selLoc  = document.getElementById("selLocalidad");
        if (selProv){ selProv.value = match.provincia; selProv.dispatchEvent(new Event("change")); }
        if (selLoc){ selLoc.value  = String(match.clc); selLoc.dispatchEvent(new Event("change")); }
      }
    });
  }



  map.on("load", () => {
    // Fuente vector del tileset
    map.addSource("localidades", {
      type: "vector",
      url: CONFIG.TILESET_URL,
      promoteId: "clc"
    });

    // Definir rampa secuencial (un solo color) en base a min/max
    const minPP = Math.min(...records.map(r => (Number.isFinite(Number(r.growth_pp)) ? Number(r.growth_pp) : 0)));
    const maxPP = Math.max(...records.map(r => (Number.isFinite(Number(r.growth_pp)) ? Number(r.growth_pp) : 0)));
    const span = (maxPP - minPP) || 1;
    const s1 = minPP + span * 0.16;
    const s2 = minPP + span * 0.33;
    const s3 = minPP + span * 0.50;
    const s4 = minPP + span * 0.66;
    const s5 = minPP + span * 0.83;

    const fillColorExpr = [
      "interpolate",
      ["linear"],
      ["coalesce", ["feature-state", "growth_pp"], minPP],
      minPP, COLOR_RAMP[0],
      s1, COLOR_RAMP[1],
      s2, COLOR_RAMP[2],
      s3, COLOR_RAMP[3],
      s4, COLOR_RAMP[4],
      s5, COLOR_RAMP[5],
      maxPP, COLOR_RAMP[6]
    ];

    // Cargar estados por feature (join por clc)
    // Esto habilita pintar y consultar valores sin inflar expresiones
    for (const r of records){
      map.setFeatureState(
        { source: "localidades", sourceLayer: CONFIG.SOURCE_LAYER, id: String(r.clc) },
        {
          growth_pp: r.growth_pp,
          pct60_2022: r.pct60_2022,
          total_2022: r.total_2022,
          p60_2022: r.p60_2022,
          hasData: true
        }
      );
    }

    // Capas
    map.addLayer({
      id: "localidades-fill",
      type: "fill",
      source: "localidades",
      "source-layer": CONFIG.SOURCE_LAYER,
      paint: {
        "fill-color": fillColorExpr,
        "fill-opacity": [
          "case",
          ["boolean", ["feature-state", "hover"], false], 0.85,
          ["boolean", ["feature-state", "hasData"], false], 0.70,
          0
        ]
      }
    });

    map.addLayer({
      id: "localidades-line",
      type: "line",
      source: "localidades",
      "source-layer": CONFIG.SOURCE_LAYER,
      paint: {
        "line-color": "rgba(255,255,255,0.18)",
        "line-width": 0.6,
        "line-opacity": [
          "case",
          ["boolean", ["feature-state", "hasData"], false], 0.55,
          0
        ]
      }
    });

    map.addLayer({
      id: "localidades-selected",
      type: "line",
      source: "localidades",
      "source-layer": CONFIG.SOURCE_LAYER,
      filter: ["==", ["get","clc"], "__none__"],
      paint: {
        "line-color": "rgba(255,255,255,0.92)",
        "line-width": 3
      }
    });

    // Interacciones
    map.on("mousemove", "localidades-fill", onMove);
    map.on("mouseleave", "localidades-fill", onLeave);
    map.on("click", "localidades-fill", onClick);

    // Render inicial con filtros
    applyFilters();
  });
}

function onMove(e){
  map.getCanvas().style.cursor = "pointer";
  const f = e.features && e.features[0];
  if(!f) return;

  const id = f.id; // por promoteId
  if (hoveredId !== null && hoveredId !== id){
    map.setFeatureState({ source: "localidades", sourceLayer: CONFIG.SOURCE_LAYER, id: hoveredId }, { hover: false });
  }
  hoveredId = id;
  map.setFeatureState({ source: "localidades", sourceLayer: CONFIG.SOURCE_LAYER, id }, { hover: true });
}

function onLeave(){
  map.getCanvas().style.cursor = "";
  if (hoveredId !== null){
    map.setFeatureState({ source: "localidades", sourceLayer: CONFIG.SOURCE_LAYER, id: hoveredId }, { hover: false });
  }
  hoveredId = null;
}

function onClick(e){
  const f = e.features && e.features[0];
  if(!f) return;

  const clc = String(f.properties.clc ?? f.id ?? "");
  const r = byClc.get(clc);

  // Seleccionar
  selectedClc = String(clc);
  map.setFilter("localidades-selected", ["==", ["get","clc"], String(clc)]);

  // Popup
  const html = r ? popupHTML(r) : `<div class="popup"><b>${f.properties.nam}</b></div>`;
  new mapboxgl.Popup({ closeButton: true, closeOnClick: true })
    .setLngLat(e.lngLat)
    .setHTML(html)
    .addTo(map);

  // Sidebar
  applyFilters({autoZoom:false});
}

function popupHTML(r){
  const pct10 = isTruthy(r.pct60_2010) ? `${fmtPct.format(r.pct60_2010)}%` : "s/d";
  const pct22 = isTruthy(r.pct60_2022) ? `${fmtPct.format(r.pct60_2022)}%` : "s/d";
  const pp = isTruthy(r.growth_pp) ? `${fmtPP.format(r.growth_pp)} p.p.` : "s/d";
  const rel = isTruthy(r.growth60_rel_pct) ? `${fmtPct.format(r.growth60_rel_pct)}%` : "s/d";

  return `
    <div class="popup">
      <div class="popup__title">${r.localidad}</div>
      <div class="popup__subtitle">${r.provincia}</div>
      <div class="popup__grid">
        <div><span>2010 Total</span><b>${fmtInt.format(r.total_2010)}</b></div>
        <div><span>2010 60+</span><b>${fmtInt.format(r.p60_2010)}</b></div>
        <div><span>2010 %60+</span><b>${pct10}</b></div>

        <div><span>2022 Total</span><b>${fmtInt.format(r.total_2022)}</b></div>
        <div><span>2022 60+</span><b>${fmtInt.format(r.p60_2022)}</b></div>
        <div><span>2022 %60+</span><b>${pct22}</b></div>

        <div><span>Crec. pp</span><b>${pp}</b></div>
        <div><span>Crec. 60+ rel.</span><b>${rel}</b></div>
        <div><span>Crec. 60+ (pers.)</span><b>${fmtInt.format(r.growth60_abs)}</b></div>
      </div>
    </div>
  `;
}

function clearSelection(){
  selectedClc = null;
  if (map && map.getLayer("localidades-selected")){
    map.setFilter("localidades-selected", ["==", ["get","clc"], "__none__"]);
  }
}

/* Zoom aproximado a una localidad:
   - No tenemos bbox fácilmente desde vector tiles sin consultar tiles ya cargados.
   - Hacemos un flyTo a la geometría visible más cercana (si está cargada).
*/
function zoomToClc(clc){
  if (!map) return;
  const key = String(clc);

  // 1) Preferimos bbox/centroide desde la tabla (funciona aunque el polígono no esté "renderizado" aún)
  const r = byClc.get(key);
  if (r){
    // bbox esperado: [minx, miny, maxx, maxy]
    if (Array.isArray(r.bbox) && r.bbox.length === 4){
      const [minx, miny, maxx, maxy] = r.bbox.map(Number);
      if ([minx,miny,maxx,maxy].every(Number.isFinite)){
        fitToBounds([[minx, miny],[maxx, maxy]], { duration: 700, maxZoom: 11.5 });
        return;
      }
    }
    const cx = Number(r.centroid_lon);
    const cy = Number(r.centroid_lat);
    if (Number.isFinite(cx) && Number.isFinite(cy)){
      map.flyTo({ center: [cx, cy], zoom: Math.max(map.getZoom(), 9.5), duration: 700 });
      return;
    }
  }

  // 2) Fallback: si el feature ya está renderizado en pantalla, usamos su geometría
  const feats = map.queryRenderedFeatures({ layers: ["localidades-fill"] })
    .filter(f => String(f.properties.clc) === key);

  if (feats.length){
    const f = feats[0];
    const coords = [];
    const geom = f.geometry;
    if (geom && geom.type){
      if (geom.type === "Polygon"){
        for (const ring of geom.coordinates) for (const c of ring) coords.push(c);
      } else if (geom.type === "MultiPolygon"){
        for (const poly of geom.coordinates) for (const ring of poly) for (const c of ring) coords.push(c);
      }
    }
    if (coords.length){
      let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
      for (const [x,y] of coords){ minX=Math.min(minX,x); minY=Math.min(minY,y); maxX=Math.max(maxX,x); maxY=Math.max(maxY,y); }
      fitToBounds([[minX,minY],[maxX,maxY]], { duration: 700, maxZoom: 11.5 });
      return;
    }
  }

  // 3) Último fallback: acercar
  map.flyTo({ zoom: Math.max(map.getZoom(), 8), duration: 600 });
}


/* ============================
   Popup CSS (inyectado)
   ============================ */
(function injectPopupCSS(){
  const css = `
  .mapboxgl-popup-content{ padding: 10px 10px; border-radius: 14px; }
  .popup{ font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; min-width: 250px; }
  .popup__title{ font-weight: 800; font-size: 14px; margin-bottom: 2px; }
  .popup__subtitle{ color: #6b7280; font-size: 12px; margin-bottom: 8px; }
  .popup__grid{ display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
  .popup__grid div{ background:#f3f4f6; border-radius: 10px; padding: 8px; }
  .popup__grid span{ display:block; font-size: 10px; color:#6b7280; margin-bottom: 4px; }
  .popup__grid b{ font-size: 12px; color:#111827; }
  `;
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
})();

/* ============================
   START
   ============================ */
function showError(msg, err){
  console.error(msg, err);
  const banner = document.getElementById("errorBanner");
  if (banner){
    banner.classList.remove("hidden");
    banner.innerHTML = `
      <div class="errorBanner__title">${msg}</div>
      <div class="errorBanner__detail">${(err && (err.message || String(err))) || ""}</div>
      <div class="errorBanner__hint">Abrí la consola del navegador (F12) para ver el detalle completo.</div>
    `;
  } else {
    alert(msg);
  }
}

window.addEventListener("error", (e) => {
  // evita duplicar mensajes muy ruidosos, pero deja el detalle en consola
  if (e && e.message) showError("Error inesperado en la página.", e.error || e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  showError("Error inesperado (promesa rechazada).", e.reason);
});

loadData().catch(err => {
  showError("No pude iniciar el mapa. Revisá el detalle abajo o en la consola.", err);
});
