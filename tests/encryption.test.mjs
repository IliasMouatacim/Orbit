import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDevice, decryptText, encryptText, openRoom, openSignal, sealSignal } from '../frontend/src/chatCrypto.js'

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

test('call negotiation is bound to the device pair, call ID, direction, and signal type', () => {
  const alice = createDevice(), bob = createDevice()
  const call = { id: 'call-one', key: alice.peerKey('bob', bob.publicKey) }
  const recipient = { id: call.id, key: bob.peerKey('alice', alice.publicKey) }
  const offer = { type: 'offer', sdp: 'private session description' }
  const packet = sealSignal(call, 'offer', 'alice', 'bob', offer)
  assert.ok(!JSON.stringify(packet).includes(offer.sdp))
  assert.deepEqual(openSignal(recipient, 'offer', 'alice', 'bob', packet), offer)
  assert.equal(openSignal(recipient, 'answer', 'alice', 'bob', packet), null)
  assert.equal(openSignal(recipient, 'offer', 'bob', 'alice', packet), null)
  assert.equal(openSignal({ ...recipient, id: 'call-two' }, 'offer', 'alice', 'bob', packet), null)
})
