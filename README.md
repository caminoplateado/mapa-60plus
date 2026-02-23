# Web map — Evolución 60+ (Argentina, 2010–2022)

Este sitio es una **single-page** con Mapbox GL JS que:
- Muestra polígonos de centros urbanos (tileset vector en Mapbox).
- Une datos por `clc` contra la tabla `data/localidades_60plus.json`.
- Incluye: buscador (Argentina), click/popup, filtros por provincia/localidad y sliders por población, %60+ y crecimiento en p.p.
- Sidebar (20% del ancho) con KPIs: **si hay localidad seleccionada**, muestra esa localidad; si no, el **agregado del filtrado**; si no hay filtros, **Argentina**.

## 1) Completar CONFIG
Abrí `app.js` y completá:

- `MAPBOX_TOKEN`
- `TILESET_URL`  (ej: `mapbox://usuario.tilesetid`)
- `SOURCE_LAYER` (nombre del source-layer del tileset)

## 2) Publicar / correr local
Como es estático, con cualquier servidor sirve.

### Opción rápida (Python)
```bash
cd mapa60plus_site
python -m http.server 8000
```
Abrir: http://localhost:8000

## 3) Datos
La tabla se entrega como XLSX/JSON en `data/localidades_60plus.xlsx` (derivado del XLSX que adjuntaste).
Si preferís JSON/CSV, están también en `data/localidades_60plus.csv`.

## 4) Notas
- El color representa **crecimiento del peso de 60+ (puntos porcentuales)** entre 2010 y 2022.
- Para el click y el sidebar se usa la tabla unida por `clc`.


## Nota
- El dataset y el buscador están limitados a localidades con **Total 2022 >= 2000**.
- Se incluye `data/localidades_censales_2022_2000plus_join.geojson` (GeoJSON con atributos agregados) por si querés re-subirlo como tileset en Mapbox.

---
## Deploy en Cloudflare Pages (sin exponer el token)

Este proyecto usa **Cloudflare Pages Functions** para servir el token en runtime en `./assets/config`.

### Pasos
1) En Cloudflare Pages → tu proyecto → **Settings → Environment variables**
2) Agregar variable **MAPBOX_TOKEN** (Production y Preview)
3) Redeploy.

### Local (opcional)
Si probás local sin Functions, podés setear temporalmente en consola:
`window.MAPBOX_TOKEN = "TOKEN_AQUI";` y recargar.
