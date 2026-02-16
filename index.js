const net = require("net");

const PORT = 9001;

console.log("VEGA Push Server listening on", PORT);

const server = net.createServer(socket => {
    console.log("CONNECT:", socket.remoteAddress);

    let buffer = Buffer.alloc(0);
    let contentLength = null;

    socket.on("data", chunk => {
        buffer = Buffer.concat([buffer, chunk]);

        const str = buffer.toString();

        // read headers first
        if (contentLength === null) {
            const headerEnd = str.indexOf("\r\n\r\n");
            if (headerEnd === -1) return;

            const headers = str.slice(0, headerEnd);
            const match = headers.match(/Content-Length:\s*(\d+)/i);
            if (match) {
                contentLength = parseInt(match[1]);
            } else {
                contentLength = 0;
            }
        }

        const headerEnd = str.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const bodyStart = headerEnd + 4;
        const totalNeeded = bodyStart + contentLength;

        if (buffer.length < totalNeeded) return;

        const body = buffer.slice(bodyStart, totalNeeded).toString();

        try {
            const json = JSON.parse(body);

            console.log("\nLOG RECEIVED:");
            console.log(json);

            if (json.logPhoto) {
                require("fs").writeFileSync(
                    `photo_${Date.now()}.jpg`,
                    Buffer.from(json.logPhoto, "base64")
                );
                console.log("Photo saved");
            }

        } catch (err) {
            console.log("JSON parse error");
        }

        socket.write("HTTP/1.1 200 OK\r\nContent-Length:2\r\n\r\nOK");

        buffer = Buffer.alloc(0);
        contentLength = null;
    });

    socket.on("close", () => console.log("DISCONNECTED"));
    socket.on("error", err => console.log("ERROR", err.message));
});

server.listen(PORT);
