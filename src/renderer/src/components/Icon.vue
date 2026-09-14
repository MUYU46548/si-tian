<template>
  <svg class="icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <template v-if="name === 'clock'"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></template>
    <template v-else-if="name === 'save'"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></template>
    <template v-else-if="name === 'layers'"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></template>
    <template v-else-if="name === 'bookmark'"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></template>
    <template v-else-if="name === 'download'"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></template>
    <template v-else-if="name === 'settings'"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></template>
    <template v-else-if="name === 'clipboard'"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></template>
    <template v-else-if="name === 'search'"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></template>
    <template v-else-if="name === 'moon'"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></template>
    <template v-else-if="name === 'sun'"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></template>
    <template v-else-if="name === 'sparkles'"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/><path d="M18 14l.75 2.25L21 17l-2.25.75L18 20l-.75-2.25L15 17l2.25-.75L18 14z"/><path d="M5 14l.75 2.25L8 17l-2.25.75L5 20l-.75-2.25L2 17l2.25-.75L5 14z"/></template>
    <template v-else-if="name === 'book'"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></template>
    <template v-else-if="name === 'keyboard'"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"/><line x1="6" y1="8" x2="6" y2="8"/><line x1="10" y1="8" x2="10" y2="8"/><line x1="14" y1="8" x2="14" y2="8"/><line x1="18" y1="8" x2="18" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="6" y1="16" x2="6" y2="16"/><line x1="10" y1="16" x2="10" y2="16"/><line x1="14" y1="16" x2="14" y2="16"/><line x1="18" y1="16" x2="18" y2="16"/></template>
    <template v-else-if="name === 'tools'"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></template>
    <template v-else-if="name === 'pencil'"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></template>
    <template v-else-if="name === 'ruler'"><path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/></template>
    <template v-else-if="name === 'magnet'"><path d="M6 2v6a6 6 0 0 0 12 0V2"/><line x1="6" y1="10" x2="18" y2="10"/></template>
    <template v-else-if="name === 'folder'"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></template>
    <template v-else-if="name === 'wrench'"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></template>
    <template v-else-if="name === 'trash'"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></template>
    <template v-else-if="name === 'plus'"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></template>
    <template v-else-if="name === 'hand'"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></template>
    <template v-else-if="name === 'route'"><circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M12 19h6a3 3 0 0 0 3-3v-3"/><path d="M6 10.5V16"/><path d="M8.5 8.5l7.5-4"/></template>
    <template v-else-if="name === 'map'"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></template>
    <template v-else-if="name === 'building'"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="9" y1="22" x2="9" y2="22.01"/><line x1="15" y1="22" x2="15" y2="22.01"/><line x1="9" y1="18" x2="9" y2="18.01"/><line x1="15" y1="18" x2="15" y2="18.01"/><line x1="9" y1="14" x2="9" y2="14.01"/><line x1="15" y1="14" x2="15" y2="14.01"/><line x1="9" y1="10" x2="9" y2="10.01"/><line x1="15" y1="10" x2="15" y2="10.01"/><line x1="9" y1="6" x2="9" y2="6.01"/><line x1="15" y1="6" x2="15" y2="6.01"/></template>
    <template v-else-if="name === 'image'"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></template>
    <template v-else-if="name === 'compass'"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></template>
    <template v-else-if="name === 'text'"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></template>
    <template v-else-if="name === 'check'"><polyline points="20 6 9 17 4 12"/></template>
    <template v-else-if="name === 'x'"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></template>
    <template v-else-if="name === 'lock'"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></template>
    <template v-else-if="name === 'unlock'"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></template>
    <template v-else-if="name === 'camera'"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></template>
    <template v-else-if="name === 'package'"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></template>
    <template v-else-if="name === 'edit'"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></template>
    <template v-else-if="name === 'alert-circle'"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></template>
    <template v-else-if="name === 'info'"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></template>
    <template v-else-if="name === 'refresh'"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></template>
    <template v-else-if="name === 'upload'"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></template>
    <template v-else-if="name === 'eye'"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></template>
    <template v-else-if="name === 'zoom-in'"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></template>
    <template v-else-if="name === 'move'"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></template>
    <template v-else-if="name === 'rotate'"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></template>
    <template v-else-if="name === 'scissors'"><circle cx="6" cy="6" r="3"/><line x1="8" y1="8" x2="21" y2="21"/><circle cx="6" cy="18" r="3"/><line x1="8" y1="16" x2="21" y2="2"/></template>
    <template v-else-if="name === 'star'"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></template>
    <template v-else-if="name === 'mountain'"><line x1="8" y1="3" x2="16" y2="3"/><path d="M4 21l5-12 4 6 3-6 5 12"/></template>
    <template v-else-if="name === 'home'"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></template>
    <template v-else-if="name === 'shop'"><path d="M3 9l1-4h16l1 4"/><path d="M5 9v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M9 9V5a3 3 0 0 1 6 0v4"/></template>
    <template v-else-if="name === 'play'"><polygon points="5 3 19 12 5 21 5 3"/></template>
    <template v-else-if="name === 'pause'"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></template>
    <template v-else-if="name === 'square'"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></template>
    <template v-else-if="name === 'loader'"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></template>
    <template v-else-if="name === 'git-branch'"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></template>
    <template v-else-if="name === 'database'"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></template>
    <template v-else-if="name === 'code'"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></template>
    <template v-else-if="name === 'terminal'"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></template>
    <template v-else-if="name === 'cpu'"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></template>
    <template v-else-if="name === 'hard-drive'"><line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/></template>
    <template v-else-if="name === 'globe'"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></template>
    <template v-else-if="name === 'shield'"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></template>
    <template v-else-if="name === 'zap'"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></template>
    <template v-else-if="name === 'activity'"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></template>
    <template v-else-if="name === 'trending-up'"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></template>
    <template v-else-if="name === 'bar-chart'"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></template>
    <template v-else-if="name === 'hash'"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></template>
    <template v-else-if="name === 'corner-down-left'"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></template>
    <template v-else-if="name === 'chevron-up'"><polyline points="18 15 12 9 6 15"/></template>
    <template v-else-if="name === 'chevron-down'"><polyline points="6 9 12 15 18 9"/></template>
    <template v-else-if="name === 'chevron-left'"><polyline points="15 18 9 12 15 6"/></template>
    <template v-else-if="name === 'chevron-right'"><polyline points="9 18 15 12 9 6"/></template>
    <template v-else-if="name === 'arrow-up'"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></template>
    <template v-else-if="name === 'arrow-down'"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></template>
    <template v-else-if="name === 'corner-right-up'"><polyline points="10 9 15 4 20 9"/><path d="M4 20h7a4 4 0 0 0 4-4V4"/></template>
    <template v-else-if="name === 'copy'"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></template>
    <template v-else-if="name === 'filter'"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></template>
    <template v-else-if="name === 'grid'"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></template>
    <template v-else-if="name === 'list'"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></template>
    <template v-else-if="name === 'more-horizontal'"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></template>
    <template v-else-if="name === 'sidebar'"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="3" x2="9" y2="21"/></template>
    <template v-else-if="name === 'target'"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></template>
    <template v-else-if="name === 'anchor'"><circle cx="12" cy="5" r="3"/><line x1="12" y1="22" x2="12" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/></template>
    <template v-else-if="name === 'link'"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></template>
    <template v-else-if="name === 'box'"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></template>
    <template v-else-if="name === 'tag'"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></template>
    <template v-else-if="name === 'flag'"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></template>
    <template v-else-if="name === 'map-pin'"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></template>
    <template v-else-if="name === 'navigation'"><polygon points="3 11 22 2 13 21 11 13 3 11"/></template>
    <template v-else-if="name === 'crosshair'"><circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/></template>
    <template v-else-if="name === 'pointer'"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6"/></template>
    <template v-else-if="name === 'mouse-pointer'"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6"/></template>
    <template v-else-if="name === 'pen-tool'"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></template>
    <template v-else-if="name === 'brush'"><path d="M18.37 2.63a2.12 2.12 0 0 1 3 3L14 13l-4 1 1-4 7.37-7.37z"/><path d="M9 14.5c-2.5 1-3.5 3.5-4.5 5.5 2 0 4-.5 5.5-2.5 1-1.5 0-3-1-3z"/></template>
    <template v-else-if="name === 'droplet'"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></template>
    <template v-else-if="name === 'cloud'"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></template>
    <template v-else-if="name === 'thermometer'"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></template>
    <template v-else-if="name === 'wind'"><path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"/></template>
    <template v-else-if="name === 'flame'"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></template>
    <template v-else-if="name === 'snowflake'"><line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/><line x1="19.07" y1="4.93" x2="4.93" y2="19.07"/></template>
    <template v-else-if="name === 'sunrise'"><path d="M17 18a5 5 0 0 0-10 0"/><line x1="12" y1="2" x2="12" y2="9"/><line x1="4.22" y1="10.22" x2="5.64" y2="11.64"/><line x1="1" y1="18" x2="3" y2="18"/><line x1="21" y1="18" x2="23" y2="18"/><line x1="18.36" y1="11.64" x2="19.78" y2="10.22"/><line x1="23" y1="22" x2="1" y2="22"/><polyline points="8 6 12 2 16 6"/></template>
    <template v-else-if="name === 'sunset'"><path d="M17 18a5 5 0 0 0-10 0"/><line x1="12" y1="9" x2="12" y2="2"/><line x1="4.22" y1="10.22" x2="5.64" y2="11.64"/><line x1="1" y1="18" x2="3" y2="18"/><line x1="21" y1="18" x2="23" y2="18"/><line x1="18.36" y1="11.64" x2="19.78" y2="10.22"/><line x1="23" y1="22" x2="1" y2="22"/><polyline points="16 5 12 9 8 5"/></template>
    <template v-else-if="name === 'timer'"><circle cx="12" cy="14" r="8"/><line x1="12" y1="10" x2="12" y2="14"/><line x1="12" y1="14" x2="14" y2="14"/><line x1="10" y1="2" x2="14" y2="2"/></template>
    <template v-else-if="name === 'history'"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></template>
    <template v-else-if="name === 'undo'"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></template>
    <template v-else-if="name === 'redo'"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"/></template>
    <template v-else-if="name === 'zoom-out'"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></template>
    <template v-else-if="name === 'maximize'"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></template>
    <template v-else-if="name === 'minimize'"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></template>
    <template v-else-if="name === 'zoom-resize'"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></template>
    <!-- P1.1 批次 A/B/C 新增 -->
    <template v-else-if="name === 'trash-2'"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></template>
    <template v-else-if="name === 'alert-triangle'"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></template>
    <template v-else-if="name === 'check-circle'"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></template>
    <template v-else-if="name === 'x-circle'"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></template>
    <template v-else-if="name === 'check-square'"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></template>
    <template v-else-if="name === 'minus'"><line x1="5" y1="12" x2="19" y2="12"/></template>
    <template v-else-if="name === 'file-text'"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></template>
    <template v-else-if="name === 'folder-open'"><path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/></template>
    <template v-else-if="name === 'help-circle'"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></template>
    <template v-else-if="name === 'type'"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></template>
    <template v-else-if="name === 'door-open'"><path d="M13 4h3a2 2 0 0 1 2 2v14"/><path d="M2 20h3"/><path d="M13 20h9"/><path d="M10 12h.01"/><path d="M13 4.562v16.157a1 1 0 0 1-1.242.97L5 20V5.562a2 2 0 0 1 1.515-1.94l4-1A2 2 0 0 1 13 4.562z"/></template>
    <template v-else-if="name === 'armchair'"><path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/><path d="M3 16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v2H7v-2a2 2 0 0 0-4 0z"/><path d="M5 18v2"/><path d="M19 18v2"/></template>
    <template v-else-if="name === 'satellite'"><path d="M13 7 9 3 5 7l4 4"/><path d="m17 11 4 4-4 4-4-4"/><path d="m8 12 4 4 6-6-4-4Z"/><path d="m16 8 3-3"/><path d="M9 21a6 6 0 0 0-6-6"/></template>
    <template v-else-if="name === 'palette'"><circle cx="13.5" cy="6.5" r="0.5"/><circle cx="17.5" cy="10.5" r="0.5"/><circle cx="8.5" cy="7.5" r="0.5"/><circle cx="6.5" cy="12.5" r="0.5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></template>
    <template v-else-if="name === 'store'"><path d="M3 9l1-4h16l1 4"/><path d="M5 9v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M9 9V5a3 3 0 0 1 6 0v4"/></template>
    <template v-else-if="name === 'shopping-bag'"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></template>
    <template v-else-if="name === 'skull'"><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M8 20v2h8v-2"/><path d="m12.5 17-.5-1-.5 1z"/><path d="M16 20a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20"/></template>
    <template v-else-if="name === 'gem'"><path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></template>
    <template v-else-if="name === 'user'"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></template>
    <template v-else-if="name === 'church'"><path d="M10 9h4"/><path d="M12 5v4"/><path d="M6 21V12l6-4 6 4v9"/><path d="M3 21h18"/><path d="M10 21v-4a2 2 0 0 1 4 0v4"/></template>
    <template v-else-if="name === 'castle'"><path d="M4 21V9l2-3 2 3 2-3 2 3 2-3 2 3 2-3 2 3v12"/><path d="M3 21h18"/><path d="M10 21v-4a2 2 0 0 1 4 0v4"/></template>
    <template v-else-if="name === 'factory'"><path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M17 18h1"/><path d="M12 18h1"/><path d="M7 18h1"/></template>
    <template v-else-if="name === 'spiral'"><path d="M12 12a2.5 2.5 0 1 1 2.5 2.5A4.5 4.5 0 0 1 10 10a6.5 6.5 0 0 1 6.5-6.5A8.5 8.5 0 0 1 20.5 12a10 10 0 1 1-10 10"/></template>
    <template v-else-if="name === 'rocket'"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></template>
    <template v-else-if="name === 'refresh-cw'"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></template>
    <!-- P1.1 批次 C 新增（家具 / 区域类型 / 标记预设） -->
    <template v-else-if="name === 'table'"><rect x="3" y="8" width="18" height="3" rx="1"/><path d="M5 11v9"/><path d="M19 11v9"/></template>
    <template v-else-if="name === 'bed'"><path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/></template>
    <template v-else-if="name === 'archive'"><rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/></template>
    <template v-else-if="name === 'vase'"><path d="M8 3h8"/><path d="M11 3c0 3-4 4-4 9a5 5 0 0 0 10 0c0-5-4-6-4-9"/></template>
    <template v-else-if="name === 'window'"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M12 3v18"/><path d="M3 12h18"/></template>
    <template v-else-if="name === 'tree'"><path d="M12 3 7 11h10z"/><path d="M12 8 6 17h12z"/><path d="M12 17v5"/></template>
    <template v-else-if="name === 'fence'"><path d="M7 21V6l3-3 3 3v15"/><path d="M3 11h16"/><path d="M3 16h16"/></template>
    <template v-else-if="name === 'swords'"><polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" y1="19" x2="19" y2="13"/><line x1="16" y1="16" x2="20" y2="20"/><line x1="19" y1="21" x2="21" y2="19"/><polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/><line x1="5" y1="14" x2="9" y2="18"/><line x1="7" y1="17" x2="4" y2="20"/><line x1="3" y1="19" x2="5" y2="21"/></template>
    <template v-else-if="name === 'orbit'"><circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><path d="M10.4 21.9a10 10 0 0 0 9.941-15.416"/><path d="M13.5 2.1a10 10 0 0 0-9.841 15.416"/></template>
    <template v-else-if="name === 'users'"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6"/><path d="M23 11h-6"/></template>
    <template v-else-if="name === 'waves'"><path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9 5c1.3 0 1.7.5 2.5 1 .8.5 1.2 1 2.5 1 2.5 0 2.5-2 4.5-2 1.3 0 1.7.5 2.5 1 .8.5 1.2 1 2.5 1 2.5 0 2.5-2 4.5-2"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 4.5-2 1.3 0 1.7.5 2.5 1 .8.5 1.2 1 2.5 1 2.5 0 2.5-2 4.5-2 1.3 0 1.7.5 2.5 1 .8.5 1.2 1 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 4.5-2 1.3 0 1.7.5 2.5 1 .8.5 1.2 1 2.5 1 2.5 0 2.5-2 4.5-2 1.3 0 1.7.5 2.5 1 .8.5 1.2 1 2.5 1"/></template>
  </svg>
</template>

<script setup>
defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 16 }
})
</script>

<style scoped>
.icon {
  display: inline-block;
  vertical-align: middle;
  flex-shrink: 0;
  line-height: 0;
}
</style>
