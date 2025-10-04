import React, { useEffect, useMemo, useRef, useState } from "react";

// 53‑TET Keyboard – Web Audio React App (D4‑centric)
// Now lighter: self‑tests moved to a separate document. This file exposes
// testable helpers on `window.__testables_53tet` for the test harness.

// ------------------------------ Constants & Math ------------------------------
const D4_FREQ = 293.6647679; // Hz
const D4_MIDI = 62; // MIDI for D4
const STEPS = 53; // steps per octave
const R = Math.pow(2, 1 / STEPS); // ratio per step (koma)
const CENTS_PER_STEP = 1200 / STEPS; // ≈ 22.6415

// Keyboard span: perfect fifth in 53‑TET is 31 komas (~702 cents)
const MAX_STEP = 31; // inclusive (0..31)
const KEYS_COUNT = MAX_STEP + 1; // 32 keys

// Visual fade time helper
const MIN_REL = 0.03; // 30ms minimum to avoid hard cuts
function visualReleaseMs(rel: number) {
  return Math.max(90, Math.round((Math.max(MIN_REL, rel) + 0.01) * 1000));
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function midiNameFromSemis(semitonesFromD4: number) {
  const midi = D4_MIDI + semitonesFromD4;
  const name = NOTE_NAMES[(midi % 12 + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

// Helpers
function baseFreqFromSemitones(semitonesFromD4: number): number {
  return D4_FREQ * Math.pow(2, semitonesFromD4 / 12);
}
function freqForStepFromBase(step: number, baseFreq: number): number {
  return baseFreq * Math.pow(R, step);
}
const fmtHz = (f: number) => (f < 1000 ? f.toFixed(2) : f.toFixed(1));
const fmtCents = (c: number) => c.toFixed(2);
const cents = (ratio: number) => 1200 * Math.log2(ratio);
const fmtSigned1 = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)} cents`;

// Choose nearest member from a set (for snapping to existing marker steps)
function nearestFromSet(target: number, set: Set<number>): number {
  let best = Infinity; let choice = target;
  set.forEach((s) => { const d = Math.abs(s - target); if (d < best) { best = d; choice = s; } });
  return choice;
}

// ------------------------------ Çeşni definitions ------------------------------

type CesniChoice = { id: string; label: string; steps: number[] };
const CESNI_OPTIONS: CesniChoice[] = [
  { id: 'none', label: 'None', steps: [] },
  { id: 'kurdi_penta', label: 'Kürdi pentachord', steps: [0, 4, 13, 22, 31] },
  // Rename old Rast [0,9,18,22,31] to Cargah
  { id: 'cargah_penta', label: 'Çargah pentachord', steps: [0, 9, 18, 22, 31] },
  // Updated Rast
  { id: 'rast_penta', label: 'Rast pentachord', steps: [0, 9, 17, 22, 31] },
  { id: 'buselik_penta', label: 'Buselik pentachord', steps: [0, 9, 13, 22, 31] },
  // Updated tetrachords/pentachords
  { id: 'ussak_tetra', label: 'Uşşak tetrachord', steps: [0, 8, 13, 22] },
  { id: 'sabah_tetra', label: 'Sabah tetrachord', steps: [0, 8, 13, 18] },
  { id: 'hicaz_penta', label: 'Hicaz pentachord', steps: [0, 5, 17, 22, 31] },
  { id: 'segah_penta', label: 'Segah pentachord', steps: [0, 5, 14, 22, 31] },
  { id: 'huseyni_penta', label: 'Hüseyni pentachord', steps: [0, 8, 13, 22, 31] },
  { id: 'custom', label: 'Custom (enter steps)', steps: [] },
];

// Parse helper for custom steps
function parseStepList(s: string): { steps: number[]; error: string | null } {
  if (!s.trim()) return { steps: [], error: null };
  const tokens = s.split(/[^0-9]+/).filter(Boolean);
  const nums: number[] = [];
  for (const t of tokens) {
    const n = Number(t);
    if (!Number.isInteger(n)) return { steps: [], error: `Non-integer token: '${t}'` };
    if (n < 0 || n > 31) return { steps: [], error: `Out of range: ${n} (use 0–31)` };
    nums.push(n);
  }
  const uniq = Array.from(new Set(nums)).sort((a, b) => a - b);
  return { steps: uniq, error: null };
}

// Smooth release curve (S‑curve)
function buildSmoothDecayCurve(start: number, end = 1e-4, points = 256): Float32Array {
  const n = Math.max(2, points | 0);
  const floor = Math.max(end, 1e-6);
  const s0 = Math.max(start || floor, floor);
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const smooth = t * t * (3 - 2 * t); // smoothstep
    const y = floor + (s0 - floor) * (1 - smooth);
    curve[i] = y;
  }
  return curve;
}

// Map keyboard keys A,S,D,F,G to the first five steps of the selected çeşni
function resolveStepForKey(key: string, steps: number[]): number | null {
  const order = ['a','s','d','f','g'];
  const idx = order.indexOf(key.toLowerCase());
  if (idx === -1) return null;
  if (idx >= steps.length) return null; // tetrachords: 'g' does nothing
  return steps[idx] ?? null;
}

// --- Expose testables for the external self‑tests doc ---
if (typeof window !== 'undefined') {
  (window as any).__testables_53tet = {
    D4_FREQ, D4_MIDI, STEPS, R, CENTS_PER_STEP,
    baseFreqFromSemitones, freqForStepFromBase, cents, fmtSigned1,
    nearestFromSet, visualReleaseMs, parseStepList, resolveStepForKey,
    CESNI_OPTIONS,
  };
}

// ------------------------------ WebAudio Voice ------------------------------
class Voice {
  ctx: AudioContext;
  osc: OscillatorNode;
  gain: GainNode;
  private _stopped = false;

  constructor(ctx: AudioContext, type: OscillatorType, frequency: number, gainTarget: number, attack: number) {
    this.ctx = ctx;
    this.osc = ctx.createOscillator();
    this.osc.type = type;
    this.osc.frequency.value = frequency;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.osc.connect(this.gain).connect(ctx.destination);
    this.osc.start();
    const now = ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(0, now);
    this.gain.gain.linearRampToValueAtTime(gainTarget, now + Math.max(0.001, attack));
  }

  setFrequency(freq: number) { this.osc.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.01); }
  setGain(target: number) { this.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.01); }
  setWaveform(type: OscillatorType) { this.osc.type = type; }

  stop(release: number, onEnded?: () => void) {
    if (this._stopped) return; this._stopped = true;
    const now = this.ctx.currentTime; const rel = Math.max(0.03, release);
    const current = this.gain.gain.value;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(Math.max(current, 0.0001), now);
    const rampEnd = now + rel;
    try {
      const curve = buildSmoothDecayCurve(this.gain.gain.value, 1e-4, 256);
      this.gain.gain.setValueCurveAtTime(curve, now, rel);
    } catch {
      try { this.gain.gain.linearRampToValueAtTime(0.0001, rampEnd); }
      catch { this.gain.gain.setTargetAtTime(0.0001, now, Math.max(0.01, rel / 3)); }
    }
    this.gain.gain.setValueAtTime(0, rampEnd + 0.008);
    if (onEnded) this.osc.onended = onEnded as any;
    this.osc.stop(rampEnd + 0.010);
  }
}

// ------------------------------ Component ------------------------------
export default function FiftyThreeTETKeyboard() {
  // Synth params
  const [waveform, setWaveform] = useState<OscillatorType>("sine");
  const [gain, setGain] = useState(0.15);
  const [attack, setAttack] = useState(0.01);
  const [release, setRelease] = useState(0.45); // 75% of 0.6s max
  const [sustain, setSustain] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  const [isTouch, setIsTouch] = useState(false);
  const [lastTestRun, setLastTestRun] = useState<number | null>(null);

  // Base pitch (12‑TET semitones from D4)
  const [transpose12, setTranspose12] = useState<number>(0);
  // Marker visibility
  const [showTet, setShowTet] = useState(true);
  const [showJust, setShowJust] = useState(true);

  // Çeşni selection (for highlights)
  const [cesniId, setCesniId] = useState<string>('rast_penta');
  const [customStepsStr, setCustomStepsStr] = useState<string>('');
  const customParsed = useMemo(() => parseStepList(customStepsStr), [customStepsStr]);
  const cesniSteps = useMemo(() => {
    if (cesniId === 'custom') return customParsed.error ? [] : customParsed.steps;
    return CESNI_OPTIONS.find(o => o.id === cesniId)?.steps ?? [];
  }, [cesniId, customParsed]);
  const cesniSet = useMemo(() => new Set<number>(cesniSteps), [cesniSteps]);

  // Force re-render on ref map updates
  const [, setUiPulse] = useState(0);
  const tick = () => setUiPulse((v) => (v + 1) % 1_000_000);

  // Audio
  const audioRef = useRef<AudioContext | null>(null);
  const getCtx = () => {
    if (!audioRef.current) audioRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    return audioRef.current;
  };

  // Active voices and effects
  const activePointers = useRef<Set<number>>(new Set());
  const activeVoices = useRef<Map<number, { voice: Voice; step: number }>>(new Map());
  const latchedVoices = useRef<Map<number, Voice>>(new Map());
  const activeKeys = useRef<Map<string, { voice: Voice; step: number }>>(new Map());
  const glowCounts = useRef<Map<number, number>>(new Map());
  const fadeInfo = useRef<Map<number, { startedAt: number; durationMs: number }>>(new Map()); // step → fade state

  // Hotkey guards (Option A + select-open handling)
  const selectOpenRef = useRef(false);

  // Touch tooltip state for 12‑TET row (press‑and‑scrub)
  const tetRowRef = useRef<HTMLDivElement | null>(null);
  const isScrubbingTet = useRef(false);
  const tetTipStepRef = useRef<number | null>(null);
  const [tetTip, setTetTip] = useState<{ left: number; text: string } | null>(null);

  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // Inline self-test runner (logs to console)
  const runSelfTestsInline = () => {
    const T = (window as any).__testables_53tet;
    if (!T) { console.warn("⛔ __testables_53tet not found. Open this app preview first."); return; }
    const {
      D4_FREQ, STEPS, R, CENTS_PER_STEP,
      baseFreqFromSemitones, freqForStepFromBase, cents, fmtSigned1,
      nearestFromSet, visualReleaseMs, parseStepList, resolveStepForKey,
      CESNI_OPTIONS,
    } = T;
    const ok = (m: string) => console.log('✅ '+m);
    const bad = (m: string) => console.warn('❌ '+m);
    const close = (a: number, b: number, t: number) => Math.abs(a-b) <= t;
    console.groupCollapsed('53-TET Self-tests');
    try {
      close(Math.pow(R,53), 2, 1e-6) ? ok('(2^(1/53))^53 ≈ 2') : bad('ratio');
      close(31*CENTS_PER_STEP, 701.955, 0.5) ? ok('31 steps ≈ perfect fifth') : bad('fifth');
      close(baseFreqFromSemitones(0), D4_FREQ, 0.02) ? ok('base semitones 0 = D4') : bad('base semitones 0');
      // Extra usage to satisfy TS (and verify correctness)
      close(freqForStepFromBase(0, D4_FREQ), D4_FREQ, 1e-4) ? ok('freqForStepFromBase step0 = base') : bad('freqForStepFromBase');
      (fmtSigned1(-3.25) === "-3.3 cents") ? ok('fmtSigned1 rounding') : bad('fmtSigned1');
      const tetSteps = Array.from({length:8},(_,s)=> Math.round((STEPS*s)/12));
      JSON.stringify(tetSteps)===JSON.stringify([0,4,9,13,18,22,27,31]) ? ok('12‑TET markers') : bad('12‑TET markers');
      const justSteps = [1/1,16/15,9/8,6/5,5/4,4/3,45/32,3/2].map((r:number)=> Math.round(cents(r)/CENTS_PER_STEP));
      JSON.stringify(justSteps)===JSON.stringify([0,5,9,14,17,22,26,31]) ? ok('Just markers') : bad('Just markers');
      const byId = (id: string)=> CESNI_OPTIONS.find((o:any)=>o.id===id)?.steps || [];
      JSON.stringify(byId('huseyni_penta'))===JSON.stringify([0,8,13,22,31]) ? ok('Huseyni def') : bad('Huseyni def');
      parseStepList('32').error ? ok('parse range error') : bad('parse range');
      resolveStepForKey('g',[0,8,13,22])===null ? ok('G ignored for tetrachord') : bad('G mapping');
      nearestFromSet(12,new Set([0,4,9,13,18,22,27,31]))===13 ? ok('nearestFromSet') : bad('nearestFromSet');
      (visualReleaseMs(0.05) >= 90) ? ok('visualReleaseMs floor') : bad('visualReleaseMs');
    } finally {
      console.groupEnd();
      setLastTestRun(Date.now());
    }
  };

  const incGlow = (step: number) => {
    const m = glowCounts.current; m.set(step, (m.get(step) || 0) + 1);
    fadeInfo.current.delete(step);
    tick();
  };
  const maybeBeginFade = (step: number) => {
    const count = glowCounts.current.get(step) || 0;
    if (count <= 1) {
      fadeInfo.current.set(step, { startedAt: nowMs(), durationMs: visualReleaseMs(release) });
      tick();
    }
  };
  const decGlow = (step: number) => {
    const m = glowCounts.current; const next = (m.get(step) || 0) - 1;
    if (next <= 0) { m.delete(step); fadeInfo.current.delete(step); } else { m.set(step, next); }
    tick();
  };

  // UI readouts
  const [activeHz, setActiveHz] = useState<number | null>(null);
  const [activeStep, setActiveStep] = useState<number | null>(null);

  // Keys metadata 0..31
  const keys = useMemo(() => Array.from({ length: KEYS_COUNT }, (_, n) => ({ step: n, cents: n * CENTS_PER_STEP })), []);

  const baseFreq = useMemo(() => baseFreqFromSemitones(transpose12), [transpose12]);
  const baseName = useMemo(() => midiNameFromSemis(transpose12), [transpose12]);

  // 12‑TET markers snapped to nearest koma (0..7 semitones → 0..31 steps)
  const tetData = useMemo(() => {
    const deltaMap = new Map<number, number>();
    const cells: (string | null)[] = Array.from({ length: KEYS_COUNT }, () => null);
    for (let s = 0; s <= 7; s++) {
      const idealCents = s * 100; // exact 12‑TET position in cents
      const step = Math.round((STEPS * s) / 12); // nearest 53‑TET step
      if (step >= 0 && step <= MAX_STEP) {
        const midi = D4_MIDI + transpose12 + s;
        const name = NOTE_NAMES[(midi % 12 + 12) % 12];
        cells[step] = name;
        const snappedCents = step * CENTS_PER_STEP;
        deltaMap.set(step, snappedCents - idealCents);
      }
    }
    return { cells, deltaMap };
  }, [transpose12]);

  // Just (5‑limit) markers snapped to nearest koma across 0..31
  const justCells = useMemo(() => {
    const intervals: { name: string; ratio: number }[] = [
      { name: '1/1', ratio: 1/1 },
      { name: '16/15', ratio: 16/15 },
      { name: '9/8', ratio: 9/8 },
      { name: '6/5', ratio: 6/5 },
      { name: '5/4', ratio: 5/4 },
      { name: '4/3', ratio: 4/3 },
      { name: '45/32', ratio: 45/32 },
      { name: '3/2', ratio: 3/2 },
    ];
    const map = new Map<number, string>();
    for (const it of intervals) {
      const step = Math.round(cents(it.ratio) / CENTS_PER_STEP);
      if (step >= 0 && step <= MAX_STEP) map.set(step, it.name);
    }
    const cells: (string | null)[] = Array.from({ length: KEYS_COUNT }, () => null);
    map.forEach((label, step) => { cells[step] = label; });
    return cells;
  }, []);

  // Sets for coloring Çeşni keys by alignment
  const tetStepSet = useMemo(() => new Set<number>(tetData.cells.map((lbl, i) => (lbl ? i : -1)).filter(i => i >= 0)), [tetData]);
  const justStepSet = useMemo(() => new Set<number>(justCells.map((lbl, i) => (lbl ? i : -1)).filter(i => i >= 0)), [justCells]);

  // Housekeeping
  const allOff = () => {
    activeVoices.current.forEach(({ voice, step }) => { maybeBeginFade(step); voice.stop(release, () => decGlow(step)); });
    activeVoices.current.clear();
    activePointers.current.clear();
    activeKeys.current.forEach(({ voice, step }) => { maybeBeginFade(step); voice.stop(release, () => decGlow(step)); });
    activeKeys.current.clear();
    latchedVoices.current.forEach((v, step) => { maybeBeginFade(step); v.stop(release, () => decGlow(step)); });
    latchedVoices.current.clear();
    setActiveHz(null); setActiveStep(null); tick();
  };

  useEffect(() => () => { allOff(); audioRef.current?.close?.(); }, []);

  // Detect touch-capable (phone/tablet) to hide desktop keyboard tips & enable touch tooltip
  useEffect(() => {
    try {
      const w = window as any;
      const touch = 'ontouchstart' in w || (navigator && (navigator.maxTouchPoints > 0 || (navigator as any).msMaxTouchPoints > 0));
      setIsTouch(!!touch);
    } catch { setIsTouch(false); }
  }, []);

  // Update ALL voices when parameters change
  useEffect(() => { activeVoices.current.forEach(({ voice }) => voice.setGain(gain)); latchedVoices.current.forEach((v) => v.setGain(gain)); }, [gain]);
  useEffect(() => { activeVoices.current.forEach(({ voice }) => voice.setWaveform(waveform)); latchedVoices.current.forEach((v) => v.setWaveform(waveform)); }, [waveform]);

  // Retune currently held (pointer‑down) voices if base transposes
  useEffect(() => {
    activeVoices.current.forEach(({ voice, step }) => {
      const f = freqForStepFromBase(step, baseFreq);
      voice.setFrequency(f); setActiveHz(f); setActiveStep(step);
    });
  }, [transpose12, baseFreq]);

  // Start/retune/stop helpers for drag voices
  const startForPointer = (pointerId: number, step: number) => {
    const ctx = getCtx(); const f = freqForStepFromBase(step, baseFreq);
    const voice = new Voice(ctx, waveform, f, gain, attack);
    activePointers.current.add(pointerId);
    activeVoices.current.set(pointerId, { voice, step });
    incGlow(step); setActiveHz(f); setActiveStep(step);
  };
  const retuneForPointer = (pointerId: number, step: number) => {
    const entry = activeVoices.current.get(pointerId); if (!entry) return;
    const prev = entry.step; if (prev !== step) { decGlow(prev); incGlow(step); }
    entry.step = step; const f = freqForStepFromBase(step, baseFreq);
    entry.voice.setFrequency(f); setActiveHz(f); setActiveStep(step);
  };
  const stopForPointer = (pointerId: number) => {
    const entry = activeVoices.current.get(pointerId); if (!entry) return;
    const step = entry.step; maybeBeginFade(step); entry.voice.stop(release, () => decGlow(step));
    activeVoices.current.delete(pointerId); activePointers.current.delete(pointerId);
  };

  // Keyboard start/stop (non-sustain behaves like mouse drag; sustain toggles)
  const startForKey = (key: string, step: number) => {
    if (activeKeys.current.has(key)) return;
    const ctx = getCtx(); const f = freqForStepFromBase(step, baseFreq);
    const voice = new Voice(ctx, waveform, f, gain, attack);
    activeKeys.current.set(key, { voice, step }); incGlow(step); setActiveHz(f); setActiveStep(step);
  };
  const stopForKey = (key: string) => {
    const entry = activeKeys.current.get(key); if (!entry) return;
    const step = entry.step; maybeBeginFade(step); entry.voice.stop(release, () => decGlow(step)); activeKeys.current.delete(key);
  };

  // Sustain toggle logic (tap a key to start/stop that step)
  const toggleLatched = (step: number) => {
    const existing = latchedVoices.current.get(step);
    if (existing) { maybeBeginFade(step); existing.stop(release, () => decGlow(step)); latchedVoices.current.delete(step);
      if (activeVoices.current.size === 0 && latchedVoices.current.size === 0) { setActiveHz(null); setActiveStep(null); }
      return; }
    const ctx = getCtx(); const f = freqForStepFromBase(step, baseFreq);
    const voice = new Voice(ctx, waveform, f, gain, attack);
    latchedVoices.current.set(step, voice); incGlow(step); setActiveHz(f); setActiveStep(step);
  };

  // Global pointerup/cancel in case release happens off keyboard
  useEffect(() => {
    const handleUp = (e: PointerEvent) => stopForPointer(e.pointerId);
    const handleCancel = (e: PointerEvent) => stopForPointer(e.pointerId);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleCancel);
    return () => { window.removeEventListener("pointerup", handleUp); window.removeEventListener("pointercancel", handleCancel); };
  }, [release]);

  // Keyboard handlers: A,S,D,F,G map to degrees of current çeşni (with typing guard & select-open guard)
  useEffect(() => {
    const isTextEntry = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      return !!el.closest('input[type="text"], input[type="email"], input[type="search"], input[type="url"], input[type="number"], input[type="password"], textarea, [contenteditable="true"]');
    };
    const down = (e: KeyboardEvent) => {
      if (isTextEntry(e.target)) return; if (selectOpenRef.current) return;
      const step = resolveStepForKey(e.key, cesniSteps); if (step === null) return; e.preventDefault();
      if (sustain) { if (e.repeat) return; toggleLatched(step); return; }
      if (e.repeat) return; startForKey(e.key.toLowerCase(), step);
    };
    const up = (e: KeyboardEvent) => {
      if (isTextEntry(e.target)) return; if (selectOpenRef.current) return;
      const step = resolveStepForKey(e.key, cesniSteps); if (step === null) return;
      if (sustain) return; stopForKey(e.key.toLowerCase());
    };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [cesniSteps, sustain, waveform, gain, attack, release, baseFreq]);

  // Per‑key handlers
  const onPointerDown = (step: number) => (e: React.PointerEvent) => { e.preventDefault(); if (sustain) { toggleLatched(step); return; } startForPointer(e.pointerId, step); };
  const onPointerEnter = (step: number) => (e: React.PointerEvent) => { if (!sustain && activePointers.current.has(e.pointerId)) retuneForPointer(e.pointerId, step); };
  const onPointerUp = (e: React.PointerEvent) => { if (!sustain) stopForPointer(e.pointerId); };
  const onPointerCancel = (e: React.PointerEvent) => { if (!sustain) stopForPointer(e.pointerId); };

  // --- Touch tooltip: press‑and‑scrub over 12‑TET marker row ---
  const updateTetTipFromClientX = (clientX: number) => {
    if (!tetRowRef.current) return;
    const rect = tetRowRef.current.getBoundingClientRect();
    const colWidth = rect.width / KEYS_COUNT;
    let approx = Math.round((clientX - rect.left) / colWidth);
    approx = Math.max(0, Math.min(MAX_STEP, approx));
    let step = approx;
    const tetStepsAvail = new Set<number>(tetData.cells.map((lbl, i) => (lbl ? i : -1)).filter(i => i >= 0));
    if (!tetStepsAvail.has(step)) step = nearestFromSet(step, tetStepsAvail);
    const delta = tetData.deltaMap.get(step) ?? 0;
    const label = tetData.cells[step] ?? '';
    const left = step * colWidth + colWidth / 2;
    const text = `${label} ${fmtSigned1(delta)}`;
    if (tetTipStepRef.current !== step) { try { (navigator as any).vibrate?.(10); } catch {} tetTipStepRef.current = step; }
    setTetTip({ left, text });
  };
  const onTetPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isTouch && e.pointerType !== 'touch') return;
    isScrubbingTet.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); updateTetTipFromClientX(e.clientX);
  };
  const onTetPointerMove = (e: React.PointerEvent<HTMLDivElement>) => { if (!isScrubbingTet.current) return; updateTetTipFromClientX(e.clientX); };
  const onTetPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => { if (!isScrubbingTet.current) return; isScrubbingTet.current = false; setTetTip(null); tetTipStepRef.current = null; try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch {} };

  // ------------------------------ Render ------------------------------
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Title */}
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Makam Klavyesi | 0-31 (tam beşli aralığı)</h1>
          <p className="text-neutral-300 text-sm">
            Range: 0–31 komas (≈ perfect fifth). Default base = D4 = {fmtHz(D4_FREQ)} Hz. Each step ≈ {CENTS_PER_STEP.toFixed(2)} cents.
          </p>
          <div className="flex items-center gap-3">
            <button onClick={runSelfTestsInline} className="px-2 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-xs">Run self-tests (console)</button>
            {lastTestRun ? (
              <span className="text-[11px] text-neutral-400">Last run: {new Date(lastTestRun).toLocaleTimeString()}</span>
            ) : null}
          </div>
        </header>

        {/* Starting pitch + Markers */}
        <div className="rounded-2xl bg-neutral-900 p-4 space-y-3">
          <h2 className="font-semibold">Starting pitch</h2>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2">Select
              <select
                className="bg-neutral-800 rounded px-2 py-1"
                value={transpose12}
                onMouseDown={() => (selectOpenRef.current = true)}
                onChange={(e) => { const v = parseInt((e.target as HTMLSelectElement).value, 10); setTranspose12(v); selectOpenRef.current = false; (e.target as HTMLSelectElement).blur(); }}
                onBlur={() => (selectOpenRef.current = false)}
                onKeyDown={(e) => { if (e.key === 'Escape' || e.key === 'Enter') selectOpenRef.current = false; }}
              >
                {[
                  { label: "C", semisFromD4: -2 },
                  { label: "C#/Db", semisFromD4: -1 },
                  { label: "D", semisFromD4: 0 },
                  { label: "D#/Eb", semisFromD4: 1 },
                  { label: "E", semisFromD4: 2 },
                  { label: "F", semisFromD4: 3 },
                  { label: "F#/Gb", semisFromD4: 4 },
                  { label: "G", semisFromD4: 5 },
                  { label: "G#/Ab", semisFromD4: 6 },
                  { label: "A", semisFromD4: 7 },
                  { label: "A#/Bb", semisFromD4: 8 },
                  { label: "B", semisFromD4: 9 },
                ].map((opt) => (
                  <option key={opt.label} value={opt.semisFromD4}>{opt.label}</option>
                ))}
              </select>
            </label>
            <div className="text-neutral-300">Current: <span className="font-mono">{baseName}</span> = <span className="font-mono">{fmtHz(baseFreq)} Hz</span></div>
            <fieldset className="flex items-center gap-3 ml-auto">
              <legend className="sr-only">Markers</legend>
              <span className="text-neutral-300 mr-1">Markers:</span>
              <label className="inline-flex items-center gap-1">
                <input type="checkbox" checked={showTet} onChange={(e) => setShowTet(e.target.checked)} />
                12‑TET
              </label>
              <label className="inline-flex items-center gap-1">
                <input type="checkbox" checked={showJust} onChange={(e) => setShowJust(e.target.checked)} />
                Just
              </label>
            </fieldset>
          </div>
        </div>

        {/* Audio output (collapsible) */}
        <div className="rounded-2xl bg-neutral-900 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Audio output</h2>
            <button onClick={() => setAudioOpen(o => !o)} className="px-3 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-sm">
              {audioOpen ? 'Hide' : 'Show'}
            </button>
          </div>
          {audioOpen && (
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">Waveform
                <select
                  className="bg-neutral-800 rounded px-2 py-1"
                  value={waveform}
                  onMouseDown={() => (selectOpenRef.current = true)}
                  onChange={(e) => { setWaveform((e.target as HTMLSelectElement).value as OscillatorType); selectOpenRef.current = false; (e.target as HTMLSelectElement).blur(); }}
                  onBlur={() => (selectOpenRef.current = false)}
                  onKeyDown={(e) => { if (e.key === 'Escape' || e.key === 'Enter') selectOpenRef.current = false; }}
                >
                  <option value="sine">sine</option>
                  <option value="triangle">triangle</option>
                  <option value="square">square</option>
                  <option value="sawtooth">sawtooth</option>
                </select>
              </label>
              <label className="flex items-center gap-2">Gain
                <input type="range" min={0.02} max={0.6} step={0.01} value={gain} onChange={(e) => setGain(parseFloat(e.target.value))} />
              </label>
              <label className="flex items-center gap-2">Attack
                <input type="range" min={0} max={0.2} step={0.005} value={attack} onChange={(e) => setAttack(parseFloat(e.target.value))} />
              </label>
              <label className="flex items-center gap-2">Release
                <input type="range" min={0.01} max={0.6} step={0.01} value={release} onChange={(e) => setRelease(parseFloat(e.target.value))} />
              </label>
            </div>
          )}
        </div>

        {/* Çeşni selection */}
        <div className="rounded-2xl bg-neutral-900 p-4 space-y-3">
          <h2 className="font-semibold">Çeşni selection</h2>
          <div className="flex flex-wrap items-center gap-6 text-sm">
            {/* Çeşni selector */}
            <label className="flex items-center gap-2">Çeşni
              <select
                className="bg-neutral-800 rounded px-2 py-1"
                value={cesniId}
                onMouseDown={() => (selectOpenRef.current = true)}
                onChange={(e) => {
                  const nextId = (e.target as HTMLSelectElement).value;

                  // If switching to "custom", prefill the textbox with the current highlights
                  if (nextId === 'custom' && cesniId !== 'custom' && cesniSteps.length) {
                    // space-separated, per your example: "0 8 13 22 31"
                    setCustomStepsStr(cesniSteps.join(' '));
                  }

                  setCesniId(nextId);
                  selectOpenRef.current = false;
                  (e.target as HTMLSelectElement).blur();
                }}
                onBlur={() => (selectOpenRef.current = false)}
                onKeyDown={(e) => { if (e.key === 'Escape' || e.key === 'Enter') selectOpenRef.current = false; }}
              >
                {CESNI_OPTIONS.map((opt)=> (<option key={opt.id} value={opt.id}>{opt.label}</option>))}
              </select>
              {cesniId === 'custom' && (
                <span className="flex items-center gap-2">
                  <input
                    className="bg-neutral-800 rounded px-2 py-1 w-44"
                    placeholder="e.g. 0,4,13,22,31"
                    value={customStepsStr}
                    onChange={(e)=> setCustomStepsStr(e.target.value)}
                  />
                  {customParsed.error ? (
                    <span className="text-red-400 text-xs">{customParsed.error}</span>
                  ) : (
                    <span className="text-neutral-400 text-xs">0–31, comma/space separated</span>
                  )}
                </span>
              )}
            </label>
          </div>
          {!isTouch && (
            <p className="text-xs text-neutral-400">Tip: Use your computer keyboard — <span className="font-mono">A S D F G</span> — to play the highlighted notes. With Sustain on, a key toggles its note; without Sustain, hold the key to play.</p>
          )}
        </div>

        {/* Keyboard card */}
        <div className="rounded-2xl bg-neutral-900 p-4 shadow-inner space-y-3">
          <div className="flex flex-wrap items-center justify-between text-sm text-neutral-300 gap-2">
            <div>
              <span className="mr-2">Base:</span>
              <span className="font-mono">{baseName}</span>
              <span className="mx-2">=</span>
              <span className="font-mono">{fmtHz(baseFreq)} Hz</span>
            </div>
            <div className="flex items-center gap-4">
              <span>{activeHz !== null ? (<span>Active: <span className="font-mono">{fmtHz(activeHz)} Hz</span>{activeStep!==null?` (step ${activeStep})`:``}</span>) : (<span className="text-neutral-500">Active: —</span>)}</span>
              <span className="text-neutral-400">Poly: {activeVoices.current.size + activeKeys.current.size + latchedVoices.current.size}</span>
            </div>
          </div>

          {/* Keyboard grid (32 equal columns = consistent key widths) */}
          <div className="grid gap-1 p-3 rounded-xl bg-neutral-950/40 w-full overflow-x-hidden"
               style={{ touchAction: 'none', gridTemplateColumns: `repeat(${KEYS_COUNT}, minmax(0, 1fr))` }}>
            {keys.map((k) => {
              const count = glowCounts.current.get(k.step) || 0;
              const fade = fadeInfo.current.get(k.step);
              const isAlive = count > 0;
              const isCesni = cesniSet.has(k.step);
              // Decide highlight color based on alignment precedence: TET (green) > Just (magenta) > neither (yellow)
              let colorClass = 'bg-neutral-300 border-neutral-400';
              let styleOverride: React.CSSProperties | undefined = undefined;
              if (isCesni) {
                if (tetStepSet.has(k.step)) {
                  colorClass = 'bg-green-600 border-green-800';
                } else if (justStepSet.has(k.step)) {
                  colorClass = 'border-neutral-400';
                  styleOverride = { background: '#E20074', borderColor: '#b1005a' };
                } else {
                  colorClass = 'bg-yellow-400 border-yellow-600';
                }
              }
              const opacity = !fade && isAlive ? 1 : 0;
              const durationMs = fade?.durationMs || 120;
              return (
                <div key={k.step}
                  className={`relative h-48 sm:h-56 md:h-64 rounded-2xl text-neutral-900 cursor-pointer border ${colorClass}`}
                  style={styleOverride}
                  onPointerDown={onPointerDown(k.step)}
                  onPointerEnter={onPointerEnter(k.step)}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerCancel}
                  onContextMenu={(e) => e.preventDefault()}
                  title={`Step ${k.step} • ${fmtCents(k.cents)} cents`}
                >
                  {/* Yellow glow overlay, opacity animated to match release tail */}
                  <div className="absolute inset-0 rounded-2xl pointer-events-none"
                       style={{
                         boxShadow: '0 0 16px rgba(250,204,21,0.65)',
                         outline: '4px solid rgba(250,204,21,1)',
                         opacity,
                         transitionProperty: 'opacity, box-shadow, outline-color',
                         transitionDuration: `${durationMs}ms`,
                       }} />

                  {/* Koma number halfway between top and center; small to avoid overlap */}
                  <div className="absolute left-1/2 -translate-x-1/2 top-[25%] text-xs sm:text-sm md:text-base font-extrabold leading-none drop-shadow-[0_1px_1px_rgba(0,0,0,0.3)]">
                    {k.step}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Marker rows snapped to keys: separate rows so they never push each other */}
          <div className="px-3 pb-2 space-y-1">
            {showJust && (
              <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${KEYS_COUNT}, minmax(0, 1fr))` }}>
                {Array.from({ length: KEYS_COUNT }, (_, i) => (
                  <div key={`just-${i}`} className="h-8 flex items-center justify-center">
                    {justCells[i] ? (
                      <div className="px-1.5 py-0.5 rounded-md text-[10px] sm:text-xs font-semibold text-white" style={{ background: '#E20074' }}>
                        {justCells[i]}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            {showTet && (
              <div
                ref={tetRowRef}
                className="relative"
                style={{ touchAction: isTouch ? 'pan-y' as React.CSSProperties['touchAction'] : undefined }}
                onPointerDown={onTetPointerDown}
                onPointerMove={onTetPointerMove}
                onPointerUp={onTetPointerEnd}
                onPointerCancel={onTetPointerEnd}
              >
                <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${KEYS_COUNT}, minmax(0, 1fr))` }}>
                  {Array.from({ length: KEYS_COUNT }, (_, i) => (
                    <div key={`tet-${i}`} className="h-8 flex items-center justify-center">
                      {tetData.cells[i] ? (
                        <div
                          className="px-1.5 py-0.5 rounded-md text-[10px] sm:text-xs font-semibold"
                          style={{ background: 'rgba(34,197,94,0.9)', color: '#052e16' }}
                          title={!isTouch ? fmtSigned1(tetData.deltaMap.get(i) ?? 0) : undefined}
                        >
                          {tetData.cells[i]}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
                {isTouch && tetTip && (
                  <div className="absolute -top-8 px-2 py-1 rounded-md text-[10px] font-semibold bg-neutral-100 text-neutral-900 shadow pointer-events-none" style={{ left: tetTip.left, transform: 'translateX(-50%)' }}>
                    {tetTip.text}
                  </div>
                )}
              </div>
            )}
          </div>
          <p className="text-xs text-neutral-400">Markers snap to the nearest koma key. Rows are separate: <span style={{color:'#E20074'}}>Magenta</span> = common 5‑limit Just intervals; <span className="text-green-400">Green</span> = 12‑TET semitones relative to the chosen base.</p>
        </div>

        {/* Bottom controls: All Off (left) & Sustain toggle (right) */}
        <div className="flex items-center justify-between -mt-2">
          <button onClick={allOff} className="px-3 py-2 rounded-lg bg-red-600/80 hover:bg-red-600 text-white text-sm">All Off</button>
          <div className="flex items-center gap-3">
            <span className="text-sm text-neutral-300">Sustain</span>
            <button
              type="button"
              role="switch"
              aria-checked={sustain}
              onClick={() => setSustain(v => !v)}
              className={`relative inline-flex h-7 w-14 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 ${sustain ? 'bg-green-500' : 'bg-neutral-700'}`}
            >
              <span className={`inline-block h-6 w-6 bg-white rounded-full transform transition-transform ${sustain ? 'translate-x-7' : 'translate-x-1'}`} />
            </button>
          </div>
        </div>

        {/* Info cards */}
        <section className="grid sm:grid-cols-2 gap-4">
          <div className="bg-neutral-900 rounded-2xl p-4">
            <h2 className="font-semibold mb-2">Math & Tuning</h2>
            <ul className="text-sm text-neutral-300 list-disc pl-5 space-y-1">
              <li>Step ratio r = 2^(1/53) ≈ {R.toFixed(6)}</li>
              <li>One step ≈ {CENTS_PER_STEP.toFixed(4)} cents</li>
              <li>Range = 0–31 steps (≈ perfect fifth). f(n) = Base × 2^(n/53)</li>
            </ul>
          </div>
          <div className="bg-neutral-900 rounded-2xl p-4">
            <h2 className="font-semibold mb-2">Tips</h2>
            <ul className="text-sm text-neutral-300 list-disc pl-5 space-y-1">
              <li>Use <em>sine</em> or <em>triangle</em> for clean beating perception between close steps.</li>
              <li>"All Off" stops all active and latched voices.</li>
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
