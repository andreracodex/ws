const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

/* ================= CONFIG ================= */
const PORT = Number.parseInt(process.env.WS_PORT, 10) || 9001;
const OFFLINE_TIMEOUT_SECONDS = Number.parseInt(process.env.DEVICE_OFFLINE_SECONDS, 10) || 10;

const db = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || 'mypassrootonly',
  database: process.env.DB_NAME || 'test_fingerspot',
  port: Number.parseInt(process.env.DB_PORT, 10) || 3306,
  waitForConnections: true,
  connectionLimit: Number.parseInt(process.env.DB_CONN_LIMIT, 10) || 10
});

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

setInterval(async () => {
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

/* =============== IMAGE FOLDER =============== */
const imageDir = path.join(__dirname, 'images');
if (!fs.existsSync(imageDir)) {
  fs.mkdirSync(imageDir);
}

/* =============== WEBSOCKET SERVER =============== */
const wss = new WebSocket.Server({ port: PORT });

console.log(`AI Push Server (Protocol 2.4) running on port ${PORT}`);

wss.on('connection', (ws, req) => {

  const ip = req.socket.remoteAddress;
  let currentSn = null;
  console.log(`[CONNECTED] ${ip}`);

  ws.on('message', async (message) => {

    let data;

    try {
      data = JSON.parse(message.toString());
    } catch {
      console.log("Invalid JSON received");
      return;
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

        let imagePath = null;

        /* Save Image (AI Device) */
        if (record.image && record.image.length > 100) {
          try {
            const filename = `${data.sn}_${record.enrollid}_${Date.now()}.jpg`;
            const filepath = path.join(imageDir, filename);
            fs.writeFileSync(filepath, record.image, 'base64');
            imagePath = filename;
          } catch (err) {
            console.log("Image save error:", err.message);
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
              data.sn,
              record.enrollid,
              record.name || null,
              record.time,
              record.mode,
              record.inout,
              record.event,
              record.temp || null,
              imagePath,
              ip,
              JSON.stringify(record)
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
        sn: data.sn,
        count: data.count,
        logindex: data.logindex,
        cloudtime: new Date().toISOString().slice(0, 19).replace('T', ' ')
      }));

      console.log("ACK sent to device");
    }
  });

  ws.on('close', () => {
    console.log(`[DISCONNECTED] ${ip}`);
    updateDeviceStatus(currentSn, ip, false);
  });

  ws.on('error', (err) => {
    console.log(`[ERROR] ${ip} - ${err.message}`);
    updateDeviceStatus(currentSn, ip, false);
  });

});
