const express = require("express");
const mysql = require("mysql2/promise");

const app = express();
app.use(express.json());

const db = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "test_fingerspot",
});

const TARGET_USERS = ["15"];

/* ================= WEBHOOK ================= */

app.post("/device-webhook", async (req,res)=>{

  const body = req.body;

  if(body.type !== "attlog"){
    return res.sendStatus(200);
  }

  const sn   = body.cloud_id;
  const user = body.data?.pin;
  const time = body.data?.scan;
  const verify = body.data?.verify;
  const status = body.data?.status_scan;

  console.log("WEBHOOK:",sn,user,time);

  if(!user || !TARGET_USERS.includes(user)){
    return res.sendStatus(200);
  }

  try{
    await db.execute(
      `INSERT INTO device_logs
       (device_sn,user_id,event_time,event_mode,raw,is_json_valid)
       VALUES (?,?,?,?,?,1)`,
      [sn,user,time,verify,JSON.stringify(body)]
    );

    console.log("SAVED USER:",user);

  }catch(e){
    console.log("DB ERROR:",e.message);
  }

  res.sendStatus(200);
});

/* ================= START ================= */

app.listen(9001,()=>console.log("Webhook listening 9001"));
