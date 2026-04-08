// server.js
import express from "express";
import pkg from "whatsapp-web.js";
import cors from "cors";
import multer from "multer";
import http from "http";
import { WebSocketServer } from "ws";
import { parse } from "csv-parse/sync";
import qrcode from "qrcode";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";

const { Client, LocalAuth, MessageMedia } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ADMIN_PASSWORD = "harsh";
const SESSION_ID = "default"; // persistent WA session folder
const SESSION_ROOT = path.join(__dirname, ".wwebjs_auth", SESSION_ID);
const WHATSAPP_HEADLESS = process.env.WHATSAPP_HEADLESS?.toLowerCase() === "true" || true; // default to true for production
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;

const app = express();
const port = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const upload = multer({ storage: multer.memoryStorage() });

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Runtime state ---
let client = null;
let currentUser = null;
let isInitializing = false;
let isBulkSending = false;
let currentBulkTotal = 0;
let currentBulkSent = 0;
let currentBulkSkipped = 0;

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// Auth token store (single admin; keep simple)
let currentAdminToken = null;
function newAdminToken() {
  currentAdminToken = crypto.randomBytes(24).toString("hex");
  return currentAdminToken;
}
function checkAuthToken(req) {
  // Expect token in header: x-admin-token
  const t = req.headers["x-admin-token"];
  return t && t === currentAdminToken;
}

// --- Helper to validate phone number format ---
function validatePhoneNumber(number) {
  if (!number || typeof number !== 'string') return false;
  // Check if it has a + prefix and is mostly digits
  const cleaned = number.replace(/[\s\-\(\)]/g, '');
  return cleaned.startsWith('+') && cleaned.length >= 10 && /^\+\d+$/.test(cleaned);
}

// --- Broadcast helper ---
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  });
}

// --- WhatsApp client lifecycle ---
async function initializeClient() {
  if (isInitializing) {
    console.log('initializeClient: already initializing, skipping');
    return;
  }

  isInitializing = true;
  if (client) {
    try {
      await client.destroy();
    } catch (err) {
      console.error('Error destroying existing client:', err);
    }
    client = null;
  }

  const puppeteerOptions = {
    headless: WHATSAPP_HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
    ],
  };
  if (PUPPETEER_EXECUTABLE_PATH) {
    puppeteerOptions.executablePath = PUPPETEER_EXECUTABLE_PATH;
  }

  client = new Client({
    authStrategy: new LocalAuth({ clientId: SESSION_ID }),
    puppeteer: puppeteerOptions,
  });
  try {
    client.on("loading_screen", (percent, message) => {
      console.log(`WA loading ${percent}% - ${message}`);
    });

    client.on("qr", async (qr) => {
      // QR will only fire if no valid saved session
      try {
        const qrImage = await qrcode.toDataURL(qr);
        broadcast({
          type: "qr_code",
          qrCode: qrImage,
          message: "Scan QR code with WhatsApp",
        });
      } catch (err) {
        console.error("QR gen error:", err);
      }
    });

    client.on("ready", () => {
      currentUser = client.info?.wid?.user || "Unknown";
      broadcast({
        type: "ready",
        message: "WhatsApp connected",
        phoneNumber: currentUser,
      });
      console.log(`WhatsApp ready - ${currentUser}`);
    });

    client.on("disconnected", (reason) => {
      console.log("WA disconnected:", reason);
      currentUser = null;
      broadcast({ type: "disconnected", message: `Disconnected: ${reason}` });
    });

    client.on("auth_failure", (msg) => {
      console.error("WA auth failure:", msg);
      broadcast({ type: "auth_failure", message: "Auth failed" });
    });

    await client.initialize();
  } catch (err) {
    console.error('Client initialization failed:', err);
  } finally {
    isInitializing = false;
  }
}

// Attempt auto-connect on server start IF session folder exists
if (fs.existsSync(SESSION_ROOT)) {
  console.log("🟡 Existing WhatsApp session found; auto-initializing...");
  initializeClient();
} else {
  console.log("⚪ No saved WhatsApp session yet; will require QR when connecting.");
}

// ------------------- ROUTES -------------------

// AUTHENTICATE
app.post("/authenticate", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const token = newAdminToken();
    res.json({ status: "success", message: "Authenticated", token });
  } else {
    res.status(401).json({ status: "error", message: "Invalid password" });
  }
});

// CONNECT (requires admin token)
app.post("/connect-whatsapp", async (req, res) => {
  if (!checkAuthToken(req)) {
    return res.status(401).json({ status: "error", message: "Not authenticated" });
  }
  if (client?.info?.wid) {
    return res.json({ status: "success", message: "Already connected" });
  }
  if (isInitializing) {
    return res.json({ status: "success", message: "Already connecting" });
  }

  try {
    await initializeClient();
    res.json({ status: "success", message: "Connecting..." });
  } catch (err) {
    console.error("Init error:", err);
    res.status(500).json({ status: "error", message: "Init failed" });
  }
});

// BULK SEND
app.post("/send-bulk-messages", upload.array("attachment"), async (req, res) => {
  if (!checkAuthToken(req)) {
    return res.status(401).json({ status: "error", message: "Not authenticated" });
  }
  if (!client?.info?.wid) {
    return res.status(400).json({ status: "error", message: "WhatsApp not connected" });
  }

  const { recipientsText, messageTemplate, delay = "60" } = req.body;
  const attachments = req.files || [];
  const delayMs = Math.max(0, parseInt(delay, 10) || 60) * 1000;
  // attachments is an array of files.
  // Current active mode: Multiple attachments per send.
  // If you want to restore the old single-file mode, change this route to upload.single("attachment")
  // and use const attachment = req.file; instead of req.files.

  if (!recipientsText || !messageTemplate) {
    return res
      .status(400)
      .json({ status: "error", message: "Recipients and messageTemplate are required" });
  }

  try {
    const lines = recipientsText.trim().split('\n').filter(line => line.trim());
    if (lines.length === 0) {
      return res.status(400).json({ status: "error", message: "No recipients" });
    }

    let recipients;
    const firstLine = lines[0].trim();
    const hasHeaders = firstLine.toLowerCase().includes('number') || firstLine.toLowerCase().includes('phone');

    if (hasHeaders) {
      // Parse with headers
      recipients = parse(recipientsText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    } else {
      // No headers, assume format: number,name
      recipients = lines.map(line => {
        const parts = line.split(',').map(p => p.trim());
        return {
          number: parts[0] || '',
          name: parts[1] || ''
        };
      });
    }

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ status: "error", message: "No recipients" });
    }

    currentBulkTotal = recipients.length;
    currentBulkSent = 0;
    currentBulkSkipped = 0;
    broadcast({ type: "bulk_start", total: recipients.length });

    let sent = 0;
    let skipped = 0;
    let stopped = false;
    isBulkSending = true;

    for (let i = 0; i < recipients.length; i++) {
      if (!isBulkSending) {
        stopped = true;
        broadcast({ type: "bulk_stopped", sent, total: recipients.length, skipped, message: "Stopped by user" });
        break;
      }
      const row = recipients[i];
      let number = (row.number || '').trim();
      
      if (!number) {
        broadcast({
          type: "message_sent",
          number: "Unknown",
          status: "Failed: Missing number",
          progress: i + 1,
          total: recipients.length,
        });
        skipped++;
        currentBulkSkipped = skipped;
        continue;
      }

      // Auto-fix: if number doesn't start with +, try to add +91 (India default)
      if (!number.startsWith('+')) {
        // Only auto-fix if it looks like a 10-digit number
        if (/^\d{10}$/.test(number)) {
          console.log(`Auto-fixing number ${number} to +91${number}`);
          number = `+91${number}`;
        } else if (!number.startsWith('0') && /^\d+$/.test(number)) {
          // If it's just digits and not 10 digits, skip
          broadcast({
            type: "message_sent",
            number: row.number,
            status: "Failed: Invalid format. Use +country code format (e.g., +919876543210)",
            progress: i + 1,
            total: recipients.length,
          });
          skipped++;
          currentBulkSkipped = skipped;
          continue;
        }
      }

      // Validate final number
      if (!validatePhoneNumber(number)) {
        broadcast({
          type: "message_sent",
          number: row.number,
          status: "Failed: Phone must be +country code format (e.g., +919876543210)",
          progress: i + 1,
          total: recipients.length,
        });
        skipped++;
        currentBulkSkipped = skipped;
        continue;
      }

      const personalized = messageTemplate.replace(
        /{(\w+)}/g,
        (_, k) => row[k] || `{${k}}`
      );
      const cleanNumber = number.replace(/[^\d]/g, '');

      // Additional validation: check length after cleaning
      if (cleanNumber.length < 10 || cleanNumber.length > 15) {
        broadcast({
          type: "message_sent",
          number: row.number,
          status: "Failed: Invalid number length (must be 10-15 digits after cleaning)",
          progress: i + 1,
          total: recipients.length,
        });
        skipped++;
        currentBulkSkipped = skipped;
        continue;
      }

      try {
        // Send message with text first
        await client.sendMessage(`${cleanNumber}@c.us`, personalized);

        // Current active mode: multiple attachments.
        // Each uploaded file is sent separately as its own message.
        for (const attachment of attachments) {
          const media = new MessageMedia(
            attachment.mimetype,
            attachment.buffer.toString("base64"),
            attachment.originalname
          );
          await client.sendMessage(`${cleanNumber}@c.us`, media);
        }

        sent++;
        currentBulkSent = sent;
        broadcast({
          type: "message_sent",
          number,
          status: "Sent",
          progress: i + 1,
          total: recipients.length,
        });
      } catch (err) {
        broadcast({
          type: "message_sent",
          number,
          status: `Failed: ${err.message}`,
          progress: i + 1,
          total: recipients.length,
        });
      }

      /*
        Previous single-attachment logic:
        ----------------------------------
        If you want only one attachment per recipient, restore this block.
        It sends the text message first, then a single attachment if present.

        const attachment = req.file;

        try {
          await client.sendMessage(`${cleanNumber}@c.us`, personalized);
          if (attachment) {
            const media = new MessageMedia(
              attachment.mimetype,
              attachment.buffer.toString("base64"),
              attachment.originalname
            );
            await client.sendMessage(`${cleanNumber}@c.us`, media);
          }
          sent++;
          currentBulkSent = sent;
          broadcast({
            type: "message_sent",
            number,
            status: "Sent",
            progress: i + 1,
            total: recipients.length,
          });
        } catch (err) {
          broadcast({
            type: "message_sent",
            number,
            status: `Failed: ${err.message}`,
            progress: i + 1,
            total: recipients.length,
          });
        }
      */

      if (i < recipients.length - 1 && delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    const wasStopped = !isBulkSending && stopped;
    isBulkSending = false;
    if (!wasStopped) {
      broadcast({ type: "bulk_complete", sent, total: recipients.length, skipped });
    }
    res.json({ status: "success", sent, total: recipients.length, skipped });
  } catch (err) {
    console.error("Bulk send error:", err);
    res.status(500).json({ status: "error", message: "Send failed" });
  }
});

// STOP BULK SEND
app.post("/stop-bulk-send", (req, res) => {
  if (!checkAuthToken(req)) {
    return res.status(401).json({ status: "error", message: "Not authenticated" });
  }
  if (!isBulkSending) {
    return res.json({ status: "success", message: "No bulk send in progress" });
  }
  isBulkSending = false;
  broadcast({
    type: "bulk_stopped",
    message: "Bulk send stopped by user",
    sent: currentBulkSent,
    total: currentBulkTotal,
    skipped: currentBulkSkipped,
  });
  res.json({ status: "success", message: "Stopping bulk send" });
});

// LOGOUT
app.post("/logout", async (req, res) => {
  if (!checkAuthToken(req)) {
    return res.status(401).json({ status: "error", message: "Not authenticated" });
  }

  try {
    if (client) {
      try { await client.logout(); } catch {}
      try { client.destroy(); } catch {}
      client = null;
    }
    currentUser = null;

    // wipe WA session so next connect shows QR
    if (fs.existsSync(SESSION_ROOT)) {
      fs.rmSync(SESSION_ROOT, { recursive: true, force: true });
    }

    // invalidate admin token
    currentAdminToken = null;

    broadcast({ type: "logged_out", message: "Logged out" });
    res.json({ status: "success", message: "Logged out" });
  } catch (err) {
    console.error("Logout error:", err);
    res.json({ status: "success", message: "Logged out (forced)" });
  }
});

// STATUS — used by frontend on load to sync state
app.get("/status", (req, res) => {
  res.json({
    authenticated: !!currentAdminToken,
    connected: !!client?.info?.wid,
    phoneNumber: currentUser,
    hasSavedSession: fs.existsSync(SESSION_ROOT),
  });
});

// --- WebSocket connection handler ---
wss.on("connection", (ws) => {
  console.log("WS: new connection established");
  ws.send(
    JSON.stringify({
      type: "status",
      authenticated: !!currentAdminToken,
      connected: !!client?.info?.wid,
      phoneNumber: currentUser,
    })
  );
  ws.on("close", () => console.log("WS: connection closed"));
});

// Serve frontend
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`🚀 WhatsApp Bulk Sender running on port ${port}`);
  console.log(`📱 Admin Password: ${ADMIN_PASSWORD}`);
});
