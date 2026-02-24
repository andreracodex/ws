const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { startApiServer } = require('./api');

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
const DEVICE_AUTH_TOKEN = process.env.DEVICE_AUTH_TOKEN || null;
const HEARTBEAT_INTERVAL = 10000; // 10 seconds

/* ================= SECURITY TRACKING ================= */
const connectionsByIP = new Map();
const rateLimitByIP = new Map();
const activeDevicesBySn = new Map();
const pendingCommandResponses = new Map();

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
    // Device messages table
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

    // Device status table
    await db.execute(
      `CREATE TABLE IF NOT EXISTS device_status (
        device_sn VARCHAR(64) PRIMARY KEY,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_online TINYINT(1) DEFAULT 1,
        device_ip VARCHAR(64) NULL,
        modelname VARCHAR(64) NULL,
        usersize INT NULL,
        facesize INT NULL,
        fpsize INT NULL,
        cardsize INT NULL,
        pwdsize INT NULL,
        logsize INT NULL,
        useduser INT NULL,
        usedface INT NULL,
        usedfp INT NULL,
        usedcard INT NULL,
        usedpwd INT NULL,
        usedlog INT NULL,
        usednewlog INT NULL,
        usedrtlog INT NULL,
        netinuse VARCHAR(32) NULL,
        usb4g VARCHAR(32) NULL,
        fpalgo VARCHAR(32) NULL,
        firmware VARCHAR(64) NULL,
        device_time TIMESTAMP NULL,
        intercom VARCHAR(32) NULL,
        floors INT NULL,
        charid VARCHAR(32) NULL,
        useosdp VARCHAR(32) NULL,
        dislanguage VARCHAR(32) NULL,
        mac VARCHAR(32) NULL,
        INDEX idx_online (is_online),
        INDEX idx_last_seen (last_seen)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
    );

    // Attendance logs table
    await db.execute(
      `CREATE TABLE IF NOT EXISTS attendance_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        device_sn VARCHAR(64) NOT NULL,
        enroll_id VARCHAR(64) NOT NULL,
        user_name VARCHAR(128) NULL,
        log_time VARCHAR(32) NOT NULL,
        verify_mode INT NULL,
        io_status INT NULL,
        event_code INT NULL,
        temperature DECIMAL(5,2) NULL,
        image_path VARCHAR(255) NULL,
        device_ip VARCHAR(64) NULL,
        raw_json TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_log (device_sn, enroll_id, log_time, verify_mode),
        INDEX idx_device_sn (device_sn),
        INDEX idx_enroll_id (enroll_id),
        INDEX idx_log_time (log_time),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
    );

    console.log('Database tables initialized successfully');
  } catch (err) {
    console.error('DATABASE INITIALIZATION ERROR:', err.message);
  }
};

initDb().finally(() => {
  startApiServer(db, undefined, {
    sendUserToDevice: async (payload) => {
      const sn = payload?.sn;
      if (!sn) {
        return { ok: false, message: 'Missing device serial number' };
      }

      const ws = activeDevicesBySn.get(sn);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return { ok: false, message: `Device ${sn} is offline` };
      }

      const commandPayload = {
        cmd: 'setuserinfo',
        sn,
        enrollid: payload.enrollid,
        name: payload.name,
        backupnum: payload.backupnum,
        admin: payload.admin,
        record: payload.record
      };

      const requestId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
      commandPayload.request_id = requestId;
      const pendingKey = `${sn}:setuserinfo:${requestId}`;

      return await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          pendingCommandResponses.delete(pendingKey);
          resolve({ ok: false, message: `Timeout waiting device ${sn} response` });
        }, 8000);

        pendingCommandResponses.set(pendingKey, {
          sn,
          ret: 'setuserinfo',
          requestId,
          resolve,
          timeout
        });

        try {
          ws.send(JSON.stringify(commandPayload));
        } catch (err) {
          clearTimeout(timeout);
          pendingCommandResponses.delete(pendingKey);
          resolve({ ok: false, message: `Failed to send command: ${err.message}` });
        }
      });
    }
  });
});

/* ================= UTILITY FUNCTIONS ================= */
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

const isValidSN = (sn) => {
  return typeof sn === 'string' && sn.length > 0 && sn.length <= 64 && /^[A-Za-z0-9_-]+$/.test(sn);
};

const isValidCmd = (cmd) => {
  const validCommands = [
    'reg', 'heartbeat', 'sendlog', 'senduser', 'sendqrcode',
    // Server-initiated commands
    'getuserlist', 'getuserinfo', 'setuserinfo', 'deleteuser',
    'getusername', 'setusername', 'enableuser', 'cleanuser',
    'getnewlog', 'getalllog', 'cleanlog', 'initsys', 'reboot',
    'cleanadmin', 'settime', 'gettime', 'setdevinfo', 'getdevinfo',
    'opendoor', 'setdevlock', 'getdevlock', 'getuserlock', 'setuserlock',
    'deleteuserlock', 'cleanuserlock', 'getquestionnaire', 'setquestionnaire',
    'getholiday', 'setholiday'
  ];
  return validCommands.includes(cmd);
};

const sanitizeString = (str, maxLength = 255) => {
  if (typeof str !== 'string') return null;
  return str.substring(0, maxLength).trim();
};

const isValidBase64Image = (data) => {
  if (typeof data !== 'string') return false;
  if (data.length > MAX_IMAGE_SIZE * 1.4) return false;
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
  if (!sn) return;

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
  if (!sn || !devinfo) return;

  try {
    await db.execute(
      `UPDATE device_status
       SET modelname = ?, usersize = ?, facesize = ?, fpsize = ?,
           cardsize = ?, pwdsize = ?, logsize = ?, useduser = ?,
           usedface = ?, usedfp = ?, usedcard = ?, usedpwd = ?,
           usedlog = ?, usednewlog = ?, usedrtlog = ?, netinuse = ?,
           usb4g = ?, fpalgo = ?, firmware = ?, device_time = ?,
           intercom = ?, floors = ?, charid = ?, useosdp = ?,
           dislanguage = ?, mac = ?
       WHERE device_sn = ?`,
      [
        devinfo.modelname || null, devinfo.usersize || null,
        devinfo.facesize || null, devinfo.fpsize || null,
        devinfo.cardsize || null, devinfo.pwdsize || null,
        devinfo.logsize || null, devinfo.useduser || null,
        devinfo.usedface || null, devinfo.usedfp || null,
        devinfo.usedcard || null, devinfo.usedpwd || null,
        devinfo.usedlog || null, devinfo.usednewlog || null,
        devinfo.usedrtlog || null, devinfo.netinuse || null,
        devinfo.usb4g || null, devinfo.fpalgo || null,
        devinfo.firmware || null, devinfo.time || null,
        devinfo.intercom || null, devinfo.floors || null,
        devinfo.charid || null, devinfo.useosdp || null,
        devinfo.dislanguage || null, devinfo.mac || null,
        sn
      ]
    );
  } catch (err) {
    console.error("DEVICE INFO ERROR:", err.message);
  }
};

const getCloudTime = () => {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
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

const rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimitByIP.entries()) {
    if (now > data.resetTime) {
      rateLimitByIP.delete(ip);
    }
  }
}, 60000);

/* ================= IMAGE FOLDER ================= */
const imageDir = path.join(__dirname, 'images');
if (!fs.existsSync(imageDir)) {
  fs.mkdirSync(imageDir, { recursive: true });
}

/* ================= COMMAND HANDLERS ================= */
const handleRegister = async (ws, data, ip) => {
  console.log(`[REGISTER] Device: ${data.sn}, IP: ${ip}`);
  
  await updateDeviceStatus(data.sn, ip, true);
  
  if (data.devinfo) {
    await updateDeviceInfo(data.sn, data.devinfo);
  }

  return {
    ret: "reg",
    result: true,
    sn: data.sn,
    cloudtime: getCloudTime(),
    nosenduser: true
  };
};

const handleHeartbeat = async (ws, data, ip) => {
  await updateDeviceStatus(data.sn, ip, true);
  
  return {
    ret: "heartbeat",
    result: true,
    sn: data.sn,
    cloudtime: getCloudTime()
  };
};

const handleSendLog = async (ws, data, ip) => {
  console.log(`[LOG] Device: ${data.sn}, Count: ${data.count}, Index: ${data.logindex || 'N/A'}`);
  
  await updateDeviceStatus(data.sn, ip, true);

  if (!Array.isArray(data.record)) {
    console.error('[INVALID LOG] Record is not an array');
    return {
      ret: "sendlog",
      result: false,
      reason: 1
    };
  }

  for (const record of data.record) {
    let enrollId = record.enrollid;
    
    // Validate required fields
    if (!enrollId && enrollId !== 0) {
      console.error(`[INVALID LOG] Missing enrollId`);
      return {
        ret: "sendlog",
        result: false,
        reason: 1
      };
    }

    if (!record.time) {
      console.error(`[INVALID LOG] Missing time`);
      return {
        ret: "sendlog",
        result: false,
        reason: 1
      };
    }

    console.log(`[PROCESSING] SN: ${data.sn}, EnrollID: ${enrollId}, Time: ${record.time}`);

    // Handle fallback for missing enroll ID (enrollid = 0 means system event)
    if (!enrollId && enrollId !== 0) {
      const fallbackId = `UNKNOWN_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      enrollId = fallbackId.substring(0, 64);
      console.log(`[FALLBACK] Using ${enrollId}`);
    }

    let imagePath = null;

    // Save image (AI device with backupnum 50)
    if (record.image && record.image.length > 100) {
      try {
        if (!isValidBase64Image(record.image)) {
          console.log(`[INVALID IMAGE] ${data.sn} - Invalid base64`);
        } else {
          const safeSn = sanitizeString(data.sn, 64).replace(/[^A-Za-z0-9_-]/g, '_');
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
          const filename = `${safeSn}_${enrollId}_${timestamp}.jpg`;
          const filepath = path.join(imageDir, path.basename(filename));
          
          const imageBuffer = Buffer.from(record.image, 'base64');
          
          if (imageBuffer.length > MAX_IMAGE_SIZE) {
            console.log(`[IMAGE TOO LARGE] ${data.sn} - ${imageBuffer.length} bytes`);
          } else if (imageBuffer.length > 2 && imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8) {
            fs.writeFileSync(filepath, imageBuffer);
            imagePath = filename;
            console.log(`[IMAGE SAVED] ${filename}`);
          } else {
            console.log(`[INVALID IMAGE] ${data.sn} - Not a valid JPEG`);
          }
        }
      } catch (err) {
        console.error(`[IMAGE ERROR] ${data.sn} - ${err.message}`);
      }
    }

    try {
      console.log(`[DB INSERT] SN: ${data.sn}, EnrollID: ${enrollId}, Time: ${record.time}`);
      await db.execute(
        `INSERT INTO attendance_logs
        (device_sn, enroll_id, user_name, log_time, verify_mode, io_status,
         event_code, temperature, image_path, device_ip, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE id=id`,
        [
          sanitizeString(data.sn, 64),
          String(enrollId).substring(0, 64),
          sanitizeString(record.name, 128),
          sanitizeString(record.time, 32),
          Number.parseInt(record.mode, 10) || null,
          Number.parseInt(record.inout, 10) || null,
          Number.parseInt(record.event, 10) || null,
          record.temp ? parseFloat(record.temp) : null,
          imagePath,
          ip,
          JSON.stringify(record).substring(0, 65535)
        ]
      );
    } catch (err) {
      console.error(`[DB INSERT ERROR] SN: ${data.sn}, EnrollID: ${enrollId}, Time: ${record.time} - ${err.message}`);
    }
  }

  // Protocol 2.4 compliant acknowledgment
  return {
    ret: "sendlog",
    result: true,
    count: data.count,
    logindex: data.logindex || 0,
    cloudtime: getCloudTime(),
    access: 1, // 1 = open door, 0 = deny access
    message: "Log received successfully"
  };
};

const handleSendUser = async (ws, data, ip) => {
  console.log(`[SENDUSER] Device: ${data.sn}, EnrollID: ${data.enrollid}, BackupNum: ${data.backupnum}`);
  
  // This is called when a user is added via keypad on the device
  // Store user information in your system if needed
  
  return {
    ret: "senduser",
    result: true,
    cloudtime: getCloudTime()
  };
};

const handleSendQRCode = async (ws, data, ip) => {
  console.log(`[QR CODE] Device: ${data.sn}, Record: ${data.record}`);
  
  // Process QR code verification
  // This is where you'd verify the QR code against your database
  
  return {
    ret: "sendqrcode",
    result: true,
    access: 1, // 1 = allow access, 0 = deny
    enrollid: 0, // Optional: user ID
    username: "", // Optional: username
    message: "QR code accepted"
  };
};

/* ================= WEBSOCKET SERVER ================= */
const wss = new WebSocket.Server({ 
  port: PORT,
  maxPayload: MAX_MESSAGE_SIZE,
  clientTracking: true
});

console.log(`=================================================`);
console.log(`AI Push Server (Protocol 2.4) - Port ${PORT}`);
console.log(`Security: Max ${MAX_CONNECTIONS_PER_IP} conn/IP, ${RATE_LIMIT_MAX_REQUESTS} req/min`);
console.log(`Authentication: ${DEVICE_AUTH_TOKEN ? 'ENABLED' : 'DISABLED'}`);
console.log(`=================================================`);

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  let currentSn = null;
  let isAuthenticated = !DEVICE_AUTH_TOKEN;
  let messageCount = 0;
  let connectionTimeout = null;
  let heartbeatInterval = null;
  
  // Check connection limit per IP
  const ipConnections = connectionsByIP.get(ip) || 0;
  if (ipConnections >= MAX_CONNECTIONS_PER_IP) {
    console.log(`[REJECTED] ${ip} - Too many connections`);
    ws.close(1008, 'Too many connections from IP');
    return;
  }
  
  connectionsByIP.set(ip, ipConnections + 1);
  console.log(`[CONNECTED] ${ip} (${ipConnections + 1}/${MAX_CONNECTIONS_PER_IP})`);
  
  // Reset activity timeout
  const resetTimeout = () => {
    if (connectionTimeout) clearTimeout(connectionTimeout);
    connectionTimeout = setTimeout(() => {
      console.log(`[TIMEOUT] ${ip} - Inactive connection`);
      ws.close(1000, 'Connection timeout');
    }, CONNECTION_TIMEOUT);
  };
  
  resetTimeout();

  // Ping/pong for connection health
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

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
    
    // Message size validation
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
      await storeDeviceMessage(ip, rawMessage, null, false, err.message);
      ws.send(JSON.stringify({ ret: 'error', message: 'Invalid JSON' }));
      return;
    }

    await storeDeviceMessage(ip, rawMessage, data, true, null);

    const responseSn = data.sn || currentSn;
    if (data.ret && responseSn) {
      for (const [pendingKey, pending] of pendingCommandResponses.entries()) {
        if (pending.sn === responseSn && pending.ret === data.ret && (!data.request_id || pending.requestId === data.request_id)) {
          clearTimeout(pending.timeout);
          pendingCommandResponses.delete(pendingKey);
          pending.resolve({
            ok: Boolean(data.result),
            message: data.message || (data.result ? 'Device accepted command' : 'Device rejected command'),
            data
          });
          return;
        }
      }
    }
    
    // Validate command
    if (!data.cmd || !isValidCmd(data.cmd)) {
      console.log(`[INVALID CMD] ${ip} - ${data.cmd}`);
      ws.send(JSON.stringify({ ret: 'error', message: 'Invalid command' }));
      return;
    }
    
    // Validate serial number (required for device-initiated commands)
    if (['reg', 'heartbeat', 'sendlog', 'senduser', 'sendqrcode'].includes(data.cmd)) {
      if (!data.sn || !isValidSN(data.sn)) {
        console.log(`[INVALID SN] ${ip} - ${data.sn}`);
        ws.send(JSON.stringify({ ret: 'error', message: 'Invalid serial number' }));
        return;
      }
    }
    
    // Authentication check
    if (!isAuthenticated && DEVICE_AUTH_TOKEN) {
      if (data.cmd === 'reg' && data.token === DEVICE_AUTH_TOKEN) {
        isAuthenticated = true;
        console.log(`[AUTHENTICATED] ${ip} - ${data.sn}`);
      } else {
        console.log(`[AUTH FAILED] ${ip} - ${data.sn}`);
        ws.send(JSON.stringify({ 
          ret: data.cmd, 
          result: false, 
          message: 'Authentication required' 
        }));
        return;
      }
    }

    // Route to appropriate handler
    let response;
    try {
      switch (data.cmd) {
        case 'reg':
          currentSn = data.sn;
          activeDevicesBySn.set(currentSn, ws);
          response = await handleRegister(ws, data, ip);
          break;
        
        case 'heartbeat':
          currentSn = data.sn;
          activeDevicesBySn.set(currentSn, ws);
          response = await handleHeartbeat(ws, data, ip);
          break;
        
        case 'sendlog':
          currentSn = data.sn;
          activeDevicesBySn.set(currentSn, ws);
          response = await handleSendLog(ws, data, ip);
          break;
        
        case 'senduser':
          response = await handleSendUser(ws, data, ip);
          break;
        
        case 'sendqrcode':
          response = await handleSendQRCode(ws, data, ip);
          break;
        
        default:
          console.log(`[UNHANDLED] ${data.cmd} from ${ip}`);
          response = {
            ret: data.cmd,
            result: false,
            message: 'Command not implemented'
          };
      }

      if (response) {
        ws.send(JSON.stringify(response));
      }
    } catch (err) {
      console.error(`[HANDLER ERROR] ${data.cmd} - ${err.message}`);
      ws.send(JSON.stringify({
        ret: data.cmd,
        result: false,
        message: 'Internal server error'
      }));
    }
  });

  ws.on('close', () => {
    if (connectionTimeout) clearTimeout(connectionTimeout);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    
    const count = connectionsByIP.get(ip) || 1;
    connectionsByIP.set(ip, count - 1);
    if (count - 1 <= 0) connectionsByIP.delete(ip);
    
    console.log(`[DISCONNECTED] ${ip} - ${messageCount} messages`);
    if (currentSn) {
      if (activeDevicesBySn.get(currentSn) === ws) {
        activeDevicesBySn.delete(currentSn);
      }
      updateDeviceStatus(currentSn, ip, false);
    }
  });

  ws.on('error', (err) => {
    console.log(`[ERROR] ${ip} - ${err.message}`);
    if (currentSn) {
      if (activeDevicesBySn.get(currentSn) === ws) {
        activeDevicesBySn.delete(currentSn);
      }
      updateDeviceStatus(currentSn, ip, false);
    }
  });
});

// Ping all clients periodically
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

/* ================= GRACEFUL SHUTDOWN ================= */
const shutdown = async (signal) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  
  clearInterval(pingInterval);
  clearInterval(offlineCheckInterval);
  clearInterval(rateLimitCleanup);
  
  wss.close(() => {
    console.log('WebSocket server closed');
  });
  
  for (const client of wss.clients) {
    client.close(1001, 'Server shutting down');
  }
  
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

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  shutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
});