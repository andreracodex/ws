const net = require("net");

const PORT = 9001;

console.log("VEGA Push Server listening on", PORT);

const server = net.createServer(socket => {
    const ip = socket.remoteAddress;
    console.log("\n[DEVICE CONNECT]", ip);

    let buffer = "";

    socket.on("data", chunk => {
        buffer += chunk.toString();

        // wait until full HTTP request arrives
        if (!buffer.includes("\r\n\r\n")) return;

        const [header, body] = buffer.split("\r\n\r\n");

        try {
            const json = JSON.parse(body);

            console.log("\n--- LOG RECEIVED ---");
            console.log(JSON.stringify(json, null, 2));

            // save photo if exists
            if (json.logPhoto) {
                require("fs").writeFileSync(
                    `photo_${Date.now()}.jpg`,
                    Buffer.from(json.logPhoto, "base64")
                );
                console.log("Photo saved");
            }

        } catch {
            console.log("Invalid JSON body");
        }

        // send HTTP response (REQUIRED)
        socket.write(
            "HTTP/1.1 200 OK\r\nContent-Length:2\r\n\r\nOK"
        );

        buffer = "";
    });

    socket.on("close", () =>
        console.log("[DISCONNECTED]", ip)
    );

    socket.on("error", err =>
        console.log("[SOCKET ERROR]", err.message)
    );
});

server.listen(PORT);
