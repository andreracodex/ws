const net = require("net");
const mysql = require("mysql2/promise");

const PORT = 9001;
require('dotenv').config();
const db = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || 'mypassrootonly',
  database: process.env.DB_NAME || 'test_fingerspot',
  port: Number.parseInt(process.env.DB_PORT, 10) || 3306,
  waitForConnections: true,
  connectionLimit: Number.parseInt(process.env.DB_CONN_LIMIT, 10) || 10
});

console.log("RAW INGEST SERVER RUNNING:", PORT);

net.createServer(socket => {

    const ip = socket.remoteAddress.replace("::ffff:", "");
    console.log("CONNECT:", ip);

    socket.on("data", async buffer => {

        const raw = buffer.toString();
        let device_sn = null;
        let cmd = null;
        let jsonValid = 0;
        let parseError = null;

        try {
            // try extract headers
            const snMatch = raw.match(/dev_id:\s*(.+)/i);
            if (snMatch) device_sn = snMatch[1].trim();

            const cmdMatch = raw.match(/request_code:\s*(.+)/i);
            if (cmdMatch) cmd = cmdMatch[1].trim();

            // try detect JSON body
            const jsonStart = raw.indexOf("{");
            if (jsonStart !== -1) {
                const jsonPart = raw.substring(jsonStart);
                JSON.parse(jsonPart);
                jsonValid = 1;
            }

        } catch (err) {
            parseError = err.message;
        }

        try {
            await db.execute(
                `INSERT INTO device_logs 
                (device_sn, cmd, device_ip, payload, is_json_valid, parse_error)
                VALUES (?,?,?,?,?,?)`,
                [device_sn, cmd, ip, raw, jsonValid, parseError]
            );

            console.log("LOG SAVED:", ip, cmd || "-");

        } catch (dbErr) {
            console.log("DB ERROR:", dbErr.message);
        }

        // ACK so device stops resending
        socket.write("OK");

    });

    socket.on("close", () => console.log("DISCONNECTED:", ip));
    socket.on("error", err => console.log("ERROR:", err.message));

}).listen(PORT);
