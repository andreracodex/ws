const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

require('dotenv').config();

/* ================= CONFIG ================= */
const PORT = Number.parseInt(process.env.WS_PORT, 10) || 9001;
const OFFLINE_TIMEOUT_SECONDS = Number.parseInt(process.env.DEVICE_OFFLINE_SECONDS, 10) || 10;
const MAX_MESSAGE_SIZE = Number.parseInt(process.env.MAX_MESSAGE_SIZE, 10) || 10485760; // 10MB
const MAX_IMAGE_SIZE = Number.parseInt(process.env.MAX_IMAGE_SIZE, 10) || 5242880; // 5MB
const MAX_CONNECTIONS_PER_IP = Number.parseInt(process.env.MAX_CONNECTIONS_PER_IP, 10) || 5;
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = Number.parseInt(process.env.RATE_LIMIT_MAX, 10) || 100;
const CONNECTION_TIMEOUT = Number.parseInt(process.env.CONNECTION_TIMEOUT, 10) || 300000; // 5 minutes
const DEVICE_AUTH_TOKEN = process.env.DEVICE_AUTH_TOKEN || null; // Optional authentication

/* ================= SECURITY TRACKING ================= */
const connectionsByIP = new Map();
const rateLimitByIP = new Map();

/* ================= DATABASE ================= */
const db = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || 'mypassrootonly',
  database: process.env.DB_NAME || 'test_fingerspot',
  port: Number.parseInt(process.env.DB_PORT, 10) || 3306,
  waitForConnections: true,
  connectionLimit: Number.parseInt(process.env.DB_CONN_LIMIT, 10) || 10
});

const initDb = async () => {
  try {
    await db.execute(
      `CREATE TABLE IF NOT EXISTS device_messages (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        device_sn VARCHAR(64) NULL,
        cmd VARCHAR(32) NULL,
        device_ip VARCHAR(64) NULL,
        payload MEDIUMTEXT NOT NULL,
        is_json_valid TINYINT(1) NOT NULL DEFAULT 1,
        parse_error VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_device_sn (device_sn),
        INDEX idx_cmd (cmd),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
    );
  } catch (err) {
    console.error('DEVICE MESSAGES TABLE ERROR:', err.message);
  }
};

initDb();

const storeDeviceMessage = async (ip, payload, data, isJsonValid, parseError) => {
  try {
    await db.execute(
      `INSERT INTO device_messages
      (device_sn, cmd, device_ip, payload, is_json_valid, parse_error)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [
        data?.sn ? sanitizeString(data.sn, 64) : null,
        data?.cmd ? sanitizeString(data.cmd, 32) : null,
        ip || null,
        payload.substring(0, MAX_MESSAGE_SIZE),
        isJsonValid ? 1 : 0,
        parseError ? sanitizeString(parseError, 255) : null
      ]
    );
  } catch (err) {
    console.error('DEVICE MESSAGE STORE ERROR:', err.message);
  }
};

/* ================= VALIDATION FUNCTIONS ================= */
const isValidSN = (sn) => {
  return typeof sn === 'string' && sn.length > 0 && sn.length <= 64 && /^[A-Za-z0-9_-]+$/.test(sn);
};

const isValidCmd = (cmd) => {
  return ['reg', 'heartbeat', 'sendlog'].includes(cmd);
};

const sanitizeString = (str, maxLength = 255) => {
  if (typeof str !== 'string') return null;
  return str.substring(0, maxLength).trim();
};

const isValidBase64Image = (data) => {
  if (typeof data !== 'string') return false;
  if (data.length > MAX_IMAGE_SIZE * 1.4) return false; // Base64 is ~1.33x larger
  return /^[A-Za-z0-9+/]+=*$/.test(data);
};

const checkRateLimit = (ip) => {
  const now = Date.now();
  let ipData = rateLimitByIP.get(ip);
  
  if (!ipData) {
    ipData = { count: 1, resetTime: now + RATE_LIMIT_WINDOW };
    rateLimitByIP.set(ip, ipData);
    return true;
  }
  
  if (now > ipData.resetTime) {
    ipData.count = 1;
    ipData.resetTime = now + RATE_LIMIT_WINDOW;
    return true;
  }
  
  if (ipData.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }
  
  ipData.count++;
  return true;
};

const updateDeviceStatus = async (sn, ip, isOnline) => {
  if (!sn) {
    return;
  }

  try {
    await db.execute(
      `INSERT INTO device_status (device_sn, last_seen, is_online, device_ip)
       VALUES (?, NOW(), ?, ?)
       ON DUPLICATE KEY UPDATE
         last_seen = NOW(),
         is_online = VALUES(is_online),
         device_ip = VALUES(device_ip)`,
      [sn, isOnline ? 1 : 0, ip || null]
    );
  } catch (err) {
    console.error("DEVICE STATUS ERROR:", err.message);
  }
};

const updateDeviceInfo = async (sn, devinfo) => {
  if (!sn || !devinfo) {
    return;
  }

  try {
    await db.execute(
      `UPDATE device_status
       SET modelname = ?,
           usersize = ?,
           facesize = ?,
           fpsize = ?,
           cardsize = ?,
           pwdsize = ?,
           logsize = ?,
           useduser = ?,
           usedface = ?,
           usedfp = ?,
           usedcard = ?,
           usedpwd = ?,
           usedlog = ?,
           usednewlog = ?,
           usedrtlog = ?,
           netinuse = ?,
           usb4g = ?,
           fpalgo = ?,
           firmware = ?,
           device_time = ?,
           intercom = ?,
           floors = ?,
           charid = ?,
           useosdp = ?,
           dislanguage = ?,
           mac = ?
       WHERE device_sn = ?`,
      [
        devinfo.modelname || null,
        devinfo.usersize || null,
        devinfo.facesize || null,
        devinfo.fpsize || null,
        devinfo.cardsize || null,
        devinfo.pwdsize || null,
        devinfo.logsize || null,
        devinfo.useduser || null,
        devinfo.usedface || null,
        devinfo.usedfp || null,
        devinfo.usedcard || null,
        devinfo.usedpwd || null,
        devinfo.usedlog || null,
        devinfo.usednewlog || null,
        devinfo.usedrtlog || null,
        devinfo.netinuse || null,
        devinfo.usb4g || null,
        devinfo.fpalgo || null,
        devinfo.firmware || null,
        devinfo.time || null,
        devinfo.intercom || null,
        devinfo.floors || null,
        devinfo.charid || null,
        devinfo.useosdp || null,
        devinfo.dislanguage || null,
        devinfo.mac || null,
        sn
      ]
    );
  } catch (err) {
    console.error("DEVICE INFO ERROR:", err.message);
  }
};

/* ================= BACKGROUND TASKS ================= */
const offlineCheckInterval = setInterval(async () => {
  try {
    await db.execute(
      `UPDATE device_status
       SET is_online = 0
       WHERE last_seen < (NOW() - INTERVAL ? SECOND)`,
      [OFFLINE_TIMEOUT_SECONDS]
    );
  } catch (err) {
    console.error("DEVICE OFFLINE CHECK ERROR:", err.message);
  }
}, 5000);

// Cleanup rate limit tracking
const rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimitByIP.entries()) {
    if (now > data.resetTime) {
      rateLimitByIP.delete(ip);
    }
  }
}, 60000);

/* =============== IMAGE FOLDER =============== */
const imageDir = path.join(__dirname, 'images');
if (!fs.existsSync(imageDir)) {
  fs.mkdirSync(imageDir);
}

/* =============== WEBSOCKET SERVER =============== */
const wss = new WebSocket.Server({ 
  port: PORT,
  maxPayload: MAX_MESSAGE_SIZE,
  clientTracking: true
});

console.log(`AI Push Server (Protocol 2.4) running on port ${PORT}`);
console.log(`Security: Max ${MAX_CONNECTIONS_PER_IP} connections/IP, ${RATE_LIMIT_MAX_REQUESTS} requests/min`);
if (DEVICE_AUTH_TOKEN) {
  console.log('Device authentication: ENABLED');
}

wss.on('connection', (ws, req) => {

  const ip = req.socket.remoteAddress;
  let currentSn = null;
  let isAuthenticated = !DEVICE_AUTH_TOKEN; // Auto-auth if no token required
  let messageCount = 0;
  let connectionTimeout = null;
  
  // Check connection limit per IP
  const ipConnections = connectionsByIP.get(ip) || 0;
  if (ipConnections >= MAX_CONNECTIONS_PER_IP) {
    console.log(`[REJECTED] ${ip} - Too many connections`);
    ws.close(1008, 'Too many connections from IP');
    return;
  }
  
  connectionsByIP.set(ip, ipConnections + 1);
  console.log(`[CONNECTED] ${ip} (${ipConnections + 1}/${MAX_CONNECTIONS_PER_IP})`);
  
  // Set connection timeout
  const resetTimeout = () => {
    if (connectionTimeout) clearTimeout(connectionTimeout);
    connectionTimeout = setTimeout(() => {
      console.log(`[TIMEOUT] ${ip} - Inactive connection`);
      ws.close(1000, 'Connection timeout');
    }, CONNECTION_TIMEOUT);
  };
  
  resetTimeout();

  ws.on('message', async (message) => {

    resetTimeout();
    messageCount++;
    const rawMessage = message.toString();

    // Rate limiting
    if (!checkRateLimit(ip)) {
      console.log(`[RATE LIMIT] ${ip}`);
      ws.send(JSON.stringify({ ret: 'error', message: 'Rate limit exceeded' }));
      return;
    }
    
    // Message size already enforced by maxPayload, but double-check
    if (message.length > MAX_MESSAGE_SIZE) {
      console.log(`[REJECTED] ${ip} - Message too large: ${message.length} bytes`);
      ws.close(1009, 'Message too large');
      return;
    }

    let data;

    try {
      data = JSON.parse(rawMessage);
    } catch (err) {
      console.log(`[INVALID JSON] ${ip}`);
      storeDeviceMessage(ip, rawMessage, null, false, err.message);
      ws.send(JSON.stringify({ ret: 'error', message: 'Invalid JSON' }));
      return;
    }

    storeDeviceMessage(ip, rawMessage, data, true, null);
    
    // Validate command
    if (!data.cmd || !isValidCmd(data.cmd)) {
      console.log(`[INVALID CMD] ${ip} - ${data.cmd}`);
      ws.send(JSON.stringify({ ret: 'error', message: 'Invalid command' }));
      return;
    }
    
    // Validate serial number
    if (!data.sn || !isValidSN(data.sn)) {
      console.log(`[INVALID SN] ${ip} - ${data.sn}`);
      ws.send(JSON.stringify({ ret: 'error', message: 'Invalid serial number' }));
      return;
    }
    
    // Authentication check (if enabled)
    if (!isAuthenticated) {
      if (data.cmd === 'reg' && data.token === DEVICE_AUTH_TOKEN) {
        isAuthenticated = true;
        console.log(`[AUTHENTICATED] ${ip} - ${data.sn}`);
      } else {
        console.log(`[AUTH FAILED] ${ip} - ${data.sn}`);
        ws.send(JSON.stringify({ ret: data.cmd, result: false, message: 'Authentication required' }));
        return;
      }
    }

    /* ================= REGISTER ================= */
    if (data.cmd === 'reg') {

      console.log(`REGISTER from ${data.sn}`);
      currentSn = data.sn;
      await updateDeviceStatus(currentSn, ip, true);

      if (data.devinfo) {
        await updateDeviceInfo(currentSn, data.devinfo);
      }

      ws.send(JSON.stringify({
        ret: "reg",
        result: true,
        sn: data.sn,
        cloudtime: new Date().toISOString().slice(0, 19).replace('T', ' '),
        nosenduser: true
      }));

      return;
    }

    /* ================= HEARTBEAT ================= */
    if (data.cmd === 'heartbeat') {

      currentSn = data.sn;
      updateDeviceStatus(currentSn, ip, true);
      ws.send(JSON.stringify({
        ret: "heartbeat",
        result: true,
        sn: data.sn,
        cloudtime: new Date().toISOString().slice(0, 19).replace('T', ' ')
      }));

      return;
    }

    /* ================= SEND LOG ================= */
    if (data.cmd === 'sendlog' && Array.isArray(data.record)) {

      console.log(`LOG from ${data.sn}, count=${data.count}, index=${data.logindex}`);
      currentSn = data.sn;
      updateDeviceStatus(currentSn, ip, true);

      for (const record of data.record) {

        let enrollId = record.enrollid;
        console.log(`Processing log: SN=${data.sn}, EnrollID=${enrollId}, Time=${record.time}`);

        // Validate required fields
        if (enrollId == 99999999) {
          console.log(`[INVALID LOG] ${data.sn} - Missing enrollId or time`);
          ws.send(JSON.stringify({
            ret: "sendlog",
            result: false,
            reason: 1
          }));
          return;
        }

        // Fallback for missing enroll ID (but we already checked above)
        if (!enrollId) {
          const fallbackId = `UNKNOWN_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
          enrollId = fallbackId.substring(0, 64);
          console.log(`[MISSING ENROLLID] ${data.sn} - Using ${enrollId}`);
        }

        let imagePath = null;

        /* Save Image (AI Device) */
        if (record.image && record.image.length > 100) {
          try {
            // Validate image data
            if (!isValidBase64Image(record.image)) {
              console.log(`[INVALID IMAGE] ${data.sn} - Invalid base64 format`);
            } else {
              // Sanitize filename components to prevent path traversal
              const safeSn = sanitizeString(data.sn, 64).replace(/[^A-Za-z0-9_-]/g, '_');
              const safeEnrollId = enrollId;
              const filename = `${safeSn}_${safeEnrollId}_${new Date().toISOString().slice(0,7)}.jpg`;
              const filepath = path.join(imageDir, path.basename(filename)); // Prevent path traversal
              
              // Decode and validate image
              const imageBuffer = Buffer.from(record.image, 'base64');
              
              // Check actual size after decoding
              if (imageBuffer.length > MAX_IMAGE_SIZE) {
                console.log(`[IMAGE TOO LARGE] ${data.sn} - ${imageBuffer.length} bytes`);
              } else {
                // Basic JPEG validation (check magic bytes)
                if (imageBuffer.length > 2 && imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8) {
                  fs.writeFileSync(filepath, imageBuffer);
                  imagePath = filename;
                } else {
                  console.log(`[INVALID IMAGE] ${data.sn} - Not a valid JPEG`);
                }
              }
            }
          } catch (err) {
            console.log(`[IMAGE ERROR] ${data.sn} - ${err.message}`);
          }
        }

        try {
          await db.execute(
            `INSERT INTO attendance_logs
            (device_sn, enroll_id, user_name, log_time,
             verify_mode, io_status, event_code,
             temperature, image_path, device_ip, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE id=id`,
            [
              sanitizeString(data.sn, 64),
              enrollId,
              sanitizeString(record.name, 128),
              sanitizeString(record.time, 32),
              Number.parseInt(record.mode, 10) || null,
              Number.parseInt(record.inout, 10) || null,
              Number.parseInt(record.event, 10) || null,
              record.temp ? parseFloat(record.temp) : null,
              imagePath,
              ip,
              JSON.stringify(record).substring(0, 65535) // Limit JSON size
            ]
          );
          
        } catch (err) {
          console.error("DB ERROR:", err.message);
        }
      }

      /* ===== PROTOCOL 2.4 CORRECT ACK ===== */
      ws.send(JSON.stringify({
        ret: "sendlog",
        result: true,
        count: data.count,
        logindex: data.logindex,
        cloudtime: new Date().toISOString().slice(0, 19).replace('T', ' '),
        access: 1,
        message: "message open the door"
      }));

      console.log("ACK sent to device");
    }
  });

  ws.on('close', () => {
    if (connectionTimeout) clearTimeout(connectionTimeout);
    const count = connectionsByIP.get(ip) || 1;
    connectionsByIP.set(ip, count - 1);
    if (count - 1 <= 0) connectionsByIP.delete(ip);
    
    console.log(`[DISCONNECTED] ${ip} - ${messageCount} messages`);
    updateDeviceStatus(currentSn, ip, false);
  });

  ws.on('error', (err) => {
    console.log(`[ERROR] ${ip} - ${err.message}`);
    updateDeviceStatus(currentSn, ip, false);
  });

});

/* ================= GRACEFUL SHUTDOWN ================= */
const shutdown = async (signal) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  
  // Stop accepting new connections
  wss.close(() => {
    console.log('WebSocket server closed');
  });
  
  // Close all active connections
  for (const client of wss.clients) {
    client.close(1001, 'Server shutting down');
  }
  
  // Clear intervals
  clearInterval(offlineCheckInterval);
  clearInterval(rateLimitCleanup);
  
  // Close database pool
  try {
    await db.end();
    console.log('Database connections closed');
  } catch (err) {
    console.error('Error closing database:', err.message);
  }
  
  console.log('Shutdown complete');
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  shutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
});
