const crypto = require('crypto')
const path = require('path')

const MIME_TO_EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4',  'video/3gpp': '3gp',
    'audio/ogg': 'ogg',  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/msword': 'doc',
}

const MEDIA_TYPE_INFO = {
    image:    'WhatsApp Image Keys',
    video:    'WhatsApp Video Keys',
    audio:    'WhatsApp Audio Keys',
    document: 'WhatsApp Document Keys',
    sticker:  'WhatsApp Image Keys',
}

function resolvePhone(jid, lidToPhone = {}) {
    if (!jid) return 'Unknown'
    if (jid.includes('@s.whatsapp.net')) return jid.replace('@s.whatsapp.net', '')
    if (jid.includes('@lid'))            return lidToPhone[jid] || null
    return jid
}

function formatDatetime(unixSeconds) {
    return new Date(unixSeconds * 1000).toLocaleString('en-SG', {
        timeZone: 'Asia/Singapore',
        year:     'numeric',
        month:    '2-digit',
        day:      '2-digit',
        hour:     '2-digit',
        minute:   '2-digit',
        second:   '2-digit',
        hour12:   false,
    })
}

function getMessageType(msg) {
    const c = msg.message
    if (!c) return 'unknown'
    if (c.conversation || c.extendedTextMessage) return 'text'
    if (c.imageMessage)    return 'image'
    if (c.videoMessage)    return 'video'
    if (c.audioMessage)    return 'audio'
    if (c.documentMessage) return 'document'
    if (c.stickerMessage)  return 'sticker'
    return 'unsupported'
}

function getMessageBody(msg) {
    const c = msg.message
    if (!c) return '[Empty]'
    if (c.conversation)                   return c.conversation
    if (c.extendedTextMessage?.text)      return c.extendedTextMessage.text
    if (c.imageMessage?.caption)          return c.imageMessage.caption
    if (c.videoMessage?.caption)          return c.videoMessage.caption
    if (c.documentMessage?.caption)       return c.documentMessage.caption
    if (c.imageMessage)                   return '[Image]'
    if (c.videoMessage)                   return '[Video]'
    if (c.audioMessage)                   return '[Audio]'
    if (c.documentMessage)                return '[Document]'
    if (c.stickerMessage)                 return '[Sticker]'
    return '[Unsupported]'
}

function getFileExtension(mediaMsg, messageType) {
    if (messageType === 'document' && mediaMsg.fileName) {
        return mediaMsg.fileName.split('.').pop() || 'bin'
    }
    return MIME_TO_EXT[mediaMsg.mimetype] || messageType
}

function hkdf(key, length, info) {
    const salt  = Buffer.alloc(32, 0)
    const prk   = crypto.createHmac('sha256', salt).update(key).digest()
    const infoB = Buffer.from(info)
    let t = Buffer.alloc(0), okm = Buffer.alloc(0)
    for (let i = 1; okm.length < length; i++) {
        t   = crypto.createHmac('sha256', prk).update(Buffer.concat([t, infoB, Buffer.from([i])])).digest()
        okm = Buffer.concat([okm, t])
    }
    return okm.slice(0, length)
}

function buildGCSDestPath(filepath, messageId, groupId, unixSeconds) {
    const date     = new Date(unixSeconds * 1000)
    const datePath = `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`
    const folder   = groupId ? groupId.replace('@g.us', '') : 'direct'
    const ext      = path.extname(filepath).slice(1)
    return `${folder}/${datePath}/${messageId}.${ext}`
}

function buildWebhookPayload({ from, senderName, groupId, messageId, body, messageType, timestamp }) {
    const cleanFrom = from.replace('@s.whatsapp.net', '').replace('@g.us', '')

    const messageObj = {
        from: cleanFrom,
        id: messageId,
        timestamp: String(Math.floor(timestamp / 1000)),
        type: messageType,
        ...(groupId && { group_id: groupId }),
    }

    if (messageType === 'text')     messageObj.text = { body }
    if (messageType === 'image')    messageObj.image = { caption: body }
    if (messageType === 'video')    messageObj.video = { caption: body }
    if (messageType === 'document') messageObj.document = { caption: body }

    return {
        object: 'whatsapp_business_account',
        entry: [{
            id: 'baileys',
            changes: [{
                field: 'messages',
                value: {
                    messaging_product: 'whatsapp',
                    contacts: [{ profile: { name: senderName }, wa_id: cleanFrom }],
                    messages: [messageObj],
                },
            }],
        }],
    }
}

module.exports = {
    MIME_TO_EXT,
    MEDIA_TYPE_INFO,
    resolvePhone,
    formatDatetime,
    getMessageType,
    getMessageBody,
    getFileExtension,
    hkdf,
    buildGCSDestPath,
    buildWebhookPayload,
}
