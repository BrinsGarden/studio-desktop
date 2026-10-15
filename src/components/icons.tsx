const paths: Record<string, string> = {
  select: 'M7 4.5C10 3 15 3 18 5s3.5 6 1 8.5S11 16 8 15s-5-3.5-4-6.5c.4-1.4 1.6-2.9 3-4M8 15c-.6 1.6-.3 3.4.8 4.5M8.8 19.5l-1.3 2',
  swirl: 'M12 12a1.5 1.5 0 1 1 1.5 1.5A3 3 0 0 1 10.5 10.5 4.5 4.5 0 0 1 15 6a6 6 0 0 1 6 6 7.5 7.5 0 0 1-7.5 7.5A9 9 0 0 1 3 12',
  move: 'M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3',
  brush: 'M18.4 2.6a2 2 0 0 1 2.9 2.9L11 15.8 8.2 13zM7.5 14.5c-2 0-3.5 1.5-3.5 3.5 0 1.5-1 2.5-2 3 3 1 7 0 8-2.5.5-1.4 0-2.8-1.2-3.5',
  eraser: 'M7 21h13M5.5 15.5l9-9a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 20H7.5l-2-2a2 2 0 0 1 0-2.5zM10 11l5 5',
  eyedropper: 'M2 22l2-1 9-9M13.5 6.5l4 4M15 3l6 6-2.5 2.5-6-6zM4 21l-1-1',
  hand: 'M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 0 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.3L3.3 16.9a2 2 0 0 1 2.8-2.8L8 16',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.1 3.9M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 9.5a1.5 1.5 0 1 0 0-.01',
  text: 'M4 6V4h16v2M12 4v16M9 20h6',
  gradient: 'M3 3h18v18H3zM3 3l18 18M3 9l12 12M9 3l12 12',
  adjust: 'M12 3a9 9 0 1 0 0 18zM12 3a9 9 0 0 1 0 18',
  mask: 'M3 4h18v16H3zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M19 12l-7 7-7-7',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  flipH: 'M12 3v18M8 7L3 12l5 5zM16 7l5 5-5 5z',
  flipV: 'M3 12h18M7 8l5-5 5 5zM7 16l5 5 5-5z',
  swap: 'M7 7h13l-3-3M17 17H4l3 3',
};

export function Icon({ name, size = 18 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? ''} />
    </svg>
  );
}
