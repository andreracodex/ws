const http = require('http');
const { URL } = require('url');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const API_BEARER_TOKEN = process.env.API_BEARER_TOKEN || 'ARmiXDvuTcZBkaTMtfoGUNcRFTAAjuIZ';

const getBearerToken = (authorizationHeader) => {
  if (!authorizationHeader) return null;

  const [scheme, token] = authorizationHeader.split(' ');
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;

  return token;
};

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) return fallback;
  return parsed;
};

const buildAttendanceQuery = (params) => {
  const where = [];
  const values = [];

  if (params.deviceSn) {
    where.push('device_sn = ?');
    values.push(params.deviceSn);
  }

  if (params.enrollId) {
    where.push('enroll_id = ?');
    values.push(params.enrollId);
  }

  if (params.fromTime) {
    where.push('log_time >= ?');
    values.push(params.fromTime);
  }

  if (params.toTime) {
    where.push('log_time <= ?');
    values.push(params.toTime);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { whereSql, values };
};

const startApiServer = (db, port = Number.parseInt(process.env.API_PORT, 10) || 9002) => {
  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Missing URL' }));
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname !== '/api/attendance_logs') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
      return;
    }

    const bearerToken = getBearerToken(req.headers.authorization);
    if (bearerToken !== API_BEARER_TOKEN) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer'
      });
      res.end(JSON.stringify({
        ok: false,
        error: 'Unauthorized: invalid or missing Bearer token'
      }));
      return;
    }

    const limit = Math.min(parsePositiveInt(url.searchParams.get('limit'), DEFAULT_LIMIT), MAX_LIMIT);
    const offset = parsePositiveInt(url.searchParams.get('offset'), 0);
    const deviceSn = url.searchParams.get('device_sn');
    const enrollId = url.searchParams.get('enroll_id');
    const fromTime = url.searchParams.get('from');
    const toTime = url.searchParams.get('to');

    const { whereSql, values } = buildAttendanceQuery({
      deviceSn,
      enrollId,
      fromTime,
      toTime
    });

    try {
      const [rows] = await db.execute(
        `SELECT
           id as log_id,
           enroll_id,
           user_name,
           event_code,
           verify_mode,
           COALESCE(DATE_FORMAT(log_time, '%Y-%m-%d %H:%i:%s'), log_time) AS log_time
         FROM attendance_logs
         ${whereSql}
         ORDER BY id DESC
         LIMIT ${limit} OFFSET ${offset}`,
        values
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true,
        code: rows.raw_json.note.msg,
        count: rows.length, 
        data: rows 
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: false, 
        error: err.message 
      }));
    }
  });

  server.listen(port, () => {
    console.log(`HTTP API server running on port ${port}`);
  });

  return server;
};

module.exports = { startApiServer };
