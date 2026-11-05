import type { ReactNode } from 'react';

// Icons draw in the text color, so they match whatever they sit beside.

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function HourglassIcon() {
  return (
    <Svg>
      <path d="M5 3h14M5 21h14M7 3v4l5 5 5-5V3M7 21v-4l5-5 5 5v4" />
    </Svg>
  );
}

/** A circle, half filled: light and dark. */
export function ThemeIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Eight square teeth around a ring. */
const GEAR = Array.from({ length: 8 }, (_, tooth) => {
  const at = (radius: number, offset: number) => {
    const angle = ((tooth + offset) * Math.PI) / 4;
    const x = 12 + radius * Math.sin(angle);
    const y = 12 - radius * Math.cos(angle);
    return `${x.toFixed(2)} ${y.toFixed(2)}`;
  };
  return `${at(7.5, -0.26)} ${at(10.5, -0.17)} ${at(10.5, 0.17)} ${at(7.5, 0.26)}`;
});

export function GearIcon() {
  return (
    <Svg>
      <path d={`M${GEAR.join(' ')}z`} />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}
