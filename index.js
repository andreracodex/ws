const net = require("net");
const mysql = require("mysql2/promise");
const fs = require("fs");
require("dotenv").config();

const PORT = 5005;

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

  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);

    const text = buffer.toString();
    if (!text.includes("\r\n\r\n")) return;

    processPacket(text, socket, ip);
    buffer = Buffer.alloc(0);
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

  /* ---------- DEVICE ASK COMMAND ---------- */
  if (req === "receive_cmd") {

    if (state.index >= commands.length) {
      socket.write("cmd=none\n");
      return;
    }

    const cmd = commands[state.index];
    state.last = cmd;
    state.index++;

    console.log("SEND:", sn, cmd);
    socket.write(`cmd=${cmd}\n`);
    return;
  }

  /* ---------- DEVICE RESPONSE ---------- */
  if (state.last) {

    const result = raw.length > 50 ? "supported" : "rejected";

    console.log("RESULT:", sn, state.last, result);

    /* SAVE DB */
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

    /* SAVE FILE LOG */
    fs.appendFileSync(
      "command_log.txt",
      `[${new Date().toISOString()}] ${sn} | ${state.last} | ${result}\n${raw}\n\n`
    );

    state.last = null;
  }

  socket.write(
    `HTTP/1.1 200 OK\r
    Content-Type: text/plain\r
    Content-Length: 2\r
    \r
    OK`
  );
}
