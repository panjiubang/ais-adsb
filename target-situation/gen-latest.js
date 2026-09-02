const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection({
    host:'127.0.0.1',port:3306,user:'root',password:'Ais@2026',database:'demo'
  });

  // 清空 latest 表
  console.log('清空 aircraft_track_latest...');
  await conn.query('TRUNCATE TABLE aircraft_track_latest');

  // 生成 latest 表(每架飞机取最新一条, GROUP BY 去重)
  console.log('生成 aircraft_track_latest...');
  await conn.query(`
    INSERT INTO aircraft_track_latest
      (icao, callsign, regist, longitude, latitude, heading, speed, altitude,
       locationtime, now_time, aircraft_type, flight, flag)
    SELECT t.icao, t.callsign, t.regist, t.longitude, t.latitude, t.heading,
           t.speed, t.altitude, t.locationtime, t.now_time, t.aircraft_type,
           t.flight, t.flag
    FROM aircraft_track t
    INNER JOIN (
      SELECT icao, MAX(locationtime) as max_lt
      FROM aircraft_track
      WHERE locationtime IS NOT NULL
      GROUP BY icao
    ) latest ON t.icao = latest.icao AND t.locationtime = latest.max_lt
    GROUP BY t.icao
  `);

  // 验证
  const [cnt] = await conn.query('SELECT COUNT(*) as cnt FROM aircraft_track_latest');
  console.log('aircraft_track_latest 记录数:', cnt[0].cnt);

  const [stats] = await conn.query(`
    SELECT
      COUNT(*) as total_records,
      COUNT(DISTINCT icao) as unique_aircraft,
      MIN(locationtime) as min_time,
      MAX(locationtime) as max_time
    FROM aircraft_track
    WHERE locationtime IS NOT NULL
  `);
  console.log('\n===== aircraft_track 统计 =====');
  console.log('  总记录数:', stats[0].total_records);
  console.log('  独立飞机数:', stats[0].unique_aircraft);
  if(stats[0].min_time){
    console.log('  最早时间:', new Date(parseFloat(stats[0].min_time)*1000).toISOString());
    console.log('  最晚时间:', new Date(parseFloat(stats[0].max_time)*1000).toISOString());
  }

  const [flagStats] = await conn.query(`
    SELECT flag, COUNT(*) as cnt, COUNT(DISTINCT icao) as aircraft_cnt
    FROM aircraft_track GROUP BY flag ORDER BY flag
  `);
  console.log('\n  各数据源统计:');
  const sources = {1:'adsbexchange',2:'planespotters',3:'airnavradar',4:'flightradar24'};
  flagStats.forEach(f=>console.log(`    flag=${f.flag} (${sources[f.flag]||'未知'}): ${f.cnt} 条, ${f.aircraft_cnt} 架飞机`));

  // 查看几条 latest 样本
  const [sample] = await conn.query('SELECT * FROM aircraft_track_latest LIMIT 5');
  console.log('\n===== latest 表样本 =====');
  sample.forEach(s=>console.log(JSON.stringify(s)));

  await conn.end();
})().catch(e=>{console.error(e.message);process.exit(1)});
