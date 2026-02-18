const net = require("net");
const mysql = require("mysql2/promise");
const fs = require("fs");
require("dotenv").config();

const PORT = 9001;

/* ---------- DB ---------- */
const db = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "test_fingerspot",
  waitForConnections: true,
  connectionLimit: 10
});

/* ---------- COMMAND LIST ---------- */
const commands = [
  "get_info",
  "get_time",
  "get_config",
  "get_user",
  "get_log",
  "get_new_log",
  "unlock",
  "lock",
  "beep",
  "restart",
  "clear_log",
  "clear_user"
];

let deviceState = {};

console.log("COMMAND DETECTOR RUNNING:", PORT);

/* ---------- SERVER ---------- */
net.createServer(socket => {

  const ip = socket.remoteAddress.replace("::ffff:", "");
  console.log("CONNECT:", ip);

  let buffer = Buffer.alloc(0);

  socket.on("data", async chunk => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {

      const str = buffer.toString();
      const headerEnd = str.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const headerPart = str.substring(0, headerEnd);
      const lenMatch = headerPart.match(/Content-Length:\s*(\d+)/i);
      const bodyLen = lenMatch ? parseInt(lenMatch[1]) : 0;

      const totalLen = headerEnd + 4 + bodyLen;
      if (buffer.length < totalLen) return;

      const packet = buffer.slice(0, totalLen).toString();
      buffer = buffer.slice(totalLen);

      await processPacket(packet, socket, ip);
    }
  });

  socket.on("close", () => console.log("DISCONNECTED:", ip));
  socket.on("error", err => console.log("ERROR:", err.message));

}).listen(PORT);



/* ---------- PROCESS PACKET ---------- */

async function processPacket(raw, socket, ip) {

  const snMatch = raw.match(/dev_id:\s*(.+)/i);
  const reqMatch = raw.match(/request_code:\s*(.+)/i);

  const sn = snMatch ? snMatch[1].trim() : ip;
  const req = reqMatch ? reqMatch[1].trim() : null;

  if (!deviceState[sn]) {
    deviceState[sn] = { index: 0, last: null };
  }

  const state = deviceState[sn];

  /* ---------- DEVICE POLLING COMMAND ---------- */
  if (req === "receive_cmd") {

    if (state.index >= commands.length) {
      return sendHTTP(socket, JSON.stringify({ cmd: "none" }));
    }

    const cmd = commands[state.index];
    state.last = cmd;
    state.index++;

    console.log("SEND:", sn, cmd);

    return sendHTTP(socket, JSON.stringify({ cmd }));
  }

  /* ---------- DEVICE RESPONSE ---------- */
  if (state.last) {

    const result =
      raw.includes("OK") ||
      raw.includes('"result":"OK"') ||
      raw.length > 80
        ? "supported"
        : "rejected";

    console.log("RESULT:", sn, state.last, result);

    try {
      await db.execute(
        `INSERT INTO device_command_logs
        (device_sn, device_ip, command_sent, response_raw, result)
        VALUES (?,?,?,?,?)`,
        [sn, ip, state.last, raw, result]
      );
    } catch (e) {
      console.log("DB ERROR:", e.message);
    }

    fs.appendFileSync(
      "command_log.txt",
      `[${new Date().toISOString()}] ${sn} | ${state.last} | ${result}\n${raw}\n\n`
    );

    state.last = null;
  }

  sendHTTP(socket, "OK");
}



/* ---------- HTTP RESPONSE BUILDER ---------- */

function sendHTTP(socket, body) {
  const res =
    "HTTP/1.1 200 OK\r\n" +
    "Content-Type: application/json\r\n" +
    "Content-Length: " + Buffer.byteLength(body) + "\r\n" +
    "Connection: close\r\n" +
    "\r\n" +
    body;

  socket.write(res);
  socket.end();
}
