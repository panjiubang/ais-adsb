/**
 * zssf - 走私识别算法 (船舶静默行为检测)
 *
 * 基于 demo 库 ais_origin_record 船舶轨迹原始表, 检测满足以下条件的船舶静默行为:
 *   1. 静默开始位置距离海岸线 < coastlineDistanceKm (默认20KM, 靠近海岸)
 *   2. 静默开始时间在配置的时间窗口内 (默认全天)
 *   3. 静默时长 >= silenceDurationMin (默认45分钟)
 *   4. 静默后第一次恢复AIS的位置与静默开始位置的距离 <= restartDisplacementKm (默认10KM)
 *
 * 满足条件的记录写入 risk_zousi 表
 *
 * 用法:
 *   node zssf.js            # 运行算法, 清表后重新检测
 *   node zssf.js --dry-run  # 只检测不入库, 打印结果
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// ====== 数据库配置 ======
const DB_CONFIG = {
  host: '127.0.0.1', port: 3306,
  user: 'root', password: 'Ais@2026',
  database: 'demo', charset: 'utf8mb4'
};

// ====== 配置文件加载 ======
const CONFIG_PATH = path.join(__dirname, 'zssf-config.json');
const COASTLINE_PATH = path.join(__dirname, 'coastline-gz.json');
const PORTS_PATH = path.join(__dirname, 'ports.json');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw).params;
}

function loadCoastline() {
  const raw = fs.readFileSync(COASTLINE_PATH, 'utf8');
  const data = JSON.parse(raw);
  return data.segments;
}

function loadPorts() {
  if (!fs.existsSync(PORTS_PATH)) {
    console.warn('[zssf] ports.json 不存在, 码头距离过滤不生效');
    return [];
  }
  const raw = fs.readFileSync(PORTS_PATH, 'utf8');
  const data = JSON.parse(raw);
  console.log('[zssf] 已加载 %d 个码头/港口点', (data.ports || []).length);
  return data.ports || [];
}

// ====== 地理计算工具 ======

/**
 * Haversine 公式计算两点间距离(KM)
 */
function haversineKm(lng1, lat1, lng2, lat2) {
  const R = 6371; // 地球半径 KM
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 计算点到线段的最短距离(KM)
 * 点 P(lng,lat), 线段 A(lng1,lat1)->B(lng2,lat2)
 */
function pointToSegmentKm(plng, plat, alng, alat, blng, blat) {
  // 经纬度转近似平面坐标(以A为原点, 1度≈111.32km, 经度按纬度缩放)
  const kmPerDegLat = 111.32;
  const kmPerDegLng = 111.32 * Math.cos(plat * Math.PI / 180);
  const px = plng * kmPerDegLng;
  const py = plat * kmPerDegLat;
  const ax = alng * kmPerDegLng;
  const ay = alat * kmPerDegLat;
  const bx = blng * kmPerDegLng;
  const by = blat * kmPerDegLat;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-10) {
    // A=B, 直接算PA距离
    return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
}

/**
 * 计算点到海岸线的最短距离(KM)
 * coastSegments: [{name, points:[[lng,lat],...]}]
 */
function distanceToCoastline(lng, lat, coastSegments) {
  let minDist = Infinity;
  for (const seg of coastSegments) {
    const pts = seg.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = pointToSegmentKm(lng, lat, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (d < minDist) minDist = d;
    }
  }
  return minDist;
}

/**
 * 计算点到最近码头/港口的距离(KM)
 * ports: [{name, lng, lat, type}, ...]
 * 返回 { distKm, nearest }
 */
function distanceToNearestPort(lng, lat, ports) {
  if (!ports || ports.length === 0) return { distKm: Infinity, nearest: null };
  let minDist = Infinity, nearest = null;
  for (const p of ports) {
    const d = haversineKm(lng, lat, p.lng, p.lat);
    if (d < minDist) {
      minDist = d;
      nearest = p;
    }
  }
  return { distKm: minDist, nearest };
}

// ====== 时间工具 ======

function parseTime(ts) {
  // ts_local 格式: "2026-08-23 00:00:18.420489"
  const d = new Date(ts.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

function timeInWindow(dateStr, start, end) {
  // 提取 HH:MM
  const m = dateStr.match(/(\d{2}):(\d{2})/);
  if (!m) return true; // 无法解析则放行
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const cur = hh * 60 + mm;
  const sm = start.match(/(\d{2}):(\d{2})/);
  const em = end.match(/(\d{2}):(\d{2})/);
  if (!sm || !em) return true;
  const s = parseInt(sm[1], 10) * 60 + parseInt(sm[2], 10);
  const e = parseInt(em[1], 10) * 60 + parseInt(em[2], 10);
  if (s <= e) {
    return cur >= s && cur <= e;
  } else {
    // 跨天, 如 22:00-06:00
    return cur >= s || cur <= e;
  }
}

// ====== 建表 ======

async function ensureTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS risk_zousi (
      id              BIGINT AUTO_INCREMENT PRIMARY KEY,
      mmsi            BIGINT                            COMMENT '船舶MMSI',
      vessel_name     VARCHAR(200)                      COMMENT '船名',
      silent_start_time VARCHAR(50)                     COMMENT '静默开始时间(最后一次AIS信号时间)',
      silent_end_time   VARCHAR(50)                     COMMENT '静默结束时间(恢复AIS信号时间)',
      silent_duration_min DECIMAL(10,2)                 COMMENT '静默时长(分钟)',
      silent_start_lng DECIMAL(11,6)                   COMMENT '静默开始位置经度',
      silent_start_lat DECIMAL(11,6)                   COMMENT '静默开始位置纬度',
      silent_end_lng   DECIMAL(11,6)                   COMMENT '静默结束位置经度',
      silent_end_lat   DECIMAL(11,6)                   COMMENT '静默结束位置纬度',
      coastline_distance_km DECIMAL(10,2)              COMMENT '静默开始位置距海岸线距离(KM)',
      nearest_port_distance_km DECIMAL(10,2)            COMMENT '静默开始位置距最近码头距离(KM)',
      nearest_port_name VARCHAR(200)                    COMMENT '最近码头名称',
      displacement_km  DECIMAL(10,2)                    COMMENT '静默后位移距离(KM)',
      sog_before       DOUBLE                           COMMENT '静默前速度(节)',
      sog_after        DOUBLE                           COMMENT '静默后速度(节)',
      nav_status_before VARCHAR(100)                   COMMENT '静默前航行状态',
      nav_status_after  VARCHAR(100)                   COMMENT '静默后航行状态',
      flag_country_cn  VARCHAR(50)                      COMMENT '船旗国(中文)',
      vessel_type_name VARCHAR(100)                     COMMENT '船舶类型名称(英文)',
      vessel_type      VARCHAR(50)                      COMMENT '船舶类型代码',
      vessel_type_name_cn VARCHAR(50)                   COMMENT '船舶类型中文名',
      destination      VARCHAR(255)                     COMMENT '目的地',
      algo_params      TEXT                             COMMENT '本次检测使用的算法参数JSON',
      create_time      DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '入库时间',
      INDEX idx_mmsi (mmsi),
      INDEX idx_silent_time (silent_start_time),
      INDEX idx_coastline_dist (coastline_distance_km),
      INDEX idx_port_dist (nearest_port_distance_km)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='zssf走私识别-船舶静默行为检测结果表'
  `);
  // 兼容: 老表没有新字段时自动 ALTER
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'risk_zousi'`
  );
  const colSet = new Set(cols.map(c => c.COLUMN_NAME));
  if (!colSet.has('nearest_port_distance_km')) {
    await conn.query(`ALTER TABLE risk_zousi
      ADD COLUMN nearest_port_distance_km DECIMAL(10,2) COMMENT '静默开始位置距最近码头距离(KM)' AFTER coastline_distance_km,
      ADD COLUMN nearest_port_name VARCHAR(200) COMMENT '最近码头名称' AFTER nearest_port_distance_km,
      ADD INDEX idx_port_dist (nearest_port_distance_km)`);
    console.log('[zssf] 已为 risk_zousi 表补充码头距离/名称字段');
  }
  console.log('[zssf] risk_zousi 表已就绪');
}

// ====== 船舶类型代码 → 中文名映射 (与 ais_record 保持一致) ======
// 来源: ais_record.vessel_type_name_cn 与 ais_origin_record.vessel_type 对应关系
const VESSEL_TYPE_CN_MAP = {
  '40': '高速船', '41': '高速船', '42': '高速船', '43': '高速船',
  '44': '高速船', '45': '高速船', '46': '高速船', '47': '高速船', '48': '高速船',
  '49': '未知',
  '50': '引航船', '51': '引航船',
  '52': '拖船', '53': '拖船', '54': '拖船', '55': '拖船',
  '56': '搜救船', '57': '搜救船',
  '58': '防污染船', '59': '防污染船',
  '60': '客船', '61': '客船', '62': '客船', '63': '客船', '64': '客船',
  '65': '客船', '66': '客船', '67': '客船', '68': '客船', '69': '客船',
  '70': '货船', '71': '货船', '72': '货船', '73': '货船', '74': '货船',
  '75': '货船', '76': '货船', '77': '货船', '78': '货船', '79': '货船',
  '80': '油船', '81': '油船', '82': '油船', '83': '油船', '84': '油船',
  '85': '油船', '86': '油船', '87': '油船', '88': '油船', '89': '油船',
  '90': '其他', '91': '其他', '92': '其他', '93': '其他', '94': '其他',
  '95': '其他', '96': '其他', '97': '其他', '98': '其他', '99': '其他',
  '30': '挖泥船', '31': '拖船', '32': '挖泥船', '33': '挖泥船', '34': 'Diving Ops',
  '35': 'Diving Ops',
  '0': '未知'
};

function vesselTypeCn(code) {
  if (!code && code !== '0') return '';
  return VESSEL_TYPE_CN_MAP[String(code)] || '';
}


// ====== 算法主逻辑 ======

async function runAlgorithm(dryRun) {
  const params = loadConfig();
  const coastSegments = loadCoastline();
  const ports = loadPorts();
  console.log('[zssf] 配置参数:', JSON.stringify(params));

  const conn = await mysql.createConnection(DB_CONFIG);

  // 建表
  await ensureTable(conn);

  // 获取所有有轨迹数据的 MMSI
  const [mmsiRows] = await conn.query(
    `SELECT DISTINCT mmsi FROM ais_origin_record
     WHERE latitude IS NOT NULL AND longitude IS NOT NULL
     ORDER BY mmsi`
  );
  console.log('[zssf] 共 %d 艘船舶待检测', mmsiRows.length);

  // 清空旧数据(非dry-run时)
  if (!dryRun) {
    await conn.query('TRUNCATE TABLE risk_zousi');
    console.log('[zssf] 已清空 risk_zousi 旧数据');
  }

  const results = [];
  let processed = 0;
  const total = mmsiRows.length;
  const progressStep = Math.max(1, Math.floor(total / 10));

  for (const { mmsi } of mmsiRows) {
    processed++;
    if (processed % progressStep === 0 || processed === total) {
      console.log('[zssf] 进度: %d/%d (%d%%)', processed, total, Math.round(processed/total*100));
    }

    // 拉取该船全部轨迹点(按时间排序)
    const [pts] = await conn.query(
      `SELECT ts_local, latitude, longitude, sog_kn, nav_status_text,
              vessel_name, flag_country_cn, vessel_type_name, vessel_type, destination
       FROM ais_origin_record
       WHERE mmsi = ? AND latitude IS NOT NULL AND longitude IS NOT NULL
       ORDER BY ts_local ASC`,
      [mmsi]
    );

    if (pts.length < 2) continue;

    // 遍历相邻轨迹点, 检测时间间隔(静默)
    for (let i = 0; i < pts.length - 1; i++) {
      const cur = pts[i];
      const next = pts[i + 1];

      const t1 = parseTime(cur.ts_local);
      const t2 = parseTime(next.ts_local);
      if (!t1 || !t2) continue;

      const gapMin = (t2 - t1) / 60000;

      // 条件3: 静默时长 >= silenceDurationMin
      if (gapMin < params.silenceDurationMin) continue;

      // 条件2: 静默开始时间在时间窗口内
      if (!timeInWindow(cur.ts_local, params.silenceTimeWindow.start, params.silenceTimeWindow.end)) continue;

      // 条件1: 静默开始位置距海岸线 < coastlineDistanceKm (靠近海岸才可疑)
      const coastDist = distanceToCoastline(
        parseFloat(cur.longitude), parseFloat(cur.latitude), coastSegments
      );
      if (coastDist >= params.coastlineDistanceKm) continue;

      // 条件5: 静默开始位置距离最近码头 >= minPortDistanceKm (远离码头才算海上可疑静默)
      // 如果 minPortDistanceKm 是 0 或未定义则跳过此项
      const portDist = distanceToNearestPort(
        parseFloat(cur.longitude), parseFloat(cur.latitude), ports
      );
      if (params.minPortDistanceKm && portDist.distKm < params.minPortDistanceKm) continue;

      // 条件4: 恢复位置与静默开始位置距离 <= restartDisplacementKm
      const displacement = haversineKm(
        parseFloat(cur.longitude), parseFloat(cur.latitude),
        parseFloat(next.longitude), parseFloat(next.latitude)
      );
      if (displacement > params.restartDisplacementKm) continue;

      // 所有条件满足, 记录结果
      const record = {
        mmsi: mmsi,
        vessel_name: cur.vessel_name || '',
        silent_start_time: cur.ts_local,
        silent_end_time: next.ts_local,
        silent_duration_min: gapMin.toFixed(2),
        silent_start_lng: parseFloat(cur.longitude).toFixed(6),
        silent_start_lat: parseFloat(cur.latitude).toFixed(6),
        silent_end_lng: parseFloat(next.longitude).toFixed(6),
        silent_end_lat: parseFloat(next.latitude).toFixed(6),
        coastline_distance_km: coastDist.toFixed(2),
        nearest_port_distance_km: isFinite(portDist.distKm) ? portDist.distKm.toFixed(2) : null,
        nearest_port_name: portDist.nearest ? (portDist.nearest.name || portDist.nearest.type || '未知码头') : null,
        displacement_km: displacement.toFixed(2),
        sog_before: cur.sog_kn,
        sog_after: next.sog_kn,
        nav_status_before: cur.nav_status_text || '',
        nav_status_after: next.nav_status_text || '',
        flag_country_cn: cur.flag_country_cn || '',
        vessel_type_name: cur.vessel_type_name || '',
        vessel_type: cur.vessel_type || '',
        vessel_type_name_cn: vesselTypeCn(cur.vessel_type),
        destination: cur.destination || '',
        algo_params: JSON.stringify(params)
      };
      results.push(record);
    }
  }

  console.log('[zssf] 检测完成, 共发现 %d 条静默记录', results.length);

  // 打印前10条结果
  if (results.length > 0) {
    console.log('\n[zssf] 前10条结果预览:');
    console.log('MMSI | 船名 | 静默开始 | 时长(分) | 距岸(KM) | 距码头(KM) | 位移(KM) | 速度前→后');
    results.slice(0, 10).forEach(r => {
      console.log('%s | %s | %s | %s | %s | %s | %s | %s→%s',
        r.mmsi, r.vessel_name, r.silent_start_time,
        r.silent_duration_min, r.coastline_distance_km,
        r.nearest_port_distance_km || '-',
        r.displacement_km, r.sog_before, r.sog_after);
    });
  }

  // 入库(逐条插入, 避免大批量占位符问题)
  if (!dryRun && results.length > 0) {
    const insertSql = `INSERT INTO risk_zousi
         (mmsi, vessel_name, silent_start_time, silent_end_time,
          silent_duration_min, silent_start_lng, silent_start_lat,
          silent_end_lng, silent_end_lat, coastline_distance_km,
          nearest_port_distance_km, nearest_port_name,
          displacement_km, sog_before, sog_after,
          nav_status_before, nav_status_after, flag_country_cn,
          vessel_type_name, vessel_type, vessel_type_name_cn, destination, algo_params)
         VALUES ?`;
    let inserted = 0;
    const BATCH = 100;
    for (let i = 0; i < results.length; i += BATCH) {
      const batch = results.slice(i, i + BATCH).map(r => [
        r.mmsi, r.vessel_name, r.silent_start_time, r.silent_end_time,
        r.silent_duration_min, r.silent_start_lng, r.silent_start_lat,
        r.silent_end_lng, r.silent_end_lat, r.coastline_distance_km,
        r.nearest_port_distance_km, r.nearest_port_name,
        r.displacement_km, r.sog_before, r.sog_after,
        r.nav_status_before, r.nav_status_after, r.flag_country_cn,
        r.vessel_type_name, r.vessel_type, r.vessel_type_name_cn, r.destination, r.algo_params
      ]);
      // mysql2 支持 VALUES ? 传入二维数组做批量插入
      await conn.query(insertSql, [batch]);
      inserted += batch.length;
    }
    console.log('[zssf] 已入库 %d 条记录到 risk_zousi 表', inserted);
  }

  // ====== 船舶类型补全 ======
  if (!dryRun) {
    await fillVesselType(conn);
  }

  await conn.end();
  return results;
}

/**
 * 船舶类型补全算法
 *
 * 策略(优先级从高到低):
 *   1. 从 ais_origin_record 查该 MMSI 最常见的 vessel_type (取众数)
 *   2. 从 ais_record 查该 MMSI 的 vessel_type
 *   3. 根据 MMSI 结构推断:
 *      - 前2位 00: 岸台/沿海电台
 *      - 前1位 0 且非00: 船队/管理站
 *      - 前3位 111: 搜救飞机
 *      - 前4位 1111: 搜救直升机
 *      - 前5位 11111: EPIRB(应急示位标)
 *      - 前2位 99: AIS基站
 *      - 前2位 8: 潜水员电台
 *      - 其余 9 位标准 MMSI: 按 MID(前3位) 查国家, 无法定类型 -> '商船'
 *   4. 仍无法判断: vessel_type_name_cn = ''
 *
 * 执行: UPDATE risk_zousi SET vessel_type=?, vessel_type_name=?, vessel_type_name_cn=?
 *       WHERE mmsi=? AND (vessel_type IS NULL OR vessel_type='')
 */
async function fillVesselType(conn) {
  console.log('[zssf] 开始船舶类型补全...');

  // 1) 从 ais_origin_record 查每个 MMSI 的 vessel_type 众数
  //    注意: ais_origin_record 可能没有 vessel_type_name_cn 列, 先探测
  let originHasCn = false;
  try {
    const [cols] = await conn.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ais_origin_record'");
    originHasCn = cols.some(c => c.COLUMN_NAME === 'vessel_type_name_cn');
  } catch (e) {}
  const originSelectCols = originHasCn
    ? 'mmsi, vessel_type, vessel_type_name, vessel_type_name_cn'
    : 'mmsi, vessel_type, vessel_type_name';
  const [originTypes] = await conn.query(`
    SELECT ${originSelectCols}, COUNT(*) as cnt
    FROM ais_origin_record
    WHERE vessel_type IS NOT NULL AND vessel_type != ''
    GROUP BY mmsi, vessel_type
    ORDER BY mmsi, cnt DESC
  `);
  // 每个 MMSI 取第一条(众数)
  const originMap = new Map();
  for (const row of originTypes) {
    if (!originMap.has(row.mmsi)) {
      originMap.set(row.mmsi, {
        vessel_type: row.vessel_type,
        vessel_type_name: row.vessel_type_name || '',
        vessel_type_name_cn: (originHasCn ? row.vessel_type_name_cn : '') || vesselTypeCn(row.vessel_type)
      });
    }
  }
  console.log('[zssf] ais_origin_record 中有 %d 个 MMSI 的 vessel_type 可用', originMap.size);

  // 2) 从 ais_record 查(作为兜底)
  let recordMap = new Map();
  try {
    let recordHasCn = false;
    try {
      const [cols] = await conn.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ais_record'");
      recordHasCn = cols.some(c => c.COLUMN_NAME === 'vessel_type_name_cn');
    } catch (e) {}
    const recordSelectCols = recordHasCn
      ? 'DISTINCT mmsi, vessel_type, vessel_type_name, vessel_type_name_cn'
      : 'DISTINCT mmsi, vessel_type, vessel_type_name';
    const [recordTypes] = await conn.query(`
      SELECT ${recordSelectCols}
      FROM ais_record
      WHERE vessel_type IS NOT NULL AND vessel_type != ''
    `);
    for (const row of recordTypes) {
      if (!recordMap.has(row.mmsi)) {
        recordMap.set(row.mmsi, {
          vessel_type: row.vessel_type,
          vessel_type_name: row.vessel_type_name || '',
          vessel_type_name_cn: (recordHasCn ? row.vessel_type_name_cn : '') || vesselTypeCn(row.vessel_type)
        });
      }
    }
    console.log('[zssf] ais_record 中有 %d 个 MMSI 的 vessel_type 可用(兜底)', recordMap.size);
  } catch (e) {
    console.log('[zssf] ais_record 查询失败(表可能不存在), 跳过:', e.message);
  }

  // 3) MMSI 结构推断
  function inferFromMmsi(mmsi) {
    const s = String(mmsi);
    const len = s.length;
    if (len < 9) return null;
    // 特殊前缀
    if (s.startsWith('00')) return { vessel_type: '90', vessel_type_name: 'Station', vessel_type_name_cn: '岸台/电台' };
    if (s.startsWith('0'))  return { vessel_type: '90', vessel_type_name: 'Group', vessel_type_name_cn: '船队管理站' };
    if (s.startsWith('11111')) return { vessel_type: '96', vessel_type_name: 'EPIRB', vessel_type_name_cn: '应急示位标' };
    if (s.startsWith('1111'))  return { vessel_type: '96', vessel_type_name: 'SAR Heli', vessel_type_name_cn: '搜救直升机' };
    if (s.startsWith('111'))   return { vessel_type: '96', vessel_type_name: 'SAR Aircraft', vessel_type_name_cn: '搜救飞机' };
    if (s.startsWith('99'))    return { vessel_type: '90', vessel_type_name: 'Base Station', vessel_type_name_cn: 'AIS基站' };
    if (s.startsWith('8'))     return { vessel_type: '90', vessel_type_name: 'Diver Radio', vessel_type_name_cn: '潜水员电台' };
    // 标准 9 位 MMSI: 商船
    return { vessel_type: '70', vessel_type_name: 'Cargo (inferred)', vessel_type_name_cn: '商船(推断)' };
  }

  // 4) 查所有需要补全的 risk_zousi 记录
  const [needFill] = await conn.query(`
    SELECT DISTINCT mmsi FROM risk_zousi
    WHERE vessel_type IS NULL OR vessel_type = ''
  `);
  console.log('[zssf] 需要补全 vessel_type 的 MMSI 数: %d', needFill.length);

  let updated = 0, byOrigin = 0, byRecord = 0, byMmsi = 0, stillEmpty = 0;
  for (const { mmsi } of needFill) {
    let info = originMap.get(mmsi) || recordMap.get(mmsi);
    if (info) {
      if (originMap.has(mmsi)) byOrigin++; else byRecord++;
    } else {
      info = inferFromMmsi(mmsi);
      if (info) byMmsi++;
      else { stillEmpty++; continue; }
    }
    await conn.query(
      `UPDATE risk_zousi SET vessel_type=?, vessel_type_name=?, vessel_type_name_cn=? WHERE mmsi=? AND (vessel_type IS NULL OR vessel_type='')`,
      [info.vessel_type, info.vessel_type_name, info.vessel_type_name_cn, mmsi]
    );
    updated++;
  }
  console.log('[zssf] 船舶类型补全完成: 更新 %d 条 (来源: origin=%d, record=%d, mmsi推断=%d, 仍空=%d)',
    updated, byOrigin, byRecord, byMmsi, stillEmpty);

  // 统计补全后空值
  const [stats] = await conn.query("SELECT COUNT(*) total, SUM(CASE WHEN vessel_type_name_cn IS NULL OR vessel_type_name_cn='' THEN 1 ELSE 0 END) empty_cn FROM risk_zousi");
  console.log('[zssf] 补全后: 总 %d 条, vessel_type_name_cn 为空 %d 条', stats[0].total, stats[0].empty_cn);
}

// ====== 入口 ======
const dryRun = process.argv.includes('--dry-run');
runAlgorithm(dryRun).then(results => {
  console.log('\n[zssf] %s 完成, 结果: %d 条', dryRun ? '试运行' : '正式运行', results.length);
  process.exit(0);
}).catch(err => {
  console.error('[zssf] 运行出错:', err.message);
  console.error(err.stack);
  process.exit(1);
});
