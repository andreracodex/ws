const net = require("net");

const PORT = 9001;

/* ---------- COMMAND TEST LIST ---------- */
const commands = [
  "get_info",
  "get_time",
  "get_config",
  "get_user",
  "get_log",
  "get_new_log",
  "unlock",
  "lock",
  "beep",
  "restart",
  "clear_log",
  "clear_user"
];

let deviceState = {}; // per device progress


console.log("AUTO DETECT SERVER RUNNING:", PORT);

net.createServer(socket => {

  const ip = socket.remoteAddress.replace("::ffff:", "");
  console.log("CONNECT:", ip);

  let buffer = Buffer.alloc(0);

  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);

    const text = buffer.toString();

    if (!text.includes("\r\n\r\n")) return;

    handlePacket(text, socket, ip);
    buffer = Buffer.alloc(0);
  });

  socket.on("close", () => console.log("DISCONNECTED:", ip));
  socket.on("error", err => console.log("ERROR:", err.message));

}).listen(PORT);



/* ---------- PACKET PROCESSOR ---------- */

function handlePacket(raw, socket, ip) {

  const snMatch = raw.match(/dev_id:\s*(.+)/i);
  const cmdMatch = raw.match(/request_code:\s*(.+)/i);

  const sn = snMatch ? snMatch[1].trim() : ip;
  const req = cmdMatch ? cmdMatch[1].trim() : null;

  if (!deviceState[sn]) {
    deviceState[sn] = {
      index: 0,
      supported: [],
      rejected: []
    };
  }

  const state = deviceState[sn];

  console.log("\nDEVICE:", sn);
  console.log("REQUEST:", req);

  /* ---------- ONLY RESPOND TO COMMAND POLL ---------- */
  if (req === "receive_cmd") {

    if (state.index >= commands.length) {
      console.log("FINISHED TEST:", sn);
      console.log("SUPPORTED:", state.supported);
      console.log("REJECTED:", state.rejected);
      socket.write("cmd=none\n");
      return;
    }

    const testCmd = commands[state.index];

    console.log("TESTING:", testCmd);

    socket.write(`cmd=${testCmd}\n`);
    state.last = testCmd;
    state.index++;
    return;
  }

  /* ---------- DEVICE RESPONSE ---------- */
  if (state.last) {

    if (raw.length > 50) {
      console.log("SUPPORTED:", state.last);
      state.supported.push(state.last);
    } else {
      console.log("REJECTED:", state.last);
      state.rejected.push(state.last);
    }

    state.last = null;
  }

  socket.write("OK");
}
