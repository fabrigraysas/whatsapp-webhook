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
 * - ODOO_DB (database name)
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

/** Odoo JSON-RPC helper */
async function odooExecute(model, method, args = [], kwargs = {}) {
  const payload = {
    jsonrpc: "2.0",
    method: "call",
    params: {
      service: "object",
      method: "execute_kw",
      args: [ODOO_DB, ODOO_USER, ODOO_API_KEY, model, method, args, kwargs],
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
 * We respond 200 immediately and process asynchronously to avoid retries.
 * This implementation:
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

app.get("/", (_req, res) => res.status(200).send("OK"));
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
