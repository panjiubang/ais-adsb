/**
 * AIS 轨迹数据建表+导入脚本
 * 数据源: ais_data 目录下所有 .csv 文件
 * 入库到: ais_track_huang(全量) 和 ais_track_huang_latest(每船最新一条)
 *
 * CSV 格式支持两种:
 *   1. snap/final/singapore 格式(列名: MMSI,SHIP_NAME,CALLSIGN,IMO,SHIP_TYPE,LAT,LON,
 *      DISTANCE_NM,SOG,COG,HEADING,NAV_STATUS,DRAUGHT,DESTINATION,ETA,LAST_UPDATE,
 *      POSITION_COUNT,STATIC_COUNT)
 *   2. huangyan_ais 格式(列名: MMSI,NAME,CALLSIGN,IMO,TYPE,LAT,LON,DISTANCE_NM,SPEED,
 *      COURSE,HEADING,NAVSTAT,DRAUGHT,DESTINATION,ETA,TIMESTAMP,SOURCE)
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const DATA_DIR = 'C:\\Users\\Administrator\\AppData\\Roaming\\TRAE SOLO CN\\ModularData\\ai-agent\\work-mode-projects\\6a797786174653ef3756a7ac\\ais_data';

const DB_CONFIG = {
  host: '127.0.0.1', port: 3306,
  user: 'root', password: 'Ais@2026',
  database: 'demo', charset: 'utf8mb4'
};

// ====== 数据清洗函数 ======
// 字符串清洗: 去空格,空串/null/NaN 转为 null
const ss = v => {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || s === 'NaN' || s.toLowerCase() === 'null') return null;
  return s;
};
// 浮点数清洗
const sf = v => {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
};
// 整数清洗
const si = v => {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
};
// 时间字符串清洗 -> MySQL DATETIME
// 支持 '2026-08-24 05:17:10' / Unix秒时间戳
const st = v => {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (s === '' || s === 'NaN') return null;
  // Unix 秒时间戳(纯数字,长度>=10)
  if (/^\d{10,}$/.test(s)) {
    const sec = parseInt(s.substring(0, 10), 10);
    const d = new Date(sec * 1000);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }
  // 已是 datetime 字符串,直接返回
  return s;
};

// 简易 CSV 行解析(支持引号包裹字段)
function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i + 1] === '"') {
      cur += '"'; i++;
    } else if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

// 从文件名解析采集时间 huangyan_live_snap_20260824_114125.csv -> 2026-08-24 11:41:25
function parseFileTime(fileName) {
  const m = fileName.match(/_(\d{8})_(\d{6})\.csv$/);
  if (!m) return null;
  const d = m[1], t = m[2];
  return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)} ${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}`;
}

// 将一行 CSV 数据按表头映射为统一结构
function mapRow(headers, row, fileName, fileTime) {
  const get = (h) => {
    const idx = headers.indexOf(h);
    return idx >= 0 ? row[idx] : null;
  };
  const has = (h) => headers.indexOf(h) >= 0;

  // 区分两种格式
  const isMock = has('SOURCE'); // huangyan_ais 格式
  const lastUpdate = isMock
    ? st(get('TIMESTAMP'))
    : st(get('LAST_UPDATE'));
  const shipName = isMock ? ss(get('NAME')) : ss(get('SHIP_NAME'));
  const shipType = isMock ? ss(get('TYPE')) : ss(get('SHIP_TYPE'));
  const sog = isMock ? sf(get('SPEED')) : sf(get('SOG'));
  const cog = isMock ? sf(get('COURSE')) : sf(get('COG'));
  const navStatus = isMock ? ss(get('NAVSTAT')) : ss(get('NAV_STATUS'));
  const source = isMock ? ss(get('SOURCE')) : null;
  const positionCount = isMock ? null : si(get('POSITION_COUNT'));
  const staticCount = isMock ? null : si(get('STATIC_COUNT'));

  return [
    ss(get('MMSI')),
    shipName,
    ss(get('CALLSIGN')),
    ss(get('IMO')),
    shipType,
    sf(get('LAT')),
    sf(get('LON')),
    sf(get('DISTANCE_NM')),
    sog,
    cog,
    sf(get('HEADING')),
    navStatus,
    sf(get('DRAUGHT')),
    ss(get('DESTINATION')),
    ss(get('ETA')),
    lastUpdate,
    positionCount,
    staticCount,
    source,
    fileName,
    fileTime
  ];
}

async function main() {
  const conn = await mysql.createConnection(DB_CONFIG);

  // ========== 1. 建表 ==========
  console.log('===== 创建表 =====');

  await conn.query(`
    CREATE TABLE IF NOT EXISTS ais_track_huang (
      id              BIGINT       AUTO_INCREMENT PRIMARY KEY,
      mmsi            VARCHAR(15)                                COMMENT '海上移动业务识别码(MMSI,9位数字)',
      ship_name       VARCHAR(100)                               COMMENT '船名',
      callsign        VARCHAR(20)                                COMMENT '呼号',
      imo             VARCHAR(15)                               COMMENT 'IMO号(国际海事组织编号,7位数字)',
      ship_type       VARCHAR(10)                               COMMENT '船舶类型代码(如70=货船,80=油船)',
      lat             DECIMAL(10,5)                             COMMENT '纬度(WGS84,北纬正)',
      lon             DECIMAL(10,5)                             COMMENT '经度(WGS84,东经正)',
      distance_nm     DECIMAL(10,2)                             COMMENT '距参考点距离(海里)',
      sog             DECIMAL(6,2)                              COMMENT '对地航速(SOG,单位:节)',
      cog             DECIMAL(6,2)                              COMMENT '对地航向(COG,0-360度)',
      heading         DECIMAL(6,1)                              COMMENT '船首向(HEADING,0-511度,511=不可用)',
      nav_status      VARCHAR(10)                               COMMENT '航行状态(0=航行中,1=锚泊,5=系泊,8=动力下航行)',
      draught         DECIMAL(5,1)                              COMMENT '吃水深度(单位:米)',
      destination     VARCHAR(100)                              COMMENT '目的地港口代码',
      eta             VARCHAR(50)                               COMMENT '预计到达时间(ETA)',
      last_update     DATETIME                                  COMMENT '数据更新时间(UTC+8)',
      position_count  INT                                      COMMENT '位置报告数量',
      static_count    INT                                      COMMENT '静态信息报告数量',
      source          VARCHAR(20)                              COMMENT '数据来源(MOCK=模拟数据,NULL=真实采集)',
      file_name       VARCHAR(255)                              COMMENT '原始文件名',
      file_time       DATETIME                                  COMMENT '文件采集时间(从文件名解析)',
      create_time     DATETIME DEFAULT CURRENT_TIMESTAMP       COMMENT '入库时间',
      INDEX idx_mmsi (mmsi),
      INDEX idx_last_update (last_update),
      INDEX idx_file_time (file_time),
      INDEX idx_create_time (create_time)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AIS船舶轨迹全量表(黄岩岛/新加坡互联网采集数据)'
  `);
  console.log('  ais_track_huang 表已创建');

  await conn.query(`
    CREATE TABLE IF NOT EXISTS ais_track_huang_latest (
      id              BIGINT       AUTO_INCREMENT PRIMARY KEY,
      mmsi            VARCHAR(15)                                COMMENT '海上移动业务识别码(MMSI,9位数字)',
      ship_name       VARCHAR(100)                               COMMENT '船名',
      callsign        VARCHAR(20)                                COMMENT '呼号',
      imo             VARCHAR(15)                               COMMENT 'IMO号(国际海事组织编号,7位数字)',
      ship_type       VARCHAR(10)                               COMMENT '船舶类型代码(如70=货船,80=油船)',
      lat             DECIMAL(10,5)                             COMMENT '纬度(WGS84,北纬正)',
      lon             DECIMAL(10,5)                             COMMENT '经度(WGS84,东经正)',
      distance_nm     DECIMAL(10,2)                             COMMENT '距参考点距离(海里)',
      sog             DECIMAL(6,2)                              COMMENT '对地航速(SOG,单位:节)',
      cog             DECIMAL(6,2)                              COMMENT '对地航向(COG,0-360度)',
      heading         DECIMAL(6,1)                              COMMENT '船首向(HEADING,0-511度,511=不可用)',
      nav_status      VARCHAR(10)                               COMMENT '航行状态(0=航行中,1=锚泊,5=系泊,8=动力下航行)',
      draught         DECIMAL(5,1)                              COMMENT '吃水深度(单位:米)',
      destination     VARCHAR(100)                             COMMENT '目的地港口代码',
      eta             VARCHAR(50)                               COMMENT '预计到达时间(ETA)',
      last_update     DATETIME                                  COMMENT '数据更新时间(UTC+8)',
      source          VARCHAR(20)                              COMMENT '数据来源(MOCK=模拟数据,NULL=真实采集)',
      file_name       VARCHAR(255)                              COMMENT '最近一次来源文件名',
      file_time       DATETIME                                  COMMENT '最近一次文件采集时间',
      create_time     DATETIME DEFAULT CURRENT_TIMESTAMP       COMMENT '入库时间',
      UNIQUE KEY uk_mmsi (mmsi),
      INDEX idx_last_update (last_update)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AIS船舶最新轨迹表(每船仅保留最新一条)'
  `);
  console.log('  ais_track_huang_latest 表已创建');

  // ========== 2. 清空旧数据 ==========
  console.log('\n===== 清空旧数据 =====');
  await conn.query('TRUNCATE TABLE ais_track_huang');
  await conn.query('TRUNCATE TABLE ais_track_huang_latest');
  console.log('  表已清空');

  // ========== 3. 遍历 CSV 文件入库 ==========
  console.log('\n===== 导入数据 =====');
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.toLowerCase().endsWith('.csv'))
    .sort();

  console.log(`  共 ${files.length} 个 CSV 文件`);

  let totalRows = 0;
  let processedFiles = 0;
  const startTime = Date.now();

  // 批量插入,每 batch 500 行
  const BATCH = 500;
  const FIELDS = 21;
  const rowPlaceholder = '(' + Array(FIELDS).fill('?').join(',') + ')';
  let batch = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const placeholders = batch.map(() => rowPlaceholder).join(',');
    const values = [];
    for (const r of batch) {
      for (let i = 0; i < FIELDS; i++) values.push(r[i] === undefined ? null : r[i]);
    }
    try {
      await conn.query(
        `INSERT INTO ais_track_huang
          (mmsi,ship_name,callsign,imo,ship_type,lat,lon,distance_nm,sog,cog,heading,
           nav_status,draught,destination,eta,last_update,position_count,static_count,
           source,file_name,file_time)
         VALUES ${placeholders}`,
        values
      );
      totalRows += batch.length;
    } catch (e) {
      console.error(`\n  SQL 错误: ${e.message}`);
      console.error(`  batch 大小: ${batch.length}, values 长度: ${values.length}`);
      console.error(`  第一行样本: ${JSON.stringify(batch[0])}`);
      throw e;
    }
    batch = [];
  };

  for (const file of files) {
    const filePath = path.join(DATA_DIR, file);
    const fileTime = parseFileTime(file);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/).filter(l => l.trim() !== '');

    if (lines.length < 2) {
      console.log(`  跳过 ${file}: 仅有表头/空文件`);
      continue;
    }

    // 解析表头,去掉 BOM
    let headers = parseCsvLine(lines[0].replace(/^\uFEFF/, ''));
    headers = headers.map(h => h.trim());

    let fileRows = 0;
    for (let i = 1; i < lines.length; i++) {
      const row = parseCsvLine(lines[i]);
      if (row.length < 5) continue; // 跳过明显残缺行
      // 必须有 MMSI 才入库
      const mmsi = (row[headers.indexOf('MMSI')] || '').trim();
      if (!mmsi) continue;
      const mapped = mapRow(headers, row, file, fileTime);
      batch.push(mapped);
      fileRows++;
      if (batch.length >= BATCH) {
        await flush();
      }
    }
    processedFiles++;
    if (processedFiles % 20 === 0 || processedFiles === files.length) {
      const pct = (processedFiles / files.length * 100).toFixed(0);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  处理进度: ${processedFiles}/${files.length} (${pct}%), 累计入库 ${totalRows.toLocaleString()} 行, 用时 ${elapsed}s`);
    }
  }
  await flush(); // 处理最后不足一批的数据

  console.log(`\n  全量入库完成: ${totalRows.toLocaleString()} 条记录, ${processedFiles} 个文件`);

  // ========== 4. 生成实时表 ==========
  console.log('\n===== 生成 ais_track_huang_latest =====');
  // 每个 mmsi 仅保留 last_update 最大的一条
  await conn.query(`
    INSERT INTO ais_track_huang_latest
      (mmsi, ship_name, callsign, imo, ship_type, lat, lon, distance_nm, sog, cog,
       heading, nav_status, draught, destination, eta, last_update, source, file_name, file_time)
    SELECT t.mmsi, t.ship_name, t.callsign, t.imo, t.ship_type, t.lat, t.lon, t.distance_nm,
           t.sog, t.cog, t.heading, t.nav_status, t.draught, t.destination, t.eta, t.last_update,
           t.source, t.file_name, t.file_time
    FROM ais_track_huang t
    INNER JOIN (
      SELECT mmsi, MAX(last_update) as max_lt
      FROM ais_track_huang
      WHERE last_update IS NOT NULL AND mmsi IS NOT NULL
      GROUP BY mmsi
    ) latest ON t.mmsi = latest.mmsi AND t.last_update = latest.max_lt
    WHERE t.mmsi IS NOT NULL
    GROUP BY t.mmsi
  `);

  // ========== 5. 验证统计 ==========
  const [fullCnt] = await conn.query('SELECT COUNT(*) as cnt FROM ais_track_huang');
  const [latestCnt] = await conn.query('SELECT COUNT(*) as cnt FROM ais_track_huang_latest');
  const [mmsiCnt] = await conn.query('SELECT COUNT(DISTINCT mmsi) as cnt FROM ais_track_huang WHERE mmsi IS NOT NULL');

  console.log('\n===== 入库统计 =====');
  console.log(`  ais_track_huang:         ${fullCnt[0].cnt.toLocaleString()} 条`);
  console.log(`  ais_track_huang_latest:  ${latestCnt[0].cnt.toLocaleString()} 条`);
  console.log(`  独立 MMSI 数:            ${mmsiCnt[0].cnt.toLocaleString()} 条`);

  // 按文件类型统计
  const [byType] = await conn.query(`
    SELECT
      CASE
        WHEN file_name LIKE 'huangyan_live_snap_%' THEN 'huangyan_snap'
        WHEN file_name LIKE 'huangyan_live_final_%' THEN 'huangyan_final'
        WHEN file_name LIKE 'singapore_ais_%' THEN 'singapore'
        WHEN file_name LIKE 'huangyan_ais_%' THEN 'huangyan_ais_mock'
        ELSE 'other'
      END as data_type,
      COUNT(*) as cnt,
      COUNT(DISTINCT mmsi) as distinct_mmsi
    FROM ais_track_huang
    GROUP BY data_type
    ORDER BY cnt DESC
  `);
  console.log('\n按数据源分类:');
  byType.forEach(r => {
    console.log(`  ${r.data_type}: ${r.cnt.toLocaleString()} 行, ${r.distinct_mmsi.toLocaleString()} 艘船`);
  });

  // 样本
  const [samples] = await conn.query(`
    SELECT mmsi, ship_name, lat, lon, last_update, file_name
    FROM ais_track_huang_latest
    ORDER BY last_update DESC LIMIT 5
  `);
  console.log('\n最新轨迹样本:');
  samples.forEach(r => {
    console.log(`  MMSI=${r.mmsi}, ${r.ship_name||'(无名)'}, (${r.lat}, ${r.lon}), 时间=${r.last_update}, 来源=${r.file_name}`);
  });

  await conn.end();
  console.log(`\n===== 完成,总用时 ${((Date.now() - startTime) / 1000).toFixed(1)}s =====`);
}

main().catch(e => {
  console.error('导入失败:', e.message);
  console.error(e.stack);
  process.exit(1);
});
