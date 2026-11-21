import { createDevice, decryptText, encryptText, openRoom, openSignal, safetyCode, sealSignal } from './chatCrypto'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './App.css'
import { Brand, Icon } from './Icons'

const defaultIceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
]

const VIDEO_CONSTRAINTS = {
  video: {
    width: { ideal: 1920, min: 640 },
    height: { ideal: 1080, min: 480 },
    frameRate: { ideal: 30, max: 60 },
  },
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
}

const getMediaStream = async () => {
  try {
    return await navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS)
  } catch (err) {
    if (err.name === 'OverconstrainedError') {
      return await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: true,
      })
    }
    throw err
  }
}

const enforceHighQualityVideo = async (peer) => {
  if (!peer) return
  const videoSender = peer.getSenders?.().find(s => s.track && s.track.kind === 'video')
  if (!videoSender) return
  try {
    const params = videoSender.getParameters()
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}]
    }
    params.degradationPreference = 'maintain-resolution'
    params.encodings.forEach((enc) => {
      enc.maxBitrate = 4000000
      enc.maxFramerate = 30
      enc.scaleResolutionDownBy = 1.0
    })
    await videoSender.setParameters(params)
  } catch { /* This optional browser feature may be unavailable. */ }
}

const ACCESS_OPTIONS = [
  { value: 'guest', label: 'Guest' },
  { value: 'login', label: 'Sign in' },
  { value: 'register', label: 'Create account' },
]

const loadSavedSession = () => {
  try {
    localStorage.removeItem('orbit_session') // Retire credentials saved by older clients.
    const raw = sessionStorage.getItem('orbit_session')
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.name === 'string' && typeof parsed.token === 'string') {
      return parsed
    }
  } catch { /* This optional browser feature may be unavailable. */ }
  return null
}

const buildIceServers = () => {
  const {
    VITE_ICE_SERVERS,
    VITE_TURN_URL,
    VITE_TURN_USERNAME,
    VITE_TURN_CREDENTIAL,
  } = import.meta.env

  if (VITE_ICE_SERVERS) {
    try {
      const parsed = JSON.parse(VITE_ICE_SERVERS)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed
      }
      console.warn(
        'VITE_ICE_SERVERS must be a non-empty JSON array. Falling back to defaults.',
      )
    } catch (error) {
      console.warn(
        'Failed to parse VITE_ICE_SERVERS JSON. Falling back to defaults.',
        error,
      )
    }
  }

  if (VITE_TURN_URL) {
    return [
      ...defaultIceServers,
      {
        urls: VITE_TURN_URL,
        username: VITE_TURN_USERNAME || '',
        credential: VITE_TURN_CREDENTIAL || '',
      },
    ]
  }

  return defaultIceServers
}

function App() {
  const apiUrl = import.meta.env.VITE_API_URL
  const [initialSession] = useState(loadSavedSession)
  const savedSession = useRef(initialSession)
  const device = useMemo(createDevice, [])
  const socket = useMemo(() => io(apiUrl, {
    autoConnect: false,
    auth: {
      publicKey: device.publicKey,
      token: savedSession.current?.token,
    },
  }), [apiUrl, device])
  const roomKeys = useRef(new Map())
  const peers = useRef(new Map())
  const sending = useRef(false)
  const iceServers = useMemo(() => buildIceServers(), [])

  const [name, setName] = useState(() => savedSession.current?.name || '')
  const [mode, setMode] = useState('guest')
  const [accessMenuOpen, setAccessMenuOpen] = useState(false)
  const accessMenuRef = useRef(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [accountError, setAccountError] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [joined, setJoined] = useState(() => Boolean(savedSession.current?.token))
  const [messages, setMessages] = useState({ global: [] })
  const [activeChat, setActiveChat] = useState('global')
  const [unread, setUnread] = useState({})
  const [draft, setDraft] = useState('')
  const [roomCodeInput, setRoomCodeInput] = useState('')
  const [connected, setConnected] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(
    () => window.innerWidth >= 1200,
  )
  const searchRef = useRef(null)
  const [messageSearch, setMessageSearch] = useState(null)
  const messageSearchButton = useRef(null)
  const [search, setSearch] = useState('')
  const [roomError, setRoomError] = useState('')
  const [notice, setNotice] = useState('')
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia('(max-width: 760px)').matches,
  )
  const [isFullscreen, setIsFullscreen] = useState(false)

  // New state
  const [onlineUsers, setOnlineUsers] = useState([])
  const [joinedRooms, setJoinedRooms] = useState([])
  const [typingUsers, setTypingUsers] = useState(new Set())

  // WebRTC state
  const [stream, setStream] = useState(null)
  const [remoteStream, setRemoteStream] = useState(null)
  const [receivingCall, setReceivingCall] = useState(false)
  const [caller, setCaller] = useState(null)
  const [callerName, setCallerName] = useState('')
  const [callerSignal, setCallerSignal] = useState(null)
  const [callAccepted, setCallAccepted] = useState(false)
  const [callEnded, setCallEnded] = useState(false)
  const [callPartner, setCallPartner] = useState(null)
  const [callError, setCallError] = useState('')

  const listRef = useRef(null)
  const typingTimeoutRef = useRef(null)
  const isTypingRef = useRef(false)
  const activeChatRef = useRef('global')
  const localVideo = useRef(null)
  const remoteVideo = useRef(null)
  const currentCall = useRef(null)
  const connectionRef = useRef(null)
  const iceCandidateQueue = useRef([])
  const remoteDescSet = useRef(false)

  const [ownSocketIds, setOwnSocketIds] = useState(() => new Set())
  const identityRef = useRef(savedSession.current?.name || null)
  const roomsRef = useRef([])
  const streamRef = useRef(null)
  const draftsRef = useRef({})
  const nearBottomRef = useRef(true)

  useEffect(() => {
    if (!joined || isMobile) return
    const focusSearch = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !document.querySelector('[aria-modal="true"]')) {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [joined, isMobile])

  const closeNavigation = () => {
    setSidebarOpen(false)
    if (isMobile)
      requestAnimationFrame(() =>
        document.querySelector('.menu-toggle')?.focus(),
      )
  }

  const selectChat = (chat) => {
    draftsRef.current[activeChatRef.current] = draft
    setDraft(draftsRef.current[chat] || '')
    nearBottomRef.current = true
    clearTimeout(typingTimeoutRef.current)
    if (isTypingRef.current) socket.emit('stop_typing')
    isTypingRef.current = false
    activeChatRef.current = chat
    setActiveChat(chat)
    setMessageSearch(null)
    closeNavigation()
    setNotice('')
    setUnread((prev) => ({ ...prev, [chat]: 0 }))
  }

  useEffect(() => {
    const onConnect = () => {
      setConnected(true)
      setOwnSocketIds((previous) => new Set([...previous, socket.id]))
      if (identityRef.current) socket.emit('join_room', identityRef.current)
      roomsRef.current.forEach((room) => socket.emit('join_private_room', room))
    }
    const onDisconnect = (reason) => {
      onEndCall()
      setConnected(false)
      if (socket.auth?.token && (reason === 'io server disconnect' || reason?.message === 'Session expired')) {
        try { sessionStorage.removeItem('orbit_session') } catch { /* This optional browser feature may be unavailable. */ }
        socket.auth = { publicKey: device.publicKey }
        identityRef.current = ''
        setName('')
        setJoined(false)
        window.location.reload() // Discard transcripts, room keys and device identity.
        return
      }
    }
    socket.on('disconnect', onDisconnect)
    socket.on('connect_error', onDisconnect)
    socket.on('connect', onConnect)
    socket.connect()

    const onMessage = (message) => {
      setMessages((prev) => ({
        ...prev,
        global: [...(prev.global || []), message],
      }))
      if (activeChatRef.current !== 'global') {
        setUnread((prev) => ({ ...prev, global: (prev.global || 0) + 1 }))
      }
    }

    const onPrivateMessage = (message) => {
      const isMe = message.from === socket.id
      const chatId = isMe ? message.to : message.from

      setMessages((prev) => ({
        ...prev,
        [chatId]: [...(prev[chatId] || []), message],
      }))

      if (activeChatRef.current !== chatId && !isMe) {
        setUnread((prev) => ({ ...prev, [chatId]: (prev[chatId] || 0) + 1 }))
      }
    }

    const onRoomMessage = (message) => {
      const room = message.room ? `room_${message.room}` : null
      if (!room && message.system) return // Safety fallback

      const chatId = room || activeChatRef.current
      const isMe = message.from === socket.id

      setMessages((prev) => ({
        ...prev,
        [chatId]: [...(prev[chatId] || []), message],
      }))

      if (activeChatRef.current !== chatId && !isMe) {
        setUnread((prev) => ({ ...prev, [chatId]: (prev[chatId] || 0) + 1 }))
      }
    }

    const onOnlineUsers = (users) => {
      const directory = new Map()
      for (const user of users) {
        if (!user.joined || (user.id !== socket.id && user.publicKey === device.publicKey)) continue
        try {
          const key = device.peerKey(user.id, user.publicKey)
          const local = [socket.id, identityRef.current, device.publicKey]
          const remote = [user.id, user.name, user.publicKey]
          const outgoing = safetyCode(local, remote)
          const incoming = safetyCode(remote, local)
          const previous = peers.current.get(user.id)
          directory.set(user.id, { ...user, key, outgoing, incoming,
            verified: previous?.incoming === incoming && previous.verified })

        } catch { /* Invalid or substituted keys cannot receive messages. */ }
      }
      peers.current = directory
      setOnlineUsers([...directory.values()])
    }

    const onUserTyping = (userName) => {
      setTypingUsers((prev) => {
        const next = new Set(prev)
        next.add(userName)
        return next
      })
    }

    const onUserStopTyping = (userName) => {
      setTypingUsers((prev) => {
        const next = new Set(prev)
        next.delete(userName)
        return next
      })
    }

    const offers = new Set()
    const onCallUser = (data) => {
      const sender = peers.current.get(data.from)
      if (currentCall.current || !sender?.verified || !data.signal?.callId) return
      const call = { id: data.signal.callId, peer: sender.id, key: sender.key }
      const offer = openSignal(call, 'offer', sender.id, socket.id, data.signal)
      if (offer?.type !== 'offer' || offers.has(call.id)) return
      offers.add(call.id)
      currentCall.current = call
      setReceivingCall(true)
      setCallEnded(false)
      setCaller(data.from)
      setCallerName(sender.name)
      setCallerSignal(offer)
      setCallPartner(data.from)
      remoteDescSet.current = false
      iceCandidateQueue.current = [] // Clear any stale candidates
    }

    const onCallAccepted = async (packet) => {
      const call = currentCall.current
      if (!call) return
      const signal = openSignal(call, 'answer', call.peer, socket.id, packet)
      if (signal?.type !== 'answer' || connectionRef.current?.signalingState !== 'have-local-offer') return
      setCallAccepted(true)
      if (connectionRef.current) {
        await connectionRef.current.setRemoteDescription(
          new RTCSessionDescription(signal),
        )
        remoteDescSet.current = true
        enforceHighQualityVideo(connectionRef.current)
        for (const candidate of iceCandidateQueue.current) {
          try {
            await connectionRef.current.addIceCandidate(
              new RTCIceCandidate(candidate),
            )
          } catch (e) {
            console.error('Error adding queued ice candidate', e)
          }
        }
        iceCandidateQueue.current = []
      }
    }

    const onIceCandidate = async (data) => {
      const call = currentCall.current
      if (!call || call.peer !== data.from) return
      const candidate = openSignal(call, 'ice', data.from, socket.id, data.candidate)
      if (!candidate) return
      if (!connectionRef.current || !remoteDescSet.current) {
        if (iceCandidateQueue.current.length < 128) iceCandidateQueue.current.push(candidate)
        return
      }

      try {
        await connectionRef.current.addIceCandidate(
          new RTCIceCandidate(candidate),
        )
      } catch (e) {
        console.error('Error adding received ice candidate', e)
      }
    }

    const onEndCall = () => {
      currentCall.current = null
      setCallEnded(true)
      if (connectionRef.current) {
        connectionRef.current.close()
      }
      connectionRef.current = null
      remoteDescSet.current = false
      iceCandidateQueue.current = []
      setReceivingCall(false)
      setCallAccepted(false)
      setCaller(null)
      setCallPartner(null)
      setRemoteStream(null)
      setStream((prev) => {
        if (prev) prev.getTracks().forEach((t) => t.stop())
        return null
      })
      try {
        if (typeof document !== 'undefined' && document.fullscreenElement && document.exitFullscreen) {
          document.exitFullscreen().catch(() => {})
        }
      } catch { /* This optional browser feature may be unavailable. */ }
    }

    const seen = new Set()
    const onEncrypted = packet => {
      const { kind, from, to, target, nonce } = packet
      const sender = peers.current.get(from)
      const room = roomKeys.current.get(target)
      if (!sender || (kind === 'direct' && !sender.verified) || (kind === 'room' ? !room : to !== socket.id)) return
      try {
        const text = decryptText(kind === 'room' ? room.key : sender.key, [kind, from, to], packet)
        const id = from + ':' + nonce
        if (seen.has(id)) return
        seen.add(id)
        const message = { id, from, to, text, user: sender.name, timestamp: packet.timestamp }
        if (kind === 'room') onRoomMessage({ ...message, room: target })
        else if (kind === 'global') onMessage(message)
        else if (kind === 'direct') onPrivateMessage(message)
      } catch { /* Never render unauthenticated text. */ }
    }
    const onSystem = message => { if (message.system === true) onMessage(message) }
    const onRoomSystem = message => {
      if (message.system === true && roomKeys.current.has(message.room)) onRoomMessage(message)
    }
    socket.on('encrypted_text', onEncrypted)
    socket.on('chat_message', onSystem)
    socket.on('room_message', onRoomSystem)
    socket.on('online_users', onOnlineUsers)
    socket.on('user_typing', onUserTyping)
    socket.on('user_stop_typing', onUserStopTyping)
    socket.on('call_user', onCallUser)
    socket.on('call_accepted', onCallAccepted)
    socket.on('ice_candidate', onIceCandidate)
    socket.on('end_call', onEndCall)

    return () => {
      socket.off('disconnect', onDisconnect)
      socket.off('connect_error', onDisconnect)
      socket.off('connect', onConnect)
      clearTimeout(typingTimeoutRef.current)
      connectionRef.current?.close()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      socket.off('chat_message', onSystem)
      socket.off('encrypted_text', onEncrypted)
      socket.off('room_message', onRoomSystem)
      socket.off('online_users', onOnlineUsers)
      socket.off('user_typing', onUserTyping)
      socket.off('user_stop_typing', onUserStopTyping)
      socket.off('call_user', onCallUser)
      socket.off('call_accepted', onCallAccepted)
      socket.off('ice_candidate', onIceCandidate)
      socket.off('end_call', onEndCall)
      socket.disconnect()
    }
  }, [socket, device])

  useEffect(() => {
    if (listRef.current && nearBottomRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages, typingUsers, activeChat])

  useEffect(() => {
    if (remoteVideo.current && remoteStream) {
      remoteVideo.current.srcObject = remoteStream
      remoteVideo.current.play().catch(() => {
        // Browsers can block autoplay with sound until user interaction.
        // The call accept/start button generally provides interaction, so ignore failures.
      })
    }
  }, [remoteStream, callAccepted])

  useEffect(() => {
    if (localVideo.current && stream) {
      localVideo.current.srcObject = stream
      localVideo.current.play().catch(() => {
        // Browsers can block autoplay with sound until user interaction.
        // The call accept/start button generally provides interaction, so ignore failures.
      })
    }
  }, [stream])

  useEffect(() => {
    if (!sidebarOpen || !isMobile) return
    const closeOnEscape = (event) => {
      if (event.key === 'Tab') {
        const items = [
          ...document.querySelectorAll(
            '#chat-navigation button:not(:disabled), #chat-navigation input',
          ),
        ].filter((item) => item.getClientRects().length)
        const first = items[0],
          last = items[items.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }
      if (event.key === 'Escape') {
        setSidebarOpen(false)
        requestAnimationFrame(() =>
          document.querySelector('.menu-toggle')?.focus(),
        )
      }
    }
    document.addEventListener('keydown', closeOnEscape)
    document.querySelector('#chat-navigation .mobile-only')?.focus()
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [sidebarOpen, isMobile])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const onChange = (event) => setIsMobile(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  const toggleFullscreen = () => {
    try {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {})
      } else {
        document.exitFullscreen?.().catch(() => {})
      }
    } catch { /* This optional browser feature may be unavailable. */ }
  }

  useEffect(() => {
    if (!accessMenuOpen) return
    const handleClickOutside = (event) => {
      if (accessMenuRef.current && !accessMenuRef.current.contains(event.target)) {
        setAccessMenuOpen(false)
      }
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setAccessMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [accessMenuOpen])

  const handleSelectMode = (nextMode) => {
    if (nextMode === 'login' && name.includes('@')) setName('')
    setEmail('')
    setMode(nextMode)
    setAccountError('')
    setPassword('')
    setAccessMenuOpen(false)
  }

  useEffect(() => {
    if (!joined || !(receivingCall || stream || callAccepted)) return
    const dialog = document.querySelector(
      '.active-call-overlay, .call-modal-overlay',
    )
    const previousFocus = document.activeElement
    const focusFrame = requestAnimationFrame(() =>
      dialog?.querySelector('button')?.focus(),
    )
    const trapFocus = (event) => {
      if (event.key !== 'Tab') return
      const buttons = [...dialog.querySelectorAll('button:not(:disabled)')]
      const first = buttons[0],
        last = buttons[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    dialog?.addEventListener('keydown', trapFocus)
    return () => {
      cancelAnimationFrame(focusFrame)
      dialog?.removeEventListener('keydown', trapFocus)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [joined, receivingCall, stream, callAccepted])

  const joinRoom = async (event) => {
    event.preventDefault()
    const cleanName = mode === 'guest' ? name.trim().slice(0, 24) : name.trim()
    if (!cleanName || !connected) {
      return
    }
    setAccountError('')
    if (mode !== 'guest') {
      setAuthBusy(true)
      try {
        const endpoint = new URL(apiUrl, window.location.href)
        if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
          throw new Error('Account access requires an HTTPS backend.')
        }
        const response = await fetch(new URL('/accounts/' + mode, endpoint), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: cleanName, email: mode === 'register' ? email.trim() : undefined, password }),
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Account request failed.')
        socket.disconnect()
        socket.auth = { publicKey: device.publicKey, token: data.token }
        identityRef.current = data.name
        try {
          sessionStorage.setItem('orbit_session', JSON.stringify({ name: data.name, token: data.token }))
        } catch { /* This optional browser feature may be unavailable. */ }
        setName(data.name)
        setEmail('')
        setPassword('')
        setJoined(true)
        socket.connect()
      } catch (error) {
        setAccountError(error.message)
      } finally {
        setAuthBusy(false)
      }
      return
    }
    if (cleanName.startsWith('@')) {
      setAccountError('Account handles start with @. Choose another guest name.')
      return
    }
    identityRef.current = cleanName
    socket.emit('join_room', cleanName)
    setName(cleanName)
    setJoined(true)
  }

  const joinPrivateRoom = (e) => {
    e.preventDefault()
    if (!connected) return
    let room
    try {
      room = openRoom(roomCodeInput)
    } catch (error) {
      setRoomError(error.message)
      return
    }
    const code = room.id
    roomKeys.current.set(code, room)
    setRoomError('')

    if (!joinedRooms.includes(code)) {
      socket.emit('join_private_room', code)
      roomsRef.current = [...roomsRef.current, code]
      setJoinedRooms(roomsRef.current)
    }

    selectChat(`room_${code}`)
    setRoomCodeInput('')
  }

  const handleDraftChange = (e) => {
    setDraft(e.target.value)

    if (!joined || !connected || activeChat !== 'global') return

    if (!isTypingRef.current) {
      socket.emit('typing')
      isTypingRef.current = true
    }

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
    }

    typingTimeoutRef.current = setTimeout(() => {
      socket.emit('stop_typing')
      isTypingRef.current = false
    }, 1500)
  }

  const callUser = async (idToCall) => {
    const target = peers.current.get(idToCall)
    if (!target?.verified || currentCall.current) return
    try {
      if (typeof document !== 'undefined' && !document.fullscreenElement && document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {})
      }
    } catch { /* This optional browser feature may be unavailable. */ }
    const call = { id: crypto.randomUUID(), peer: idToCall, key: target.key }
    currentCall.current = call
    try {
      setCallError('')
      setCallEnded(false)
      remoteDescSet.current = false
      iceCandidateQueue.current = []
      setCallPartner(idToCall)
      const currentStream = await getMediaStream()
      if (currentCall.current !== call) {
        currentStream.getTracks().forEach(track => track.stop())
        return
      }
      streamRef.current = currentStream
      setStream(currentStream)
      if (localVideo.current) localVideo.current.srcObject = currentStream

      const configuration = { iceServers }
      const peer = new RTCPeerConnection(configuration)
      connectionRef.current = peer

      currentStream
        .getTracks()
        .forEach((track) => peer.addTrack(track, currentStream))
      enforceHighQualityVideo(peer)

      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'connected') {
          enforceHighQualityVideo(peer)
        }
      }

      peer.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice_candidate', {
            to: idToCall,
            candidate: sealSignal(call, 'ice', socket.id, call.peer, event.candidate),
          })
        }
      }

      peer.ontrack = (event) => {
        setRemoteStream(event.streams[0])
        if (remoteVideo.current) {
          remoteVideo.current.srcObject = event.streams[0]
          remoteVideo.current.play().catch(() => {})
        }
      }

      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      enforceHighQualityVideo(peer)
      socket.emit('call_user', {
        userToCall: idToCall,
        signalData: sealSignal(call, 'offer', socket.id, call.peer, offer),
        from: socket.id,
        name,
      })
    } catch (err) {
      leaveCall()
      setCallError(
        'Could not start the call. Check camera and microphone permissions.',
      )
      console.error('Call failed', err)
    }
  }

  const answerCall = async () => {
    const call = currentCall.current
    const target = peers.current.get(caller)
    if (!call || !target) return
    try {
      if (typeof document !== 'undefined' && !document.fullscreenElement && document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {})
      }
    } catch { /* This optional browser feature may be unavailable. */ }
    setCallError('')
    setCallAccepted(true)
    setCallEnded(false)
    remoteDescSet.current = false
    try {
      const currentStream = await getMediaStream()
      if (currentCall.current !== call) {
        currentStream.getTracks().forEach(track => track.stop())
        return
      }
      streamRef.current = currentStream
      setStream(currentStream)
      if (localVideo.current) localVideo.current.srcObject = currentStream

      const configuration = { iceServers }
      const peer = new RTCPeerConnection(configuration)
      connectionRef.current = peer

      currentStream
        .getTracks()
        .forEach((track) => peer.addTrack(track, currentStream))
      enforceHighQualityVideo(peer)

      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'connected') {
          enforceHighQualityVideo(peer)
        }
      }

      peer.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice_candidate', {
            to: caller,
            candidate: sealSignal(call, 'ice', socket.id, call.peer, event.candidate),
          })
        }
      }

      peer.ontrack = (event) => {
        setRemoteStream(event.streams[0])
        if (remoteVideo.current) {
          remoteVideo.current.srcObject = event.streams[0]
          remoteVideo.current.play().catch(() => {})
        }
      }

      await peer.setRemoteDescription(new RTCSessionDescription(callerSignal))
      remoteDescSet.current = true
      for (const candidate of iceCandidateQueue.current) {
        try {
          await peer.addIceCandidate(new RTCIceCandidate(candidate))
        } catch (e) {
          console.error('Error adding queued ice candidate', e)
        }
      }
      iceCandidateQueue.current = []
      const answer = await peer.createAnswer()
      await peer.setLocalDescription(answer)
      enforceHighQualityVideo(peer)

      socket.emit('answer_call', { signal: sealSignal(call, 'answer', socket.id, call.peer, answer), to: caller })
    } catch (err) {
      leaveCall()
      setCallError(
        'Could not answer the call. Check camera and microphone permissions.',
      )
      console.error(err)
    }
  }

  const leaveCall = () => {
    const call = currentCall.current
    currentCall.current = null
    setCallEnded(true)
    if (connectionRef.current) {
      connectionRef.current.close()
    }
    if (call) {
      socket.emit('end_call', { to: call.peer })
    }
    connectionRef.current = null
    remoteDescSet.current = false
    iceCandidateQueue.current = []
    setReceivingCall(false)
    setCallAccepted(false)
    setCaller(null)
    setCallPartner(null)
    setRemoteStream(null)
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setStream(null)
    try {
      if (typeof document !== 'undefined' && document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {})
      }
    } catch { /* This optional browser feature may be unavailable. */ }
  }

  const sendMessage = (event) => {
    event.preventDefault()
    const message = draft.trim()
    if (!message || !joined || !canSend) {
      return
    }

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
    }
    if (isTypingRef.current) {
      socket.emit('stop_typing')
      isTypingRef.current = false
    }

    nearBottomRef.current = true
    if (sending.current) return
    const from = socket.id
    const kind = isRoom ? 'room' : isGlobal ? 'global' : 'direct'
    const target = isRoom ? activeChat.slice(5) : activeChat
    if (kind === 'direct') {
      const currentPeer = peers.current.get(target)
      if (!socket.connected || !currentPeer?.verified || currentPeer.publicKey !== peer.publicKey ||
          currentPeer.name !== peer.name) return
    }
    try {
      const recipients = isGlobal ? [...peers.current.values()] :
        isRoom ? [roomKeys.current.get(target)] : [peers.current.get(target)]
      const deliveries = recipients.map(({ id, key }) => ({
        to: id, ...encryptText(key, [kind, from, id], message),
      }))
      sending.current = true
      socket.timeout(5000).emit('encrypted_text', { kind, target, deliveries }, (error, accepted) => {
        sending.current = false
        if (error || !accepted) {
          setNotice('Delivery could not be confirmed. Your draft is available to retry.')
          return
        }
        if (kind === 'direct' && target !== from) {
          const sent = { id: from + ':' + deliveries[0].nonce, from, to: target, user: identityRef.current, text: message, timestamp: new Date().toISOString() }
          setMessages(previous => ({ ...previous, [target]: [...(previous[target] || []), sent] }))
        }
        if (activeChatRef.current === activeChat) setDraft(value => value === draft ? '' : value)
        else if (draftsRef.current[activeChat] === draft) draftsRef.current[activeChat] = ''
      })
    } catch {
      setNotice('Encryption is unavailable. Your draft has been kept.')
    }
  }

  // Helper to format typing text
  const getTypingText = () => {
    if (typingUsers.size === 0) return null
    const users = Array.from(typingUsers)
    if (users.length === 1) return `${users[0]} is typing...`
    if (users.length === 2) return `${users[0]} and ${users[1]} are typing...`
    return 'Multiple users are typing...'
  }

  const isRoom = activeChat.startsWith('room_')
  const isGlobal = activeChat === 'global'
  const peer = onlineUsers.find((user) => user.id === activeChat)
  const chatTitle = isGlobal
    ? 'Global Room'
    : isRoom
      ? roomKeys.current.get(activeChat.slice(5))?.label
      : peer?.name || 'Disconnected user'
  const chatIcon = isGlobal ? 'globe' : isRoom ? 'hash' : 'chat'
  const canSend = connected && onlineUsers.some(user => user.id === socket.id) && (isGlobal || isRoom || peer?.verified)
  const filteredUsers = onlineUsers.filter((user) =>
    user.name.toLowerCase().includes(search.toLowerCase()),
  )
  const filteredRooms = joinedRooms.filter((room) =>
    roomKeys.current.get(room)?.label.toLowerCase().includes(search.toLowerCase()),
  )
  const chatMessages = messages[activeChat] || []
  const query = messageSearch?.trim().toLowerCase()
  const visibleMessages = query ? chatMessages.filter(message => !message.system &&
    (message.text.toLowerCase().includes(query) || message.user.toLowerCase().includes(query))) : chatMessages
  const closeMessageSearch = () => {
    setMessageSearch(null)
    messageSearchButton.current?.focus()
  }
  const copyRoomCode = async () => {
    try {
      await navigator.clipboard.writeText(roomKeys.current.get(activeChat.slice(5)).invite)
      setNotice('Room code copied. Share it with a friend!')
    } catch {
      setNotice(
        roomKeys.current.get(activeChat.slice(5)).invite,
      )
    }
  }

  if (!joined) {
    return (
      <main className="welcome-page">
        <header className="welcome-nav">
          <Brand />
          <span className="nav-note">
            <span className="status-dot" /> {connected ? 'Connected to Orbit' : 'Connecting…'}
          </span>
        </header>
        <div className="welcome-content">
          <section className="welcome-story">
            <h1>Your chat<br /><em>workspace.</em></h1>
            <p className="welcome-description">
              Join the global conversation, invite friends to a private room, or start a verified direct call.
            </p>
            <div className="welcome-features">
              <span>
                <Icon name="chat" size={17} /> Real-time chat
              </span>
              <span>
                <Icon name="video" size={17} /> Face-to-face calls
              </span>
              <span>
                <Icon name="hash" size={17} /> Your own rooms
              </span>
            </div>
            <div className="orbit-art" aria-hidden="true">
              <div className="orbit-ring ring-one" />
              <div className="orbit-ring ring-two" />
              <div className="orbit-center">
                <Icon name="orbit" size={58} />
              </div>
              <div className="orbit-note note-one">
                <span className="art-avatar">J</span> Hey, you made it!{' '}
                <span>✦</span>
              </div>
              <div className="orbit-note note-two">
                <span className="art-avatar peach">M</span> Always room for one
                more.
              </div>
              <span className="orbit-dot dot-one" />
              <span className="orbit-dot dot-two" />
            </div>
          </section>
          <section className="join-card" aria-labelledby="join-heading">
            <span className="card-icon">
              <Icon name="spark" size={26} />
            </span>

            <h2 id="join-heading">
              Open Orbit
            </h2>
            <p>
              Join as a guest or use your account.

            </p>
            <form className="join-form" onSubmit={joinRoom}>
              <label htmlFor="account-mode">Access</label>
              <div className="access-select" ref={accessMenuRef}>
                <select
                  id="account-mode"
                  disabled={authBusy}
                  value={mode}
                  onChange={(event) => handleSelectMode(event.target.value)}
                  className="access-native-select"
                  tabIndex={-1}
                >
                  <option value="guest">Guest</option>
                  <option value="login">Sign in</option>
                  <option value="register">Create account</option>
                </select>
                <button
                  type="button"
                  id="account-mode-trigger"
                  role="combobox"
                  className={`access-trigger ${accessMenuOpen ? 'open' : ''}`}
                  aria-haspopup="listbox"
                  aria-expanded={accessMenuOpen}
                  aria-controls="account-mode-menu"
                  aria-label="Access mode"
                  disabled={authBusy}
                  onClick={() => setAccessMenuOpen((prev) => !prev)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault()
                      setAccessMenuOpen(true)
                    }
                  }}
                >
                  <span>{ACCESS_OPTIONS.find((opt) => opt.value === mode)?.label || 'Guest'}</span>
                  <span className="access-trigger-arrow" aria-hidden="true" />
                </button>
                {accessMenuOpen && (
                  <ul id="account-mode-menu" className="access-menu" role="listbox" aria-label="Access">
                    {ACCESS_OPTIONS.map((opt) => (
                      <li
                        key={opt.value}
                        role="option"
                        aria-selected={mode === opt.value}
                        className={`access-menu-item ${mode === opt.value ? 'selected' : ''}`}
                        onClick={() => handleSelectMode(opt.value)}
                      >
                        <span>{opt.label}</span>
                        {mode === opt.value && <Icon name="check" size={15} />}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <label htmlFor="display-name">{mode === 'guest' ? 'What should we call you?' : mode === 'login' ? 'Username or email' : 'Username'}</label>
              <input
                id="display-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={mode === 'guest' ? 'Enter your display name' : undefined}
                maxLength={mode === 'login' ? 254 : 24}
                autoComplete={mode === 'guest' ? 'nickname' : 'username'}
                pattern={mode === 'register' ? '[A-Za-z0-9_]{3,23}' : undefined}
                required
              />
              {mode === 'register' && <>
                <label htmlFor="account-email">Email (optional)</label>
                <input id="account-email" type="email" autoComplete="email" maxLength={254}
                  value={email} onChange={(event) => setEmail(event.target.value)} />
              </>}
              {mode !== 'guest' && <>
                <label htmlFor="account-password">Password (at least 12 characters)</label>
                <input id="account-password" type="password" minLength={12} required
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  value={password} onChange={(event) => setPassword(event.target.value)} />
              </>}
              {accountError && <p role="alert">{accountError}</p>}
              <button
                className="primary-button"
                type="submit"
                disabled={authBusy || !name.trim() || !connected}
              >
                {mode === 'guest' ? 'Join Space' : mode === 'login' ? 'Sign in' : 'Create account'} <Icon name="arrow" />
              </button>
            </form>
            <div
              className={`connection-note ${connected ? '' : 'is-offline'}`}
              role="status"
            >
              <span className="status-dot" />
              {connected ? 'Ready when you are' : 'Connecting to your space…'}
            </div>
            <div className="join-card-footer">
              <Icon name="people" size={18} />
              <span>Guest names are temporary. Sign in to keep your handle.</span>
            </div>
          </section>
        </div>
        <footer className="welcome-footer">

          {import.meta.env.MODE !== 'desktop' && (
            <a href="/downloads/orbit-chat-windows-x64.zip" download>Download for Windows (x64)</a>
          )}
        </footer>
      </main>
    )
  }

  return (
    <main
      className={`app-layout ${sidebarOpen ? 'nav-open' : ''} ${detailsOpen ? 'details-open' : ''}`}
    >
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={closeNavigation}
        />
      )}
      <aside
        className="sidebar"
        id="chat-navigation"
        aria-label="Conversations"
        role={isMobile && sidebarOpen ? 'dialog' : undefined}
        aria-modal={isMobile && sidebarOpen ? true : undefined}
      >
        <div className="sidebar-header">
          <Brand />
          <button
            className="icon-button mobile-only"
            aria-label="Close navigation"
            onClick={closeNavigation}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="workspace-label">
          <span className="workspace-symbol">O</span>
          <div>
            Your workspace<small>Make yourself at home</small>
          </div>
          <Icon name="spark" size={16} />
        </div>
        <label className="search-field">
          <Icon name="search" size={17} />
          <input
            ref={searchRef}
            aria-keyshortcuts="Control+K Meta+K"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find people or rooms"
            aria-label="Find people or rooms"
          />
          {!search && !isMobile && <kbd aria-hidden="true">{navigator.platform.includes('Mac') ? '⌘ K' : 'Ctrl K'}</kbd>}
          {search && (
            <button
              className="clear-search"
              aria-label="Clear search"
              onClick={() => setSearch('')}
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </label>
        <nav className="user-list" aria-label="Spaces and people">
          <div className="menu-section-header">
            YOUR SPACES <span>{joinedRooms.length + 1}</span>
          </div>
          {(!search || 'global room'.includes(search.toLowerCase())) && (
            <button
              className={`user-item menu-cta ${isGlobal ? 'active' : ''}`}
              aria-current={isGlobal ? 'page' : undefined}
              onClick={() => selectChat('global')}
            >
              <span className="item-icon">
                <Icon name="globe" />
              </span>
              <span className="item-label">
                Global Room<small>A little bit of everyone</small>
              </span>
              {unread.global > 0 && (
                <span className="unread-badge">{unread.global}</span>
              )}
            </button>
          )}
          {filteredRooms.map((room) => (
            <button
              key={room}
              className={`user-item room-item ${activeChat === `room_${room}` ? 'active' : ''}`}
              aria-current={activeChat === `room_${room}` ? 'page' : undefined}
              onClick={() => selectChat(`room_${room}`)}
            >
              <span className="item-icon">
                <Icon name="hash" />
              </span>
              <span className="item-label">
                {roomKeys.current.get(room)?.label}
                <small>Room conversation</small>
              </span>
              {unread[`room_${room}`] > 0 && (
                <span className="unread-badge">{unread[`room_${room}`]}</span>
              )}
            </button>
          ))}
          <form className="join-room-form" onSubmit={joinPrivateRoom}>
            <label className="sr-only" htmlFor="room-code">
              Enter room code
            </label>
            <input
              id="room-code"
              className="room-input"
              placeholder="Enter room code"
              value={roomCodeInput}
              maxLength={97}
              onChange={(event) => {
                setRoomCodeInput(event.target.value)
                setRoomError('')
              }}
            />
            <button
              className="room-btn"
              type="submit"
              aria-label="Join private room"
              disabled={!roomCodeInput.trim() || !connected}
            >
              <Icon name="plus" size={18} />
            </button>
          </form>
          {roomError && (
            <p className="field-error" role="alert">
              {roomError}
            </p>
          )}
          <p className="room-hint">Enter a name to create a room, or paste a private invitation.</p>
          <div className="menu-section-header people-heading">
            PEOPLE ONLINE <span>{onlineUsers.length}</span>
          </div>
          {filteredUsers.map((user) => (
            <button
              key={user.id}
              className={`user-item person-item ${activeChat === user.id ? 'active' : ''}`}
              disabled={user.id === socket.id}
              aria-current={activeChat === user.id ? 'page' : undefined}
              onClick={() => selectChat(user.id)}
            >
              <span
                className={`avatar-pill avatar-${user.name.charCodeAt(0) % 4}`}
              >
                {user.name.slice(0, 1).toUpperCase()}
                <i className="status-dot" />
              </span>
              <span className="item-label">
                {user.name}
                <small>
                  {user.id === socket.id
                    ? 'That’s you'
                    : 'Here for a conversation'}
                </small>
              </span>
              {user.id === socket.id && <span className="you-tag">You</span>}
              {unread[user.id] > 0 && (
                <span className="unread-badge">{unread[user.id]}</span>
              )}
            </button>
          ))}
          {search &&
            !filteredUsers.length &&
            !filteredRooms.length &&
            !'global room'.includes(search.toLowerCase()) && (
              <div className="search-empty">
                <Icon name="search" />
                <p>No matches for “{search}”</p>
                <button onClick={() => setSearch('')}>Clear search</button>
              </div>
            )}
        </nav>
        <div className="sidebar-bottom">
          <span className="avatar-pill self-avatar">
            {name.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{name}</strong>
            <span
              className={
                connected ? 'connection-label' : 'connection-label offline'
              }
            >
              <i className="status-dot" />
              {connected ? 'You’re online' : 'Reconnecting…'}
            </span>
          </div>
          <button
            className="icon-button"
            title="Leave space"
            aria-label="Leave space"
            onClick={async () => {
              if (socket.auth?.token) {
                try {
                  const response = await fetch(new URL('/accounts/logout', apiUrl), {
                    method: 'POST', headers: { Authorization: 'Bearer ' + socket.auth.token },
                  })
                  if (!response.ok) throw new Error()
                } catch {
                  setNotice('Could not sign out. Reconnect and try again.')
                  return
                }
              }
              try { sessionStorage.removeItem('orbit_session') } catch { /* This optional browser feature may be unavailable. */ }
              socket.auth = { publicKey: device.publicKey }
              identityRef.current = ''
              setName('')
              setJoined(false)
              window.location.reload()
            }}
          >
            <Icon name="exit" size={18} />
          </button>
        </div>
      </aside>

      <section
        className="chat-container"
        aria-label="Chat"
        inert={isMobile && sidebarOpen}
      >
        <header className="chat-header">
          <button
            className="icon-button mobile-only menu-toggle"
            aria-label="Open navigation"
            aria-expanded={sidebarOpen}
            aria-controls="chat-navigation"
            onClick={() => setSidebarOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <span className="header-room-icon">
            <Icon name={chatIcon} size={23} />
          </span>
          <div className="header-info">
            <h1>{chatTitle}</h1>
            <p>
              <span
                className={`status-dot ${connected ? '' : 'disconnected'}`}
              />
              {!connected
                ? 'Reconnecting…'
                : isGlobal
                  ? `${onlineUsers.length} online · Everyone’s welcome`
                  : isRoom
                    ? 'A space for your people'
                    : peer
                      ? 'Online · Direct conversation'
                      : 'This person is offline'}
            </p>
          </div>
          <div className="header-actions">
            <button ref={messageSearchButton} className="icon-button" aria-label="Search this conversation"
              aria-expanded={messageSearch !== null} title="Search this conversation"
              onClick={() => setMessageSearch(value => value === null ? '' : null)}>
              <Icon name="search" />
            </button>
            {!isGlobal && !isRoom && (
              <button
                className="icon-button call-btn"
                onClick={() => callUser(activeChat)}
                disabled={Boolean(callPartner) || !canSend}
                title="Start Video Call"
                aria-label="Start Video Call"
              >
                <Icon name="video" />
              </button>
            )}
            {isRoom && (
              <button
                className="icon-button"
                title="Copy room code"
                aria-label="Copy room code"
                onClick={copyRoomCode}
              >
                <Icon name="copy" />
              </button>
            )}
            <button
              className={`icon-button info-toggle ${detailsOpen ? 'selected' : ''}`}
              aria-label="Conversation details"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen(!detailsOpen)}
            >
              <Icon name="info" />
            </button>
          </div>
        </header>
        {messageSearch !== null && (
          <div className="message-search" role="search" aria-label="Conversation search">
            <Icon name="search" size={16} />
            <input autoFocus aria-label="Search messages or senders" placeholder="Search messages or senders"
              value={messageSearch} onChange={event => setMessageSearch(event.target.value)}
              onKeyDown={event => { if (event.key === 'Escape') closeMessageSearch() }} />
            {query && <span role="status">{visibleMessages.length} {visibleMessages.length === 1 ? 'match' : 'matches'}</span>}
            <button className="icon-button" aria-label="Close message search" onClick={closeMessageSearch}><Icon name="close" /></button>
          </div>
        )}
        {!connected && (
          <div className="connection-banner" role="status">
            Connection interrupted. We’ll reconnect automatically. Your draft is
            safe.
          </div>
        )}
        {callError && (
          <div className="error-banner" role="alert">
            {callError}
            <button
              className="icon-button"
              aria-label="Dismiss call error"
              onClick={() => setCallError('')}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div className="notice-banner" role="status">
            <Icon name="check" size={17} />
            {notice}
            <button
              className="icon-button"
              aria-label="Dismiss notification"
              onClick={() => setNotice('')}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        <div className="messages-area">
          <div
            className="messages-scroll"
            ref={listRef}
            onScroll={(event) => {
              const element = event.currentTarget
              nearBottomRef.current =
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <
                80
            }}
            role="log"
            aria-label={`Messages in ${chatTitle}`}
            aria-live="polite"
            aria-relevant="additions text"
          >
            <div className="conversation-intro" hidden={Boolean(query)}>
              <span className="intro-icon">
                <Icon name={chatIcon} size={30} />
              </span>
              <span className="eyebrow">
                {isGlobal
                  ? 'THE COMMON GROUND'
                  : isRoom
                    ? 'A LITTLE SPACE OF YOUR OWN'
                    : 'JUST THE TWO OF YOU'}
              </span>
              <h2>
                {isGlobal
                  ? 'Good company starts with hello.'
                  : isRoom
                    ? `Welcome to #${chatTitle}.`
                    : `Say hello to ${chatTitle}.`}
              </h2>
              <p>
                {isGlobal
                  ? 'Share a thought, ask a question, or see where the conversation takes you.'
                  : isRoom
                    ? 'You found your corner of Orbit. Share the room code to bring your people together.'
                    : 'A quick check-in or a long catch-up. This conversation is yours.'}
              </p>
              {!chatMessages.some((message) => !message.system) && (
                <span className="first-message-prompt">
                  <Icon name="spark" size={14} /> Be the first to break the ice
                </span>
              )}
            </div>
            {visibleMessages.map((msg, index) => {
              const isSystem = msg.system === true
              const isMine = ownSocketIds.has(msg.from) && !isSystem
              const day = new Date(msg.timestamp).toLocaleDateString(
                undefined,
                { month: 'long', day: 'numeric' },
              )
              const previousDay =
                index > 0
                  ? new Date(
                      visibleMessages[index - 1].timestamp,
                    ).toLocaleDateString(undefined, {
                      month: 'long',
                      day: 'numeric',
                    })
                  : null
              return (
                <Fragment key={msg.id}>
                  {day !== previousDay && (
                    <div className="date-divider">
                      <span>{day}</span>
                    </div>
                  )}
                  {isSystem ? (
                    <div className="message system">
                      <p>{msg.text}</p>
                    </div>
                  ) : (
                    <article
                      className={`message ${isMine ? 'mine' : 'theirs'}`}
                    >
                      <span
                        className={`message-avatar avatar-${msg.user.charCodeAt(0) % 4}`}
                        aria-hidden="true"
                      >
                        {msg.user.slice(0, 1).toUpperCase()}
                      </span>
                      <div className="message-content">
                        <div className="message-meta">
                          <span className="msg-author">
                            {isMine ? 'You' : msg.user}
                          </span>
                          <time dateTime={msg.timestamp} className="msg-time">
                            {new Date(msg.timestamp).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </time>
                        </div>
                        <div className="msg-bubble">
                          <p>{msg.text}</p>
                        </div>
                      </div>
                    </article>
                  )}
                </Fragment>
              )
            })}
            {typingUsers.size > 0 && isGlobal && (
              <div className="typing-indicator">
                <div className="dots">
                  <span />
                  <span />
                  <span />
                </div>
                <span>{getTypingText()}</span>
              </div>
            )}
          </div>
        </div>
        <div className="composer-area">
          {peer && !peer.verified && (
            <form key={peer.incoming} className="verify-device" onSubmit={event => {
              event.preventDefault()
              const field = event.currentTarget.elements.code
              const current = peers.current.get(peer.id)
              if (!current || current.incoming !== peer.incoming) return
              if (field.value.toLowerCase().replace(/\s/g, '') !== current.incoming.replaceAll(' ', '')) {
                field.setCustomValidity('The codes differ. Check the code with your contact.')
                field.reportValidity()
                return
              }
              peers.current.set(peer.id, { ...current, verified: true })
              setOnlineUsers([...peers.current.values()])
            }}>
              <strong>Verify {peer.name}’s device</strong>
              <p>Exchange codes over a separate trusted channel to enable direct messages and calls.</p>
              <span>Your code</span><code>{peer.outgoing}</code>
              <label htmlFor="peer-code">Their code</label>
              <div><input id="peer-code" name="code" required autoComplete="off" spellCheck={false}
                onChange={event => event.target.setCustomValidity('')} /><button className="secondary-button">Verify device</button></div>
            </form>
          )}
          {peer?.verified && <p className="verified-note">Device verified · Encrypted conversation</p>}
          <form className="composer" onSubmit={sendMessage}>
            <label className="sr-only" htmlFor="message-draft">
              Message {chatTitle}
            </label>
            <textarea
              id="message-draft"
              rows={1}
              value={draft}
              onChange={handleDraftChange}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault()
                  event.currentTarget.form.requestSubmit()
                }
              }}
              placeholder={
                connected && peer && !peer.verified ? 'Verify this device to send…' : canSend ? 'Type a message...' : 'Waiting for connection…'
              }
              maxLength={500}
            />
            <button
              type="submit"
              aria-label="Send message"
              disabled={!draft.trim() || !canSend}
            >
              <Icon name="send" size={20} />
            </button>
          </form>
          <div className="composer-hint">
            <span>
              <kbd>Enter</kbd> to send <span className="hint-separator">·</span>{' '}
              <kbd>Shift + Enter</kbd> for a new line
            </span>
            <span>
              {draft.length > 0
                ? `${draft.length} / 500`
                : 'A little kindness goes a long way.'}
            </span>
          </div>
        </div>
      </section>
      <aside
        className="details-panel"
        aria-label="Conversation details"
        hidden={!detailsOpen}
        inert={isMobile && sidebarOpen}
      >
        <div className="details-heading">
          THE LITTLE DETAILS
          <button
            className="icon-button"
            aria-label="Close details"
            onClick={() => setDetailsOpen(false)}
          >
            <Icon name="close" size={17} />
          </button>
        </div>
        <div className="detail-orbit">
          <span className="detail-orbit-ring" />
          <Icon name={chatIcon} size={38} />
          <i />
        </div>
        <h2>{chatTitle}</h2>
        <p className="details-description">
          {isGlobal
            ? 'An open door to good conversation.'
            : isRoom
              ? 'A shared code. A shared space.'
              : 'A little closer, even from a distance.'}
        </p>
        <span className="detail-tag">
          <Icon
            name={isGlobal ? 'globe' : isRoom ? 'hash' : 'chat'}
            size={13}
          />
          {isGlobal
            ? 'Open to everyone'
            : isRoom
              ? 'Join with a room code'
              : 'Direct conversation'}
        </span>
        <div className="details-rule" />
        <div className="details-note">
          <Icon name="spark" size={19} />
          <h3>{isGlobal ? 'Public conversation' : 'End-to-end encrypted text'}</h3>
          <p>{isGlobal ? 'Anyone who joins can read public messages.' : isRoom ?
            'Share your room invitation privately. Anyone with it can read messages in this room.' :
            'Messages between you and ' + (peer?.name || 'this contact') + ' are end-to-end encrypted directly on your devices.'}</p>
        </div>
        {isRoom ? (
          <button className="secondary-button" onClick={copyRoomCode}>
            <Icon name="copy" size={16} /> Copy room code
          </button>
        ) : (
          <div className="details-facts">
            <span>
              <Icon name="people" size={17} />
              {isGlobal
                ? `${onlineUsers.length} people online`
                : peer
                  ? 'Available for a chat'
                  : 'Currently offline'}
            </span>
            <span>
              <Icon name="chat" size={17} />
              Conversations live in the moment
            </span>
          </div>
        )}
        <div className="details-footnote">
          <Icon name="orbit" size={20} />
          <p>
            A small space.
            <br />A world of possibility.
          </p>
        </div>
      </aside>

      {/* Incoming Call Modal */}
      {receivingCall && !callAccepted && (
        <div
          className="call-modal-overlay fade-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="incoming-call-title"
        >
          <div className="call-modal scale-in">
            <div className="call-modal-icon pulse-circle">
              <svg
                viewBox="0 0 24 24"
                width="24"
                height="24"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="23 7 16 12 23 17 23 7"></polygon>
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
              </svg>
            </div>
            <h3 id="incoming-call-title">Incoming Video Call</h3>
            <p>
              <strong>{callerName}</strong> is calling you...
            </p>
            <div className="call-actions">
              <button className="accept-btn" onClick={answerCall}>
                Accept
              </button>
              <button className="decline-btn" onClick={leaveCall}>
                Decline
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Active Call UI */}
      {(stream || callAccepted) && (
        <div
          className="active-call-overlay fade-in"
          role="dialog"
          aria-modal="true"
          aria-label="Video call"
        >
          <div className="video-container">
            <div className="remote-video-wrapper">
              <video
                playsInline
                ref={remoteVideo}
                autoPlay
                className="remote-video"
                hidden={!callAccepted || callEnded}
              />
              {!(callAccepted && !callEnded) && (
                <div className="calling-placeholder">
                  <div className="dots">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                  <p>{receivingCall ? 'Connecting...' : 'Calling...'}</p>
                </div>
              )}
            </div>
            {stream && (
              <div className="local-video-wrapper">
                <video
                  playsInline
                  muted
                  ref={localVideo}
                  autoPlay
                  className="local-video"
                />
              </div>
            )}
            <div className="call-controls">
              <button
                type="button"
                className="fullscreen-btn"
                onClick={toggleFullscreen}
                aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
                  {isFullscreen ? (
                    <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
                  ) : (
                    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                  )}
                </svg>
              </button>
              <button className="hangup-btn" onClick={leaveCall}>
                <svg
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                  stroke="currentColor"
                  strokeWidth="2"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"></path>
                  <line x1="23" y1="1" x2="1" y2="23"></line>
                </svg>
                Hang Up
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

export default App
