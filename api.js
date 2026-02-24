const http = require('http');
const { URL } = require('url');
const Busboy = require('busboy');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const API_BEARER_TOKEN = process.env.API_BEARER_TOKEN || 'ARmiXDvuTcZBkaTMtfoGUNcRFTAAjuIZ';
let userTableReady = false;

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

const getBodyValue = (body, ...keys) => {
  for (const key of keys) {
    if (body[key] !== undefined && body[key] !== null && String(body[key]).trim() !== '') {
      return body[key];
    }
  }
  return null;
};

const normalizeEnrollId = (value) => {
  if (value === undefined || value === null) return null;

  const raw = String(value).trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return null;

  return parsed;
};

const normalizeBase64Image = (value) => {
  if (value === undefined || value === null) return null;

  let raw = String(value).trim();
  if (!raw) return null;

  const prefixMatch = raw.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
  if (prefixMatch && prefixMatch[1]) {
    raw = prefixMatch[1].trim();
  }

  const compact = raw.replace(/\s+/g, '');
  if (!compact || compact.length < 20) return null;
  if (!/^[A-Za-z0-9+/]+=*$/.test(compact)) return null;

  return compact;
};

const parseRequestBody = async (req) => {
  const contentType = (req.headers['content-type'] || '').toLowerCase();

  if (contentType.includes('multipart/form-data')) {
    return await new Promise((resolve, reject) => {
      const fields = {};
      const busboy = Busboy({ headers: req.headers });

      busboy.on('field', (name, value) => {
        fields[name] = value;
      });

      busboy.on('file', (name, file, info) => {
        const filename = info?.filename || '';
        const mimeType = info?.mimeType || info?.mime || '';
        const chunks = [];

        file.on('data', (chunk) => {
          chunks.push(chunk);
        });

        file.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (buffer.length === 0) return;

          const base64 = buffer.toString('base64');
          const isImageField = ['image', 'photo', 'file'].includes(String(name).toLowerCase())
            || String(mimeType).toLowerCase().startsWith('image/')
            || /\.(jpg|jpeg|png|webp|bmp)$/i.test(filename);

          if (isImageField) {
            fields.image = `data:${mimeType || 'image/jpeg'};base64,${base64}`;
          } else {
            fields[name] = base64;
          }
        });
      });

      busboy.on('error', reject);
      busboy.on('finish', () => resolve(fields));
      req.pipe(busboy);
    });
  }

  let rawBody = '';

  for await (const chunk of req) {
    rawBody += chunk;
  }

  if (!rawBody) return {};

  if (contentType.includes('application/json')) {
    return JSON.parse(rawBody);
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const parsed = new URLSearchParams(rawBody);
    return Object.fromEntries(parsed.entries());
  }

  return JSON.parse(rawBody);
};

const buildAttendanceQuery = (body) => {
  const where = [];
  const values = [];

  const deviceSn = getBodyValue(body, 'deviceSn', 'device_sn');
  const fingerId = getBodyValue(body, 'fingerId', 'finger_id', 'enrollId', 'enroll_id', 'enrollid', 'id', 'userId', 'userid');
  const fromTime = getBodyValue(body, 'fromTime', 'from');
  const toTime = getBodyValue(body, 'toTime', 'to');

  if (deviceSn) {
    where.push('device_sn = ?');
    values.push(deviceSn);
  }

  if (fingerId) {
    where.push('enroll_id = ?');
    values.push(fingerId);
  }

  if (fromTime) {
    where.push('log_time >= ?');
    values.push(fromTime);
  }

  if (toTime) {
    where.push('log_time <= ?');
    values.push(toTime);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { whereSql, values };
};

const startApiServer = (
  db,
  port = Number.parseInt(process.env.API_PORT, 10) || 9002,
  options = {}
) => {
  const sendUserToDevice = options.sendUserToDevice;
  const deleteUserFromDevice = options.deleteUserFromDevice;
  const cleanLogsFromDevice = options.cleanLogsFromDevice;

  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: false, 
        code: 400, 
        message: 'Missing URL' 
      }));
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const isAttendanceRoute = url.pathname === '/api/attendance_logs';
    const isAddUserRoute = url.pathname === '/api/adduser';
    const isDeleteUserRoute = url.pathname === '/api/deleteuser';
    const isCleanLogsRoute = url.pathname === '/api/cleanlogs';

    if (!isAttendanceRoute && !isAddUserRoute && !isDeleteUserRoute && !isCleanLogsRoute) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: false, 
        code: 404, 
        message: 'Not found' 
      }));
      return;
    }

    if (isAttendanceRoute && req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: false, 
        code: 405, 
        message: 'Method not allowed. Use GET' 
      }));
      return;
    }

    if (isAddUserRoute && req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: false, 
        code: 405, 
        message: 'Method not allowed. Use POST' 
      }));
      return;
    }

    if (isDeleteUserRoute && req.method !== 'DELETE') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: false, 
        code: 405, 
        message: 'Method not allowed. Use DELETE' 
      }));
      return;
    }

    if (isCleanLogsRoute && req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: false, 
        code: 405, 
        message: 'Method not allowed. Use POST' 
      }));
      return;
    }

    const bearerToken = getBearerToken(req.headers.authorization);
    if (bearerToken !== API_BEARER_TOKEN) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer'
      });
      res.end(JSON.stringify({
        success: false,
        code: 401,
        message: 'Unauthorized: invalid or missing Bearer token'
      }));
      return;
    }

    let body = {};
    if (isAttendanceRoute && req.method === 'GET') {
      body = Object.fromEntries(url.searchParams.entries());
    } else if (isDeleteUserRoute && req.method === 'DELETE') {
      const queryBody = Object.fromEntries(url.searchParams.entries());
      let requestBody = {};

      try {
        requestBody = await parseRequestBody(req);
      } catch (_err) {
        requestBody = {};
      }

      body = { ...requestBody, ...queryBody };
    } else if (isCleanLogsRoute && req.method === 'POST') {
      const queryBody = Object.fromEntries(url.searchParams.entries());
      let requestBody = {};

      try {
        requestBody = await parseRequestBody(req);
      } catch (_err) {
        requestBody = {};
      }

      body = { ...requestBody, ...queryBody };
    } else {
      try {
        body = await parseRequestBody(req);
      } catch (_err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          code: 400,
          message: 'Invalid request body'
        }));
        return;
      }
    }

    if (isAddUserRoute) {
      const enrollIdRaw = getBodyValue(body, 'enrollid', 'enrollId', 'enroll_id', 'fingerId', 'finger_id', 'id', 'userId', 'userid');
      const enrollId = normalizeEnrollId(enrollIdRaw);
      const userName = String(getBodyValue(body, 'userName', 'user_name', 'name') || '').trim();
      const deviceSn = String(getBodyValue(body, 'deviceSn', 'device_sn') || '').trim() || null;
      const backupNum = Number.parseInt(getBodyValue(body, 'backupNum', 'backup_num') || 11, 10);
      const admin = Number.parseInt(getBodyValue(body, 'admin') || 0, 10);
      const record = getBodyValue(body, 'record', 'template', 'cardNo', 'card_no');
      const imageBase64 = getBodyValue(body, 'image', 'imageBase64', 'image_base64', 'photo', 'photoBase64', 'photo_base64');
      const normalizedImage = normalizeBase64Image(imageBase64);

      if (!enrollId || !userName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          code: 400,
          message: 'Valid enrollid (numeric, > 0) and userName are required'
        }));
        return;
      }

      if (!deviceSn) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          code: 400,
          message: 'deviceSn is required'
        }));
        return;
      }

      if (imageBase64 && !normalizedImage) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          code: 400,
          message: 'Invalid image format. Use base64 image content.'
        }));
        return;
      }

      if (typeof sendUserToDevice !== 'function') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          code: 503,
          message: 'Device command bridge is not available'
        }));
        return;
      }

      try {
        const finalBackupNum = normalizedImage ? 50 : (Number.isNaN(backupNum) ? 11 : backupNum);
        const finalRecord = normalizedImage || record || '';

        const deviceResult = await sendUserToDevice({
          sn: deviceSn,
          enrollid: enrollId,
          name: userName,
          backupnum: finalBackupNum,
          admin: Number.isNaN(admin) ? 0 : admin,
          record: finalRecord
        });

        if (!deviceResult.ok) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            code: 502,
            message: deviceResult.message || 'Failed to add user to device first'
          }));
          return;
        }

        if (!userTableReady) {
          await db.execute(
            `CREATE TABLE IF NOT EXISTS api_users (
              id BIGINT AUTO_INCREMENT PRIMARY KEY,
              finger_id VARCHAR(64) NOT NULL,
              user_name VARCHAR(128) NOT NULL,
              device_sn VARCHAR(64) NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              UNIQUE KEY unique_finger_id (finger_id),
              INDEX idx_device_sn (device_sn)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
          );
          userTableReady = true;
        }

        await db.execute(
          `INSERT INTO api_users (finger_id, user_name, device_sn)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE user_name = VALUES(user_name), device_sn = VALUES(device_sn)`,
          [String(enrollId), userName, deviceSn]
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          code: 200,
          message: 'User saved successfully',
          data: {
            finger_id: enrollId,
            enrollid: enrollId,
            user_name: userName,
            device_sn: deviceSn,
            backupnum: finalBackupNum,
            image_included: Boolean(normalizedImage),
            device_response: deviceResult.data || null
          }
        }));
        return;
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }

        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          code: 500,
          message: 'Failed to save user',
          data: err.message
        }));
        return;
      }
    }

    if (isDeleteUserRoute) {
      const enrollIdRaw = getBodyValue(body, 'enrollid', 'enrollId', 'enroll_id', 'fingerId', 'finger_id', 'id', 'userId', 'userid');
      const enrollId = normalizeEnrollId(enrollIdRaw);
      const deviceSnRaw = getBodyValue(body, 'deviceSn', 'device_sn');
      const backupNumRaw = getBodyValue(body, 'backupNum', 'backup_num');
      const parsedBackupNum = Number.parseInt(backupNumRaw, 10);
      const backupNum = Number.isNaN(parsedBackupNum) ? 13 : parsedBackupNum;
      let deviceSn = String(deviceSnRaw || '').trim() || null;
      console.log('Delete user request - enrollId:', enrollId, 'deviceSn:', deviceSn);

      if (!enrollId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          code: 400,
          message: 'Valid enrollid (numeric, > 0) is required'
        }));
        return;
      }

      if (!deviceSn) {
        try {
          const [rows] = await db.execute(
            'SELECT device_sn FROM api_users WHERE finger_id = ? LIMIT 1',
            [String(enrollId)]
          );
          deviceSn = rows?.[0]?.device_sn || null;
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            code: 500,
            message: 'Failed to resolve device serial number',
            data: err.message
          }));
          return;
        }
      }

      if (!deviceSn) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          code: 400,
          message: 'deviceSn is required'
        }));
        return;
      }

      if (typeof deleteUserFromDevice !== 'function') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          code: 503,
          message: 'Device command bridge is not available'
        }));
        return;
      }

      try {
        const deviceResult = await deleteUserFromDevice({
          sn: deviceSn,
          enrollid: enrollId,
          backupnum: backupNum
        });

        if (!deviceResult.ok) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            code: 502,
            message: deviceResult.message || 'Failed to delete user from device first'
          }));
          return;
        }

        const [deleteResult] = await db.execute(
          'DELETE FROM api_users WHERE finger_id = ?',
          [String(enrollId)]
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          code: 200,
          message: 'User deleted successfully',
          data: {
            finger_id: enrollId,
            device_sn: deviceSn,
            backupnum: backupNum,
            rows_deleted: deleteResult.affectedRows,
            device_response: deviceResult.data || null
          }
        }));
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }

        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          code: 500,
          message: 'Failed to delete user',
          data: err.message
        }));
      }
      return;
    }

    if (isCleanLogsRoute) {
      const deviceSn = String(getBodyValue(body, 'deviceSn', 'device_sn') || '').trim();

      if (!deviceSn) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          code: 400,
          message: 'deviceSn is required'
        }));
        return;
      }

      if (typeof cleanLogsFromDevice !== 'function') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          code: 503,
          message: 'Device command bridge is not available'
        }));
        return;
      }

      try {
        const deviceResult = await cleanLogsFromDevice({ sn: deviceSn });

        if (!deviceResult.ok) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            code: 502,
            message: deviceResult.message || 'Failed to clean logs on device'
          }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          code: 200,
          message: 'Device logs cleaned successfully',
          data: {
            device_sn: deviceSn,
            device_response: deviceResult.data || null
          }
        }));
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }

        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          code: 500,
          message: 'Failed to clean logs',
          data: err.message
        }));
      }
      return;
    }

    const limit = Math.min(parsePositiveInt(body.limit, DEFAULT_LIMIT), MAX_LIMIT);
    const offset = parsePositiveInt(body.offset, 0);

    const { whereSql, values } = buildAttendanceQuery(body);

    try {
      const [rows] = await db.execute(
        `SELECT
           id as log_id,
           enroll_id as finger_id,
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

      const responseBody = {
        success: true,
        code: 200,
        message: 'Attendance logs retrieved successfully',
        count: rows.length,
        data: rows
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: false, 
        code: 500,
        message: 'Internal server error',
        data: err.message 
      }));
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`HTTP API server running on port ${port}`);
  });

  return server;
};

module.exports = { startApiServer };
