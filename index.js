const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dayjs = require("dayjs");

/* ================= CONFIG ================= */

const PORT = 9001;
const IMAGE_DIR = "./images";
const DUP_WINDOW_MS = 60000;
const MAX_PACKET = 10 * 1024 * 1024;

if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR);

/* ================= DUPLICATE FILTER ================= */

const seen = new Map();

function isDuplicate(str){
    const hash = crypto.createHash("md5").update(str).digest("hex");

    if(seen.has(hash)) return true;

    seen.set(hash, Date.now());
    return false;
}

// auto clean hash cache
setInterval(()=>{
    const now = Date.now();
    for(const [k,v] of seen){
        if(now - v > DUP_WINDOW_MS) seen.delete(k);
    }
}, 10000);

/* ================= HTTP PARSER ================= */

function parseHttp(buffer){

    const text = buffer.toString();
    const headerEnd = text.indexOf("\r\n\r\n");
    if(headerEnd === -1) return null;

    const headerText = text.slice(0, headerEnd);
    const headers = {};

    headerText.split("\r\n").slice(1).forEach(line=>{
        const [k,v] = line.split(":");
        if(k && v) headers[k.trim().toLowerCase()] = v.trim();
    });

    const len = parseInt(headers["content-length"] || 0);
    const total = headerEnd + 4 + len;

    if(buffer.length < total) return null;

    const body = buffer.slice(headerEnd + 4, total).toString();

    return {
        headers,
        body,
        size: total
    };
}

/* ================= RESPONSE ================= */

function replyAndClose(socket, obj){
    const body = JSON.stringify(obj);

    socket.end(
        "HTTP/1.1 200 OK\r\n"+
        "Content-Type: application/json\r\n"+
        "Content-Length: "+Buffer.byteLength(body)+"\r\n"+
        "Connection: close\r\n"+
        "\r\n"+
        body
    );
}

/* ================= PROCESSOR ================= */

function processPacket(ip, json){

    console.log("\nEVENT FROM:", ip);

    if(json.time)
        console.log("Device Time:", json.time);

    if(json.userId)
        console.log("User:", json.userId);

    if(json.ioMode !== undefined)
        console.log("Mode:", json.ioMode);

    /* save image */
    if(json.logPhoto){
        const file = path.join(
            IMAGE_DIR,
            dayjs().format("YYYYMMDD_HHmmss_SSS")+".jpg"
        );

        fs.writeFileSync(file, Buffer.from(json.logPhoto,"base64"));
        console.log("Saved image:", file);
    }
}

/* ================= SERVER ================= */

const server = net.createServer(socket=>{

    const ip = socket.remoteAddress;
    console.log("\nDEVICE CONNECT:", ip);

    let buffer = Buffer.alloc(0);

    socket.on("data", chunk=>{

        buffer = Buffer.concat([buffer, chunk]);

        if(buffer.length > MAX_PACKET){
            console.log("Packet overflow dropped");
            buffer = Buffer.alloc(0);
            return;
        }

        while(true){

            const packet = parseHttp(buffer);
            if(!packet) break;

            buffer = buffer.slice(packet.size);

            const bodyStr = packet.body;

            if(isDuplicate(bodyStr)){
                console.log("Duplicate ignored");
                replyAndClose(socket,{result:true});
                continue;
            }

            let json;
            try{
                json = JSON.parse(bodyStr);
            }catch{
                console.log("Non JSON packet");
                replyAndClose(socket,{ok:true});
                continue;
            }

            /* ==== IMMEDIATE ACK ==== */

            if(packet.headers.request_code === "realtime_glog")
                replyAndClose(socket,{result:true});

            else if(packet.headers.request_code === "receive_cmd")
                replyAndClose(socket,{cmd:[]});

            else
                replyAndClose(socket,{ok:true});

            /* ==== ASYNC PROCESS ==== */

            setImmediate(()=>processPacket(ip,json));
        }
    });

    socket.on("close",()=>console.log("DISCONNECTED:",ip));
    socket.on("error",e=>console.log("SOCKET ERROR:",e.message));
});

/* ================= START ================= */

server.listen(PORT, ()=>{
    console.log("Production Push Server running on port", PORT);
});
