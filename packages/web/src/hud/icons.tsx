import type { ReactNode } from "react";

/** Small line icons for the player and widgets, drawn in the current colour. */
const svg = (children: ReactNode, size = 18) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const IconPlay = () => svg(<path d="M7 4.5v15l12-7.5z" fill="currentColor" />);
export const IconPause = () => svg(<><rect x="6" y="4.5" width="4" height="15" fill="currentColor" /><rect x="14" y="4.5" width="4" height="15" fill="currentColor" /></>);
export const IconNext = () => svg(<><path d="M5 5v14l10-7z" fill="currentColor" /><path d="M18 5v14" /></>);
export const IconPrev = () => svg(<><path d="M19 5v14L9 12z" fill="currentColor" /><path d="M6 5v14" /></>);
export const IconShuffle = () => svg(<><path d="M3 7h3.5c3 0 4 2 5.5 5s2.500 5 5.500 5H21" /><path d="M3 17h3.5c1.500 0 2.500-.6 3.400-1.800M13.500 8.800C14.500 7.600 15.500 7 17 7h4" /><path d="m18.500 4.500 2.500 2.500-2.500 2.500M18.500 14.500l2.500 2.500-2.500 2.500" /></>);
export const IconRepeat = () => svg(<><path d="M17 3l3 3-3 3" /><path d="M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3" /><path d="M20 13v2a3 3 0 0 1-3 3H4" /></>);
export const IconVolume = () => svg(<><path d="M4 9.500v5h3.500L12 18.500v-13L7.500 9.500z" fill="currentColor" /><path d="M15.500 9a4 4 0 0 1 0 6M18 6.500a7.500 7.500 0 0 1 0 11" /></>);
export const IconMute = () => svg(<><path d="M4 9.500v5h3.500L12 18.500v-13L7.500 9.500z" fill="currentColor" /><path d="m16 9 5 6M21 9l-5 6" /></>);
export const IconExpand = () => svg(<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />);
export const IconCollapse = () => svg(<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />);
export const IconClose = () => svg(<path d="M6 6l12 12M18 6 6 18" />);
export const IconNote = () => svg(<path d="M9 18V6l10-2v12" />, 22);
