import express from "express";
import axios from "axios";
import morgan from "morgan";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(morgan("combined"));

/**
 * ENV required:
 * - META_VERIFY_TOKEN
 * - ODOO_URL (e.g. https://tuempresa.odoo.com)
 * - ODOO_DB (database name / subdomain on Odoo Online)
 * - ODOO_USER (integration user's email/login)
 * - ODOO_API_KEY (API key created in Odoo for that user)
 * - ODOO_TEAM_ID (crm.team numeric id for "Ventas WhatsApp")
 */
const {
  PORT = 10000,
  META_VERIFY_TOKEN,
  ODOO_URL,
  ODOO_DB,
  ODOO_USER,
  ODOO_API_KEY,
  ODOO_TEAM_ID,
} = process.env;

function must(name) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}
["META_VERIFY_TOKEN", "ODOO_URL", "ODOO_DB", "ODOO_USER", "ODOO_API_KEY", "ODOO_TEAM_ID"].forEach(must);

/** ===== Odoo auth (uid) cache ===== */
let cachedUid = null;

async function odooLoginUid() {
  if (cachedUid) return cachedUid;

  const payload = {
    jsonrpc: "2.0",
    method: "call",
    params: {
      service: "common",
      method: "authenticate",
      args: [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}],
    },
    id: Date.now(),
  };

  const res = await axios.post(`${ODOO_URL}/jsonrpc`, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 20000,
  });

  if (res.data?.error) {
    throw new Error(`Odoo auth error: ${JSON.stringify(res.data.error)}`);
  }

  const uid = res.data?.result;
  if (!uid) {
    throw new Error("Odoo auth failed: uid vacío (revisa ODOO_DB / ODOO_USER / ODOO_API_KEY)");
  }

  cachedUid = uid;
  return uid;
}

/** ===== Odoo JSON-RPC helper ===== */
async function odooExecute(model, method, args = [], kwargs = {}) {
  const uid = await odooLoginUid();

  const payload = {
    jsonrpc: "2.0",
    method: "call",
    params: {
      service: "object",
      method: "execute_kw",
      args: [ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs],
    },
    id: Date.now(),
  };

  const res = await axios.post(`${ODOO_URL}/jsonrpc`, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 20000,
  });

  if (res.data?.error) {
    throw new Error(`Odoo error: ${JSON.stringify(res.data.error)}`);
  }
  return res.data.result;
}

/**
 * Meta Webhook verification endpoint (GET)
 * Meta will call:
 *   /webhook/meta?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
 */
app.get("/webhook/meta", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/**
 * Meta Webhook receiver endpoint (POST)
 * - Creates/updates a contact (res.partner) using phone = +{wa_id}
 * - Reuses an open lead for the contact, otherwise creates a new one
 * - Logs the message in the lead chatter
 * - Uses mail.message.message_id for idempotency to avoid duplicates on retries
 */
app.post("/webhook/meta", async (req, res) => {
  // Respond quickly to Meta
  res.sendStatus(200);

  try {
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    if (!msg) return; // ignore non-message events (e.g., statuses only)

    const waId = msg.from; // e.g. "573001112233"
    const msgId = msg.id;  // unique message id
    if (!waId || !msgId) return;

    const phone = `+${waId}`;
    const contactName = change?.contacts?.[0]?.profile?.name || null;

    // Extract message text (extend later for media downloads if needed)
    let bodyText = "";
    if (msg.type === "text") bodyText = msg?.text?.body || "";
    else bodyText = `[${msg.type}] Mensaje no-texto recibido.`;

    // ---- Idempotency: if we already saved this msgId, skip ----
    const existing = await odooExecute(
      "mail.message",
      "search",
      [[["message_id", "=", msgId]]],
      { limit: 1 }
    );
    if (existing?.length) return;

    // ---- Partner (contact) ----
    const partnerIds = await odooExecute(
      "res.partner",
      "search",
      [[["phone", "=", phone]]],
      { limit: 1 }
    );

    let partnerId = partnerIds?.[0];
    if (!partnerId) {
      partnerId = await odooExecute("res.partner", "create", [{
        name: contactName || `WhatsApp ${phone}`,
        phone,
      }]);
    }

    // ---- Lead reuse/open lead search ----
    const leadIds = await odooExecute(
      "crm.lead",
      "search",
      [[
        ["partner_id", "=", partnerId],
        ["active", "=", true],
        ["probability", "<", 100], // not won
      ]],
      { limit: 1, order: "id desc" }
    );

    let leadId = leadIds?.[0];
    const teamIdNum = parseInt(ODOO_TEAM_ID, 10);

    if (!leadId) {
      leadId = await odooExecute("crm.lead", "create", [{
        name: `WhatsApp: ${contactName || phone}`,
        partner_id: partnerId,
        phone,
        team_id: teamIdNum,
        description: bodyText,
      }]);
    } else {
      // enforce team assignment (optional)
      await odooExecute("crm.lead", "write", [[leadId], { team_id: teamIdNum }]);
    }

    // ---- Log message in lead chatter ----
    await odooExecute("mail.message", "create", [{
      model: "crm.lead",
      res_id: leadId,
      message_type: "comment",
      body: `WhatsApp (${phone}): ${bodyText}`,
      author_id: partnerId,
      message_id: msgId, // for idempotency
    }]);

  } catch (err) {
    console.error("Webhook processing error:", err?.message || err);
  }
});
const { META_WA_PHONE_NUMBER_ID, META_WA_ACCESS_TOKEN, SEND_SECRET } = process.env;
["META_WA_PHONE_NUMBER_ID", "META_WA_ACCESS_TOKEN", "SEND_SECRET"].forEach(must);

// Render helper: enviar WhatsApp (Cloud API)
async function sendWhatsAppText({ toPhoneE164, text }) {
  // Meta requiere número sin "+" y sin espacios: 57300...
  const to = toPhoneE164.replace(/[^\d]/g, "");

  const url = `https://graph.facebook.com/v19.0/${META_WA_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text }
  };

  const res = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${META_WA_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });

  return res.data; // trae message id, etc.
}

// UI simple para asesoras (formulario)
app.get("/send", async (req, res) => {
  const { secret, lead_id, phone } = req.query;

  if (secret !== SEND_SECRET) return res.status(403).send("Forbidden");

  // Formulario HTML simple (sin complicaciones)
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
    <html>
      <body style="font-family: Arial; max-width: 720px; margin: 24px auto;">
        <h2>Enviar WhatsApp</h2>
        <form method="POST" action="/send">
          <input type="hidden" name="secret" value="${secret}" />
          <label>Lead ID</label><br/>
          <input name="lead_id" value="${lead_id || ""}" style="width: 100%; padding: 8px;" /><br/><br/>

          <label>Teléfono (E.164, ej +573001112233)</label><br/>
          <input name="phone" value="${phone || ""}" style="width: 100%; padding: 8px;" /><br/><br/>

          <label>Mensaje</label><br/>
          <textarea name="message" rows="6" style="width: 100%; padding: 8px;"></textarea><br/><br/>

          <button type="submit" style="padding: 10px 16px;">Enviar</button>
        </form>
      </body>
    </html>
  `);
});

// Enviar y registrar en Odoo
app.post("/send", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { secret, lead_id, phone, message } = req.body;

    if (secret !== SEND_SECRET) return res.status(403).send("Forbidden");
    if (!phone || !message) return res.status(400).send("Faltan campos: phone o message");

    // 1) Enviar WhatsApp por Meta
    const metaResp = await sendWhatsAppText({ toPhoneE164: phone, text: message });

    // 2) Registrar el mensaje en Odoo en el chatter del lead (si viene lead_id)
    if (lead_id) {
      await odooExecute("mail.message", "create", [{
        model: "crm.lead",
        res_id: parseInt(lead_id, 10),
        message_type: "comment",
        body: `✅ WhatsApp enviado a ${phone}: ${message}<br/><small>Meta: ${JSON.stringify(metaResp)}</small>`,
      }]);
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<p>Mensaje enviado OK.</p><p><a href="/send?secret=${secret}&lead_id=${lead_id}&phone=${encodeURIComponent(phone)}">Enviar otro</a></p>`);
  } catch (err) {
    console.error("Send error:", err?.response?.data || err?.message || err);
    res.status(500).send("Error enviando WhatsApp. Revisa logs.");
  }
});

app.get("/", (_req, res) => res.status(200).send("OK"));
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
