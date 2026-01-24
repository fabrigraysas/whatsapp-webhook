from flask import Flask, request, jsonify
import requests

app = Flask(__name__)

# ===== CONFIGURACIÓN =====
VERIFY_TOKEN = "fabrigray_verify"

ERP_URL = "https://fabrigraysas1.odoo.com"
ERP_API_KEY = "16aaba4d24769b75b7fa9a4978d9672c42aa551a"

# =========================

HEADERS = {
    "Authorization": f"token {ERP_API_KEY}:{ERP_API_SECRET}",
    "Content-Type": "application/json",
    "Accept": "application/json",
}

@app.route("/", methods=["GET"])
def home():
    return "OK", 200

@app.route("/webhook", methods=["GET", "POST"])
def webhook():
    # Verificación de Meta
    if request.method == "GET":
        mode = request.args.get("hub.mode")
        token = request.args.get("hub.verify_token")
        challenge = request.args.get("hub.challenge")
        if mode == "subscribe" and token == VERIFY_TOKEN:
            return challenge, 200
        return "Verification failed", 403

    # Mensajes entrantes
    data = request.get_json(silent=True) or {}
    try:
        phone, text = extract_phone_and_text(data)
        if phone:
            upsert_lead(phone, text)
    except Exception as e:
        print("Error procesando webhook:", repr(e))
        print("Payload recibido:", data)

    return jsonify({"status": "ok"}), 200


def extract_phone_and_text(payload: dict):
    """
    Extrae:
    - phone: string (ej. '57300...')
    - text: string (mensaje o descripción)
    """
    try:
        value = payload["entry"][0]["changes"][0]["value"]
    except Exception:
        return None, "Sin estructura esperada"

    # Mensaje
    msg = None
    if "messages" in value and value["messages"]:
        msg = value["messages"][0]

    if not msg:
        return None, "Sin mensaje"

    phone = msg.get("from")

    # Texto / tipo de mensaje
    if "text" in msg and isinstance(msg["text"], dict):
        text = msg["text"].get("body", "")
    else:
        # Si es audio/imagen/ubicación/etc
        text = f"Mensaje tipo: {msg.get('type','unknown')}"

    text = (text or "").strip()
    return phone, text


def upsert_lead(phone: str, text: str):
    """
    Si ya existe un lead con ese mobile_no, no crea otro.
    Si no existe, crea uno nuevo.
    """
    # 1) Buscar lead por mobile_no
    search_url = f"{ERP_URL}/api/resource/Lead"
    params = {
        "fields": '["name","lead_name","mobile_no"]',
        "filters": f'[["Lead","mobile_no","=","{phone}"]]'
    }
    r = requests.get(search_url, headers=HEADERS, params=params)
    print("ERPNext search:", r.status_code, r.text)

    lead_name_doc = None
    if r.status_code == 200:
        j = r.json()
        if j.get("data"):
            lead_name_doc = j["data"][0]["name"]

    # 2) Si no existe, crear lead
    if not lead_name_doc:
        payload = {
            "lead_name": f"WhatsApp {phone}",
            "mobile_no": phone,
            "source": "WhatsApp",
            "status": "Open",
        }
        create_url = f"{ERP_URL}/api/resource/Lead"
        resp = requests.post(create_url, headers=HEADERS, json=payload)
        print("ERPNext create:", resp.status_code, resp.text)
        return

    # 3) Si existe, agregar nota como Communication (opcional)
    # Si quieres, en vez de crear lead duplicado, registramos el mensaje:
    comm_payload = {
        "communication_type": "Communication",
        "communication_medium": "Chat",
        "sent_or_received": "Received",
        "content": text or "Mensaje WhatsApp (sin texto)",
        "reference_doctype": "Lead",
        "reference_name": lead_name_doc,
        "subject": f"WhatsApp {phone}",
    }
    comm_url = f"{ERP_URL}/api/resource/Communication"
    resp2 = requests.post(comm_url, headers=HEADERS, json=comm_payload)
    print("ERPNext comm:", resp2.status_code, resp2.text)


