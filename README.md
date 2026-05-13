# aeris-aria-whatsapp-ingestion

WhatsApp message ingestion service for **ARIA (Aeris Response Intelligence Agent)**. Connects to WhatsApp via the Baileys library, captures all incoming and outgoing messages from group chats and direct messages, stores media to Google Cloud Storage, and saves metadata to Cloud SQL (PostgreSQL).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| WhatsApp Client | [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) v6.7 |
| Media Decryption | Node.js `crypto` (AES-256-CBC + manual HKDF) |
| Media Storage | Google Cloud Storage |
| Metadata Storage | Cloud SQL — PostgreSQL (`pg`) |
| Webhook Forward | Axios — Meta-compatible payload format |
| Testing | Jest 29 |
| CI/CD | GitHub Actions |

---

## Features

- Connects to any WhatsApp number (personal or business) via QR code scan
- Captures text, images, videos, audio, documents, and stickers
- Resolves sender phone numbers from WhatsApp's `@lid` privacy identifiers via group metadata
- Downloads and decrypts media using manual HKDF key derivation (compatible with OpenSSL 3)
- Uploads media to GCS with structure: `{group_id}/YYYY/MM/DD/{messageId}.ext`
- Saves message metadata to PostgreSQL with `ON CONFLICT DO NOTHING` for idempotency
- Optionally forwards messages to a FastAPI webhook in Meta-compatible format
- Auto-reconnects on connection drop; re-scan only required after logout

---

## Project Structure

```
├── index.js                    # Entry point — WhatsApp connection and message handler
├── utils.js                    # Pure functions (message parsing, GCS path building, etc.)
├── __tests__/
│   └── utils.test.js           # 52 Jest unit tests
├── .github/
│   └── workflows/
│       └── test.yml            # CI — runs tests on every push/PR to main
├── .env.example                # Environment variable template
└── .gitignore
```

---

## Prerequisites

- Node.js 20+
- A WhatsApp account (personal or WhatsApp Business)
- A Google Cloud project with:
  - Cloud Storage bucket
  - Cloud SQL (PostgreSQL) instance
  - Service account with `Storage Object Admin` and `Cloud SQL Client` roles

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/jareldlim-cell/aeris-aria-whatsapp-ingestion.git
cd aeris-aria-whatsapp-ingestion
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Set to true to forward messages to your FastAPI server
FORWARD_TO_WEBHOOK=false

# FastAPI server URL (only used if FORWARD_TO_WEBHOOK=true)
WEBHOOK_URL=http://localhost:8000/webhook/whatsapp

# GCS bucket name (leave empty to skip media upload)
GCS_BUCKET_NAME=aeris-aria-landing-dev

# PostgreSQL connection string (leave empty to skip DB storage)
# Standard:   postgresql://user:password@host:5432/dbname
# Cloud SQL:  postgresql://user:password@/dbname?host=/cloudsql/PROJECT:REGION:INSTANCE
DATABASE_URL=postgresql://user:password@localhost:5432/aeris
```

### 3. Configure GCS credentials

Place your service account key file somewhere secure and export the path:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
```

If running on GCP infrastructure (Cloud Run, GCE), Application Default Credentials are used automatically — no key file needed.

### 4. Start the service

```bash
npm start
```

On first run, a QR code will appear in the terminal. Scan it with WhatsApp:
**Settings → Linked Devices → Link a Device**

Credentials are saved to `auth_info_baileys/` — subsequent restarts reconnect automatically without rescanning.

---

## GCS Media Structure

Media files are organised by group and date:

```
{bucket}/
  {group_id}/          # WhatsApp group JID (without @g.us)
    2026/05/13/
      ABC123DEF.jpg
      GHI456JKL.pdf
  direct/              # Direct (1-on-1) messages
    2026/05/13/
      MNO789PQR.mp4
```

---

## Database Schema

The table is auto-created on startup if it does not exist:

```sql
CREATE TABLE IF NOT EXISTS whatsapp_messages (
    message_id     VARCHAR(255) PRIMARY KEY,
    from_number    VARCHAR(50)  NOT NULL,
    sender_name    VARCHAR(255),
    group_id       VARCHAR(255),
    message_type   VARCHAR(50)  NOT NULL,  -- text | image | video | audio | document | sticker
    body           TEXT         NOT NULL,
    timestamp      TIMESTAMPTZ  NOT NULL,
    media_gcs_path VARCHAR(500),           -- gs://bucket/path or NULL for non-media messages
    raw_payload    JSONB        NOT NULL,
    created_at     TIMESTAMPTZ  DEFAULT NOW()
);
```

---

## Webhook Forwarding (Optional)

When `FORWARD_TO_WEBHOOK=true`, every message is forwarded to `WEBHOOK_URL` in Meta-compatible format:

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "baileys",
    "changes": [{
      "field": "messages",
      "value": {
        "messaging_product": "whatsapp",
        "contacts": [{ "profile": { "name": "Jun Rong" }, "wa_id": "601123177422" }],
        "messages": [{
          "from": "601123177422",
          "id": "MSGABC123",
          "timestamp": "1778630400",
          "type": "text",
          "group_id": "120363123456@g.us",
          "text": { "body": "hello" }
        }]
      }
    }]
  }]
}
```

---

## Running Tests

```bash
npm test
```

52 unit tests covering message parsing, media path building, HKDF key derivation, GCS path structure, and webhook payload format. No external services required.

---

## CI/CD

GitHub Actions runs the full test suite on every push and pull request to `main`. Merging is blocked if any test fails.

To enforce merge protection, go to your GitHub repo:
**Settings → Branches → Add branch protection rule → Require status checks → select `Baileys WhatsApp Unit Tests`**
