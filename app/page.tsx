'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import fixWebmDuration from 'fix-webm-duration';

/** Returns true when running inside the Threads (or Instagram) in-app browser.
 *  - Android Threads: UA contains "ThreadsAnd"
 *  - iOS Threads: uses the same WebView as Instagram, UA contains "Instagram"
 */
function isThreadsInAppBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /ThreadsAnd/i.test(ua) || /Instagram/i.test(ua);
}

export default function VoiceMemoApp() {
  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef(false); // Used inside the animation frame loop
  const [status, setStatus] = useState<'idle' | 'requesting' | 'ready' | 'recording' | 'error'>('idle');
  const [elapsedTime, setElapsedTime] = useState(0);
  const [hasPermission, setHasPermission] = useState(false);
  const [isChecking, setIsChecking] = useState(true);
  const [isThreadsBrowser, setIsThreadsBrowser] = useState<boolean>(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const recordingStartWallTimeRef = useRef<number>(0);
  const audioStreamRef = useRef<MediaStream | null>(null);

  // Web Audio API refs for real-time visualization
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  const volumeHistoryRef = useRef<number[]>(new Array(60).fill(0));

  // Helper: Format time as MM:SS.ms
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

    // A solid black background for the video stream
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    if (isRecordingRef.current) {
      const currentElapsed = Math.max(0, now - startTimeRef.current);
      setElapsedTime(currentElapsed);
    }

    // --- REAL-TIME AUDIO ANALYSIS ---
    let rms = 0;
    if (analyserRef.current && dataArrayRef.current && audioStreamRef.current) {
      // Get raw time-domain data (the actual audio wave)
      analyserRef.current.getByteTimeDomainData(dataArrayRef.current as any);

      // Calculate Root Mean Square (RMS) to get a clean volume level
      let sumSquares = 0;
      for (let i = 0; i < dataArrayRef.current.length; i++) {
        const normalized = (dataArrayRef.current[i] / 128.0) - 1.0;
        sumSquares += normalized * normalized;
      }
      rms = Math.sqrt(sumSquares / dataArrayRef.current.length);
    }

    // Push new volume to history and shift out the oldest
    volumeHistoryRef.current.push(rms);
    volumeHistoryRef.current.shift();

    // --- DRAW WAVEFORM ---
    ctx.strokeStyle = '#ff3b30';
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.beginPath();

    const numBars = volumeHistoryRef.current.length;
    const spacing = 14; // Width of bar + gap
    const totalWidth = numBars * spacing;
    const startX = centerX - totalWidth / 2;

    for (let i = 0; i < numBars; i++) {
      const vol = volumeHistoryRef.current[i];

      // Scale the RMS volume (typically 0.0 to 0.5 for normal speech) into a pixel height
      let height = 4 + (vol * 1200);
      if (height > 600) height = 600; // Cap maximum height

      const x = startX + i * spacing;
      ctx.moveTo(x, centerY - height / 2);
      ctx.lineTo(x, centerY + height / 2);
    }
    ctx.stroke();

    // Draw timer on canvas (this ends up in the saved video file)
    ctx.font = '300 120px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';

    const timeToDraw = isRecordingRef.current
      ? formatTime(Math.max(0, now - startTimeRef.current)).split('.')[0]
      : '00:00';
    ctx.fillText(timeToDraw, centerX, centerY + 300);

    // Loop
    animationFrameRef.current = requestAnimationFrame(drawFrame);
  }, []);

  useEffect(() => {
    // Detect Threads IAB on the client only (navigator is unavailable on the server)
    setIsThreadsBrowser(isThreadsInAppBrowser());

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
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach(track => track.stop());
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
      }
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, []);

  const requestMicrophoneAccess = async () => {
    try {
      setStatus('requesting');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;

      // Initialize Web Audio API for visualization
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

      // Browsers require audio context to be resumed after a user gesture
      if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume();
      }

      setHasPermission(true);
      setStatus('ready');

      // Start the drawing loop so the waveform reacts immediately even before recording
      if (!animationFrameRef.current) {
        animationFrameRef.current = requestAnimationFrame(drawFrame);
      }
    } catch (err) {
      console.error('Permission denied:', err);
      setStatus('error');
      if (err instanceof DOMException && err.name !== 'NotAllowedError') {
        alert('Microphone access is required to use this app.');
      }
    }
  };

  const getSupportedMimeType = () => {
    // Always prefer MP4 — it works on iOS Safari and is widely supported.
    // WebM is kept as a fallback for browsers that don't support MP4 recording.
    const types = [
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=h264,opus',
      'video/webm',
    ];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        console.log('[VoiceMemo] Recording format:', type);
        return type;
      }
    }
    return '';
  };

  const startRecording = async () => {
    if (!hasPermission) {
      await requestMicrophoneAccess();
      return;
    }
    if (!audioStreamRef.current) return;

    // Ensure audio context is active (in case it suspended)
    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }

    try {
      const canvas = canvasRef.current;
      if (!canvas) throw new Error('Canvas not initialized');

      // Start time
      startTimeRef.current = performance.now();
      recordingStartWallTimeRef.current = Date.now();

      setIsRecording(true);
      isRecordingRef.current = true;
      setStatus('recording');

      // Make sure the loop is running
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

      recorder.onstop = async () => {
        const isWebm = mimeType.includes('webm');
        const extension = isWebm ? 'webm' : 'mp4';
        const rawBlob = new Blob(chunksRef.current, { type: mimeType });

        // Fix WebM duration metadata — without this, the file header
        // has no duration info which causes Threads/editors to show 0:00
        const duration = Date.now() - recordingStartWallTimeRef.current;
        console.log('[VoiceMemo] Recording duration:', duration, 'ms, format:', mimeType);
        let blob: Blob;
        if (isWebm) {
          console.log('[VoiceMemo] Fixing WebM duration metadata...');
          blob = await fixWebmDuration(rawBlob, duration, { logger: false });
          console.log('[VoiceMemo] WebM fixed. Original:', rawBlob.size, 'bytes → Fixed:', blob.size, 'bytes');
        } else {
          blob = rawBlob;
        }

        const url = URL.createObjectURL(blob);
        const now = new Date();
        const name = `Voice Memo ${now.toLocaleDateString().replace(/\//g, '-')} ${now.getHours()}-${now.getMinutes()}-${now.getSeconds()}.${extension}`;

        // Auto Download
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();

        // Cleanup after download
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
      };

      recorder.start();
    } catch (err) {
      console.error('Recording stopped unexpectedly:', err);
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
    if (isRecordingRef.current) {
      stopRecording();
    }
  };

  return (
    <div className="app-container" onContextMenu={(e) => e.preventDefault()}>

      {/* Threads in-app browser warning overlay */}
      {isThreadsBrowser && (
        <div style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          background: 'rgba(0,0,0,0.75)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}>
          <div style={{
            background: '#1c1c1e',
            border: '1px solid #38383a',
            borderRadius: '20px',
            padding: '2.5rem 2rem',
            maxWidth: '340px',
            width: '100%',
            textAlign: 'center',
            color: '#ffffff',
            boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
          }}>
            <span style={{ display: 'block', fontSize: '3rem', marginBottom: '1rem' }}>🚫</span>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 0.75rem', letterSpacing: '-0.01em' }}>
              Open in your browser
            </h2>
            <p style={{ fontSize: '0.9375rem', lineHeight: 1.55, color: 'rgba(235,235,245,0.8)', margin: 0 }}>
              The Threads in-app browser doesn&rsquo;t support microphone access.
              Tap the menu and choose <strong style={{ color: '#fff', fontWeight: 600 }}>Open in browser</strong> to use this app.
            </p>
          </div>
        </div>
      )}

      <canvas
        ref={canvasRef}
        width={1080}
        height={1080}
        style={{ display: 'none' }}
      />

      {/* Central display area with the timer */}
      <div className="display-area">
        <p className="text-8xl font-light tabular-nums" style={{ color: 'var(--foreground)' }}>
          {formatTime(elapsedTime).split('.')[0]}
        </p>
        <p className="text-xl font-medium opacity-50 mt-4 tabular-nums" style={{ minHeight: '30px' }}>
          {isRecording ? `.${formatTime(elapsedTime).split('.')[1]}` : ''}
        </p>
      </div>

      {/* Record button area */}
      <div className="record-area">
        {!isChecking && (
          <div
            className="record-button-container animate-pop-in"
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            aria-label={isRecording ? "Stop recording" : "Start recording"}
          >
            <div className="record-ring" />
            <div className={`record-inner ${isRecording ? 'recording' : ''}`} />
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="pb-8 text-center text-xs font-medium opacity-40">
        made by <a href="https://www.threads.com/@apfeltaschh" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:opacity-80 transition-opacity">@apfeltaschh</a> ❤️
      </footer>

    </div>
  );
}
