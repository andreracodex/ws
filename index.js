const net = require("net");
const fs = require("fs");

const PORT = 9001;

console.log("FULL CAPTURE SERVER listening on", PORT);

const server = net.createServer(socket => {

    const ip = socket.remoteAddress;
    console.log("\nDEVICE CONNECT:", ip);

    let buffer = Buffer.alloc(0);

    socket.on("data", chunk => {

        // append stream
        buffer = Buffer.concat([buffer, chunk]);

        console.log("\nRAW PACKET HEX:");
        console.log(chunk.toString("hex"));

        console.log("RAW PACKET ASCII:");
        console.log(chunk.toString());

        // detect HTTP request
        const text = buffer.toString();
        const headerEnd = text.indexOf("\r\n\r\n");

        if (headerEnd !== -1) {

            const headers = text.slice(0, headerEnd);
            const match = headers.match(/Content-Length:\s*(\d+)/i);

            if (match) {

                const length = parseInt(match[1]);
                const totalSize = headerEnd + 4 + length;

                if (buffer.length < totalSize) return;

                const body = buffer.slice(headerEnd + 4, totalSize).toString();

                console.log("\nHTTP BODY:");
                console.log(body);

                // try JSON decode
                try {
                    const json = JSON.parse(body);

                    console.log("\nDECODED JSON:");
                    console.dir(json, { depth: null });

                    // save image if exists
                    if (json.logPhoto) {
                        const name = `img_${Date.now()}.jpg`;
                        fs.writeFileSync(name, Buffer.from(json.logPhoto, "base64"));
                        console.log("Saved image:", name);
                    }

                } catch {
                    console.log("BODY is not JSON");
                }

                // send ACK response
                socket.write(
                    "HTTP/1.1 200 OK\r\nContent-Length:7\r\n\r\nSUCCESS"
                );

                buffer = Buffer.alloc(0);
            }
        }
    });

    socket.on("close", () => console.log("DISCONNECTED:", ip));
    socket.on("error", err => console.log("ERROR:", err.message));
});

server.listen(PORT);
