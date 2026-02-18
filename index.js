const net = require("net");
const mysql = require("mysql2/promise");
const fs = require("fs");
require("dotenv").config();

/* ================= CONFIG ================= */

const PORT = 9001;
const TARGET_USERS = ["15"]; // only save these user IDs

/* ================= DATABASE ================= */

const db = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "test_fingerspot",
  waitForConnections: true,
  connectionLimit: 10
});

/* ================= LOGGER ================= */

function logPacket(raw){
  try{
    fs.appendFileSync(
      "packets.log",
      "\n==== PACKET ====\n"+raw+"\n"
    );
  }catch{}
}

/* ================= SERVER ================= */

const server = net.createServer(socket => {

  const ip = socket.remoteAddress.replace("::ffff:","");
  console.log("CONNECT:", ip);

  let bufferStore = Buffer.alloc(0);

  socket.on("data", async chunk => {

    bufferStore = Buffer.concat([bufferStore, chunk]);

    while(true){

      const str = bufferStore.toString();

      const headerEnd = str.indexOf("\r\n\r\n");
      if(headerEnd === -1) return;

      const headerPart = str.substring(0, headerEnd);

      const lenMatch = headerPart.match(/Content-Length:\s*(\d+)/i);
      const bodyLength = lenMatch ? parseInt(lenMatch[1]) : 0;

      const total = headerEnd + 4 + bodyLength;

      if(bufferStore.length < total)
        return;

      const packet = bufferStore.slice(0,total);
      bufferStore = bufferStore.slice(total);

      await handlePacket(packet.toString(), ip, socket);
    }
  });

  socket.on("close", ()=> console.log("DISCONNECT:", ip));
  socket.on("error", e=> console.log("SOCKET ERROR:", e.message));

});

server.listen(PORT, ()=>{
  console.log("SERVER RUNNING PORT", PORT);
});

/* ================= PACKET HANDLER ================= */

async function handlePacket(raw, ip, socket){

  logPacket(raw);

  const headerEnd = raw.indexOf("\r\n\r\n");
  const headerText = raw.substring(0, headerEnd);
  const bodyText = raw.substring(headerEnd+4);

  /* ---------- PARSE HEADERS ---------- */

  const headers = {};
  headerText.split("\r\n").forEach(line=>{
    const i = line.indexOf(":");
    if(i>0)
      headers[line.slice(0,i).trim().toLowerCase()]
        = line.slice(i+1).trim();
  });

  const cmd = headers["request_code"] || "";
  const sn  = headers["dev_id"] || "";

  /* ---------- PARSE JSON ---------- */

  let json = {};
  let jsonValid = 1;
  let parseError = null;

  try{
    json = JSON.parse(bodyText);
  }catch(e){
    jsonValid = 0;
    parseError = e.message;
  }

  /* =================================================
     EVENT LOG
     ================================================= */

  if(cmd === "realtime_glog"){

    const user =
      json.userId ??
      json.pin ??
      json?.data?.pin ??
      null;

    const time = json.time || null;
    const mode = json.ioMode ?? null;

    console.log("EVENT:", sn, user, time, mode);

    /* save only target user */
    if(user && TARGET_USERS.includes(user)){

      try{
        await db.execute(
          `INSERT INTO device_logs
           (device_sn,user_id,event_time,event_mode,raw,is_json_valid,parse_error,ip)
           VALUES (?,?,?,?,?,?,?,?)`,
          [sn,user,time,mode,raw,jsonValid,parseError,ip]
        );

        console.log("SAVED USER", user);

      }catch(e){
        console.log("DB ERROR:", e.message);
      }
    }

    /* required response */
    socket.write(
      "HTTP/1.1 200 OK\r\n\r\n"+
      '{"result":1}'
    );
    return;
  }

  /* =================================================
     COMMAND POLL
     ================================================= */

  if(cmd === "receive_cmd"){

    socket.write(
      "HTTP/1.1 200 OK\r\n\r\n"+
      '{"cmd":""}'
    );
    return;
  }

  /* =================================================
     UNKNOWN PACKET
     ================================================= */

  socket.write("HTTP/1.1 200 OK\r\n\r\n");
}
