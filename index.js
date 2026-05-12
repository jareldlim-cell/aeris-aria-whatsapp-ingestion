require('dotenv').config()

const {
    makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys')
const pino = require('pino')
const axios = require('axios')
const qrcode = require('qrcode-terminal')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { downloadAuthFromGCS, uploadAuthToGCS } = require('./gcsAuth')

const {
    MEDIA_TYPE_INFO,
    resolvePhone,
    formatDatetime,
    getMessageType,
    getMessageBody,
    getFileExtension,
    hkdf,
    buildGCSDestPath,
    buildWebhookPayload,
} = require('./utils')

const crypto = require('crypto')

const MEDIA_DIR = path.join(__dirname, 'media')
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR)

const WEBHOOK_URL        = process.env.WEBHOOK_URL || 'http://localhost:8000/webhook/whatsapp'
const FORWARD_TO_WEBHOOK = process.env.FORWARD_TO_WEBHOOK === 'true'
const GCS_BUCKET_NAME    = process.env.GCS_BUCKET_NAME || null
const DATABASE_URL       = process.env.DATABASE_URL || null

// ── GCS client ───────────────────────────────────────────────────────────────
let gcsClient = null
if (GCS_BUCKET_NAME) {
    const { Storage } = require('@google-cloud/storage')
    gcsClient = new Storage()
}

async function uploadToGCS(filepath, messageId, groupId, unixSeconds) {
    if (!gcsClient || !GCS_BUCKET_NAME) return null
    try {
        const destPath = buildGCSDestPath(filepath, messageId, groupId, unixSeconds)
        await gcsClient.bucket(GCS_BUCKET_NAME).upload(filepath, { destination: destPath })
        console.log(`[GCS] Uploaded: ${destPath}`)
        return `gs://${GCS_BUCKET_NAME}/${destPath}`
    } catch (e) {
        console.error(`[ERROR] GCS upload failed: ${e.message}`)
        return null
    }
}

// ── Cloud SQL (PostgreSQL) client ─────────────────────────────────────────────
let pgPool = null
if (DATABASE_URL) {
    const { Pool } = require('pg')
    pgPool = new Pool({ connectionString: DATABASE_URL })

    pgPool.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_messages (
            message_id    VARCHAR(255) PRIMARY KEY,
            from_number   VARCHAR(50)  NOT NULL,
            sender_name   VARCHAR(255),
            group_id      VARCHAR(255),
            message_type  VARCHAR(50)  NOT NULL,
            body          TEXT         NOT NULL,
            timestamp     TIMESTAMPTZ  NOT NULL,
            media_gcs_path VARCHAR(500),
            raw_payload   JSONB        NOT NULL,
            created_at    TIMESTAMPTZ  DEFAULT NOW()
        )
    `).catch(e => console.error('[ERROR] DB init failed:', e.message))
}

async function saveToDatabase({ messageId, phone, senderName, groupId, messageType, body, unixSeconds, mediaGcsPath, rawPayload }) {
    if (!pgPool) return
    try {
        await pgPool.query(`
            INSERT INTO whatsapp_messages
                (message_id, from_number, sender_name, group_id, message_type, body, timestamp, media_gcs_path, raw_payload)
            VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7),$8,$9)
            ON CONFLICT (message_id) DO NOTHING
        `, [messageId, phone, senderName, groupId, messageType, body, unixSeconds, mediaGcsPath, JSON.stringify(rawPayload)])
        console.log(`[DB] Saved message: ${messageId}`)
    } catch (e) {
        console.error(`[ERROR] DB insert failed: ${e.message}`)
    }
}

// ── Contacts map: resolves @lid → phone number ───────────────────────────────
const lidToPhone = {}

async function resolvePhoneFromGroup(sock, groupId, lid) {
    try {
        const metadata = await sock.groupMetadata(groupId)

        for (const p of metadata.participants) {
            const pLid = p.lid ?? p.id

            if ((pLid === lid || p.id === lid) && p.jid) {
                const phone = p.jid.replace('@s.whatsapp.net', '')
                lidToPhone[lid] = phone
                return phone
            }
        }
    } catch (e) {
        console.error(`[ERROR] groupMetadata failed: ${e.message}`)
    }
    return lid.split('@')[0]
}

// ── Media download ───────────────────────────────────────────────────────────

async function downloadAndSaveMedia(sock, msg, messageType, messageId) {
    try {
        const mediaMsg = msg.message?.[`${messageType}Message`]
        if (!mediaMsg?.url || !mediaMsg?.mediaKey) throw new Error('Missing url or mediaKey')

        const resp = await axios.get(mediaMsg.url, { responseType: 'arraybuffer', timeout: 30000 })
        const encData = Buffer.from(resp.data)

        const mediaKeyBuf = Buffer.isBuffer(mediaMsg.mediaKey)
            ? mediaMsg.mediaKey
            : Buffer.from(mediaMsg.mediaKey, 'base64')
        const derived    = hkdf(mediaKeyBuf, 112, MEDIA_TYPE_INFO[messageType] || MEDIA_TYPE_INFO.image)
        const iv         = derived.slice(0, 16)
        const cipherKey  = derived.slice(16, 48)

        // Strip last 10 bytes (MAC), disable auto-padding for OpenSSL 3 compatibility
        const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv)
        decipher.setAutoPadding(false)
        const raw = Buffer.concat([decipher.update(encData.slice(0, -10)), decipher.final()])
        const padLen    = raw[raw.length - 1]
        const decrypted = raw.slice(0, raw.length - padLen)

        const ext      = getFileExtension(mediaMsg, messageType)
        const filename = `${messageId}.${ext}`
        const filepath = path.join(MEDIA_DIR, filename)
        fs.writeFileSync(filepath, decrypted)
        return filepath
    } catch (e) {
        console.error(`[ERROR] Failed to download media: ${e.message}`)
        return null
    }
}

// ── Forward to FastAPI in Meta-compatible format ─────────────────────────────

async function forwardToFastAPI(params) {
    const payload = buildWebhookPayload(params)
    try {
        await axios.post(WEBHOOK_URL, payload, { timeout: 5000 })
    } catch (err) {
        console.error(`[ERROR] Failed to forward to FastAPI: ${err.message}`)
    }
}

// ── Main connection ──────────────────────────────────────────────────────────

async function connectToWhatsApp() {
    const authDir = GCS_BUCKET_NAME
        ? await downloadAuthFromGCS(GCS_BUCKET_NAME)
        : 'auth_info_baileys'
    const { state, saveCreds } = await useMultiFileAuthState(authDir)
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
    })

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            qrcode.generate(qr, { small: true })
            console.log('[INFO] Scan the QR code above with WhatsApp → Settings → Linked Devices → Link a Device')
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode
            const shouldReconnect = code !== DisconnectReason.loggedOut

            console.log(`[INFO] Connection closed (code=${code}). Reconnecting: ${shouldReconnect}`)

            if (shouldReconnect) {
                connectToWhatsApp()
            } else {
                console.log('[INFO] Logged out. Delete auth_info_baileys/ and restart to re-scan QR.')
            }
        } else if (connection === 'open') {
            console.log('[INFO] ✅ Connected to WhatsApp')
        }
    })

    sock.ev.on('creds.update', async () => {
        await saveCreds()
        if (GCS_BUCKET_NAME) await uploadAuthToGCS(GCS_BUCKET_NAME)
    })

    const mapContacts = contacts => {
        for (const contact of contacts) {
            if (contact.lid && contact.id?.includes('@s.whatsapp.net')) {
                lidToPhone[contact.lid] = contact.id.replace('@s.whatsapp.net', '')
            }
        }
    }
    sock.ev.on('contacts.upsert', mapContacts)
    sock.ev.on('contacts.update', mapContacts)

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return

        for (const msg of messages) {
            const jid         = msg.key.remoteJid
            const isGroup     = jid.endsWith('@g.us')
            const rawFrom     = isGroup ? msg.key.participant : jid
            const groupId     = isGroup ? jid : null

            let phone = resolvePhone(rawFrom, lidToPhone)
            if (!phone && isGroup) {
                phone = await resolvePhoneFromGroup(sock, jid, rawFrom)
            }
            if (!phone) phone = rawFrom.split('@')[0]
            phone = phone.split('@')[0]

            const messageId   = msg.key.id
            const unixSeconds = msg.messageTimestamp ?? Math.floor(Date.now() / 1000)
            const datetime    = formatDatetime(unixSeconds)
            const senderName  = msg.pushName || 'Unknown'
            const body        = getMessageBody(msg)
            const messageType = getMessageType(msg)

            let savedPath    = null
            let mediaGcsPath = null
            if (['image', 'document', 'video', 'audio'].includes(messageType)) {
                savedPath = await downloadAndSaveMedia(null, msg, messageType, messageId)
                if (savedPath) {
                    mediaGcsPath = await uploadToGCS(savedPath, messageId, groupId, unixSeconds)
                }
            }

            const direction = msg.key.fromMe ? 'OUT' : 'IN'
            console.log(
                `[MSG][${direction}] phone=+${phone} name=${senderName} type=${messageType} body=${body} group=${groupId || 'direct'} datetime=${datetime}${savedPath ? ` file=${savedPath}` : ''}${mediaGcsPath ? ` gcs=${mediaGcsPath}` : ''}`
            )

            await saveToDatabase({
                messageId,
                phone,
                senderName,
                groupId,
                messageType,
                body,
                unixSeconds,
                mediaGcsPath,
                rawPayload: msg,
            })

            if (FORWARD_TO_WEBHOOK) {
                await forwardToFastAPI({ from: rawFrom, senderName, groupId, messageId, body, messageType, timestamp: unixSeconds * 1000 })
            }
        }
    })
}

if (require.main === module) {
    // Health check server required by Cloud Run
    const PORT = process.env.PORT || 8080
    http.createServer((_req, res) => { res.writeHead(200); res.end('OK') })
        .listen(PORT, () => console.log(`[INFO] Health check listening on port ${PORT}`))

    connectToWhatsApp()
}
