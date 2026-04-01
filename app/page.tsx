'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

interface Recording {
  id: string;
  url: string;
  name: string;
  timestamp: Date;
}

export default function VoiceMemoApp() {
  const [isRecording, setIsRecording] = useState(false);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [status, setStatus] = useState<'idle' | 'requesting' | 'ready' | 'recording' | 'error'>('idle');
  const [elapsedTime, setElapsedTime] = useState(0);
  const [hasPermission, setHasPermission] = useState(false);
  const [isChecking, setIsChecking] = useState(true);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const audioStreamRef = useRef<MediaStream | null>(null);

  // Helper: Format time as MM:SS
  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // Canvas drawing loop
  const drawFrame = useCallback((now: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    // Background
    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Voice Icon (Simplified Mic)
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2 - 40;

    ctx.strokeStyle = '#fafafa';
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';

    // Mic Body
    ctx.beginPath();
    ctx.roundRect(centerX - 60, centerY - 120, 120, 200, 60);
    ctx.stroke();

    // Bottom arc
    ctx.beginPath();
    ctx.arc(centerX, centerY + 40, 120, 0.1, Math.PI - 0.1, false);
    ctx.stroke();

    // Stand
    ctx.beginPath();
    ctx.moveTo(centerX, centerY + 160);
    ctx.lineTo(centerX, centerY + 240);
    ctx.stroke();

    // Time Indication
    const currentElapsed = now - startTimeRef.current;
    setElapsedTime(currentElapsed);

    ctx.font = 'bold 84px sans-serif';
    ctx.fillStyle = '#fafafa';
    ctx.textAlign = 'center';
    ctx.fillText(formatTime(currentElapsed), centerX, centerY + 400);

    animationFrameRef.current = requestAnimationFrame(drawFrame);
  }, []);

  // Cleanup & Initial Permission Check
  useEffect(() => {
    const checkPermission = async () => {
      try {
        // Use Permissions API if available (Chrome, Firefox)
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
        } else {
          // Fallback for browsers like Safari: 
          // We can't check without prompting, so we just wait for user interaction.
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
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, []);

  const requestMicrophoneAccess = async () => {
    try {
      setStatus('requesting');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;
      setHasPermission(true);
      setStatus('ready');
    } catch (err) {
      console.error('Permission denied:', err);
      setStatus('error');
      // Only show alert if it was a manual click (actually better to show it always if it failed, 
      // but if we were just checking and it failed it might be confusing. 
      // However, if state was 'granted' it shouldn't fail.)
      if (err instanceof DOMException && err.name !== 'NotAllowedError') {
        alert('Microphone access is required to use this app.');
      }
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
    if (!hasPermission || !audioStreamRef.current) return;

    try {
      const canvas = canvasRef.current;
      if (!canvas) throw new Error('Canvas not initialized');

      startTimeRef.current = performance.now();
      drawFrame(startTimeRef.current);

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
        const name = `memo-${now.toLocaleDateString().replace(/\//g, '-')}-${now.getHours()}${now.getMinutes()}.${extension}`;

        setRecordings(prev => [{
          id: crypto.randomUUID(),
          url,
          name,
          timestamp: now,
        }, ...prev]);

        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      };

      recorder.start();
      setIsRecording(true);
      setStatus('recording');
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
    setStatus('ready');
    setElapsedTime(0);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    if (hasPermission) startRecording();
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    e.preventDefault();
    if (isRecording) stopRecording();
  };

  return (
    <main className="recorder-container" onContextMenu={(e) => e.preventDefault()}>
      <canvas
        ref={canvasRef}
        width={1080}
        height={1080}
        style={{ display: 'none' }}
      />

      <h1 className="text-3xl font-bold tracking-tight mb-4 text-center">Video Voice Memo</h1>

      {isChecking ? (
        <div className="flex flex-col items-center gap-6">
          <p className="text-center opacity-50">Checking microphone access...</p>
          <div className="w-8 h-8 border-4 border-rose-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : !hasPermission ? (
        <div className="flex flex-col items-center gap-6">
          <p className="text-center opacity-70">To start recording, we need permission to use your microphone.</p>
          <button
            onClick={requestMicrophoneAccess}
            className="px-8 py-4 bg-rose-500 rounded-full font-bold text-white shadow-lg hover:bg-rose-600 transition-colors"
          >
            Enable Microphone
          </button>
        </div>
      ) : (
        <>
          <div className="recording-info mb-4">
            {status === 'recording' ? (
              <span className="text-2xl font-mono text-rose-500 font-bold">{formatTime(elapsedTime)}</span>
            ) : (
              'Hold circle to record'
            )}
          </div>

          <button
            className={`record-button ${isRecording ? 'active' : ''}`}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            aria-label="Record button"
          >
            <svg
              width="64"
              height="64"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
              <line x1="12" x2="12" y1="19" y2="22" />
            </svg>
          </button>
        </>
      )}

      <div className="w-full max-w-md mt-12 px-4 overflow-y-auto" style={{ maxHeight: '40vh' }}>
        {recordings.map((rec) => (
          <div key={rec.id} className="memo-card">
            <div className="flex flex-col">
              <span className="font-semibold text-sm truncate max-w-[180px]">{rec.name}</span>
              <span className="text-xs opacity-50">{rec.timestamp.toLocaleTimeString()}</span>
            </div>
            <a
              href={rec.url}
              download={rec.name}
              className="download-link"
            >
              Download
            </a>
          </div>
        ))}
        {recordings.length === 0 && hasPermission && !isRecording && (
          <p className="text-center opacity-30 mt-4 text-sm">No memos recorded yet</p>
        )}
      </div>
    </main>
  );
}
