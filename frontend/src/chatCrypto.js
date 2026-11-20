import nacl from 'tweetnacl'

const encode = bytes => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}
const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0))
const utf8 = new TextEncoder()
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

export function createDevice() {
  const pair = nacl.box.keyPair()
  const peers = new Map()
  return {
    publicKey: encode(pair.publicKey),
    peerKey(id, publicKey) {
      const previous = peers.get(id)
      if (previous) {
        if (previous.publicKey !== publicKey) throw new Error('Device key changed')
        return previous.key
      }
      const point = decode(publicKey)
      if (!nacl.scalarMult(pair.secretKey, point).some(Boolean)) throw new Error('Invalid device key')
      const key = nacl.box.before(point, pair.secretKey)
      peers.set(id, { key, publicKey })
      return key
    },
  }
}

export function safetyCode(sender, recipient) {
  const input = JSON.stringify(['Orbit DM verification v2', sender, recipient])
  return hex(nacl.hash(utf8.encode(input)).slice(0, 16)).match(/.{4}/g).join(' ')
}

export function openRoom(input) {
  const [rawLabel, secret, ...extra] = input.trim().split('~')
  const label = rawLabel.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
  if (!label || extra.length || (secret !== undefined && !/^[0-9a-f]{64}$/.test(secret))) {
    throw new Error('Enter a room name or paste the complete invitation.')
  }
  const key = secret === undefined ? nacl.randomBytes(32) :
    Uint8Array.from(secret.match(/../g), byte => parseInt(byte, 16))
  return { label, key, id: hex(nacl.hash(key).slice(0, 16)), invite: label + '~' + hex(key) }
}

export function encryptText(key, context, text) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
  const content = utf8.encode(JSON.stringify(['Orbit text v1', ...context, text]))
  return { nonce: encode(nonce), box: encode(nacl.secretbox(content, nonce, key)) }
}

export function decryptText(key, context, packet, maxLength = 500) {
  const bytes = nacl.secretbox.open(decode(packet.box), decode(packet.nonce), key)
  if (!bytes) throw new Error('Message authentication failed')
  const fields = JSON.parse(new TextDecoder().decode(bytes))
  const text = fields.pop()
  if (JSON.stringify(fields) !== JSON.stringify(['Orbit text v1', ...context]) ||
      typeof text !== 'string' || text.length > maxLength) throw new Error('Invalid message')
  return text
}

export function sealSignal(call, type, from, to, data) {
  return { callId: call.id, ...encryptText(call.key, ['call', call.id, type, from, to], JSON.stringify(data)) }
}

export function openSignal(call, type, from, to, packet) {
  if (packet?.callId !== call.id || typeof packet.box !== 'string' || packet.box.length > 131072) return null
  try {
    return JSON.parse(decryptText(call.key, ['call', call.id, type, from, to], packet, 65536))
  } catch { return null }
}
