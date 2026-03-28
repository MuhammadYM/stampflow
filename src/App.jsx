import { useState, useRef, useEffect, useCallback } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import { PDFDocument } from 'pdf-lib'
import './App.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).href

const STAMP_DEFAULT_RATIO = 0.22 // 22% of canvas width

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
        if (d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225) {
          d[i + 3] = 0
        }
      }
      ctx.putImageData(imageData, 0, 0)
      resolve({
        dataUrl: canvas.toDataURL('image/png'),
        aspectRatio: w / h,
      })
    }
    img.src = dataUrl
  })
}

export default function App() {
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
  const [pdfPageSize, setPdfPageSize] = useState({ w: 0, h: 0 })
  const [isDraggingOver, setIsDraggingOver] = useState(false)

  const canvasRef = useRef(null)
  const overlayRef = useRef(null)
  const docInputRef = useRef(null)
  const stampInputRef = useRef(null)
  const docAreaRef = useRef(null)

  useEffect(() => {
    try { localStorage.setItem('sf_stamps', JSON.stringify(stamps)) } catch {}
  }, [stamps])

  const renderPDF = useCallback(async (buffer) => {
    const pdf = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise
    const page = await pdf.getPage(1)
    const viewport = page.getViewport({ scale: 1 })
    const containerW = (docAreaRef.current?.clientWidth || 800) - 64
    const targetW = Math.min(containerW, 860)
    const s = targetW / viewport.width
    const scaledVP = page.getViewport({ scale: s })

    setCanvasSize({ w: scaledVP.width, h: scaledVP.height })
    setPdfPageSize({ w: viewport.width, h: viewport.height })

    const canvas = canvasRef.current
    canvas.width = scaledVP.width
    canvas.height = scaledVP.height
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaledVP }).promise
    setPageRendered(true)
    setPlacedStamps([])
  }, [])

  const loadFile = useCallback((file) => {
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) return
    setPdfFileName(file.name)
    const reader = new FileReader()
    reader.onload = ev => {
      setPdfBuffer(ev.target.result)
      renderPDF(ev.target.result)
    }
    reader.readAsArrayBuffer(file)
  }, [renderPDF])

  const handleDocUpload = (e) => { loadFile(e.target.files[0]); e.target.value = '' }

  const handleDrop = (e) => {
    e.preventDefault()
    setIsDraggingOver(false)
    loadFile(e.dataTransfer.files[0])
  }

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
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const dx = cx - interaction.startX
    const dy = cy - interaction.startY
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

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <path d="M14 2L25.26 8.5V21.5L14 28L2.74 21.5V8.5L14 2Z" stroke="currentColor" strokeWidth="1.5" fill="none" />
              <path d="M14 8L19.2 11V17L14 20L8.8 17V11L14 8Z" fill="currentColor" opacity="0.4" />
            </svg>
          </div>
          <div>
            <h1 className="brand-name">StampFlow</h1>
            <p className="brand-sub">Digital Certification</p>
          </div>
        </div>

        <div className="sidebar-body">
          <div className="section-header">
            <span className="section-label">Stamp Library</span>
            <button className="btn-add" onClick={() => stampInputRef.current?.click()} title="Upload new stamp">
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
              <p>Upload your stamp or signature image</p>
              <button className="btn-upload-stamp" onClick={() => stampInputRef.current?.click()}>
                Upload Stamp
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
                + Add another
              </button>
            </div>
          )}
        </div>

        <div className="sidebar-footer">
          {selectedStamp ? (
            <div className="status-bar active">
              <span className="pulse" />
              <span><strong>{selectedStamp.name}</strong> — click on document to place</span>
            </div>
          ) : stamps.length > 0 ? (
            <div className="status-bar">
              <span className="dot" />
              <span>Select a stamp above to begin</span>
            </div>
          ) : null}
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
            <button className="btn-secondary" onClick={() => docInputRef.current?.click()}>
              {pageRendered ? 'Change Document' : 'Upload Document'}
            </button>
            <input ref={docInputRef} type="file" accept=".pdf" onChange={handleDocUpload} hidden />
            {pageRendered && placedStamps.length > 0 && (
              <button className="btn-download" onClick={handleDownload}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M7 1v8M4 6l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M1 10v1.5A1.5 1.5 0 002.5 13h9A1.5 1.5 0 0013 11.5V10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                Download PDF
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
