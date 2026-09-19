const MAP_IMAGE_PATH = 'assets/map.png';

/**
 * 지도 face.png 오버레이 — 숫자만 바꾼 뒤 새로고침.
 * top/left: 지도 shell 기준 %(0=위/왼, 100=아래/오른)
 * translate: 이미지 자체 기준 %( -50,-50 = top/left 지점이 이미지 중심 )
 */
const FACE_OVERLAY = {
  opacity: 0.58,
  widthPercent: 75,
  topPercent: 47,
  leftPercent: 56,
  translateXPercent: -50,
  translateYPercent: -50,
};

/**
 * 첫 로드 시 지도 중심 — photos.json과 같은 좌상단 픽셀 { x, y }.
 * zoom: CRS.Simple 정수 줌 (0=기본, -1·-2=더 축소, 1=더 확대).
 */
const INITIAL_MAP_VIEW = { x: 400, y: 300, zoom: 0.2 };
/** @type {string | null} */
let mapDisplayUrl = null;

const params = new URLSearchParams(window.location.search);
const devMode = params.get('dev') === '1';

let selectedId = null;
let hoveredId = null;

/** @type {import('leaflet').Map | null} */
let map = null;
/** @type {number} */
let imageHeight = 0;
/** @type {number} */
let imageWidth = 0;
/** @type {Array<{ id: string, title: string, date: string, caption: string, x: number, y: number, thumb: string, src: string }>} */
let photos = [];
/** @type {Map<string, import('leaflet').Marker>} */
const markersById = new Map();
/** @type {Map<string, { leftPct: number, topPct: number }>} */
const scatterPosById = new Map();
/** @type {Map<string, number>} */
const scatterSizeById = new Map();

/** scrollTop(y)에 따라 마커가 누적 노출 — 25개 기준으로 스크롤 거리를 나눈다. */
const SCATTER_MAX_COUNT = 25;
const SCATTER_SCROLL_RANGE = 2200;
const SCATTER_SIZE_MIN = 40;
const SCATTER_SIZE_MAX = 160;
/** 썸네일 최대 160px일 때 중심 간격(80px→18% 비례 → 36%, 소폭 여유). */
const SCATTER_MIN_CENTER_DIST_PCT = 18;

let scatterScrollBound = false;
let scatterListBuilt = false;
let scatterScrollRaf = 0;

const thumbLoadQueue = [];
let thumbLoadsInFlight = 0;
const THUMB_LOAD_CONCURRENCY = 3;

const el = {
  errorBanner: document.getElementById('error-banner'),
  listCount: document.getElementById('list-count'),
  photoListScroller: document.getElementById('photo-list-scroller'),
  photoScatterSpacer: document.getElementById('photo-scatter-spacer'),
  photoList: document.getElementById('photo-list'),
  detail: document.getElementById('detail'),
  detailClose: document.getElementById('detail-close'),
  detailImg: document.getElementById('detail-img'),
  detailCoords: document.getElementById('detail-coords'),
  detailCaption: document.getElementById('detail-caption'),
  detailDate: document.getElementById('detail-date'),
  mapStack: document.querySelector('.map-stack'),
  mapShell: document.querySelector('.map-shell'),
  mapFaceToggle: document.getElementById('map-face-toggle'),
  mapFaceOverlay: document.getElementById('map-face-overlay'),
  devCoords: document.getElementById('dev-coords'),
};

function applyFaceOverlayConfig() {
  const shell = el.mapShell;
  if (!shell) return;
  shell.style.setProperty('--face-overlay-opacity', String(FACE_OVERLAY.opacity));
  shell.style.setProperty('--face-overlay-width', `${FACE_OVERLAY.widthPercent}%`);
  shell.style.setProperty('--face-overlay-top', `${FACE_OVERLAY.topPercent}%`);
  shell.style.setProperty('--face-overlay-left', `${FACE_OVERLAY.leftPercent}%`);
  shell.style.setProperty(
    '--face-overlay-translate-x',
    `${FACE_OVERLAY.translateXPercent}%`,
  );
  shell.style.setProperty(
    '--face-overlay-translate-y',
    `${FACE_OVERLAY.translateYPercent}%`,
  );
}

function bindMapFaceOverlay() {
  if (!el.mapFaceToggle || !el.mapFaceOverlay) return;

  el.mapFaceToggle.addEventListener('click', () => {
    el.mapFaceOverlay.classList.toggle('hidden');
    const on = !el.mapFaceOverlay.classList.contains('hidden');
    el.mapFaceToggle.setAttribute('aria-pressed', String(on));
    el.mapFaceToggle.classList.toggle('map-face-toggle--active', on);
  });
}

// CRS.Simple는 y가 아래→위로 증가하므로, 편집 도구(좌상단 원점)와 맞추려 한 곳에서만 뒤집는다.
function toLatLng({ x, y }, height) {
  return [height - y, x];
}

function toImageCoords(latlng, height) {
  return {
    x: Math.round(latlng.lng),
    y: Math.round(height - latlng.lat),
  };
}

function showError(message) {
  el.errorBanner.textContent = message;
  el.errorBanner.classList.remove('hidden');
}

function parseSvgSize(svgText) {
  const widthMatch = svgText.match(/\bwidth=["'](\d+(?:\.\d+)?)/);
  const heightMatch = svgText.match(/\bheight=["'](\d+(?:\.\d+)?)/);
  if (widthMatch && heightMatch) {
    return {
      width: Math.round(Number(widthMatch[1])),
      height: Math.round(Number(heightMatch[1])),
    };
  }
  const viewBoxMatch = svgText.match(/viewBox=["']([\d.\s]+)/);
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1].trim().split(/\s+/).map(Number);
    if (parts.length === 4) {
      return { width: Math.round(parts[2]), height: Math.round(parts[3]) };
    }
  }
  throw new Error('지도 SVG에서 크기를 읽을 수 없습니다.');
}

function loadRasterDimensions(objectUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      if (!width || !height) {
        reject(new Error('지도 이미지 크기가 0입니다.'));
        return;
      }
      resolve({ width, height });
    };
    img.onerror = () => reject(new Error('지도 이미지를 디코딩하지 못했습니다.'));
    img.src = objectUrl;
  });
}

function getBuiltinMapImage() {
  // assets/map.svg fetch가 실패해도 MVP 임시 지도는 항상 띄우기 위한 내장 SVG
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150" viewBox="0 0 2000 1500">
  <rect width="2000" height="1500" fill="#e8e4dc"/><defs>
  <pattern id="g" width="100" height="100" patternUnits="userSpaceOnUse">
  <path d="M 100 0 L 0 0 0 100" fill="none" stroke="#c4bfb4" stroke-width="1"/>
  </pattern></defs><rect width="200" height="150" fill="url(#g)"/>
  <text x="100" y="75" text-anchor="middle" dominant-baseline="middle" font-family="system-ui,sans-serif" font-size="48" fill="#8a8478">temp map (200x150)</text></svg>`;
  return {
    width: 160,
    height: 80,
    displayUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  };
}

// fetch로 크기 확인. overlay에는 blob URL 대신 같은 출처 URL/data URI(Leaflet 호환).
async function loadMapImage(relativePath) {
  if (window.location.protocol === 'file:') {
    throw new Error(
      'file:// 로는 열 수 없습니다. spoonbill 폴더에서 python3 -m http.server 8080 실행 후 http://localhost:8080 을 여세요.',
    );
  }

  const url = new URL(relativePath, window.location.href).href;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP error');

    const isSvg = relativePath.toLowerCase().endsWith('.svg');

    if (isSvg) {
      const svgText = await res.text();
      const { width, height } = parseSvgSize(svgText);
      return { width, height, displayUrl: url };
    }

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const { width, height } = await loadRasterDimensions(objectUrl);
    URL.revokeObjectURL(objectUrl);
    return { width, height, displayUrl: url };
  } catch (fetchErr) {
    console.warn('Map file fetch failed, using built-in placeholder:', fetchErr);
    return getBuiltinMapImage();
  }
}

async function loadPhotos() {
  const res = await fetch('data/photos.json');
  if (!res.ok) throw new Error('사진 데이터(photos.json)를 불러오지 못했습니다.');
  return res.json();
}

function createMarkerIcon() {
  // 보이는 점(14px)과 클릭/호버 히트 영역(28px)을 맞춰 커서와 체감 위치가 어긋나지 않게 한다.
  return L.divIcon({
    className: 'marker-icon-wrap',
    html: '<span class="marker-dot" aria-hidden="true"></span>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function updateMarkerClasses() {
  for (const [id, marker] of markersById) {
    const dot = marker.getElement()?.querySelector('.marker-dot');
    if (!dot) continue;
    dot.classList.toggle('marker-dot--selected', id === selectedId);
    dot.classList.toggle('marker-dot--hovered', id === hoveredId && id !== selectedId);
  }
}

function ensureScatterRevealed(id) {
  const item = el.photoList
    .querySelector(`[data-id="${id}"]`)
    ?.closest('.photo-scatter-item');
  if (!item || !el.photoListScroller) return;
  const revealAt = Number(item.dataset.revealAt);
  if (el.photoListScroller.scrollTop < revealAt) {
    el.photoListScroller.scrollTop = revealAt;
    updateScatterByScroll(revealAt);
  }
}

function setHoveredId(id, { fromMap = false } = {}) {
  hoveredId = id;
  updateMarkerClasses();
  updateListHighlights();
  if (fromMap && id) ensureScatterRevealed(id);
}

/** 지도 뷰포트를 이미지 좌상단 {x,y} 박스로 (여유 paddingPx). */
function getVisibleImageBounds(paddingPx = 0) {
  if (!map || !imageHeight) return null;
  const bounds = map.getBounds();
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const minX = sw.lng;
  const maxX = ne.lng;
  const minY = imageHeight - ne.lat;
  const maxY = imageHeight - sw.lat;
  return {
    minX: minX - paddingPx,
    maxX: maxX + paddingPx,
    minY: minY - paddingPx,
    maxY: maxY + paddingPx,
  };
}

function photoInView(photo) {
  const box = getVisibleImageBounds();
  if (!box) return false;
  const spanX = box.maxX - box.minX;
  const spanY = box.maxY - box.minY;
  const pad = Math.max(72, Math.min(spanX, spanY) * 0.22);
  const padded = getVisibleImageBounds(pad);
  if (!padded) return false;
  const x = Number(photo.x);
  const y = Number(photo.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return (
    x >= padded.minX &&
    x <= padded.maxX &&
    y >= padded.minY &&
    y <= padded.maxY
  );
}

function visiblePhotos() {
  return photos.filter(photoInView);
}

function scatterCenterDistance(a, b) {
  return Math.hypot(a.leftPct - b.leftPct, a.topPct - b.topPct);
}

function getScatterPlacementBounds() {
  const viewH = el.photoList?.clientHeight || el.photoListScroller?.clientHeight || 480;
  const viewW = el.photoList?.clientWidth || el.photoListScroller?.clientWidth || 300;
  const padPx = SCATTER_SIZE_MAX / 2 + 12;
  return {
    minL: (padPx / viewW) * 100,
    maxL: 100 - (padPx / viewW) * 100,
    minT: (padPx / viewH) * 100,
    maxT: 100 - (padPx / viewH) * 100,
  };
}

function clampScatterPct(leftPct, topPct, bounds) {
  return {
    leftPct: Math.min(bounds.maxL, Math.max(bounds.minL, leftPct)),
    topPct: Math.min(bounds.maxT, Math.max(bounds.minT, topPct)),
  };
}

function scatterFallbackPosition(index, bounds) {
  const hRange = bounds.maxL - bounds.minL;
  const vRange = bounds.maxT - bounds.minT;
  const step = Math.min(
    SCATTER_MIN_CENTER_DIST_PCT,
    hRange / 3.5,
    vRange / 4.5,
  );
  const cols = Math.max(2, Math.floor(hRange / step) + 1);
  const col = index % cols;
  const row = Math.floor(index / cols);
  return clampScatterPct(
    bounds.minL + col * step,
    bounds.minT + row * step,
    bounds,
  );
}

function layoutScatterPositions(ids) {
  const sorted = [...ids].sort((a, b) => a.localeCompare(b));
  const bounds = getScatterPlacementBounds();
  const placed = [];

  for (const id of sorted) {
    const existing = scatterPosById.get(id);
    if (existing) {
      placed.push(existing);
      continue;
    }

    let pos = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const candidate = {
        leftPct: bounds.minL + Math.random() * (bounds.maxL - bounds.minL),
        topPct: bounds.minT + Math.random() * (bounds.maxT - bounds.minT),
      };
      const ok = placed.every(
        (p) => scatterCenterDistance(p, candidate) >= SCATTER_MIN_CENTER_DIST_PCT,
      );
      if (ok) {
        pos = clampScatterPct(candidate.leftPct, candidate.topPct, bounds);
        break;
      }
    }

    if (!pos) pos = scatterFallbackPosition(placed.length, bounds);

    scatterPosById.set(id, pos);
    placed.push(pos);
  }
}

function getScatterPosition(id) {
  const bounds = getScatterPlacementBounds();
  const raw = scatterPosById.get(id);
  if (!raw) return scatterFallbackPosition(0, bounds);
  return clampScatterPct(raw.leftPct, raw.topPct, bounds);
}

function layoutScatterSizes(ids) {
  for (const id of ids) {
    if (scatterSizeById.has(id)) continue;
    const sizePx =
      SCATTER_SIZE_MIN +
      Math.floor(Math.random() * (SCATTER_SIZE_MAX - SCATTER_SIZE_MIN + 1));
    scatterSizeById.set(id, sizePx);
  }
}

function getScatterSize(id) {
  return scatterSizeById.get(id) ?? 48;
}

function scatterRevealStep() {
  const n = Math.max(1, photos.length || SCATTER_MAX_COUNT);
  return SCATTER_SCROLL_RANGE / n;
}

function syncScatterLayout() {
  if (!el.photoListScroller || !el.photoScatterSpacer) return;
  const viewH = el.photoListScroller.clientHeight;
  el.photoList.style.height = `${viewH}px`;
  el.photoScatterSpacer.style.height = `${SCATTER_SCROLL_RANGE}px`;
}

function resolvePhotoUrl(relativeOrAbsolute) {
  return new URL(relativeOrAbsolute, window.location.href).href;
}

function drainThumbLoadQueue() {
  while (
    thumbLoadsInFlight < THUMB_LOAD_CONCURRENCY &&
    thumbLoadQueue.length > 0
  ) {
    const img = thumbLoadQueue.shift();
    if (!img || img.dataset.loaded === '1') continue;
    const src = img.dataset.src;
    if (!src) continue;

    thumbLoadsInFlight += 1;
    const done = () => {
      thumbLoadsInFlight -= 1;
      drainThumbLoadQueue();
    };
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
    img.src = src;
    img.dataset.loaded = '1';
    delete img.dataset.pending;
  }
}

function ensureThumbLoaded(li) {
  if (li.classList.contains('photo-scatter-item--map-out')) return;
  if (!li.classList.contains('photo-scatter-item--revealed')) return;

  const img = li.querySelector('.photo-card-thumb');
  if (!img || img.dataset.loaded === '1' || img.dataset.pending === '1') return;
  if (!img.dataset.src) return;

  img.dataset.pending = '1';
  thumbLoadQueue.push(img);
  drainThumbLoadQueue();
}

function updateScatterByScroll(scrollTop) {
  el.photoList.querySelectorAll('.photo-scatter-item').forEach((li) => {
    const revealAt = Number(li.dataset.revealAt);
    const shouldReveal = scrollTop >= revealAt;
    const wasRevealed = li.classList.contains('photo-scatter-item--revealed');
    if (shouldReveal === wasRevealed) return;

    li.classList.toggle('photo-scatter-item--revealed', shouldReveal);
    if (shouldReveal) ensureThumbLoaded(li);
  });
}

function scheduleScatterScrollUpdate() {
  if (scatterScrollRaf) return;
  scatterScrollRaf = requestAnimationFrame(() => {
    scatterScrollRaf = 0;
    if (el.photoListScroller) {
      updateScatterByScroll(el.photoListScroller.scrollTop);
    }
  });
}

function bindScatterScroll() {
  if (scatterScrollBound || !el.photoListScroller) return;
  scatterScrollBound = true;

  el.photoListScroller.addEventListener(
    'scroll',
    () => scheduleScatterScrollUpdate(),
    { passive: true },
  );

  window.addEventListener('resize', () => {
    syncScatterLayout();
    updateScatterByScroll(el.photoListScroller.scrollTop);
  });
}

function adjustHoverDetailSide(card) {
  const detail = card.querySelector('.photo-card-hover-detail');
  const boundsEl = el.photoListScroller;
  if (!detail || !boundsEl) return;

  card.classList.remove('photo-card--detail-flip-right');
  if (!card.classList.contains('photo-card--show-detail')) return;

  const panelRect = boundsEl.getBoundingClientRect();
  const detailRect = detail.getBoundingClientRect();

  // 기본은 썸네일 왼쪽 — 패널 밖으로 나가면(화면 x가 패널 left 미만) 오른쪽으로 붙인다.
  if (detailRect.left < panelRect.left) {
    card.classList.add('photo-card--detail-flip-right');
  }
}

function updateListHighlights() {
  el.photoList.querySelectorAll('.photo-scatter-item').forEach((li) => {
    const id = li.dataset.id;
    const card = li.querySelector('.photo-card');
    if (!card) return;

    const emphasized = id === hoveredId || id === selectedId;
    li.classList.toggle('photo-scatter-item--emphasis', emphasized);
    card.classList.toggle('photo-card--selected', id === selectedId);
    card.classList.toggle('photo-card--hovered', id === hoveredId);
    card.classList.toggle('photo-card--show-detail', id === hoveredId);

    if (id === hoveredId) {
      requestAnimationFrame(() => adjustHoverDetailSide(card));
    } else {
      card.classList.remove('photo-card--detail-flip-right');
    }
  });
}

function syncScatterViewport() {
  const visibleIds = new Set(visiblePhotos().map((p) => p.id));
  if (el.listCount) {
    el.listCount.textContent = `${visibleIds.size}장 표시 중`;
  }

  el.photoList.querySelectorAll('.photo-scatter-item').forEach((li) => {
    const id = li.dataset.id;
    const mapOut = !id || !visibleIds.has(id);
    const wasOut = li.classList.contains('photo-scatter-item--map-out');
    li.classList.toggle('photo-scatter-item--map-out', mapOut);
    if (wasOut && !mapOut && li.classList.contains('photo-scatter-item--revealed')) {
      ensureThumbLoaded(li);
    }
  });
}

function buildScatterList() {
  el.photoList.replaceChildren();
  syncScatterLayout();
  layoutScatterPositions(photos.map((p) => p.id));

  const sorted = [...photos].sort((a, b) => a.id.localeCompare(b.id));
  const step = scatterRevealStep();

  sorted.forEach((photo, index) => {
    const { leftPct, topPct } = getScatterPosition(photo.id);
    const sizePx = getScatterSize(photo.id);
    // index 0 → scrollTop 0부터 누적 (위쪽이 scroll만 비어 보이던 문제 완화)
    const revealAt = (index + 1) * step;

    const li = document.createElement('li');
    li.className = 'photo-scatter-item';
    li.dataset.revealAt = String(revealAt);
    li.dataset.id = photo.id;
    li.style.left = `${leftPct}%`;
    li.style.top = `${topPct}%`;

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'photo-card photo-card--scatter';
    card.dataset.id = photo.id;
    card.style.width = `${sizePx}px`;
    card.style.height = `${sizePx}px`;

    const detail = document.createElement('span');
    detail.className = 'photo-card-hover-detail';

    const detailTitle = document.createElement('span');
    detailTitle.className = 'photo-card-hover-title';
    detailTitle.textContent = photo.title;

    const detailCaption = document.createElement('span');
    detailCaption.className = 'photo-card-hover-caption';
    detailCaption.textContent = photo.caption;

    detail.style.height = `${sizePx}px`;
    detail.append(detailTitle, detailCaption);

    const thumb = document.createElement('img');
    thumb.className = 'photo-card-thumb';
    thumb.dataset.src = resolvePhotoUrl(photo.thumb);
    thumb.alt = photo.title;
    thumb.decoding = 'async';
    thumb.fetchPriority = 'low';

    card.append(thumb, detail);
    li.append(card);
    el.photoList.append(li);

    card.addEventListener('mouseenter', () => setHoveredId(photo.id));
    card.addEventListener('mouseleave', () => {
      if (hoveredId === photo.id) setHoveredId(null);
    });
    card.addEventListener('click', () => selectPhoto(photo.id, { pan: true }));
  });

  scatterListBuilt = true;
  bindScatterScroll();
  updateScatterByScroll(el.photoListScroller?.scrollTop ?? 0);
  updateListHighlights();
  syncScatterViewport();
}

function renderList() {
  if (!scatterListBuilt) {
    buildScatterList();
    return;
  }
  syncScatterViewport();
  updateListHighlights();
}

function formatDetailCoords(photo) {
  const lat = Number(photo.lat);
  const lng = Number(photo.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '—';
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function renderDetail(photo) {
  if (!photo) {
    el.detail.classList.add('hidden');
    el.mapStack?.classList.remove('map-stack--detail-open');
    el.detailImg.removeAttribute('src');
    requestAnimationFrame(() => {
      syncMapViewportSize();
    });
    return;
  }
  el.detail.classList.remove('hidden');
  el.mapStack?.classList.add('map-stack--detail-open');
  el.detailImg.src = resolvePhotoUrl(photo.src);
  el.detailImg.alt = photo.title ?? '';
  el.detailCoords.textContent = formatDetailCoords(photo);
  el.detailCaption.textContent = photo.caption ?? '';
  el.detailDate.textContent = photo.date ?? '';

  requestAnimationFrame(() => {
    syncMapViewportSize();
  });
}

function closeDetail() {
  selectedId = null;
  renderDetail(null);
  updateMarkerClasses();
  updateListHighlights();
}

function scrollCardIntoView(id) {
  const item = el.photoList
    .querySelector(`[data-id="${id}"]`)
    ?.closest('.photo-scatter-item');
  if (!item || !el.photoListScroller) return;
  const revealAt = Number(item.dataset.revealAt);
  const scrollTop = el.photoListScroller.scrollTop;
  // revealAt으로 스크롤을 되돌리면, 이미 아래까지 펼친 마커가 다시 숨는다.
  if (scrollTop >= revealAt) return;
  el.photoListScroller.scrollTo({ top: revealAt, behavior: 'smooth' });
  updateScatterByScroll(revealAt);
}

function selectPhoto(id, { pan = false } = {}) {
  const photo = photos.find((p) => p.id === id);
  if (!photo) return;

  selectedId = id;
  renderDetail(photo);
  updateMarkerClasses();
  updateListHighlights();
  syncScatterViewport();
  scrollCardIntoView(id);

  if (pan && map) {
    const target = L.latLng(toLatLng(photo, imageHeight));
    map.flyTo(target, map.getZoom(), { duration: 0.6 });
  }
}

function addPhotoMarkers() {
  if (!map) return;
  for (const photo of photos) {
    const marker = L.marker(toLatLng(photo, imageHeight), {
      icon: createMarkerIcon(),
    }).addTo(map);

    marker.on('click', () => selectPhoto(photo.id, { pan: false }));
    marker.on('mouseover', () => setHoveredId(photo.id, { fromMap: true }));
    marker.on('mouseout', () => {
      if (hoveredId === photo.id) setHoveredId(null);
    });

    markersById.set(photo.id, marker);
  }
}

function applyMapLayoutAspect(width, height) {
  if (!el.mapStack) return;
  el.mapStack.style.setProperty('--map-aspect-w', String(width));
  el.mapStack.style.setProperty('--map-aspect-h', String(height));
}

function getImageLatLngBounds() {
  return L.latLngBounds([0, 0], [imageHeight, imageWidth]);
}

function applyInitialMapView({ animate = false } = {}) {
  if (!map || !imageHeight) return;

  const center = L.latLng(
    ...toLatLng(
      { x: INITIAL_MAP_VIEW.x, y: INITIAL_MAP_VIEW.y },
      imageHeight,
    ),
  );
  map.setView(center, INITIAL_MAP_VIEW.zoom, { animate });
}

function syncMapViewportSize() {
  if (!map) return;
  const center = map.getCenter();
  const zoom = map.getZoom();
  map.invalidateSize();
  map.setView(center, zoom, { animate: false });
  syncScatterViewport();
}

function initMap(width, height, displayUrl) {
  imageWidth = width;
  imageHeight = height;
  mapDisplayUrl = displayUrl;
  applyMapLayoutAspect(width, height);

  const bounds = getImageLatLngBounds();

  map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: -2,
    maxZoom: 4,
    maxBounds: bounds,
    maxBoundsViscosity: 1,
  });

  L.imageOverlay(displayUrl, bounds).addTo(map);
  applyInitialMapView();

  // CSS로 #map 높이가 flex 이후에야 확정되므로, Leaflet이 올바른 크기로 그리도록 한 번 더 맞춘다.
  requestAnimationFrame(() => {
    map.invalidateSize();
    applyInitialMapView();
    syncScatterViewport();
  });

  window.addEventListener('resize', () => {
    syncMapViewportSize();
  });

  map.on('resize', () => {
    syncMapViewportSize();
  });

  // moveend 시점에만 필터링 — DOM 재생성 없이 표시/숨김만 갱신한다.
  map.on('moveend', () => {
    syncScatterViewport();
  });

  if (devMode) {
    el.devCoords.classList.remove('hidden');
    map.on('click', (e) => {
      const coords = toImageCoords(e.latlng, imageHeight);
      const text = `{ "x": ${coords.x}, "y": ${coords.y} }`;
      console.log('image coords (top-left origin):', coords);
      el.devCoords.textContent = text;
    });
  }
}

el.detailClose.addEventListener('click', closeDetail);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selectedId) closeDetail();
});

applyFaceOverlayConfig();
bindMapFaceOverlay();

async function main() {
  if (typeof L === 'undefined') {
    showError(
      'Leaflet(CDN)을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 새로고침하세요.',
    );
    return;
  }

  try {
    const { width, height, displayUrl } = await loadMapImage(MAP_IMAGE_PATH);
    initMap(width, height, displayUrl);
  } catch (err) {
    showError(err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다.');
    console.error(err);
    return;
  }

  try {
    photos = await loadPhotos();
    scatterPosById.clear();
    scatterSizeById.clear();
    scatterListBuilt = false;
    const photoIds = photos.map((p) => p.id);
    layoutScatterSizes(photoIds);
    addPhotoMarkers();
  } catch (err) {
    showError(err instanceof Error ? err.message : '사진 데이터를 불러오지 못했습니다.');
    console.error(err);
  }

  renderList();
}

main();
