const { Storage } = require('@google-cloud/storage')
const fs = require('fs')
const path = require('path')

const AUTH_PREFIX    = '_auth/'
const AUTH_LOCAL_DIR = '/tmp/auth_info_baileys'

async function downloadAuthFromGCS(bucketName) {
    const storage = new Storage()
    fs.mkdirSync(AUTH_LOCAL_DIR, { recursive: true })

    try {
        const [files] = await storage.bucket(bucketName).getFiles({ prefix: AUTH_PREFIX })
        for (const file of files) {
            const dest = path.join(AUTH_LOCAL_DIR, path.basename(file.name))
            await file.download({ destination: dest })
        }
        console.log(`[AUTH] Downloaded ${files.length} auth file(s) from GCS`)
    } catch (e) {
        console.log('[AUTH] No existing auth state in GCS — starting fresh (QR scan required)')
    }

    return AUTH_LOCAL_DIR
}

async function uploadAuthToGCS(bucketName) {
    const storage = new Storage()

    try {
        const files = fs.readdirSync(AUTH_LOCAL_DIR)
        await Promise.all(files.map(file =>
            storage.bucket(bucketName).upload(path.join(AUTH_LOCAL_DIR, file), {
                destination: `${AUTH_PREFIX}${file}`,
            })
        ))
        console.log(`[AUTH] Synced ${files.length} auth file(s) to GCS`)
    } catch (e) {
        console.error(`[AUTH] Failed to sync auth to GCS: ${e.message}`)
    }
}

module.exports = { downloadAuthFromGCS, uploadAuthToGCS }
