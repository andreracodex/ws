// const net = require("net");
// const dayjs = require("dayjs");

// const PORT = 9001;

// console.log("VEGA Push Server listening on", PORT);

// /* ---------------- Packet Parser ---------------- */

// function parsePacket(buffer) {
//     const hex = buffer.toString("hex");

//     // device heartbeat packet
//     if (hex.startsWith("504b")) {
//         return {
//             type: "heartbeat",
//             raw: hex
//         };
//     }

//     // log packet
//     if (buffer.length > 32) {
//         try {
//             const text = buffer.toString("utf8").replace(/\0/g, "");
//             const parts = text.split(",");

//             if (parts.length >= 5) {
//                 return {
//                     type: "log",
//                     user_id: parts[0],
//                     timestamp: parts[1],
//                     verify_mode: parts[2],
//                     io_mode: parts[3],
//                     work_code: parts[4],
//                     raw: text
//                 };
//             }
//         } catch (e) {}
//     }

//     return {
//         type: "unknown",
//         raw: hex
//     };
// }

// /* ---------------- TCP Server ---------------- */

// const server = net.createServer(socket => {
//     const ip = socket.remoteAddress;
//     console.log("\n[DEVICE CONNECT]", ip);

//     socket.on("data", data => {
//         const parsed = parsePacket(data);

//         console.log("\n--- PACKET RECEIVED ---");
//         console.log(JSON.stringify(parsed, null, 2));

//         // send ACK (required or device resends)
//         socket.write(Buffer.from("ACK"));
//     });

//     socket.on("close", () => {
//         console.log("[DISCONNECTED]", ip);
//     });

//     socket.on("error", err => {
//         console.log("[SOCKET ERROR]", err.message);
//     });
// });

// server.listen(PORT);


const net = require("net");

const PORT = 9001;

const server = net.createServer(socket => {
    console.log("DEVICE CONNECT:", socket.remoteAddress);

    let buffer = "";

    socket.on("data", data => {
        buffer += data.toString();

        // HTTP request ends with double CRLF + body
        if (buffer.includes("\r\n\r\n")) {
            const [header, body] = buffer.split("\r\n\r\n");

            try {
                const json = JSON.parse(body);

                console.log("\n=== LOG RECEIVED ===");
                console.log(JSON.stringify(json, null, 2));

                if (json.logPhoto) {
                    require("fs").writeFileSync(
                        "photo.jpg",
                        Buffer.from(json.logPhoto, "base64")
                    );
                    console.log("Photo saved");
                }

            } catch (err) {
                console.log("Parse JSON failed");
            }

            // HTTP response REQUIRED
            socket.write(
                "HTTP/1.1 200 OK\r\nContent-Length:2\r\n\r\nOK"
            );

            buffer = "";
        }
    });

    socket.on("close", () => console.log("DISCONNECT"));
    socket.on("error", err => console.log("ERROR", err.message));
});

server.listen(PORT, () =>
    console.log("VEGA HTTP Push Server running on", PORT)
);
