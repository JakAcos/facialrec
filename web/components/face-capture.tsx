"use client";

import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { Camera, Check, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CAPTURE, guide, measurePose, type Pose, type Step } from "@/lib/pose";
import { cn } from "@/lib/utils";

const STEP_LABEL: Record<Step, string> = {
  center: "Look straight",
  left: "Turn left",
  right: "Turn right",
};

const CAMERA_KEY = "facialrec.camera";
const FRAME_WIDTH = 640;
const TICK_MS = 90;

type CameraError = { title: string; detail: string };

function describeCameraError(error: unknown): CameraError {
  const name = (error as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      title: "Camera access is blocked",
      detail:
        "Allow camera access for this site in your browser settings, then try again.",
    };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return {
      title: "No camera found",
      detail: "Connect a camera, or pick a different one, and try again.",
    };
  }
  if (name === "NotReadableError") {
    return {
      title: "The camera is busy",
      detail: "Another app may be using it. Close that app and try again.",
    };
  }
  return {
    title: "The camera could not start",
    detail: "Reload the page and try again.",
  };
}

/**
 * The guided camera. It walks the user through each pose in `steps`,
 * takes one frame per pose when the pose is right, and hands the frames
 * back. It never decides anything about identity: the server does that.
 */
export function FaceCapture({
  steps,
  onComplete,
}: {
  steps: Step[];
  onComplete: (frames: Blob[]) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const framesRef = useRef<Blob[]>([]);
  const holdRef = useRef(0);
  const stepRef = useRef(0);
  const busyRef = useRef(false);

  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<CameraError | null>(null);
  const [tracker, setTracker] = useState<"loading" | "ready" | "manual">("loading");
  const [stepIndex, setStepIndex] = useState(0);
  const [hint, setHint] = useState("Starting camera…");
  const [holding, setHolding] = useState(false);
  const [pose, setPose] = useState<Pose | null>(null);

  const step = steps[Math.min(stepIndex, steps.length - 1)];
  const done = stepIndex >= steps.length;

  // --- Camera -------------------------------------------------------------
  const startCamera = useCallback(async (wanted: string | null) => {
    setCameraError(null);
    setCameraReady(false);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError({
        title: "Camera is not available",
        detail: "This page needs a secure (https) connection to use the camera.",
      });
      return;
    }
    const base = { width: { ideal: 1280 }, height: { ideal: 720 } };
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: wanted
            ? { ...base, deviceId: { exact: wanted } }
            : { ...base, facingMode: "user" },
        });
      } catch (error) {
        // A remembered camera may have been unplugged: fall back to any camera.
        if (!wanted) throw error;
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { ...base, facingMode: "user" },
        });
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      setCameraReady(true);

      const devices = await navigator.mediaDevices.enumerateDevices();
      setCameras(devices.filter((d) => d.kind === "videoinput"));
      const active = stream.getVideoTracks()[0]?.getSettings().deviceId ?? null;
      setDeviceId(active);
    } catch (error) {
      setCameraError(describeCameraError(error));
    }
  }, []);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(CAMERA_KEY);
    } catch {}
    // eslint-disable-next-line react-hooks/set-state-in-effect -- starting the camera is the effect
    void startCamera(saved);
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [startCamera]);

  const chooseCamera = (id: string) => {
    try {
      localStorage.setItem(CAMERA_KEY, id);
    } catch {}
    void startCamera(id);
  };

  // --- Face tracker (runs in the browser, only for guidance) ---------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const vision = await import("@mediapipe/tasks-vision");
        const fileset = await vision.FilesetResolver.forVisionTasks("/mediapipe/wasm");
        const landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: "/mediapipe/face_landmarker.task",
            delegate: "CPU",
          },
          runningMode: "VIDEO",
          numFaces: 2,
        });
        if (cancelled) {
          landmarker.close();
          return;
        }
        landmarkerRef.current = landmarker;
        setTracker("ready");
      } catch {
        // Guidance is a convenience. Without it the user captures by hand
        // and the server still checks every frame.
        if (!cancelled) setTracker("manual");
      }
    })();
    return () => {
      cancelled = true;
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
    };
  }, []);

  // --- Taking a frame -----------------------------------------------------
  const takeFrame = useCallback(async (): Promise<Blob | null> => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return null;
    const scale = Math.min(1, FRAME_WIDTH / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    // Drawn as the camera sees it. Only the on-screen preview is mirrored.
    canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  }, []);

  const capture = useCallback(async () => {
    if (busyRef.current || stepRef.current >= steps.length) return;
    busyRef.current = true;
    const blob = await takeFrame();
    if (blob) {
      framesRef.current.push(blob);
      stepRef.current += 1;
      holdRef.current = 0;
      setHolding(false);
      setStepIndex(stepRef.current);
      if (stepRef.current >= steps.length) {
        setHint("Checking…");
        onComplete(framesRef.current);
      }
    }
    busyRef.current = false;
  }, [onComplete, steps.length, takeFrame]);

  // --- Guidance loop ------------------------------------------------------
  useEffect(() => {
    if (tracker !== "ready" || !cameraReady || done) return;
    const timer = setInterval(() => {
      const video = videoRef.current;
      const landmarker = landmarkerRef.current;
      if (!video || !landmarker || video.readyState < 2 || busyRef.current) return;
      let result;
      try {
        result = landmarker.detectForVideo(video, performance.now());
      } catch {
        return;
      }
      const faces = result.faceLandmarks;
      const measured = faces.map((f) =>
        measurePose(f, video.videoWidth, video.videoHeight),
      );
      measured.sort((a, b) => b.faceWidth - a.faceWidth);
      const main = measured[0] ?? null;
      // Small faces in the background are not a second person at the camera.
      const count = main
        ? measured.filter((m) => m.faceWidth >= main.faceWidth * 0.5).length
        : 0;
      const current = steps[stepRef.current];
      const guidance = guide(current, main, count);
      setPose(main);
      setHint(guidance.hint);
      setHolding(guidance.ok);
      holdRef.current = guidance.ok ? holdRef.current + 1 : 0;
      if (holdRef.current >= CAPTURE.holdTicks) void capture();
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [tracker, cameraReady, done, steps, capture]);

  // --- Render -------------------------------------------------------------
  if (cameraError) {
    return (
      <div
        className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-surface p-8 text-center"
        data-testid="camera-error"
      >
        <Camera className="h-10 w-10 text-muted" aria-hidden />
        <div>
          <p className="font-semibold">{cameraError.title}</p>
          <p className="mt-1 text-sm text-muted">{cameraError.detail}</p>
        </div>
        <Button variant="secondary" onClick={() => void startCamera(null)}>
          Try again
        </Button>
      </div>
    );
  }

  const manual = tracker === "manual";
  const manualHint: Record<Step, string> = {
    center: "Look straight at the camera, then press Capture",
    left: "Turn your head to your left, then press Capture",
    right: "Turn your head to your right, then press Capture",
  };
  const shownHint = done
    ? "Checking…"
    : !cameraReady
      ? "Starting camera…"
      : tracker === "loading"
        ? "Getting ready…"
        : manual
          ? manualHint[step]
          : hint;

  return (
    <div
      className="flex flex-col gap-4"
      data-testid="face-capture"
      data-step={done ? "done" : step}
      data-tracker={tracker}
      data-yaw={pose ? pose.yaw.toFixed(3) : ""}
      data-pitch={pose ? pose.pitch.toFixed(3) : ""}
    >
      <div className="relative mx-auto aspect-[3/4] w-full max-w-sm overflow-hidden rounded-3xl bg-black sm:aspect-[4/3] sm:max-w-xl">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="h-full w-full -scale-x-100 object-cover"
        />
        {/* Oval guide */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            className={cn(
              "mb-[8%] h-[68%] w-[58%] rounded-[50%] border-4 transition-colors duration-200 sm:w-[36%]",
              done
                ? "border-success"
                : holding
                  ? "border-accent"
                  : "border-white/60",
            )}
            style={{ boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.45)" }}
          />
        </div>
        {/* Direction arrow. The preview is mirrored, so the user's left is screen left. */}
        {!done && cameraReady && step !== "center" && (
          <div
            className={cn(
              "pointer-events-none absolute top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-2 text-black shadow-lg",
              step === "left" ? "left-4" : "right-4",
            )}
          >
            {step === "left" ? (
              <ChevronLeft className="h-7 w-7" aria-hidden />
            ) : (
              <ChevronRight className="h-7 w-7" aria-hidden />
            )}
          </div>
        )}
        {(!cameraReady || tracker === "loading") && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <Loader2 className="h-8 w-8 animate-spin text-white" aria-hidden />
          </div>
        )}
        {/* The instruction sits on the camera view so it is always visible, even on a small phone. */}
        <p
          className="absolute inset-x-3 bottom-3 rounded-2xl bg-black/65 px-4 py-2.5 text-center text-base font-medium text-white backdrop-blur sm:text-lg"
          aria-live="polite"
          data-testid="face-hint"
        >
          {shownHint}
        </p>
        {cameras.length > 1 && !done && (
          <select
            aria-label="Camera"
            value={deviceId ?? ""}
            onChange={(e) => chooseCamera(e.target.value)}
            className="absolute right-3 top-3 max-w-[60%] cursor-pointer truncate rounded-lg border border-white/30 bg-black/60 px-2 py-1.5 text-xs text-white backdrop-blur"
          >
            {cameras.map((camera, i) => (
              <option key={camera.deviceId} value={camera.deviceId}>
                {camera.label || `Camera ${i + 1}`}
              </option>
            ))}
          </select>
        )}
      </div>


      <ol className="flex items-center justify-center gap-2">
        {steps.map((s, i) => (
          <li
            key={`${s}-${i}`}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
              i < stepIndex
                ? "border-success/40 bg-success-soft text-success"
                : i === stepIndex
                  ? "border-accent/50 bg-accent-soft text-accent"
                  : "border-border text-muted",
            )}
          >
            {i < stepIndex && <Check className="h-3.5 w-3.5" aria-hidden />}
            {STEP_LABEL[s]}
          </li>
        ))}
      </ol>

      {manual && !done && cameraReady && (
        <Button className="mx-auto" onClick={() => void capture()} data-testid="manual-capture">
          <Camera className="h-4 w-4" aria-hidden />
          Capture
        </Button>
      )}
    </div>
  );
}
