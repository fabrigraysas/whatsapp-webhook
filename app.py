from flask import Flask, request, jsonify
import requests

app = Flask(__name__)

# ===== CONFIGURACIÓN =====
VERIFY_TOKEN = "fabrigray_verify"

ERP_URL = "https://fabrigraysas.v.erpnext.com"
ERP_API_KEY = "640077c21610ddd"
ERP_API_SECRET = "ba99f366dfab7d4"

# =========================

@app.route("/webhook", methods=["GET", "POST"])
def webhook():
    # 1️⃣ Verificación de Meta
    if request.method == "GET":
        mode = request.args.get("hub.mode")
        token = request.args.get("hub.verify_token")
        challenge = request.args.get("hub.challenge")

        if mode == "subscribe" and token == VERIFY_TOKEN:
            return challenge, 200
        return "Verification failed", 403

    # 2️⃣ Mensajes entrantes
    if request.method == "POST":
        data = request.get_json()

        try:
            entry = data["entry"][0]
            changes = entry["changes"][0]
            value = changes["value"]

            if "messages" in value:
                message = value["messages"][0]
                phone = message["from"]
                text = message.get("text", {}).get("body", "Mensaje sin texto")

                create_lead(phone, text)

        except Exception as e:
            print("Error procesando mensaje:", e)

        return jsonify({"status": "ok"}), 200


def create_lead(phone, text):
    url = f"{ERP_URL}/api/resource/Lead"

    payload = {
        "lead_name": f"WhatsApp {phone}",
        "mobile_no": phone,
        "source": "WhatsApp",
        "notes": text
    }

    headers = {
        "Authorization": f"token {ERP_API_KEY}:{ERP_API_SECRET}",
        "Content-Type": "application/json"
    }

    response = requests.post(url, json=payload, headers=headers)
    print("ERPNext response:", response.status_code, response.text)


if __name__ == "__main__":
    app.run()
