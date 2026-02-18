const net = require("net");
const mysql = require("mysql2/promise");
const fs = require("fs");
require("dotenv").config();

/* ================= CONFIG ================= */

const PORT = 9001;
const TARGET_USERS = ["15"];
const OFFLINE_SECONDS = 60;

/* ================= DATABASE ================= */

const db = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "test_fingerspot",
  waitForConnections: true,
  connectionLimit: 10
});

/* ================= MEMORY STATE ================= */

const devices = new Map();

/*
device state structure:

{
 ip,
 lastSeen,
 firstSeen,
 connects,
 events
}
*/

/* ================= UTIL ================= */

function now(){ return Date.now(); }

function logPacket(raw){
  try{
    fs.appendFileSync("packets.log","\n==== PACKET ====\n"+raw+"\n");
  }catch{}
}

function eventName(code){
  return {
    0:"PASS",
    1:"ADMIN",
    5:"CARD",
    10:"DOOR_OPEN",
    11:"DOOR_CLOSE"
  }[code] || "UNKNOWN";
}

function touchDevice(sn,ip){
  if(!devices.has(sn)){
    devices.set(sn,{
      ip,
      firstSeen: now(),
      lastSeen: now(),
      connects:1,
      events:0
    });
  }else{
    const d = devices.get(sn);
    d.lastSeen = now();
    d.connects++;
  }
}

/* ================= OFFLINE WATCHDOG ================= */

setInterval(()=>{

  const t = now();

  for(const [sn,d] of devices){

    if(t - d.lastSeen > OFFLINE_SECONDS*1000){

      console.log("DEVICE OFFLINE:",sn,d.ip);
      devices.delete(sn);
    }
  }

},10000);

/* ================= SERVER ================= */

const server = net.createServer(socket=>{

  const ip = socket.remoteAddress.replace("::ffff:","");
  let buffer = Buffer.alloc(0);
  let snCache = null;

  console.log("CONNECT:",ip);

  socket.on("data", async chunk=>{

    buffer = Buffer.concat([buffer,chunk]);

    while(true){

      const str = buffer.toString();

      const headerEnd = str.indexOf("\r\n\r\n");
      if(headerEnd === -1) return;

      const headerPart = str.substring(0,headerEnd);

      const lenMatch = headerPart.match(/Content-Length:\s*(\d+)/i);
      const bodyLen = lenMatch ? parseInt(lenMatch[1]) : 0;

      const totalLen = headerEnd+4+bodyLen;

      if(buffer.length < totalLen) return;

      const packet = buffer.slice(0,totalLen);
      buffer = buffer.slice(totalLen);

      await handlePacket(packet.toString(),ip,socket,(sn)=>{snCache=sn;});
    }

  });

  socket.on("close",()=>{
    console.log("DISCONNECT:",ip);
  });

  socket.on("error",e=>{
    console.log("SOCKET ERROR:",e.message);
  });

});

server.listen(PORT,()=>{
  console.log("SERVER RUNNING PORT",PORT);
});

/* ================= PACKET HANDLER ================= */

async function handlePacket(raw,ip,socket,setSN){

  logPacket(raw);

  const headerEnd = raw.indexOf("\r\n\r\n");
  const headerTxt = raw.substring(0,headerEnd);
  const bodyTxt = raw.substring(headerEnd+4);

  /* ---------- HEADERS ---------- */

  const headers={};

  headerTxt.split("\r\n").forEach(line=>{
    const i=line.indexOf(":");
    if(i>0)
      headers[line.slice(0,i).trim().toLowerCase()]
        = line.slice(i+1).trim();
  });

  const cmd = headers["request_code"] || "";
  const sn  = headers["dev_id"] || "UNKNOWN";

  setSN(sn);
  touchDevice(sn,ip);

  /* ---------- JSON ---------- */

  let json={};
  let valid=1;
  let err=null;

  try{
    json=JSON.parse(bodyTxt);
  }catch(e){
    valid=0;
    err=e.message;
  }

  /* ======================================================
     REALTIME EVENT
     ====================================================== */

  if(cmd==="realtime_glog"){

    const user =
      json.userId ??
      json.pin ??
      json?.data?.pin ??
      null;

    const time = json.time || null;
    const mode = json.ioMode ?? null;

    const dev = devices.get(sn);
    if(dev) dev.events++;

    /* ignore non-user events */
    if(!user){
      console.log("EVENT:",sn,"NO_USER",eventName(mode));
      socket.write("HTTP/1.1 200 OK\r\n\r\n"+'{"result":1}');
      return;
    }

    console.log("EVENT:",sn,user,time,eventName(mode));

    if(TARGET_USERS.includes(user)){
      try{
        await db.execute(
          `INSERT INTO device_logs
           (device_sn,user_id,event_time,event_mode,raw,is_json_valid,parse_error,ip)
           VALUES (?,?,?,?,?,?,?,?)`,
          [sn,user,time,mode,raw,valid,err,ip]
        );

        console.log("SAVED:",user);

      }catch(e){
        console.log("DB ERROR:",e.message);
      }
    }

    socket.write("HTTP/1.1 200 OK\r\n\r\n"+'{"result":1}');
    return;
  }

  /* ======================================================
     COMMAND POLL
     ====================================================== */

  if(cmd==="receive_cmd"){
    socket.write("HTTP/1.1 200 OK\r\n\r\n"+'{"cmd":""}');
    return;
  }

  /* ======================================================
     FALLBACK
     ====================================================== */

  socket.write("HTTP/1.1 200 OK\r\n\r\n");
}
