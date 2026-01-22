from flask import Flask, request, jsonify

app = Flask(__name__)

VERIFY_TOKEN = "fabrigray_verify"  # debe coincidir con Meta

@app.route("/webhook", methods=["GET", "POST"])
def webhook():
    # Verificación de Meta
    if request.method == "GET":
        mode = request.args.get("hub.mode")
        token = request.args.get("hub.verify_token")
        challenge = request.args.get("hub.challenge")

        if mode == "subscribe" and token == VERIFY_TOKEN:
            return challenge, 200
        else:
            return "Verification failed", 403

    # Recepción de mensajes
    if request.method == "POST":
        data = request.get_json()
        print("Mensaje recibido:", data)
        return jsonify({"status": "ok"}), 200


if __name__ == "__main__":
    app.run()
