<script lang="ts">
  // A bot's character: a soft shape in its color, with a face that follows its state.
  // idle: calm (an occasional blink) · working: eyes scan, the light pulses · needs you: wide eyes
  // and a badge · failed: a worried face · paused: asleep. Motion stops under prefers-reduced-motion.
  import { MOOD_TEXT, inkFor, moodFor, shapeFor, type AvatarShape, type Mood } from "../lib/bot-avatar";
  import type { BotStatus } from "../lib/bots";

  interface Props {
    name: string;
    color: string;
    shape?: string;
    status?: BotStatus;
    /** Override the mood (the form's preview). */
    mood?: Mood;
    size?: number;
    /** Decorative next to the bot's name (no label of its own). */
    decorative?: boolean;
  }
  let { name, color, shape, status = "idle", mood: moodOverride, size = 32, decorative = false }: Props = $props();

  const form = $derived<AvatarShape>(shapeFor({ name, avatarShape: shape }));
  const mood = $derived<Mood>(moodOverride ?? moodFor(status));
  const ink = $derived(inkFor(color));
  const label = $derived(`${name} (${MOOD_TEXT[mood]})`);
</script>

<svg
  class="bot-avatar mood-{mood}"
  width={size}
  height={size}
  viewBox="0 0 48 48"
  role={decorative ? undefined : "img"}
  aria-hidden={decorative ? "true" : undefined}
  aria-label={decorative ? undefined : label}
  data-mood={mood}
  data-shape={form}
>
  {#if !decorative}<title>{label}</title>{/if}
  <g class="body">
    {#if form === "robot"}
      <line x1="24" y1="12" x2="24" y2="6" stroke={color} stroke-width="2.4" stroke-linecap="round" />
      <circle class="light" cx="24" cy="5" r="3" fill={color} />
      <rect x="7" y="12" width="34" height="30" rx="10" fill={color} />
      <rect x="4" y="22" width="4" height="9" rx="2" fill={color} opacity="0.75" />
      <rect x="40" y="22" width="4" height="9" rx="2" fill={color} opacity="0.75" />
    {:else if form === "orb"}
      <circle cx="11" cy="13" r="4.5" fill={color} opacity="0.8" />
      <circle cx="37" cy="13" r="4.5" fill={color} opacity="0.8" />
      <circle cx="24" cy="26" r="18" fill={color} />
      <circle class="light" cx="17" cy="15" r="2.4" fill="#fff" opacity="0.35" />
    {:else if form === "hex"}
      <polygon points="24,6 40,15 40,35 24,44 8,35 8,15" fill={color} stroke={color} stroke-width="5" stroke-linejoin="round" />
      <circle class="light" cx="24" cy="10.5" r="2" fill="#fff" opacity="0.4" />
    {:else}
      <rect x="6" y="8" width="36" height="35" rx="14" fill={color} />
      <rect class="light" x="17" y="10.5" width="14" height="3" rx="1.5" fill="#fff" opacity="0.3" />
    {/if}
    <!-- the face: a soft visor so the eyes read on any color -->
    <rect x="12" y="19" width="24" height="13" rx="6.5" fill="#1d1d1f" opacity="0.22" />
  </g>

  <g class="face" fill="none" stroke-linecap="round" stroke-linejoin="round">
    {#if mood === "asleep"}
      <path d="M15.5 25.5 q3 2.6 6 0" stroke="#fff" stroke-width="2" />
      <path d="M26.5 25.5 q3 2.6 6 0" stroke="#fff" stroke-width="2" />
      <path d="M21 37 h6" stroke={ink} stroke-width="2" />
      <text x="37" y="11" font-size="8" font-weight="700" fill={ink === "#ffffff" ? "currentColor" : ink} stroke="none" class="zzz">z</text>
    {:else if mood === "failed"}
      <path d="M15 21.5 l5 1.6" stroke={ink} stroke-width="1.8" />
      <path d="M33 21.5 l-5 1.6" stroke={ink} stroke-width="1.8" />
      <circle cx="18.5" cy="26.5" r="3" fill="#fff" stroke="none" />
      <circle cx="29.5" cy="26.5" r="3" fill="#fff" stroke="none" />
      <circle cx="18.5" cy="27.6" r="1.4" fill="#1d1d1f" stroke="none" />
      <circle cx="29.5" cy="27.6" r="1.4" fill="#1d1d1f" stroke="none" />
      <path d="M19.5 38.5 q4.5 -3.4 9 0" stroke={ink} stroke-width="2" />
    {:else if mood === "needs"}
      <path d="M15 19.5 q3.5 -2.4 7 0" stroke={ink} stroke-width="1.8" />
      <path d="M26 19.5 q3.5 -2.4 7 0" stroke={ink} stroke-width="1.8" />
      <circle cx="18.5" cy="25.5" r="3.7" fill="#fff" stroke="none" />
      <circle cx="29.5" cy="25.5" r="3.7" fill="#fff" stroke="none" />
      <circle cx="18.5" cy="25.5" r="1.6" fill="#1d1d1f" stroke="none" />
      <circle cx="29.5" cy="25.5" r="1.6" fill="#1d1d1f" stroke="none" />
      <circle cx="24" cy="37.5" r="2" stroke={ink} stroke-width="1.8" />
    {:else}
      <g class="eyes">
        <ellipse cx="18.5" cy="25.5" rx="3.2" ry="3.4" fill="#fff" stroke="none" />
        <ellipse cx="29.5" cy="25.5" rx="3.2" ry="3.4" fill="#fff" stroke="none" />
        <g class="pupils">
          <circle cx="19" cy="26" r="1.5" fill="#1d1d1f" stroke="none" />
          <circle cx="30" cy="26" r="1.5" fill="#1d1d1f" stroke="none" />
        </g>
      </g>
      {#if mood === "working"}
        <path d="M20.5 36.5 h7" stroke={ink} stroke-width="2" />
      {:else}
        <path d="M19.5 35.5 q4.5 3.6 9 0" stroke={ink} stroke-width="2" />
      {/if}
    {/if}
  </g>

  {#if mood === "needs"}
    <g class="badge">
      <circle cx="40" cy="9" r="7" fill="var(--warning, #d29922)" stroke="var(--bg-deep, #111)" stroke-width="1.5" />
      <path d="M40 5.5 v4.2" stroke="#1d1d1f" stroke-width="2" stroke-linecap="round" />
      <circle cx="40" cy="12.4" r="1.1" fill="#1d1d1f" />
    </g>
  {:else if mood === "failed"}
    <g class="badge">
      <circle cx="40" cy="9" r="6.5" fill="var(--danger, #e5484d)" stroke="var(--bg-deep, #111)" stroke-width="1.5" />
      <path d="M37.8 6.8 l4.4 4.4 M42.2 6.8 l-4.4 4.4" stroke="#fff" stroke-width="1.8" stroke-linecap="round" />
    </g>
  {/if}
</svg>

<style>
  .bot-avatar {
    flex-shrink: 0;
    display: inline-block;
    overflow: visible;
    color: var(--text-secondary);
  }
  .eyes {
    transform-box: fill-box;
    transform-origin: center;
  }
  .mood-idle .eyes {
    animation: blink 6s infinite;
  }
  .mood-working .pupils {
    animation: scan 1.8s ease-in-out infinite;
  }
  .mood-working .light {
    animation: pulse 1.2s ease-in-out infinite;
  }
  .mood-needs .badge {
    transform-box: fill-box;
    transform-origin: center;
    animation: pop 2.4s ease-in-out infinite;
  }
  .zzz {
    opacity: 0.7;
  }
  @keyframes blink {
    0%, 94%, 100% { transform: scaleY(1); }
    97% { transform: scaleY(0.1); }
  }
  @keyframes scan {
    0%, 100% { transform: translateX(-1.6px); }
    50% { transform: translateX(1.6px); }
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
  @keyframes pop {
    0%, 80%, 100% { transform: scale(1); }
    88% { transform: scale(1.15); }
  }
  @media (prefers-reduced-motion: reduce) {
    .mood-idle .eyes,
    .mood-working .pupils,
    .mood-working .light,
    .mood-needs .badge {
      animation: none;
    }
  }
</style>
