/**
 * 抓取珠三角码头/港口/锚地位置
 * 优先级: OSM Overpass (port/harbour/marina) > 高德 POI (关键字码头/港口)
 *
 * 输出: ports.json 与 coastline-gz.json 结构类似, 后续 zssf.js 直接 load
 *        { ports: [{name, lng, lat, type}, ...], meta: {...} }
 *
 * 码头标签筛选:
 *   OSM: amenity=harbour,  maritime=port,  leisure=marina,  landuse=port,
 *        man_made=pier,  railway=port (轮渡),  service=bicycle_repair_station 跳过
 *        额外筛: 名称含 "港/码头/渡/锚地/泊位/口岸/客运/货运/栈桥/埠", 或类型为 port/harbour
 *
 *   高德: typeCode 在 150xxx/151xxx (交通设施服务-码头/港口/客运码头/货运码头)
 *        关键字: 码头、港口、渡口、锚地、客运口岸、货运口岸
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const BBOX = [21.8, 113.4, 22.9, 114.6]; // S,W,N,E
const OUT = path.join(__dirname, 'ports.json');
const AMAP_KEY = '01d6322cc08dafd1800e07b018b06b49';
const OVERPASS_INSTANCES = [
  'https://overpass-api.de',
  'https://overpass.kumi.systems',
  'https://overpass.openstreetmap.ru',
  'https://overpass-api.de', // retry
];

// ====== 通用 https.get wrapper ======
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    console.log('[http]', url);
    https.get(url, { headers: { 'User-Agent': 'ais-adsb/1.0', ...headers }, timeout: 60000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpGet(res.headers.location, headers).then(resolve, reject);
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
      res.on('error', reject);
    }).on('error', reject).setTimeout(60000, function () { this.destroy(new Error('timeout')); });
  });
}

// ====== 1) OSM Overpass 抓取 ======
async function fetchOverpassPorts() {
  // Overpass QL: 同时抓 node 和 way (带 center)
  const ql = `
[out:json][timeout:120][bbox:${BBOX.join(',')}];
(
  node["amenity"="harbour"](${BBOX.join(',')});
  node["maritime"="port"](${BBOX.join(',')});
  node["landuse"="port"](${BBOX.join(',')});
  node["leisure"="marina"](${BBOX.join(',')});
  node["man_made"="pier"](${BBOX.join(',')});
  node["railway"="port"](${BBOX.join(',')});
  way["landuse"="port"](${BBOX.join(',')});
  way["leisure"="marina"](${BBOX.join(',')});
  way["man_made"="pier"](${BBOX.join(',')});
  way["maritime"="port"](${BBOX.join(',')});
);
out center body tags;
`.trim();
  for (const base of OVERPASS_INSTANCES) {
    try {
      const url = `${base}/api/interpreter?data=${encodeURIComponent(ql)}`;
      const json = await httpGet(url);
      console.log('[osm] total elements:', json.elements.length);
      const out = [];
      for (const el of json.elements) {
        let lng, lat;
        if (el.type === 'node') { lng = el.lon; lat = el.lat; }
        else if (el.center) { lng = el.center.lon; lat = el.center.lat; }
        if (lng == null || lat == null) continue;
        const t = el.tags || {};
        const name = t.name || t['name:en'] || '';
        // 过滤噪音: 小轮渡站? 不, 先全收, 再按 type 分类
        const types = [];
        if (t.amenity) types.push(t.amenity);
        if (t.maritime) types.push(t.maritime);
        if (t.landuse) types.push(t.landuse);
        if (t.leisure) types.push(t.leisure);
        if (t.man_made) types.push(t.man_made);
        if (t.railway) types.push(t.railway);
        out.push({ name: String(name), lng: +lng, lat: +lat, type: types.join('/'), source: 'osm' });
      }
      return out;
    } catch (e) {
      console.log(`[osm] ${base} fail: ${e.message}`);
    }
  }
  return null;
}

// ====== 2) 高德 Web 服务 API 兜底 ======
//    text 搜索 + 分页 (高德默认 20/页, 最多 5页 = 100条)
async function fetchAmapPorts() {
  const KEYWORDS = ['码头', '港口', '渡口', '锚地', '客运口岸', '货运口岸'];
  const AMAP_TYPES = ['150500', '150501', '150502', '150503', '150504', '151500', '151501']; // 交通设施-码头/港口/轮渡
  const results = [];
  const seen = new Set();
  // 用 bbox 的中心 + 大半径做 area 搜索
  const [S, W, N, E] = BBOX;
  const centerLng = (W + E) / 2;
  const centerLat = (S + N) / 2;
  const radius = 120000; // 120km 覆盖整个 bbox

  for (const kw of KEYWORDS) {
    for (const type of AMAP_TYPES) {
      for (let page = 1; page <= 3; page++) {
        try {
          const url = `https://restapi.amap.com/v3/place/text?key=${AMAP_KEY}&keywords=${encodeURIComponent(kw)}&types=${type}&radius=${radius}&center=${centerLng},${centerLat}&offset=25&page=${page}&extensions=base`;
          const json = await httpGet(url);
          if (!json || json.status !== '1' || !json.pois || json.pois.length === 0) break;
          for (const p of json.pois) {
            const [lng, lat] = (p.location || '').split(',').map(Number);
            if (isNaN(lng) || isNaN(lat)) continue;
            // 过滤在 bbox 外的
            if (lng < W || lng > E || lat < S || lat > N) continue;
            const id = `${lng.toFixed(3)}|${lat.toFixed(3)}`;
            if (seen.has(id)) continue;
            seen.add(id);
            results.push({ name: p.name || '', lng, lat, type: kw + '/' + type, source: 'amap' });
          }
          if (json.pois.length < 25) break;
          await new Promise(r => setTimeout(r, 300)); // 限流
        } catch (e) {
          console.log(`[amap] ${kw} ${type} page ${page}: ${e.message}`);
          break;
        }
      }
    }
  }
  console.log(`[amap] collected ${results.length} pois`);
  return results;
}

// ====== 3) 合并去重 + 质量过滤 ======
function normalizeType(raw) {
  if (!raw) return '';
  const seen = new Set();
  for (const t of String(raw).split('/')) seen.add(t.trim());
  return [...seen].filter(Boolean).join(',');
}

function qualityScore(p) {
  // 打分越大越优质
  let s = 0;
  if (p.name) s += 10;
  if (p.type.includes('marina')) s += 8;
  if (p.type.includes('harbour')) s += 8;
  if (p.type.includes('ferry_terminal')) s += 8;
  if (p.type.includes('pier')) s += 3;
  if (p.type.includes('landuse')) s -= 5; // landuse=port 是用地质心, 差
  return s;
}

function mergeAndDedupe(osm, amap) {
  const all = [];
  if (osm) for (const p of osm) all.push(p);
  if (amap) {
    for (const p of amap) {
      let dup = false;
      for (const q of osm || []) {
        if (haversineKm(p.lng, p.lat, q.lng, q.lat) < 0.5) { dup = true; break; }
      }
      if (!dup) all.push(p);
    }
  }
  // 规整 type
  for (const p of all) p.type = normalizeType(p.type);

  // 质量过滤: 丢弃那些 "无名 + 只有 landuse=port + 没有 pier/marina/harbour" 的质心点
  const filtered = all.filter(p => {
    if (p.name) return true;                           // 有名字就保留
    if (!p.type) return false;
    // 没有名字, 但类型包含 marina / harbour / ferry_terminal / pier 任一关键字 -> 保留
    if (/marina|harbour|ferry|pier/.test(p.type)) return true;
    return false;
  });
  console.log('[filter] before:', all.length, ' -> after:', filtered.length, '(removed low-quality landuse centroid)');

  // 再把 500m 半径内的点合并, 保留质量分最高那个
  const final = [];
  for (const p of filtered) {
    let bestIdx = -1, bestScore = -1, bestMin = 999;
    for (let i = 0; i < final.length; i++) {
      const d = haversineKm(p.lng, p.lat, final[i].lng, final[i].lat);
      if (d < 0.5 && d < bestMin) { bestIdx = i; bestMin = d; }
    }
    if (bestIdx === -1) final.push(p);
    else {
      const cur = final[bestIdx];
      const sP = qualityScore(p), sC = qualityScore(cur);
      if (sP > sC) {
        // 用更好的替换
        final[bestIdx] = p;
      } else if (sP === sC && (p.name || '').length > (cur.name || '').length) {
        final[bestIdx] = p;
      }
    }
  }
  return final;
}

function haversineKm(lng1, lat1, lng2, lat2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ====== 主流程 ======
(async () => {
  const osm = await fetchOverpassPorts();
  console.log('[osm] got', osm ? osm.length : 0, 'elements');
  const amap = osm && osm.length > 150 ? null : await fetchAmapPorts(); // OSM 足够多就跳过高德
  const merged = mergeAndDedupe(osm, amap);
  console.log('[merge] final ports:', merged.length);
  // 统计一下
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const p of merged) {
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  const out = {
    meta: {
      source: 'OSM Overpass' + (amap ? ' + AMap POI' : ''),
      bbox: { minLng, minLat, maxLng, maxLat },
      totalPorts: merged.length,
      generatedAt: new Date().toISOString()
    },
    ports: merged
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 0), 'utf8');
  console.log(`[OK] ${OUT} ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
  // 打印前几个
  console.log('\n前10个:');
  merged.slice(0, 10).forEach(p => console.log(`  ${p.name || '(无名)'} (${p.lng.toFixed(4)},${p.lat.toFixed(4)}) [${p.source}]`));
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
