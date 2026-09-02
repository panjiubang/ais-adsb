/**
 * 飞机轨迹数据建表+导入脚本
 * 数据源: C:\Users\Administrator\Desktop\hyd\3702~3705 目录下的JSON格式txt文件
 * 入库字段(rk.txt定义): Icao, callsign, regist, longitude, latitude, heading,
 *                       speed, altitude, locationtime, now, aircraft_type, flight, flag
 * 表1: aircraft_track        - 飞机轨迹全量表
 * 表2: aircraft_track_latest - 飞机实时轨迹表(每架飞机仅保留最新一条)
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// 数据源目录(仅入库3702目录数据)
const DATA_DIRS = [
  { dir: '3702', source: 'globe.adsbexchange.com', flag: '1' },
];
const BASE_DIR = 'C:\\Users\\Administrator\\AppData\\Roaming\\TRAE SOLO CN\\ModularData\\ai-agent\\work-mode-projects\\6a797786174653ef3756a7ac';

// 数据库配置
const DB_CONFIG = {
  host: '127.0.0.1', port: 3306,
  user: 'root', password: 'Ais@2026',
  database: 'demo', charset: 'utf8mb4'
};

async function main() {
  const conn = await mysql.createConnection(DB_CONFIG);

  // ========== 1. 建表 ==========
  console.log('===== 创建表 =====');

  // 表1: 飞机轨迹全量表
  await conn.query(`
    CREATE TABLE IF NOT EXISTS aircraft_track (
      id          BIGINT       AUTO_INCREMENT PRIMARY KEY,
      icao        VARCHAR(20)                               COMMENT 'ICAO地址(飞机唯一标识,十六进制或十进制字符串)',
      callsign    VARCHAR(20)                               COMMENT '呼号(航班呼号,如SAS984)',
      regist      VARCHAR(20)                               COMMENT '注册号(飞机注册编号,如SE-RSH)',
      longitude   DECIMAL(11,6)                             COMMENT '经度(东经正,西经负)',
      latitude    DECIMAL(11,6)                             COMMENT '纬度(北纬正,南纬负)',
      heading     DECIMAL(7,3)                              COMMENT '航向角(0-360度,正北为0)',
      speed       DECIMAL(8,2)                              COMMENT '地速(单位:节,knots)',
      altitude    INT                                       COMMENT '飞行高度(单位:英尺,ft)',
      locationtime  DECIMAL(15,3)                           COMMENT '定位时间(Unix时间戳,精确到毫秒)',
      now_time    DECIMAL(15,3)                             COMMENT '数据采集时间(Unix时间戳,精确到毫秒)',
      aircraft_type VARCHAR(10)                             COMMENT '飞机型号(ICAO类型代码,如A359/B77W/B744)',
      flight      VARCHAR(20)                               COMMENT '航班号(如SAS984)',
      flag        VARCHAR(5)                                COMMENT '数据来源标志(1=adsbexchange 2=planespotters 3=airnavradar 4=flightradar24)',
      source_file VARCHAR(255)                              COMMENT '原始数据文件名',
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP       COMMENT '入库时间',
      INDEX idx_icao (icao),
      INDEX idx_callsign (callsign),
      INDEX idx_locationtime (locationtime),
      INDEX idx_create_time (create_time)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='飞机轨迹记录表(全量原始轨迹数据)'
  `);
  console.log('  aircraft_track 表已创建');

  // 表2: 飞机实时轨迹表(每架飞机仅最新一条)
  await conn.query(`
    CREATE TABLE IF NOT EXISTS aircraft_track_latest (
      id          BIGINT       AUTO_INCREMENT PRIMARY KEY,
      icao        VARCHAR(20)                               COMMENT 'ICAO地址(飞机唯一标识,十六进制或十进制字符串)',
      callsign    VARCHAR(20)                               COMMENT '呼号(航班呼号,如SAS984)',
      regist      VARCHAR(20)                               COMMENT '注册号(飞机注册编号,如SE-RSH)',
      longitude   DECIMAL(11,6)                             COMMENT '经度(东经正,西经负)',
      latitude    DECIMAL(11,6)                             COMMENT '纬度(北纬正,南纬负)',
      heading     DECIMAL(7,3)                              COMMENT '航向角(0-360度,正北为0)',
      speed       DECIMAL(8,2)                              COMMENT '地速(单位:节,knots)',
      altitude    INT                                       COMMENT '飞行高度(单位:英尺,ft)',
      locationtime  DECIMAL(15,3)                           COMMENT '最新定位时间(Unix时间戳,精确到毫秒)',
      now_time    DECIMAL(15,3)                             COMMENT '最新采集时间(Unix时间戳,精确到毫秒)',
      aircraft_type VARCHAR(10)                             COMMENT '飞机型号(ICAO类型代码,如A359/B77W/B744)',
      flight      VARCHAR(20)                               COMMENT '航班号(如SAS984)',
      flag        VARCHAR(5)                                COMMENT '数据来源标志(1=adsbexchange 2=planespotters 3=airnavradar 4=flightradar24)',
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
      UNIQUE KEY uk_icao (icao)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='飞机实时轨迹表(每架飞机仅保留最新一条轨迹记录)'
  `);
  console.log('  aircraft_track_latest 表已创建');

  // 清空旧数据(如存在)
  await conn.query('TRUNCATE TABLE aircraft_track');
  await conn.query('TRUNCATE TABLE aircraft_track_latest');
  console.log('  旧数据已清空');

  // ========== 2. 读取并导入数据 ==========
  console.log('\n===== 开始导入数据 =====');
  let totalFiles = 0;
  let totalRecords = 0;
  let batchRecords = [];
  const BATCH_SIZE = 500;

  for (const ds of DATA_DIRS) {
    const dirPath = path.join(BASE_DIR, ds.dir);
    if (!fs.existsSync(dirPath)) {
      console.log(`  跳过不存在的目录: ${dirPath}`);
      continue;
    }
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.txt'));
    console.log(`\n  [${ds.dir}] ${ds.source} (${ds.flag}): ${files.length} 个文件`);

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const json = JSON.parse(raw);
        const records = json.data || [];
        for (const r of records) {
          // 只提取 rk.txt 中定义的字段, NaN 转为 null
          const sf = v => { if(v==null||v==='')return null; const n=parseFloat(v); return isNaN(n)?null:n; };
          const si = v => { if(v==null||v==='')return null; const n=parseInt(v,10); return isNaN(n)?null:n; };
          const ss = v => { if(v==null||v==='')return null; return String(v).trim()||null; };
          const row = [
            ss(r.Icao),
            ss(r.callsign),
            ss(r.regist),
            sf(r.longitude),
            sf(r.latitude),
            sf(r.heading),
            sf(r.speed),
            si(r.altitude),
            sf(r.locationtime),
            sf(r.now),
            ss(r.aircraft_type),
            ss(r.flight),
            ds.flag,
            file
          ];
          batchRecords.push(row);
          totalRecords++;

          // 批量插入 aircraft_track
          if (batchRecords.length >= BATCH_SIZE) {
            await insertBatch(conn, batchRecords);
            batchRecords = [];
          }
        }
      } catch (e) {
        console.error(`  解析文件失败: ${file} - ${e.message}`);
      }
      totalFiles++;
    }
    console.log(`  [${ds.dir}] 累计已读取 ${totalRecords} 条记录`);
  }

  // 插入剩余记录
  if (batchRecords.length > 0) {
    await insertBatch(conn, batchRecords);
  }

  console.log(`\n===== aircraft_track 导入完成: ${totalFiles} 个文件, ${totalRecords} 条记录 =====`);

  // ========== 3. 生成 aircraft_track_latest (每架飞机取最新一条) ==========
  console.log('\n===== 生成 aircraft_track_latest (每架飞机最新一条) =====');
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
  const [latestCnt] = await conn.query('SELECT COUNT(*) as cnt FROM aircraft_track_latest');
  console.log(`  aircraft_track_latest: ${latestCnt[0].cnt} 架飞机`);

  // ========== 4. 统计验证 ==========
  console.log('\n===== 数据统计 =====');
  const [stats] = await conn.query(`
    SELECT
      COUNT(*) as total_records,
      COUNT(DISTINCT icao) as unique_aircraft,
      COUNT(DISTINCT callsign) as unique_callsign,
      COUNT(DISTINCT aircraft_type) as unique_types,
      MIN(locationtime) as min_time,
      MAX(locationtime) as max_time
    FROM aircraft_track
    WHERE locationtime IS NOT NULL
  `);
  console.log('  总记录数:', stats[0].total_records);
  console.log('  独立飞机数:', stats[0].unique_aircraft);
  console.log('  独立呼号数:', stats[0].unique_callsign);
  console.log('  飞机型号数:', stats[0].unique_types);

  if (stats[0].min_time) {
    const minDate = new Date(parseFloat(stats[0].min_time) * 1000);
    const maxDate = new Date(parseFloat(stats[0].max_time) * 1000);
    console.log('  最早时间:', minDate.toISOString());
    console.log('  最晚时间:', maxDate.toISOString());
  }

  const [flagStats] = await conn.query(`
    SELECT flag, COUNT(*) as cnt, COUNT(DISTINCT icao) as aircraft_cnt
    FROM aircraft_track
    GROUP BY flag ORDER BY flag
  `);
  console.log('\n  各数据源统计:');
  flagStats.forEach(f => {
    const source = DATA_DIRS.find(d => d.flag === f.flag);
    console.log(`    flag=${f.flag} (${source ? source.source : '未知'}): ${f.cnt} 条, ${f.aircraft_cnt} 架飞机`);
  });

  await conn.end();
  console.log('\n===== 导入完成 =====');
}

async function insertBatch(conn, records) {
  if (records.length === 0) return;
  const sql = `
    INSERT INTO aircraft_track
      (icao, callsign, regist, longitude, latitude, heading, speed, altitude,
       locationtime, now_time, aircraft_type, flight, flag, source_file)
    VALUES ?
  `;
  await conn.query(sql, [records]);
}

main().catch(e => {
  console.error('执行失败:', e.message);
  console.error(e.stack);
  process.exit(1);
});
