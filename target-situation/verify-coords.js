/**
 * 坐标转换结果验证
 */
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: '127.0.0.1', port: 3306,
    user: 'root', password: 'Ais@2026',
    database: 'demo', charset: 'utf8mb4'
  });

  console.log('===== 坐标转换验证 =====\n');

  // 国内坐标样本(已加密偏移)
  const [cn] = await conn.query(`
    SELECT icao, callsign, longitude, latitude
    FROM aircraft_track_latest
    WHERE longitude BETWEEN 73.66 AND 135.05
      AND latitude BETWEEN 3.86 AND 53.55
    LIMIT 5
  `);
  console.log('国内坐标样本(已加密偏移,GCJ-02):');
  cn.forEach(r => {
    console.log(`  icao=${r.icao}, callsign=${r.callsign}, lng=${r.longitude}, lat=${r.latitude}`);
  });

  // 国外坐标样本(未加密,保留WGS84)
  const [abroad] = await conn.query(`
    SELECT icao, callsign, longitude, latitude
    FROM aircraft_track_latest
    WHERE longitude NOT BETWEEN 73.66 AND 135.05
       OR latitude NOT BETWEEN 3.86 AND 53.55
    LIMIT 5
  `);
  console.log('\n国外坐标样本(未偏移,保留WGS84):');
  abroad.forEach(r => {
    console.log(`  icao=${r.icao}, callsign=${r.callsign}, lng=${r.longitude}, lat=${r.latitude}`);
  });

  // 统计
  const [stats] = await conn.query(`
    SELECT
      SUM(CASE WHEN longitude BETWEEN 73.66 AND 135.05 AND latitude BETWEEN 3.86 AND 53.55
               THEN 1 ELSE 0 END) as in_china,
      SUM(CASE WHEN longitude NOT BETWEEN 73.66 AND 135.05
                    OR latitude NOT BETWEEN 3.86 AND 53.55
               THEN 1 ELSE 0 END) as abroad,
      COUNT(*) as total
    FROM aircraft_track_latest
  `);
  console.log('\n国内/国外分布:');
  console.log(`  国内(已偏移): ${stats[0].in_china}`);
  console.log(`  国外(未偏移): ${stats[0].abroad}`);
  console.log(`  总计: ${stats[0].total}`);

  // 检查经纬度范围是否合理
  const [range] = await conn.query(`
    SELECT MIN(longitude) as min_lng, MAX(longitude) as max_lng,
           MIN(latitude) as min_lat, MAX(latitude) as max_lat
    FROM aircraft_track_latest
  `);
  console.log('\n经纬度范围:');
  console.log(`  经度: ${range[0].min_lng} ~ ${range[0].max_lng}`);
  console.log(`  纬度: ${range[0].min_lat} ~ ${range[0].max_lat}`);

  await conn.end();
  console.log('\n===== 验证完成 =====');
}

main().catch(e => {
  console.error('验证失败:', e.message);
  process.exit(1);
});
