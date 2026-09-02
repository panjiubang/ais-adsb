/**
 * 飞机轨迹数据入库验证脚本
 */
const mysql = require('mysql2/promise');

const DB_CONFIG = {
  host: '127.0.0.1', port: 3306,
  user: 'root', password: 'Ais@2026',
  database: 'demo', charset: 'utf8mb4'
};

async function main() {
  const conn = await mysql.createConnection(DB_CONFIG);

  console.log('===== 飞机轨迹数据入库验证 =====\n');

  // 1. 表结构验证
  const [tables] = await conn.query("SHOW TABLES LIKE 'aircraft_track%'");
  console.log('1. 已创建表:');
  tables.forEach(t => {
    const name = Object.values(t)[0];
    console.log(`   - ${name}`);
  });

  // 2. 总记录数
  const [totalRows] = await conn.query('SELECT COUNT(*) as cnt FROM aircraft_track');
  console.log(`\n2. aircraft_track 总记录数: ${totalRows[0].cnt.toLocaleString()}`);

  const [latestRows] = await conn.query('SELECT COUNT(*) as cnt FROM aircraft_track_latest');
  console.log(`   aircraft_track_latest 总记录数: ${latestRows[0].cnt.toLocaleString()}`);

  // 3. 独立飞机数
  const [uniqueIcao] = await conn.query('SELECT COUNT(DISTINCT icao) as cnt FROM aircraft_track');
  console.log(`\n3. 独立飞机数(去重icao): ${uniqueIcao[0].cnt.toLocaleString()}`);

  // 4. 各数据源分布
  console.log('\n4. 各数据源(flag)分布:');
  const [flagDist] = await conn.query(`
    SELECT flag,
           CASE flag
             WHEN '1' THEN 'adsbexchange'
             WHEN '2' THEN 'planespotters'
             WHEN '3' THEN 'airnavradar'
             WHEN '4' THEN 'flightradar24'
             ELSE 'unknown'
           END as source,
           COUNT(*) as cnt,
           COUNT(DISTINCT icao) as unique_icao
    FROM aircraft_track
    GROUP BY flag
    ORDER BY flag
  `);
  console.log('   flag | 数据源         | 记录数       | 独立飞机数');
  console.log('   -----|---------------|-------------|-----------');
  flagDist.forEach(r => {
    console.log(`   ${String(r.flag).padEnd(4)} | ${r.source.padEnd(13)} | ${String(r.cnt).padStart(11)} | ${String(r.unique_icao).padStart(9)}`);
  });

  // 5. 数据完整性检查
  console.log('\n5. 数据完整性检查:');
  const [nullCheck] = await conn.query(`
    SELECT
      SUM(CASE WHEN icao IS NULL OR icao='' THEN 1 ELSE 0 END) as null_icao,
      SUM(CASE WHEN longitude IS NULL THEN 1 ELSE 0 END) as null_lon,
      SUM(CASE WHEN latitude IS NULL THEN 1 ELSE 0 END) as null_lat,
      SUM(CASE WHEN locationtime IS NULL THEN 1 ELSE 0 END) as null_lt,
      SUM(CASE WHEN callsign IS NULL OR callsign='' THEN 1 ELSE 0 END) as null_cs
    FROM aircraft_track
  `);
  console.log(`   空icao记录数: ${nullCheck[0].null_icao.toLocaleString()}`);
  console.log(`   空经度记录数: ${nullCheck[0].null_lon.toLocaleString()}`);
  console.log(`   空纬度记录数: ${nullCheck[0].null_lat.toLocaleString()}`);
  console.log(`   空locationtime记录数: ${nullCheck[0].null_lt.toLocaleString()}`);
  console.log(`   空callsign记录数: ${nullCheck[0].null_cs.toLocaleString()}`);

  // 6. 时间范围
  console.log('\n6. 数据时间范围:');
  const [timeRange] = await conn.query(`
    SELECT
      FROM_UNIXTIME(MIN(locationtime)) as min_time,
      FROM_UNIXTIME(MAX(locationtime)) as max_time,
      MIN(locationtime) as min_ts,
      MAX(locationtime) as max_ts
    FROM aircraft_track
    WHERE locationtime IS NOT NULL
  `);
  if (timeRange[0].min_time) {
    console.log(`   最早时间: ${timeRange[0].min_time}`);
    console.log(`   最晚时间: ${timeRange[0].max_time}`);
  } else {
    console.log('   无有效时间数据');
  }

  // 7. 实时表与全量表一致性
  console.log('\n7. 实时表与全量表一致性:');
  const [latestCheck] = await conn.query(`
    SELECT COUNT(DISTINCT icao) as latest_unique,
           (SELECT COUNT(DISTINCT icao) FROM aircraft_track WHERE icao IS NOT NULL AND icao<>'') as track_unique
    FROM aircraft_track_latest
    WHERE icao IS NOT NULL AND icao<>''
  `);
  console.log(`   全量表独立飞机数: ${latestCheck[0].track_unique.toLocaleString()}`);
  console.log(`   实时表独立飞机数: ${latestCheck[0].latest_unique.toLocaleString()}`);
  const consistent = latestCheck[0].latest_unique === latestCheck[0].track_unique;
  console.log(`   一致性: ${consistent ? '✓ 一致' : '✗ 不一致'}`);

  // 8. 各数据源样本数据
  console.log('\n8. 各数据源样本数据(前2条):');
  for (const flag of ['1', '2', '3', '4']) {
    const [sample] = await conn.query(
      'SELECT icao, callsign, longitude, latitude, altitude, locationtime FROM aircraft_track WHERE flag=? LIMIT 2',
      [flag]
    );
    const source = { '1':'adsbexchange', '2':'planespotters', '3':'airnavradar', '4':'flightradar24' }[flag];
    console.log(`\n   [flag=${flag} ${source}]`);
    if (sample.length === 0) {
      console.log('   无数据');
    } else {
      sample.forEach(r => {
        console.log(`     icao=${r.icao}, callsign=${r.callsign}, ` +
          `lon=${r.longitude}, lat=${r.latitude}, alt=${r.altitude}, lt=${r.locationtime}`);
      });
    }
  }

  await conn.end();
  console.log('\n===== 验证完成 =====');
}

main().catch(err => {
  console.error('验证失败:', err);
  process.exit(1);
});
