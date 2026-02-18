const net = require("net");
const mysql = require("mysql2/promise");
require("dotenv").config();
const TARGET_USERS = ["1", "15"]; // allowed user IDs

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

console.log("RAW INGEST SERVER RUNNING:", PORT);

/* ---------- SERVER ---------- */
net.createServer(socket => {

  const ip = socket.remoteAddress.replace("::ffff:", "");
  console.log("CONNECT:", ip);

  let bufferStore = Buffer.alloc(0);

  socket.on("data", async chunk => {
    bufferStore = Buffer.concat([bufferStore, chunk]);

    while (true) {

      const dataStr = bufferStore.toString();

      const headerEnd = dataStr.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const headerPart = dataStr.substring(0, headerEnd);
      const lengthMatch = headerPart.match(/Content-Length:\s*(\d+)/i);
      const bodyLength = lengthMatch ? parseInt(lengthMatch[1]) : 0;

      const totalLength = headerEnd + 4 + bodyLength;
      if (bufferStore.length < totalLength) return;

      const fullPacket = bufferStore.slice(0, totalLength);
      bufferStore = bufferStore.slice(totalLength);

      await handlePacket(fullPacket.toString(), ip, socket);
    }
  });

  socket.on("close", () => console.log("DISCONNECTED:", ip));
  socket.on("error", e => console.log("ERROR:", e.message));

}).listen(PORT);

/* ---------- PACKET HANDLER ---------- */

async function handlePacket(raw, ip, socket) {

  try {
    require("fs").appendFileSync(
      "raw_packets.log",
      "\n==== PACKET ====\n" + raw + "\n"
    );
  } catch(e) {}

  let device_sn = null;
  let cmd = null;
  let jsonValid = 0;
  let parseError = null;
  let matchedUser = null;

  try {

    /* -------- HEADERS -------- */

    const snMatch = raw.match(/dev_id:\s*(.+)/i);
    if (snMatch) device_sn = snMatch[1].trim();

    const cmdMatch = raw.match(/request_code:\s*(.+)/i);
    if (cmdMatch) cmd = cmdMatch[1].trim();

    /* -------- JSON BODY -------- */

    const jsonStart = raw.indexOf("{");

    if (jsonStart !== -1) {

      const jsonPart = raw.substring(jsonStart);
      const parsed = JSON.parse(jsonPart);
      // console.log("USER DETECT TEST:", parsed.userId, parsed.data?.pin, parsed.pin);
      jsonValid = 1;

      /* -------- USER FILTER -------- */

      // realtime_glog format
      if (parsed.userId && TARGET_USERS.includes(parsed.userId)) {
        matchedUser = parsed.userId;
      }

      // webhook attlog format
      if (parsed.data?.pin && TARGET_USERS.includes(parsed.data.pin)) {
        matchedUser = parsed.data.pin;
      }

      // fallback generic formats
      if (parsed.pin && TARGET_USERS.includes(parsed.pin)) {
        matchedUser = parsed.pin;
      }
    }

  } catch (err) {
    parseError = err.message;
  }

  /* -------- SAVE ONLY MATCHED USERS -------- */

  if (matchedUser) {
    try {
      await db.execute(
        `INSERT INTO device_messages
         (device_sn, cmd, device_ip, payload, is_json_valid, parse_error)
         VALUES (?,?,?,?,?,?)`,
        [device_sn, cmd, ip, raw, jsonValid, parseError]
      );

      console.log("MATCHED USER:", matchedUser, "| CMD:", cmd);

    } catch (e) {
      console.log("DB ERROR:", e.message);
    }
  } else {
    console.log("IGNORED PACKET (user not target)");
  }

  /* -------- RESPONSE -------- */

  if (cmd === "receive_cmd") {
    socket.write(JSON.stringify({ cmd: "none" }));
  } else {
    socket.write("OK");
  }
}