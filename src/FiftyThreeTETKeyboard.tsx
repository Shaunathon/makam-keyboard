import React, { useEffect, useMemo, useRef, useState } from "react";

// 53-TET Keyboard – Web Audio React App (D4-centric)

// ------------------------------ Constants & Math ------------------------------
const D4_FREQ = 293.6647679; // Hz
const D4_MIDI = 62; // MIDI for D4
const STEPS = 53; // steps per octave
const R = Math.pow(2, 1 / STEPS); // ratio per step (koma)
const CENTS_PER_STEP = 1200 / STEPS; // ≈ 22.6415

const MAX_STEP = 31; // fallback upper bound for kb1 when empty
const ABS_MAX_STEP = 53; // max absolute step in the octave

// Generalized key mapping for both keyboards
function resolveStepForKeyWithOrder(key: string, steps: number[], order: string[]): number | null {
  const idx = order.indexOf(key.toLowerCase());
  if (idx === -1) return null;
  if (idx >= steps.length) return null;
  return steps[idx] ?? null;
}

// Math + fmt
const cents = (ratio: number) => 1200 * Math.log2(ratio);
const fmtSigned1 = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)} cents`;
const fmtHz = (f: number) => `${f.toFixed(2)}`.replace(/\.00$/, '');
const fmtCents = (c: number) => `${c.toFixed(1)}¢`;

// Snapping helper
function nearestFromSet(target: number, set: Set<number>) {
  let best: number | null = null, bestDist = Infinity;
  set.forEach(n => { const d = Math.abs(n - target); if (d < bestDist) { best = n; bestDist = d; } });
  return best;
}

// MIDI-ish helpers
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const midiNameFromSemis = (dSemis: number) =>
  NOTE_NAMES[(D4_MIDI + dSemis + 1200) % 12] + (Math.floor((D4_MIDI + dSemis) / 12) - 1);
const baseFreqFromSemitones = (dSemis: number) => D4_FREQ * Math.pow(2, dSemis / 12);

// Expose some helpers for quick console tests
;(window as any).__testables_53tet = { R, cents, midiNameFromSemis, baseFreqFromSemitones, fmtSigned1 };

// ------------------------------ Çeşni options ------------------------------
type CesniChoice = { id: string; label: string; steps: number[] };

/**
 * Pentachords with tetrachord counterparts (omit 31st koma for tetras).
 * Hüseyni exists only as a pentachord.
 */
const CESNI_OPTIONS_RAW: CesniChoice[] = [
  { id: 'none', label: 'None', steps: [] },

  // Pentachords
  { id: 'buselik_penta', label: 'Buselik pentachord', steps: [0, 9, 13, 22, 31] },
  { id: 'cargah_penta',  label: 'Çargah pentachord',  steps: [0, 9, 18, 22, 31] },
  { id: 'hicaz_penta',   label: 'Hicaz pentachord',   steps: [0, 5, 17, 22, 31] },
  { id: 'huseyni_penta', label: 'Hüseyni pentachord', steps: [0, 8, 13, 22, 31] },
  { id: 'kurdi_penta',   label: 'Kürdi pentachord',   steps: [0, 4, 13, 22, 31] },
  { id: 'rast_penta',    label: 'Rast pentachord',    steps: [0, 9, 17, 22, 31] },
  { id: 'segah_penta',   label: 'Segah pentachord',   steps: [0, 5, 14, 22, 31] },

  // Tetrachords derived from pentachords (omit 31)
  { id: 'buselik_tetra', label: 'Buselik tetrachord', steps: [0, 9, 13, 22] },
  { id: 'cargah_tetra',  label: 'Çargah tetrachord',  steps: [0, 9, 18, 22] },
  { id: 'hicaz_tetra',   label: 'Hicaz tetrachord',   steps: [0, 5, 17, 22] },
  { id: 'kurdi_tetra',   label: 'Kürdi tetrachord',   steps: [0, 4, 13, 22] },
  { id: 'rast_tetra',    label: 'Rast tetrachord',    steps: [0, 9, 17, 22] },
  { id: 'segah_tetra',   label: 'Segah tetrachord',   steps: [0, 5, 14, 22] },

  // Independent tetrachords
  { id: 'ussak_tetra',   label: 'Uşşak tetrachord',   steps: [0, 8, 13, 22] },
  { id: 'sabah_tetra',   label: 'Sabah tetrachord',   steps: [0, 8, 13, 18] },

  { id: 'custom', label: 'Custom (enter steps)', steps: [] },
];

// Alphabetically-sorted options by label (includes None/Custom)
const CESNI_OPTIONS: CesniChoice[] = CESNI_OPTIONS_RAW
  .slice()
  .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

// Custom parser for 0..31 (relative steps)
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

// Smooth release curve (S-curve)
function buildSmoothDecayCurve(start: number, end = 1e-4, points = 256): Float32Array {
  const n = Math.max(2, points | 0);
  const floor = Math.max(end, 1e-6);
  const s0 = Math.max(start || floor, floor);
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const smooth = t * t * (3 - 2 * t);
    const y = floor + (s0 - floor) * (1 - smooth);
    curve[i] = y;
  }
  return curve;
}

// Voice (Web Audio)
class Voice {
  ctx: AudioContext;
  osc: OscillatorNode;
  gain: GainNode;
  releaseCurve: Float32Array;

  constructor(ctx: AudioContext, waveform: OscillatorType, freq: number, gain: number, attack: number) {
    this.ctx = ctx;
    this.osc = ctx.createOscillator();
    this.osc.type = waveform;
    this.osc.frequency.value = freq;

    this.gain = ctx.createGain();
    this.gain.gain.value = 0;

    const now = ctx.currentTime;
    const atk = Math.max(0.005, attack);
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(0, now);
    this.gain.gain.linearRampToValueAtTime(gain, now + atk);

    this.osc.connect(this.gain).connect(ctx.destination);
    this.osc.start();

    this.releaseCurve = buildSmoothDecayCurve(gain);
  }

  setFrequency(f: number) { this.osc.frequency.value = f; }
  setGain(g: number) {
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(g, now + 0.01);
    this.releaseCurve = buildSmoothDecayCurve(g);
  }
  setWaveform(w: OscillatorType) { this.osc.type = w; }

  stop(release: number, onEnded?: () => void) {
    const now = this.ctx.currentTime;
    const rel = Math.max(0.02, release);
    const curve = this.releaseCurve;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.setValueCurveAtTime(curve, now, rel);
    this.osc.stop(now + rel + 0.005);
    this.osc.onended = () => onEnded?.();
  }
}

// Marker builders for any [start..end] absolute range
function buildTetDataForRange(startStep: number, endStep: number, transpose12: number) {
  const span = endStep - startStep + 1;
  const cells: (string | null)[] = Array.from({ length: span }, () => null);
  const deltaMap = new Map<number, number>(); // abs step -> cents delta
  for (let s = 0; s <= 12; s++) {
    const idealCents = s * 100;
    const absolute = Math.round((STEPS * s) / 12);
    if (absolute < startStep || absolute > endStep) continue;
    const midi = D4_MIDI + transpose12 + s;
    const name = NOTE_NAMES[(midi % 12 + 12) % 12];
    cells[absolute - startStep] = name;
    const snappedCents = absolute * CENTS_PER_STEP;
    deltaMap.set(absolute, snappedCents - idealCents);
  }
  return { cells, deltaMap };
}
function buildJustCellsForRange(startStep: number, endStep: number) {
  const intervals: { name: string; ratio: number }[] = [
    { name: '1/1', ratio: 1/1 }, { name: '16/15', ratio: 16/15 }, { name: '9/8', ratio: 9/8 },
    { name: '6/5', ratio: 6/5 }, { name: '5/4', ratio: 5/4 }, { name: '4/3', ratio: 4/3 },
    { name: '45/32', ratio: 45/32 }, { name: '3/2', ratio: 3/2 }, { name: '8/5', ratio: 8/5 },
    { name: '5/3', ratio: 5/3 }, { name: '15/8', ratio: 15/8 }, { name: '2/1', ratio: 2/1 },
  ];
  const span = endStep - startStep + 1;
  const cells: (string | null)[] = Array.from({ length: span }, () => null);
  for (const it of intervals) {
    const abs = Math.round(cents(it.ratio) / CENTS_PER_STEP);
    if (abs >= startStep && abs <= endStep) cells[abs - startStep] = it.name;
  }
  return cells;
}

// --- Reusable keyboard surface ---
type KomaKeyboardProps = {
  title?: string;
  startStep: number;
  endStep: number; // inclusive
  cesniAbsSteps: Set<number>;
  showTet: boolean;
  showJust: boolean;
  tetData: { cells: (string | null)[]; deltaMap: Map<number, number> };
  justCells: (string | null)[];
  onPointerDown: (step: number) => (e: React.PointerEvent) => void;
  onPointerEnter: (step: number) => (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  glowCounts: React.MutableRefObject<Map<number, number>>;
  fadeInfo: React.MutableRefObject<Map<number, { startedAt: number; durationMs: number }>>;
  tetRowRef?: React.MutableRefObject<HTMLDivElement | null> | React.RefObject<HTMLDivElement>;
  isTouch: boolean;
  tetTip?: { left: number; text: string } | null;
  onTetPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onTetPointerMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onTetPointerEnd?: (e: React.PointerEvent<HTMLDivElement>) => void;
};

function KomaKeyboard(props: KomaKeyboardProps) {
  const {
    title, startStep, endStep, cesniAbsSteps, showTet, showJust,
    tetData, justCells, onPointerDown, onPointerEnter, onPointerUp, onPointerCancel,
    glowCounts, fadeInfo, tetRowRef, isTouch, tetTip, onTetPointerDown, onTetPointerMove, onTetPointerEnd,
  } = props;

  const span = endStep - startStep + 1;
  const keys = React.useMemo(
    () => Array.from({ length: span }, (_, i) => {
      const s = startStep + i;
      return { absStep: s, cents: s * CENTS_PER_STEP };
    }),
    [startStep, endStep]
  );

  const tetStepSet = React.useMemo(() => new Set<number>(
    tetData.cells.map((lbl, i) => (lbl ? (startStep + i) : -1)).filter(i => i >= 0)
  ), [tetData, startStep]);

  const justStepSet = React.useMemo(() => new Set<number>(
    justCells.map((lbl, i) => (lbl ? (startStep + i) : -1)).filter(i => i >= 0)
  ), [justCells, startStep]);

  return (
    <div className="rounded-2xl bg-neutral-900 p-4 shadow-inner space-y-3">
      {title && <div className="text-sm text-neutral-300 font-semibold">{title}</div>}

      <div
        className="grid gap-1 p-3 rounded-xl bg-neutral-950/40 w-full overflow-x-hidden"
        style={{ touchAction: 'none', gridTemplateColumns: `repeat(${span}, minmax(0, 1fr))` }}
      >
        {keys.map((k) => {
          const count = glowCounts.current.get(k.absStep) || 0;
          const fade = fadeInfo.current.get(k.absStep);
          const isAlive = count > 0;
          const isCesni = cesniAbsSteps.has(k.absStep);

          let colorClass = 'bg-neutral-300 border-neutral-400';
          let styleOverride: React.CSSProperties | undefined = undefined;
          if (isCesni) {
            if (tetStepSet.has(k.absStep)) {
              colorClass = 'bg-green-600 border-green-800';
            } else if (justStepSet.has(k.absStep)) {
              colorClass = 'border-neutral-400';
              styleOverride = { background: '#E20074', borderColor: '#b1005a' };
            } else {
              colorClass = 'bg-yellow-400 border-yellow-600';
            }
          }

          const opacity = !fade && isAlive ? 1 : 0;
          const durationMs = fade?.durationMs || 120;

          return (
            <div key={k.absStep}
              className={`relative h-48 sm:h-56 md:h-64 rounded-2xl text-neutral-900 cursor-pointer border ${colorClass}`}
              style={styleOverride}
              onPointerDown={onPointerDown(k.absStep)}
              onPointerEnter={onPointerEnter(k.absStep)}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onContextMenu={(e) => e.preventDefault()}
              title={`Step ${k.absStep} • ${fmtCents(k.cents)} cents`}
            >
              <div className="absolute inset-0 rounded-2xl pointer-events-none"
                   style={{
                     boxShadow: '0 0 16px rgba(250,204,21,0.65)',
                     outline: '4px solid rgba(250,204,21,1)',
                     opacity,
                     transitionProperty: 'opacity, box-shadow, outline-color',
                     transitionDuration: `${durationMs}ms`,
                   }} />
              <div className="absolute left-1/2 -translate-x-1/2 top-[25%] text-xs sm:text-sm md:text-base font-extrabold leading-none drop-shadow-[0_1px_1px_rgba(0,0,0,0.3)]">
                {k.absStep}
              </div>
            </div>
          );
        })}
      </div>

      {/* markers */}
      <div className="px-3 pb-2 space-y-1">
        {showJust && (
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${span}, minmax(0, 1fr))` }}>
            {Array.from({ length: span }, (_, i) => (
              <div key={`just-${startStep + i}`} className="h-8 flex items-center justify-center">
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
            ref={tetRowRef as React.Ref<HTMLDivElement>}
            className="relative"
            style={{ touchAction: isTouch ? ('pan-y' as React.CSSProperties['touchAction']) : undefined }}
            onPointerDown={onTetPointerDown}
            onPointerMove={onTetPointerMove}
            onPointerUp={onTetPointerEnd}
            onPointerCancel={onTetPointerEnd}
          >
            <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${span}, minmax(0, 1fr))` }}>
              {tetData.cells.map((label, i) => (
                <div key={`tet-${startStep + i}`} className="h-8 flex items-center justify-center">
                  {label ? (
                    <div
                      className="px-1.5 py-0.5 rounded-md text-[10px] sm:text-xs font-semibold"
                      style={{ background: 'rgba(34,197,94,0.9)', color: '#052e16' }}
                      title={!isTouch ? fmtSigned1(tetData.deltaMap.get(startStep + i) ?? 0) : undefined}
                    >
                      {label}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            {isTouch && tetTip && (
              <div className="absolute -top-8 px-2 py-1 rounded-md text-[10px] font-semibold bg-neutral-100 text-neutral-900 shadow pointer-events-none"
                   style={{ left: tetTip.left, transform: 'translateX(-50%)' }}>
                {tetTip.text}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function FiftyThreeTETKeyboard() {
  // Synth params
  const [waveform, setWaveform] = useState<OscillatorType>('sine');
  const [gain, setGain] = useState(0.15);
  const [attack, setAttack] = useState(0.02);
  const [release, setRelease] = useState(0.12);
  const [sustain, setSustain] = useState(false);

  // UI housekeeping
  const selectOpenRef = useRef(false);
  const [isTouch, setIsTouch] = useState(false);
  const [lastTestRun, setLastTestRun] = useState<number | null>(null);

  // Base pitch / markers
  const [transpose12, setTranspose12] = useState<number>(0);
  const [showTet, setShowTet] = useState(true);
  const [showJust, setShowJust] = useState(true);

  // Çeşni — Keyboard 1
  const [cesniId, setCesniId] = useState<string>('rast_penta');
  const [customStepsStr, setCustomStepsStr] = useState<string>('');
  const customParsed = useMemo(() => parseStepList(customStepsStr), [customStepsStr]);
  const cesniSteps = useMemo(() => {
    if (cesniId === 'custom') return customParsed.error ? [] : customParsed.steps;
    return CESNI_OPTIONS.find(o => o.id === cesniId)?.steps ?? [];
  }, [cesniId, customParsed]);
  const cesniSet = useMemo(() => new Set<number>(cesniSteps), [cesniSteps]);
  const prevCesniIdRef = useRef<string>(cesniId);

  // Dynamic kb1 range from lowest..highest highlighted (fallback 0..31)
  const startStep1 = useMemo(() => (cesniSteps.length ? Math.min(...cesniSteps) : 0), [cesniSteps]);
  const endStep1   = useMemo(() => (cesniSteps.length ? Math.max(...cesniSteps) : MAX_STEP), [cesniSteps]);
  const spanKb1 = endStep1 - startStep1 + 1;

  // Çeşni — Keyboard 2 (relative)
  const [cesni2Id, setCesni2Id] = useState<string>('rast_tetra'); // default to Rast tetrachord
  const [custom2StepsStr, setCustom2StepsStr] = useState<string>('');
  const custom2Parsed = useMemo(() => parseStepList(custom2StepsStr), [custom2StepsStr]);
  const cesni2RelSteps = useMemo(() => {
    if (cesni2Id === 'custom') return custom2Parsed.error ? [] : custom2Parsed.steps;
    return CESNI_OPTIONS.find(o => o.id === cesni2Id)?.steps ?? [];
  }, [cesni2Id, custom2Parsed]);
  const prevCesni2IdRef = useRef<string>(cesni2Id);

  // kb2 starts at highest highlighted of kb1, ends minimally to include its own recipe
  const highestStepKb1 = useMemo(() => (cesniSteps.length ? Math.max(...cesniSteps) : 31), [cesniSteps]);
  const startStep2 = highestStepKb1;
  const endStep2 = useMemo(() => {
    const maxRel = cesni2RelSteps.length ? Math.max(...cesni2RelSteps) : 0;
    return Math.min(ABS_MAX_STEP, startStep2 + maxRel);
  }, [cesni2RelSteps, startStep2]);

  const cesni2AbsSet = useMemo(
    () => new Set<number>(cesni2RelSteps.map(s => startStep2 + s).filter(s => s >= startStep2 && s <= endStep2)),
    [cesni2RelSteps, startStep2, endStep2]
  );

  // Base, names, markers
  const baseFreq = useMemo(() => baseFreqFromSemitones(transpose12), [transpose12]);
  const baseName = useMemo(() => midiNameFromSemis(transpose12), [transpose12]);

  const tetDataKb1 = useMemo(() => buildTetDataForRange(startStep1, endStep1, transpose12), [startStep1, endStep1, transpose12]);
  const justCellsKb1 = useMemo(() => buildJustCellsForRange(startStep1, endStep1), [startStep1, endStep1]);

  const tetDataKb2 = useMemo(() => buildTetDataForRange(startStep2, endStep2, transpose12), [startStep2, endStep2, transpose12]);
  const justCellsKb2 = useMemo(() => buildJustCellsForRange(startStep2, endStep2), [startStep2, endStep2]);

  // Force re-render on ref map updates
  const [, setUiPulse] = useState(0);
  const tick = () => setUiPulse(v => (v + 1) % 1_000_000);

  // Audio
  const audioRef = useRef<AudioContext | null>(null);
  const getCtx = () => {
    if (!audioRef.current) audioRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    return audioRef.current;
  };
  const freqForStepFromBase = (step: number, base: number) => base * Math.pow(2, step / STEPS);

  // Active voices
  const activeVoices = useRef(new Map<number, { voice: Voice; step: number }>());
  const activePointers = useRef(new Map<number, number>());
  const activeKeys = useRef(new Map<string, { voice: Voice; step: number }>());
  const latchedVoices = useRef(new Map<number, Voice>());

  // Visuals
  const glowCounts = useRef(new Map<number, number>());
  const fadeInfo = useRef(new Map<number, { startedAt: number; durationMs: number }>());
  const incGlow = (step: number) => { glowCounts.current.set(step, (glowCounts.current.get(step) || 0) + 1); tick(); };
  const decGlow = (step: number) => { const v = (glowCounts.current.get(step) || 0) - 1; if (v <= 0) glowCounts.current.delete(step); else glowCounts.current.set(step, v); tick(); };
  const maybeBeginFade = (step: number) => { const ms = visualReleaseMs(release); fadeInfo.current.set(step, { startedAt: performance.now(), durationMs: ms }); setTimeout(() => { fadeInfo.current.delete(step); tick(); }, ms + 10); };
  const [activeHz, setActiveHz] = useState<number | null>(null);
  const [activeStep, setActiveStep] = useState<number | null>(null);

  // 12-TET row tooltip (kb1 dynamic)
  const tetRowRef = useRef<HTMLDivElement | null>(null);
  const [tetTip, setTetTip] = useState<{ left: number; text: string } | null>(null);

  // ------- Per-key pointer handlers -------
  const onPointerDown = (step: number) => (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    if (sustain) { toggleLatched(step); return; }
    startForPointer(e.pointerId, step);
  };
  const onPointerEnter = (step: number) => (e: React.PointerEvent) => {
    if ((e.buttons & 1) === 1 && activePointers.current.has(e.pointerId)) {
      retuneForPointer(e.pointerId, step);
    }
  };
  const onPointerUp = (e: React.PointerEvent) => { if (!sustain) stopForPointer(e.pointerId); };
  const onPointerCancel = (e: React.PointerEvent) => { if (!sustain) stopForPointer(e.pointerId); };

  // Start/stop helpers
  const startVoice = (step: number) => {
    const ctx = getCtx();
    const f = freqForStepFromBase(step, baseFreq);
    const v = new Voice(ctx, waveform, f, gain, attack);
    incGlow(step);
    setActiveHz(f); setActiveStep(step);
    return v;
  };
  const startForKey = (key: string, step: number) => {
    const v = startVoice(step);
    activeKeys.current.set(key, { voice: v, step });
  };
  const stopForKey = (key: string) => {
    const ent = activeKeys.current.get(key);
    if (!ent) return;
    const { voice, step } = ent;
    maybeBeginFade(step);
    voice.stop(release, () => decGlow(step));
    activeKeys.current.delete(key);
  };

  const startForPointer = (pointerId: number, step: number) => {
    const v = startVoice(step);
    activePointers.current.set(pointerId, step);
    activeVoices.current.set(pointerId, { voice: v, step });
  };
  const retuneForPointer = (pointerId: number, step: number) => {
    const ent = activeVoices.current.get(pointerId);
    if (!ent) return;
    const { voice } = ent;
    const f = freqForStepFromBase(step, baseFreq);
    voice.setFrequency(f);
    incGlow(step);
    setActiveHz(f); setActiveStep(step);
    activeVoices.current.set(pointerId, { voice, step });
  };
  const stopForPointer = (pointerId: number) => {
    const ent = activeVoices.current.get(pointerId);
    if (!ent) return;
    const { voice, step } = ent;
    maybeBeginFade(step);
    voice.stop(release, () => decGlow(step));
    activeVoices.current.delete(pointerId);
    activePointers.current.delete(pointerId);
  };

  const toggleLatched = (step: number) => {
    const v = latchedVoices.current.get(step);
    if (v) {
      maybeBeginFade(step);
      v.stop(release, () => decGlow(step));
      latchedVoices.current.delete(step);
    } else {
      const ctx = getCtx();
      const f = freqForStepFromBase(step, baseFreq);
      const newV = new Voice(ctx, waveform, f, gain, attack);
      latchedVoices.current.set(step, newV);
      incGlow(step); setActiveHz(f); setActiveStep(step);
    }
    tick();
  };

  const allOff = () => {
    activeVoices.current.forEach(({ voice, step }) => { maybeBeginFade(step); voice.stop(release, () => decGlow(step)); });
    activeVoices.current.clear();
    activePointers.current.clear();
    activeKeys.current.forEach(({ voice, step }) => { maybeBeginFade(step); voice.stop(release, () => decGlow(step)); });
    activeKeys.current.clear();
    latchedVoices.current.forEach((voice, step) => { maybeBeginFade(step); voice.stop(release, () => decGlow(step)); });
    latchedVoices.current.clear();
    setActiveHz(null); setActiveStep(null); tick();
  };

  useEffect(() => () => { allOff(); audioRef.current?.close?.(); }, []);
  useEffect(() => {
    try {
      const w = window as any;
      const touch = 'ontouchstart' in w || (navigator && ((navigator as any).maxTouchPoints > 0 || (navigator as any).msMaxTouchPoints > 0));
      setIsTouch(!!touch);
    } catch { setIsTouch(false); }
  }, []);
  useEffect(() => { activeVoices.current.forEach(({ voice }) => voice.setGain(gain)); latchedVoices.current.forEach(v => v.setGain(gain)); }, [gain]);
  useEffect(() => { activeVoices.current.forEach(({ voice }) => voice.setWaveform(waveform)); latchedVoices.current.forEach(v => v.setWaveform(waveform)); }, [waveform]);
  useEffect(() => {
    activeVoices.current.forEach(({ voice, step }) => {
      const f = freqForStepFromBase(step, baseFreq);
      voice.setFrequency(f); setActiveHz(f); setActiveStep(step);
    });
  }, [transpose12, baseFreq]);

  // Keyboard handlers: allow playing even if inputs/selects are focused
  useEffect(() => {
    const isTextEntry = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      return !!el.closest('input, textarea, [contenteditable="true"]');
    };

    const orderKb1 = ['a','s','d','f','g'];
    const orderKb2 = ['h','j','k','l',';'];
    const playableKeys = new Set([...orderKb1, ...orderKb2]);

    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();

      // If a text input / textarea or select is active, only intercept playable keys
      const focusedElsewhere = isTextEntry(e.target) || selectOpenRef.current;
      if (focusedElsewhere && !playableKeys.has(k)) return;
      if (e.repeat) return;

      let step: number | null = null;

      const s1 = resolveStepForKeyWithOrder(k, cesniSteps, orderKb1);
      if (s1 !== null) step = s1;

      if (step === null) {
        const rel2 = resolveStepForKeyWithOrder(k, cesni2RelSteps, orderKb2);
        if (rel2 !== null) step = startStep2 + rel2;
      }
      if (step === null) return;

      e.preventDefault();
      if (sustain) { toggleLatched(step); return; }
      startForKey(k, step);
    };

    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const focusedElsewhere = isTextEntry(e.target) || selectOpenRef.current;
      if (focusedElsewhere && !playableKeys.has(k)) return;

      const matchKb1 = resolveStepForKeyWithOrder(k, cesniSteps, orderKb1) !== null;
      const matchKb2 = resolveStepForKeyWithOrder(k, cesni2RelSteps, orderKb2) !== null;
      if (!matchKb1 && !matchKb2) return;
      if (sustain) return;
      e.preventDefault();
      stopForKey(k);
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [cesniSteps, cesni2RelSteps, startStep2, sustain, waveform, gain, attack, release, baseFreq]);

  // Touch tooltip over kb1 12-TET marker row (dynamic span)
  const updateTetTipFromClientX = (clientX: number) => {
    if (!tetRowRef.current) return;
    const rect = tetRowRef.current.getBoundingClientRect();
    const colWidth = rect.width / spanKb1;
    let approxIndex = Math.round((clientX - rect.left) / colWidth);
    approxIndex = Math.max(0, Math.min(spanKb1 - 1, approxIndex));
    let stepAbs = startStep1 + approxIndex;

    const tetStepsAvail = new Set<number>(
      tetDataKb1.cells.map((lbl, i) => (lbl ? (startStep1 + i) : -1)).filter(i => i >= 0)
    );
    if (!tetStepsAvail.has(stepAbs)) {
      const near = nearestFromSet(stepAbs, tetStepsAvail);
      if (near !== null) stepAbs = near;
    }
    const dx = ((stepAbs - startStep1) + 0.5) * colWidth;
    const centsDelta = tetDataKb1.deltaMap.get(stepAbs) ?? 0;
    const label = tetDataKb1.cells[stepAbs - startStep1] ?? '';
    setTetTip({ left: rect.left + dx, text: `${label} (${fmtSigned1(centsDelta)})` });
  };
  const onTetPointerDown = (e: React.PointerEvent<HTMLDivElement>) => { if (!isTouch) return; updateTetTipFromClientX(e.clientX); };
  const onTetPointerMove = (e: React.PointerEvent<HTMLDivElement>) => { if (!isTouch) return; updateTetTipFromClientX(e.clientX); };
  const onTetPointerEnd = () => setTetTip(null);

  // Prefill "custom" with the previously-selected recipe (kb1)
  const handleCesni1Change = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newId = (e.target as HTMLSelectElement).value;
    if (newId === 'custom') {
      const prevId = prevCesniIdRef.current;
      const prevSteps =
        prevId === 'custom'
          ? (customParsed.error ? [] : customParsed.steps)
          : (CESNI_OPTIONS.find(o => o.id === prevId)?.steps ?? []);
      if (prevSteps.length) setCustomStepsStr(prevSteps.join(' '));
    }
    setCesniId(newId);
    prevCesniIdRef.current = newId;
    selectOpenRef.current = false;
    (e.target as HTMLSelectElement).blur();
  };

  // Prefill for kb2 custom
  const handleCesni2Change = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newId = (e.target as HTMLSelectElement).value;
    if (newId === 'custom') {
      const prevId = prevCesni2IdRef.current;
      const prevSteps =
        prevId === 'custom'
          ? (custom2Parsed.error ? [] : custom2Parsed.steps)
          : (CESNI_OPTIONS.find(o => o.id === prevId)?.steps ?? []);
      if (prevSteps.length) setCustom2StepsStr(prevSteps.join(' '));
    }
    setCesni2Id(newId);
    prevCesni2IdRef.current = newId;
    selectOpenRef.current = false;
    (e.target as HTMLSelectElement).blur();
  };

  // ------------------------------ Render ------------------------------
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Makam Klavyesi | Dinamik Aralıklar</h1>
          <p className="text-neutral-300 text-sm">
            Each step ≈ {CENTS_PER_STEP.toFixed(2)} cents. Base pitch defaults to {fmtHz(D4_FREQ)} Hz (D4).
          </p>
          <div className="flex items-center gap-3">
            <button onClick={() => {
              try {
                const T = (window as any).__testables_53tet;
                const { R, baseFreqFromSemitones } = T;
                const ok = (m: string) => console.log('✅ '+m);
                const bad = (m: string) => console.warn('❌ '+m);
                const close = (a: number, b: number, t: number) => Math.abs(a-b) <= t;
                console.groupCollapsed('53-TET Self-tests');
                try {
                  close(Math.pow(R,53), 2, 1e-6) ? ok('(2^(1/53))^53 ≈ 2') : bad('ratio');
                  close(baseFreqFromSemitones(0), D4_FREQ, 0.02) ? ok('base semitones 0 = D4') : bad('base semitones 0');
                } finally { console.groupEnd(); }
              } catch (e) { console.warn(e); }
              setLastTestRun(Date.now());
            }} className="px-2 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-xs">Run self-tests (console)</button>
            {lastTestRun ? <span className="text-[11px] text-neutral-400">Last run: {new Date(lastTestRun).toLocaleTimeString()}</span> : null}
          </div>
        </header>

        {/* Starting pitch + markers toggle */}
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
                {Array.from({ length: 25 }, (_, i) => i - 12).map(n => (
                  <option key={n} value={n}>{midiNameFromSemis(n)}</option>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2">12-TET markers
                <input type="checkbox" checked={showTet} onChange={(e)=> setShowTet(e.target.checked)} />
              </label>
              <label className="flex items-center gap-2">Just markers
                <input type="checkbox" checked={showJust} onChange={(e)=> setShowJust(e.target.checked)} />
              </label>
            </div>
            {!isTouch && (
              <p className="text-xs text-neutral-400">Hotkeys: <span className="font-mono">A S D F G</span> for Keyboard 1; <span className="font-mono">H J K L ;</span> for Keyboard 2. With <em>Sustain</em> on, keys toggle.</p>
            )}
          </div>
        </div>

        {/* Sound controls (RESTORED) */}
        <div className="rounded-2xl bg-neutral-900 p-4 space-y-3">
          <h2 className="font-semibold">Sound</h2>
          <div className="grid sm:grid-cols-2 gap-4 text-sm items-center">
            <label className="flex items-center gap-2">Waveform
              <select
                className="bg-neutral-800 rounded px-2 py-1"
                value={waveform}
                onChange={(e)=> setWaveform((e.target as HTMLSelectElement).value as OscillatorType)}
              >
                <option value="sine">sine</option>
                <option value="triangle">triangle</option>
                <option value="square">square</option>
                <option value="sawtooth">sawtooth</option>
              </select>
            </label>

            <div className="flex items-center gap-3">
              <span className="w-16 text-neutral-300">Gain</span>
              <input type="range" min={0} max={0.6} step={0.01} value={gain} onChange={(e)=> setGain(parseFloat(e.target.value))} className="w-full" />
              <span className="w-14 text-right font-mono">{gain.toFixed(2)}</span>
            </div>

            <div className="flex items-center gap-3">
              <span className="w-16 text-neutral-300">Attack</span>
              <input type="range" min={0} max={0.2} step={0.005} value={attack} onChange={(e)=> setAttack(parseFloat(e.target.value))} className="w-full" />
              <span className="w-14 text-right font-mono">{attack.toFixed(3)}s</span>
            </div>

            <div className="flex items-center gap-3">
              <span className="w-16 text-neutral-300">Release</span>
              <input type="range" min={0.02} max={0.6} step={0.005} value={release} onChange={(e)=> setRelease(parseFloat(e.target.value))} className="w-full" />
              <span className="w-14 text-right font-mono">{release.toFixed(3)}s</span>
            </div>
          </div>
        </div>

        {/* KEYBOARD 2 container (on top) */}
        <div className="rounded-2xl bg-neutral-900 p-4 shadow-inner space-y-4">
          {/* Big selector as the title */}
          <div className="flex flex-wrap items-center gap-4">
            <select
              className="bg-neutral-800/80 hover:bg-neutral-800 rounded-lg px-3 py-2 text-lg sm:text-2xl font-bold tracking-tight"
              value={cesni2Id}
              onMouseDown={() => (selectOpenRef.current = true)}
              onChange={handleCesni2Change}
              onBlur={() => (selectOpenRef.current = false)}
              onKeyDown={(e) => { if (e.key === 'Escape' || e.key === 'Enter') selectOpenRef.current = false; }}
              title="Çeşni (Keyboard 2)"
            >
              {CESNI_OPTIONS.map((opt)=> (<option key={opt.id} value={opt.id}>{opt.label}</option>))}
            </select>

            {cesni2Id === 'custom' && (
              <span className="flex items-center gap-2">
                <input
                  className="bg-neutral-800 rounded px-2 py-2 w-52 text-sm"
                  placeholder="relative e.g. 0 4 13 22 31"
                  value={custom2StepsStr}
                  onChange={(e)=> setCustom2StepsStr(e.target.value)}
                />
                {custom2Parsed.error ? (
                  <span className="text-red-400 text-xs">{custom2Parsed.error}</span>
                ) : (
                  <span className="text-neutral-400 text-xs">0–31 relative to start</span>
                )}
              </span>
            )}

            <span className="text-neutral-400 text-xs">Start = highest highlighted on Keyboard 1 → <span className="font-mono">{startStep2}</span></span>
          </div>

          {/* Keyboard 2 surface */}
          <KomaKeyboard
            startStep={startStep2}
            endStep={endStep2}
            cesniAbsSteps={cesni2AbsSet}
            showTet={showTet}
            showJust={showJust}
            tetData={tetDataKb2}
            justCells={justCellsKb2}
            onPointerDown={onPointerDown}
            onPointerEnter={onPointerEnter}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            glowCounts={glowCounts}
            fadeInfo={fadeInfo}
            isTouch={isTouch}
          />
        </div>

        {/* KEYBOARD 1 container (below) */}
        <div className="rounded-2xl bg-neutral-900 p-4 shadow-inner space-y-4">
          {/* Big selector as the title */}
          <div className="flex flex-wrap items-center gap-4">
            <select
              className="bg-neutral-800/80 hover:bg-neutral-800 rounded-lg px-3 py-2 text-lg sm:text-2xl font-bold tracking-tight"
              value={cesniId}
              onMouseDown={() => (selectOpenRef.current = true)}
              onChange={handleCesni1Change}
              onBlur={() => (selectOpenRef.current = false)}
              onKeyDown={(e) => { if (e.key === 'Escape' || e.key === 'Enter') selectOpenRef.current = false; }}
              title="Çeşni (Keyboard 1)"
            >
              {CESNI_OPTIONS.map((opt)=> (<option key={opt.id} value={opt.id}>{opt.label}</option>))}
            </select>

            {cesniId === 'custom' && (
              <span className="flex items-center gap-2">
                <input
                  className="bg-neutral-800 rounded px-2 py-2 w-52 text-sm"
                  placeholder="e.g. 0 8 13 22 31"
                  value={customStepsStr}
                  onChange={(e)=> setCustomStepsStr(e.target.value)}
                />
                {customParsed.error ? (
                  <span className="text-red-400 text-xs">{customParsed.error}</span>
                ) : (
                  <span className="text-neutral-400 text-xs">0–31, space/comma separated</span>
                )}
              </span>
            )}
          </div>

          {/* Base / activity strip */}
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

          {/* Keyboard 1 surface */}
          <KomaKeyboard
            startStep={startStep1}
            endStep={endStep1}
            cesniAbsSteps={cesniSet}
            showTet={showTet}
            showJust={showJust}
            tetData={tetDataKb1}
            justCells={justCellsKb1}
            onPointerDown={onPointerDown}
            onPointerEnter={onPointerEnter}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            glowCounts={glowCounts}
            fadeInfo={fadeInfo}
            tetRowRef={tetRowRef}
            isTouch={isTouch}
            tetTip={tetTip}
            onTetPointerDown={onTetPointerDown}
            onTetPointerMove={onTetPointerMove}
            onTetPointerEnd={onTetPointerEnd}
          />

          <p className="text-xs text-neutral-400 -mt-2">
            Markers snap to the nearest koma key. <span style={{color:'#E20074'}}>Magenta</span> = 5-limit Just; <span className="text-green-400">Green</span> = 12-TET semitones.
          </p>
        </div>

        {/* Bottom controls */}
        <div className="flex items-center justify-between -mt-2">
          <button onClick={allOff} className="px-3 py-2 rounded-md bg-red-600/80 hover:bg-red-600 text-white text-sm">All Off</button>
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
      </div>
    </div>
  );
}

// Visual fade helper
const MIN_REL = 0.03;
function visualReleaseMs(rel: number) {
  return Math.max(90, Math.round((Math.max(MIN_REL, rel) + 0.01) * 1000));
}
