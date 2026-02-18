const net = require("net");
const mysql = require("mysql2/promise");
const fs = require("fs");
require("dotenv").config();

const PORT = 9001;

/* ---------- DATABASE ---------- */
const db = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "test_fingerspot",
  waitForConnections: true,
  connectionLimit: 10
});


/* ---------- COMMAND DICTIONARY ---------- */

const commands = [
  // confirmed
  "get_info","get_config","get_user","get_log","get_new_log",
  "lock","unlock","beep","restart","clear_log","clear_user",

  // likely supported
  "set_time","get_time","set_config","get_device","get_sn",
  "open_door","close_door","get_version","get_firmware",
  "get_photo","get_face","get_fp","get_card",
  "delete_user","set_user","add_user","update_user",
  "factory_reset","reboot","poweroff","sleep","wake",

  // experimental
  "status","ping","test","info","version","time","date",
  "cmd","list","help","scan","debug","sysinfo","netinfo"
];

let deviceState = {};

/* ---------- SERVER ---------- */

console.log("COMMAND SCANNER ACTIVE:", PORT);

net.createServer(socket => {

  const ip = socket.remoteAddress.replace("::ffff:", "");
  console.log("CONNECT:", ip);

  let buffer = Buffer.alloc(0);

  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);

    const txt = buffer.toString();
    if (!txt.includes("\r\n\r\n")) return;

    processPacket(txt, socket, ip);
    buffer = Buffer.alloc(0);
  });

  socket.on("close", () => console.log("DISCONNECTED:", ip));
  socket.on("error", e => console.log("ERROR:", e.message));

}).listen(PORT);



/* ---------- PACKET PROCESSOR ---------- */

async function processPacket(raw, socket, ip) {

  const snMatch = raw.match(/dev_id:\s*(.+)/i);
  const reqMatch = raw.match(/request_code:\s*(.+)/i);

  const sn = snMatch ? snMatch[1].trim() : ip;
  const req = reqMatch ? reqMatch[1].trim() : null;

  if (!deviceState[sn]) {
    deviceState[sn] = { index: 0, last: null };
  }

  const state = deviceState[sn];

  /* DEVICE ASKING COMMAND */
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


  /* DEVICE RESPONSE */
  if (state.last) {

    let type = "unknown";

    try {
      const jsonStart = raw.indexOf("{");
      if (jsonStart !== -1) {
        JSON.parse(raw.substring(jsonStart));
        type = "json";
      } else if (raw.length > 300) {
        type = "binary";
      } else if (raw.length > 80) {
        type = "text";
      } else {
        type = "empty";
      }
    } catch {
      type = "invalid_json";
    }

    console.log("RESULT:", sn, state.last, type);

    /* DB SAVE */
    try {
      await db.execute(
        `INSERT INTO device_command_scan
        (device_sn, device_ip, command_sent, response_type, response_raw)
        VALUES (?,?,?,?,?)`,
        [sn, ip, state.last, type, raw]
      );
    } catch(e) {
      console.log("DB ERROR:", e.message);
    }

    /* FILE LOG */
    fs.appendFileSync(
      "scan_results.log",
      `[${new Date().toISOString()}] ${sn} | ${state.last} | ${type}\n${raw}\n\n`
    );

    state.last = null;
  }

  /* ACK */
  socket.write(
    "HTTP/1.0 200 OK\r\n" +
    "Content-Type: text/plain\r\n" +
    "Content-Length: 2\r\n\r\nOK"
  );
}
