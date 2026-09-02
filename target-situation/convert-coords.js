/**
 * 坐标系转换脚本: WGS84(GPS原始) → GCJ-02(高德/火星坐标系)
 * 处理表: aircraft_track(全量) 和 aircraft_track_latest(实时)
 * 算法: 国测局公开的 GCJ-02 加密算法
 */
const mysql = require('mysql2/promise');

const DB_CONFIG = {
  host: '127.0.0.1', port: 3306,
  user: 'root', password: 'Ais@2026',
  database: 'demo', charset: 'utf8mb4'
};

// ====== WGS84 → GCJ-02 转换算法 ======
const PI = 3.1415926535897932384626;
const A = 6378245.0;           // 长半轴
const EE = 0.00669342162296594323; // 偏心率平方

// 判断是否在国内,国外坐标不做偏移
function outOfChina(lng, lat) {
  return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
  return ret;
}

function wgs84ToGcj02(lng, lat) {
  if (outOfChina(lng, lat)) {
    return [lng, lat]; // 国外不偏移
  }
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
  dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI);
  return [lng + dLng, lat + dLat];
}

// ====== 批量转换某张表 ======
async function convertTable(conn, table, batchSize) {
  const [cntRows] = await conn.query(
    `SELECT COUNT(*) as cnt FROM ${table} WHERE longitude IS NOT NULL AND latitude IS NOT NULL`
  );
  const total = cntRows[0].cnt;
  console.log(`\n开始转换 ${table}: ${total.toLocaleString()} 条记录`);

  let processed = 0;
  let lastId = 0;
  const startTime = Date.now();

  while (true) {
    const [rows] = await conn.query(
      `SELECT id, longitude, latitude FROM ${table}
       WHERE id > ? AND longitude IS NOT NULL AND latitude IS NOT NULL
       ORDER BY id ASC LIMIT ?`,
      [lastId, batchSize]
    );
    if (rows.length === 0) break;

    // 构造 CASE WHEN 批量 UPDATE
    const idList = [];
    const lngCases = [];
    const latCases = [];
    let skippedOutOfChina = 0;

    for (const r of rows) {
      const lng = parseFloat(r.longitude);
      const lat = parseFloat(r.latitude);
      const [newLng, newLat] = wgs84ToGcj02(lng, lat);
      idList.push(r.id);
      lngCases.push(`WHEN ${r.id} THEN ${newLng.toFixed(6)}`);
      latCases.push(`WHEN ${r.id} THEN ${newLat.toFixed(6)}`);
      if (outOfChina(lng, lat)) skippedOutOfChina++;
    }

    const idListStr = idList.join(',');
    const lngCasesStr = lngCases.join(' ');
    const latCasesStr = latCases.join(' ');

    await conn.query(
      `UPDATE ${table}
         SET longitude = CASE id ${lngCasesStr} END,
             latitude  = CASE id ${latCasesStr} END
       WHERE id IN (${idListStr})`
    );

    processed += rows.length;
    lastId = rows[rows.length - 1].id;

    // 每 50000 条打印进度
    if (Math.floor(processed / 50000) !== Math.floor((processed - rows.length) / 50000) || processed >= total) {
      const pct = (processed / total * 100).toFixed(1);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  ${table}: ${processed.toLocaleString()}/${total.toLocaleString()} (${pct}%) 用时 ${elapsed}s`);
    }
  }

  console.log(`${table} 转换完成: ${processed.toLocaleString()} 条记录`);
}

async function main() {
  const conn = await mysql.createConnection(DB_CONFIG);
  console.log('===== 坐标系转换: WGS84 → GCJ-02(高德) =====');
  console.log(`开始时间: ${new Date().toLocaleString()}`);

  // 转换两张表(先转 latest 小表,再转 track 大表)
  await convertTable(conn, 'aircraft_track_latest', 5000);
  await convertTable(conn, 'aircraft_track', 5000);

  // 验证样本
  console.log('\n===== 验证样本 =====');
  const [samples] = await conn.query(
    `SELECT icao, callsign, longitude, latitude FROM aircraft_track_latest
     WHERE longitude IS NOT NULL LIMIT 5`
  );
  console.log('aircraft_track_latest 转换后样本:');
  samples.forEach(r => {
    console.log(`  icao=${r.icao}, callsign=${r.callsign}, lng=${r.longitude}, lat=${r.latitude}`);
  });

  // 统计国内/国外分布
  const [stats] = await conn.query(
    `SELECT
      SUM(CASE WHEN longitude BETWEEN 73.66 AND 135.05 AND latitude BETWEEN 3.86 AND 53.55
               THEN 1 ELSE 0 END) as in_china,
      COUNT(*) as total
     FROM aircraft_track_latest`
  );
  console.log(`\n实时表国内坐标数: ${stats[0].in_china} (已加密偏移)`);
  console.log(`实时表总记录数: ${stats[0].total}`);

  await conn.end();
  console.log(`\n完成时间: ${new Date().toLocaleString()}`);
  console.log('===== 转换完成 =====');
}

main().catch(e => {
  console.error('转换失败:', e.message);
  console.error(e.stack);
  process.exit(1);
});
