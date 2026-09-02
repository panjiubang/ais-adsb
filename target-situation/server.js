/**
 * 态势分析后端服务
 * 提供 ais_risk_vessel 查询接口 + 静态文件服务
 * 数据库配置来自 datasource2.txt: jdbc:mysql://127.0.0.1:3306/demo (root / Ais@2026)
 */
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = 8765;

app.use(cors());
app.use(express.json());

// 请求日志
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// 数据库连接池
const pool = mysql.createPool({
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: 'Ais@2026',
  database: 'demo',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
});

// 健康检查
app.get('/api/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT COUNT(*) as cnt FROM ais_risk_vessel');
    res.json({ ok: true, total: rows[0].cnt });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * 嫌疑船舶查询接口
 * GET /api/risk-vessels
 * 数据来源: ais_risk_vessel JOIN ais_record(最新位置)
 * 参数:
 *   keyword   - 搜索关键词(MMSI 或 船名)
 *   riskLevel - 风险等级: 高 / 中 / 低 / 正常 (可多选, 逗号分隔)
 *   page      - 页码(默认1)
 *   pageSize  - 每页数量(默认50, 最大1000)
 *   sort      - 排序字段: risk_score / create_time / track_points / mmsi
 *   order     - 排序方向: desc / asc
 */
app.get('/api/risk-vessels', async (req, res) => {
  try {
    const {
      keyword = '',
      riskLevel = '',
      page = 1,
      pageSize = 50,
      sort = 'risk_score',
      order = 'desc'
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const size = Math.min(1000, Math.max(1, parseInt(pageSize, 10) || 50));
    const offset = (pageNum - 1) * size;

    // 排序白名单
    const sortMap = {
      risk_score: 'r.risk_score',
      create_time: 'r.create_time',
      track_points: 'r.track_points',
      mmsi: 'r.mmsi'
    };
    const sortField = sortMap[sort] || 'r.risk_score';
    const sortDir = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // 构造 WHERE (针对 ais_risk_vessel 别名 r)
    const where = [];
    const params = [];

    if (keyword) {
      const kw = `%${keyword}%`;
      where.push('(CAST(r.mmsi AS CHAR) LIKE ? OR r.vessel_name LIKE ?)');
      params.push(kw, kw);
    }

    if (riskLevel) {
      const levels = String(riskLevel).split(',').map(s => s.trim()).filter(Boolean);
      if (levels.length > 0) {
        const placeholders = levels.map(() => '?').join(',');
        where.push(`r.risk_level IN (${placeholders})`);
        levels.forEach(l => params.push(l));
      }
    }

    const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    // 查询总数
    const [cntRows] = await pool.query(
      `SELECT COUNT(*) as total FROM ais_risk_vessel r ${whereSql}`,
      params
    );
    const total = cntRows[0].total;

    // 查询分页数据, LEFT JOIN ais_record 获取最新位置
    const [rows] = await pool.query(
      `SELECT r.mmsi, r.vessel_name, r.f_no_imo, r.f_no_callsign_type, r.f_name_dup,
              r.f_dest_blank, r.f_dest_vague, r.f_draught_change, r.f_small_overload,
              r.f_dark, r.f_dark_night, r.f_loiter, r.f_high_speed, r.f_spoofing, r.f_sts, r.f_night_active,
              r.track_points, r.track_minutes, r.risk_score, r.risk_level, r.risk_tags, r.create_time,
              rec.latitude, rec.longitude, rec.sog_kn, rec.cog_deg, rec.heading,
              rec.ts_local, rec.vessel_type_name_cn, rec.flag_country_cn,
              rec.imo, rec.callsign, rec.destination, rec.draught_m
       FROM ais_risk_vessel r
       LEFT JOIN (
         SELECT mmsi, MAX(ts_local) as max_ts FROM ais_record GROUP BY mmsi
       ) latest ON r.mmsi = latest.mmsi
       LEFT JOIN ais_record rec ON r.mmsi = rec.mmsi AND rec.ts_local = latest.max_ts
       ${whereSql}
       ORDER BY ${sortField} ${sortDir}
       LIMIT ? OFFSET ?`,
      [...params, size, offset]
    );

    res.json({
      ok: true,
      total,
      page: pageNum,
      pageSize: size,
      data: rows
    });
  } catch (e) {
    console.error('Query error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * 船舶轨迹查询接口
 * GET /api/vessel-track?mmsi=xxx
 * 数据来源: ais_origin_record
 */
app.get('/api/vessel-track', async (req, res) => {
  try {
    const { mmsi } = req.query;
    if (!mmsi) {
      return res.status(400).json({ ok: false, error: '缺少 mmsi 参数' });
    }
    // 限制最多返回 2000 个轨迹点, 避免大数据量
    const [rows] = await pool.query(
      `SELECT ts_local, latitude, longitude, sog_kn, cog_deg, heading,
              nav_status_text, message_type, vessel_name, draught_m, destination
       FROM ais_origin_record
       WHERE mmsi = ? AND latitude IS NOT NULL AND longitude IS NOT NULL
       ORDER BY ts_local ASC
       LIMIT 2000`,
      [mmsi]
    );
    const [cntRows] = await pool.query(
      `SELECT COUNT(*) as total FROM ais_origin_record WHERE mmsi = ? AND latitude IS NOT NULL`,
      [mmsi]
    );
    res.json({
      ok: true,
      mmsi: String(mmsi),
      total: cntRows[0].total,
      points: rows.length,
      data: rows
    });
  } catch (e) {
    console.error('Track query error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * 飞机数量查询接口
 * GET /api/aircraft/count
 * 数据来源: aircraft_track_latest 表(每架飞机最新一条轨迹)
 */
app.get('/api/aircraft/count', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) as total FROM aircraft_track_latest
       WHERE icao IS NOT NULL AND icao <> ''
         AND longitude IS NOT NULL AND latitude IS NOT NULL`
    );
    res.json({ ok: true, total: rows[0].total });
  } catch (e) {
    console.error('Aircraft count error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * 飞机实时轨迹查询接口
 * GET /api/aircraft/latest?limit=300
 * 数据来源: aircraft_track_latest 表, 按 locationtime 降序取 top N
 */
app.get('/api/aircraft/latest', async (req, res) => {
  try {
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 300));
    const [rows] = await pool.query(
      `SELECT icao, callsign, regist, longitude, latitude, heading, speed, altitude,
              locationtime, now_time, aircraft_type, flight, flag
       FROM aircraft_track_latest
       WHERE icao IS NOT NULL AND icao <> ''
         AND longitude IS NOT NULL AND latitude IS NOT NULL
       ORDER BY locationtime DESC
       LIMIT ?`,
      [limit]
    );
    const [cntRows] = await pool.query(
      `SELECT COUNT(*) as total FROM aircraft_track_latest
       WHERE icao IS NOT NULL AND icao <> ''
         AND longitude IS NOT NULL AND latitude IS NOT NULL`
    );
    res.json({
      ok: true,
      total: cntRows[0].total,
      returned: rows.length,
      data: rows
    });
  } catch (e) {
    console.error('Aircraft latest error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * AIS 船舶数量查询接口
 * GET /api/ais/count
 * 数据来源: ais_track_huang_latest 表(每艘船最新一条轨迹)
 */
app.get('/api/ais/count', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) as total FROM ais_track_huang_latest
       WHERE mmsi IS NOT NULL AND mmsi <> ''
         AND lat IS NOT NULL AND lon IS NOT NULL`
    );
    res.json({ ok: true, total: rows[0].total });
  } catch (e) {
    console.error('AIS count error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * AIS 船舶最新轨迹查询接口
 * GET /api/ais/latest?limit=500
 * 数据来源: ais_track_huang_latest 表, 按 last_update 降序取所有/前 N 条
 */
app.get('/api/ais/latest', async (req, res) => {
  try {
    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 500));
    const [rows] = await pool.query(
      `SELECT mmsi, ship_name, callsign, imo, ship_type, lat, lon, distance_nm,
              sog, cog, heading, nav_status, draught, destination, eta,
              DATE_FORMAT(last_update, '%Y-%m-%d %H:%i:%s') as last_update,
              source, file_name,
              DATE_FORMAT(file_time, '%Y-%m-%d %H:%i:%s') as file_time
       FROM ais_track_huang_latest
       WHERE mmsi IS NOT NULL AND mmsi <> ''
         AND lat IS NOT NULL AND lon IS NOT NULL
       ORDER BY last_update DESC
       LIMIT ?`,
      [limit]
    );
    const [cntRows] = await pool.query(
      `SELECT COUNT(*) as total FROM ais_track_huang_latest
       WHERE mmsi IS NOT NULL AND mmsi <> ''
         AND lat IS NOT NULL AND lon IS NOT NULL`
    );
    res.json({
      ok: true,
      total: cntRows[0].total,
      returned: rows.length,
      data: rows
    });
  } catch (e) {
    console.error('AIS latest error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * AIS 船舶历史轨迹查询接口
 * GET /api/ais/history?mmsi=xxx
 * 数据来源: ais_track_huang 表(全量轨迹),按时间升序返回该船所有轨迹点
 */
app.get('/api/ais/history', async (req, res) => {
  try {
    const mmsi = req.query.mmsi;
    if (!mmsi) return res.status(400).json({ ok: false, error: 'mmsi required' });
    const [rows] = await pool.query(
      `SELECT mmsi, ship_name, lat, lon, sog, cog, heading, nav_status, draught,
              destination, eta,
              DATE_FORMAT(last_update, '%Y-%m-%d %H:%i:%s') as last_update,
              source, file_name,
              DATE_FORMAT(file_time, '%Y-%m-%d %H:%i:%s') as file_time
       FROM ais_track_huang
       WHERE mmsi = ? AND lat IS NOT NULL AND lon IS NOT NULL
       ORDER BY last_update ASC
       LIMIT 2000`,
      [mmsi]
    );
    const [cntRows] = await pool.query(
      `SELECT COUNT(*) as total FROM ais_track_huang WHERE mmsi = ? AND lat IS NOT NULL AND lon IS NOT NULL`,
      [mmsi]
    );
    res.json({
      ok: true,
      total: cntRows[0].total,
      returned: rows.length,
      data: rows
    });
  } catch (e) {
    console.error('AIS history error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/aircraft/track?icao=xxx
 * 飞机历史轨迹接口
 * 数据来源: aircraft_track 表(全量轨迹),按 locationtime 升序返回该飞机所有轨迹点
 */
app.get('/api/aircraft/track', async (req, res) => {
  try {
    const icao = req.query.icao;
    if (!icao) return res.status(400).json({ ok: false, error: 'icao required' });
    const [rows] = await pool.query(
      `SELECT icao, callsign, regist, longitude, latitude, heading, speed, altitude,
              locationtime, now_time, aircraft_type, flight, flag
       FROM aircraft_track
       WHERE icao = ? AND longitude IS NOT NULL AND latitude IS NOT NULL
       ORDER BY locationtime ASC
       LIMIT 2000`,
      [icao]
    );
    const [cntRows] = await pool.query(
      `SELECT COUNT(*) as total FROM aircraft_track WHERE icao = ? AND longitude IS NOT NULL AND latitude IS NOT NULL`,
      [icao]
    );
    res.json({
      ok: true,
      total: cntRows[0].total,
      returned: rows.length,
      data: rows
    });
  } catch (e) {
    console.error('Aircraft track error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ========== 目标关注表 target_watch ==========
pool.execute(`
  CREATE TABLE IF NOT EXISTS target_watch (
    id          BIGINT       AUTO_INCREMENT PRIMARY KEY,
    target_type VARCHAR(20)                               COMMENT '目标类型(aircraft=飞机, ship=船舶)',
    target_id   VARCHAR(32)                               COMMENT '目标唯一标识(飞机=ICAO地址, 船舶=MMSI)',
    target_name VARCHAR(64)                               COMMENT '目标名称(航班呼号/飞机注册号 或 船舶名称)',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP         COMMENT '关注时间',
    UNIQUE KEY uk_type_id (target_type, target_id),
    INDEX idx_target_type (target_type)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='目标关注表(用户关注/收藏的飞机与船舶)'
`).then(() => console.log('  target_watch 表已就绪'))
  .catch(e => console.error('  target_watch 建表失败:', e.message));

/**
 * GET /api/watch/list
 * 查询所有关注目标列表
 */
app.get('/api/watch/list', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, target_type, target_id, target_name,
              DATE_FORMAT(create_time, '%Y-%m-%d %H:%i:%s') as create_time
       FROM target_watch
       ORDER BY create_time DESC`
    );
    res.json({ ok: true, total: rows.length, data: rows });
  } catch (e) {
    console.error('Watch list error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/watch/add
 * 添加关注 { target_type, target_id, target_name }
 */
app.post('/api/watch/add', async (req, res) => {
  try {
    const { target_type, target_id, target_name } = req.body || {};
    if (!target_type || !target_id) {
      return res.status(400).json({ ok: false, error: 'target_type 和 target_id 必填' });
    }
    await pool.query(
      `INSERT INTO target_watch (target_type, target_id, target_name)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE target_name = VALUES(target_name)`,
      [target_type, target_id, target_name || '']
    );
    res.json({ ok: true, target_type, target_id, target_name });
  } catch (e) {
    console.error('Watch add error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/watch/remove
 * 取消关注 { target_type, target_id }
 */
app.post('/api/watch/remove', async (req, res) => {
  try {
    const { target_type, target_id } = req.body || {};
    if (!target_type || !target_id) {
      return res.status(400).json({ ok: false, error: 'target_type 和 target_id 必填' });
    }
    await pool.query(
      `DELETE FROM target_watch WHERE target_type = ? AND target_id = ?`,
      [target_type, target_id]
    );
    res.json({ ok: true, target_type, target_id });
  } catch (e) {
    console.error('Watch remove error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/watch/check?target_type=xxx&target_id=xxx
 * 检查目标是否已被关注
 */
app.get('/api/watch/check', async (req, res) => {
  try {
    const { target_type, target_id } = req.query;
    if (!target_type || !target_id) {
      return res.status(400).json({ ok: false, error: 'target_type 和 target_id 必填' });
    }
    const [rows] = await pool.query(
      `SELECT id FROM target_watch WHERE target_type = ? AND target_id = ? LIMIT 1`,
      [target_type, target_id]
    );
    res.json({ ok: true, watched: rows.length > 0 });
  } catch (e) {
    console.error('Watch check error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ========== zssf 走私识别算法接口 ==========

/**
 * GET /api/zssf/config
 * 读取当前算法配置参数
 */
app.get('/api/zssf/config', (req, res) => {
  try {
    const cfgPath = path.join(__dirname, 'zssf-config.json');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    res.json(JSON.parse(raw));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/zssf/config
 * 更新算法配置参数
 */
app.post('/api/zssf/config', (req, res) => {
  try {
    const cfgPath = path.join(__dirname, 'zssf-config.json');
    const current = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const newParams = req.body && req.body.params;
    if (newParams) {
      current.params = newParams;
    } else if (req.body) {
      // 允许直接传完整配置
      Object.assign(current, req.body);
    }
    fs.writeFileSync(cfgPath, JSON.stringify(current, null, 2), 'utf8');
    res.json({ ok: true, config: current });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/zssf/run
 * 运行算法(清表后重新检测)
 * 参数: ?dryRun=1 只检测不入库
 */
app.post('/api/zssf/run', async (req, res) => {
  try {
    const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
    // 使用 child_process 调用 zssf.js, 避免阻塞主服务
    const { exec } = require('child_process');
    const cmd = dryRun ? 'node zssf.js --dry-run' : 'node zssf.js';
    exec(cmd, { cwd: __dirname, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[zssf run] error:', err.message);
        return res.status(500).json({ ok: false, error: err.message, stderr });
      }
      // 解析输出提取结果数
      const match = stdout.match(/共发现 (\d+) 条静默记录/);
      const count = match ? parseInt(match[1], 10) : 0;
      const inDbMatch = stdout.match(/已入库 (\d+) 条记录/);
      const inserted = inDbMatch ? parseInt(inDbMatch[1], 10) : 0;
      res.json({ ok: true, detected: count, inserted, dryRun, log: stdout.slice(-2000) });
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/zssf/results
 * 查询 risk_zousi 表检测结果
 * 参数: page, pageSize, keyword(MMSI/船名), minDuration, minCoastDist
 */
app.get('/api/zssf/results', async (req, res) => {
  try {
    const {
      keyword = '', page = 1, pageSize = 50,
      minDuration = '', minCoastDist = ''
    } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const size = Math.min(500, Math.max(1, parseInt(pageSize, 10) || 50));
    const offset = (pageNum - 1) * size;

    const where = [];
    const params = [];
    if (keyword) {
      const kw = `%${keyword}%`;
      where.push('(CAST(mmsi AS CHAR) LIKE ? OR vessel_name LIKE ?)');
      params.push(kw, kw);
    }
    if (minDuration) {
      where.push('silent_duration_min >= ?');
      params.push(parseFloat(minDuration));
    }
    if (minCoastDist) {
      where.push('coastline_distance_km >= ?');
      params.push(parseFloat(minCoastDist));
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [cntRows] = await pool.query(
      `SELECT COUNT(*) as total FROM risk_zousi ${whereSql}`, params
    );
    const total = cntRows[0].total;

    const [rows] = await pool.query(
      `SELECT id, mmsi, vessel_name, silent_start_time, silent_end_time,
              silent_duration_min, silent_start_lng, silent_start_lat,
              silent_end_lng, silent_end_lat, coastline_distance_km,
              displacement_km, sog_before, sog_after,
              nav_status_before, nav_status_after, flag_country_cn,
              vessel_type_name, destination,
              DATE_FORMAT(create_time, '%Y-%m-%d %H:%i:%s') as create_time
       FROM risk_zousi ${whereSql}
       ORDER BY silent_duration_min DESC, coastline_distance_km DESC
       LIMIT ? OFFSET ?`,
      [...params, size, offset]
    );

    // 统计独立船舶数
    const [shipCnt] = await pool.query(
      `SELECT COUNT(DISTINCT mmsi) as ships FROM risk_zousi ${whereSql}`, params
    );

    res.json({
      ok: true, total, ships: shipCnt[0].ships,
      page: pageNum, pageSize: size,
      data: rows
    });
  } catch (e) {
    console.error('ZSSF results error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 静态文件服务 (根目录 = target-situation), HTML 禁止缓存
app.use((req, res, next) => {
  if (req.url.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  next();
}, express.static(path.join(__dirname)));

// 默认首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[态势分析] 服务已启动: http://127.0.0.1:${PORT}/pages/index.html`);
  console.log(`[API] 嫌疑船舶接口: http://127.0.0.1:${PORT}/api/risk-vessels`);
});
