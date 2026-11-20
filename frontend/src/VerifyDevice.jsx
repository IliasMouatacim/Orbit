import { useState } from 'react'

export function VerifyDevice({ name, localCode, expectedCode, onVerify }) {
  const [error, setError] = useState('')
  function verify(event) {
    event.preventDefault()
    const code = new FormData(event.currentTarget).get('code').replace(/\s/g, '').toLowerCase()
    if (code !== expectedCode.replace(/ /g, '')) {
      setError('The code does not match. Check the full code with the other person.')
      return
    }
    onVerify()
  }
  return (
    <form className="verify-device" onSubmit={verify}>
      <strong>Verify {name} before sending a direct message</strong>
      <p>Exchange codes in person or through a trusted channel outside Orbit. Give them your code:</p>
      <code>{localCode}</code>
      <label htmlFor="peer-code">Their verification code</label>
      <div>
        <input id="peer-code" name="code" required autoComplete="off" spellCheck={false}
          onChange={() => setError('')} maxLength={80} />
        <button className="secondary-button" type="submit">Verify device</button>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  )
}
