const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:9002';
const API_TOKEN = process.env.API_BEARER_TOKEN || 'ARmiXDvuTcZBkaTMtfoGUNcRFTAAjuIZ';

const request = async (path, method, body) => {
  const requestOptions = {
    method,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`
    }
  };

  if (body && method !== 'GET') {
    requestOptions.headers['Content-Type'] = 'application/json';
    requestOptions.body = JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, requestOptions);

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    data: json
  };
};

const getAttendanceLogs = async () => {
  const query = new URLSearchParams({
    limit: 10,
    offset: 0,
    deviceSn: 'DEVICE_SN_HERE',
    fromTime: '2026-02-01 00:00:00',
    toTime: '2026-02-24 23:59:59'
  });

  return await request(`/api/attendance_logs?${query.toString()}`, 'GET');
};

const addUserToDevice = async () => {
  return await request('/api/adduser', 'POST', {
    enrollid: 1001,
    userName: 'John Doe',
    deviceSn: 'DEVICE_SN_HERE',
    backupNum: 11,
    admin: 0,
    record: '1234567890'
  });
};

const addUserWithPassword = async () => {
  return await request('/api/adduser', 'POST', {
    enrollid: 1002,
    userName: 'Jane Smith',
    deviceSn: 'DEVICE_SN_HERE',
    backupNum: 10,  // 10 = password mode
    admin: 0,
    record: 'Pwd@1234'  // Password: 1-32 characters, alphanumeric and !@#$%^&*_-+=
  });
};

const addUserWithPicture = async () => {
  // Example base64-encoded JPEG image (minimal valid JPEG - 1x1 pixel for demo)
  const sampleJpegBase64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDA' +
    'AgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQ' +
    'kJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wA' +
    'ARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8VAFQEBA' +
    'QAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA8A/9k=';

  return await request('/api/adduser', 'POST', {
    enrollid: 1003,
    userName: 'Photo User',
    deviceSn: 'DEVICE_SN_HERE',
    backupNum: 50,  // 50 = photo mode
    admin: 0,
    image: `data:image/jpeg;base64,${sampleJpegBase64}`  // Can also use 'record' field instead of 'image'
  });
};

const main = async () => {
  try {
    const attendanceResult = await getAttendanceLogs();
    console.log('Attendance logs result:', attendanceResult);

    const addUserResult = await addUserToDevice();
    console.log('Add user result:', addUserResult);

    const addUserPasswordResult = await addUserWithPassword();
    console.log('Add user with password result:', addUserPasswordResult);

    const addUserPictureResult = await addUserWithPicture();
    console.log('Add user with picture result:', addUserPictureResult);
  } catch (err) {
    console.error('API example failed:', err.message);
    process.exitCode = 1;
  }
};

main();
