// 验证 AIS 数据入库结果
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: '127.0.0.1', port: 3306,
    user: 'root', password: 'Ais@2026',
    database: 'demo', charset: 'utf8mb4',
    dateStrings: true  // 以字符串形式返回 DATETIME
  });

  console.log('===== AIS 数据验证 =====\n');

  // 全量表样本
  const [full] = await conn.query(`
    SELECT mmsi, ship_name, lat, lon, last_update, source, file_name, file_time
    FROM ais_track_huang ORDER BY id LIMIT 5
  `);
  console.log('ais_track_huang 前 5 行:');
  full.forEach(r => {
    console.log(`  MMSI=${r.mmsi}, ${r.ship_name||'(无名)'}, (${r.lat},${r.lon}), last_update=${r.last_update}, source=${r.source||'NULL'}, file=${r.file_name}`);
  });

  // latest 表样本
  const [latest] = await conn.query(`
    SELECT mmsi, ship_name, lat, lon, last_update, source, file_name
    FROM ais_track_huang_latest ORDER BY last_update DESC LIMIT 5
  `);
  console.log('\nais_track_huang_latest 前 5 行(按时间倒序):');
  latest.forEach(r => {
    console.log(`  MMSI=${r.mmsi}, ${r.ship_name||'(无名)'}, (${r.lat},${r.lon}), last_update=${r.last_update}, source=${r.source||'NULL'}, file=${r.file_name}`);
  });

  // mock 数据样本(检查 Unix 时间戳转换)
  const [mock] = await conn.query(`
    SELECT mmsi, ship_name, last_update, source, file_name
    FROM ais_track_huang WHERE source='MOCK' LIMIT 3
  `);
  console.log('\nMOCK 数据样本(检查 Unix 时间戳转换):');
  mock.forEach(r => {
    console.log(`  MMSI=${r.mmsi}, ${r.ship_name}, last_update=${r.last_update}, source=${r.source}, file=${r.file_name}`);
  });

  // snap 数据样本
  const [snap] = await conn.query(`
    SELECT mmsi, ship_name, lat, lon, last_update, file_name
    FROM ais_track_huang WHERE file_name LIKE 'huangyan_live_snap%' LIMIT 3
  `);
  console.log('\nsnap 数据样本:');
  snap.forEach(r => {
    console.log(`  MMSI=${r.mmsi}, ${r.ship_name}, (${r.lat},${r.lon}), last_update=${r.last_update}, file=${r.file_name}`);
  });

  // 时间范围
  const [range] = await conn.query(`
    SELECT MIN(last_update) as min_t, MAX(last_update) as max_t
    FROM ais_track_huang WHERE last_update IS NOT NULL
  `);
  console.log(`\n时间范围: ${range[0].min_t} ~ ${range[0].max_t}`);

  await conn.end();
}

main().catch(e => {
  console.error('错误:', e.message);
  process.exit(1);
});
