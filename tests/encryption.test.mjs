import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDevice, decryptText, encryptText, openRoom } from '../frontend/src/chatCrypto.js'

test('only the intended device can authenticate a DM in its original context', () => {
  const alice = createDevice(), bob = createDevice(), outsider = createDevice()
  const context = ['direct', 'alice', 'bob']
  const packet = encryptText(alice.peerKey('bob', bob.publicKey), context, 'hello')
  const key = bob.peerKey('alice', alice.publicKey)
  assert.equal(decryptText(key, context, packet), 'hello')
  assert.throws(() => decryptText(outsider.peerKey('alice', alice.publicKey), context, packet))
  assert.throws(() => decryptText(key, ['global', 'alice', 'bob'], packet))
  assert.throws(() => bob.peerKey('alice', outsider.publicKey))
  assert.throws(() => bob.peerKey('invalid', Buffer.alloc(32).toString('base64')))
})

test('room labels and routing identifiers cannot recover an invitation key', () => {
  const room = openRoom('Friends')
  const invited = openRoom(room.invite)
  const context = ['room', 'alice', room.id]
  const packet = encryptText(room.key, context, 'hello')
  assert.equal(decryptText(invited.key, context, packet), 'hello')
  for (const input of ['Friends', room.id]) {
    assert.throws(() => decryptText(openRoom(input).key, context, packet))
  }
})
