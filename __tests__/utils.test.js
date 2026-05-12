const {
    resolvePhone,
    getMessageType,
    getMessageBody,
    getFileExtension,
    hkdf,
    buildGCSDestPath,
    buildWebhookPayload,
} = require('../utils')

// 2026-05-13T00:00:00Z
const UNIX_MAY_13 = 1778630400
// 2026-01-05T00:00:00Z
const UNIX_JAN_05 = 1767571200

// ── resolvePhone ─────────────────────────────────────────────────────────────

describe('resolvePhone', () => {
    test('strips @s.whatsapp.net', () => {
        expect(resolvePhone('628512152526@s.whatsapp.net')).toBe('628512152526')
    })

    test('resolves @lid via lidToPhone map', () => {
        expect(resolvePhone('12345@lid', { '12345@lid': '601123177422' })).toBe('601123177422')
    })

    test('returns null for unknown @lid', () => {
        expect(resolvePhone('unknown@lid', {})).toBeNull()
    })

    test('returns Unknown for null', () => {
        expect(resolvePhone(null)).toBe('Unknown')
    })

    test('returns Unknown for undefined', () => {
        expect(resolvePhone(undefined)).toBe('Unknown')
    })

    test('returns jid as-is for plain number string', () => {
        expect(resolvePhone('628512152526')).toBe('628512152526')
    })
})

// ── getMessageType ────────────────────────────────────────────────────────────

describe('getMessageType', () => {
    test('conversation → text', () => {
        expect(getMessageType({ message: { conversation: 'hello' } })).toBe('text')
    })

    test('extendedTextMessage → text', () => {
        expect(getMessageType({ message: { extendedTextMessage: { text: 'hi' } } })).toBe('text')
    })

    test('imageMessage → image', () => {
        expect(getMessageType({ message: { imageMessage: {} } })).toBe('image')
    })

    test('videoMessage → video', () => {
        expect(getMessageType({ message: { videoMessage: {} } })).toBe('video')
    })

    test('audioMessage → audio', () => {
        expect(getMessageType({ message: { audioMessage: {} } })).toBe('audio')
    })

    test('documentMessage → document', () => {
        expect(getMessageType({ message: { documentMessage: {} } })).toBe('document')
    })

    test('stickerMessage → sticker', () => {
        expect(getMessageType({ message: { stickerMessage: {} } })).toBe('sticker')
    })

    test('null message → unknown', () => {
        expect(getMessageType({ message: null })).toBe('unknown')
    })

    test('unrecognised type → unsupported', () => {
        expect(getMessageType({ message: { unknownMessage: {} } })).toBe('unsupported')
    })
})

// ── getMessageBody ────────────────────────────────────────────────────────────

describe('getMessageBody', () => {
    test('returns conversation text', () => {
        expect(getMessageBody({ message: { conversation: 'hello world' } })).toBe('hello world')
    })

    test('returns extendedTextMessage text', () => {
        expect(getMessageBody({ message: { extendedTextMessage: { text: 'hi there' } } })).toBe('hi there')
    })

    test('returns image caption when present', () => {
        expect(getMessageBody({ message: { imageMessage: { caption: 'my photo' } } })).toBe('my photo')
    })

    test('returns [Image] when no caption', () => {
        expect(getMessageBody({ message: { imageMessage: {} } })).toBe('[Image]')
    })

    test('returns [Video] for video without caption', () => {
        expect(getMessageBody({ message: { videoMessage: {} } })).toBe('[Video]')
    })

    test('returns [Audio] for audio', () => {
        expect(getMessageBody({ message: { audioMessage: {} } })).toBe('[Audio]')
    })

    test('returns document caption when present', () => {
        expect(getMessageBody({ message: { documentMessage: { caption: 'Q1 report' } } })).toBe('Q1 report')
    })

    test('returns [Document] when no caption', () => {
        expect(getMessageBody({ message: { documentMessage: {} } })).toBe('[Document]')
    })

    test('returns [Sticker] for sticker', () => {
        expect(getMessageBody({ message: { stickerMessage: {} } })).toBe('[Sticker]')
    })

    test('returns [Empty] for null message', () => {
        expect(getMessageBody({ message: null })).toBe('[Empty]')
    })
})

// ── getFileExtension ──────────────────────────────────────────────────────────

describe('getFileExtension', () => {
    test('image/jpeg → jpg', () => {
        expect(getFileExtension({ mimetype: 'image/jpeg' }, 'image')).toBe('jpg')
    })

    test('image/png → png', () => {
        expect(getFileExtension({ mimetype: 'image/png' }, 'image')).toBe('png')
    })

    test('application/pdf → pdf', () => {
        expect(getFileExtension({ mimetype: 'application/pdf' }, 'document')).toBe('pdf')
    })

    test('docx MIME → docx', () => {
        expect(getFileExtension({
            mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }, 'document')).toBe('docx')
    })

    test('uses fileName extension for documents', () => {
        expect(getFileExtension({ mimetype: 'application/octet-stream', fileName: 'report.xlsx' }, 'document')).toBe('xlsx')
    })

    test('falls back to messageType for unknown MIME', () => {
        expect(getFileExtension({ mimetype: 'application/x-custom' }, 'document')).toBe('document')
    })

    test('audio/ogg → ogg', () => {
        expect(getFileExtension({ mimetype: 'audio/ogg' }, 'audio')).toBe('ogg')
    })
})

// ── hkdf ─────────────────────────────────────────────────────────────────────

describe('hkdf', () => {
    const key = Buffer.from('test-media-key-32-bytes-long!!!!')

    test('returns Buffer of exact requested length', () => {
        const result = hkdf(key, 112, 'WhatsApp Image Keys')
        expect(Buffer.isBuffer(result)).toBe(true)
        expect(result.length).toBe(112)
    })

    test('is deterministic for same inputs', () => {
        const r1 = hkdf(key, 112, 'WhatsApp Image Keys')
        const r2 = hkdf(key, 112, 'WhatsApp Image Keys')
        expect(r1.equals(r2)).toBe(true)
    })

    test('produces different output for different info strings', () => {
        const r1 = hkdf(key, 112, 'WhatsApp Image Keys')
        const r2 = hkdf(key, 112, 'WhatsApp Video Keys')
        expect(r1.equals(r2)).toBe(false)
    })

    test('produces different output for different keys', () => {
        const r1 = hkdf(Buffer.from('key-one'), 32, 'WhatsApp Image Keys')
        const r2 = hkdf(Buffer.from('key-two'), 32, 'WhatsApp Image Keys')
        expect(r1.equals(r2)).toBe(false)
    })
})

// ── buildGCSDestPath ──────────────────────────────────────────────────────────

describe('buildGCSDestPath', () => {
    test('group message uses group id as top-level folder', () => {
        const result = buildGCSDestPath('/media/abc.jpg', 'MSG001', '120363123456@g.us', UNIX_MAY_13)
        expect(result).toBe('120363123456/2026/05/13/MSG001.jpg')
    })

    test('direct message uses "direct" folder', () => {
        const result = buildGCSDestPath('/media/abc.pdf', 'MSG002', null, UNIX_MAY_13)
        expect(result).toBe('direct/2026/05/13/MSG002.pdf')
    })

    test('strips @g.us suffix from group id', () => {
        const result = buildGCSDestPath('/media/file.mp4', 'MSG003', '999888777@g.us', UNIX_MAY_13)
        expect(result.startsWith('999888777/')).toBe(true)
    })

    test('pads single-digit month and day with zeros', () => {
        const result = buildGCSDestPath('/media/img.png', 'MSG004', null, UNIX_JAN_05)
        expect(result).toBe('direct/2026/01/05/MSG004.png')
    })

    test('preserves file extension from filepath', () => {
        const result = buildGCSDestPath('/tmp/file.docx', 'MSG005', null, UNIX_MAY_13)
        expect(result.endsWith('.docx')).toBe(true)
    })
})

// ── buildWebhookPayload ───────────────────────────────────────────────────────

describe('buildWebhookPayload', () => {
    const base = {
        from:        '628512152526@s.whatsapp.net',
        senderName:  'Jun Rong',
        groupId:     '120363123456@g.us',
        messageId:   'MSGABC123',
        body:        'hello',
        messageType: 'text',
        timestamp:   UNIX_MAY_13 * 1000,
    }

    test('top-level object is whatsapp_business_account', () => {
        expect(buildWebhookPayload(base).object).toBe('whatsapp_business_account')
    })

    test('entry field is messages', () => {
        const payload = buildWebhookPayload(base)
        expect(payload.entry[0].changes[0].field).toBe('messages')
    })

    test('strips @s.whatsapp.net from sender', () => {
        const msg = buildWebhookPayload(base).entry[0].changes[0].value.messages[0]
        expect(msg.from).toBe('628512152526')
    })

    test('includes group_id for group messages', () => {
        const msg = buildWebhookPayload(base).entry[0].changes[0].value.messages[0]
        expect(msg.group_id).toBe('120363123456@g.us')
    })

    test('omits group_id for direct messages', () => {
        const msg = buildWebhookPayload({ ...base, groupId: null }).entry[0].changes[0].value.messages[0]
        expect(msg.group_id).toBeUndefined()
    })

    test('adds text.body for text type', () => {
        const msg = buildWebhookPayload(base).entry[0].changes[0].value.messages[0]
        expect(msg.text).toEqual({ body: 'hello' })
    })

    test('adds image.caption for image type', () => {
        const msg = buildWebhookPayload({ ...base, messageType: 'image', body: 'sunset pic' })
            .entry[0].changes[0].value.messages[0]
        expect(msg.image).toEqual({ caption: 'sunset pic' })
    })

    test('adds video.caption for video type', () => {
        const msg = buildWebhookPayload({ ...base, messageType: 'video', body: 'funny clip' })
            .entry[0].changes[0].value.messages[0]
        expect(msg.video).toEqual({ caption: 'funny clip' })
    })

    test('adds document.caption for document type', () => {
        const msg = buildWebhookPayload({ ...base, messageType: 'document', body: 'Q1 report' })
            .entry[0].changes[0].value.messages[0]
        expect(msg.document).toEqual({ caption: 'Q1 report' })
    })

    test('contact profile name matches senderName', () => {
        const contact = buildWebhookPayload(base).entry[0].changes[0].value.contacts[0]
        expect(contact.profile.name).toBe('Jun Rong')
    })

    test('timestamp is stringified unix seconds', () => {
        const msg = buildWebhookPayload(base).entry[0].changes[0].value.messages[0]
        expect(msg.timestamp).toBe(String(UNIX_MAY_13))
    })
})
