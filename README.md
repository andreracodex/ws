# AI Push Server (Protocol 2.4)

WebSocket server for receiving attendance logs and device status from AI-enabled fingerprint/face recognition devices (Camel or Fingerspot AI devices).

## Features

- **Real-time WebSocket communication** with AI attendance devices
- **Device registration & heartbeat monitoring** with connection status tracking
- **Attendance log collection** with face image capture
- **Device information tracking** (capacity, firmware, MAC address, etc.)
- **MySQL database integration** for logs and device status
- **Auto-offline detection** for unresponsive devices
- **Environment-based configuration** via `.env` file

## Requirements

- Node.js 14+
- MySQL 5.7+ / MariaDB 10.2+
- FingerSpot AI device supporting Protocol 2.4

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file in the project root:

```env
# WebSocket Server
WS_PORT=9001

# MySQL Database
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASS=your_password
DB_NAME=test_fingerspot

# Connection Pool
DB_CONN_LIMIT=10

# Device Status
DEVICE_OFFLINE_SECONDS=10
```

## Database Setup

### 1. Create `attendance_logs` table

```sql
CREATE TABLE attendance_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  device_sn VARCHAR(64) NOT NULL,
  enroll_id VARCHAR(64) NOT NULL,
  user_name VARCHAR(128) NULL,
  log_time DATETIME NOT NULL,
  verify_mode INT NULL,
  io_status INT NULL,
  event_code INT NULL,
  temperature DECIMAL(5,2) NULL,
  image_path VARCHAR(255) NULL,
  device_ip VARCHAR(64) NULL,
  raw_json TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_log (device_sn, enroll_id, log_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 2. Create `device_status` table

```sql
CREATE TABLE device_status (
  device_sn VARCHAR(64) NOT NULL,
  last_seen DATETIME NOT NULL,
  is_online TINYINT(1) NOT NULL DEFAULT 0,
  device_ip VARCHAR(64) NULL,
  modelname VARCHAR(32) NULL,
  usersize INT NULL,
  facesize INT NULL,
  fpsize INT NULL,
  cardsize INT NULL,
  pwdsize INT NULL,
  logsize INT NULL,
  useduser INT NULL,
  usedface INT NULL,
  usedfp INT NULL,
  usedcard INT NULL,
  usedpwd INT NULL,
  usedlog INT NULL,
  usednewlog INT NULL,
  usedrtlog INT NULL,
  netinuse TINYINT(1) NULL,
  usb4g TINYINT(1) NULL,
  fpalgo VARCHAR(32) NULL,
  firmware VARCHAR(64) NULL,
  device_time DATETIME NULL,
  intercom TINYINT(1) NULL,
  floors INT NULL,
  charid INT NULL,
  useosdp TINYINT(1) NULL,
  dislanguage INT NULL,
  mac VARCHAR(32) NULL,
  PRIMARY KEY (device_sn)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

## Usage

### Start the server

```bash
npm start
```

Or for development:

```bash
node server.js
```

The server will listen on port `9001` (or your configured `WS_PORT`).

### Configure device

On your FingerSpot AI device:
1. Go to **Communication Settings**
2. Set **Cloud Server** mode
3. Enter server IP and port (e.g., `192.168.1.100:9001`)
4. Enable **Push Protocol 2.4**
5. Save and restart device

## Protocol Documentation

### Device → Server Messages

#### 1. Registration (`reg`)
```json
{
  "cmd": "reg",
  "sn": "AYSH29096497",
  "devinfo": {
    "modelname": "AiFace",
    "firmware": "ai518_f40v_v1.29",
    "mac": "00-01-F5-01-98-B1",
    "usersize": 5000,
    "useduser": 1,
    ...
  }
}
```

#### 2. Heartbeat (`heartbeat`)
```json
{
  "cmd": "heartbeat",
  "sn": "AYSH29096497"
}
```

#### 3. Send Log (`sendlog`)
```json
{
  "cmd": "sendlog",
  "sn": "AYSH29096497",
  "count": 1,
  "logindex": 12345,
  "record": [
    {
      "enrollid": "001",
      "name": "John Doe",
      "time": "2026-02-11 10:30:00",
      "mode": 15,
      "inout": 0,
      "event": 0,
      "temp": "36.5",
      "image": "base64_encoded_jpeg..."
    }
  ]
}
```

### Server → Device Responses

#### Registration ACK
```json
{
  "ret": "reg",
  "result": true,
  "sn": "AYSH29096497",
  "cloudtime": "2026-02-11 10:30:00",
  "nosenduser": true
}
```

#### Heartbeat ACK
```json
{
  "ret": "heartbeat",
  "result": true,
  "sn": "AYSH29096497",
  "cloudtime": "2026-02-11 10:30:00"
}
```

#### Log ACK
```json
{
  "ret": "sendlog",
  "result": true,
  "sn": "AYSH29096497",
  "count": 1,
  "logindex": 12345,
  "cloudtime": "2026-02-11 10:30:00"
}
```

## Features Details

### Connection Status Tracking

- Devices are marked **online** when they connect or send heartbeats/logs
- Devices are marked **offline** when:
  - WebSocket connection closes
  - No heartbeat received within `DEVICE_OFFLINE_SECONDS` (default: 10s)
- Background task runs every 5 seconds to check for stale devices

### Image Storage

Face/fingerprint images from AI devices are:
- Automatically decoded from base64
- Saved to `images/` directory
- Named: `{device_sn}_{enroll_id}_{timestamp}.jpg`
- Path stored in `attendance_logs.image_path`

### Device Information

On registration, the server stores:
- Model name, firmware version, MAC address
- User/face/card/password capacity and usage
- Fingerprint algorithm version
- Network configuration

## Project Structure

```
ws/
├── server.js           # Main WebSocket server
├── package.json        # Dependencies
├── .env               # Configuration (create this)
├── .env.example       # Configuration template
├── images/            # Captured images (auto-created)
└── README.md          # This file
```

## Troubleshooting

### Device not connecting
- Check firewall allows port 9001
- Verify device IP can reach server
- Ensure Protocol 2.4 is enabled on device

### Logs not saving
- Check `attendance_logs` table exists
- Verify database credentials in `.env`
- Check server console for DB errors

### Device shows offline
- Increase `DEVICE_OFFLINE_SECONDS` if network is slow
- Check device heartbeat interval setting
- Verify `device_status` table exists

## License

ISC
