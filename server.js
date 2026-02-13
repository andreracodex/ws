// zk_server_simple.js
const net = require('net');
const dgram = require('dgram');

// Configuration
const TCP_PORT = 5005;  // Main PUSH port
const UDP_PORT = 9001;  // Alternative PUSH port
const HOST = '0.0.0.0'; // Listen on all interfaces

// TCP Server (Port 5005)
const tcpServer = net.createServer((socket) => {
    const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`\n🔌 TCP Client connected: ${clientAddress}`);
    
    let dataBuffer = Buffer.alloc(0);
    
    socket.on('data', (data) => {
        dataBuffer = Buffer.concat([dataBuffer, data]);
        
        // Process complete packets
        while (dataBuffer.length >= 16) { // Minimum packet size
            const packetLength = dataBuffer.readUInt16LE(0); // First 2 bytes = packet length
            
            if (dataBuffer.length >= packetLength) {
                const packet = dataBuffer.slice(0, packetLength);
                dataBuffer = dataBuffer.slice(packetLength);
                
                processZKPacket(packet, clientAddress, 'TCP');
            } else {
                break; // Wait for more data
            }
        }
    });
    
    socket.on('end', () => {
        console.log(`🔌 TCP Client disconnected: ${clientAddress}`);
    });
    
    socket.on('error', (err) => {
        console.error(`❌ Socket error: ${err.message}`);
    });
});

// UDP Server (Port 9001)
const udpServer = dgram.createSocket('udp4');

udpServer.on('message', (msg, rinfo) => {
    console.log(`\n📦 UDP Packet from ${rinfo.address}:${rinfo.port}`);
    processZKPacket(msg, `${rinfo.address}:${rinfo.port}`, 'UDP');
});

udpServer.on('listening', () => {
    const address = udpServer.address();
    console.log(`📡 UDP Server listening on ${address.address}:${address.port}`);
});

udpServer.on('error', (err) => {
    console.error(`❌ UDP error: ${err.message}`);
});

// Packet Processor
function processZKPacket(packet, source, protocol) {
    console.log(`\n📨 Received ${protocol} packet from ${source}`);
    console.log(`📏 Size: ${packet.length} bytes`);
    console.log(`🔢 Hex: ${packet.toString('hex').toUpperCase()}`);
    console.log(`📝 ASCII: ${packet.toString('ascii').replace(/[^\x20-\x7E]/g, '.')}`);
    
    // Check if it's a ZKTeco PUSH packet
    if (packet.length >= 8) {
        const machineId = packet.readUInt16LE(4); // Usually at offset 4-5
        
        // Check for attendance record (common pattern)
        if (packet.includes('ATTLOG') || packet.includes('ATT\_LOG')) {
            console.log('✅ This is an ATTENDANCE RECORD packet');
            parseAttendanceRecord(packet);
        }
        // Check for user data
        else if (packet.includes('USER') || packet.includes('USERINFO')) {
            console.log('👤 This is USER DATA packet');
            parseUserData(packet);
        }
        // Check for heartbeat/keepalive
        else if (packet.length < 20) {
            console.log('💓 Heartbeat/Keepalive packet');
            
            // Send acknowledgment
            sendAcknowledgment(packet, source, protocol);
        }
        else {
            console.log('❓ Unknown packet type');
        }
    }
    
    // Save raw packet to file for debugging
    savePacketToFile(packet, source, protocol);
}

// Parse Attendance Record
function parseAttendanceRecord(packet) {
    try {
        const record = {
            timestamp: new Date().toISOString(),
            machineId: packet.readUInt16LE(4),
            userId: extractUserId(packet),
            fingerprintId: extractFingerprintId(packet),
            verifyMode: extractVerifyMode(packet),
            inOutMode: extractInOutMode(packet),
            rawHex: packet.toString('hex').toUpperCase()
        };
        
        console.log('📋 Attendance Record:', JSON.stringify(record, null, 2));
        
        // Save to database or file
        saveAttendanceRecord(record);
        
    } catch (err) {
        console.error('Error parsing attendance record:', err.message);
    }
}

// Extract User ID from packet
function extractUserId(packet) {
    // Try different offsets where user ID might be
    let userId = '';
    
    // Method 1: ASCII string after specific marker
    const userIdMatch = packet.toString('ascii').match(/USER[ID]*[=:]*(\d+)/i);
    if (userIdMatch) return userIdMatch[1];
    
    // Method 2: Fixed offset (common in ZKTeco)
    if (packet.length > 24) {
        userId = packet.slice(16, 24).toString('ascii').replace(/\0/g, '');
    }
    
    return userId || 'unknown';
}

// Extract fingerprint/face ID
function extractFingerprintId(packet) {
    const fpMatch = packet.toString('ascii').match(/FP[=:](\d+)|FINGER[=:](\d+)/i);
    return fpMatch ? (fpMatch[1] || fpMatch[2]) : '0';
}

// Extract verification mode
function extractVerifyMode(packet) {
    // 1=Password, 2=RFID, 3=Fingerprint, 4=Face, 15=Palm Vein, etc.
    const verifyMatch = packet.toString('ascii').match(/VERIFY[=:](\d+)|MODE[=:](\d+)/i);
    if (verifyMatch) {
        const mode = parseInt(verifyMatch[1] || verifyMatch[2]);
        const modes = {
            1: 'Password',
            2: 'RFID Card',
            3: 'Fingerprint',
            4: 'Face',
            15: 'Palm Vein'
        };
        return { code: mode, name: modes[mode] || 'Unknown' };
    }
    return { code: 0, name: 'Unknown' };
}

// Extract In/Out mode
function extractInOutMode(packet) {
    const ioMatch = packet.toString('ascii').match(/INOUT[=:](\d+)|IO[=:](\d+)/i);
    if (ioMatch) {
        const mode = parseInt(ioMatch[1] || ioMatch[2]);
        const modes = {
            0: 'Check-in',
            1: 'Check-out',
            2: 'Break-out',
            3: 'Break-in',
            4: 'OT-in',
            5: 'OT-out'
        };
        return { code: mode, name: modes[mode] || 'Unknown' };
    }
    return { code: 0, name: 'Check-in' };
}

// Parse User Data
function parseUserData(packet) {
    try {
        const userData = {
            timestamp: new Date().toISOString(),
            machineId: packet.readUInt16LE(4),
            userId: extractUserId(packet),
            name: extractUserName(packet),
            privilege: extractPrivilege(packet),
            password: extractPassword(packet),
            cardNo: extractCardNumber(packet)
        };
        
        console.log('👤 User Data:', JSON.stringify(userData, null, 2));
        
        // Save to database or file
        saveUserData(userData);
        
    } catch (err) {
        console.error('Error parsing user data:', err.message);
    }
}

// Extract user name
function extractUserName(packet) {
    const nameMatch = packet.toString('ascii').match(/NAME[=:]?([A-Za-z0-9\s]+)/i);
    if (nameMatch) return nameMatch[1].trim();
    
    // Try fixed offset
    const nameStr = packet.slice(32, 64).toString('ascii').replace(/\0/g, '');
    return nameStr.trim() || 'unknown';
}

// Extract user privilege (0=User, 1=Admin, 2=Super Admin)
function extractPrivilege(packet) {
    const privMatch = packet.toString('ascii').match(/PRIV[=:](\d+)|ROLE[=:](\d+)/i);
    if (privMatch) {
        const priv = parseInt(privMatch[1] || privMatch[2]);
        const privileges = {
            0: 'User',
            1: 'Administrator',
            2: 'Super Administrator'
        };
        return { code: priv, name: privileges[priv] || 'Unknown' };
    }
    return { code: 0, name: 'User' };
}

// Extract password
function extractPassword(packet) {
    const pwdMatch = packet.toString('ascii').match(/PWD[=:](\d+)|PASSWORD[=:](\d+)/i);
    return pwdMatch ? pwdMatch[1] : '';
}

// Extract card number
function extractCardNumber(packet) {
    const cardMatch = packet.toString('ascii').match(/CARD[=:](\d+)|RFID[=:](\d+)/i);
    return cardMatch ? cardMatch[1] : '';
}

// Send acknowledgment to device
function sendAcknowledgment(packet, source, protocol) {
    try {
        const [host, port] = source.split(':');
        
        // Create acknowledgment packet
        const ack = Buffer.alloc(16);
        packet.copy(ack, 0, 0, 16); // Echo back first 16 bytes
        
        if (protocol === 'TCP') {
            // TCP acknowledgment handled automatically by socket
        } else if (protocol === 'UDP') {
            udpServer.send(ack, 0, ack.length, parseInt(port), host, (err) => {
                if (err) console.error('Failed to send UDP ACK:', err.message);
                else console.log('✅ Sent UDP acknowledgment');
            });
        }
    } catch (err) {
        console.error('Error sending acknowledgment:', err.message);
    }
}

// Save attendance record to file (JSON)
const fs = require('fs');

function saveAttendanceRecord(record) {
    const filename = `attendance_${new Date().toISOString().split('T')[0]}.json`;
    let records = [];
    
    try {
        if (fs.existsSync(filename)) {
            const data = fs.readFileSync(filename, 'utf8');
            records = JSON.parse(data);
        }
    } catch (err) {
        // File doesn't exist or invalid JSON
    }
    
    records.push(record);
    
    fs.writeFileSync(filename, JSON.stringify(records, null, 2));
    console.log(`💾 Saved attendance record to ${filename}`);
}

// Save user data to file
function saveUserData(userData) {
    const filename = `users_${new Date().toISOString().split('T')[0]}.json`;
    let users = [];
    
    try {
        if (fs.existsSync(filename)) {
            const data = fs.readFileSync(filename, 'utf8');
            users = JSON.parse(data);
        }
    } catch (err) {
        // File doesn't exist or invalid JSON
    }
    
    // Update or add user
    const existingIndex = users.findIndex(u => u.userId === userData.userId);
    if (existingIndex >= 0) {
        users[existingIndex] = { ...users[existingIndex], ...userData };
    } else {
        users.push(userData);
    }
    
    fs.writeFileSync(filename, JSON.stringify(users, null, 2));
    console.log(`💾 Saved user data to ${filename}`);
}

// Save raw packet for debugging
function savePacketToFile(packet, source, protocol) {
    const debugFile = 'zk_packets_debug.log';
    const logEntry = `[${new Date().toISOString()}] ${protocol} from ${source}\nHex: ${packet.toString('hex').toUpperCase()}\nASCII: ${packet.toString('ascii').replace(/[^\x20-\x7E]/g, '.')}\n${'='.repeat(80)}\n`;
    
    fs.appendFileSync(debugFile, logEntry);
}

// Start servers
tcpServer.listen(TCP_PORT, HOST, () => {
    console.log(`🚀 TCP Server listening on port ${TCP_PORT}`);
    console.log(`📋 Waiting for ZKTeco device data...`);
});

udpServer.bind(UDP_PORT, HOST);

// Handle process termination
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down servers...');
    tcpServer.close();
    udpServer.close();
    process.exit();
});

console.log(`
╔══════════════════════════════════════════════════════════════╗
║     ZKTeco PUSH Protocol Receiver for Vega W-2431M          ║
╠══════════════════════════════════════════════════════════════╣
║  TCP Port: ${TCP_PORT}                                             ║
║  UDP Port: ${UDP_PORT}                                             ║
║  Mode: Receive attendance data from your device             ║
║                                                              ║
║  Configure your Vega device to point to THIS server:        ║
║  Server: YOUR_SERVER_IP                                     ║
║  Port: ${TCP_PORT} or ${UDP_PORT}                                          ║
╚══════════════════════════════════════════════════════════════╝
`);