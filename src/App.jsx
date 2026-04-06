import { useState, useRef, useEffect, useCallback } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import { PDFDocument } from 'pdf-lib'
import { FONTS, CATEGORIES } from './fonts.js'
import './App.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).href

const STAMP_DEFAULT_RATIO = 0.22

function loadGoogleFont(fontName) {
  const id = `gf-${fontName.replace(/\s+/g, '-').toLowerCase()}`
  if (!document.getElementById(id)) {
    const link = document.createElement('link')
    link.id = id
    link.rel = 'stylesheet'
    link.href = `https://fonts.googleapis.com/css2?family=${fontName.replace(/\s+/g, '+')}&display=swap`
    document.head.appendChild(link)
  }
  return document.fonts.load(`12px "${fontName}"`).catch(() => {})
}

function FontItem({ fontName, text, sample, selected, onSelect }) {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let alive = true
    loadGoogleFont(fontName).then(() => { if (alive) setLoaded(true) })
    return () => { alive = false }
  }, [fontName])
  const preview = text || sample || 'Signature'
  return (
    <button className={`font-item${selected ? ' active' : ''}`} onClick={onSelect}>
      <span className="fi-preview" style={loaded ? { fontFamily: `'${fontName}', serif` } : { opacity: 0.3 }}>
        {preview}
      </span>
      <span className="fi-name">{fontName}</span>
    </button>
  )
}

async function processStampImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const MAX = 600
      const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight))
      const w = Math.round(img.naturalWidth * scale)
      const h = Math.round(img.naturalHeight * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, w, h)
      const imageData = ctx.getImageData(0, 0, w, h)
      const d = imageData.data
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225) d[i + 3] = 0
      }
      ctx.putImageData(imageData, 0, 0)
      resolve({ dataUrl: canvas.toDataURL('image/png'), aspectRatio: w / h })
    }
    img.src = dataUrl
  })
}

function initCanvas(canvas) {
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
}

export default function App() {
  // Theme
  const [dark, setDark] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  }, [dark])

  // Stamps & document state
  const [stamps, setStamps] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sf_stamps') || '[]') } catch { return [] }
  })
  const [selectedStamp, setSelectedStamp] = useState(null)
  const [pdfBuffer, setPdfBuffer] = useState(null)
  const [pdfFileName, setPdfFileName] = useState('')
  const [pageRendered, setPageRendered] = useState(false)
  const [placedStamps, setPlacedStamps] = useState([])
  const [interaction, setInteraction] = useState(null)
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 })
  const [isDraggingOver, setIsDraggingOver] = useState(false)

  // Sidebar tab state
  const [activeTab, setActiveTab] = useState('library') // 'library' | 'create'

  // Signature creator state
  const [createMode, setCreateMode] = useState('draw') // 'draw' | 'type'
  const [sigText, setSigText] = useState('')
  const [sigFont, setSigFont] = useState('Dancing Script')
  const [penSize, setPenSize] = useState(2.5)
  const [isDrawing, setIsDrawing] = useState(false)
  const [fontQuery, setFontQuery] = useState('')
  const [fontCategory, setFontCategory] = useState('All')
  const [customFonts, setCustomFonts] = useState([])
  const [fontUrlInput, setFontUrlInput] = useState('')
  const [fontUrlError, setFontUrlError] = useState('')
  const [showAddFont, setShowAddFont] = useState(false)

  // Refs
  const canvasRef = useRef(null)
  const overlayRef = useRef(null)
  const docInputRef = useRef(null)
  const stampInputRef = useRef(null)
  const docAreaRef = useRef(null)
  const sigCanvasRef = useRef(null)
  const lastPoint = useRef(null)
  const hasDrawn = useRef(false)
  const fontFileRef = useRef(null)
  const renderTaskRef = useRef(null)

  useEffect(() => {
    try { localStorage.setItem('sf_stamps', JSON.stringify(stamps)) } catch {}
  }, [stamps])

  // ── PDF rendering ─────────────────────────────────────────

  const renderPDF = useCallback(async (buffer) => {
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel()
      renderTaskRef.current = null
    }
    const pdf = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise
    const page = await pdf.getPage(1)
    const viewport = page.getViewport({ scale: 1 })
    const containerW = (docAreaRef.current?.clientWidth || 800) - 64
    const s = Math.min(containerW, 860) / viewport.width
    const scaledVP = page.getViewport({ scale: s })
    setCanvasSize({ w: scaledVP.width, h: scaledVP.height })
    const canvas = canvasRef.current
    canvas.width = scaledVP.width
    canvas.height = scaledVP.height
    const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: scaledVP })
    renderTaskRef.current = task
    try {
      await task.promise
      renderTaskRef.current = null
      setPageRendered(true)
      setPlacedStamps([])
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') throw e
    }
  }, [])

  // ── Re-render PDF on container resize (handles mobile layout shifts) ──
  useEffect(() => {
    if (!docAreaRef.current || !pdfBuffer) return
    let timer
    const ro = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => renderPDF(pdfBuffer), 120)
    })
    ro.observe(docAreaRef.current)
    return () => { ro.disconnect(); clearTimeout(timer) }
  }, [pdfBuffer, renderPDF])

  const loadFile = useCallback((file) => {
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) return
    setPdfFileName(file.name)
    const reader = new FileReader()
    reader.onload = ev => { setPdfBuffer(ev.target.result); renderPDF(ev.target.result) }
    reader.readAsArrayBuffer(file)
  }, [renderPDF])

  const handleDocUpload = (e) => { loadFile(e.target.files[0]); e.target.value = '' }
  const handleDrop = (e) => { e.preventDefault(); setIsDraggingOver(false); loadFile(e.dataTransfer.files[0]) }

  const handleStampUpload = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async (ev) => {
      const { dataUrl, aspectRatio } = await processStampImage(ev.target.result)
      const stamp = { id: `${Date.now()}`, name: file.name.replace(/\.[^.]+$/, ''), dataUrl, aspectRatio }
      setStamps(prev => [...prev, stamp])
      setSelectedStamp(stamp)
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const deleteStamp = (e, id) => {
    e.stopPropagation()
    setStamps(prev => prev.filter(s => s.id !== id))
    if (selectedStamp?.id === id) setSelectedStamp(null)
    setPlacedStamps(prev => prev.filter(s => s.stampId !== id))
  }

  // ── Stamp placement on PDF ────────────────────────────────

  const handleOverlayMouseDown = useCallback((e) => {
    if (!selectedStamp || !pageRendered) return
    const rect = overlayRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const w = canvasSize.w * STAMP_DEFAULT_RATIO
    const h = w / selectedStamp.aspectRatio
    const inst = { id: `i_${Date.now()}`, stampId: selectedStamp.id, x: x - w / 2, y: y - h / 2, w, h }
    setPlacedStamps(prev => [...prev, inst])
    setInteraction({ type: 'move', instanceId: inst.id, startX: x, startY: y, origX: inst.x, origY: inst.y })
    e.preventDefault()
  }, [selectedStamp, pageRendered, canvasSize])

  const startMove = useCallback((e, inst) => {
    e.stopPropagation()
    const rect = overlayRef.current.getBoundingClientRect()
    setInteraction({ type: 'move', instanceId: inst.id, startX: e.clientX - rect.left, startY: e.clientY - rect.top, origX: inst.x, origY: inst.y })
    e.preventDefault()
  }, [])

  const startResize = useCallback((e, inst) => {
    e.stopPropagation()
    const rect = overlayRef.current.getBoundingClientRect()
    setInteraction({ type: 'resize', instanceId: inst.id, startX: e.clientX - rect.left, startY: e.clientY - rect.top, origW: inst.w, origH: inst.h, ar: inst.w / inst.h })
    e.preventDefault()
  }, [])

  const handleMouseMove = useCallback((e) => {
    if (!interaction || !overlayRef.current) return
    const rect = overlayRef.current.getBoundingClientRect()
    const dx = (e.clientX - rect.left) - interaction.startX
    const dy = (e.clientY - rect.top) - interaction.startY
    if (interaction.type === 'move') {
      setPlacedStamps(prev => prev.map(s =>
        s.id === interaction.instanceId ? { ...s, x: interaction.origX + dx, y: interaction.origY + dy } : s
      ))
    } else {
      const newW = Math.max(30, interaction.origW + dx)
      setPlacedStamps(prev => prev.map(s =>
        s.id === interaction.instanceId ? { ...s, w: newW, h: newW / interaction.ar } : s
      ))
    }
  }, [interaction])

  const handleMouseUp = useCallback(() => setInteraction(null), [])

  useEffect(() => {
    if (interaction) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [interaction, handleMouseMove, handleMouseUp])

  const removeInstance = (e, id) => { e.stopPropagation(); e.preventDefault(); setPlacedStamps(prev => prev.filter(s => s.id !== id)) }

  // ── Download ──────────────────────────────────────────────

  const handleDownload = async () => {
    if (!pdfBuffer || placedStamps.length === 0) return
    const pdfDoc = await PDFDocument.load(pdfBuffer)
    const page = pdfDoc.getPages()[0]
    const { width: pW, height: pH } = page.getSize()
    for (const inst of placedStamps) {
      const stamp = stamps.find(s => s.id === inst.stampId)
      if (!stamp) continue
      let img
      try { img = await pdfDoc.embedPng(stamp.dataUrl) } catch { continue }
      page.drawImage(img, {
        x: (inst.x / canvasSize.w) * pW,
        y: pH - ((inst.y + inst.h) / canvasSize.h) * pH,
        width: (inst.w / canvasSize.w) * pW,
        height: (inst.h / canvasSize.h) * pH,
      })
    }
    const bytes = await pdfDoc.save()
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
    const a = document.createElement('a')
    a.href = url
    a.download = pdfFileName.replace(/\.pdf$/i, '_stamped.pdf')
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Signature creator ─────────────────────────────────────

  // Init canvas when tab/mode becomes active
  useEffect(() => {
    if (activeTab !== 'create') return
    const canvas = sigCanvasRef.current
    if (!canvas) return
    initCanvas(canvas)
    hasDrawn.current = false
    if (createMode === 'type' && sigText) renderTextOnCanvas(canvas, sigText, sigFont)
  }, [activeTab, createMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-render text when text or font changes (type mode only)
  useEffect(() => {
    if (activeTab !== 'create' || createMode !== 'type') return
    const canvas = sigCanvasRef.current
    if (!canvas) return
    renderTextOnCanvas(canvas, sigText, sigFont)
  }, [sigText, sigFont, activeTab, createMode])

  async function renderTextOnCanvas(canvas, text, font) {
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    if (!text) return
    const display = `60px '${font}'`
    try { await document.fonts.load(display) } catch {}
    const size = Math.min(72, Math.max(28, (canvas.width / (text.length || 1)) * 1.6))
    ctx.font = `${size}px '${font}'`
    ctx.fillStyle = '#1a1a1a'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, canvas.width / 2, canvas.height / 2)
  }

  // Drawing handlers
  function getSigPos(e) {
    const canvas = sigCanvasRef.current
    const rect = canvas.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    }
  }

  function handleSigMouseDown(e) {
    if (createMode !== 'draw') return
    setIsDrawing(true)
    hasDrawn.current = true
    const { x, y } = getSigPos(e)
    lastPoint.current = { x, y }
    const ctx = sigCanvasRef.current.getContext('2d')
    ctx.beginPath()
    ctx.arc(x, y, penSize / 2, 0, Math.PI * 2)
    ctx.fillStyle = '#1a1a1a'
    ctx.fill()
  }

  function handleSigMouseMove(e) {
    if (!isDrawing || createMode !== 'draw') return
    const { x, y } = getSigPos(e)
    const ctx = sigCanvasRef.current.getContext('2d')
    ctx.beginPath()
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y)
    ctx.lineTo(x, y)
    ctx.strokeStyle = '#1a1a1a'
    ctx.lineWidth = penSize
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke()
    lastPoint.current = { x, y }
  }

  function handleSigMouseUp() { setIsDrawing(false) }

  function clearSigCanvas() {
    const canvas = sigCanvasRef.current
    initCanvas(canvas)
    hasDrawn.current = false
    if (createMode === 'type' && sigText) renderTextOnCanvas(canvas, sigText, sigFont)
  }

  async function handleFontFileUpload(e) {
    const file = e.target.files[0]
    if (!file) return
    e.target.value = ''
    const name = file.name.replace(/\.(ttf|otf|woff2?)$/i, '')
    try {
      const buffer = await file.arrayBuffer()
      const face = new FontFace(name, buffer)
      await face.load()
      document.fonts.add(face)
      setCustomFonts(prev => prev.find(f => f.name === name) ? prev : [...prev, { name }])
      setSigFont(name)
    } catch {
      setFontUrlError('Could not load font file.')
    }
  }

  async function handleAddFontUrl() {
    const raw = fontUrlInput.trim()
    if (!raw) return
    setFontUrlError('')

    // Direct font file URL — handle before anything else
    if (/\.(ttf|otf|woff2?)(\?|$)/i.test(raw)) {
      const name = raw.split('/').pop().replace(/\?.*/, '').replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[+_]/g, ' ')
      try {
        const face = new FontFace(name, `url(${raw})`)
        await face.load()
        document.fonts.add(face)
        setCustomFonts(prev => [...prev.filter(f => f.name !== name), { name }])
        setSigFont(name)
        setFontUrlInput('')
      } catch { setFontUrlError('Could not load font from URL.') }
      return
    }

    // Extract family name from any Google Fonts URL format
    let familyName = raw
    if (raw.includes('fonts.google.com/specimen/')) {
      // e.g. https://fonts.google.com/specimen/Dancing+Script?preview.script=Latn
      const match = raw.match(/\/specimen\/([^?&#/]+)/)
      familyName = match ? decodeURIComponent(match[1].replace(/\+/g, ' ')).trim() : ''
    } else if (raw.includes('fonts.googleapis.com')) {
      // e.g. https://fonts.googleapis.com/css2?family=Dancing+Script:wght@400
      const match = raw.match(/family=([^&;]+)/)
      familyName = match ? decodeURIComponent(match[1].replace(/\+/g, ' ')).split(':')[0].trim() : ''
    } else if (raw.includes('fonts.google.com')) {
      // e.g. fonts.google.com/share?selection.family=Roboto
      const match = raw.match(/family=([^&;|]+)/)
      familyName = match ? decodeURIComponent(match[1].replace(/\+/g, ' ')).trim() : ''
    }
    // else: treat raw as a plain family name, e.g. "Pacifico"

    if (!familyName) { setFontUrlError('Could not parse font name from this URL.'); return }

    try {
      // Load CSS and wait for it, then verify the font actually resolved
      const id = `gf-${familyName.replace(/\s+/g, '-').toLowerCase()}`
      if (!document.getElementById(id)) {
        await new Promise((resolve, reject) => {
          const link = document.createElement('link')
          link.id = id
          link.rel = 'stylesheet'
          link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(familyName)}&display=swap`
          link.onload = resolve
          link.onerror = reject
          document.head.appendChild(link)
        })
      }
      const result = await document.fonts.load(`16px "${familyName}"`)
      if (!result || result.length === 0) throw new Error('not found')
      setCustomFonts(prev => [...prev.filter(f => f.name !== familyName), { name: familyName }])
      setSigFont(familyName)
      setFontUrlInput('')
    } catch {
      setFontUrlError(`"${familyName}" not found on Google Fonts. Check the spelling.`)
    }
  }

  async function saveSignature() {
    const canvas = sigCanvasRef.current
    if (!canvas) return
    if (createMode === 'draw' && !hasDrawn.current) return
    if (createMode === 'type' && !sigText.trim()) return

    const dataUrl = canvas.toDataURL('image/png')
    const { dataUrl: processed, aspectRatio } = await processStampImage(dataUrl)
    const name = createMode === 'type' ? (sigText.trim() || 'Signature') : `Signature ${stamps.length + 1}`
    const stamp = { id: `${Date.now()}`, name, dataUrl: processed, aspectRatio }
    setStamps(prev => [...prev, stamp])
    setSelectedStamp(stamp)
    setActiveTab('library')
    // Reset
    setSigText('')
    hasDrawn.current = false
  }

  // ─────────────────────────────────────────────────────────

  return (
    <div className="app">
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="sidebar-drag-handle" onClick={() => setSidebarOpen(false)} />
        <div className="brand">
          <div className="brand-mark">
            <img src="/logo.svg" alt="StampFlow" width="32" height="38" />
          </div>
          <div>
            <h1 className="brand-name">StampFlow</h1>
            <p className="brand-sub">Digital Certification</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="sidebar-tabs">
          <button
            className={`s-tab ${activeTab === 'library' ? 'active' : ''}`}
            onClick={() => setActiveTab('library')}
          >
            Library
          </button>
          <button
            className={`s-tab ${activeTab === 'create' ? 'active' : ''}`}
            onClick={() => setActiveTab('create')}
          >
            Create Signature
          </button>
        </div>

        {/* Library panel */}
        {activeTab === 'library' && (
          <div className="sidebar-body">
            <div className="section-header">
              <span className="section-label">Stamp Library</span>
              <button className="btn-add" onClick={() => stampInputRef.current?.click()} title="Upload stamp image">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
            </div>
            <input ref={stampInputRef} type="file" accept="image/*" onChange={handleStampUpload} hidden />

            {stamps.length === 0 ? (
              <div className="empty-stamps">
                <div className="empty-icon">
                  <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                    <rect x="6" y="6" width="28" height="28" rx="4" stroke="currentColor" strokeWidth="1.2" strokeDasharray="3 3"/>
                    <path d="M20 13v14M13 20h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </div>
                <p>No stamps yet. Upload an image or create a signature.</p>
                <button className="btn-upload-stamp" onClick={() => stampInputRef.current?.click()}>
                  Upload Image
                </button>
                <button className="btn-upload-stamp" onClick={() => setActiveTab('create')}>
                  Create Signature
                </button>
              </div>
            ) : (
              <div className="stamp-list">
                {stamps.map(stamp => (
                  <div
                    key={stamp.id}
                    className={`stamp-item ${selectedStamp?.id === stamp.id ? 'active' : ''}`}
                    onClick={() => setSelectedStamp(prev => prev?.id === stamp.id ? null : stamp)}
                  >
                    <div className="stamp-thumb">
                      <img src={stamp.dataUrl} alt={stamp.name} />
                    </div>
                    <span className="stamp-label">{stamp.name}</span>
                    <button className="stamp-del" onMouseDown={e => deleteStamp(e, stamp.id)}>
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                    </button>
                  </div>
                ))}
                <button className="btn-add-more" onClick={() => stampInputRef.current?.click()}>
                  + Upload image
                </button>
                <button className="btn-add-more" onClick={() => setActiveTab('create')}>
                  + Create signature
                </button>
              </div>
            )}
          </div>
        )}

        {/* Create Signature panel */}
        {activeTab === 'create' && (
          <div className="sidebar-body create-panel">
            {/* Draw / Type toggle */}
            <div className="mode-toggle">
              <button
                className={`mode-btn ${createMode === 'draw' ? 'active' : ''}`}
                onClick={() => setCreateMode('draw')}
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                  <path d="M2 11L4.5 10 10.5 4 9 2.5 3 8.5 2 11Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                </svg>
                Draw
              </button>
              <button
                className={`mode-btn ${createMode === 'type' ? 'active' : ''}`}
                onClick={() => setCreateMode('type')}
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                  <path d="M2 3h9M6.5 3v7M4 10h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
                Type
              </button>
            </div>

            {/* Name input — above canvas so preview updates as you type */}
            {createMode === 'type' && (
              <input
                className="sig-input"
                type="text"
                placeholder="Type your name..."
                value={sigText}
                onChange={e => setSigText(e.target.value)}
                maxLength={40}
                autoFocus
              />
            )}

            {/* Signature canvas */}
            <div className="sig-canvas-wrap">
              <canvas
                ref={sigCanvasRef}
                className={`sig-canvas${createMode === 'draw' ? ' drawable' : ''}`}
                width={480}
                height={160}
                onMouseDown={handleSigMouseDown}
                onMouseMove={handleSigMouseMove}
                onMouseUp={handleSigMouseUp}
                onMouseLeave={handleSigMouseUp}
              />
              {createMode === 'draw' && !hasDrawn.current && (
                <p className="sig-hint">Draw your signature above</p>
              )}
            </div>

            {/* Draw tools */}
            {createMode === 'draw' && (
              <div className="draw-tools">
                <div className="pen-sizes">
                  {[1.5, 2.5, 4.5].map(s => (
                    <button
                      key={s}
                      className={`pen-size-btn ${penSize === s ? 'active' : ''}`}
                      onClick={() => setPenSize(s)}
                      title={`${s === 1.5 ? 'Thin' : s === 2.5 ? 'Medium' : 'Thick'}`}
                    >
                      <span style={{ width: s * 2.5, height: s * 2.5, borderRadius: '50%', background: 'currentColor', display: 'block' }} />
                    </button>
                  ))}
                </div>
                <button className="btn-clear" onClick={clearSigCanvas}>Clear</button>
              </div>
            )}

            {/* Font picker — type mode only */}
            {createMode === 'type' && (
              <div className="font-picker">
                {/* Search + toggle add-font button on one row */}
                <div className="font-picker-top">
                  <div className="font-search-row">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.2"/>
                      <path d="M8 8l2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                    </svg>
                    <input
                      className="font-search"
                      type="text"
                      placeholder="Search fonts..."
                      value={fontQuery}
                      onChange={e => setFontQuery(e.target.value)}
                    />
                    {fontQuery && (
                      <button className="font-search-clear" onClick={() => setFontQuery('')}>×</button>
                    )}
                  </div>
                  <button
                    className={`btn-toggle-add-font${showAddFont ? ' active' : ''}`}
                    onClick={() => setShowAddFont(v => !v)}
                    title="Add your own font"
                  >
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                      <path d="M6.5 1v7M3.5 5l3-3 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M1 10v1.5A.5.5 0 001.5 12h10a.5.5 0 00.5-.5V10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                    </svg>
                  </button>
                </div>

                {/* Collapsible add-font panel */}
                {showAddFont && (
                  <div className="add-font-panel">
                    <button className="btn-upload-font" onClick={() => fontFileRef.current?.click()}>
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M6 1v7M3 5l3-3 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M1 9v1.5A.5.5 0 001.5 11h9a.5.5 0 00.5-.5V9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                      </svg>
                      Upload font file (.ttf, .otf, .woff)
                    </button>
                    <input ref={fontFileRef} type="file" accept=".ttf,.otf,.woff,.woff2" onChange={handleFontFileUpload} hidden />
                    <div className="font-url-row">
                      <input
                        className="font-url-input"
                        type="text"
                        placeholder="Google Fonts URL or name…"
                        value={fontUrlInput}
                        onChange={e => { setFontUrlInput(e.target.value); setFontUrlError('') }}
                        onKeyDown={e => e.key === 'Enter' && handleAddFontUrl()}
                      />
                      <button className="btn-add-url" onClick={handleAddFontUrl}>Add</button>
                    </div>
                    {fontUrlError && <p className="font-url-error">{fontUrlError}</p>}
                  </div>
                )}

                {/* Category chips — single scrollable row */}
                <div className="cat-chips">
                  {CATEGORIES.map(cat => (
                    <button
                      key={cat}
                      className={`cat-chip${fontCategory === cat ? ' active' : ''}`}
                      onClick={() => setFontCategory(cat)}
                    >
                      {cat}
                    </button>
                  ))}
                </div>

                {/* Custom fonts */}
                {customFonts.length > 0 && (
                  <div className="custom-font-list">
                    <span className="custom-font-label">Your fonts</span>
                    {customFonts
                      .filter(f => f.name.toLowerCase().includes(fontQuery.toLowerCase()))
                      .map(f => (
                        <FontItem
                          key={f.name}
                          fontName={f.name}
                          text={sigText}
                          selected={sigFont === f.name}
                          onSelect={() => setSigFont(f.name)}
                        />
                      ))
                    }
                  </div>
                )}

                {/* Font list */}
                <div className="font-list">
                  {FONTS
                    .filter(f =>
                      (fontCategory === 'All' || f.category === fontCategory) &&
                      f.name.toLowerCase().includes(fontQuery.toLowerCase())
                    )
                    .slice(0, 24)
                    .map(f => (
                      <FontItem
                        key={f.name}
                        fontName={f.name}
                        text={sigText}
                        sample={f.sample}
                        selected={sigFont === f.name}
                        onSelect={() => setSigFont(f.name)}
                      />
                    ))
                  }
                </div>
              </div>
            )}

          </div>
        )}

        <div className="sidebar-footer">
          {activeTab === 'library' && (
            selectedStamp ? (
              <div className="status-bar active">
                <span className="pulse" />
                <span><strong>{selectedStamp.name}</strong> — click on document to place</span>
              </div>
            ) : stamps.length > 0 ? (
              <div className="status-bar">
                <span className="dot" />
                <span>Select a stamp above to begin</span>
              </div>
            ) : null
          )}

          {activeTab === 'create' && (
            <div className="create-footer">
              {createMode === 'type' && sigFont && (
                <div className="cf-selected">
                  <div
                    className="cf-preview"
                    style={{ fontFamily: `'${sigFont}', serif` }}
                  >
                    {sigText || 'Signature'}
                  </div>
                  <div className="cf-meta">
                    <span className="cf-font-name">{sigFont}</span>
                    {!sigText.trim() && (
                      <span className="cf-hint">Type your name above to preview</span>
                    )}
                  </div>
                </div>
              )}
              {createMode === 'draw' && (
                <div className="cf-draw-hint">
                  {hasDrawn.current ? 'Ready to add — looking good!' : 'Draw your signature above'}
                </div>
              )}
              <button
                className="btn-save-sig"
                onClick={saveSignature}
                disabled={createMode === 'draw' ? !hasDrawn.current : !sigText.trim()}
              >
                {createMode === 'type' && !sigText.trim()
                  ? 'Type your name to continue'
                  : 'Add to Library →'}
              </button>
            </div>
          )}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            {pdfFileName && (
              <div className="file-chip">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <rect x="1.5" y="1" width="9" height="10" rx="1.5" stroke="currentColor" strokeWidth="1"/>
                  <path d="M3.5 4.5h5M3.5 6.5h5M3.5 8.5h3" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                </svg>
                {pdfFileName}
              </div>
            )}
            {pageRendered && placedStamps.length > 0 && (
              <span className="placed-count">{placedStamps.length} stamp{placedStamps.length !== 1 ? 's' : ''} placed</span>
            )}
          </div>
          <div className="topbar-right">
            <button className="btn-theme mobile-toggle" onClick={() => setSidebarOpen(o => !o)} title="Stamps">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/>
                <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/>
                <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/>
                <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3"/>
              </svg>
            </button>
            <button className="btn-theme" onClick={() => setDark(d => !d)} title={dark ? 'Light mode' : 'Dark mode'}>
              {dark ? (
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                  <circle cx="7.5" cy="7.5" r="3" stroke="currentColor" strokeWidth="1.3"/>
                  <path d="M7.5 1v1.5M7.5 12.5V14M1 7.5h1.5M12.5 7.5H14M3.2 3.2l1.1 1.1M10.7 10.7l1.1 1.1M10.7 3.2l-1.1 1.1M3.2 10.7l1.1 1.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                  <path d="M13 9.5A6 6 0 015.5 2a6 6 0 000 11 6 6 0 007.5-3.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
            <button className="btn-secondary" onClick={() => docInputRef.current?.click()}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1.5" y="1" width="9" height="10" rx="1.5" stroke="currentColor" strokeWidth="1"/>
                <path d="M3.5 4.5h5M3.5 6.5h5M3.5 8.5h3" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
              </svg>
              <span className="btn-label">{pageRendered ? 'Change Document' : 'Upload Document'}</span>
            </button>
            <input ref={docInputRef} type="file" accept=".pdf" onChange={handleDocUpload} hidden />
            {pageRendered && placedStamps.length > 0 && (
              <button className="btn-download" onClick={handleDownload}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M7 1v8M4 6l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M1 10v1.5A1.5 1.5 0 002.5 13h9A1.5 1.5 0 0013 11.5V10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                <span className="btn-label">Download PDF</span>
              </button>
            )}
          </div>
        </header>

        <div
          ref={docAreaRef}
          className="doc-area"
          onDragOver={e => { e.preventDefault(); setIsDraggingOver(true) }}
          onDragLeave={() => setIsDraggingOver(false)}
          onDrop={handleDrop}
        >
          {!pageRendered && (
            <div className={`drop-zone ${isDraggingOver ? 'over' : ''}`} onClick={() => docInputRef.current?.click()}>
              <div className="drop-graphic">
                <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
                  <rect x="10" y="6" width="36" height="44" rx="4" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M19 20h18M19 27h18M19 34h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  <circle cx="42" cy="42" r="10" fill="var(--gold)" opacity="0.15" stroke="var(--gold)" strokeWidth="1.5"/>
                  <path d="M42 38v8M38 42h8" stroke="var(--gold)" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </div>
              <p className="drop-title">Upload PDF Certificate</p>
              <p className="drop-hint">Click to browse or drag & drop your document here</p>
            </div>
          )}

          <div className="canvas-wrapper" style={{ display: pageRendered ? 'flex' : 'none', width: canvasSize.w }}>
            <div className="page-label">Page 1</div>
            <div className="canvas-frame" style={{ width: canvasSize.w, height: canvasSize.h }}>
              <canvas ref={canvasRef} />
              <div
                ref={overlayRef}
                className={`overlay${selectedStamp ? ' placing' : ''}`}
                style={{ width: canvasSize.w, height: canvasSize.h }}
                onMouseDown={handleOverlayMouseDown}
              >
                {placedStamps.map(inst => {
                  const stamp = stamps.find(s => s.id === inst.stampId)
                  if (!stamp) return null
                  return (
                    <div
                      key={inst.id}
                      className="placed"
                      style={{ left: inst.x, top: inst.y, width: inst.w, height: inst.h }}
                      onMouseDown={e => startMove(e, inst)}
                    >
                      <img src={stamp.dataUrl} alt="" draggable={false} />
                      <button className="placed-remove" onMouseDown={e => removeInstance(e, inst.id)}>
                        <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M1 1l6 6M7 1L1 7" stroke="white" strokeWidth="1.5" strokeLinecap="round"/></svg>
                      </button>
                      <div className="placed-resize" onMouseDown={e => startResize(e, inst)} />
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
