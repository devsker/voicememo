'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

function TaskbarClock() {
  const [time, setTime] = useState('');
  useEffect(() => {
    const update = () => {
      const now = new Date();
      const h = now.getHours().toString().padStart(2, '0');
      const m = now.getMinutes().toString().padStart(2, '0');
      setTime(`${h}:${m}`);
    };
    update();
    const id = setInterval(update, 10000);
    return () => clearInterval(id);
  }, []);
  return <div className="win-taskbar-clock">{time}</div>;
}

export default function VoiceMemoApp() {
  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef(false);
  const [status, setStatus] = useState<'idle' | 'requesting' | 'ready' | 'recording' | 'error'>('idle');
  const [elapsedTime, setElapsedTime] = useState(0);
  const [hasPermission, setHasPermission] = useState(false);
  const [isChecking, setIsChecking] = useState(true);
  const [vuLevels, setVuLevels] = useState<number[]>(new Array(20).fill(0));

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const audioStreamRef = useRef<MediaStream | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  const volumeHistoryRef = useRef<number[]>(new Array(60).fill(0));

  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    const ms100 = Math.floor((ms % 1000) / 10);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms100.toString().padStart(2, '0')}`;
  };

  const drawFrame = useCallback((now: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    if (isRecordingRef.current) {
      const currentElapsed = Math.max(0, now - startTimeRef.current);
      setElapsedTime(currentElapsed);
    }

    let rms = 0;
    if (analyserRef.current && dataArrayRef.current && audioStreamRef.current) {
      analyserRef.current.getByteTimeDomainData(dataArrayRef.current as any);
      let sumSquares = 0;
      for (let i = 0; i < dataArrayRef.current.length; i++) {
        const normalized = (dataArrayRef.current[i] / 128.0) - 1.0;
        sumSquares += normalized * normalized;
      }
      rms = Math.sqrt(sumSquares / dataArrayRef.current.length);
    }

    volumeHistoryRef.current.push(rms);
    volumeHistoryRef.current.shift();

    // Update VU meter bars
    const newLevels = Array.from({ length: 20 }, (_, i) => {
      const idx = Math.floor((i / 20) * volumeHistoryRef.current.length);
      return volumeHistoryRef.current[idx] * 10;
    });
    setVuLevels(newLevels);

    // Canvas draw for recording
    ctx.strokeStyle = '#ff3b30';
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    const numBars = volumeHistoryRef.current.length;
    const spacing = 14;
    const totalWidth = numBars * spacing;
    const startX = centerX - totalWidth / 2;
    for (let i = 0; i < numBars; i++) {
      const vol = volumeHistoryRef.current[i];
      let height = 4 + (vol * 1200);
      if (height > 600) height = 600;
      const x = startX + i * spacing;
      ctx.moveTo(x, centerY - height / 2);
      ctx.lineTo(x, centerY + height / 2);
    }
    ctx.stroke();

    ctx.font = '300 120px monospace';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    const timeToDraw = isRecordingRef.current
      ? formatTime(Math.max(0, now - startTimeRef.current)).split('.')[0]
      : '00:00';
    ctx.fillText(timeToDraw, centerX, centerY + 300);

    animationFrameRef.current = requestAnimationFrame(drawFrame);
  }, []);

  useEffect(() => {
    const checkPermission = async () => {
      try {
        if (navigator.permissions && navigator.permissions.query) {
          const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
          if (result.state === 'granted') {
            await requestMicrophoneAccess();
          }
          result.onchange = async () => {
            if (result.state === 'granted') {
              await requestMicrophoneAccess();
            } else if (result.state === 'denied') {
              setHasPermission(false);
              setStatus('idle');
            }
          };
        }
      } catch (err) {
        console.warn('Permissions API check failed:', err);
      } finally {
        setIsChecking(false);
      }
    };
    checkPermission();
    return () => {
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      if (audioStreamRef.current) audioStreamRef.current.getTracks().forEach(t => t.stop());
      if (audioCtxRef.current) audioCtxRef.current.close();
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, []);

  const requestMicrophoneAccess = async () => {
    try {
      setStatus('requesting');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;
      if (!audioCtxRef.current) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        const audioCtx = new AudioContextClass();
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyser);
        audioCtxRef.current = audioCtx;
        analyserRef.current = analyser;
        dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount);
      }
      if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume();
      }
      setHasPermission(true);
      setStatus('ready');
      if (!animationFrameRef.current) {
        animationFrameRef.current = requestAnimationFrame(drawFrame);
      }
    } catch (err) {
      console.error('Permission denied:', err);
      setStatus('error');
    }
  };

  const getSupportedMimeType = () => {
    const types = [
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=h264,opus',
      'video/webm',
    ];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  };

  const startRecording = async () => {
    if (!hasPermission) {
      await requestMicrophoneAccess();
      return;
    }
    if (!audioStreamRef.current) return;
    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
    try {
      const canvas = canvasRef.current;
      if (!canvas) throw new Error('Canvas not initialized');
      startTimeRef.current = performance.now();
      setIsRecording(true);
      isRecordingRef.current = true;
      setStatus('recording');
      if (!animationFrameRef.current) {
        drawFrame(performance.now());
      }
      const canvasStream = canvas.captureStream(30);
      const combinedStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...audioStreamRef.current.getAudioTracks(),
      ]);
      streamRef.current = combinedStream;
      const mimeType = getSupportedMimeType();
      if (!mimeType) throw new Error('No supported format found');
      const recorder = new MediaRecorder(combinedStream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const url = URL.createObjectURL(blob);
        const now = new Date();
        const name = `Voice Memo ${now.toLocaleDateString().replace(/\//g, '-')} ${now.getHours()}-${now.getMinutes()}-${now.getSeconds()}.${extension}`;
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
      };
      recorder.start();
    } catch (err) {
      console.error('Recording error:', err);
      setStatus('error');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    isRecordingRef.current = false;
    setStatus('ready');
    setElapsedTime(0);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    startRecording();
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    e.preventDefault();
    if (isRecordingRef.current) stopRecording();
  };

  const statusText = () => {
    if (isChecking) return 'Checking microphone permissions...';
    if (status === 'requesting') return 'Requesting microphone access...';
    if (status === 'error') return 'Error: Microphone access denied.';
    if (isRecording) return 'Recording...';
    if (status === 'ready') return 'Ready';
    return 'Press Record to begin.';
  };

  return (
    <div className="desktop" onContextMenu={(e) => e.preventDefault()}>
      <canvas ref={canvasRef} width={1080} height={1080} style={{ display: 'none' }} />

      {/* Window */}
      <div className="win-window" style={{ width: '400px', minWidth: '300px' }}>

        {/* Title bar */}
        <div className="win-titlebar">
          {/* Mic icon (inline SVG) */}
          <svg className="win-titlebar-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="5" y="1" width="6" height="9" rx="3" fill="white"/>
            <path d="M3 8a5 5 0 0010 0" stroke="white" strokeWidth="1.5" fill="none"/>
            <line x1="8" y1="13" x2="8" y2="15" stroke="white" strokeWidth="1.5"/>
            <line x1="5" y1="15" x2="11" y2="15" stroke="white" strokeWidth="1.5"/>
          </svg>
          <span style={{ flex: 1 }}>Sound Recorder</span>
          <div className="win-title-buttons">
            <button className="win-title-btn" aria-label="Minimize">_</button>
            <button className="win-title-btn" aria-label="Maximize">□</button>
            <button className="win-title-btn" style={{ fontWeight: 'bold' }} aria-label="Close">✕</button>
          </div>
        </div>

        {/* Menu bar */}
        <div className="win-menubar" role="menubar">
          <span className="win-menu-item" role="menuitem"><u>F</u>ile</span>
          <span className="win-menu-item" role="menuitem"><u>E</u>dit</span>
          <span className="win-menu-item" role="menuitem"><u>E</u>ffects</span>
          <span className="win-menu-item" role="menuitem"><u>H</u>elp</span>
        </div>

        {/* Body */}
        <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>

          {/* LED display */}
          <div className="win-led-display" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '32px', fontWeight: 'bold', letterSpacing: '0.2em', lineHeight: 1.1 }}>
              {formatTime(elapsedTime).split('.')[0]}
            </div>
            <div style={{ fontSize: '14px', marginTop: '2px', color: '#00cc00', minHeight: '18px' }}>
              {isRecording ? `.${formatTime(elapsedTime).split('.')[1]}` : '\u00a0'}
            </div>
          </div>

          {/* VU Meter */}
          <div className="win-label-group">
            <span className="win-label-title">Level</span>
            <div className="win-vu-track">
              {vuLevels.map((level, i) => {
                const h = Math.min(48, Math.max(2, level * 48));
                const pct = i / vuLevels.length;
                const cls = pct > 0.85 ? 'red' : pct > 0.65 ? 'yellow' : '';
                return (
                  <div
                    key={i}
                    className={`win-vu-bar ${cls}`}
                    style={{ height: `${h}px` }}
                    aria-hidden="true"
                  />
                );
              })}
            </div>
          </div>

          {/* Seek bar (decorative) */}
          <div>
            <div className="win-progress-track">
              <div
                className="win-progress-fill"
                style={{ width: isRecording ? '60%' : '0%' }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#666', marginTop: '2px' }}>
              <span>0:00</span>
              <span>{formatTime(elapsedTime).split('.')[0]}</span>
            </div>
          </div>

          {/* Control buttons */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
            {/* Seek start */}
            <button className="win-btn" aria-label="Seek to Start" title="Seek to Start" style={{ minWidth: 'auto', padding: '4px 8px' }}>
              ⏮
            </button>
            {/* Seek back */}
            <button className="win-btn" aria-label="Rewind" title="Rewind" style={{ minWidth: 'auto', padding: '4px 8px' }}>
              ◀◀
            </button>
            {/* Play */}
            <button className="win-btn" aria-label="Play" title="Play" style={{ minWidth: 'auto', padding: '4px 10px' }}>
              ▶
            </button>
            {/* Stop */}
            <button
              className="win-btn"
              aria-label="Stop"
              title="Stop"
              style={{ minWidth: 'auto', padding: '4px 8px' }}
              onClick={() => { if (isRecording) stopRecording(); }}
            >
              ■
            </button>
            {/* Seek fwd */}
            <button className="win-btn" aria-label="Fast Forward" title="Fast Forward" style={{ minWidth: 'auto', padding: '4px 8px' }}>
              ▶▶
            </button>
            {/* Seek end */}
            <button className="win-btn" aria-label="Seek to End" title="Seek to End" style={{ minWidth: 'auto', padding: '4px 8px' }}>
              ⏭
            </button>

            <div className="win-toolbar-separator" />

            {/* Record button */}
            {isChecking ? (
              <button className="win-btn" disabled aria-label="Record" title="Record" style={{ minWidth: 'auto', padding: '4px 10px' }}>
                <span className="record-dot" />
              </button>
            ) : (
              <button
                className={`win-btn ${isRecording ? 'active' : ''}`}
                aria-label={isRecording ? 'Stop Recording' : 'Start Recording'}
                title={isRecording ? 'Stop Recording' : 'Record'}
                style={{ minWidth: 'auto', padding: '4px 10px' }}
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
              >
                <span className={`record-dot ${isRecording ? 'blink' : ''}`} />
              </button>
            )}
          </div>
        </div>

        {/* Status bar */}
        <div className="win-statusbar" role="status" aria-live="polite">
          <div className="win-statusbar-panel">
            {statusText()}
          </div>
          <div className="win-statusbar-panel" style={{ flex: 'none', minWidth: '80px', textAlign: 'center' }}>
            {isRecording ? (
              <span style={{ color: '#cc0000', fontWeight: 'bold' }}>● REC</span>
            ) : (
              <span>Stopped</span>
            )}
          </div>
        </div>
      </div>

      {/* Desktop label under window */}
      <p style={{ color: '#ffffff', fontSize: '11px', marginTop: '8px', textShadow: '1px 1px 2px #000', fontFamily: 'Tahoma, Arial, sans-serif' }}>
        made by{' '}
        <a href="https://www.threads.com/@apfeltaschh" target="_blank" rel="noopener noreferrer" style={{ color: '#ffffff', textDecoration: 'underline' }}>
          @apfeltaschh
        </a>
      </p>

      {/* Taskbar */}
      <nav className="win-taskbar" aria-label="Taskbar">
        <button className="win-start-btn" aria-label="Start menu">
          {/* Windows flag icon */}
          <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
            <rect x="0" y="0" width="7" height="7" fill="#ff0000"/>
            <rect x="9" y="0" width="7" height="7" fill="#00aa00"/>
            <rect x="0" y="9" width="7" height="7" fill="#0000ff"/>
            <rect x="9" y="9" width="7" height="7" fill="#ffcc00"/>
          </svg>
          <strong>Start</strong>
        </button>

        <div className="win-toolbar-separator" style={{ height: '20px' }} />

        <div className="win-taskbar-task active" aria-label="Sound Recorder - active window">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="5" y="1" width="6" height="9" rx="3" fill="#000080"/>
            <path d="M3 8a5 5 0 0010 0" stroke="#000080" strokeWidth="1.5" fill="none"/>
            <line x1="8" y1="13" x2="8" y2="15" stroke="#000080" strokeWidth="1.5"/>
          </svg>
          Sound Recorder
        </div>

        <TaskbarClock />
      </nav>
    </div>
  );
}
