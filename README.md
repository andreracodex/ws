# Fingerspot AI WebSocket Server - Protocol 2.4
## Improvements & Implementation Guide

## Key Improvements Made

### 1. **Protocol 2.4 Compliance**
- ✅ Proper `logindex` handling in sendlog responses
- ✅ Correct acknowledgment format with all required fields
- ✅ Support for QR code protocol (`sendqrcode` command)
- ✅ Enhanced device info tracking (all devinfo fields)
- ✅ Proper handling of AI device features (temperature, images, verifymode)

### 2. **Enhanced Data Validation**
- ✅ Comprehensive command validation (all protocol commands)
- ✅ Better enrollid validation (handles enrollid=0 for system events)
- ✅ Improved time field validation
- ✅ JPEG magic byte validation for images
- ✅ More robust base64 validation

### 3. **Better Database Schema**
- ✅ Added proper indexes for performance
- ✅ Device status table with comprehensive device info
- ✅ Unique constraint on attendance logs to prevent duplicates
- ✅ Better field types and sizes

### 4. **Improved Connection Management**
- ✅ Ping/pong heartbeat mechanism
- ✅ Better connection health monitoring
- ✅ Automatic dead connection cleanup
- ✅ Per-IP connection tracking

### 5. **Better Logging & Debugging**
- ✅ More descriptive console output
- ✅ Better error messages
- ✅ Clearer connection lifecycle tracking
- ✅ Enhanced startup banner

### 6. **Security Enhancements**
- ✅ Better command validation
- ✅ Improved rate limiting
- ✅ Enhanced input sanitization
- ✅ Path traversal prevention

## Implementing Additional Protocol Features

### Server-Initiated Commands

The protocol supports many server-initiated commands. Here's how to implement them:

#### 1. Get User List

```javascript
const getUserList = (ws, stn = true) => {
  ws.send(JSON.stringify({
    cmd: "getuserlist",
    stn: stn
  }));
};

// Handle response in message handler:
if (data.ret === 'getuserlist' && data.result) {
  console.log(`Received ${data.count} users from ${data.from} to ${data.to}`);
  
  // Process users
  data.record.forEach(user => {
    console.log(`User ${user.enrollid}: admin=${user.admin}, backupnum=${user.backupnum}`);
  });
  
  // If more records exist, request next batch
  if (data.to < data.count - 1) {
    getUserList(ws, false);
  }
}
```

#### 2. Get/Set Device Info

```javascript
// Get device configuration
const getDeviceInfo = (ws) => {
  ws.send(JSON.stringify({
    cmd: "getdevinfo",
    sn: deviceSN
  }));
};

// Set device configuration
const setDeviceInfo = (ws, config) => {
  ws.send(JSON.stringify({
    cmd: "setdevinfo",
    sn: deviceSN,
    deviceid: config.deviceid || 1,
    language: config.language || 0, // 0=EN, 1=SC, 2=TC, etc.
    volume: config.volume || 6,     // 0-10
    screensaver: config.screensaver || 0, // 0=off, 1-255 seconds
    verifymode: config.verifymode || 0,
    sleep: config.sleep || 0,
    userfpnum: config.userfpnum || 3
  }));
};
```

#### 3. Download User to Device

```javascript
const downloadUser = (ws, user) => {
  ws.send(JSON.stringify({
    cmd: "setuserinfo",
    sn: deviceSN,
    enrollid: user.enrollid,
    name: user.name,
    backupnum: user.backupnum, // 0-9:FP, 10:PWD, 11:CARD, 50:PHOTO
    admin: user.admin || 0,
    record: user.record // fingerprint template, card number, password, or photo base64
  }));
};

// Example: Download fingerprint
downloadUser(ws, {
  enrollid: 1,
  name: "John Doe",
  backupnum: 0, // First fingerprint
  admin: 0,
  record: "fingerprint_template_data_here"
});

// Example: Download RFID card
downloadUser(ws, {
  enrollid: 1,
  name: "John Doe",
  backupnum: 11, // RFID card
  admin: 0,
  record: "123456789" // Card number
});

// Example: Download photo (AI device)
downloadUser(ws, {
  enrollid: 1,
  name: "John Doe",
  backupnum: 50, // Photo
  admin: 0,
  record: "base64_encoded_jpeg_here"
});
```

#### 4. Access Control (Door Control)

```javascript
// Set access parameters
const setAccessControl = (ws, params) => {
  ws.send(JSON.stringify({
    cmd: "setdevlock",
    sn: deviceSN,
    opendelay: params.opendelay || 5,      // Door open duration (seconds)
    doorsensor: params.doorsensor || 0,    // 0:disable, 1:NC, 2:NO
    alarmdelay: params.alarmdelay || 0,    // Alarm delay (minutes)
    threat: params.threat || 0,            // Threat alarm mode
    antpass: params.antpass || 0,          // Anti-passback
    interlock: params.interlock || 0,      // Interlock mode
    dayzone: params.dayzone || [],         // Time zones (see protocol)
    weekzone: params.weekzone || [],       // Week schedules
    lockgroup: params.lockgroup || []      // Multi-person unlock groups
  }));
};

// Set user access permissions
const setUserAccess = (ws, users) => {
  ws.send(JSON.stringify({
    cmd: "setuserlock",
    sn: deviceSN,
    count: users.length,
    record: users.map(user => ({
      enrollid: user.enrollid,
      weekzone: user.weekzone || 1,
      weekzone2: user.weekzone2 || 1, // For access controllers with multiple doors
      weekzone3: user.weekzone3 || 1,
      weekzone4: user.weekzone4 || 1,
      group: user.group || 0,         // 0-9: group number
      starttime: user.starttime || "2024-01-01 00:00:00",
      endtime: user.endtime || "2099-12-31 23:59:59"
    }))
  }));
};

// Open door remotely
const openDoor = (ws, doornum = 1) => {
  ws.send(JSON.stringify({
    cmd: "opendoor",
    sn: deviceSN,
    doornum: doornum // 1-4 for access controllers, omit for single-door devices
  }));
};
```

#### 5. Log Management

```javascript
// Get new logs
const getNewLogs = (ws, stn = true) => {
  ws.send(JSON.stringify({
    cmd: "getnewlog",
    sn: deviceSN,
    stn: stn
  }));
};

// Get all logs with date filter
const getAllLogs = (ws, fromDate, toDate, stn = true) => {
  ws.send(JSON.stringify({
    cmd: "getalllog",
    sn: deviceSN,
    stn: stn,
    from: fromDate || "2024-01-01",
    to: toDate || "2024-12-31"
  }));
};

// Clear all logs
const clearLogs = (ws) => {
  ws.send(JSON.stringify({
    cmd: "cleanlog",
    sn: deviceSN
  }));
};
```

#### 6. Device Management

```javascript
// Sync device time
const syncTime = (ws) => {
  ws.send(JSON.stringify({
    cmd: "settime",
    sn: deviceSN,
    cloudtime: new Date().toISOString().slice(0, 19).replace('T', ' ')
  }));
};

// Get device time
const getTime = (ws) => {
  ws.send(JSON.stringify({
    cmd: "gettime",
    sn: deviceSN
  }));
};

// Reboot device
const rebootDevice = (ws) => {
  ws.send(JSON.stringify({
    cmd: "reboot",
    sn: deviceSN
  }));
};

// Initialize device (DANGEROUS - wipes all data)
const initDevice = (ws) => {
  ws.send(JSON.stringify({
    cmd: "initsys",
    sn: deviceSN
  }));
};
```

#### 7. Advanced Features (AI Devices)

```javascript
// Set questionnaire (for event selection on device)
const setQuestionnaire = (ws, config) => {
  ws.send(JSON.stringify({
    cmd: "setquestionnaire",
    sn: deviceSN,
    title: config.title || "Select Event",
    voice: config.voice || "Please select",
    errmsg: config.errmsg || "Please make a selection",
    radio: config.radio !== false, // true=single choice, false=multiple
    optionflag: config.optionflag || 0,
    usequestion: config.usequestion !== false,
    useschedule: config.useschedule !== false,
    card: config.card || 0,
    items: config.items || ["In", "Out", "Break", "Meeting"],
    schedules: config.schedules || [
      "00:01-11:12*1",
      "11:30-12:30*3",
      "13:00-19:00*4",
      "00:00-00:00*0",
      "00:00-00:00*0",
      "00:00-00:00*0",
      "00:00-00:00*0",
      "00:00-00:00*0"
    ]
  }));
};

// Set holiday schedule
const setHolidays = (ws, holidays) => {
  ws.send(JSON.stringify({
    cmd: "setholiday",
    sn: deviceSN,
    holidays: holidays.map(h => ({
      name: h.name,
      startday: h.startday,  // "MM-DD" format
      endday: h.endday,      // "MM-DD" format
      shift: h.shift || 0,
      dayzone: h.dayzone || 0
    }))
  }));
};

// Example holidays
setHolidays(ws, [
  { name: "New Year", startday: "01-01", endday: "01-01" },
  { name: "Christmas", startday: "12-25", endday: "12-25" },
  { name: "Summer Break", startday: "07-01", endday: "07-15" }
]);
```

## Extending the Handler System

Add more handlers to the switch statement:

```javascript
// In the message handler, add:
case 'getuserlist':
case 'getuserinfo':
case 'getnewlog':
case 'getalllog':
  // These are responses from device
  response = await handleDeviceResponse(ws, data, ip);
  break;

// Implement handler:
const handleDeviceResponse = async (ws, data, ip) => {
  console.log(`[RESPONSE] ${data.ret} from ${data.sn || 'unknown'}`);
  
  // Process based on response type
  if (data.ret === 'getuserlist' && data.result) {
    // Store users in database or process them
    console.log(`Received ${data.count} users`);
    // ... handle users
  }
  
  // Don't send a response back - this was a response
  return null;
};
```

## Integration Example: Web Dashboard

```javascript
// Express.js example for web dashboard
const express = require('express');
const app = express();

// Store WebSocket connections by device SN
const deviceConnections = new Map();

wss.on('connection', (ws, req) => {
  // ... existing code ...
  
  ws.on('message', async (message) => {
    // ... existing code ...
    
    // Store connection after registration
    if (data.cmd === 'reg' && data.sn) {
      deviceConnections.set(data.sn, ws);
      console.log(`Device ${data.sn} registered`);
    }
  });
  
  ws.on('close', () => {
    // Remove from map
    if (currentSn) {
      deviceConnections.delete(currentSn);
    }
  });
});

// API endpoint to send command to device
app.post('/api/device/:sn/command', (req, res) => {
  const { sn } = req.params;
  const ws = deviceConnections.get(sn);
  
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ error: 'Device not connected' });
  }
  
  // Send command
  ws.send(JSON.stringify(req.body));
  res.json({ success: true });
});

// Open door via API
app.post('/api/device/:sn/opendoor', (req, res) => {
  const { sn } = req.params;
  const ws = deviceConnections.get(sn);
  
  if (!ws) {
    return res.status(404).json({ error: 'Device not connected' });
  }
  
  openDoor(ws, req.body.doornum);
  res.json({ success: true, message: 'Door open command sent' });
});

app.listen(3000, () => console.log('API listening on port 3000'));
```

## Testing Commands

```bash
# Using wscat to test commands
npm install -g wscat

# Connect to server
wscat -c ws://localhost:9001

# Send registration
{"cmd":"reg","sn":"TEST123","devinfo":{"modelname":"TEST-MODEL","firmware":"v1.0"}}

# Send heartbeat
{"cmd":"heartbeat","sn":"TEST123"}

# Send log
{"cmd":"sendlog","sn":"TEST123","count":1,"logindex":1,"record":[{"enrollid":"1","time":"2024-02-12 10:30:00","mode":0,"inout":0,"event":0}]}
```

## Environment Variables

```bash
# .env file
WS_PORT=9001
DB_HOST=127.0.0.1
DB_USER=root
DB_PASS=your_password
DB_NAME=fingerspot_db
DB_PORT=3306
DB_CONN_LIMIT=10

DEVICE_OFFLINE_SECONDS=30
MAX_MESSAGE_SIZE=10485760
MAX_IMAGE_SIZE=5242880
MAX_CONNECTIONS_PER_IP=10
RATE_LIMIT_MAX=100
CONNECTION_TIMEOUT=300000

# Optional authentication
DEVICE_AUTH_TOKEN=your_secret_token_here
```

## Production Deployment

### Using PM2

```bash
# Install PM2
npm install -g pm2

# Start server
pm2 start websocket-server-improved.js --name fingerspot-ws

# Monitor
pm2 monit

# View logs
pm2 logs fingerspot-ws

# Restart
pm2 restart fingerspot-ws

# Auto-start on boot
pm2 startup
pm2 save
```

### Using Docker

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

EXPOSE 9001

CMD ["node", "websocket-server-improved.js"]
```

```bash
# Build and run
docker build -t fingerspot-ws .
docker run -d -p 9001:9001 --env-file .env fingerspot-ws
```

## Performance Optimization

### Database Indexes
```sql
-- Add these indexes for better performance
CREATE INDEX idx_attendance_device_date ON attendance_logs(device_sn, log_time);
CREATE INDEX idx_attendance_user_date ON attendance_logs(enroll_id, log_time);
CREATE INDEX idx_device_status_online ON device_status(is_online, last_seen);
```

### Connection Pooling
```javascript
// Increase pool size for high-traffic deployments
const db = mysql.createPool({
  // ... other config
  connectionLimit: 50, // Increase from default 10
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});
```

## Troubleshooting

### HTTP API Authorization
The HTTP API endpoints require a Bearer token in the `Authorization` header.

Set your custom token text with environment variable:

```bash
API_BEARER_TOKEN=your-custom-text
```

Request example:

```bash
curl "http://localhost:9002/api/attendance_logs?limit=10&offset=0&deviceSn=DEVICE_SN_HERE" \
  -H "Authorization: Bearer your-custom-text" \
  -H "Accept: application/json"
```

Add user example:

```bash
curl -X POST "http://localhost:9002/api/adduser" \
  -H "Authorization: Bearer your-custom-text" \
  -H "Content-Type: application/json" \
  -d '{"enrollid":1001,"userName":"John Doe","deviceSn":"DEVICE_SN_HERE","backupNum":11,"admin":0,"record":"1234567890"}'
```

Add user with password (backupNum=10 for password mode):

```bash
curl -X POST "http://localhost:9002/api/adduser" \
  -H "Authorization: Bearer your-custom-text" \
  -H "Content-Type: application/json" \
  -d '{"enrollid":1002,"userName":"Jane Smith","deviceSn":"DEVICE_SN_HERE","backupNum":10,"admin":0,"record":"Pwd@1234"}'
```

Add user with picture (backupNum=50 for photo mode, requires base64-encoded JPEG):

```bash
curl -X POST "http://localhost:9002/api/adduser" \
  -H "Authorization: Bearer your-custom-text" \
  -H "Content-Type: application/json" \
  -d '{"enrollid":1003,"userName":"Photo User","deviceSn":"DEVICE_SN_HERE","backupNum":50,"admin":0,"image":"data:image/jpeg;base64,[BASE64_JPEG_HERE]"}'
```

Delete user by enrollid:

```bash
curl -X DELETE "http://localhost:9002/api/deleteuser?enrollid=1001&deviceSn=DEVICE_SN_HERE" \
  -H "Authorization: Bearer your-custom-text"
```

If `deviceSn` is omitted, the API will try to resolve it from the `api_users` table.

**Backup Number Reference:**
- `0-9`: Fingerprint templates
- `10`: Password (1-32 characters, alphanumeric and `!@#$%^&*_-+=`)
- `11`: RFID card number
- `50`: Photo (base64 encoded JPEG)

### Device Not Connecting
1. Check firewall rules (allow port 9001)
2. Verify device network configuration
3. Check authentication token if enabled
4. Review server logs for rejection reason

### Logs Not Saving
1. Check database connection
2. Verify table exists (`attendance_logs`)
3. Check for unique constraint violations
4. Review error logs

### Images Not Saving
1. Check `images` directory permissions
2. Verify MAX_IMAGE_SIZE setting
3. Check base64 validation errors
4. Review image format (must be JPEG)

## Protocol Reference

See the PDF documentation for complete protocol details:
- Command structures
- Response formats
- Error codes
- Data types
- Backup number meanings (0-9: FP, 10: PWD, 11: CARD, 50: PHOTO)

## License

ISC

## Support

For protocol questions, refer to the official Fingerspot WebSocket JSON Protocol 2.4 documentation.