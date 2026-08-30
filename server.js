const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const pino = require("pino");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = 100 * 1024 * 1024;

const UPLOAD_DIR = path.join(__dirname, "uploads");
const OUTPUT_DIR = path.join(__dirname, "processed");
const AUTH_DIR = path.join(__dirname, "auth");

for (const dir of [UPLOAD_DIR, OUTPUT_DIR, AUTH_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: MAX_FILE_SIZE
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "video/mp4",
      "video/quicktime",
      "video/x-matroska",
      "video/webm"
    ];

    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Format video tidak didukung."));
    }

    cb(null, true);
  }
});

const jobs = new Map();

let sock = null;
let pairingNumber = null;
let pairingCode = null;
let whatsappReady = false;

function cleanNumber(number) {
  return String(number || "")
    .replace(/\D/g, "")
    .replace(/^0+/, "");
}

function jidFromNumber(number) {
  return `${cleanNumber(number)}@s.whatsapp.net`;
}

async function startWhatsApp() {
  const { state, saveCreds } =
    await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      whatsappReady = true;
      pairingCode = null;

      console.log("WhatsApp berhasil terhubung.");
    }

    if (connection === "close") {
      whatsappReady = false;

      const code =
        lastDisconnect?.error?.output?.statusCode;

      if (code !== DisconnectReason.loggedOut) {
        setTimeout(startWhatsApp, 5000);
      }
    }
  });
}

async function generatePairingCode(number) {
  if (!sock) {
    throw new Error("WhatsApp belum siap.");
  }

  const clean = cleanNumber(number);

  if (!clean) {
    throw new Error("Nomor WhatsApp tidak valid.");
  }

  if (clean.length < 10) {
    throw new Error("Nomor WhatsApp terlalu pendek.");
  }

  pairingNumber = clean;

  pairingCode = await sock.requestPairingCode(clean);

  return pairingCode;
}

function getVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file
    ]);

    let output = "";

    ffprobe.stdout.on("data", data => {
      output += data.toString();
    });

    ffprobe.on("close", code => {
      if (code !== 0) {
        return reject(new Error("Gagal membaca durasi video."));
      }

      const duration = Number.parseFloat(output);

      if (!duration || !Number.isFinite(duration)) {
        return reject(new Error("Durasi video tidak valid."));
      }

      resolve(duration);
    });
  });
}

async function processVideo(input, output, jobId) {
  const duration = await getVideoDuration(input);

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-i",
      input,

      "-vf",
      "scale=-2:1080:force_original_aspect_ratio=decrease,unsharp=5:5:0.7:5:5:0",

      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",

      "-c:a",
      "aac",
      "-b:a",
      "192k",

      "-movflags",
      "+faststart",

      output
    ]);

    ffmpeg.stderr.on("data", data => {
      const text = data.toString();

      const match = text.match(
        /time=(\d+):(\d+):(\d+(?:\.\d+)?)/
      );

      if (match) {
        const hours = Number(match[1]);
        const minutes = Number(match[2]);
        const seconds = Number(match[3]);

        const current =
          hours * 3600 +
          minutes * 60 +
          seconds;

        let progress =
          Math.round((current / duration) * 100);

        progress = Math.max(
          0,
          Math.min(99, progress)
        );

        const job = jobs.get(jobId);

        if (job) {
          job.progress = progress;
          job.status = "processing";
        }
      }
    });

    ffmpeg.on("close", code => {
      if (code === 0) {
        const job = jobs.get(jobId);

        if (job) {
          job.progress = 100;
          job.status = "processed";
        }

        resolve();
      } else {
        reject(
          new Error("FFmpeg gagal memproses video.")
        );
      }
    });

    ffmpeg.on("error", reject);
  });
}

async function sendToWhatsApp(file, number) {
  if (!sock || !whatsappReady) {
    throw new Error(
      "Bot WhatsApp belum terhubung."
    );
  }

  const jid = jidFromNumber(number);

  await sock.sendMessage(jid, {
    document: fs.readFileSync(file),
    mimetype: "video/mp4",
    fileName: "Dianz-Clean-HD.mp4",
    caption: "🎬 SUKSES HD BY YANZ ✨"
  });
}

/*
|--------------------------------------------------------------------------
| STATUS
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.json({
    app: "Dianz Clean",
    developer: "Yanz Storu",
    status: "online"
  });
});

app.get("/api/whatsapp/status", (req, res) => {
  res.json({
    connected: whatsappReady,
    pairingNumber,
    pairingCode
  });
});

/*
|--------------------------------------------------------------------------
| PAIRING CODE
|--------------------------------------------------------------------------
*/

app.post("/api/whatsapp/pair", async (req, res) => {
  try {
    const number = cleanNumber(req.body.number);

    if (!number) {
      return res.status(400).json({
        success: false,
        message: "Masukkan nomor WhatsApp."
      });
    }

    if (whatsappReady) {
      return res.json({
        success: true,
        connected: true,
        message: "WhatsApp sudah terhubung."
      });
    }

    const code =
      await generatePairingCode(number);

    res.json({
      success: true,
      pairingCode: code
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/*
|--------------------------------------------------------------------------
| UPLOAD VIDEO
|--------------------------------------------------------------------------
*/

app.post(
  "/api/upload",
  upload.single("video"),
  async (req, res) => {
    let input = null;

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Video belum dipilih."
        });
      }

      const number = cleanNumber(
        req.body.number
      );

      if (!number) {
        fs.unlinkSync(req.file.path);

        return res.status(400).json({
          success: false,
          message: "Nomor WhatsApp wajib diisi."
        });
      }

      if (!whatsappReady) {
        fs.unlinkSync(req.file.path);

        return res.status(503).json({
          success: false,
          message: "Bot WhatsApp belum terhubung."
        });
      }

      input = req.file.path;

      const id = crypto
        .randomBytes(12)
        .toString("hex");

      const output = path.join(
        OUTPUT_DIR,
        `${id}.mp4`
      );

      jobs.set(id, {
        id,
        number,
        progress: 0,
        status: "processing",
        error: null
      });

      res.json({
        success: true,
        jobId: id,
        message: "Video sedang diproses."
      });

      try {
        await processVideo(
          input,
          output,
          id
        );

        const job = jobs.get(id);

        if (job) {
          job.status = "sending";
          job.progress = 100;
        }

        await sendToWhatsApp(
          output,
          number
        );

        if (job) {
          job.status = "completed";
          job.progress = 100;
        }

        if (fs.existsSync(input)) {
          fs.unlinkSync(input);
        }

        if (fs.existsSync(output)) {
          fs.unlinkSync(output);
        }

      } catch (error) {
        console.error(error);

        const job = jobs.get(id);

        if (job) {
          job.status = "failed";
          job.error = error.message;
        }

        if (fs.existsSync(input)) {
          fs.unlinkSync(input);
        }

        if (fs.existsSync(output)) {
          fs.unlinkSync(output);
        }
      }

    } catch (error) {
      console.error(error);

      if (input && fs.existsSync(input)) {
        fs.unlinkSync(input);
      }

      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| PROGRESS
|--------------------------------------------------------------------------
*/

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Job tidak ditemukan."
    });
  }

  res.json({
    success: true,
    id: job.id,
    progress: job.progress,
    status: job.status,
    error: job.error
  });
});

/*
|--------------------------------------------------------------------------
| ERROR HANDLER
|--------------------------------------------------------------------------
*/

app.use((error, req, res, next) => {
  console.error(error);

  if (error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      success: false,
      message: "Ukuran video maksimal 100 MB."
    });
  }

  res.status(500).json({
    success: false,
    message: error.message || "Terjadi kesalahan."
  });
});

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Dianz Clean backend berjalan di port ${PORT}`
  );

  startWhatsApp().catch(console.error);
});
