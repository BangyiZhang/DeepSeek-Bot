// Functional chrome floats above content; message surfaces retain their own theme.
// These are web materials, without filtering or distorting text and icons.
export const GLASS_SHELL_CSS = `


:is(.bt-round,.bt-account,.bt-you,.bt-plus,.bt-mic,.bt-voice,.bt-head-side,[data-sidebar-right-toggle]){border-radius:50%;corner-shape:round}
:is(.bt-pill,.bt-connect,.bt-react-strip,.bt-react,.bt-seg,.bt-seg>.bt-thumb){border-radius:999px;corner-shape:round}
:is(.bt-menu,.bt-drop,.bt-avedit,.bt-palette,.bt-settings,.bt-mem){border-radius:20px;corner-shape:superellipse(1.25)}

.bt-tile{width:104px;box-sizing:border-box;padding:12px 10px 10px;gap:6px;border-radius:20px;corner-shape:superellipse(1.25)}
.bt-tile[aria-current=page],.bt-tile.active,.bt-tile[aria-current=page]:hover,.bt-tile.active:hover{background:var(--bt-active)}
.bt-tile:not([aria-current=page]):not(.active):hover{background:var(--bt-hover)}
.bt-tile[aria-current=page] .bt-tile-name{font-weight:600}
.bt-tile .bt-chip{max-width:100%;box-sizing:border-box;padding:0;background:transparent;border:0;border-radius:0;box-shadow:none;font-size:11px;line-height:16px;color:var(--bt-ink-2)}
.bt-tile-name{font-weight:500}
[data-sidebar-right-toggle]{width:36px;height:36px;padding:0;border-radius:50%;corner-shape:round;color:var(--bt-ink-2);display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box}
.bt-icon-btn.bt-head-side{width:36px;height:36px;top:2px;box-sizing:border-box}
.bt-head-side:focus-visible,[data-sidebar-right-toggle]:focus-visible,.bt-tile:focus-visible{outline:2px solid var(--bt-accent);outline-offset:3px}
@supports (backdrop-filter:blur(12px)){
  :is(.bt-round,.bt-pill,.bt-connect,.bt-account,.bt-head-side,[data-sidebar-right-toggle],.bt-react-strip){
    background:var(--bt-glass-sheen),var(--bt-glass-fill);
    border:1px solid var(--bt-glass-edge);
    box-shadow:var(--bt-glass-shadow);
    -webkit-backdrop-filter:blur(16px) saturate(1.15);
    backdrop-filter:blur(16px) saturate(1.15);
  }
  .bt-account .bt-you{background:transparent;box-shadow:none}
  :is(.bt-menu,.bt-drop,.bt-avedit,.bt-palette){
    background:var(--bt-glass-sheen),var(--bt-glass-menu-fill);
    border-color:var(--bt-glass-edge);
    box-shadow:0 12px 28px -12px rgba(0,0,0,.18),var(--bt-glass-shadow);
    -webkit-backdrop-filter:blur(24px) saturate(1.15);
    backdrop-filter:blur(24px) saturate(1.15);
  }
  :is(.bt-round,.bt-pill,.bt-connect,.bt-account,.bt-head-side,[data-sidebar-right-toggle]):hover{background:var(--bt-glass-sheen),color-mix(in srgb,var(--bt-main) 92%,transparent)}
}
@media (prefers-reduced-transparency:reduce),(prefers-contrast:more){
  :is(.bt-round,.bt-pill,.bt-connect,.bt-account,.bt-head-side,[data-sidebar-right-toggle],.bt-react-strip,.bt-menu,.bt-drop,.bt-avedit,.bt-palette){
    background:var(--bt-main)!important;
    -webkit-backdrop-filter:none!important;
    backdrop-filter:none!important;
    box-shadow:0 1px 4px var(--bt-glass-shade);
  }
}
@media (prefers-contrast:more){
  :is(.bt-round,.bt-pill,.bt-connect,.bt-account,.bt-head-side,[data-sidebar-right-toggle],.bt-react-strip,.bt-menu,.bt-drop,.bt-avedit,.bt-palette){border-color:var(--bt-ink-2)}
}
`

export const GLASS_CONVERSATION_CSS = `
[data-composer-card]{corner-shape:round}
[class*="_activity"]:has([class*="triggerAnchor"]){display:none!important}
[data-composer-card] :is(.bt-plus,.bt-mic,.bt-voice,button[class*="_primary"]){corner-shape:round}
[data-composer-card]:has(> [data-slot="conversation.input.attachments"] *),[data-composer-card]:has([data-composer-input] br + *),[data-composer-card]:has([data-composer-input] > :nth-child(2)){corner-shape:superellipse(1.25)}
@supports (backdrop-filter:blur(12px)){
  [data-composer-card]{
    background:var(--bt-glass-sheen),var(--bt-glass-fill)!important;
    border-color:var(--bt-glass-edge)!important;
    box-shadow:var(--bt-glass-shadow)!important;
    -webkit-backdrop-filter:blur(20px) saturate(1.15);
    backdrop-filter:blur(20px) saturate(1.15);
  }
  header[class*="_header"]:has(.bt-head)::before{background:linear-gradient(to bottom,color-mix(in srgb,var(--bt-main) 84%,transparent),transparent)}
}
@media (prefers-reduced-transparency:reduce),(prefers-contrast:more){
  [data-composer-card]{background:var(--bt-main)!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
}
@media (prefers-contrast:more){[data-composer-card]{border-color:var(--bt-ink-2)!important}}
`
